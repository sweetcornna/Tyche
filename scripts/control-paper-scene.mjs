import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { validatePaperLedger, derivePaperState } from './paper-trade.mjs'
import { decimalMultiply, decimalSubtract } from './gate-account-context.mjs'
import { emptyPaperScene, paperSceneDto, SCENE_EVENT_TYPES } from '../apps/control-plane/src/paper-scene.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TYPES = new Set(SCENE_EVENT_TYPES)
const positive = (value) => typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0
const positionIdentity = (row) => row && [row.symbol, row.side, row.opened_at, row.contracts, row.entry_price, row.multiplier].join(':')

export function projectPaperScene(input) {
  const ledger = validatePaperLedger(input)
  const current = derivePaperState(ledger)
  const markIndex = ledger.events.findLastIndex((event) => event.type === 'SIMULATED_EQUITY_MARK')
  const markEvent = ledger.events[markIndex]
  const marks = Object.fromEntries(Object.entries(markEvent?.data?.marks || {}).filter(([symbol, value]) => ['BTC_USDT', 'ETH_USDT'].includes(symbol) && positive(value)))
  const markedState = markEvent ? derivePaperState({ ...ledger, events: ledger.events.slice(0, markIndex + 1) }, { marks }) : null
  const completeValuation = markedState && Object.keys(markedState.positions).every((symbol) => positive(marks[symbol]))
  const last = ledger.events.at(-1)
  return paperSceneDto({
    status: 'ready', dataset_id: `ps_${createHash('sha256').update(ledger.account_id).digest('hex').slice(0, 24)}`,
    revision: `r_${last?.sequence || 0}_${last?.event_hash?.slice(0, 16) || 'initial'}`,
    sequence: last?.sequence || 0, events_start_sequence: Math.max(1, ledger.events.length - 49),
    updated_at: last?.at || ledger.created_at, valuation_at: completeValuation ? markEvent.at : null,
    evidence_gap: current.evidence_gap,
    summary: { balance: current.balance, available: current.available_quote, locked_margin: current.locked_margin,
      realized_pnl: current.realized_pnl, equity: completeValuation ? markedState.equity : null,
      unrealized_pnl: completeValuation ? markedState.unrealized_pnl : null },
    positions: Object.values(current.positions).map((position) => {
      const valued = positionIdentity(position) === positionIdentity(markedState?.positions[position.symbol]) && positive(marks[position.symbol])
      const mark = valued ? marks[position.symbol] : null
      const delta = valued ? (position.side === 'long' ? decimalSubtract(mark, position.entry_price) : decimalSubtract(position.entry_price, mark)) : null
      return { symbol: position.symbol, side: position.side, contracts: position.contracts, entry_price: position.entry_price,
        margin: position.margin, stop_price: position.stop_price, target_price: position.target_price, opened_at: position.opened_at,
        mark_price: mark, valuation_at: valued ? markEvent.at : null,
        unrealized_pnl: valued ? decimalMultiply(decimalMultiply(position.contracts, position.multiplier), delta) : null }
    }),
    orders: Object.values(current.orders).filter((order) => ['OPEN', 'PARTIALLY_FILLED'].includes(order.status)).map((order) => ({
      id: order.paper_order_id, symbol: order.symbol, side: order.side, role: order.role, status: order.status,
      quantity: String(order.quantity), filled_contracts: String(order.filled_contracts || '0'), price: String(order.price), opened_at: order.opened_at
    })),
    events: ledger.events.slice(-50).filter((event) => TYPES.has(event.type)).map((event) => ({
      id: event.event_id, sequence: event.sequence, type: event.type, at: event.at, symbol: event.data.symbol,
      side: event.data.side, role: event.data.role, contracts: event.data.contracts || event.data.quantity,
      price: event.data.price, reason: event.data.reason || event.data.kind
    }))
  })
}

// Root injection is a server-owned seam for isolated tests, never an HTTP input.
export function createPaperSceneAdapter({ root = ROOT } = {}) {
  const file = path.join(root, 'data', 'paper', 'active.json')
  let signature, cached
  return () => {
    try {
      let cursor = path.resolve(file)
      while (cursor !== path.dirname(cursor)) {
        if (fs.lstatSync(cursor).isSymbolicLink()) return emptyPaperScene('invalid')
        cursor = path.dirname(cursor)
      }
      const stat = fs.statSync(file, { bigint: true })
      if (!stat.isFile() || stat.size > 64n * 1024n * 1024n) return emptyPaperScene('invalid')
      const nextSignature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      if (signature === nextSignature) return cached
      const projected = projectPaperScene(JSON.parse(fs.readFileSync(file, 'utf8')))
      signature = nextSignature
      cached = projected
      return projected
    } catch (error) {
      signature = null; cached = null
      return emptyPaperScene(error.code === 'ENOENT' ? 'unconfigured' : error instanceof SyntaxError || String(error.code || '').startsWith('PAPER_') ? 'invalid' : 'unavailable')
    }
  }
}
