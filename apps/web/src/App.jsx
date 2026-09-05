import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { controlApi, eventsUrl } from './api.js'
import { WORKFLOW_NODES, deriveWorkflowState, normalizeWorkflowStatus } from './workflow.js'
import { PAPER_FIELDS, currentCycleWindow, createWorkflowRunner, saveConnection } from './workflow-entry.js'

export { WORKFLOW_NODES, deriveWorkflowState, normalizeWorkflowStatus } from './workflow.js'

const ROLES = Object.freeze(WORKFLOW_NODES.map(({ role }) => role))
const VENUES = Object.freeze(['gate', 'binance'])
const VENUE_NAMES = Object.freeze({ gate: 'Gate', binance: 'Binance' })
const ARM_PHRASES = Object.freeze({ gate: 'ARM TESTNET GATE 24H', binance: 'ARM TESTNET BINANCE 24H' })
const DEFAULT_MODEL = ['g', 'p', 't', '-', '6', '-', 'astra'].join('')
const DEFAULT_EFFORTS = Object.freeze(Object.fromEntries(ROLES.map((role) => [role, role === 'preflight' ? 'medium' : role === 'reviewer' ? 'xhigh' : 'high'])))
const EMPTY_MODELS = Object.freeze({ default_model: DEFAULT_MODEL, allowed_models: [DEFAULT_MODEL], role_models: {}, role_efforts: {}, effective_efforts: DEFAULT_EFFORTS, allowed_efforts: ['medium', 'high', 'xhigh'], effective_models: Object.fromEntries(ROLES.map((role) => [role, DEFAULT_MODEL])) })
const EMPTY_PROVIDER = Object.freeze({ configured: false, provider: null, model: null, endpoint: null, scope: 'session', manual_cycle_only: true })

const EMPTY_DAG = { roles: ROLES.map((role) => ({ role, status: 'waiting' })) }
const EMPTY_ROLE_EVENTS = Object.freeze(Object.fromEntries(ROLES.map((role) => [role, 'waiting'])))
const EMPTY_TESTNET = Object.fromEntries(VENUES.map((venue) => [venue, { status: 'unconfigured', armed: false }]))

function formatTime(value) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
}

function statusTone(value) {
  const text = String(value || '').toLowerCase()
  if (['ok', 'ready', 'armed', 'complete', 'active', 'accepted', 'paper-only'].some((part) => text.includes(part))) return 'good'
  if (['blocked', 'error', 'failed', 'timeout', 'expired', 'unconfigured', 'unknown'].some((part) => text.includes(part))) return 'bad'
  return 'quiet'
}

function statusLabel(value) {
  const status = String(value || '').toLowerCase()
  const labels = {
    waiting: '等待', unknown: '等待', pending: '待处理', queued: '待处理', started: '进行中', running: '进行中',
    ok: '已完成', completed: '已完成', complete: '已完成', reused: '已复用', ready: '已就绪', armed: '已启用',
    active: '运行中', accepted: '已接受', 'paper-only': '仅模拟', blocked: '已阻断', failed: '失败', error: '错误',
    timeout: '超时', expired: '已过期', unconfigured: '未配置', idle: '空闲', connecting: '连接中', stopped: '已停止',
    starting: '启动中', ticking: '运行中', empty: '暂无', disarmed: '已停用', executed: '已执行', reconciled: '对账完成',
    planned: '计划已生成', paper_applied: '模拟结果已应用', no_action: '无操作'
  }
  return labels[status] || '状态已更新'
}

function Tone({ value, label }) {
  return <span className={`tone tone-${statusTone(value)}`}><i />{label || statusLabel(value)}</span>
}

function SectionLabel({ children, hint }) {
  return <div className="section-label"><span>{children}</span>{hint && <small>{hint}</small>}</div>
}

