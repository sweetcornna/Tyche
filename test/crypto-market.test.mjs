import test from 'node:test'
import assert from 'node:assert/strict'
import { collectMarketSnapshot } from '../scripts/crypto-market.mjs'
import { DATE, WEEK, NOW } from './helpers.mjs'

function candles(kind, count, start, intervalSeconds) {
  const finalTime = Math.floor(NOW / 1000) - intervalSeconds
  const firstTime = finalTime - (count - 1) * intervalSeconds
  return Array.from({ length: count }, (_, index) => {
    const close = start + index
    const time = firstTime + index * intervalSeconds
    return kind === 'spot'
      ? [time, 1000 + index, close, close + 2, close - 2, close - 1]
      : { t: time, v: 1000 + index, c: close, h: close + 2, l: close - 2, o: close - 1 }
  })
}

function spotClient() {
  return {
    spotPair: async ({ currency_pair }) => ({ data: { id: currency_pair, base: currency_pair.startsWith('BTC') ? 'BTC' : 'ETH', quote: 'USDT', trade_status: 'tradable', precision: 1, amount_precision: 3, min_quote_amount: '1', min_base_amount: '0.001' } }),
    spotTickers: async ({ currency_pair }) => ({ data: [{ currency_pair, last: '100', highest_bid: '99', lowest_ask: '101', base_volume: '10', quote_volume: '1000' }] }),
    spotOrderBook: async () => ({ data: { bids: [['99', '2']], asks: [['101', '2']] } }),
    spotCandlesticks: async ({ interval }) => ({ data: candles('spot', interval === '1d' ? 365 : 180, 100, interval === '1d' ? 86400 : 14400) })
  }
}

function usdmClient() {
  return {
    usdmContract: async ({ contract }) => ({ data: { name: contract, order_price_round: '0.1', quanto_multiplier: '0.001', order_size_min: '1', order_size_max: '10000', leverage_max: '3', in_delisting: false, mark_price: '100', funding_rate: '0' } }),
    usdmTickers: async ({ contract }) => ({ data: [{ contract, last: '100', mark_price: '100', index_price: '100', funding_rate: '0' }] }),
    usdmOrderBook: async () => ({ data: { bids: [{ p: '99', s: '2' }], asks: [{ p: '101', s: '2' }] } }),
    usdmCandlesticks: async ({ interval }) => ({ data: candles('usdm', interval === '1d' ? 365 : 180, 100, interval === '1d' ? 86400 : 14400) }),
    usdmFundingRate: async () => ({ data: [{ t: 1800000000, r: '0' }] })
  }
}

test('public snapshot covers exactly BTC and ETH and computes deterministic technical summaries', async () => {
  const snapshot = await collectMarketSnapshot({ date: DATE, isoWeek: WEEK, now: NOW, spotClient: spotClient(), usdmClient: usdmClient() })
  assert.equal(snapshot.schema, 'tyche_crypto_market/v1')
  assert.deepEqual(Object.keys(snapshot.assets), ['BTC', 'ETH'])
  assert.equal(snapshot.assets.BTC.symbol, 'BTC_USDT')
  assert.equal(snapshot.assets.ETH.symbol, 'ETH_USDT')
  assert.equal(snapshot.assets.BTC.spot.technical.daily.bars, 365)
  assert.ok(snapshot.assets.BTC.spot.technical.daily.sma200 > 0)
  assert.ok(snapshot.assets.BTC.usdm.technical.four_hour.atr14 > 0)
  assert.ok(snapshot.assets.BTC.spot.technical.daily.level_sets.long_breakout)
})

test('snapshot rejects stale candle series even when the fetch itself is current', async () => {
  const stale = spotClient()
  stale.spotCandlesticks = async ({ interval }) => ({ data: candles('spot', interval === '1d' ? 365 : 180, 100, interval === '1d' ? 86400 : 14400).map((row) => [row[0] - 10 * 86400, ...row.slice(1)]) })
  await assert.rejects(collectMarketSnapshot({ date: DATE, isoWeek: WEEK, now: NOW, spotClient: stale, usdmClient: usdmClient() }), { code: 'MARKET_CANDLES_STALE' })
})

test('snapshot refuses unsupported date or week anchors before reading market clients', async () => {
  let called = false
  const client = new Proxy({}, { get() { called = true; return async () => ({ data: [] }) } })
  await assert.rejects(collectMarketSnapshot({ date: 'not-a-date', isoWeek: WEEK, spotClient: client, usdmClient: client }), { code: 'MARKET_DATE_INVALID' })
  assert.equal(called, false)
})
