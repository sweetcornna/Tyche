#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGateClient } from './gate-rest.mjs'
import { writeJsonAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = Object.freeze(['BTC', 'ETH'])

function failure(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function validateDate(date) {
  const value = String(date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw failure('MARKET_DATE_INVALID', 'date must be a real YYYY-MM-DD value')
  }
  return value
}

function validateWeek(week) {
  const value = String(week || '')
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(value)) throw failure('MARKET_WEEK_INVALID', 'iso-week must use YYYY-Www')
  return value
}

function topLevels(payload, side) {
  const rows = Array.isArray(payload?.[side]) ? payload[side] : []
  return rows.slice(0, 5).map((row) => {
    if (Array.isArray(row)) return { price: String(row[0]), quantity: String(row[1] ?? '') }
    return { price: String(row?.p ?? row?.price ?? ''), quantity: String(row?.s ?? row?.size ?? row?.amount ?? '') }
  }).filter((row) => Number(row.price) > 0)
}

function exactRow(payload, pair, fields) {
  const rows = Array.isArray(payload) ? payload : [payload]
  const row = rows.find((item) => fields.some((field) => String(item?.[field] || '').toUpperCase() === pair))
  if (!row) throw failure('MARKET_IDENTITY_UNPROVEN', `No exact market row for ${pair}`)
  return row
}

function compactSpotRule(row) {
  return {
    id: String(row.id || row.currency_pair || ''),
    base: String(row.base || ''),
    quote: String(row.quote || ''),
    trade_status: String(row.trade_status || ''),
    precision: row.precision,
    amount_precision: row.amount_precision,
    min_quote_amount: row.min_quote_amount ?? null,
    min_base_amount: row.min_base_amount ?? null,
    max_quote_amount: row.max_quote_amount ?? null,
    max_base_amount: row.max_base_amount ?? null,
    buy_start: row.buy_start ?? null,
    sell_start: row.sell_start ?? null
  }
}

function compactContractRule(row) {
  return {
    name: String(row.name || row.contract || ''),
    order_price_round: row.order_price_round ?? null,
    quanto_multiplier: row.quanto_multiplier ?? null,
    order_size_min: row.order_size_min ?? null,
    order_size_max: row.order_size_max ?? null,
    leverage_max: row.leverage_max ?? null,
    in_delisting: row.in_delisting === true,
    mark_price: row.mark_price ?? null,
    funding_rate: row.funding_rate ?? null
  }
}

function candle(row) {
  if (Array.isArray(row)) {
    return { time: Number(row[0]), volume: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]), open: Number(row[5]) }
  }
  return {
    time: Number(row?.t ?? row?.time),
    volume: Number(row?.v ?? row?.volume),
    close: Number(row?.c ?? row?.close),
    high: Number(row?.h ?? row?.high),
    low: Number(row?.l ?? row?.low),
    open: Number(row?.o ?? row?.open)
  }
}

