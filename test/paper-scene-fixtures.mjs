import { createHash } from 'node:crypto'
import { loadConfig } from '../scripts/config.mjs'
import { createPaperLedger, appendPaperEventsValue, derivePaperState } from '../scripts/paper-trade.mjs'
import { decimalMultiply, decimalSubtract } from '../scripts/gate-account-context.mjs'

// Isolated deterministic simulation, also used by the local visual QA server.
export function sceneFixture() {
  const config = structuredClone(loadConfig())
  Object.assign(config.gate.usdm, { configured_leverage: 2, risk_per_trade_bps: 25, max_order_notional_usdt: 100, daily_new_notional_cap_usdt: 200, max_managed_notional_usdt: 300 })
  let ledger = createPaperLedger({ config, initialUsdt: '10000', dailyLossBps: '100', maxDrawdownBps: '200', maxSpreadBps: '100', maxEntryDistanceBps: '1000', triggerSlippageBps: '10', now: Date.parse('2030-01-07T12:00:00.000Z') })
  const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24)
  const append = (type, data) => {
    const n = ledger.events.length + 1
    ledger = appendPaperEventsValue(ledger, [{ type, at: new Date(Date.parse(ledger.created_at) + n * 1000).toISOString(), source_id: `scene:${n}`, data }])
    return ledger
  }
  const open = (symbol = 'BTC_USDT', side = 'buy', quantity = '5') => {
    const id = `po_${hash(`${symbol}:${ledger.events.length}`)}`
    append('SIMULATED_ORDER_OPEN', { paper_order_id: id, symbol, side, role: 'ENTRY', quantity, price: symbol === 'BTC_USDT' ? '68000' : '3400', signal_id: `scene-${symbol}` })
    return id
  }
  const fill = (id, contracts = '5', partial = false) => {
    const order = derivePaperState(ledger).orders[id]
    const margin = decimalMultiply(decimalMultiply(contracts, '0.001'), decimalMultiply(order.price, '0.5'))
    append(partial ? 'SIMULATED_PARTIAL_FILL' : 'SIMULATED_FILLED', { paper_order_id: id, paper_fill_id: `pf_${hash(id)}`, symbol: order.symbol,
      side: order.side === 'buy' ? 'long' : 'short', role: 'ENTRY', contracts, price: order.price,
      multiplier: '0.001', margin, liquidation_price: '1000', tick_size: '0.1', taker_fee_rate: '0.0005', maintenance_rate: '0.005', tier_deduction: '0', fee: '0.1', notional: decimalMultiply(margin, '2'), signal_id: order.signal_id })
    append('SIMULATED_PROTECTION_ARMED', { symbol: order.symbol, contracts, stop_price: decimalMultiply(order.price, order.side === 'buy' ? '.95' : '1.05'), target_price: decimalMultiply(order.price, order.side === 'buy' ? '1.1' : '.9') })
  }
  const mark = (marks = { BTC_USDT: '69500', ETH_USDT: '3300' }) => {
    const state = derivePaperState(ledger, { marks })
    append('SIMULATED_EQUITY_MARK', { equity: state.equity, marks })
  }
  const close = (symbol = 'BTC_USDT', contracts = '5') => {
    const row = derivePaperState(ledger).positions[symbol]
    const price = symbol === 'BTC_USDT' ? '69500' : '3300'
    const difference = row.side === 'long' ? decimalSubtract(price, row.entry_price) : decimalSubtract(row.entry_price, price)
    append('SIMULATED_POSITION_CLOSED', { symbol, contracts, price, pnl: decimalMultiply(decimalMultiply(contracts, row.multiplier), difference), fee: '0.01' })
  }
  return { get ledger() { return ledger }, append, open, fill, mark, close }
}
