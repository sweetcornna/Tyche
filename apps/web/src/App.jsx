import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { controlApi, eventsUrl } from './api.js'

const ROLES = Object.freeze(['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer'])
const VENUES = Object.freeze(['gate', 'binance'])
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
const EMPTY_TESTNET = Object.fromEntries(VENUES.map((venue) => [venue, { status: 'unconfigured', armed: false }]))

function formatTime(value) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
}

function statusTone(value) {
  const text = String(value || '').toLowerCase()
  if (['ok', 'ready', 'armed', 'complete', 'active', 'accepted', 'paper-only'].some((part) => text.includes(part))) return 'good'
  if (['blocked', 'error', 'expired', 'unconfigured', 'unknown'].some((part) => text.includes(part))) return 'bad'
  return 'quiet'
}

function Tone({ value }) {
  return <span className={`tone tone-${statusTone(value)}`}><i />{String(value || 'waiting')}</span>
}

function SectionLabel({ children, hint }) {
  return <div className="section-label"><span>{children}</span>{hint && <small>{hint}</small>}</div>
}

function Docket({ selected, dag, onSelect }) {
  const roles = Array.isArray(dag?.roles) && dag.roles.length ? dag.roles : EMPTY_DAG.roles
  return (
    <aside className="docket">
      <div className="brand-lockup"><span className="brand-mark">τ</span><div><strong>tyche</strong><small>analysis cockpit</small></div></div>
      <div className="docket-rule" />
      <SectionLabel hint="fixed route">DAG / lane map</SectionLabel>
      <nav className="lane-list" aria-label="Agent lanes">
        {roles.map((node, index) => {
          const role = typeof node === 'string' ? node : node.role
          const state = typeof node === 'string' ? 'waiting' : node.status
          return <button key={role} type="button" className={`lane ${selected === role ? 'selected' : ''}`} onClick={() => onSelect(role)}>
            <span className="lane-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="lane-name">{role}</span>
            <Tone value={state} />
          </button>
        })}
      </nav>
      <div className="docket-foot"><span className="pulse" />loopback only<small>semantic outputs stay provisional</small></div>
    </aside>
  )
}

function MessageStream({ messages }) {
  return <div className="message-stream" aria-live="polite">
    {messages.length === 0 && <div className="empty-stream"><span className="empty-glyph">◌</span><p>The stream is quiet.</p><small>Run a cycle to see bounded agent events here.</small></div>}
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
    <SectionLabel hint="scheduler-owned">Current cycle</SectionLabel>
    <div className="cycle-current"><span className="current-mark">◉</span><div><strong>weekly / daily</strong><small>the deterministic scheduler chooses the slot</small></div></div>
    <div className="field-grid"><label>date<input value={date} onChange={(event) => onDate(event.target.value)} /></label><label>iso week<input value={isoWeek} onChange={(event) => onWeek(event.target.value)} /></label></div>
    <button type="button" className="primary-action" onClick={onRun} disabled={busy}>{busy ? 'cycle running…' : 'run current cycle'}</button>
    <div className="cycle-note">Pi may propose meaning. Deterministic Tyche code decides what can proceed.</div>
  </section>
}

function PaperSummary({ paper }) {
  const summary = paper?.summary || paper?.projection || {}
  return <section className="panel-block compact-block"><SectionLabel hint="projected">Paper summary</SectionLabel><div className="metric-row"><div><strong>{summary.simulated ?? summary.cycles ?? 0}</strong><small>simulated units</small></div><Tone value={paper?.status || 'paper-only'} /></div><p className="muted-copy">Only the dry-run projection is shown in this cockpit.</p></section>
}

