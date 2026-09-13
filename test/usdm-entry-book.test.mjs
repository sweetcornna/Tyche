import test from 'node:test'
import assert from 'node:assert/strict'
import { selectUsdmCandidates } from '../scripts/gate-trade.mjs'
import { DATE, NOW, WEEK, dailySource, marketSnapshot, weeklyAnchor } from './helpers.mjs'

function snapshotWithBook(bids, asks, levels) {
  const market = marketSnapshot()
  const usdm = market.assets.BTC.usdm
  usdm.order_book = { bids: bids.map((price) => ({ price, quantity: '10' })), asks: asks.map((price) => ({ price, quantity: '10' })) }
  if (levels) usdm.technical.daily.level_sets = levels
  return market
}

function options(market, anchor = weeklyAnchor(), managed = '0') {
  return { product: 'usdm', date: DATE, isoWeek: WEEK, now: NOW, maxAgeSeconds: 900, minimumRR: 1.5, marketSnapshot: market, weeklyAnchor: anchor, managedQuantities: { BTC_USDT: managed, ETH_USDT: '0' } }
}

const longEntry = () => dailySource().execution_candidates[0]

test('a LIMIT long priced above the best ask is rejected instead of filling at once', () => {
  const result = selectUsdmCandidates([longEntry()], options(snapshotWithBook(['98.9'], ['99'])))
  assert.deepEqual(result.selected, [])
  assert.equal(result.rejected[0].code, 'ENTRY_PRICE_THROUGH_BOOK')
})

test('a LIMIT long at the touch or below the best ask rests and is selected', () => {
  for (const ask of ['100', '100.1']) {
    const result = selectUsdmCandidates([longEntry()], options(snapshotWithBook(['99.9'], [ask])))
    assert.equal(result.selected.length, 1, `ask ${ask}`)
  }
})

test('a LIMIT short priced below the best bid is rejected, while one at or above the bid rests', () => {
  const levels = { fixture: { entry: 100, stop: 110, target: 80 } }
  const short = dailySource({ candidate: { position_intent: 'ENTER_SHORT', stop_price: 110, take_profit_price: 80 } }).execution_candidates[0]
  const anchor = weeklyAnchor()
  anchor.assets.BTC.usdm_bias = 'short'
  const through = selectUsdmCandidates([short], options(snapshotWithBook(['101'], ['101.1'], levels), anchor))
  assert.deepEqual(through.selected, [])
  assert.equal(through.rejected[0].code, 'ENTRY_PRICE_THROUGH_BOOK')
  for (const bid of ['100', '99.9']) {
    const resting = selectUsdmCandidates([short], options(snapshotWithBook([bid], ['100.2'], levels), anchor))
    assert.equal(resting.selected.length, 1, `bid ${bid}`)
  }
})

test('an entry is blocked when the snapshot has no usable top of book', () => {
  const market = marketSnapshot()
  delete market.assets.BTC.usdm.order_book
  const result = selectUsdmCandidates([longEntry()], options(market))
  assert.deepEqual(result.selected, [])
  assert.equal(result.rejected[0].code, 'ENTRY_BOOK_UNAVAILABLE')
})

test('reductions are not subject to the through-book entry check', () => {
  const reduce = dailySource({ candidate: { position_intent: 'REDUCE_LONG', stop_price: null, take_profit_price: null, reduce_fraction_bps: 5000 } }).execution_candidates[0]
  const result = selectUsdmCandidates([reduce], options(snapshotWithBook(['98.9'], ['99']), weeklyAnchor(), '10'))
  assert.equal(result.selected.length, 1)
  assert.equal(result.selected[0].valid.action, 'REDUCE_LONG')
})