function indicatorSummary(payload, options = {}) {
  let rows = (Array.isArray(payload) ? payload : []).map(candle)
    .filter((row) => [row.time, row.open, row.high, row.low, row.close].every(Number.isFinite) && row.close > 0 && row.high >= row.low)
    .sort((left, right) => left.time - right.time)
  const currentMsForClose = Number(options.currentMs)
  const intervalMs = Number(options.intervalSeconds) * 1000
  if (Number.isFinite(currentMsForClose) && Number.isFinite(intervalMs) && intervalMs > 0) {
    rows = rows.filter((row) => row.time * (row.time < 1e12 ? 1000 : 1) + intervalMs <= currentMsForClose)
  }
  if (rows.length < 20) throw failure('MARKET_CANDLES_INSUFFICIENT', `Expected at least 20 closed candles, received ${rows.length}`)
  const closes = rows.map((row) => row.close)
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  const sma = (count) => rows.length >= count ? average(closes.slice(-count)) : null
  const ranges = rows.slice(1).map((row, index) => Math.max(row.high - row.low, Math.abs(row.high - rows[index].close), Math.abs(row.low - rows[index].close)))
  const gains = []
  const losses = []
  for (let index = 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1]
    gains.push(Math.max(0, change))
    losses.push(Math.max(0, -change))
  }
  const avgGain = average(gains.slice(-14))
  const avgLoss = average(losses.slice(-14))
  const rsi14 = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss))
  const volumeRows = rows.filter((row) => Number.isFinite(row.volume) && row.volume >= 0)
  const volumeAverage = volumeRows.length >= 20 ? average(volumeRows.slice(-20).map((row) => row.volume)) : null
  const last = rows.at(-1)
  const latestMs = last.time * (last.time < 1e12 ? 1000 : 1)
  const currentMs = Number(options.currentMs)
  const maxLagSeconds = Number(options.maxLagSeconds)
  if (!Number.isFinite(latestMs) || (Number.isFinite(currentMs) && latestMs > currentMs + 60000)) throw failure('MARKET_CANDLES_FROM_FUTURE', 'Latest candle timestamp is in the future')
  if (Number.isFinite(currentMs) && Number.isFinite(maxLagSeconds) && currentMs - latestMs > maxLagSeconds * 1000) throw failure('MARKET_CANDLES_STALE', 'Latest candle is outside the allowed lag window')
  const high20 = Math.max(...rows.slice(-20).map((row) => row.high))
  const low20 = Math.min(...rows.slice(-20).map((row) => row.low))
  const summary = {
    bars: rows.length,
    through: new Date(latestMs).toISOString(),
    last_close: last.close,
    sma20: sma(20),
    sma50: sma(50),
    sma200: sma(200),
    atr14: average(ranges.slice(-14)),
    rsi14,
    high20,
    low20,
    volume_ratio_20: volumeAverage && Number.isFinite(last.volume) ? last.volume / volumeAverage : null
  }
  const spanAbove = Math.max(0, high20 - Number(summary.sma20 || last.close))
  const spanBelow = Math.max(0, Number(summary.sma20 || last.close) - low20)
  summary.level_sets = {
    long_breakout: spanAbove > 0 ? { entry: high20, stop: summary.sma20, target: high20 + 2 * spanAbove } : null,
    long_range: summary.sma20 > low20 && high20 > summary.sma20 ? { entry: summary.sma20, stop: low20, target: high20 } : null,
    short_breakdown: spanBelow > 0 && low20 - 2 * spanBelow > 0 ? { entry: low20, stop: summary.sma20, target: low20 - 2 * spanBelow } : null,
    short_range: summary.sma20 < high20 && low20 < summary.sma20 ? { entry: summary.sma20, stop: high20, target: low20 } : null
  }
  return summary
}

