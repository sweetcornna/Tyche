import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ModelSettings } from './ModelSettings.jsx'
import { controlApi, eventsUrl, isSessionFailure } from './api.js'
import { WORKFLOW_NODES, deriveWorkflowState, normalizeWorkflowStatus } from './workflow.js'
import { PAPER_FIELDS, CONNECTION_PROTOCOLS, createWorkflowRunner, saveConnection, discoveryRequest, normalizeConnectionEndpoint } from './workflow-entry.js'

export { WORKFLOW_NODES, deriveWorkflowState, normalizeWorkflowStatus } from './workflow.js'

const ROLES = Object.freeze(WORKFLOW_NODES.map(({ role }) => role))
const VENUES = Object.freeze(['gate', 'binance'])
const VENUE_NAMES = Object.freeze({ gate: 'Gate', binance: 'Binance' })
const DEFAULT_MODEL = ['g', 'p', 't', '-', '6', '-', 'astra'].join('')
const DEFAULT_EFFORTS = Object.freeze(Object.fromEntries(ROLES.map((role) => [role, role === 'preflight' ? 'medium' : role === 'reviewer' ? 'xhigh' : 'high'])))
const EMPTY_MODELS = Object.freeze({ default_model: DEFAULT_MODEL, allowed_models: [DEFAULT_MODEL], role_models: {}, role_efforts: {}, effective_efforts: DEFAULT_EFFORTS, allowed_efforts: ['medium', 'high', 'xhigh'], pool: [{ id: DEFAULT_MODEL, efforts: ['medium', 'high', 'xhigh'] }], known_models: [DEFAULT_MODEL], pool_metadata: [{ id: DEFAULT_MODEL, source: 'host_catalog' }], mode: 'auto', bootstrap: { model: DEFAULT_MODEL, effort: 'high' }, chat: { model: DEFAULT_MODEL, effort: 'high' }, allocation_state: 'ready', allocation_source: 'default', allocation_reasons: {}, effective_models: Object.fromEntries(ROLES.map((role) => [role, DEFAULT_MODEL])) })
const EMPTY_PROVIDER = Object.freeze({ configured: false, provider: null, protocol: null, model: null, endpoint: null, scope: 'session', manual_cycle_only: true })

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

