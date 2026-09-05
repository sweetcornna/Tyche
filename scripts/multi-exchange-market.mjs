#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ccxt from 'ccxt'
import { sha256Hex } from './gate-trade.mjs'
import { writeJsonAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = 'tyche_multi_exchange_market/v1'
const ASSETS = Object.freeze(['BTC', 'ETH'])
const PRODUCTS = Object.freeze(['spot', 'usdm'])
const ALL_CHANNELS = Object.freeze(['ticker', 'order_book', 'candles', 'trades', 'funding', 'funding_history', 'open_interest', 'liquidations'])
const CORE_CHANNELS = Object.freeze(['ticker', 'order_book', 'funding', 'open_interest'])
const CCXT_PIN = '4.5.77'

export class MultiExchangeError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'MultiExchangeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new MultiExchangeError(code, message, details)
}

function validateDate(value) {
  const text = String(value || '')
  const parsed = new Date(`${text}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail('MULTI_MARKET_DATE_INVALID', 'date must be a real YYYY-MM-DD value')
  return text
}

function validateWeek(value) {
  const text = String(value || '')
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(text)) fail('MULTI_MARKET_WEEK_INVALID', 'iso-week must use YYYY-Www')
  return text
}

function exactIso(value) {
  const milliseconds = typeof value === 'function' ? Number(value()) : Number(value)
  if (!Number.isFinite(milliseconds)) fail('MULTI_MARKET_TIME_INVALID', 'collector clock is invalid')
  return new Date(milliseconds).toISOString()
}

function scalar(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return String(value)
}

function timestamp(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return new Date(number < 1e12 ? number * 1000 : number).toISOString()
}

function errorCode(error) {
  const raw = String(error?.name || error?.constructor?.name || error?.code || 'ExchangeError')
  return raw.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 80) || 'EXCHANGE_ERROR'
}

function capability(exchange, method) {
  return exchange?.has?.[method] === true || exchange?.has?.[method] === 'emulated'
}

function normalizeLevels(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 5).map((row) => ({ price: scalar(row?.[0]), quantity: scalar(row?.[1]) })).filter((row) => row.price !== null && row.quantity !== null)
}

function normalizeTicker(row) {
  if (!row || typeof row !== 'object') return null
  return {
    timestamp: timestamp(row.timestamp),
    last: scalar(row.last),
    bid: scalar(row.bid),
    ask: scalar(row.ask),
    base_volume: scalar(row.baseVolume),
    quote_volume: scalar(row.quoteVolume),
    change: scalar(row.change),
    percentage: scalar(row.percentage)
  }
}

function normalizeOrderBook(row) {
  if (!row || typeof row !== 'object') return null
  return { timestamp: timestamp(row.timestamp), nonce: scalar(row.nonce), bids: normalizeLevels(row.bids), asks: normalizeLevels(row.asks) }
}

function normalizeCandles(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    timestamp: timestamp(row?.[0]),
    open: scalar(row?.[1]),
    high: scalar(row?.[2]),
    low: scalar(row?.[3]),
    close: scalar(row?.[4]),
    volume: scalar(row?.[5])
  })).filter((row) => row.timestamp && row.open && row.high && row.low && row.close)
}

function normalizeTrades(rows) {
  return (Array.isArray(rows) ? rows : []).slice(-50).map((row) => ({
    id: scalar(row?.id),
    timestamp: timestamp(row?.timestamp),
    side: ['buy', 'sell'].includes(String(row?.side || '').toLowerCase()) ? String(row.side).toLowerCase() : null,
    price: scalar(row?.price),
    amount: scalar(row?.amount),
    cost: scalar(row?.cost)
  })).filter((row) => row.timestamp && row.price && row.amount)
}

function normalizeFunding(row) {
  if (!row || typeof row !== 'object') return null
  return {
    timestamp: timestamp(row.timestamp),
    next_funding_at: timestamp(row.nextFundingTimestamp),
    funding_rate: scalar(row.fundingRate),
    mark_price: scalar(row.markPrice),
    index_price: scalar(row.indexPrice)
  }
}

function normalizeOpenInterest(row) {
  if (!row || typeof row !== 'object') return null
  return {
    timestamp: timestamp(row.timestamp),
    amount: scalar(row.openInterestAmount),
    value: scalar(row.openInterestValue),
    base_volume: scalar(row.baseVolume),
    quote_volume: scalar(row.quoteVolume)
  }
}

function normalizeLiquidations(rows) {
  return (Array.isArray(rows) ? rows : []).slice(-100).map((row) => ({
    id: scalar(row?.id),
    timestamp: timestamp(row?.timestamp),
    side: ['buy', 'sell'].includes(String(row?.side || '').toLowerCase()) ? String(row.side).toLowerCase() : null,
    price: scalar(row?.price),
    contracts: scalar(row?.contracts),
    contract_size: scalar(row?.contractSize),
    base_value: scalar(row?.baseValue),
    quote_value: scalar(row?.quoteValue)
  })).filter((row) => row.timestamp && row.price)
}

function marketRules(market) {
  return {
    maker_fee_rate: scalar(market.maker),
    taker_fee_rate: scalar(market.taker),
    precision: { amount: scalar(market.precision?.amount), price: scalar(market.precision?.price) },
    limits: {
      amount: { min: scalar(market.limits?.amount?.min), max: scalar(market.limits?.amount?.max) },
      cost: { min: scalar(market.limits?.cost?.min), max: scalar(market.limits?.cost?.max) },
      leverage: { min: scalar(market.limits?.leverage?.min), max: scalar(market.limits?.leverage?.max) }
    }
  }
}

function marketScore(market, product) {
  if (!market || market.active === false) return -Infinity
  if (product === 'spot') {
    if (market.spot !== true) return -Infinity
    return market.quote === 'USDT' ? 20 : market.quote === 'USD' ? 10 : -Infinity
  }
  if (market.swap !== true || market.linear === false || market.settle !== 'USDT' || market.quote !== 'USDT') return -Infinity
  return 30
}

function findMarket(markets, asset, product) {
  return Object.values(markets || {})
    .filter((market) => market?.base === asset)
    .map((market) => ({ market, score: marketScore(market, product) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((left, right) => right.score - left.score || String(left.market.symbol).localeCompare(String(right.market.symbol)))[0]?.market || null
}

async function readChannel(exchange, method, args, scope, errors, normalize) {
  if (!capability(exchange, method)) return null
  try {
    return normalize(await exchange[method](...args))
  } catch (error) {
    errors.push({ scope, channel: method, code: errorCode(error) })
    return null
  }
}

async function collectMarketChannels(exchange, market, product, channels, errors) {
  if (!market) return null
  const scope = `${product}:${market.symbol}`
  const output = {
    symbol: String(market.symbol),
    market_id: String(market.id),
    base: String(market.base),
    quote: String(market.quote),
    settle: market.settle ? String(market.settle) : null,
    active: market.active !== false,
    linear: market.linear === true,
    contract_size: scalar(market.contractSize),
    rules: marketRules(market),
    ticker: channels.has('ticker') ? await readChannel(exchange, 'fetchTicker', [market.symbol], scope, errors, normalizeTicker) : null,
    order_book: channels.has('order_book') ? await readChannel(exchange, 'fetchOrderBook', [market.symbol, 5], scope, errors, normalizeOrderBook) : null,
    candles: null,
    trades: channels.has('trades') ? await readChannel(exchange, 'fetchTrades', [market.symbol, undefined, 50], scope, errors, normalizeTrades) : null,
    funding: null,
    funding_history: null,
    open_interest: null,
    liquidations: null
  }
  if (channels.has('candles') && capability(exchange, 'fetchOHLCV')) {
    output.candles = {
      four_hour: await readChannel(exchange, 'fetchOHLCV', [market.symbol, '4h', undefined, 60], `${scope}:4h`, errors, normalizeCandles),
      daily: await readChannel(exchange, 'fetchOHLCV', [market.symbol, '1d', undefined, 90], `${scope}:1d`, errors, normalizeCandles)
    }
  }
  if (product === 'usdm' && channels.has('funding')) output.funding = await readChannel(exchange, 'fetchFundingRate', [market.symbol], scope, errors, normalizeFunding)
  if (product === 'usdm' && channels.has('funding_history')) output.funding_history = await readChannel(exchange, 'fetchFundingRateHistory', [market.symbol, undefined, 100], scope, errors, (rows) => (Array.isArray(rows) ? rows : []).map(normalizeFunding).filter(Boolean))
  if (product === 'usdm' && channels.has('open_interest')) output.open_interest = await readChannel(exchange, 'fetchOpenInterest', [market.symbol], scope, errors, normalizeOpenInterest)
  if (product === 'usdm' && channels.has('liquidations')) output.liquidations = await readChannel(exchange, 'fetchLiquidations', [market.symbol, undefined, 100], scope, errors, normalizeLiquidations)
  return output
}

function hasUsableData(market) {
  return Boolean(market && (
    market.ticker ||
    market.order_book ||
    (market.candles && (market.candles.four_hour?.length || market.candles.daily?.length)) ||
    market.trades?.length ||
    market.funding ||
    market.funding_history?.length ||
    market.open_interest ||
    market.liquidations?.length
  ))
}

function exchangeCapabilities(exchange) {
  return Object.fromEntries([
    ['ticker', 'fetchTicker'],
    ['order_book', 'fetchOrderBook'],
    ['candles', 'fetchOHLCV'],
    ['trades', 'fetchTrades'],
    ['funding', 'fetchFundingRate'],
    ['funding_history', 'fetchFundingRateHistory'],
    ['open_interest', 'fetchOpenInterest'],
    ['liquidations', 'fetchLiquidations']
  ].map(([label, method]) => [label, capability(exchange, method)]))
}

async function collectExchange(exchangeId, options) {
  const Exchange = options.ccxtModule[exchangeId]
  if (typeof Exchange !== 'function') return { exchange_id: exchangeId, name: exchangeId, status: 'UNAVAILABLE', capabilities: {}, assets: {}, errors: [{ scope: 'exchange', channel: 'loadMarkets', code: 'ADAPTER_MISSING' }] }
  const errors = []
  const exchange = new Exchange({ enableRateLimit: true, timeout: options.timeoutMs })
  let markets
  try {
    markets = await exchange.loadMarkets()
  } catch (error) {
    try { await exchange.close?.() } catch {}
    return { exchange_id: exchangeId, name: String(exchange.name || exchangeId), status: 'UNAVAILABLE', capabilities: exchangeCapabilities(exchange), assets: {}, errors: [{ scope: 'exchange', channel: 'loadMarkets', code: errorCode(error) }] }
  }
  const assets = {}
  let relevantMarkets = 0
  let usableMarkets = 0
  for (const asset of ASSETS) {
    const row = {}
    for (const product of PRODUCTS) {
      const market = findMarket(markets, asset, product)
      if (market) relevantMarkets += 1
      row[product] = await collectMarketChannels(exchange, market, product, options.channels, errors)
      if (hasUsableData(row[product])) usableMarkets += 1
    }
    assets[asset] = row
  }
  try { await exchange.close?.() } catch {}
  if (relevantMarkets > 0 && usableMarkets === 0) errors.push({ scope: 'exchange', channel: 'publicData', code: 'NO_USABLE_PUBLIC_DATA' })
  const status = relevantMarkets === 0 ? 'NO_RELEVANT_MARKETS' : usableMarkets === 0 ? 'UNAVAILABLE' : errors.length ? 'PARTIAL' : 'OK'
  return { exchange_id: exchangeId, name: String(exchange.name || exchangeId), status, capabilities: exchangeCapabilities(exchange), assets, errors }
}

async function mapConcurrent(values, limit, worker) {
  const output = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= values.length) return
      output[index] = await worker(values[index], index)
    }
  }))
  return output
}

function median(values) {
  const sorted = values.map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function signedMedian(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function aggregate(records) {
  const output = {}
  for (const asset of ASSETS) {
    output[asset] = {}
    for (const product of PRODUCTS) {
      const markets = records.flatMap((record) => {
        const data = record.assets?.[asset]?.[product]
        return data ? [{ exchange_id: record.exchange_id, data }] : []
      })
      const sources = markets.filter((row) => row.data.ticker?.last)
      const prices = sources.map((row) => row.data.ticker.last)
      const consensus = median(prices)
      const bids = markets.flatMap((row) => {
        const value = row.data.ticker?.bid ?? row.data.order_book?.bids?.[0]?.price
        return value ? [{ exchange_id: row.exchange_id, value: Number(value) }] : []
      }).filter((row) => Number.isFinite(row.value) && row.value > 0).sort((left, right) => right.value - left.value)
      const asks = markets.flatMap((row) => {
        const value = row.data.ticker?.ask ?? row.data.order_book?.asks?.[0]?.price
        return value ? [{ exchange_id: row.exchange_id, value: Number(value) }] : []
      }).filter((row) => Number.isFinite(row.value) && row.value > 0).sort((left, right) => left.value - right.value)
      const fundingRates = product === 'usdm' ? markets.map((row) => row.data.funding?.funding_rate).filter((value) => value !== null && value !== undefined) : []
      const numericPrices = prices.map(Number).filter((value) => Number.isFinite(value) && value > 0)
      output[asset][product] = {
        source_count: sources.length,
        sources: sources.map((row) => row.exchange_id).sort(),
        consensus_price: scalar(consensus),
        min_price: scalar(numericPrices.length ? Math.min(...numericPrices) : null),
        max_price: scalar(numericPrices.length ? Math.max(...numericPrices) : null),
        dispersion_bps: scalar(consensus && numericPrices.length ? ((Math.max(...numericPrices) - Math.min(...numericPrices)) / consensus) * 10000 : null),
        best_bid: bids[0] ? { exchange_id: bids[0].exchange_id, price: scalar(bids[0].value) } : null,
        best_ask: asks[0] ? { exchange_id: asks[0].exchange_id, price: scalar(asks[0].value) } : null,
        median_funding_rate: scalar(signedMedian(fundingRates))
      }
    }
  }
  return output
}

function normalizeChannels(input) {
  const values = input === undefined || input === null || input === 'core'
    ? CORE_CHANNELS
    : input === 'all'
      ? ALL_CHANNELS
      : Array.isArray(input) ? input : String(input).split(',')
  const normalized = [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
  if (!normalized.length || normalized.some((value) => !ALL_CHANNELS.includes(value))) fail('MULTI_MARKET_CHANNEL_INVALID', `channels must be core, all, or a subset of ${ALL_CHANNELS.join(',')}`)
  return new Set(ALL_CHANNELS.filter((channel) => normalized.includes(channel)))
}

function normalizeExchanges(input, module) {
  const available = Array.isArray(module?.exchanges) ? module.exchanges.map(String) : []
  if (!available.length) fail('MULTI_MARKET_REGISTRY_EMPTY', 'CCXT exchange registry is empty')
  const requested = input === undefined || input === null || input === 'all' ? available : Array.isArray(input) ? input.map(String) : String(input).split(',').map((value) => value.trim()).filter(Boolean)
  const unknown = requested.filter((value) => !available.includes(value))
  if (unknown.length) fail('MULTI_MARKET_EXCHANGE_UNSUPPORTED', `Unsupported CCXT exchange identifiers: ${unknown.join(',')}`)
  return available.filter((value) => new Set(requested).has(value))
}

export function exchangeCatalog(options = {}) {
  const module = options.ccxtModule || ccxt
  const exchanges = normalizeExchanges(options.exchanges, module)
  return { schema: 'tyche_exchange_catalog/v1', adapter: 'ccxt', dependency_pin: CCXT_PIN, runtime_version: String(module.version || 'unknown'), exchange_count: exchanges.length, exchanges }
}

export async function collectAllExchangeSnapshot(options = {}) {
  const module = options.ccxtModule || ccxt
  const date = validateDate(options.date)
  const isoWeek = validateWeek(options.isoWeek)
  const generatedAt = exactIso(options.now ?? Date.now)
  const exchanges = normalizeExchanges(options.exchanges, module)
  const channels = normalizeChannels(options.channels)
  const concurrency = Number(options.concurrency ?? 4)
  const timeoutMs = Number(options.timeoutMs ?? 15000)
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) fail('MULTI_MARKET_CONCURRENCY_INVALID', 'concurrency must be an integer from 1 through 8')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) fail('MULTI_MARKET_TIMEOUT_INVALID', 'timeout-ms must be an integer from 1000 through 30000')
  const records = await mapConcurrent(exchanges, concurrency, (exchangeId) => collectExchange(exchangeId, { ccxtModule: module, channels, timeoutMs }))
  const successful = records.filter((row) => ['OK', 'PARTIAL'].includes(row.status)).length
  const body = {
    schema: SCHEMA,
    date,
    iso_week: isoWeek,
    generated_at: generatedAt,
    adapter: { name: 'ccxt', dependency_pin: CCXT_PIN, runtime_version: String(module.version || 'unknown'), public_only: true },
    request: { scope: 'BTC_ETH_PUBLIC_MARKET_DATA', exchange_count: exchanges.length, channels: ALL_CHANNELS.filter((channel) => channels.has(channel)) },
    status: successful === 0 ? 'BLOCKED' : records.some((row) => row.status !== 'OK') ? 'PARTIAL' : 'COMPLETE',
    counts: {
      requested: exchanges.length,
      successful,
      complete: records.filter((row) => row.status === 'OK').length,
      partial: records.filter((row) => row.status === 'PARTIAL').length,
      unavailable: records.filter((row) => row.status === 'UNAVAILABLE').length,
      no_relevant_markets: records.filter((row) => row.status === 'NO_RELEVANT_MARKETS').length
    },
    aggregates: aggregate(records),
    exchanges: records
  }
  return { ...body, snapshot_hash: sha256Hex(body) }
}

export function validateMultiExchangeSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.schema !== SCHEMA || !/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.date || '')) || !/^\d{4}-W\d{2}$/.test(String(snapshot.iso_week || '')) || !Array.isArray(snapshot.exchanges) || !snapshot.aggregates || !snapshot.counts || !/^[a-f0-9]{64}$/.test(String(snapshot.snapshot_hash || ''))) fail('MULTI_MARKET_SNAPSHOT_INVALID', 'Multi-exchange snapshot shape is invalid')
  const body = { ...snapshot }
  delete body.snapshot_hash
  if (sha256Hex(body) !== snapshot.snapshot_hash) fail('MULTI_MARKET_SNAPSHOT_HASH_INVALID', 'Multi-exchange snapshot was modified after collection')
  if (options.date && snapshot.date !== options.date) fail('MULTI_MARKET_SNAPSHOT_ANCHOR_MISMATCH', 'Multi-exchange snapshot date does not match')
  if (options.isoWeek && snapshot.iso_week !== options.isoWeek) fail('MULTI_MARKET_SNAPSHOT_ANCHOR_MISMATCH', 'Multi-exchange snapshot ISO week does not match')
  return snapshot
}

function outputPath(value) {
  const raw = String(value || '')
  const absolute = path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw))
  const dataRoot = path.join(ROOT, 'data')
  const relative = path.relative(dataRoot, absolute)
  if (!raw || !absolute.endsWith('.json') || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('MULTI_MARKET_OUTPUT_INVALID', 'output must be a JSON file under data/')
  return absolute
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const command = values[0]
  if (!['catalog', 'snapshot'].includes(command)) fail('MULTI_MARKET_COMMAND_UNSUPPORTED', 'Commands: catalog, snapshot')
  const allowedFlags = new Set(command === 'catalog' ? ['--exchanges'] : ['--date', '--iso-week', '--out', '--exchanges', '--channels', '--concurrency', '--timeout-ms'])
  const unknownFlags = values.filter((value) => value.startsWith('--') && !allowedFlags.has(value))
  if (unknownFlags.length) fail('MULTI_MARKET_ARGUMENT_FORBIDDEN', `Unsupported arguments: ${[...new Set(unknownFlags)].join(',')}`)
  const get = (flag, fallback = null) => {
    const indexes = values.map((value, index) => value === flag ? index : -1).filter((index) => index >= 0)
    if (indexes.length > 1) fail('MULTI_MARKET_ARGUMENT_DUPLICATE', `${flag} may appear only once`)
    if (!indexes.length) return fallback
    const value = values[indexes[0] + 1]
    if (!value || value.startsWith('--')) fail('MULTI_MARKET_ARGUMENT_INVALID', `${flag} requires a value`)
    return value
  }
  if (command === 'catalog') return { command, exchanges: get('--exchanges', 'all') }
  return {
    command,
    date: get('--date'),
    isoWeek: get('--iso-week'),
    output: get('--out'),
    exchanges: get('--exchanges', 'all'),
    channels: get('--channels', 'core'),
    concurrency: Number(get('--concurrency', '4')),
    timeoutMs: Number(get('--timeout-ms', '15000'))
  }
}

async function cli(argv) {
  const args = parseArgs(argv)
  if (args.command === 'catalog') {
    process.stdout.write(`${JSON.stringify(exchangeCatalog(args), null, 2)}\n`)
    return
  }
  const snapshot = await collectAllExchangeSnapshot(args)
  const target = outputPath(args.output)
  writeJsonAtomic(target, snapshot)
  process.stdout.write(`${JSON.stringify({ ok: snapshot.status !== 'BLOCKED', status: snapshot.status, schema: snapshot.schema, exchanges: snapshot.counts, output: path.relative(ROOT, target).split(path.sep).join('/'), snapshot_hash: snapshot.snapshot_hash }, null, 2)}\n`)
  if (snapshot.status === 'BLOCKED') process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  cli(process.argv).catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 'BLOCKED', code: error.code || 'MULTI_MARKET_ERROR', message: String(error.message || error) }, null, 2)}\n`)
    process.exitCode = 1
  })
}