export async function collectMarketSnapshot(options = {}) {
  const date = validateDate(options.date)
  const isoWeek = validateWeek(options.isoWeek)
  const now = options.now ?? Date.now
  const generatedAt = new Date(typeof now === 'function' ? now() : now).toISOString()
  const spot = options.spotClient || createGateClient({ product: 'spot', environment: 'public', readOnly: true, fetchImpl: options.fetchImpl, now })
  const usdm = options.usdmClient || createGateClient({ product: 'usdm', environment: 'public', readOnly: true, fetchImpl: options.fetchImpl, now })
  const assets = {}

  await Promise.all(ASSETS.map(async (asset) => {
    const pair = `${asset}_USDT`
    const [spotRule, spotTicker, spotBook, spotDaily, spotFourHour, contractRule, contractTicker, contractBook, contractDaily, contractFourHour, funding] = await Promise.all([
      spot.spotPair({ currency_pair: pair }),
      spot.spotTickers({ currency_pair: pair }),
      spot.spotOrderBook({ currency_pair: pair, limit: 5, with_id: true }),
      spot.spotCandlesticks({ currency_pair: pair, interval: '1d', limit: 365 }),
      spot.spotCandlesticks({ currency_pair: pair, interval: '4h', limit: 180 }),
      usdm.usdmContract({ contract: pair }),
      usdm.usdmTickers({ contract: pair }),
      usdm.usdmOrderBook({ contract: pair, limit: 5, with_id: true }),
      usdm.usdmCandlesticks({ contract: pair, interval: '1d', limit: 365 }),
      usdm.usdmCandlesticks({ contract: pair, interval: '4h', limit: 180 }),
      usdm.usdmFundingRate({ contract: pair, limit: 20 })
    ])
    const tickerSpot = exactRow(spotTicker.data, pair, ['currency_pair', 'id'])
    const tickerUsdm = exactRow(contractTicker.data, pair, ['contract', 'name'])
    const ruleUsdm = exactRow(contractRule.data, pair, ['name', 'contract'])
    assets[asset] = {
      symbol: pair,
      spot: {
        rule: compactSpotRule(spotRule.data),
        ticker: {
          last: tickerSpot.last ?? null,
          highest_bid: tickerSpot.highest_bid ?? null,
          lowest_ask: tickerSpot.lowest_ask ?? null,
          base_volume: tickerSpot.base_volume ?? null,
          quote_volume: tickerSpot.quote_volume ?? null,
          change_percentage: tickerSpot.change_percentage ?? null
        },
        order_book: { bids: topLevels(spotBook.data, 'bids'), asks: topLevels(spotBook.data, 'asks') },
        technical: { daily: indicatorSummary(spotDaily.data, { currentMs: Date.parse(generatedAt), maxLagSeconds: 172800, intervalSeconds: 86400 }), four_hour: indicatorSummary(spotFourHour.data, { currentMs: Date.parse(generatedAt), maxLagSeconds: 28800, intervalSeconds: 14400 }) }
      },
      usdm: {
        rule: compactContractRule(ruleUsdm),
        ticker: {
          last: tickerUsdm.last ?? null,
          mark_price: tickerUsdm.mark_price ?? null,
          index_price: tickerUsdm.index_price ?? null,
          funding_rate: tickerUsdm.funding_rate ?? null,
          funding_rate_indicative: tickerUsdm.funding_rate_indicative ?? null,
          total_size: tickerUsdm.total_size ?? null,
          volume_24h_base: tickerUsdm.volume_24h_base ?? null,
          volume_24h_quote: tickerUsdm.volume_24h_quote ?? null
        },
        order_book: { bids: topLevels(contractBook.data, 'bids'), asks: topLevels(contractBook.data, 'asks') },
        technical: { daily: indicatorSummary(contractDaily.data, { currentMs: Date.parse(generatedAt), maxLagSeconds: 172800, intervalSeconds: 86400 }), four_hour: indicatorSummary(contractFourHour.data, { currentMs: Date.parse(generatedAt), maxLagSeconds: 28800, intervalSeconds: 14400 }) },
        funding_history: Array.isArray(funding.data) ? funding.data.slice(0, 20).map((row) => ({ t: row.t ?? null, r: row.r ?? null })) : []
      }
    }
  }))

  return {
    schema: 'tyche_crypto_market/v1',
    date,
    iso_week: isoWeek,
    generated_at: generatedAt,
    source: 'Gate public API v4',
    assets: Object.fromEntries(ASSETS.map((asset) => [asset, assets[asset]]))
  }
}

function outputPath(input) {
  const raw = String(input || '')
  const absolute = path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw))
  const dataRoot = path.join(ROOT, 'data')
  const relative = path.relative(dataRoot, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !absolute.endsWith('.json')) {
    throw failure('MARKET_OUTPUT_INVALID', 'Market snapshot output must be a JSON file under data/')
  }
  return absolute
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const command = values[0]
  const get = (flag) => {
    const index = values.indexOf(flag)
    if (index < 0 || !values[index + 1] || values[index + 1].startsWith('--')) throw failure('MARKET_ARGS_INVALID', `${flag} is required`)
    return values[index + 1]
  }
  if (command !== 'snapshot') throw failure('MARKET_COMMAND_UNSUPPORTED', 'Supported command: snapshot')
  return { date: get('--date'), isoWeek: get('--iso-week'), output: get('--out') }
}

async function cli(argv) {
  const args = parseArgs(argv)
  const snapshot = await collectMarketSnapshot(args)
  const target = outputPath(args.output)
  writeJsonAtomic(target, snapshot)
  process.stdout.write(`${JSON.stringify({ ok: true, schema: snapshot.schema, date: snapshot.date, iso_week: snapshot.iso_week, output: path.relative(ROOT, target).split(path.sep).join('/') }, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  cli(process.argv).catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'MARKET_ERROR', message: String(error.message || error) }, null, 2)}\n`)
    process.exitCode = 1
  })
}