function Docket({ selected, workflow, onSelect }) {
  const nodeButton = (role, index) => {
    const node = workflow.byRole[role]
    return <button key={role} type="button" className={`lane workflow-node ${selected === role ? 'selected' : ''} ${node.current ? 'current' : ''}`} data-role={role} data-status={node.status} aria-current={node.current ? 'step' : undefined} onClick={() => onSelect(role)}>
      <span className="lane-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="lane-name"><strong>{node.name}</strong><small>{node.role}</small></span>
      <Tone value={node.status} label={node.statusLabel} />
    </button>
  }
  return (
    <aside className="docket">

      <nav className="workflow-dag" aria-label="固定工作流导航">
        <div className="workflow-summary"><SectionLabel hint="固定拓扑">工作流 DAG</SectionLabel><strong>{workflow.completedCount}/{workflow.totalCount} · {workflow.percent}%</strong><progress aria-label="工作流完成进度" max={workflow.totalCount} value={workflow.completedCount} /></div>
        <div className="workflow-stage sequential-stage">
          {nodeButton('orchestrator', 0)}
          {nodeButton('preflight', 1)}
        </div>
        <div className="workflow-stage parallel-stage">
          <span className="stage-caption">并行分支</span>
          <div className="parallel-branch">
            {nodeButton('btc-analyst', 2)}
            {nodeButton('eth-analyst', 3)}
          </div>
        </div>
        <div className="workflow-stage merge-stage">
          <span className="stage-caption">合流</span>
          {nodeButton('synthesizer', 4)}
        </div>
        <div className="workflow-stage sequential-stage final-stage">
          {nodeButton('reviewer', 5)}
        </div>
        <div className="workflow-current"><span>当前阶段</span><strong>{workflow.currentStage}</strong><small>当前 Agent：{workflow.currentAgents.length ? workflow.currentAgents.map((role) => `${workflow.byRole[role].name}（${role}）`).join('、') : '暂无'}</small></div>
      </nav>

    </aside>
  )
}

function MessageStream({ messages }) {
  return <div className="message-stream" aria-live="polite">
    {messages.length === 0 && <div className="empty-stream"><span className="empty-glyph">◌</span><p>事件流暂无消息</p><small>运行一个周期后，此处会显示受限的 agent 事件。</small></div>}
    {messages.map((message) => <div className={`message message-${message.kind}`} key={message.id}>
      <div className="message-meta"><span>{message.label}</span><time>{formatTime(message.at)}</time></div>
      <p>{message.text}</p>
      {message.detail && <code>{message.detail}</code>}
    </div>)}
  </div>
}

function ProviderPanel({ provider, model, catalog, endpoint, apiKey, setModel, setEndpoint, setApiKey, busy }) {
  const configured = provider?.configured === true
  return <section className="connection-section">
    <div className="section-heading"><h2>模型连接</h2><Tone value={configured ? 'ready' : 'waiting'} label={configured ? '当前会话已连接' : '待填写'} /></div>
    <div className="connection-fields">
      <label>API endpoint<input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://example.com/v1" spellCheck="false" disabled={busy} /></label>
      <label>API key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" spellCheck="false" disabled={busy} placeholder={configured ? '已保存；留空继续使用' : '填写模型 API key'} /></label>
    </div>
    <details className="model-options"><summary>默认模型 · {model}</summary><label>未单独指定的 Agent 使用此模型<select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>{catalog.map((value) => <option value={value} key={value}>{value}</option>)}</select></label></details>
    <p className="field-note">API key 只保留在当前会话内，退出或重启服务后清除。模型需由你的 API 服务支持。</p>
  </section>
}

function PaperSetup({ setup, draft, onChange, busy }) {
  if (!setup) return <p className="field-note">正在检查模拟设置…</p>
  if (setup.status === 'blocked') return <p className="form-error" role="alert">{setup.message}</p>
  if (setup.ready) return <details className="saved-paper"><summary>模拟设置已就绪</summary><dl>{PAPER_FIELDS.map(({ key, label, unit }) => <div key={key}><dt>{label}</dt><dd>{setup.values[key]} {unit}</dd></div>)}</dl></details>
  return <section className="paper-setup"><h2>首次模拟设置</h2><p className="field-note">请填写你的资金和风险限制。1 bps = 0.01%，支持小数；已保存的参数将复用。</p>
    {['模拟资金', '交易限额', '成交与止损约束'].map((group) => <fieldset key={group}><legend>{group}</legend><div className="setup-fields">{PAPER_FIELDS.filter((field) => field.group === group).map(({ key, label, unit }) => <label key={key}>{label}<span className="number-field"><input inputMode="decimal" value={setup.values[key] ?? draft[key] ?? ''} readOnly={Object.hasOwn(setup.values, key)} disabled={busy} onChange={(event) => onChange(key, event.target.value)} aria-label={label} /><span>{unit}</span></span></label>)}</div></fieldset>)}
  </section>
}