function compactValue(value) {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function VenueCard({ venue, data, csrf, onAction, date, isoWeek, planHash, confirmation, setConfirmation, armConfirmation, setArmConfirmation }) {
  const armed = data?.armed === true || data?.outcome === 'ARMED'
  const expires = data?.arm?.expires_at || data?.expires_at
  const isPlanMatch = Boolean(planHash && confirmation === planHash)
  const summary = data?.plan_summary || {}
  const intents = Array.isArray(summary.intents) ? summary.intents : []
  const armReady = armConfirmation === ARM_PHRASES[venue]
  const listValue = (value) => Array.isArray(value) ? (value.length ? value.map(compactValue).join(', ') : 'none') : compactValue(value)
  return <section className="venue-card panel-block">
    <div className="venue-head"><div><span className="venue-kicker">testnet venue</span><h3>{venue}</h3></div><Tone value={armed ? 'armed' : data?.status || 'idle'} /></div>
    <div className="venue-grid"><div><span>arm expiry</span><strong>{expires ? formatTime(expires) : 'not armed'}</strong></div><div><span>plan hash</span><strong className="hash">{planHash || summary.plan_hash || 'not loaded'}</strong></div><div><span>product</span><strong>{summary.product || 'not planned'}</strong></div><div><span>sealed</span><strong>{summary.sealed === true ? 'yes' : '—'}</strong></div></div>
    <div className="intent-list" aria-label={`${venue} plan intents`}>
      {intents.length ? intents.map((intent, index) => {
        const protection = intent?.protection || {}
        return <div className="intent-row" key={`${venue}-${index}`} data-testid={`${venue}-intent-${index}`}>
          <div className="intent-title"><strong>{intent.symbol || '—'}</strong><span>{intent.action || 'NO_ACTION'}</span></div>
          <div className="intent-values"><span>size <b>{compactValue(intent.size)}</b></span><span>notional <b>{compactValue(intent.notional)}</b></span><span>stop <b>{compactValue(protection.stop ?? protection.stop_price)}</b></span><span>target <b>{compactValue(protection.target ?? protection.target_price)}</b></span></div>
        </div>
      }) : <div className="no-intent">NO_ACTION</div>}
    </div>
    <div className="summary-strip"><div><span>risk policy</span><strong>{listValue(summary.risk_policy)}</strong></div><div><span>risk digest</span><strong className="hash">{summary.risk_policy_digest || '—'}</strong></div><div><span>blockers</span><strong className={summary.blockers?.length ? 'blocked-text' : ''}>{listValue(summary.blockers)}</strong></div></div>
    <label className="hash-field arm-field">arm confirmation<input value={armConfirmation} onChange={(event) => setArmConfirmation(event.target.value)} placeholder={ARM_PHRASES[venue]} spellCheck="false" /></label>
    <div className="action-row"><button type="button" className="quiet-action" onClick={() => onAction('plan', venue, date, isoWeek)} disabled={!csrf}>generate plan</button><button type="button" className="quiet-action" onClick={() => onAction('arm', venue, armConfirmation)} disabled={!csrf || armed || !armReady}>arm 24h</button><button type="button" className="quiet-action" onClick={() => onAction('disarm', venue)} disabled={!csrf}>disarm</button><button type="button" className="quiet-action" onClick={() => onAction('reconcile', venue, planHash)} disabled={!csrf}>reconcile</button></div>
    <label className="hash-field">manual confirmation<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="paste exact plan hash" spellCheck="false" /></label>
    <button type="button" className="danger-action" onClick={() => onAction('execute', venue, planHash, confirmation)} disabled={!csrf || !isPlanMatch}>execute exact hash</button>
    <p className="safety-line">No generic execution route. Confirmation must equal the displayed hash.</p>
  </section>
}

function Login({ onLogin, error }) {
  const [token, setToken] = useState('')
  return <main className="login-shell"><div className="login-card"><span className="brand-mark large">τ</span><p className="eyebrow">loopback control plane</p><h1>Keep the signal<br />inside the room.</h1><p className="login-copy">Enter the one-time bootstrap token printed by the local service. It is never stored by this page.</p><form onSubmit={(event) => { event.preventDefault(); onLogin(token) }}><label>bootstrap token<input autoFocus value={token} onChange={(event) => setToken(event.target.value)} type="password" spellCheck="false" /></label><button type="submit" className="primary-action" disabled={!token.trim()}>open cockpit</button></form>{error && <p className="form-error">{error}</p>}</div></main>
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
  const [theme, setTheme] = useState('night')
  const [status, setStatus] = useState({ service: 'connecting' })
  const [cycle, setCycle] = useState({ status: 'idle' })
  const [dag, setDag] = useState(EMPTY_DAG)
  const [paper, setPaper] = useState({ status: 'paper-only' })
  const [testnet, setTestnet] = useState(EMPTY_TESTNET)
  const [planHashes, setPlanHashes] = useState(Object.fromEntries(VENUES.map((venue) => [venue, ''])))
  const [confirmations, setConfirmations] = useState(Object.fromEntries(VENUES.map((venue) => [venue, ''])))
  const [armConfirmations, setArmConfirmations] = useState(Object.fromEntries(VENUES.map((venue) => [venue, ''])))
  const [messages, setMessages] = useState([])
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
    socket.onopen = () => pushMessage('control plane', 'projection stream connected', 'system')
    socket.onmessage = (event) => {
      try {
        const packet = JSON.parse(event.data)
        if (packet.type === 'connected') return
        const data = packet.data || {}
        pushMessage(data.role || packet.type || 'server event', data.message || data.status || 'projection updated', 'event')
      } catch { pushMessage('control plane', 'ignored malformed projection event', 'warning') }
    }
    socket.onerror = () => pushMessage('control plane', 'projection stream unavailable; polling remains available', 'warning')
    wsRef.current = socket
  }, [pushMessage])

  useEffect(() => {
    if (!csrf) return undefined
    refresh().catch((error) => setNotice(error.message))
    openEvents()
    const timer = window.setInterval(() => refresh().catch(() => {}), 15_000)
    return () => { window.clearInterval(timer); wsRef.current?.close() }
  }, [csrf, refresh, openEvents])

  const login = async (bootstrapToken) => {
    try {
      setLoginError('')
      const response = await controlApi.session(bootstrapToken.trim())
      setCsrf(response.csrf_token); setSessionExpiry(response.expires_at); pushMessage('session', 'authenticated for this tab', 'system')
    } catch (error) { setLoginError(error.message) }
  }

  const runCycle = async () => {
    try {
      setBusy(true); setNotice(''); pushMessage('current cycle', 'starting fixed DAG', 'system')
      const response = await controlApi.runCycle({ date, iso_week: isoWeek }, csrf)
      setCycle(response); pushMessage('reviewer', response.status || 'cycle returned', response.status === 'blocked' ? 'warning' : 'event'); await refresh()
    } catch (error) { setNotice(error.message); pushMessage('cycle', error.message, 'warning') } finally { setBusy(false) }
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
      pushMessage(venueName, response?.outcome || response?.status || `${kind} returned`, response?.ok === false ? 'warning' : 'event')
      await refresh()
    } catch (error) { setNotice(error.message); pushMessage(venueName, error.message, 'warning') } finally {
      if (kind === 'arm') setArmConfirmations((current) => ({ ...current, [venueName]: '' }))
    }
  }

  const selectedNode = useMemo(() => (dag?.roles || []).find((node) => (typeof node === 'string' ? node : node.role) === selected), [dag, selected])
  if (!csrf) return <Login onLogin={login} error={loginError} />

  return <div className={`app-shell theme-${theme}`}>
    <Docket selected={selected} dag={dag} onSelect={setSelected} />
    <main className="workspace">
      <header className="topbar"><div><span className="eyebrow">BTC · ETH / semantic operations</span><h1>Read the weather. Keep the brakes.</h1></div><div className="top-actions"><span className="session-chip"><i />session until {formatTime(sessionExpiry)}</span><button type="button" className="theme-toggle" onClick={() => setTheme((current) => current === 'night' ? 'ember' : 'night')}>{theme === 'night' ? 'ember light' : 'night shade'}</button><button type="button" className="logout" onClick={() => controlApi.logout(csrf).finally(() => setCsrf(null))}>close session</button></div></header>
      <div className="workspace-grid">
        <section className="stream-column">
          <div className="stream-heading"><div><SectionLabel hint="live projection">Agent stream</SectionLabel><h2>{selected}</h2></div><Tone value={selectedNode?.status || 'waiting'} /></div>
          <MessageStream messages={messages} />
          <div className="tool-stack"><ToolCard title="public evidence" detail="dated BTC/ETH snapshot" state={status?.ready ? 'ready' : status?.status || 'waiting'} /><ToolCard title="deterministic guard" detail="semantic output only" state="active" /></div>
          <div className="composer"><textarea placeholder="Ask about the current cycle…" aria-label="Cycle note" onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) runCycle() }} /><button type="button" onClick={runCycle} disabled={busy}>send to cycle</button><small>⌘↵ runs the current UTC cycle · no free-form tool access</small></div>
        </section>
        <aside className="inspector">
          <div className="inspector-scroll">
            <CyclePanel date={date} isoWeek={isoWeek} onDate={(value) => { setDate(value); const nextWeek = utcIsoWeek(value); if (nextWeek) setIsoWeek(nextWeek) }} onWeek={setIsoWeek} onRun={runCycle} busy={busy} />
            <PaperSummary paper={paper} />
            <SectionLabel hint="fixed socket projection">Venue controls</SectionLabel>
            {VENUES.map((venueName) => <VenueCard key={venueName} venue={venueName} data={testnet[venueName]} csrf={csrf} onAction={action} date={date} isoWeek={isoWeek} planHash={planHashes[venueName]} confirmation={confirmations[venueName]} setConfirmation={(value) => setConfirmations((current) => ({ ...current, [venueName]: value }))} armConfirmation={armConfirmations[venueName]} setArmConfirmation={(value) => setArmConfirmations((current) => ({ ...current, [venueName]: value }))} />)}
            {notice && <div className="notice" role="alert">{notice}</div>}
          </div>
          <footer className="inspector-foot"><span>control plane</span><Tone value={status?.service || status?.status || 'ready'} /><span className="hash-foot">projection / no canonical writes</span></footer>
        </aside>
      </div>
    </main>
  </div>
}
