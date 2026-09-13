import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon.jsx'
import { DesktopSidebar, IconButton, ResizeHandle, DetailPanel, Dialog, SearchDialog, Composer, ConversationView, useNarrowLayout } from './DesktopUI.jsx'
import { ModelSettings } from './ModelSettings.jsx'
import { SceneDock, SceneVisual } from './SceneDock.jsx'
import { usePaperScene } from './usePaperScene.js'
import { createComposerState, composeMessage, draftError } from './composer-state.js'
import { controlApi, eventsUrl, isSessionFailure } from './api.js'
import { WORKFLOW_NODES, deriveWorkflowState, normalizeWorkflowStatus } from './workflow.js'
import { PAPER_FIELDS, CONNECTION_PROTOCOLS, createWorkflowRunner, saveConnection, discoveryRequest, normalizeConnectionEndpoint, inferConnectionProtocol } from './workflow-entry.js'

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

function SectionLabel({ children }) {
  return <div className="section-label"><span>{children}</span></div>
}

function Docket({ selected, workflow, onSelect }) {
  const nodeButton = (role, index) => {
    const node = workflow.byRole[role]
    return <button key={role} type="button" className={`lane workflow-node ${selected === role ? 'selected' : ''} ${node.current ? 'current' : ''}`} data-role={role} data-status={node.status} aria-current={node.current ? 'step' : undefined} onClick={() => onSelect(role)}>
      <span className="lane-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="lane-name"><strong>{node.name}</strong></span>
      <Tone value={node.status} label={node.statusLabel} />
    </button>
  }
  return (
    <aside className="docket">

      <nav className="workflow-dag" aria-label="固定工作流导航">
        <div className="workflow-summary"><SectionLabel>工作流</SectionLabel><strong>{workflow.completedCount}/{workflow.totalCount} · {workflow.percent}%</strong><progress aria-label="工作流完成进度" max={workflow.totalCount} value={workflow.completedCount} /></div>
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
        <div className="workflow-current"><span>当前阶段</span><strong>{workflow.currentStage}</strong></div>
      </nav>

    </aside>
  )
}

function MessageStream({ messages }) {
  return <div className="message-stream" aria-live="polite">
    {messages.length === 0 && <div className="empty-stream">暂无事件</div>}
    {messages.map((message) => <div className={`message message-${message.kind}`} key={message.id}>
      <div className="message-meta"><span>{WORKFLOW_NODES.find((node) => node.role === message.label)?.name || message.label}</span><time>{formatTime(message.at)}</time></div>
      <p>{message.text}</p>
      {message.detail && <code>{message.detail}</code>}
    </div>)}
  </div>
}