function RunResult({ cycle, workflow, phase, busy }) {
  const blocked = cycle?.ok === false || ['blocked', 'failed', 'error'].some((value) => [cycle?.outcome, cycle?.phase, cycle?.status].some((field) => String(field || '').toLowerCase() === value))
  const hasResult = Boolean(cycle?.outcome)
  return <section className="run-result" aria-live="polite"><div className="section-heading"><h2>{busy ? phase : blocked ? '运行已阻断' : hasResult ? '运行结果' : '运行进度'}</h2><Tone value={blocked ? 'blocked' : cycle?.outcome || 'waiting'} /></div>
    <progress aria-label="工作流完成进度" max={workflow.totalCount} value={workflow.completedCount} /><div className="progress-copy"><span>{workflow.currentStage}</span><span>{workflow.completedCount}/{workflow.totalCount}</span></div>
    <p>当前 Agent：{workflow.currentAgents.length ? workflow.currentAgents.map((role) => workflow.byRole[role].name).join('、') : '暂无'}</p>
    {hasResult && <p>{cycle.reused ? '已复用同周期结果；新策略将在下一有效周期使用。' : statusLabel(cycle.outcome)}{cycle.date ? ' · ' + cycle.date + ' UTC' : ''}</p>}
    {blocked && <div className="cycle-blocker" role="alert"><dl><div><dt>阶段</dt><dd>{compactValue(cycle.blocked_stage)}</dd></div><div><dt>代码</dt><dd>{compactValue(cycle.code)}</dd></div><div><dt>说明</dt><dd>{compactValue(cycle.message)}</dd></div></dl></div>}
  </section>
}

function StrategyPanel({ draft, applied, setDraft, onApply, busy }) {
  return <section className="strategy-panel"><div className="section-heading"><h2>分析策略</h2><span className="save-state">{draft === applied ? '已应用' : '未应用修改'}</span></div>
    <label>策略提示词<textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={8000} rows={10} placeholder="粘贴 BTC / ETH 的分析偏好，或在主 Agent 对话中讨论。" disabled={busy} /></label>
    <button type="button" className="primary-action" onClick={onApply} disabled={busy || draft === applied}>应用策略</button>
    <p className="field-note">仅当前会话有效，应用后用于后续分析。资金、杠杆和执行权限保持固定规则；已完成的周期继续复用。</p>
  </section>
}

function AgentSidebar({ workflow, models, selected, onSelect, onChat, onSettings }) {
  return <aside className="agent-sidebar"><div className="brand-lockup"><span className="brand-mark">τ</span><strong>Tyche</strong></div>
    <nav className="workspace-nav" aria-label="工作台导航"><button type="button" className="nav-current" onClick={onChat}>主 Agent</button><button type="button" onClick={onSettings}>运行设置</button></nav>
    <div className="sidebar-label">工作流 Agent</div><nav className="agent-list" aria-label="固定六个 Agent">{WORKFLOW_NODES.map(({ role, name }) => <button type="button" key={role} className={selected === role ? 'selected' : ''} onClick={() => onSelect(role)} data-role={role} data-status={workflow.byRole[role].status}><span className="agent-row"><strong>{name}</strong><Tone value={workflow.byRole[role].status} label={workflow.byRole[role].statusLabel} /></span><span className="agent-model">{models.effective_models[role]} · {models.effective_efforts[role]}</span></button>)}</nav>
    <div className="sidebar-foot"><span>BTC / ETH</span><span>Paper · 单次运行</span></div>
  </aside>
}

function ModelSuggestion({ suggestion, models, onApply, busy }) {
  if (!suggestion) return null
  const roles = ROLES.filter((role) => Object.hasOwn(suggestion.role_models, role) || Object.hasOwn(suggestion.role_efforts, role))
  if (!roles.length) return null
  const applied = roles.every((role) => (suggestion.role_models[role] || models.effective_models[role]) === models.effective_models[role] && (suggestion.role_efforts[role] || models.effective_efforts[role]) === models.effective_efforts[role])
  return <section className="suggestion-card"><div className="section-heading"><h3>模型与 effort 建议</h3><span className="save-state">{applied ? '已应用' : '尚未应用'}</span></div><dl className="model-diff">{roles.map((role) => <div key={role}><dt>{WORKFLOW_NODES.find((node) => node.role === role)?.name}</dt><dd><span>{models.effective_models[role]} · {models.effective_efforts[role]}</span><span aria-hidden="true">→</span><strong>{suggestion.role_models[role] || models.effective_models[role]} · {suggestion.role_efforts[role] || models.effective_efforts[role]}</strong></dd></div>)}</dl><button type="button" className="quiet-action" onClick={onApply} disabled={busy || applied}>应用模型配置</button><p className="field-note">主 Agent 使用流程编排的模型与 effort。修改仅影响后续任务，系统不会自动降档。</p></section>
}

