import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.jsx'
import { PAPER_EVENT_LABELS, paperAmount, consumeSceneEvents } from './paper-scene.js'

const SceneCanvas = lazy(() => import('./SceneCanvas.jsx'))
class SceneBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { this.props.onFailure() }
  render() { return this.state.failed ? null : this.props.children }
}

function timestamp(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', timeZone: 'UTC', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC' : '待核算'
}

export function SceneVisual({ mode = 'workflow', ...props }) {
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const failure = useCallback(() => { setFailed(true); setReady(false) }, [])
  const loaded = useCallback(() => setReady(true), [])
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => { setReduced(query.matches); setReady(false) }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const staticOnly = reduced || props.paused || failed
  useEffect(() => {
    if (staticOnly) { setReady(false); consumeSceneEvents(props.events, props.seenEvents) }
  }, [staticOnly, props.events, props.seenEvents])
  return <div className={`scene-visual ${ready && !staticOnly ? 'is-ready' : ''}`}>
    <img className="scene-poster" src={`/models/${mode === 'trading' ? 'trading' : 'workflow'}-poster.png`} alt="" aria-hidden="true" />
    {!staticOnly && <SceneBoundary onFailure={failure}><Suspense fallback={null}><SceneCanvas {...props} mode={mode} onFailure={failure} onReady={loaded} /></Suspense></SceneBoundary>}
    {failed && !props.decorative && <span className="sr-only" role="status">3D 暂不可用</span>}
  </div>
}