function ProviderPanel({ provider, protocol, endpoint, apiKey, setProtocol, setEndpoint, setApiKey, onConnectionBlur, onDiscover, catalog, busy, error }) {
  const configured = provider?.configured === true
  return <section className="connection-section">
    <div className="section-heading"><h2>连接</h2><Tone value={configured ? 'ready' : 'waiting'} label={configured ? '已连接' : '未连接'} /></div>
    <div className="connection-fields">
      <label>协议<select value={protocol} disabled={busy} onChange={(event) => setProtocol(event.target.value)}>{CONNECTION_PROTOCOLS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>服务地址<input type="text" placeholder="https://api.example.com" value={endpoint} onBlur={onConnectionBlur} onChange={(event) => setEndpoint(event.target.value)} spellCheck="false" disabled={busy} /></label>
      <label>API Key<input type="password" value={apiKey} onBlur={onConnectionBlur} onChange={(event) => setApiKey(event.target.value.trim())} autoComplete="new-password" spellCheck="false" disabled={busy} placeholder={configured ? '••••••••' : ''} /></label>
    </div>
    <div className="connection-actions"><button type="button" className="primary-action" onClick={onDiscover} disabled={busy || !endpoint.trim() || (!configured && !apiKey.trim())}>{busy ? '连接中…' : configured ? '重新检测' : '连接'}<Icon name="arrow" /></button>{configured && <span className="connection-model">{provider.model}</span>}</div>
    {error && <p className="form-error connection-error" role="alert">{error}</p>}
    {catalog && <CatalogSummary catalog={catalog} />}
  </section>
}

function CatalogSummary({ catalog }) {
  return <details className="saved-models"><summary>模型目录 · {catalog.entries.length}</summary><dl>{catalog.entries.map((entry) => <div key={entry.id}><dt>{entry.id}</dt><dd>{entry.efforts.length ? entry.efforts.join(' / ') : '—'}</dd></div>)}</dl></details>
}

function PaperSetup({ setup, draft }) {
  if (!setup) return <span role="status">加载中</span>
  const values = { ...draft?.paper_settings, ...setup.values }
  return <section className="saved-paper"><div className="section-heading"><h2>模拟设置</h2><Tone value={setup.status} label={setup.ready ? '已就绪' : setup.status === 'blocked' ? '需处理' : '待补充'} /></div>
    {setup.message && <p className="form-error">{setup.message}</p>}
    <dl>{PAPER_FIELDS.map(({ key, label, unit }) => <div key={key}><dt>{label}</dt><dd>{values[key] ? `${values[key]} ${unit}${Object.hasOwn(setup.values, key) ? '' : ' · 草稿'}` : '—'}</dd></div>)}</dl>
  </section>
}

function RunResult({ cycle, workflow, phase, busy, compact, onDetails }) {
  const blocked = cycle?.ok === false || ['blocked', 'failed', 'error'].some((value) => [cycle?.outcome, cycle?.phase, cycle?.status].some((field) => String(field || '').toLowerCase() === value))
  const hasResult = Boolean(cycle?.outcome)
  if (compact) return <button className={`run-status-strip ${blocked ? 'is-blocked' : ''}`} onClick={onDetails} aria-label="查看运行结果"><Icon name={busy ? 'workflow' : blocked ? 'close' : 'check'} /><span>Paper · {busy ? workflow.currentStage : blocked ? '运行受阻' : workflow.currentStage}</span><span className="run-mini-track" aria-hidden="true">{workflow.nodes.map((node) => <i key={node.role} data-status={node.status} />)}</span><span>{workflow.completedCount}/{workflow.totalCount}</span><Icon name="chevron" /></button>
  return <section className="run-result" aria-live="polite"><div className="section-heading"><h2>{busy ? phase : blocked ? '运行已阻断' : hasResult ? '运行结果' : '运行进度'}</h2><Tone value={blocked ? 'blocked' : cycle?.outcome || 'waiting'} /></div>
    <progress aria-label="工作流完成进度" max={workflow.totalCount} value={workflow.completedCount} /><div className="progress-copy"><span>{workflow.currentStage}</span><span>{workflow.completedCount}/{workflow.totalCount}</span></div>
    {cycle.reused && <span className="run-reused">已复用</span>}
    {blocked && <div className="cycle-blocker" role="alert"><dl><div><dt>阶段</dt><dd>{compactValue(cycle.blocked_stage)}</dd></div><div><dt>代码</dt><dd>{compactValue(cycle.code)}</dd></div><div><dt>说明</dt><dd>{compactValue(cycle.message)}</dd></div></dl></div>}
  </section>
}

function compactValue(value) {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function Login({ onLogin, onResume, busy, canResume, error }) {
  const [token, setToken] = useState('')
  return <main className="login-shell theme-night">
    <header className="login-brand"><div className="brand-lockup"><span className="brand-mark">τ</span><strong>Tyche</strong></div></header>
    <section className="login-showcase" aria-hidden="true"><div className="login-scene"><SceneVisual decorative /></div></section>
    <section className="login-card"><h1>登录</h1><form onSubmit={(event) => { event.preventDefault(); onLogin(token) }}><label>工作台口令<input autoFocus value={token} onChange={(event) => setToken(event.target.value)} type="password" spellCheck="false" disabled={busy} /></label><button type="submit" className="primary-action" disabled={busy || !token.trim()}>{busy ? '登录中' : '进入'}<Icon name="arrow" /></button></form>{canResume && <button type="button" className="quiet-action" onClick={onResume} disabled={busy}>恢复会话</button>}{error && <p className="form-error" role="alert">{error}</p>}</section>
  </main>
}

export function App() {
  const [csrf, setCsrf] = useState(null)
  const [sessionExpiry, setSessionExpiry] = useState(null)
  const [clockTick, setClockTick] = useState(() => Date.now())
  useEffect(() => {
    if (!sessionExpiry) return undefined
    const timer = setInterval(() => setClockTick(Date.now()), 15000)
    return () => clearInterval(timer)
  }, [sessionExpiry])
  const expiryMinutes = (() => {
    if (!sessionExpiry) return null
    const remaining = new Date(sessionExpiry).getTime() - clockTick
    return Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / 60000)) : null
  })()
  const expiryWarning = expiryMinutes !== null && expiryMinutes <= 5
    ? `会话剩余约 ${expiryMinutes} 分钟。过期会清空模型连接、已声明的模型池与六角色分配，请先完成当前配置。`
    : ''
  const [loginError, setLoginError] = useState('')
  const [authBusy, setAuthBusy] = useState(true)
  const [canResume, setCanResume] = useState(false)
  const [selected, setSelected] = useState('orchestrator')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const settingsNoticeRef = useRef(null)
  useEffect(() => { if (notice) settingsNoticeRef.current?.scrollIntoView({ block: 'nearest' }) }, [notice])
  const [theme, setTheme] = useState('night')
  const [status, setStatus] = useState({ service: 'connecting' })
  const [provider, setProvider] = useState(EMPTY_PROVIDER)
  const [connectionDraft, setConnectionDraft] = useState({ protocol: CONNECTION_PROTOCOLS[0].id, endpoint: '', apiKey: '', model: DEFAULT_MODEL, dirty: false })
  const { protocol: providerProtocol, endpoint: providerEndpoint, apiKey: providerApiKey, model: providerModel } = connectionDraft
  const [providerBusy, setProviderBusy] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [panel, setPanel] = useState(null)
  const [conversations, setConversations] = useState([])
  const [conversation, setConversation] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 900)
  const [sidebarWidth, setSidebarWidth] = useState(275)
  const [detailWidth, setDetailWidth] = useState(420)
  const [archivedView, setArchivedView] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchResults, setSearchResults] = useState({ query: '', items: [], status: 'loading' })
  const [renameTarget, setRenameTarget] = useState(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renameError, setRenameError] = useState('')
  const [conversationBusy, setConversationBusy] = useState(false)
  const [sceneMode, setSceneMode] = useState('workflow')
  const [pendingMessage, setPendingMessage] = useState(null)
  const [messageError, setMessageError] = useState(null)
  const [historyWarning, setHistoryWarning] = useState(null)
  const [motion, setMotion] = useState(true)
  const searchRevision = useRef(0)
  const composerState = useRef(createComposerState())
  const [draftTick, setDraftTick] = useState(0)
  const conversationRef = useRef(conversation)
  conversationRef.current = conversation
  const narrow = useNarrowLayout()
  const updateDraft = (patch, id = conversationRef.current?.id) => { composerState.current.update(id, patch); setDraftTick((v) => v + 1) }
  const currentDraft = composerState.current.draft(conversation?.id)
  const composerEpoch = composerState.current.epoch
  const discussionMessage = currentDraft.text
  const setDiscussionMessage = (next) => { const old = composerState.current.draft(conversationRef.current?.id); updateDraft({ text: typeof next === 'function' ? next(old.text) : next }) }
  useEffect(() => { if (narrow) setSidebarOpen(false) }, [narrow])
  useEffect(() => { const update = () => setDraftTick((v) => v + 1); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update) }, [])
  const [modelConfig, setModelConfig] = useState(EMPTY_MODELS)
  const [settingsResult, setSettingsResult] = useState(null)
  const [settingsDraft, setSettingsDraft] = useState({})
  const [preferences, setPreferences] = useState('')
  const [setup, setSetup] = useState(null)
  const [phase, setPhase] = useState('')
  const [appliedStrategy, setAppliedStrategy] = useState('')
  const [discussion, setDiscussion] = useState([])
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
  const editConnection = (changes) => {
    const before = connectionDraftRef.current
    const next = { ...before, ...changes }
    setConnectionError('')
    connectionRevisionRef.current++; discoveryAttemptRef.current = null
    updateConnectionDraft({ ...next, dirty: true })
    setModelConfig((current) => ({ ...current, catalog: null }))
  }
  const setProviderProtocol = (protocol) => editConnection({ protocol })
  const setProviderEndpoint = (endpoint) => editConnection({ endpoint })
  const setProviderApiKey = (apiKey) => editConnection({ apiKey })
  const setProviderModel = (model) => updateConnectionDraft({ model })

  const clearAppliedSession = useCallback(() => {
    setConversations([]); setConversation(null); setHistoryWarning(null); setPendingMessage(null); setMessageError(null); composerState.current.pauseAll(); setConversationBusy(false); setProvider(EMPTY_PROVIDER); setAppliedStrategy(''); setDiscussion([]); setModelConfig(EMPTY_MODELS)
    setConnectionError(''); setSettingsResult(null); setSettingsDraft({}); setPreferences(''); setTheme('night'); setSetup(null)
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
    setCanResume(error.code === 'CONTROL_CSRF_REJECTED')
    setLoginError(error.code === 'CONTROL_CSRF_REJECTED'
      ? '会话已更新'
      : '会话已过期')
    return true
  }, [clearAppliedSession])

  const onSceneSessionFailure = useCallback((error, expectedCsrf) => {
    if (authRef.current.csrf === expectedCsrf) handleSessionFailure(error, authRef.current)
  }, [handleSessionFailure])
  const paperView = usePaperScene(authBusy ? null : csrf, busy, onSceneSessionFailure)

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
      setProvider(nextProvider?.configured ? nextProvider : EMPTY_PROVIDER); setSetup(nextSetup); setModelConfig(connectionDraftRef.current.dirty && !(discoveryAttemptRef.current?.complete && discoveryAttemptRef.current?.revision === connectionRevisionRef.current && discoveryAttemptRef.current?.expected === expected) ? { ...nextModels, catalog: null } : nextModels); setAppliedStrategy(nextSettings.prompt); setDiscussion(nextSettings.discussion); setConversation(nextSettings.conversation); setConversations(nextSettings.conversations || []); setHistoryWarning(nextSettings.history_warning); setTheme(nextSettings.theme); setSettingsDraft(nextSettings.draft); setSettingsResult(nextSettings.settings_result); setPreferences(nextSettings.preferences)
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
        if (packet.type === 'discussion_progress') { setPendingMessage((current) => current?.requestId === packet.data?.request_id && current.phase !== 'stopping' ? { ...current, phase: packet.data.phase } : current); return }
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
      setNotice('')
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
      setNotice('')
      return response.connection_saved ? response.provider : provider
    } catch (error) {
      if (handleSessionFailure(error, expected)) throw error
      requireCurrentSession(expected)
      throw error
    }
  }

  const discoverConnection = async (force = false) => {
    if (operationRef.current || !authRef.current.csrf) return
    if (!force) { try { discoveryRequest(provider, connectionDraftRef.current) } catch { return } }
    const expected = authRef.current; const operation = { expected }
    operationRef.current = operation; configurationRevisionRef.current++
    try { setProviderBusy(true); setConnectionError(''); await detectConnection(expected, force) } catch (error) { if (!handleSessionFailure(error, expected) && authRef.current === expected) setConnectionError(error.message) }
    finally { if (operationRef.current === operation) { operationRef.current = false; setProviderBusy(false) } }
  }

  const onConnectionBlur = () => {
    const draft = connectionDraftRef.current
    const protocol = inferConnectionProtocol(draft.endpoint, draft.protocol)
    try {
      const endpoint = normalizeConnectionEndpoint(draft.endpoint.trim(), protocol)
      if (protocol !== draft.protocol) editConnection({ protocol, endpoint })
      else updateConnectionDraft({ endpoint })
    } catch { /* Keep incomplete input editable until the user connects. */ }
  }

  const runCycle = async () => {
    if (operationRef.current || !authRef.current.csrf) return
    if (modelConfig.allocation_state !== 'ready') { setPanel('models'); setNotice('模型待分配'); return }
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

  const discuss = async (message = discussionMessage, allocate = false, sentDraft = null) => {
    if (operationRef.current || !authRef.current.csrf) return
    const expected = authRef.current
    const operation = { expected, requestId: crypto.randomUUID(), conversationId: conversationRef.current?.id }
    operationRef.current = operation
    configurationRevisionRef.current++
    setPendingMessage({ message, requestId: operation.requestId, startedAt: Date.now(), phase: 'connecting' }); setMessageError(null)
    try {
      setProviderBusy(true); setNotice('')
      let detected = provider
      if (discoveryAttemptRef.current?.revision !== connectionRevisionRef.current || discoveryAttemptRef.current?.expected !== expected) {
        try { detected = await detectConnection(expected) } catch (error) { if (handleSessionFailure(error, expected)) return; requireCurrentSession(expected) }
      }
      const connection = await saveConnection(controlApi, expected.csrf, detected, { ...connectionDraftRef.current })
      requireCurrentSession(expected)
      acceptProvider(connection)
      if (operation.cancelled) throw Object.assign(new Error('已停止生成'), { code: 'CONTROL_STRATEGY_CANCELLED' })
      const response = await controlApi.discussStrategy(message, expected.csrf, allocate, operation.requestId)
      requireCurrentSession(expected)
      const saved = response.settings
      setNotice('')
      updateConnectionDraft({ endpoint: connection.endpoint, protocol: connection.protocol, apiKey: '', dirty: false })
      setDiscussion(saved.discussion); setConversation(saved.conversation); setConversations(saved.conversations || []); setHistoryWarning(saved.history_warning); setAppliedStrategy(saved.prompt); setModelConfig(saved.models); setProviderModel(saved.models.default_model); setProvider((current) => current.configured ? { ...current, model: saved.models.default_model } : current); setSetup(saved.paper); setTheme(saved.theme); setSettingsDraft(saved.draft); setSettingsResult(saved.settings_result); setPreferences(saved.preferences); if (saved.history_warning) composerState.current.pause(operation.conversationId)
    } catch (error) {
      if (isSessionFailure(error) && sentDraft && authRef.current === expected) composerState.current.restoreIfEmpty(operation.conversationId, sentDraft)
      if (handleSessionFailure(error, expected)) return
      composerState.current.pause(operation.conversationId)
      setMessageError({ message: error.code === 'CONTROL_STRATEGY_CANCELLED' ? '已停止生成' : error.message, retry: message })
      if (sentDraft) composerState.current.restoreIfEmpty(operation.conversationId, sentDraft)
      setDraftTick((v) => v + 1)
      if (!provider.configured && error.code !== 'CONTROL_STRATEGY_CANCELLED') setPanel('settings')
    } finally { if (operationRef.current === operation) { setProviderBusy(false); setPendingMessage(null); operationRef.current = false } }
  }

  const sendComposer = () => {
    const id = conversationRef.current?.id, draft = composerState.current.draft(id), message = composeMessage(draft), error = draftError(draft)
    if (!message || !authRef.current.csrf || busy || conversationBusy || historyWarning) return
    if (error) { setNotice(error); return }
    if (operationRef.current?.requestId || composerState.current.items(id).length) {
      try { composerState.current.enqueue(id, draft); composerState.current.take(id); setDraftTick((v) => v + 1) } catch (error) { setNotice(error.message) }
      return
    }
    if (operationRef.current) return
    composerState.current.resume(id); composerState.current.take(id); setDraftTick((v) => v + 1); discuss(message, false, draft)
  }
  const addAttachments = (rows, id, epoch) => {
    if (epoch !== composerState.current.epoch) return '文件读取已取消。'
    const draft = composerState.current.draft(id), next = { ...draft, attachments: [...draft.attachments, ...rows] }, error = draftError(next)
    if (error) return error
    updateDraft(next, id); return ''
  }
  useEffect(() => {
    if (!csrf || providerBusy || busy || conversationBusy || operationRef.current || historyWarning || document.hidden) return
    const id = conversation?.id
    if (!id || conversations.find((row) => row.id === id)?.archived) return
    const next = composerState.current.next(id)
    if (next) { setDraftTick((v) => v + 1); discuss(next.message, false, next.draft) }
  }, [draftTick, csrf, conversation?.id, providerBusy, busy, conversationBusy, historyWarning])

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
    setAuthBusy(true); setCsrf(null); setSessionExpiry(null); wsRef.current?.close(); composerState.current.clear(); clearAppliedSession()
    try {
      await controlApi.logout(previous.csrf)
      if (authRef.current !== attempt) return
      updateConnectionDraft({ protocol: CONNECTION_PROTOCOLS[0].id, endpoint: '', apiKey: '', model: DEFAULT_MODEL, dirty: false }); setDiscussionMessage(''); setCanResume(false); setLoginError('')
    } catch (error) {
      if (authRef.current !== attempt) return
      setCanResume(error.code !== 'CONTROL_SESSION_REQUIRED')
      setLoginError(`退出未确认：${error.message}`)
    } finally {
      if (authenticationRef.current === attempt) { authenticationRef.current = null; setAuthBusy(false) }
    }
  }

  const acceptConversation = (saved) => { setDiscussion(saved.discussion); setConversation(saved.conversation); setConversations(saved.conversations || []); setHistoryWarning(saved.history_warning); setSettingsResult(null); setMessageError(null) }
  const changeConversation = async (action, input = {}) => {
    if (operationRef.current || !authRef.current.csrf) return
    const expected = authRef.current
    const operation = { expected }; operationRef.current = operation; configurationRevisionRef.current++; setConversationBusy(true); setRenameError(''); setNotice('')
    try {
      const saved = await controlApi.changeConversation({ action, ...input }, expected.csrf)
      requireCurrentSession(expected); acceptConversation(saved)
      if (window.innerWidth <= 900) setSidebarOpen(false)
      if (action === 'create') { setArchivedView(false); setPanel(null) }
      requestAnimationFrame(() => document.getElementById('discussion-input')?.focus())
      return true
    } catch (error) { if (!handleSessionFailure(error, expected)) { setNotice(error.message); setRenameError(error.message) }; return false } finally { if (operationRef.current === operation) { operationRef.current = false; setConversationBusy(false) } }
  }
  const stopDiscussion = async () => {
    const operation = operationRef.current
    if (!operation?.requestId) return
    operation.cancelled = true
    composerState.current.pause(operation.conversationId); setDraftTick((v) => v + 1)
    setPendingMessage((p) => p && { ...p, phase: 'stopping' })
    try { await controlApi.cancelDiscussion(operation.requestId, operation.expected.csrf) } catch (error) { if (!handleSessionFailure(error, operation.expected)) setNotice(error.message) }
  }
  const setChatModel = async (model, effort) => {
    if (operationRef.current) return
    const expected = authRef.current, operation = { expected }; operationRef.current = operation; configurationRevisionRef.current++; setConversationBusy(true)
    try { const saved = await controlApi.selectChatModel(model, effort, expected.csrf); requireCurrentSession(expected); acceptConversation(saved) } catch (error) { if (!handleSessionFailure(error, expected)) setNotice(error.message) } finally { if (operationRef.current === operation) { operationRef.current = false; setConversationBusy(false) } }
  }
  const setAppearance = async (nextTheme) => {
    if (operationRef.current) return
    const expected = authRef.current, operation = { expected }
    operationRef.current = operation; configurationRevisionRef.current++; setConversationBusy(true)
    try { const saved = await controlApi.changeTheme(nextTheme, expected.csrf); requireCurrentSession(expected); setTheme(saved.theme) } catch (error) { if (!handleSessionFailure(error, expected)) setNotice(error.message) } finally { if (operationRef.current === operation) { operationRef.current = false; setConversationBusy(false) } }
  }
  const searchConversations = async (query) => {
    const revision = ++searchRevision.current, expected = authRef.current
    if (!expected.csrf) return
    setSearchResults({ query, items: [], status: 'loading' })
    try {
      const result = await controlApi.changeConversation({ action: 'search', query }, expected.csrf)
      if (revision === searchRevision.current && expected === authRef.current) setSearchResults({ query, items: result.items, status: 'ready' })
    } catch (error) { if (!handleSessionFailure(error, expected) && revision === searchRevision.current) setSearchResults({ query, items: [], status: 'error', error: error.message }) }
  }
  const closeSearch = () => { searchRevision.current++; setSearchOpen(false) }
  const openScene = (mode) => { setSceneMode(mode); setPanel('scene'); if (narrow) setSidebarOpen(false) }
  const openSettings = (tab) => { setPanel(tab); if (narrow) setSidebarOpen(false) }
  const closeSidebar = () => { setSidebarOpen(false); requestAnimationFrame(() => document.querySelector('.desktop-topbar [aria-label="展开侧栏"]')?.focus()) }
  const closeDetails = () => { const label = panel === 'scene' ? '打开 3D 场景' : '运行详情'; setPanel(null); requestAnimationFrame(() => document.querySelector(`.desktop-topbar [aria-label="${label}"]`)?.focus()) }
  const toggleSidebar = () => { if (narrow && !sidebarOpen) setPanel(null); setSidebarOpen((v) => !v) }
  const openRename = (row) => { setRenameTarget(row); setRenameTitle(row?.title || '新对话'); setRenameError('') }
  const putInComposer = (text) => { setDiscussionMessage(text.slice(0, 8000)); requestAnimationFrame(() => document.getElementById('discussion-input')?.focus()) }
  const retryMessage = (index) => { const text = index === -1 ? messageError?.retry : discussion.slice(0, index).findLast((m) => m.role === 'user')?.content; if (text) { if (composeMessage(composerState.current.draft(conversation?.id)) === text) { composerState.current.take(conversation?.id); setDraftTick((v) => v + 1) }; discuss(text) } }
  useEffect(() => {
    if (!csrf) return
    const keys = (e) => {
      if (e.isComposing || e.defaultPrevented) return
      if (document.querySelector('dialog[open]')) return
      const command = e.metaKey || e.ctrlKey
      if (command && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen((v) => !v) }
      if (command && e.key.toLowerCase() === 'n') { e.preventDefault(); changeConversation('create') }
      if (command && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar() }
      if (command && e.key === ',') { e.preventDefault(); setPanel('appearance') }
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { if (narrow && sidebarOpen) closeSidebar(); else if (panel) closeDetails(); else if (pendingMessage) stopDiscussion() }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [csrf, conversation?.id, discussionMessage, pendingMessage, narrow, sidebarOpen, panel])

  const workflow = useMemo(() => deriveWorkflowState({ dag, status: cycle, events: roleEvents }), [dag, cycle, roleEvents])
  const selectedNode = workflow.byRole[selected]
  if (!csrf || authBusy) return <Login onLogin={(token) => authenticate(token)} onResume={() => authenticate()} busy={authBusy} canResume={canResume} error={loginError} />

  const working = busy || providerBusy || conversationBusy
  const hasRun = busy || cycle?.outcome || cycle?.status === 'failed'
  const active = conversations.find((row) => row.id === conversation?.id)
  const isEmpty = discussion.length === 0 && !pendingMessage
  const sidePanel = ['scene', 'details'].includes(panel)
  const settingsOpen = Boolean(panel && !sidePanel)
  const overlay = narrow && (sidebarOpen || sidePanel)
  const settingsTabs = [['appearance', '常规', 'settings'], ['settings', '连接', 'box'], ['models', '模型', 'workflow'], ['paper', '模拟', 'positions'], ['shortcuts', '快捷键', 'file']]
  return <div className={`desktop-shell theme-${theme} ${sidebarOpen ? '' : 'sidebar-collapsed'} ${sidePanel ? 'detail-open' : ''} ${motion ? '' : 'motion-off'}`} style={{ '--sidebar-width': `${sidebarWidth}px`, '--detail-width': `${detailWidth}px` }}>
    <DesktopSidebar narrow={narrow} collapsed={!sidebarOpen} rows={conversations} current={conversation?.id} archived={archivedView} onArchived={setArchivedView} onNew={() => changeConversation('create')} onSearch={() => setSearchOpen(true)} onSelect={(id) => changeConversation('select', { id })} onUpdate={(id, patch) => changeConversation('update', { id, ...patch })} onRename={openRename} onSettings={openSettings} onScene={openScene} connected={provider.configured} busy={working} onClose={closeSidebar} />
    {sidebarOpen && <ResizeHandle side="left" value={sidebarWidth} onChange={setSidebarWidth} min={220} max={360} />}
    {overlay && <button className="panel-scrim" aria-label={sidebarOpen ? '关闭侧栏遮罩' : '关闭详情遮罩'} onClick={sidebarOpen ? closeSidebar : closeDetails} />}
    <main inert={overlay ? '' : undefined} aria-hidden={overlay} className={`desktop-main ${isEmpty ? 'empty-thread' : ''}`}>
      <header className="desktop-topbar"><div className="thread-title-group"><IconButton icon="sidebar" label={sidebarOpen ? '收起侧栏' : '展开侧栏'} onClick={toggleSidebar} /><button className="thread-title" title={conversation?.title || '新对话'} onClick={() => openRename(active)}><span>{conversation?.title || '新对话'}</span><Icon name="chevron" /></button></div><div className="topbar-actions"><IconButton icon="box" label="打开 3D 场景" onClick={() => setPanel((p) => p === 'scene' ? null : 'scene')} aria-pressed={panel === 'scene'} /><IconButton icon="workflow" label="运行详情" onClick={() => setPanel((p) => p === 'details' ? null : 'details')} aria-pressed={panel === 'details'} /><button type="button" className="run-button" onClick={runCycle} disabled={working}><Icon name="play" />{busy ? '运行中' : '运行'}</button></div></header>
      {notice && !settingsOpen && !renameTarget && <div className="desktop-notice" role="status"><span>{notice}</span><IconButton icon="close" label="关闭提示" onClick={() => setNotice('')} /></div>}
      {hasRun && <RunResult compact onDetails={() => setPanel('details')} cycle={cycle} workflow={workflow} phase={phase} busy={busy} />}
      {isEmpty ? <div className="thread-welcome"><div className="welcome-mark" aria-hidden="true">τ</div><h1>开始对话</h1><div className="welcome-actions"><button onClick={() => putInComposer('分析 BTC 与 ETH 的策略。')}><Icon name="chat" />讨论策略</button><button onClick={() => setPanel('paper')}><Icon name="positions" />模拟设置</button><button onClick={() => openScene('workflow')}><Icon name="workflow" />查看工作流</button></div></div> : <ConversationView conversationId={conversation?.id} messages={discussion} pending={pendingMessage} onQuote={(text) => putInComposer(text.split('\n').map((line) => '> ' + line).join('\n') + '\n\n')} onEdit={putInComposer} onRetry={retryMessage} busy={working} error={messageError} onDismissError={() => setMessageError(null)} />}
      {expiryWarning && !settingsOpen && <div className="desktop-notice" role="alert">{expiryWarning}</div>}
      {historyWarning && <div className="desktop-notice" role="alert">{historyWarning}<button onClick={() => changeConversation('save')}>重试保存</button></div>}
      {isEmpty && messageError && <div className="desktop-notice" role="alert">{messageError.message}<button onClick={() => retryMessage(-1)}>重试</button></div>}
      <Composer key={conversation?.id || 'draft'} draft={currentDraft} onChange={updateDraft} onAddAttachments={(rows) => addAttachments(rows, conversation?.id, composerEpoch)} onSend={sendComposer} pending={pendingMessage} onStop={stopDiscussion} disabled={busy || conversationBusy || (providerBusy && !pendingMessage) || Boolean(historyWarning)} model={conversation?.model || modelConfig.chat?.model || modelConfig.default_model} effort={conversation?.effort || modelConfig.chat?.effort || 'high'} pool={modelConfig.pool} onModel={setChatModel} connected={provider.configured} onConnect={() => openSettings('settings')} onWorkflow={() => openScene('trading')} archived={active?.archived} onRestore={() => changeConversation('update', { id: conversation.id, archived: false })} queue={composerState.current.items(conversation?.id)} queuePaused={composerState.current.paused(conversation?.id)} onResumeQueue={() => { composerState.current.resume(conversation?.id); setMessageError(null); setDraftTick((v) => v + 1) }} onRemoveQueued={(id) => { composerState.current.remove(conversation?.id, id); setDraftTick((v) => v + 1) }} />
    </main>
    <DetailPanel open={sidePanel} narrow={narrow}><ResizeHandle side="right" value={detailWidth} onChange={setDetailWidth} min={330} max={620} /><header className="detail-header"><div><button aria-pressed={panel === 'scene'} onClick={() => setPanel('scene')}>场景</button><button aria-pressed={panel === 'details'} onClick={() => setPanel('details')}>运行详情</button></div><IconButton icon="close" label="关闭详情" onClick={closeDetails} /></header><div className="detail-scroll">{panel === 'scene' ? <SceneDock initialMode={sceneMode} motionEnabled={motion} inlineDetails workflow={workflow} selected={selected} onSelectAgent={(role) => { setSelected(role); setPanel('details') }} paperView={paperView} /> : <>{hasRun && <RunResult cycle={cycle} workflow={workflow} phase={phase} busy={busy} />}<Docket selected={selected} workflow={workflow} onSelect={setSelected} /><div className="stream-heading"><h2>事件日志 · {selectedNode?.name}</h2><Tone value={selectedNode?.status || 'waiting'} /></div><MessageStream messages={messages.filter((entry) => !ROLES.includes(entry.label) || entry.label === selected)} /><span className="paper-status">Paper · {statusLabel(paper?.status || cycle?.outcome)}</span></>}</div></DetailPanel>
    <Dialog open={settingsOpen} onClose={() => setPanel(null)} title="设置" className="settings-dialog"><aside className="settings-navigation"><h2>设置</h2>{settingsTabs.map(([key, label, icon]) => <button key={key} aria-pressed={panel === key} onClick={() => setPanel(key)}><Icon name={icon} />{label}</button>)}</aside><section className="settings-content"><header><h2>{settingsTabs.find(([key]) => key === panel)?.[1]}</h2><IconButton icon="close" label="关闭设置" onClick={() => setPanel(null)} /></header><div className="settings-scroll">
      {expiryWarning && <div className="desktop-notice" role="alert">{expiryWarning}</div>}
      {notice && <div ref={settingsNoticeRef} className="desktop-notice" role="alert"><span>{notice}</span><IconButton icon="close" label="关闭提示" onClick={() => setNotice('')} /></div>}
      {panel === 'appearance' && <><div className="preference-row"><span>外观</span><div className="segmented"><button aria-pressed={theme === 'night'} onClick={() => setAppearance('night')} disabled={working}><Icon name="moon" />深色</button><button aria-pressed={theme === 'light'} onClick={() => setAppearance('light')} disabled={working}><Icon name="sun" />浅色</button></div></div><div className="preference-row"><span>界面动效</span><button className="toggle-switch" role="switch" aria-label="界面动效" aria-checked={motion} onClick={() => setMotion((v) => !v)}><i /></button></div><div className="preference-row"><span>会话</span><button className="quiet-action" onClick={logout} disabled={working}>退出</button></div></>}
      {panel === 'settings' && <div className="entry-form"><ProviderPanel provider={provider} protocol={providerProtocol} setProtocol={setProviderProtocol} endpoint={providerEndpoint} apiKey={providerApiKey} setEndpoint={setProviderEndpoint} setApiKey={setProviderApiKey} onConnectionBlur={onConnectionBlur} onDiscover={() => discoverConnection(true)} error={connectionError} catalog={modelConfig.catalog} busy={working} /><button type="button" className="quiet-action" onClick={clearProvider} disabled={working || !provider.configured}>清除模型连接</button></div>}
      {panel === 'models' && <ModelSettings config={modelConfig} busy={working} onSave={saveModels} onAllocate={() => discuss('按当前模型池分配六个工作流角色的模型和 effort，并给出依据。', true)} />}
      {panel === 'paper' && <><PaperSetup setup={setup} draft={settingsDraft} />{!setup?.ready && <button className="primary-action" onClick={() => { setPanel(null); putInComposer('帮我设置 Paper 模拟账户，先确认虚拟资金和风险限制。') }}>在对话中配置</button>}<details className="advanced"><summary>会话与测试网状态</summary><div className="advanced-actions">会话有效至 {formatTime(sessionExpiry)}</div><h2>独立测试网</h2>{VENUES.map((v) => <p key={v}>{VENUE_NAMES[v]}：<Tone value={testnet[v]?.status || 'unconfigured'} /></p>)}</details></>}
      {panel === 'shortcuts' && <div className="shortcut-list">{[['搜索 / 命令', '⌘ / Ctrl K'], ['新对话', '⌘ / Ctrl N'], ['显示侧栏', '⌘ / Ctrl B'], ['设置', '⌘ / Ctrl ,'], ['发送 / 加入队列', 'Enter'], ['换行', 'Shift Enter'], ['停止 / 关闭面板', 'Esc']].map(([name, key]) => <div key={name}><span>{name}</span><kbd>{key}</kbd></div>)}</div>}
    </div></section></Dialog>
    <SearchDialog open={searchOpen} onClose={closeSearch} results={searchResults} onQuery={searchConversations} onSelect={(id) => changeConversation('select', { id })} commands={[{ name: '新对话', icon: 'plus', run: () => changeConversation('create') }, { name: '连接设置', icon: 'settings', run: () => openSettings('settings') }, { name: '工作流', icon: 'workflow', run: () => openScene('workflow') }, { name: '持仓', icon: 'positions', run: () => openScene('trading') }, { name: '切换主题', icon: 'sun', run: () => setAppearance(theme === 'night' ? 'light' : 'night') }]} />
    <Dialog open={Boolean(renameTarget)} onClose={() => setRenameTarget(null)} title="重命名对话" className="rename-dialog"><h2>重命名对话</h2><form onSubmit={async (e) => { e.preventDefault(); if (await changeConversation('update', { id: renameTarget.id, title: renameTitle.trim() })) setRenameTarget(null) }}><input autoFocus aria-label="对话名称" value={renameTitle} maxLength={80} onChange={(e) => setRenameTitle(e.target.value)} />{renameError && <p className="form-error" role="alert">{renameError}</p>}<div><button type="button" className="quiet-action" onClick={() => setRenameTarget(null)}>取消</button><button className="primary-action" disabled={!renameTitle.trim() || conversationBusy}>{conversationBusy ? '保存中…' : '保存'}</button></div></form></Dialog>
  </div>
}