function compactValue(value) {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function intentActionLabel(value) {
  const action = String(value || 'NO_ACTION').toUpperCase()
  const labels = { NO_ACTION: '无操作', BUY: '买入', SELL: '卖出', HOLD: '持有', ENTER_LONG: '开多', ENTER_SHORT: '开空' }
  return labels[action] ? `${labels[action]}（${action}）` : action
}

function VenueCard({ venue, data, csrf, onAction, date, isoWeek, planHash, confirmation, setConfirmation, armConfirmation, setArmConfirmation }) {
  const armed = data?.armed === true || data?.outcome === 'ARMED'
  const expires = data?.arm?.expires_at || data?.expires_at
  const isPlanMatch = Boolean(planHash && confirmation === planHash)
  const summary = data?.plan_summary || {}
  const intents = Array.isArray(summary.intents) ? summary.intents : []
  const armReady = armConfirmation === ARM_PHRASES[venue]
  const listValue = (value) => Array.isArray(value) ? (value.length ? value.map(compactValue).join(', ') : '无') : compactValue(value)
  return <section className="venue-card panel-block">
    <div className="venue-head"><div><span className="venue-kicker">测试网交易所</span><h3>{VENUE_NAMES[venue]}</h3></div><Tone value={armed ? 'armed' : data?.status || 'idle'} /></div>
    <div className="venue-grid"><div><span>启用到期时间</span><strong>{expires ? formatTime(expires) : '未启用'}</strong></div><div><span>plan hash</span><strong className="hash">{planHash || summary.plan_hash || '未加载'}</strong></div><div><span>产品</span><strong>{summary.product || '尚无计划'}</strong></div><div><span>已封存</span><strong>{summary.sealed === true ? '是' : '—'}</strong></div></div>
    <div className="intent-list" aria-label={`${VENUE_NAMES[venue]} 计划意图`}>
      {intents.length ? intents.map((intent, index) => {
        const protection = intent?.protection || {}
        return <div className="intent-row" key={`${venue}-${index}`} data-testid={`${venue}-intent-${index}`}>
          <div className="intent-title"><strong>{intent.symbol || '—'}</strong><span>{intentActionLabel(intent.action)}</span></div>
          <div className="intent-values"><span>规模 <b>{compactValue(intent.size)}</b></span><span>名义金额 <b>{compactValue(intent.notional)}</b></span><span>止损 <b>{compactValue(protection.stop ?? protection.stop_price)}</b></span><span>目标 <b>{compactValue(protection.target ?? protection.target_price)}</b></span></div>
        </div>
      }) : <div className="no-intent">无操作（NO_ACTION）</div>}
    </div>
    <div className="summary-strip"><div><span>风险策略</span><strong>{listValue(summary.risk_policy)}</strong></div><div><span>风险摘要</span><strong className="hash">{summary.risk_policy_digest || '—'}</strong></div><div><span>阻断项</span><strong className={summary.blockers?.length ? 'blocked-text' : ''}>{listValue(summary.blockers)}</strong></div></div>
    <label className="hash-field arm-field">启用确认短语<input value={armConfirmation} onChange={(event) => setArmConfirmation(event.target.value)} placeholder={ARM_PHRASES[venue]} spellCheck="false" /></label>
    <div className="action-row"><button type="button" className="quiet-action" onClick={() => onAction('plan', venue, date, isoWeek)} disabled={!csrf}>生成计划</button><button type="button" className="quiet-action" onClick={() => onAction('arm', venue, armConfirmation)} disabled={!csrf || armed || !armReady}>授权 24 小时</button><button type="button" className="quiet-action" onClick={() => onAction('disarm', venue)} disabled={!csrf}>解除授权</button><button type="button" className="quiet-action" onClick={() => onAction('reconcile', venue, planHash)} disabled={!csrf}>对账</button></div>
    <label className="hash-field">手动确认<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="粘贴完整 plan hash" spellCheck="false" /></label>
    <button type="button" className="danger-action" onClick={() => onAction('execute', venue, planHash, confirmation)} disabled={!csrf || !isPlanMatch}>按计划哈希执行</button>
    <p className="safety-line">不存在通用执行入口；确认内容必须与所示 hash 完全一致。</p>
  </section>
}

function Login({ onLogin, error }) {
  const [token, setToken] = useState('')
  return <main className="login-shell"><div className="login-card"><span className="brand-mark large">τ</span><h1>登录 Tyche</h1><p className="login-copy">请输入本地服务打印的一次性 bootstrap token。本页面不会存储该凭据。</p><form onSubmit={(event) => { event.preventDefault(); onLogin(token) }}><label>bootstrap token<input autoFocus value={token} onChange={(event) => setToken(event.target.value)} type="password" spellCheck="false" /></label><button type="submit" className="primary-action" disabled={!token.trim()}>进入工作台</button></form>{error && <p className="form-error">{error}</p>}</div></main>
}

export function App() {
  const [csrf, setCsrf] = useState(null)
  const [sessionExpiry, setSessionExpiry] = useState(null)
  const [loginError, setLoginError] = useState('')
  const [selected, setSelected] = useState('orchestrator')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [theme, setTheme] = useState('light')
  const [status, setStatus] = useState({ service: 'connecting' })
  const [provider, setProvider] = useState(EMPTY_PROVIDER)
  const [providerModel, setProviderModel] = useState(DEFAULT_MODEL)
  const [providerEndpoint, setProviderEndpoint] = useState('')
  const [providerApiKey, setProviderApiKey] = useState('')
  const [providerBusy, setProviderBusy] = useState(false)
  const [panel, setPanel] = useState(null)
  const [modelConfig, setModelConfig] = useState(EMPTY_MODELS)
  const [modelSuggestion, setModelSuggestion] = useState(null)
  const [setup, setSetup] = useState(null)
  const [paperDraft, setPaperDraft] = useState({})
  const [phase, setPhase] = useState('')
  const [strategyDraft, setStrategyDraft] = useState('')
  const [appliedStrategy, setAppliedStrategy] = useState('')
  const [discussion, setDiscussion] = useState([])
  const [discussionMessage, setDiscussionMessage] = useState('')
  const [suggestion, setSuggestion] = useState('')
  const [cycle, setCycle] = useState({ status: 'idle' })
  const [dag, setDag] = useState(EMPTY_DAG)
  const [paper, setPaper] = useState({ status: 'paper-only' })
  const [testnet, setTestnet] = useState(EMPTY_TESTNET)
  const [planHashes, setPlanHashes] = useState(Object.fromEntries(VENUES.map((venue) => [venue, ''])))
  const [confirmations, setConfirmations] = useState(Object.fromEntries(VENUES.map((venue) => [venue, ''])))
  const [armConfirmations, setArmConfirmations] = useState(Object.fromEntries(VENUES.map((venue) => [venue, ''])))
  const [messages, setMessages] = useState([])
  const [roleEvents, setRoleEvents] = useState({})
  const wsRef = useRef(null)
  const operationRef = useRef(false)
  const configurationRevisionRef = useRef(0)
  const cycleRunningRef = useRef(false)
  const workflowRunner = useMemo(() => createWorkflowRunner(controlApi), [])

  const pushMessage = useCallback((label, text, kind = 'event', detail = '') => {
    setMessages((current) => [...current.slice(-39), { id: `${Date.now()}-${Math.random()}`, label, text, kind, detail, at: new Date().toISOString() }])
  }, [])

  const refresh = useCallback(async () => {
    const revision = configurationRevisionRef.current
    const [nextStatus, nextProvider, nextCycle, nextDag, nextPaper, nextTestnet, nextSetup, nextModels] = await Promise.all([controlApi.status(), controlApi.providerStatus(), controlApi.cycle(), controlApi.dag(), controlApi.paper(), controlApi.testnet(), controlApi.paperSetup(), controlApi.models()])
    if (!operationRef.current && revision === configurationRevisionRef.current) { setProvider(nextProvider?.configured ? nextProvider : EMPTY_PROVIDER); setSetup(nextSetup); setModelConfig(nextModels) }
    setStatus(nextStatus); setPaper(nextPaper)
    if (!cycleRunningRef.current) { setCycle(nextCycle); setDag(nextDag) }
    setTestnet((current) => Object.fromEntries(VENUES.map((venue) => [venue, { ...(nextTestnet?.[venue] || {}), plan_summary: nextTestnet?.[venue]?.plan_summary || current?.[venue]?.plan_summary } ])))
    setPlanHashes((current) => Object.fromEntries(VENUES.map((venue) => [venue, nextTestnet?.[venue]?.plan_summary?.plan_hash || nextTestnet?.[venue]?.plan_hash || current[venue] || ''])))
  }, [])

  const openEvents = useCallback(() => {
    wsRef.current?.close()
    const socket = new WebSocket(eventsUrl())
    socket.onopen = () => pushMessage('控制平面', '事件流已连接', 'system')
    socket.onmessage = (event) => {
      try {
        const packet = JSON.parse(event.data)
        if (packet.type === 'connected') return
        const data = packet.data || {}
        if (packet.type === 'dag_role' && ROLES.includes(data.role)) {
          setRoleEvents((current) => data.role === 'orchestrator' && normalizeWorkflowStatus(data.status) === 'running'
            ? { ...EMPTY_ROLE_EVENTS, [data.role]: data.status }
            : { ...current, [data.role]: data.status })
        }
        pushMessage(data.role || '服务事件', statusLabel(data.status || data.outcome), 'event')
      } catch { pushMessage('控制平面', '已忽略格式错误的事件', 'warning') }
    }
    socket.onerror = () => pushMessage('控制平面', '事件流暂不可用，仍可使用轮询更新', 'warning')
    wsRef.current = socket
  }, [pushMessage])

  useEffect(() => {
    if (!csrf) return undefined
    refresh().catch((error) => setNotice(`刷新失败：${error.message}`))
    openEvents()
    const timer = window.setInterval(() => refresh().catch(() => {}), 15_000)
    return () => { window.clearInterval(timer); wsRef.current?.close() }
  }, [csrf, refresh, openEvents])

  const login = async (bootstrapToken) => {
    try {
      setLoginError('')
      const response = await controlApi.session(bootstrapToken.trim())
      setProvider(EMPTY_PROVIDER); setProviderModel(DEFAULT_MODEL); setProviderEndpoint(''); setProviderApiKey('')
      setStrategyDraft(''); setAppliedStrategy(''); setDiscussion([]); setSuggestion(''); setDiscussionMessage(''); setModelConfig(EMPTY_MODELS); setModelSuggestion(null); configurationRevisionRef.current++
      setCsrf(response.csrf_token); setSessionExpiry(response.expires_at); pushMessage('会话', '当前标签页已通过验证', 'system')
    } catch (error) { setLoginError(`登录失败：${error.message}`) }
  }

  const runCycle = async () => {
    if (operationRef.current) return
    operationRef.current = true
    configurationRevisionRef.current++
    cycleRunningRef.current = true
    try {
      setBusy(true); setNotice('')
      const response = await workflowRunner({ csrf, provider, connection: { endpoint: providerEndpoint, apiKey: providerApiKey, model: providerModel }, setup, draft: paperDraft, onPhase: (next) => { setPhase(next); if (next === '正在运行 workflow…') { setDag(EMPTY_DAG); setRoleEvents(EMPTY_ROLE_EVENTS); setCycle({ status: 'running' }) } }, onProvider: acceptProvider, onSetup: setSetup })
      if (response) { setCycle(response); pushMessage('workflow', statusLabel(response.status || response.outcome), response.ok === false ? 'warning' : 'event') }
      cycleRunningRef.current = false
      await refresh()
    } catch (error) { setPanel('settings'); setNotice(`运行失败：${error.message}`); setCycle((current) => current.status === 'running' ? { ok: false, status: 'failed', blocked_stage: 'workflow', message: error.message } : current) } finally { setProviderApiKey(''); setBusy(false); cycleRunningRef.current = false; operationRef.current = false }
  }

  const acceptProvider = (response) => {
    setProvider(response); setProviderModel(response.model || providerModel); setProviderEndpoint(response.endpoint || providerEndpoint); setProviderApiKey('')
    setModelConfig((current) => ({ ...current, default_model: response.model, effective_models: Object.fromEntries(ROLES.map((role) => [role, current.role_models[role] || response.model])) }))
  }

  const discuss = async () => {
    if (operationRef.current) return
    operationRef.current = true
    configurationRevisionRef.current++
    try {
      setProviderBusy(true); setNotice('')
      const connection = await saveConnection(controlApi, csrf, provider, { endpoint: providerEndpoint, apiKey: providerApiKey, model: providerModel })
      acceptProvider(connection)
      const response = await controlApi.discussStrategy(discussionMessage, csrf)
      setDiscussion((current) => [...current.slice(-8), { role: 'user', content: discussionMessage }, { role: 'assistant', content: response.reply }]); setSuggestion(response.suggested_prompt || ''); setModelSuggestion(response.suggested_role_models || response.suggested_role_efforts ? { role_models: response.suggested_role_models || {}, role_efforts: response.suggested_role_efforts || {} } : null); setDiscussionMessage('')
    } catch (error) { if (!provider.configured) setPanel('settings'); setNotice(`讨论失败：${error.message}`) } finally { setProviderApiKey(''); setProviderBusy(false); operationRef.current = false }
  }

  const applyStrategy = async () => {
    if (operationRef.current) return
    operationRef.current = true
    configurationRevisionRef.current++
    try { setProviderBusy(true); setNotice(''); const response = await controlApi.applyStrategy(strategyDraft, csrf); setAppliedStrategy(response.prompt); setStrategyDraft(response.prompt) } catch (error) { setNotice(`应用失败：${error.message}`) } finally { setProviderBusy(false); operationRef.current = false }
  }

  const applyModels = async () => {
    if (operationRef.current || !modelSuggestion) return
    operationRef.current = true
    configurationRevisionRef.current++
    try { setProviderBusy(true); setNotice(''); setModelConfig(await controlApi.applyModels(modelSuggestion, csrf)) } catch (error) { setNotice(`模型配置未应用：${error.message}`) } finally { setProviderBusy(false); operationRef.current = false }
  }

  const clearProvider = async () => {
    if (operationRef.current) return
    operationRef.current = true
    configurationRevisionRef.current++
    try {
      setProviderBusy(true); setNotice('')
      const response = await controlApi.clearProvider(csrf)
      setProvider(response?.configured ? response : EMPTY_PROVIDER); setProviderModel(DEFAULT_MODEL); setProviderEndpoint(''); pushMessage('模型连接', '当前会话的模型连接已清除', 'system')
      setModelConfig((current) => ({ ...current, default_model: DEFAULT_MODEL, effective_models: Object.fromEntries(ROLES.map((role) => [role, current.role_models[role] || DEFAULT_MODEL])) }))
    } catch (error) {
      setNotice(`模型连接清除失败：${error.message}`); pushMessage('模型连接', `清除失败：${error.message}`, 'warning')
    } finally {
      setProviderApiKey(''); setProviderBusy(false); operationRef.current = false
    }
  }

  const logout = async () => {
    try { await controlApi.logout(csrf) } finally {
      setProviderApiKey(''); setProviderModel(DEFAULT_MODEL); setProviderEndpoint(''); setProvider(EMPTY_PROVIDER); setCsrf(null)
      setStrategyDraft(''); setAppliedStrategy(''); setDiscussion([]); setSuggestion(''); setDiscussionMessage(''); setModelConfig(EMPTY_MODELS); setModelSuggestion(null); configurationRevisionRef.current++
    }
  }

  const action = async (kind, venueName, value, secondValue) => {
    try {
      setNotice('')
      let response
      if (kind === 'plan') response = await controlApi.plan(venueName, value, secondValue, csrf)
      if (kind === 'arm') response = await controlApi.arm(venueName, value, csrf)
      if (kind === 'disarm') response = await controlApi.disarm(venueName, csrf)
      if (kind === 'reconcile') response = await controlApi.reconcile(venueName, value, csrf)
      if (kind === 'execute') response = await controlApi.execute(venueName, value, secondValue, csrf)
      if (kind === 'plan' && response?.plan_summary) {
        setTestnet((current) => ({ ...current, [venueName]: { ...current[venueName], plan_summary: response.plan_summary } }))
        setPlanHashes((current) => ({ ...current, [venueName]: response.plan_summary.plan_hash || '' }))
      }
      pushMessage(VENUE_NAMES[venueName], statusLabel(response?.outcome || response?.status) || '操作已返回', response?.ok === false ? 'warning' : 'event')
      await refresh()
    } catch (error) { setNotice(`场所操作失败：${error.message}`); pushMessage(VENUE_NAMES[venueName], `操作失败：${error.message}`, 'warning') } finally {
      if (kind === 'arm') setArmConfirmations((current) => ({ ...current, [venueName]: '' }))
    }
  }

  const workflow = useMemo(() => deriveWorkflowState({ dag, status: cycle, events: roleEvents }), [dag, cycle, roleEvents])
  const selectedNode = workflow.byRole[selected]
  if (!csrf) return <Login onLogin={login} error={loginError} />

  const working = busy || providerBusy
  const currentModels = modelConfig.effective_models
  const hasRun = busy || cycle?.outcome || cycle?.status === 'failed'
  return <div className={`app-shell theme-${theme} ${panel ? 'panel-open' : ''}`}>
    <AgentSidebar workflow={workflow} models={modelConfig} selected={selected} onSelect={(role) => { setSelected(role); setPanel('details') }} onChat={() => setPanel(null)} onSettings={() => setPanel('settings')} />
    <main className="chat-workspace">
      <header className="chat-topbar"><div><h1>主 Agent</h1><span className="main-model">{currentModels.orchestrator} · {modelConfig.effective_efforts.orchestrator}</span></div><div className="topbar-actions"><button type="button" className="quiet-action" onClick={() => setPanel((current) => current ? null : 'settings')} aria-expanded={Boolean(panel)}>设置与详情</button><button type="button" className="primary-action run-workflow" onClick={runCycle} disabled={working || !setup || setup.status === 'blocked'}>{busy ? phase : '运行 workflow'}</button></div></header>
      {(!provider.configured || !setup?.ready) && <div className="readiness-banner"><span>{!provider.configured ? '填写模型连接后，即可开始讨论。' : '模型已连接。运行前请完成首次模拟设置。'}</span><button type="button" onClick={() => setPanel('settings')}>打开设置</button></div>}
      {notice && <div className="notice" role="alert">{notice}</div>}
      {hasRun && <RunResult cycle={cycle} workflow={workflow} phase={phase} busy={busy} />}
      <section className="chat-scroll" aria-label="主 Agent 对话"><div className="conversation">
        {discussion.length === 0 && <div className="chat-empty"><h2>从主 Agent 开始</h2><p>讨论 BTC / ETH 分析策略，或告诉我每个 Agent 应使用什么模型与 effort。</p><p>建议会先展示，只有明确应用后才会生效。</p></div>}
        <div className="discussion-messages" aria-live="polite">{discussion.map((item, index) => <article key={index} className={'discussion-' + item.role}><span className="message-author">{item.role === 'user' ? '你' : '主 Agent'}</span><p>{item.content}</p></article>)}</div>
        {providerBusy && <div className="chat-pending" role="status">正在处理…</div>}
        {suggestion && <section className="suggestion-card"><h3>策略建议</h3><p className="suggested-text">{suggestion}</p><button type="button" className="quiet-action" disabled={working} onClick={() => { setStrategyDraft(suggestion); setPanel('strategy') }}>放入策略草稿</button><span className="field-note">编辑后单独应用</span></section>}
        <ModelSuggestion suggestion={modelSuggestion} models={modelConfig} onApply={applyModels} busy={working} />
      </div></section>
      <div className="composer-area"><form className="chat-composer" onSubmit={(event) => { event.preventDefault(); discuss() }}><label className="sr-only" htmlFor="discussion-input">发送给主 Agent</label><textarea id="discussion-input" value={discussionMessage} onChange={(event) => setDiscussionMessage(event.target.value)} maxLength={8000} rows={3} disabled={working} placeholder="讨论策略，或调整 Agent 模型与 effort…" onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); discuss() } }} /><div className="composer-controls"><span>主 Agent · {currentModels.orchestrator}</span><button type="submit" className="send-action" disabled={working || !discussionMessage.trim()}>发送</button></div></form><p className="composer-note">⌘ / Ctrl + Enter 发送 · 会话内保存 · Paper 单次运行</p></div>
    </main>
    {panel && <aside className="context-panel" aria-label="设置与运行详情"><header className="panel-header"><h2>工作台</h2><button type="button" className="icon-action" aria-label="关闭设置" onClick={() => setPanel(null)}>×</button></header><nav className="panel-tabs" aria-label="设置分类">{[['settings', '设置'], ['strategy', '策略'], ['details', '运行详情']].map(([value, label]) => <button type="button" key={value} aria-pressed={panel === value} onClick={() => setPanel(value)}>{label}</button>)}</nav><div className="panel-scroll">
      {panel === 'settings' && <form className="entry-form" noValidate onSubmit={(event) => { event.preventDefault(); runCycle() }}><ProviderPanel provider={provider} model={providerModel} catalog={modelConfig.allowed_models} endpoint={providerEndpoint} apiKey={providerApiKey} setModel={setProviderModel} setEndpoint={setProviderEndpoint} setApiKey={setProviderApiKey} busy={working} /><PaperSetup setup={setup} draft={paperDraft} onChange={(key, value) => setPaperDraft((current) => ({ ...current, [key]: value }))} busy={working} /><p className="field-note">填写后点击顶部「运行 workflow」。日期与周次自动使用当日 UTC。</p><details className="saved-models"><summary>当前 Agent 模型</summary><dl>{WORKFLOW_NODES.map(({ role, name }) => <div key={role}><dt>{name}</dt><dd>{currentModels[role]} · {modelConfig.effective_efforts[role]}</dd></div>)}</dl><p className="field-note">可在主 Agent 对话中提出变更，确认建议后应用。</p></details></form>}
      {panel === 'strategy' && <StrategyPanel draft={strategyDraft} applied={appliedStrategy} setDraft={setStrategyDraft} onApply={applyStrategy} busy={working} />}
      {panel === 'details' && <section className="run-details"><Docket selected={selected} workflow={workflow} onSelect={setSelected} /><div className="stream-heading"><h2>事件日志 · {selectedNode?.name}</h2><Tone value={selectedNode?.status || 'waiting'} /></div><MessageStream messages={messages} /><p className="field-note">模拟状态：{statusLabel(paper?.status || cycle?.outcome)}</p></section>}
      <details className="advanced"><summary>高级</summary><div className="advanced-actions"><span>会话有效至 {formatTime(sessionExpiry)}</span><Tone value={status?.service || status?.status} /><button type="button" className="quiet-action" onClick={clearProvider} disabled={working || !provider.configured}>清除模型连接</button><button type="button" className="quiet-action" onClick={() => setTheme((current) => current === 'light' ? 'night' : 'light')}>{theme === 'light' ? '深色模式' : '浅色模式'}</button><button type="button" className="quiet-action" onClick={logout} disabled={working}>退出会话</button></div><h2>测试网控制</h2><div className="venue-panels">{VENUES.map((venueName) => <VenueCard key={venueName} venue={venueName} data={testnet[venueName]} csrf={working ? null : csrf} onAction={action} date={currentCycleWindow().date} isoWeek={currentCycleWindow().isoWeek} planHash={planHashes[venueName]} confirmation={confirmations[venueName]} setConfirmation={(value) => setConfirmations((current) => ({ ...current, [venueName]: value }))} armConfirmation={armConfirmations[venueName]} setArmConfirmation={(value) => setArmConfirmations((current) => ({ ...current, [venueName]: value }))} />)}</div></details>
    </div></aside>}
  </div>
}
