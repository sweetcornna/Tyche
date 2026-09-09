// The scene has an explicit DTO; raw account/ledger objects never reach the UI.
const SYMBOLS = new Set(['BTC_USDT', 'ETH_USDT'])
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
export const SCENE_EVENT_TYPES = Object.freeze([
  'SIMULATED_ORDER_OPEN', 'SIMULATED_PARTIAL_FILL', 'SIMULATED_FILLED', 'SIMULATED_CANCELLED',
  'SIMULATED_POSITION_CLOSED', 'SIMULATED_LIQUIDATION', 'SIMULATED_PROTECTION_ARMED', 'SIMULATION_EVIDENCE_GAP'
])
const TYPES = new Set(SCENE_EVENT_TYPES)
const amount = (value) => typeof value === 'string' && value.length <= 80 && DECIMAL.test(value) && Number.isFinite(Number(value)) ? value : null
const time = (value) => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null
const id = (value) => typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value) ? value : null
const sequence = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0
const pick = (value, values) => values.includes(value) ? value : null

export function emptyPaperScene(status = 'unavailable') {
  return { schema: 'tyche_paper_scene/v1', environment: 'paper', status, dataset_id: null, revision: null,
    sequence: 0, events_start_sequence: 1, updated_at: null, valuation_at: null, evidence_gap: false,
    summary: null, positions: [], orders: [], events: [] }
}

export function paperSceneDto(value) {
  const status = pick(value?.status, ['ready', 'unconfigured', 'invalid', 'unavailable']) || 'unavailable'
  if (status !== 'ready') return emptyPaperScene(status)
  if (!id(value.dataset_id) || !id(value.revision) || !value.summary || !Array.isArray(value.positions) || !Array.isArray(value.orders) || !Array.isArray(value.events)) return emptyPaperScene('invalid')
  const summary = {}
  for (const key of ['balance', 'available', 'locked_margin', 'realized_pnl', 'equity', 'unrealized_pnl']) summary[key] = amount(value.summary[key])
  const positions = value.positions.slice(0, 2).filter((row) => SYMBOLS.has(row?.symbol)).map((row) => {
    const out = { symbol: row.symbol, side: pick(row.side, ['long', 'short']), opened_at: time(row.opened_at), valuation_at: time(row.valuation_at) }
    for (const key of ['contracts', 'entry_price', 'margin', 'stop_price', 'target_price', 'mark_price', 'unrealized_pnl']) out[key] = amount(row[key])
    return out
  })
  const orders = value.orders.slice(0, 20).filter((row) => SYMBOLS.has(row?.symbol)).map((row) => ({
    id: id(row.id), symbol: row.symbol, side: pick(row.side, ['buy', 'sell', 'long', 'short']),
    role: pick(row.role, ['ENTRY', 'REDUCTION']), status: pick(row.status, ['OPEN', 'PARTIALLY_FILLED']),
    quantity: amount(row.quantity), filled_contracts: amount(row.filled_contracts), price: amount(row.price), opened_at: time(row.opened_at)
  }))
  const events = value.events.slice(-50).filter((row) => TYPES.has(row?.type) && id(row.id) && sequence(row.sequence) > 0).map((row) => ({
    id: id(row.id), sequence: sequence(row.sequence), type: row.type, at: time(row.at),
    symbol: SYMBOLS.has(row.symbol) ? row.symbol : null, side: pick(row.side, ['long', 'short', 'buy', 'sell']),
    role: pick(row.role, ['ENTRY', 'REDUCTION']), contracts: amount(row.contracts), price: amount(row.price),
    reason: pick(row.reason, ['WATCH_EXPIRED', 'VISIBLE_DEPTH_EXHAUSTED', 'EVIDENCE_GAP', 'STOP', 'TARGET', 'REDUCTION', 'CLOSE', 'OTHER'])
  }))
  if (positions.some((row) => !row.side || !row.contracts || Number(row.contracts) <= 0 || !row.entry_price || Number(row.entry_price) <= 0 || !row.margin) || orders.some((row) => !row.id || !row.status || !row.side || !row.quantity || Number(row.quantity) <= 0)) return emptyPaperScene('invalid')
  return { ...emptyPaperScene('ready'), dataset_id: id(value.dataset_id), revision: id(value.revision),
    sequence: sequence(value.sequence), events_start_sequence: Math.max(1, sequence(value.events_start_sequence)),
    updated_at: time(value.updated_at), valuation_at: time(value.valuation_at), evidence_gap: value.evidence_gap === true,
    summary, positions, orders, events }
}
