import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlan, parseUsdmRule } from '../scripts/gate-trade.mjs'
import { DATE, NOW, WEEK, dailySource, manualConfig, marketSnapshot, planContext, weeklyAnchor } from './helpers.mjs'

// Captured from Gate's public futures contract endpoint. ETH_USDT now accepts
// decimal sizes and reports a zero minimum; BTC_USDT still reports one.
const LIVE_ETH_RULE = Object.freeze({ name: 'ETH_USDT', order_price_round: '0.01', quanto_multiplier: '0.01', order_size_min: 0, order_size_max: 10000000, leverage_max: '200', maintenance_rate: '0.003', maker_fee_rate: '-0.0001', taker_fee_rate: '0.00075', status: 'trading', in_delisting: false, enable_circuit_breaker: false, enable_decimal: true })

test('a zero contract minimum from a decimal-size contract means one whole contract', () => {
  const rule = parseUsdmRule(LIVE_ETH_RULE)
  assert.equal(rule.ok, true)
  assert.equal(rule.min_contracts, '1')
  for (const zero of [0, '0', '0.0', ' 0 ']) assert.equal(parseUsdmRule({ ...LIVE_ETH_RULE, order_size_min: zero }).min_contracts, '1', String(zero))
  assert.equal(parseUsdmRule({ ...LIVE_ETH_RULE, order_size_min: undefined }).min_contracts, '1')
  assert.equal(parseUsdmRule({ ...LIVE_ETH_RULE, name: 'BTC_USDT', order_size_min: 1 }).min_contracts, '1')
})

test('a negative or non-numeric contract minimum is still rejected', () => {
  for (const bad of [-1, '-1', 'abc']) assert.equal(parseUsdmRule({ ...LIVE_ETH_RULE, order_size_min: bad }).code, 'USDM_RULE_INVALID', String(bad))
})

test('an ETH entry plans whole contracts against the live decimal-size contract rule', () => {
  const at = new Date(NOW).toISOString()
  const context = planContext()
  context.rules.ETH_USDT = { ...LIVE_ETH_RULE, _fetched_at: at }
  context.quotes.ETH_USDT = { product: 'usdm', symbol: 'ETH_USDT', price: '2400.5', bid: '2400.4', ask: '2400.5', fetched_at: at }
  context.accounts['usdm:ETH_USDT'] = { ...context.accounts['usdm:BTC_USDT'], account_epoch_id: 'tae_fixture_eth', symbol: 'ETH_USDT' }
  const market = marketSnapshot()
  market.assets.ETH.usdm = {
    ticker: { last: '2400.5', mark_price: '2400.5', index_price: '2400.5' },
    order_book: { bids: [{ price: '2400.4', quantity: '10' }], asks: [{ price: '2400.5', quantity: '10' }] },
    technical: { daily: { level_sets: { eth_fixture: { entry: 2400, stop: 2300, target: 2600 } } }, four_hour: { level_sets: {} } }
  }
  const anchor = weeklyAnchor()
  anchor.assets.ETH.usdm_bias = 'long'
  const source = dailySource({ candidate: { asset: 'ETH', symbol: 'ETH_USDT', entry_price: 2400, stop_price: 2300, take_profit_price: 2600, evidence_refs: ['fixture#eth'], signal_id: 'fixture:eth:long' } })
  const plan = createPlan(source, { product: 'usdm', environment: 'testnet', config: manualConfig(), context, ledger: { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: DATE, isoWeek: WEEK, weeklyAnchor: anchor, marketSnapshot: market, now: NOW })
  assert.equal(plan.status, 'READY', JSON.stringify({ blockers: plan.blockers, skipped: plan.skipped }))
  assert.equal(plan.intents.length, 1)
  assert.equal(plan.intents[0].symbol, 'ETH_USDT')
  assert.match(String(plan.intents[0].quantity), /^[1-9]\d*$/)
})