function PositionCard({ symbol, position, selected, onSelect }) {
  const pnl = position?.unrealized_pnl
  return <button type="button" className={`position-card ${selected ? 'is-selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
    <span className="position-heading"><span className={`asset-monogram ${symbol === 'BTC_USDT' ? 'asset-btc' : 'asset-eth'}`} aria-hidden="true">{symbol === 'BTC_USDT' ? '○' : '◇'}</span><strong>{symbol.split('_')[0]}</strong><span className={`position-direction ${position?.side || ''}`}>{position ? position.side === 'long' ? '↑ 多' : '↓ 空' : '未持仓'}</span></span>
    {position ? <><span className="position-size">{paperAmount(position.contracts)} <span>张</span></span><span className="position-values"><span>均价<strong>{paperAmount(position.entry_price)}</strong></span><span>保证金<strong>{paperAmount(position.margin)}</strong></span><span>核算价<strong>{paperAmount(position.mark_price)}</strong></span><span>浮盈亏<strong className={pnl === null ? '' : Number(pnl) < 0 ? 'value-negative' : 'value-positive'}>{paperAmount(pnl)}</strong></span><span>止损<strong>{position.stop_price === null ? '—' : paperAmount(position.stop_price)}</strong></span><span>止盈<strong>{position.target_price === null ? '—' : paperAmount(position.target_price)}</strong></span></span></> : <span className="position-empty">—</span>}
  </button>
}

export function SceneDock({ compact, workflow, selected, onSelectAgent, paperView, initialMode = 'workflow', inlineDetails = false, motionEnabled = true }) {
  const [mode, setMode] = useState(initialMode)
  useEffect(() => setMode(initialMode), [initialMode])
  const [expanded, setExpanded] = useState(false)
  const [paused, setPaused] = useState(false)
  const [asset, setAsset] = useState('BTC_USDT')
  const dialogRef = useRef(null)
  const expandButton = useRef(null)
  const seenEvents = useRef(new Set())
  useEffect(() => {
    const dialog = dialogRef.current
    if (expanded && !dialog.open) dialog.showModal()
    if (!expanded && dialog.open) { dialog.close(); expandButton.current?.focus() }
  }, [expanded])
  const { scene, events, notice } = paperView
  const stale = Boolean(scene && scene.status !== 'ready' && scene.previous)
  const paper = scene?.status === 'ready' ? scene : scene?.previous
  const tight = compact && !expanded
  const latestEvent = events?.at(-1)
  useEffect(() => {
    if (events.some((event) => ['SIMULATED_ORDER_OPEN', 'SIMULATED_PARTIAL_FILL', 'SIMULATED_FILLED', 'SIMULATED_POSITION_CLOSED', 'SIMULATED_LIQUIDATION'].includes(event.type))) setMode('trading')
  }, [events])
  const statusCopy = !scene ? '加载中' : ({ unconfigured: '未配置', invalid: '数据异常', unavailable: '连接中断' })[scene.status]
  const content = <section data-view={mode} className={`scene-dock ${tight ? 'is-compact' : ''} ${expanded ? 'is-expanded' : ''} ${stale ? 'is-stale' : ''}`} aria-label="场景">
    {expanded && <h2 id="scene-dialog-title" className="sr-only">{mode === 'workflow' ? '工作流' : '持仓'}</h2>}
    <header className="scene-toolbar"><div className="scene-tabs" role="group" aria-label="场景视图"><button type="button" aria-pressed={mode === 'workflow'} onClick={() => setMode('workflow')}><Icon name="workflow" />工作流</button><button type="button" aria-pressed={mode === 'trading'} onClick={() => setMode('trading')}><Icon name="positions" />持仓 <span>{paper?.positions?.length ?? '—'}</span></button></div><div className="scene-controls"><span className="paper-badge">Paper</span><button className="scene-control" type="button" onClick={() => setPaused((value) => !value)} aria-pressed={paused} disabled={!motionEnabled} aria-label={!motionEnabled ? '动效已关闭' : paused ? '开启动画' : '暂停动画'}><Icon name={paused ? 'play' : 'pause'} /></button><button ref={expandButton} className="scene-control" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-label={expanded ? '收起场景' : '展开场景'}><Icon name={expanded ? 'collapse' : 'expand'} /></button></div></header>
    <div className="scene-composition">
      <div className="scene-summary">
        {mode === 'workflow' ? <><div className="scene-progress-number" aria-label={`已完成 ${workflow.completedCount}，共 ${workflow.totalCount} 个阶段`}><strong>{String(workflow.completedCount).padStart(2, '0')}</strong><span>/ {String(workflow.totalCount).padStart(2, '0')}</span></div><span className="scene-current">{workflow.currentStage}</span><nav className="scene-track" aria-label="阶段进度">{workflow.nodes.map((node, index) => <button type="button" key={node.role} data-status={node.status} aria-label={`${node.name} · ${node.statusLabel}`} aria-pressed={selected === node.role} title={`${node.name} · ${node.statusLabel}`} onClick={() => { onSelectAgent(node.role); if (expanded) setExpanded(false) }}><span>{String(index + 1).padStart(2, '0')}</span><i /></button>)}</nav></> : <><span className="scene-summary-label">核算权益 <span>USDT</span></span><strong className="scene-equity">{paper ? paperAmount(paper.summary.equity) : '—'}</strong><span className="scene-current">{statusCopy || (paper?.positions.length ? `${paper.positions.length} 项持仓` : '未持仓')}{stale && ' · 已过期'}</span></>}
      </div>
    <div className={`scene-surface mode-${mode}`}>
      <SceneVisual mode={mode} decorative={tight} paused={paused || !motionEnabled} workflow={workflow} selected={selected} onSelectAgent={(role) => { onSelectAgent(role); if (expanded) setExpanded(false) }} paper={paper} events={events} seenEvents={seenEvents.current} onSelectAsset={(symbol) => { setAsset(symbol); setExpanded(true) }} />
    </div>
    </div>
    {mode === 'trading' && <div className="paper-scene-data">
      <div className="paper-caption"><span>核算 <time title={paper?.valuation_at || ''}>{timestamp(paper?.valuation_at)}</time></span>{!expanded && <button type="button" onClick={() => setExpanded(true)}>详情 ↗</button>}</div>
      {(statusCopy || notice || paper?.evidence_gap) && <div className="paper-scene-notice" role="status">{statusCopy || (notice ? '已同步' : '数据缺失')}{stale && ' · 已过期'}</div>}
      {paper && (expanded || inlineDetails) && <><div className="paper-metrics"><div><span>余额 · USDT</span><strong>{paperAmount(paper.summary.balance)}</strong></div><div><span>保证金 · USDT</span><strong>{paperAmount(paper.summary.locked_margin)}</strong></div><div><span>核算权益 · USDT</span><strong>{paperAmount(paper.summary.equity)}</strong></div></div><div className="position-grid" aria-label="持仓数据，价格与金额单位为 USDT">{['BTC_USDT', 'ETH_USDT'].map((symbol) => <PositionCard key={symbol} symbol={symbol} position={paper.positions.find((row) => row.symbol === symbol)} selected={asset === symbol} onSelect={() => setAsset(symbol)} />)}</div></>}
      {paper?.orders?.length > 0 && <div className="scene-orders">{paper.orders.map((order) => <div key={order.id}><strong>{order.symbol.split('_')[0]} · {order.role === 'REDUCTION' ? '减仓' : '开仓'}</strong><span>{order.status === 'PARTIALLY_FILLED' ? '部分成交' : '挂单'} · {paperAmount(order.filled_contracts)}/{paperAmount(order.quantity)} 张</span></div>)}</div>}
      {latestEvent && <div className="scene-event-announcement" aria-live="polite">{latestEvent.symbol?.split('_')[0]} {PAPER_EVENT_LABELS[latestEvent.type]}</div>}
    </div>}
  </section>
  return <>{!expanded && content}<dialog ref={dialogRef} className="scene-expanded-dialog" aria-labelledby="scene-dialog-title" onCancel={(event) => { event.preventDefault(); setExpanded(false) }} onClick={(event) => { if (event.target === event.currentTarget) setExpanded(false) }}>{expanded && content}</dialog></>
}
