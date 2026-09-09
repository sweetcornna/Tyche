export const PAPER_EVENT_LABELS = Object.freeze({
  SIMULATED_ORDER_OPEN: '已挂单', SIMULATED_PARTIAL_FILL: '部分成交', SIMULATED_FILLED: '已成交',
  SIMULATED_CANCELLED: '已撤单', SIMULATED_POSITION_CLOSED: '已减仓／平仓',
  SIMULATED_LIQUIDATION: '已强平', SIMULATED_PROTECTION_ARMED: '已设置保护', SIMULATION_EVIDENCE_GAP: '数据缺失'
})

// Lifecycle cursors are page-memory only. A fresh session always establishes a baseline.
export function advancePaperScene(cursor, snapshot, baseline = false) {
  if (snapshot?.status !== 'ready') return { cursor, events: [], notice: '', accepted: true }
  if (cursor?.dataset === snapshot.dataset_id && snapshot.sequence < cursor.sequence) return { cursor, events: [], notice: '', accepted: false }
  const reset = baseline || !cursor || cursor.dataset !== snapshot.dataset_id
  const gap = !reset && cursor.sequence < snapshot.events_start_sequence - 1
  const seen = new Set(reset ? [] : cursor.ids)
  const events = reset || gap ? [] : [...snapshot.events].sort((a, b) => a.sequence - b.sequence).filter((event) => {
    if (event.sequence <= cursor.sequence || seen.has(event.id)) return false
    seen.add(event.id)
    return true
  })
  const ids = [...new Set([...seen, ...snapshot.events.map((event) => event.id)])].slice(-100)
  return { cursor: { dataset: snapshot.dataset_id, sequence: snapshot.sequence, revision: snapshot.revision, ids },
    events, accepted: true, notice: gap ? '期间发生多次更新，已同步最新持仓。' : '' }
}

export function paperPollDelay(running, scene) {
  return running || (scene?.status === 'ready' && scene.orders.length > 0) ? 1000 : 15000
}

// Shared by every canvas incarnation, including dialog and static-view transitions.
export function consumeSceneEvents(events = [], seen = new Set()) {
  return events.filter((event) => {
    if (!['BTC_USDT', 'ETH_USDT'].includes(event.symbol) || seen.has(event.id)) return false
    seen.add(event.id)
    if (seen.size > 100) seen.delete(seen.values().next().value)
    return true
  })
}

export function paperAmount(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '待核算'
  // Preserve source decimals; inserting thousands separators never rounds contracts.
  const text = String(value)
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return '暂不可用'
  const [integer, fraction] = text.split('.')
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}${suffix}`
}
