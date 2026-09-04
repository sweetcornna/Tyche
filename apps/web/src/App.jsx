import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { controlApi, eventsUrl } from './api.js'
import { WORKFLOW_NODES, deriveWorkflowState, normalizeWorkflowStatus } from './workflow.js'

export { WORKFLOW_NODES, deriveWorkflowState, normalizeWorkflowStatus } from './workflow.js'

const ROLES = Object.freeze(WORKFLOW_NODES.map(({ role }) => role))
const VENUES = Object.freeze(['gate', 'binance'])
const VENUE_NAMES = Object.freeze({ gate: 'Gate', binance: 'Binance' })
const ARM_PHRASES = Object.freeze({ gate: 'ARM TESTNET GATE 24H', binance: 'ARM TESTNET BINANCE 24H' })

function utcIsoWeek(dateText) {
  const date = new Date(`${dateText}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime())) return ''
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function currentCycleWindow() {
  const date = new Date().toISOString().slice(0, 10)
  return { date, isoWeek: utcIsoWeek(date) }
}

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
      <div className="brand-lockup"><span className="brand-mark">τ</span><div><strong>tyche</strong><small>分析工作台</small></div></div>
      <div className="docket-rule" />
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
      <div className="docket-foot"><span className="pulse" />仅限本机回环<small>语义输出均为临时结果</small></div>
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

function ToolCard({ title, state, detail }) {
  return <div className="tool-card"><div className="tool-icon">↳</div><div className="tool-copy"><strong>{title}</strong><small>{detail}</small></div><Tone value={state} /></div>
}

function CyclePanel({ date, isoWeek, onDate, onWeek, onRun, busy }) {
  return <section className="cycle-panel panel-block">
    <SectionLabel hint="由调度器管理">当前周期</SectionLabel>
    <div className="cycle-current"><span className="current-mark">◉</span><div><strong>周度 / 日度</strong><small>确定性调度器选择运行时段</small></div></div>
    <div className="field-grid"><label>日期<input value={date} onChange={(event) => onDate(event.target.value)} /></label><label>ISO 周<input value={isoWeek} onChange={(event) => onWeek(event.target.value)} /></label></div>
    <button type="button" className="primary-action" onClick={onRun} disabled={busy}>{busy ? '周期运行中…' : '运行当前周期'}</button>
    <div className="cycle-note">Pi 负责提出语义建议；Tyche 的确定性代码决定流程能否继续。</div>
  </section>
}

function PaperSummary({ paper }) {
  const summary = paper?.summary || paper?.projection || {}
  return <section className="panel-block compact-block"><SectionLabel hint="预测结果">模拟摘要</SectionLabel><div className="metric-row"><div><strong>{summary.simulated ?? summary.cycles ?? 0}</strong><small>模拟单位</small></div><Tone value={paper?.status || 'paper-only'} /></div><p className="muted-copy">此工作台仅显示模拟运行的预测结果。</p></section>
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
  return <main className="login-shell"><div className="login-card"><span className="brand-mark large">τ</span><p className="eyebrow">本机回环控制平面</p><h1>让信号留在<br />安全边界内。</h1><p className="login-copy">请输入本地服务打印的一次性 bootstrap token。本页面不会存储该凭据。</p><form onSubmit={(event) => { event.preventDefault(); onLogin(token) }}><label>bootstrap token<input autoFocus value={token} onChange={(event) => setToken(event.target.value)} type="password" spellCheck="false" /></label><button type="submit" className="primary-action" disabled={!token.trim()}>进入工作台</button></form>{error && <p className="form-error">{error}</p>}</div></main>
}

export function App() {
  const initialWindow = useMemo(() => currentCycleWindow(), [])
  const [csrf, setCsrf] = useState(null)
  const [sessionExpiry, setSessionExpiry] = useState(null)
  const [loginError, setLoginError] = useState('')
  const [date, setDate] = useState(initialWindow.date)
  const [isoWeek, setIsoWeek] = useState(initialWindow.isoWeek)
  const [selected, setSelected] = useState('orchestrator')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [theme, setTheme] = useState('paper')
  const [status, setStatus] = useState({ service: 'connecting' })
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

  const pushMessage = useCallback((label, text, kind = 'event', detail = '') => {
    setMessages((current) => [...current.slice(-39), { id: `${Date.now()}-${Math.random()}`, label, text, kind, detail, at: new Date().toISOString() }])
  }, [])

  const refresh = useCallback(async () => {
    const [nextStatus, nextCycle, nextDag, nextPaper, nextTestnet] = await Promise.all([controlApi.status(), controlApi.cycle(), controlApi.dag(), controlApi.paper(), controlApi.testnet()])
    setStatus(nextStatus); setCycle(nextCycle); setDag(nextDag); setPaper(nextPaper)
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
      setCsrf(response.csrf_token); setSessionExpiry(response.expires_at); pushMessage('会话', '当前标签页已通过验证', 'system')
    } catch (error) { setLoginError(`登录失败：${error.message}`) }
  }

  const runCycle = async () => {
    try {
      setBusy(true); setNotice(''); setDag(EMPTY_DAG); setRoleEvents(EMPTY_ROLE_EVENTS); pushMessage('当前周期', '正在启动固定 DAG', 'system')
      const response = await controlApi.runCycle({ date, iso_week: isoWeek }, csrf)
      setCycle(response); pushMessage('reviewer', statusLabel(response.status || response.outcome), response.status === 'blocked' ? 'warning' : 'event'); await refresh()
    } catch (error) { setNotice(`周期运行失败：${error.message}`); pushMessage('周期', `运行失败：${error.message}`, 'warning') } finally { setBusy(false) }
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

  return <div className={`app-shell theme-${theme}`}>
    <Docket selected={selected} workflow={workflow} onSelect={setSelected} />
    <main className="workspace">
      <header className="topbar"><div><span className="eyebrow">BTC · ETH / 语义分析</span><h1>读取市场信号，守住安全边界。</h1></div><div className="top-actions"><span className="session-chip"><i />会话有效至 {formatTime(sessionExpiry)}</span><button type="button" className="theme-toggle" onClick={() => setTheme((current) => current === 'paper' ? 'night' : 'paper')}>{theme === 'paper' ? '深色模式' : '浅色模式'}</button><button type="button" className="logout" onClick={() => controlApi.logout(csrf).finally(() => setCsrf(null))}>退出会话</button></div></header>
      <div className="workspace-grid">
        <section className="stream-column">
          <div className="stream-heading"><div><SectionLabel hint="实时预测">事件流</SectionLabel><h2>{selectedNode?.name || '流程节点'} <small>{selected}</small></h2></div><Tone value={selectedNode?.status || 'waiting'} label={selectedNode?.statusLabel} /></div>
          <MessageStream messages={messages} />
          <div className="tool-stack"><ToolCard title="公开证据" detail="带日期的 BTC/ETH 快照" state={status?.ready ? 'ready' : status?.status || 'waiting'} /><ToolCard title="确定性防护" detail="仅允许语义输出" state="active" /></div>
          <div className="composer"><textarea placeholder="记录当前周期的备注…" aria-label="周期备注" onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) runCycle() }} /><button type="button" onClick={runCycle} disabled={busy}>运行周期</button><small>⌘↵ 运行当前 UTC 周期 · 不提供自由形式的工具访问</small></div>
        </section>
        <aside className="inspector">
          <div className="inspector-scroll">
            <CyclePanel date={date} isoWeek={isoWeek} onDate={(value) => { setDate(value); const nextWeek = utcIsoWeek(value); if (nextWeek) setIsoWeek(nextWeek) }} onWeek={setIsoWeek} onRun={runCycle} busy={busy} />
            <PaperSummary paper={paper} />
            <SectionLabel hint="固定 socket 预测">场所控制</SectionLabel>
            {VENUES.map((venueName) => <VenueCard key={venueName} venue={venueName} data={testnet[venueName]} csrf={csrf} onAction={action} date={date} isoWeek={isoWeek} planHash={planHashes[venueName]} confirmation={confirmations[venueName]} setConfirmation={(value) => setConfirmations((current) => ({ ...current, [venueName]: value }))} armConfirmation={armConfirmations[venueName]} setArmConfirmation={(value) => setArmConfirmations((current) => ({ ...current, [venueName]: value }))} />)}
            {notice && <div className="notice" role="alert">{notice}</div>}
          </div>
          <footer className="inspector-foot"><span>控制平面</span><Tone value={status?.service || status?.status || 'ready'} /><span className="hash-foot">仅预测 / 不写入规范数据</span></footer>
        </aside>
      </div>
    </main>
  </div>
}
