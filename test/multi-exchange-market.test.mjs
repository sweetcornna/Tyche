import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectAllExchangeSnapshot,
  exchangeCatalog,
  validateMultiExchangeSnapshot
} from '../scripts/multi-exchange-market.mjs'
import { DATE, NOW, WEEK } from './helpers.mjs'

const constructorOptions = []

class FixtureExchange {
  constructor(options) {
    constructorOptions.push(options)
    this.name = this.constructor.exchangeName
    this.has = {
      fetchTicker: true,
      fetchOrderBook: true,
      fetchOHLCV: true,
      fetchTrades: true,
      fetchFundingRate: true,
      fetchFundingRateHistory: true,
      fetchOpenInterest: true,
      fetchLiquidations: true
    }
  }

  async loadMarkets() {
    return {
      'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', settle: null, spot: true, swap: false, active: true },
      'ETH/USD': { id: 'ETHUSD', symbol: 'ETH/USD', base: 'ETH', quote: 'USD', settle: null, spot: true, swap: false, active: true },
      'BTC/USDT:USDT': { id: 'BTCUSDT-PERP', symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT', spot: false, swap: true, linear: true, active: true, contractSize: 0.001, maker: 0.0002, taker: 0.0005, precision: { amount: 1, price: 0.1 }, limits: { amount: { min: 1, max: 10000 }, leverage: { min: 1, max: 3 } } }
    }
  }

  async fetchTicker(symbol) {
    const adjustment = this.constructor.priceAdjustment || 0
    const price = (symbol.startsWith('BTC') ? 100 : 50) + adjustment
    return { timestamp: NOW, last: price, bid: price - 1, ask: price + 1, baseVolume: 10, quoteVolume: 1000, percentage: 1 }
  }

  async fetchOrderBook() {
    return { timestamp: NOW, nonce: 7, bids: [[99, 2]], asks: [[101, 3]] }
  }

  async fetchOHLCV(symbol, timeframe) {
    assert.ok(['4h', '1d'].includes(timeframe))
    return [[NOW - 60000, 90, 110, 80, symbol.startsWith('BTC') ? 100 : 50, 5]]
  }

  async fetchTrades() {
    return [{ id: 'trade-1', timestamp: NOW, side: 'buy', price: 100, amount: 1, cost: 100 }]
  }

  async fetchFundingRate() {
    return { timestamp: NOW, nextFundingTimestamp: NOW + 28800000, fundingRate: this.constructor.fundingRate, markPrice: 100, indexPrice: 100 }
  }

  async fetchOpenInterest() {
    return { timestamp: NOW, openInterestAmount: 10, openInterestValue: 1000 }
  }

  async fetchFundingRateHistory() {
    return [{ timestamp: NOW, fundingRate: this.constructor.fundingRate, markPrice: 100, indexPrice: 100 }]
  }

  async fetchLiquidations() {
    return [{ id: 'liq-1', timestamp: NOW, side: 'sell', price: 90, contracts: 2, contractSize: 0.001, quoteValue: 180 }]
  }

  async close() {}
}

class Alpha extends FixtureExchange {}
Alpha.exchangeName = 'Alpha'
Alpha.priceAdjustment = 0
Alpha.fundingRate = -0.001

class Beta extends FixtureExchange {
  async fetchOrderBook() {
    throw Object.assign(new Error('fixture'), { name: 'NetworkError' })
  }
}
Beta.exchangeName = 'Beta'
Beta.priceAdjustment = 2
Beta.fundingRate = 0.001

class Offline extends FixtureExchange {
  async loadMarkets() {
    throw Object.assign(new Error('fixture'), { name: 'ExchangeNotAvailable' })
  }
}
Offline.exchangeName = 'Offline'

const fixtureCcxt = { version: 'fixture', exchanges: ['alpha', 'beta', 'offline'], alpha: Alpha, beta: Beta, offline: Offline }

test('CCXT catalog is registry-driven and exposes the pinned public adapter', () => {
  const catalog = exchangeCatalog({ ccxtModule: fixtureCcxt })
  assert.equal(catalog.adapter, 'ccxt')
  assert.equal(catalog.dependency_pin, '4.5.77')
  assert.deepEqual(catalog.exchanges, ['alpha', 'beta', 'offline'])
  assert.throws(() => exchangeCatalog({ ccxtModule: fixtureCcxt, exchanges: 'unknown' }), { code: 'MULTI_MARKET_EXCHANGE_UNSUPPORTED' })
})

test('installed CCXT registry exposes broad current coverage without network access', () => {
  const catalog = exchangeCatalog()
  assert.ok(catalog.exchange_count >= 100)
  assert.ok(catalog.exchanges.includes('gate'))
  assert.ok(catalog.exchanges.includes('kraken'))
  assert.ok(catalog.exchanges.includes('coinbase'))
})

test('all registered exchanges are isolated, normalized, aggregated, and sealed', async () => {
  constructorOptions.length = 0
  const snapshot = await collectAllExchangeSnapshot({ ccxtModule: fixtureCcxt, date: DATE, isoWeek: WEEK, now: NOW, channels: 'all', concurrency: 2, timeoutMs: 5000 })
  assert.equal(snapshot.status, 'PARTIAL')
  assert.deepEqual(snapshot.counts, { requested: 3, successful: 2, complete: 1, partial: 1, unavailable: 1, no_relevant_markets: 0 })
  assert.equal(snapshot.exchanges[0].assets.BTC.spot.ticker.last, '100')
  assert.equal(snapshot.exchanges[0].assets.BTC.usdm.candles.daily.length, 1)
  assert.equal(snapshot.exchanges[0].assets.BTC.usdm.trades[0].id, 'trade-1')
  assert.equal(snapshot.exchanges[0].assets.BTC.usdm.funding_history.length, 1)
  assert.equal(snapshot.exchanges[0].assets.BTC.usdm.liquidations[0].id, 'liq-1')
  assert.equal(snapshot.exchanges[0].assets.BTC.usdm.rules.taker_fee_rate, '0.0005')
  assert.equal(snapshot.exchanges[1].errors[0].code, 'NETWORKERROR')
  assert.equal(snapshot.aggregates.BTC.spot.source_count, 2)
  assert.equal(snapshot.aggregates.BTC.spot.consensus_price, '101')
  assert.equal(snapshot.aggregates.BTC.usdm.median_funding_rate, '0')
  assert.ok(constructorOptions.every((options) => Object.keys(options).sort().join(',') === 'enableRateLimit,timeout'))
  assert.equal(validateMultiExchangeSnapshot(snapshot, { date: DATE, isoWeek: WEEK }), snapshot)
  const changed = structuredClone(snapshot)
  changed.aggregates.BTC.spot.consensus_price = '999'
  assert.throws(() => validateMultiExchangeSnapshot(changed), { code: 'MULTI_MARKET_SNAPSHOT_HASH_INVALID' })
})

test('collection blocks only when every requested exchange is unavailable', async () => {
  const snapshot = await collectAllExchangeSnapshot({ ccxtModule: fixtureCcxt, date: DATE, isoWeek: WEEK, now: NOW, exchanges: ['offline'], channels: 'core', timeoutMs: 5000 })
  assert.equal(snapshot.status, 'BLOCKED')
  assert.equal(snapshot.counts.successful, 0)
})