function ProviderPanel({ provider, protocol, endpoint, apiKey, setProtocol, setEndpoint, setApiKey, onConnectionBlur, onDiscover, catalog, busy }) {
  const configured = provider?.configured === true
  const selected = CONNECTION_PROTOCOLS.find(({ id }) => id === protocol) || CONNECTION_PROTOCOLS[0]
  return <section className="connection-section">
    <div className="section-heading"><h2>模型连接</h2><Tone value={configured ? 'ready' : 'waiting'} label={configured ? '当前会话已连接' : '待填写'} /></div>
    <label>API 协议<select value={protocol} disabled={busy} onChange={(event) => setProtocol(event.target.value)}>{CONNECTION_PROTOCOLS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
    <p className="field-note">{selected.hint}</p>
    <div className="connection-fields">
      <label>API endpoint<input type="text" value={endpoint} onBlur={onConnectionBlur} onChange={(event) => setEndpoint(event.target.value)} placeholder={selected.example} spellCheck="false" disabled={busy} /></label>
      <label>API key<input type="password" value={apiKey} onBlur={onConnectionBlur} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" spellCheck="false" disabled={busy} placeholder={configured ? '已保存；留空继续使用' : '填写模型 API key'} /></label>
    </div>

    <button type="button" className="quiet-action" onClick={onDiscover} disabled={busy}>重新检测模型</button>
    <p className="field-note">{endpoint && `实际基础地址：${endpoint}`} 填完连接字段并离开输入框时检测；也可直接发送消息。目录不可用时可手动配置模型池后继续。</p>
    {catalog && <CatalogSummary catalog={catalog} />}
    <p className="field-note">API key 只保留在当前会话内，退出或重启服务后清除。模型需由你的 API 服务支持。</p>
  </section>
}

function CatalogSummary({ catalog }) {
  return <section className="saved-models"><h3>服务商模型目录 · {catalog.entries.length} 项</h3><p className="field-note">{catalog.message}</p><p className="field-note">{catalog.selection_rule} 可用候选 {catalog.eligible_count} 项，未选入 {catalog.omitted_eligible_count} 项。目录有效至 {formatTime(catalog.expires_at)}。</p><details><summary>查看模型及 effort 来源</summary><dl>{catalog.entries.map((entry) => <div key={entry.id}><dt>{entry.id}</dt><dd>服务商已列出 · {entry.efforts.length ? entry.efforts.join(' / ') : 'effort 未知或当前协议不可用'} · {({ host_catalog: '本机能力目录', pinned_sdk: '固定 SDK 能力', user_declared: '用户明确声明', unknown: '未知能力' })[entry.capability_source]}</dd></div>)}</dl></details></section>
}

function PaperSetup({ setup, draft }) {
  if (!setup) return <p className="field-note">正在检查模拟设置…</p>
  const values = { ...draft?.paper_settings, ...setup.values }
  return <section className="saved-paper"><div className="section-heading"><h2>模拟设置</h2><Tone value={setup.status} label={setup.ready ? '已就绪' : setup.status === 'blocked' ? '需处理' : '待补充'} /></div>
    {setup.message && <p className="form-error">{setup.message}</p>}
    {!setup.ready && <p className="field-note">告诉主 Agent 你的目标；不确定时可请它安排模拟起点。草稿不会创建账户。</p>}
    <dl>{PAPER_FIELDS.map(({ key, label, unit }) => <div key={key}><dt>{label}</dt><dd>{values[key] ? `${values[key]} ${unit}${Object.hasOwn(setup.values, key) ? '' : ' · 草稿'}` : '待讨论'}</dd></div>)}</dl>
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

function AgentSidebar({ workflow, models, selected, onSelect, onChat, onSettings }) {
  return <aside className="agent-sidebar"><div className="brand-lockup"><span className="brand-mark">τ</span><strong>Tyche</strong></div>
    <nav className="workspace-nav" aria-label="工作台导航"><button type="button" className="nav-current" onClick={onChat}>主 Agent</button><button type="button" onClick={onSettings}>运行设置</button></nav>
    <div className="sidebar-label">工作流 Agent</div><nav className="agent-list" aria-label="固定六个 Agent">{WORKFLOW_NODES.map(({ role, name }) => <button type="button" key={role} className={selected === role ? 'selected' : ''} onClick={() => onSelect(role)} data-role={role} data-status={workflow.byRole[role].status}><span className="agent-row"><strong>{name}</strong><Tone value={workflow.byRole[role].status} label={workflow.byRole[role].statusLabel} /></span><span className="agent-model">{models.effective_models[role]} · {models.effective_efforts[role]}</span></button>)}</nav>
    <div className="sidebar-foot"><span>BTC / ETH</span><span>Paper · 单次运行</span></div>
  </aside>
}

function compactValue(value) {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function Login({ onLogin, onResume, busy, canResume, error }) {
  const [token, setToken] = useState('')
  return <main className="login-shell"><div className="login-card"><span className="brand-mark large">τ</span><h1>登录 Tyche</h1><p className="login-copy">请输入本机配置的固定 token，或本地服务打印的临时 bootstrap token。本页面不会存储该凭据。</p><form onSubmit={(event) => { event.preventDefault(); onLogin(token) }}><label>bootstrap token<input autoFocus value={token} onChange={(event) => setToken(event.target.value)} type="password" spellCheck="false" disabled={busy} /></label><button type="submit" className="primary-action" disabled={busy || !token.trim()}>{busy ? '正在确认会话…' : '进入工作台'}</button></form>{canResume && <button type="button" className="quiet-action" onClick={onResume} disabled={busy}>恢复当前会话</button>}{error && <p className="form-error" role="alert">{error}</p>}</div></main>
}

export function App() {
  const [csrf, setCsrf] = useState(null)
  const [sessionExpiry, setSessionExpiry] = useState(null)
  const [loginError, setLoginError] = useState('')
  const [authBusy, setAuthBusy] = useState(true)
  const [canResume, setCanResume] = useState(false)
  const [selected, setSelected] = useState('orchestrator')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [theme, setTheme] = useState('light')
  const [status, setStatus] = useState({ service: 'connecting' })
  const [provider, setProvider] = useState(EMPTY_PROVIDER)
  const [connectionDraft, setConnectionDraft] = useState({ protocol: CONNECTION_PROTOCOLS[0].id, endpoint: '', apiKey: '', model: DEFAULT_MODEL, dirty: false })
  const { protocol: providerProtocol, endpoint: providerEndpoint, apiKey: providerApiKey, model: providerModel } = connectionDraft
  const [providerBusy, setProviderBusy] = useState(false)
  const [panel, setPanel] = useState(null)
  const [modelConfig, setModelConfig] = useState(EMPTY_MODELS)
  const [settingsResult, setSettingsResult] = useState(null)
  const [settingsDraft, setSettingsDraft] = useState({})
  const [preferences, setPreferences] = useState('')
  const [setup, setSetup] = useState(null)
  const [phase, setPhase] = useState('')
  const [appliedStrategy, setAppliedStrategy] = useState('')
  const [discussion, setDiscussion] = useState([])
  const [discussionMessage, setDiscussionMessage] = useState('')
  const [cycle, setCycle] = useState({ status: 'idle' })
  const [dag, setDag] = useState(EMPTY_DAG)
  const [paper, setPaper] = useState({ status: 'paper-only' })
  const [testnet, setTestnet] = useState(EMPTY_TESTNET)
  const [messages, setMessages] = useState([])
  const [roleEvents, setRoleEvents] = useState({})
  const wsRef = useRef(null)
  const authRef = useRef({ csrf: null })
  const authenticationRef = useRef(null)
  const connectionDraftRef = useRef(connectionDraft)
  const operationRef = useRef(false)
  const connectionRevisionRef = useRef(0)
  const discoveryAttemptRef = useRef(null)
  const configurationRevisionRef = useRef(0)
  const cycleRunningRef = useRef(false)
  const workflowRunner = useMemo(() => createWorkflowRunner(controlApi), [csrf])

  const updateConnectionDraft = useCallback((changes) => {
    const next = { ...connectionDraftRef.current, ...changes }
    connectionDraftRef.current = next
    setConnectionDraft(next)
  }, [])
  const connectionIdentity = (draft) => {
    try { return `${draft.protocol}:${normalizeConnectionEndpoint(draft.endpoint, draft.protocol)}` } catch { return null }
  }
  const editConnection = (changes) => {
    const before = connectionDraftRef.current
    const next = { ...before, ...changes }
    if (next.protocol !== before.protocol || ('endpoint' in changes && before.endpoint !== next.endpoint && (!connectionIdentity(before) || connectionIdentity(before) !== connectionIdentity(next)))) next.apiKey = ''
    connectionRevisionRef.current++; discoveryAttemptRef.current = null
    updateConnectionDraft({ ...next, dirty: true })
    setModelConfig((current) => ({ ...current, catalog: null }))
  }
  const setProviderProtocol = (protocol) => editConnection({ protocol })
  const setProviderEndpoint = (endpoint) => editConnection({ endpoint })
  const setProviderApiKey = (apiKey) => editConnection({ apiKey })
  const setProviderModel = (model) => updateConnectionDraft({ model })

  const clearAppliedSession = useCallback(() => {
    setProvider(EMPTY_PROVIDER); setAppliedStrategy(''); setDiscussion([]); setModelConfig(EMPTY_MODELS)
    setSettingsResult(null); setSettingsDraft({}); setPreferences(''); setTheme('light'); setSetup(null)
    discoveryAttemptRef.current = null; connectionRevisionRef.current++
    setStatus({ service: 'connecting' }); setCycle({ status: 'idle' }); setDag(EMPTY_DAG); setPaper({ status: 'paper-only' }); setTestnet(EMPTY_TESTNET)
    setRoleEvents({}); setMessages([]); setPhase(''); configurationRevisionRef.current++
  }, [])

  const handleSessionFailure = useCallback((error, expected) => {
    if (authRef.current !== expected) return true
    if (!isSessionFailure(error)) return false
    authRef.current = { csrf: null }
    operationRef.current = false; cycleRunningRef.current = false
    wsRef.current?.close(); setCsrf(null); setSessionExpiry(null); setBusy(false); setProviderBusy(false)
    clearAppliedSession()
    setCanResume(true)
    setLoginError(error.code === 'CONTROL_CSRF_REJECTED'
      ? '会话已在其他标签页更新。未提交的连接与消息仍保留；请恢复会话，确认后重新发送。'
      : '会话已退出或过期。未提交的连接与消息仍保留；请重新登录后确认再发送。')
    return true
  }, [clearAppliedSession])

  const requireCurrentSession = (expected) => {
    if (authRef.current !== expected || !expected.csrf) throw new Error('会话已变化，请确认后重新操作。')
  }

  const pushMessage = useCallback((label, text, kind = 'event', detail = '') => {
    setMessages((current) => [...current.slice(-39), { id: `${Date.now()}-${Math.random()}`, label, text, kind, detail, at: new Date().toISOString() }])
  }, [])

  const refresh = useCallback(async (expected = authRef.current) => {
    if (!expected.csrf || authRef.current !== expected) return false
    const revision = configurationRevisionRef.current
    try {
    const [nextStatus, nextProvider, nextCycle, nextDag, nextPaper, nextTestnet, nextSetup, nextModels, nextSettings] = await Promise.all([controlApi.status(expected.csrf), controlApi.providerStatus(expected.csrf), controlApi.cycle(expected.csrf), controlApi.dag(expected.csrf), controlApi.paper(expected.csrf), controlApi.testnet(expected.csrf), controlApi.paperSetup(expected.csrf), controlApi.models(expected.csrf), controlApi.strategy(expected.csrf)])
    if (authRef.current !== expected) return false
    if (!operationRef.current && revision === configurationRevisionRef.current) {
      setProvider(nextProvider?.configured ? nextProvider : EMPTY_PROVIDER); setSetup(nextSetup); setModelConfig(connectionDraftRef.current.dirty && !(discoveryAttemptRef.current?.complete && discoveryAttemptRef.current?.revision === connectionRevisionRef.current && discoveryAttemptRef.current?.expected === expected) ? { ...nextModels, catalog: null } : nextModels); setAppliedStrategy(nextSettings.prompt); setDiscussion(nextSettings.discussion); setTheme(nextSettings.theme); setSettingsDraft(nextSettings.draft); setSettingsResult(nextSettings.settings_result); setPreferences(nextSettings.preferences)
      updateConnectionDraft({ model: nextModels.default_model, ...(!connectionDraftRef.current.dirty ? { protocol: nextProvider?.protocol || CONNECTION_PROTOCOLS[0].id, endpoint: nextProvider?.configured ? nextProvider.endpoint : '', apiKey: '', dirty: false } : {}) })
    }
    setStatus(nextStatus); setPaper(nextPaper)
    if (!cycleRunningRef.current) { setCycle(nextCycle); setDag(nextDag) }
    setTestnet((current) => Object.fromEntries(VENUES.map((venue) => [venue, { ...(nextTestnet?.[venue] || {}), plan_summary: nextTestnet?.[venue]?.plan_summary || current?.[venue]?.plan_summary } ])))
    return true
    } catch (error) { if (handleSessionFailure(error, expected)) return false; throw error }
  }, [handleSessionFailure, updateConnectionDraft])

  const openEvents = useCallback(() => {
    const expected = authRef.current
    wsRef.current?.close()
    const socket = new WebSocket(eventsUrl())
    socket.onopen = () => { if (authRef.current === expected) pushMessage('控制平面', '事件流已连接', 'system') }
    socket.onmessage = (event) => {
      if (authRef.current !== expected) return
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
    socket.onerror = () => { if (authRef.current === expected) pushMessage('控制平面', '事件流暂不可用，仍可使用轮询更新', 'warning') }
    socket.onclose = () => { if (authRef.current === expected) refresh(expected).catch(() => {}) }
    wsRef.current = socket
  }, [pushMessage, refresh])

  useEffect(() => {
    if (!csrf || authBusy) return undefined
    refresh().catch((error) => setNotice(`刷新失败：${error.message}`))
    openEvents()
    const timer = window.setInterval(() => refresh().catch(() => {}), 15_000)
    const onFocus = () => refresh().catch(() => {})
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); wsRef.current?.close() }
  }, [csrf, authBusy, refresh, openEvents])

  const authenticate = async (bootstrapToken, initial = false) => {
    if (authenticationRef.current) return
    const attempt = { csrf: null }
    let expected = attempt
    authenticationRef.current = attempt
    authRef.current = attempt
    setAuthBusy(true)
    try {
      setLoginError('')
      const response = bootstrapToken === undefined ? await controlApi.resumeSession() : await controlApi.session(bootstrapToken.trim())
      if (authRef.current !== attempt) return
      const accepted = { csrf: response.csrf_token }
      expected = accepted
      authRef.current = accepted
      clearAppliedSession()
      setCsrf(response.csrf_token); setSessionExpiry(response.expires_at)
      if (!await refresh(accepted) || authRef.current !== accepted) return
      setCanResume(false)
      setNotice(initial ? '' : '会话已就绪。请确认当前设置与保留的连接草稿，再自行发送；此前操作不会自动重试。')
      if (connectionDraftRef.current.dirty) setPanel('settings')
      pushMessage('会话', '当前标签页已通过验证', 'system')
    } catch (error) {
      if (authRef.current !== expected) return
      authRef.current = { csrf: null }; setCsrf(null); setSessionExpiry(null)
      setCanResume(expected !== attempt)
      setLoginError(initial && isSessionFailure(error) ? '' : `登录或恢复失败：${error.message}`)
    } finally {
      if (authenticationRef.current === attempt) { authenticationRef.current = null; setAuthBusy(false) }
    }
  }

  useEffect(() => {
    authenticate(undefined, true)
    return () => { authRef.current = { csrf: null }; wsRef.current?.close() }
  }, [])

  const detectConnection = async (expected, force = false) => {
    const revision = connectionRevisionRef.current
    if (!force && discoveryAttemptRef.current?.revision === revision && discoveryAttemptRef.current?.expected === expected) return provider
    const draft = { ...connectionDraftRef.current }
    const request = discoveryRequest(provider, draft)
    discoveryAttemptRef.current = { revision, expected }
    updateConnectionDraft({ endpoint: request.endpoint })
    try {
      const response = await controlApi.discoverProvider(request, expected.csrf)
      requireCurrentSession(expected)
      if (connectionRevisionRef.current !== revision) throw new Error('连接输入已变化，旧目录结果已丢弃。')
      discoveryAttemptRef.current = { revision, expected, complete: true }
      setModelConfig(response.models)
      if (response.connection_saved) {
        setProvider(response.provider)
        updateConnectionDraft({ protocol: response.provider.protocol, endpoint: response.provider.endpoint, model: response.models.default_model, apiKey: '', dirty: false })
      }
      setNotice(response.catalog.message)
      return response.connection_saved ? response.provider : provider
    } catch (error) {
      if (handleSessionFailure(error, expected)) throw error
      requireCurrentSession(expected)
      if (connectionRevisionRef.current === revision) setNotice(`目录检测失败：${error.message} 可在模型面板手动配置后发送，或重新检测。`)
      throw error
    }
  }

  const discoverConnection = async (force = false) => {
    if (operationRef.current || !authRef.current.csrf) return
    if (!force) { try { discoveryRequest(provider, connectionDraftRef.current) } catch { return } }
    const expected = authRef.current; const operation = { expected }
    operationRef.current = operation; configurationRevisionRef.current++
    try { setProviderBusy(true); await detectConnection(expected, force) } catch (error) { if (!handleSessionFailure(error, expected) && authRef.current === expected) setNotice(`目录检测未完成：${error.message} 可手动配置后继续。`) }
    finally { if (operationRef.current === operation) { operationRef.current = false; setProviderBusy(false) } }
  }

  const onConnectionBlur = () => {
    try { updateConnectionDraft({ endpoint: normalizeConnectionEndpoint(connectionDraftRef.current.endpoint.trim(), connectionDraftRef.current.protocol) }) } catch { return }
    discoverConnection()
  }

  const runCycle = async () => {
    if (operationRef.current || !authRef.current.csrf) return
    if (modelConfig.allocation_state !== 'ready') { setPanel('models'); setNotice('请先让主 Agent 分配，或修正手动角色选择。'); return }
    if (!setup?.ready) { await discuss('我想运行一次 Paper workflow。请根据已知信息主动问必要的问题；先帮我完成模拟设置。'); return }
    const expected = authRef.current
    const operation = { expected }
    operationRef.current = operation
    configurationRevisionRef.current++
    cycleRunningRef.current = true
    try {
      setBusy(true); setNotice('')
      const response = await workflowRunner({ csrf: expected.csrf, provider, connection: { ...connectionDraftRef.current }, setup, onPhase: (next) => { requireCurrentSession(expected); setPhase(next); if (next === '正在运行 workflow…') { setDag(EMPTY_DAG); setRoleEvents(EMPTY_ROLE_EVENTS); setCycle({ status: 'running' }) } }, onProvider: (next) => { requireCurrentSession(expected); acceptProvider(next) }, onSetup: (next) => { requireCurrentSession(expected); setSetup(next) } })
      requireCurrentSession(expected)
      updateConnectionDraft({ apiKey: '', dirty: false })
      if (response) { setCycle(response); pushMessage('workflow', statusLabel(response.status || response.outcome), response.ok === false ? 'warning' : 'event') }
      cycleRunningRef.current = false
      await refresh(expected)
    } catch (error) { if (handleSessionFailure(error, expected)) return; setPanel('settings'); setNotice(`运行失败：${error.message}`); setCycle((current) => current.status === 'running' ? { ok: false, status: 'failed', blocked_stage: 'workflow', message: error.message } : current) } finally { if (operationRef.current === operation) { setBusy(false); cycleRunningRef.current = false; operationRef.current = false } }
  }

  const acceptProvider = (response) => {
    setProvider(response)
    setModelConfig((current) => ({ ...current, default_model: response.model, effective_models: Object.fromEntries(ROLES.map((role) => [role, current.role_models[role] || response.model])) }))
  }

  const discuss = async (message = discussionMessage, allocate = false) => {
    if (operationRef.current || !authRef.current.csrf) return
    const expected = authRef.current
    const operation = { expected }
    operationRef.current = operation
    configurationRevisionRef.current++
    try {
      setProviderBusy(true); setNotice('')
      let detected = provider
      if (discoveryAttemptRef.current?.revision !== connectionRevisionRef.current || discoveryAttemptRef.current?.expected !== expected) {
        try { detected = await detectConnection(expected) } catch (error) { if (handleSessionFailure(error, expected)) return; requireCurrentSession(expected) }
      }
      const connection = await saveConnection(controlApi, expected.csrf, detected, { ...connectionDraftRef.current })
      requireCurrentSession(expected)
      acceptProvider(connection)
      const response = await controlApi.discussStrategy(message, expected.csrf, allocate)
      requireCurrentSession(expected)
      const saved = response.settings
      setNotice('')
      updateConnectionDraft({ endpoint: connection.endpoint, protocol: connection.protocol, apiKey: '', dirty: false })
      setDiscussion(saved.discussion); setAppliedStrategy(saved.prompt); setModelConfig(saved.models); setProviderModel(saved.models.default_model); setProvider((current) => current.configured ? { ...current, model: saved.models.default_model } : current); setSetup(saved.paper); setTheme(saved.theme); setSettingsDraft(saved.draft); setSettingsResult(saved.settings_result); setPreferences(saved.preferences); setDiscussionMessage('')
    } catch (error) { if (handleSessionFailure(error, expected)) return; if (!provider.configured) setPanel('settings'); setNotice(`讨论失败：${error.message}`) } finally { if (operationRef.current === operation) { setProviderBusy(false); operationRef.current = false } }
  }

  const saveModels = async (input) => {
    if (operationRef.current || !authRef.current.csrf) return null
    const expected = authRef.current
    const operation = { expected }
    operationRef.current = operation; configurationRevisionRef.current++
    try {
      setProviderBusy(true); setNotice('')
      const response = await controlApi.applyModels(input, expected.csrf)
      requireCurrentSession(expected)
      setModelConfig(response); setProviderModel(response.default_model)
      setProvider((current) => current.configured ? { ...current, model: response.default_model } : current)
      return response
    } catch (error) { if (!handleSessionFailure(error, expected)) setNotice(`模型配置未保存：${error.message}`); return null } finally { if (operationRef.current === operation) { setProviderBusy(false); operationRef.current = false } }
  }

  const clearProvider = async () => {
    if (operationRef.current || !authRef.current.csrf) return
    const expected = authRef.current
    const operation = { expected }
    operationRef.current = operation
    configurationRevisionRef.current++
    try {
      setProviderBusy(true); setNotice('')
      const response = await controlApi.clearProvider(expected.csrf)
      requireCurrentSession(expected)
      discoveryAttemptRef.current = null; connectionRevisionRef.current++
      setProvider(response?.configured ? response : EMPTY_PROVIDER); updateConnectionDraft({ model: modelConfig.bootstrap.model, protocol: CONNECTION_PROTOCOLS[0].id, endpoint: '', apiKey: '', dirty: false }); pushMessage('模型连接', '当前会话的模型连接已清除', 'system')
      setModelConfig((current) => ({ ...current, catalog: null, default_model: current.bootstrap.model, effective_models: Object.fromEntries(ROLES.map((role) => [role, current.role_models[role] || current.bootstrap.model])) }))
    } catch (error) {
      if (handleSessionFailure(error, expected)) return
      setNotice(`模型连接清除失败：${error.message}`); pushMessage('模型连接', `清除失败：${error.message}`, 'warning')
    } finally {
      if (operationRef.current === operation) { setProviderBusy(false); operationRef.current = false }
    }
  }

  const logout = async () => {
    if (operationRef.current || authenticationRef.current || !authRef.current.csrf) return
    const previous = authRef.current
    const attempt = { csrf: null }
    authRef.current = attempt; authenticationRef.current = attempt
    setAuthBusy(true); setCsrf(null); setSessionExpiry(null); wsRef.current?.close(); clearAppliedSession()
    try {
      await controlApi.logout(previous.csrf)
      if (authRef.current !== attempt) return
      updateConnectionDraft({ protocol: CONNECTION_PROTOCOLS[0].id, endpoint: '', apiKey: '', model: DEFAULT_MODEL, dirty: false }); setDiscussionMessage(''); setCanResume(false); setLoginError('')
    } catch (error) {
      if (authRef.current !== attempt) return
      setCanResume(error.code !== 'CONTROL_SESSION_REQUIRED')
      setLoginError(`退出未确认：${error.message}。请恢复当前会话或重新登录；未提交输入仍保留。`)
    } finally {
      if (authenticationRef.current === attempt) { authenticationRef.current = null; setAuthBusy(false) }
    }
  }

  const workflow = useMemo(() => deriveWorkflowState({ dag, status: cycle, events: roleEvents }), [dag, cycle, roleEvents])
  const selectedNode = workflow.byRole[selected]
  if (!csrf || authBusy) return <Login onLogin={(token) => authenticate(token)} onResume={() => authenticate()} busy={authBusy} canResume={canResume} error={loginError} />

  const working = busy || providerBusy
  const currentModels = modelConfig.effective_models
  const hasRun = busy || cycle?.outcome || cycle?.status === 'failed'
  return <div className={`app-shell theme-${theme} ${panel ? 'panel-open' : ''}`}>
    <AgentSidebar workflow={workflow} models={modelConfig} selected={selected} onSelect={(role) => { setSelected(role); setPanel('details') }} onChat={() => setPanel(null)} onSettings={() => setPanel('settings')} />
    <main className="chat-workspace">
      <header className="chat-topbar"><div><h1>主 Agent</h1><span className="main-model">{modelConfig.chat.model} · {modelConfig.chat.effort}</span></div><div className="topbar-actions"><button type="button" className="quiet-action" onClick={() => setPanel((current) => current ? null : 'settings')} aria-expanded={Boolean(panel)}>设置与详情</button><button type="button" className="primary-action run-workflow" onClick={runCycle} disabled={working}>{busy ? phase : '运行 workflow'}</button></div></header>
      {(!provider.configured || !setup?.ready) && <div className="readiness-banner"><span>{!provider.configured ? '填写模型连接后，即可开始讨论。' : '告诉主 Agent 你的想法，它会补问并配置模拟起点。'}</span><button type="button" onClick={() => setPanel('settings')}>打开设置</button></div>}
      {notice && <div className="notice" role="alert">{notice}</div>}
      {hasRun && <RunResult cycle={cycle} workflow={workflow} phase={phase} busy={busy} />}
      <section className="chat-scroll" aria-label="主 Agent 对话"><div className="conversation">
        {discussion.length === 0 && <div className="chat-empty"><h2>从主 Agent 开始</h2><p>你希望用 BTC / ETH 模拟验证什么想法？更偏好谨慎尝试，还是观察趋势机会？</p><p>先在设置中填写 API 域名和 Key，再告诉我你的目标。不确定时直接说“由你安排模拟起点”，我会说明假设并完成设置。</p></div>}
        <div className="discussion-messages" aria-live="polite">{discussion.map((item, index) => <article key={index} className={'discussion-' + item.role}><span className="message-author">{item.role === 'user' ? '你' : '主 Agent'}</span><p>{item.content}</p></article>)}</div>
        {providerBusy && <div className="chat-pending" role="status">正在处理…</div>}
        {settingsResult && <section className="suggestion-card" role="status"><h3>{({ applied: '设置已应用', pending: '待补充信息', failed: '设置未应用', unchanged: '配置未变' })[settingsResult.status]}</h3><p>{settingsResult.message}</p>{settingsResult.assumptions?.length > 0 && <p className="field-note">{settingsResult.assumptions.map((text) => `模拟假设：${text}`).join('；')}</p>}</section>}
      </div></section>
      <div className="composer-area"><form className="chat-composer" onSubmit={(event) => { event.preventDefault(); discuss() }}><label className="sr-only" htmlFor="discussion-input">发送给主 Agent</label><textarea id="discussion-input" value={discussionMessage} onChange={(event) => setDiscussionMessage(event.target.value)} maxLength={8000} rows={3} disabled={working} placeholder="告诉我你的目标、调整想法，或说“由你安排模拟起点”…" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!event.repeat && !working && discussionMessage.trim()) discuss() } }} /><div className="composer-controls"><span>主 Agent · {modelConfig.chat.model}</span><button type="submit" className="send-action" disabled={working || !discussionMessage.trim()}>发送</button></div></form><p className="composer-note">Enter 发送 · Shift + Enter 换行 · 会话内保存 · Paper 单次运行</p></div>
    </main>
    {panel && <aside className="context-panel" aria-label="设置与运行详情"><header className="panel-header"><h2>工作台</h2><button type="button" className="icon-action" aria-label="关闭设置" onClick={() => setPanel(null)}>×</button></header><nav className="panel-tabs" aria-label="设置分类">{[['settings', '连接与配置'], ['models', '模型分配'], ['details', '运行详情']].map(([value, label]) => <button type="button" key={value} aria-pressed={panel === value} onClick={() => setPanel(value)}>{label}</button>)}</nav><div className="panel-scroll">
      {panel === 'settings' && <section className="entry-form"><button type="button" className="quiet-action" onClick={() => setPanel('models')}>模型池与分配 · {modelConfig.mode === 'manual' ? '手动' : '自动'}</button><ProviderPanel provider={provider} protocol={providerProtocol} setProtocol={setProviderProtocol} endpoint={providerEndpoint} apiKey={providerApiKey} setEndpoint={setProviderEndpoint} setApiKey={setProviderApiKey} onConnectionBlur={onConnectionBlur} onDiscover={() => discoverConnection(true)} catalog={modelConfig.catalog} busy={working} /><p className="field-note">填写后直接发送消息。日期与周次自动使用当日 UTC。</p><PaperSetup setup={setup} draft={settingsDraft} /><section className="strategy-panel"><h2>当前分析策略</h2><p>{appliedStrategy || '尚未定制，将按固定分析职责运行。'}</p>{preferences && <p className="field-note">已知偏好：{preferences}</p>}</section><details className="saved-models"><summary>当前 Agent 模型与 effort</summary><dl>{WORKFLOW_NODES.map(({ role, name }) => <div key={role}><dt>{name}</dt><dd>{currentModels[role]} · {modelConfig.effective_efforts[role]}</dd></div>)}</dl><p className="field-note">策略与主题通过主 Agent 调整；模型可在「模型分配」中自动或手动配置。策略、模型、偏好仅当前会话有效；已创建的模拟账户会保留。</p></details></section>}
      {panel === 'models' && <>{modelConfig.catalog && <CatalogSummary catalog={modelConfig.catalog} />}<ModelSettings config={modelConfig} busy={working} onSave={saveModels} onAllocate={() => discuss('请根据我的目标与可用模型池，为六个 Agent 自动分配模型和 effort，并给出各自依据。', true)} /></>}
      {panel === 'details' && <section className="run-details"><Docket selected={selected} workflow={workflow} onSelect={setSelected} /><div className="stream-heading"><h2>事件日志 · {selectedNode?.name}</h2><Tone value={selectedNode?.status || 'waiting'} /></div><MessageStream messages={messages} /><p className="field-note">模拟状态：{statusLabel(paper?.status || cycle?.outcome)}</p></section>}
      <details className="advanced"><summary>会话与测试网状态</summary><div className="advanced-actions"><span>会话有效至 {formatTime(sessionExpiry)}</span><Tone value={status?.service || status?.status} /><button type="button" className="quiet-action" onClick={clearProvider} disabled={working || !provider.configured}>清除模型连接</button><button type="button" className="quiet-action" onClick={logout} disabled={working}>退出会话</button></div><h2>独立测试网</h2><p className="field-note">主聊天只配置 Paper 模拟，不会开启测试网执行。独立测试网仍需原有配置、授权和执行确认。</p>{VENUES.map((venueName) => <p key={venueName}>{VENUE_NAMES[venueName]}：<Tone value={testnet[venueName]?.armed ? 'armed' : testnet[venueName]?.status || 'unconfigured'} /></p>)}</details>

    </div></aside>}
  </div>
}
