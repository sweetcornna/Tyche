#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { executionConfigForVenue as mapExecutionConfig, loadConfig, validateConfig } from './config.mjs'
import { readJsonStrict, updateJsonLocked, writeJsonAtomic, writeTextAtomic } from './lib-iolock.mjs'
import {
  applyFundingPolicy,
  buildAccountEpochs,
  decimalAbs,
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  decimalPositive,
  decimalSubtract,
  divideToStep,
  fundingProjection,
  dailyUsage,
  managedQuantities,
  normalizeSpotFunding,
  normalizeUsdmFunding,
  normalizeUsdmPositionReadiness,
  quantizeDown,
  reservationEntries,
  quantizeUp,
  ratioAtLeast
} from './gate-account-context.mjs'
import { createGateClient, isAmbiguousSubmit, isDefinitiveOrderNotFound } from './gate-rest.mjs'
import { renderConciseReport, reportFromExecution } from './concise-report.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER_PATH = path.join(ROOT, 'data', 'gate_order_ledger.json')
const PLAN_SCHEMA = 'tyche_gate_plan/v1'
const LEDGER_SCHEMA = 'tyche_gate_ledger/v1'
const CANDIDATE_SCHEMA = 'crypto_execution_candidate/v1'
const DAILY_SCHEMA = 'tyche_crypto_daily/v1'
const WEEKLY_SCHEMA = 'tyche_weekly_strategy/v1'
const PAIRS = new Set(['BTC_USDT', 'ETH_USDT'])
const ASSET_BY_PAIR = Object.freeze({ BTC_USDT: 'BTC', ETH_USDT: 'ETH' })
const BOT_TEXT = /^t-TY[EP][0-9a-f]{20,24}$/
const SHA256 = /^[0-9a-f]{64}$/
const SECRET_KEY = /(?:api.?key|secret|token|password|credential|signature|authorization|cookie|private.?key|raw.?account)/i
export const AUTOMATIC_TESTNET_AUTHORIZATION = 'TYCHE_AUTOMATIC_TESTNET_V1'
const CANDIDATE_KEYS = new Set([
  'schema', 'asset', 'product', 'symbol', 'position_intent', 'order_style', 'entry_price', 'stop_price',
  'take_profit_price', 'reduce_fraction_bps', 'data_as_of', 'anchor_week', 'anchor_fresh',
  'thesis_invalidation', 'evidence_refs', 'signal_id'
])
const ENTRY_ACTIONS = new Set(['ENTER_LONG', 'ENTER_SHORT'])
const REDUCTION_ACTIONS = new Set(['REDUCE_LONG', 'REDUCE_SHORT', 'EXIT_LONG', 'EXIT_SHORT'])
const EMPTY_LEDGER = Object.freeze({ schema: LEDGER_SCHEMA, plans: [], events: [], fills: [], reconciliations: [] })

const TRANSITIONS = Object.freeze({
  PLANNED: new Set(['SUBMISSION_RESERVED', 'BLOCKED']),
  SUBMISSION_RESERVED: new Set(['SUBMITTED', 'SUBMISSION_AMBIGUOUS', 'RESERVATION_RELEASED', 'REJECTED', 'RECONCILE_RED']),
  RESERVATION_RELEASED: new Set(['SUBMISSION_RESERVED']),
  SUBMISSION_AMBIGUOUS: new Set(['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'RECONCILE_RED']),
  SUBMITTED: new Set(['PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED', 'RECONCILE_RED']),
  PARTIALLY_FILLED: new Set(['FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'PROTECTION_PENDING', 'RECONCILE_RED']),
  CANCEL_REQUESTED: new Set(['CANCELLED', 'PARTIALLY_FILLED', 'FILLED', 'RECONCILE_RED']),
  FILLED: new Set(['PROTECTION_PENDING', 'PROTECTED', 'RECONCILE_RED']),
  CANCELLED: new Set(['PROTECTION_PENDING', 'PROTECTED', 'RECONCILE_RED']),
  PROTECTION_PENDING: new Set(['PROTECTED', 'RECONCILE_RED']),
  PROTECTED: new Set(['RECONCILE_RED']),
  REJECTED: new Set(['RECONCILE_RED']),
  BLOCKED: new Set([]),
  RECONCILE_RED: new Set([])
})

export class TradeError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'TradeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function throwCode(code, message, details) {
  throw new TradeError(code, message, details)
}

function blocked(code, message, details = undefined) {
  return { ok: false, code, message: message || code, ...(details === undefined ? {} : { details }) }
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function nowMs(value = Date.now) {
  return typeof value === 'function' ? Number(value()) : Number(value)
}

function nowIso(value = Date.now) {
  return new Date(nowMs(value)).toISOString()
}

function isoWeek(value = Date.now()) {
  const source = new Date(typeof value === 'function' ? value() : value)
  if (!Number.isFinite(source.getTime())) return null
  const day = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()))
  const weekday = (day.getUTCDay() + 6) % 7
  day.setUTCDate(day.getUTCDate() - weekday + 3)
  const first = new Date(Date.UTC(day.getUTCFullYear(), 0, 4))
  const firstWeekday = (first.getUTCDay() + 6) % 7
  first.setUTCDate(first.getUTCDate() - firstWeekday + 3)
  const week = 1 + Math.round((day - first) / 604800000)
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function validDate(value) {
  const text = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const parsed = new Date(`${text}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
}

function validWeek(value) {
  return /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(String(value || ''))
}

function safeText(value, limit = 500) {
  return String(value ?? '')
    .replace(/([?&](?:api_?key|secret(?:_?key)?|sign(?:ature)?|token)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\b(?:KEY|SIGN|Authorization)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, limit)
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === 'string') return safeText(value, 1000)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  const output = Array.isArray(value) ? [] : {}
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue
    output[key] = sanitize(child, seen)
  }
  return output
}

export function stableStringify(value) {
  const active = new Set()
  const encode = (item, inArray = false) => {
    if (item === null) return 'null'
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throwCode('CANONICAL_NUMBER_INVALID', 'Canonical JSON rejects non-finite numbers')
      return Object.is(item, -0) ? '0' : JSON.stringify(item)
    }
    if (typeof item === 'undefined') {
      if (inArray) return 'null'
      throwCode('CANONICAL_UNDEFINED', 'Canonical objects cannot contain undefined')
    }
    if (typeof item !== 'object' || typeof item === 'bigint') throwCode('CANONICAL_TYPE_INVALID', `Unsupported canonical type: ${typeof item}`)
    if (active.has(item)) throwCode('CANONICAL_CYCLE', 'Canonical JSON cannot contain cycles')
    active.add(item)
    let output
    if (Array.isArray(item)) {
      output = `[${item.map((child) => encode(child, true)).join(',')}]`
    } else {
      const entries = Object.keys(item).sort().filter((key) => item[key] !== undefined).map((key) => `${JSON.stringify(key)}:${encode(item[key])}`)
      output = `{${entries.join(',')}}`
    }
    active.delete(item)
    return output
  }
  return encode(value)
}

export function sha256Hex(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value), 'utf8').digest('hex')
}

function exactPair(value) {
  const pair = upper(value).replace(/[\/-]/g, '_').replace(/^(BTC|ETH)USDT$/, '$1_USDT')
  return PAIRS.has(pair) ? pair : null
}

function positiveDecimal(value, label) {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) || !decimalPositive(text)) return blocked('DECIMAL_POSITIVE_REQUIRED', `${label} must be a positive plain decimal`)
  return { ok: true, value: text }
}

function nonNegativeDecimal(value) {
  const text = String(value ?? '').trim()
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ? text : null
}

function timestampFresh(value, current, maxAgeSeconds, exactDay = false) {
  const parsed = Date.parse(String(value || ''))
  if (!Number.isFinite(parsed)) return blocked('SOURCE_TIME_INVALID', 'A valid ISO timestamp is required')
  const age = (current - parsed) / 1000
  if (age < -60) return blocked('SOURCE_FROM_FUTURE', 'Source timestamp is in the future')
  if (age > Number(maxAgeSeconds)) return blocked('SOURCE_STALE', `Source is ${Math.floor(age)} seconds old`)
  if (exactDay && new Date(parsed).toISOString().slice(0, 10) !== new Date(current).toISOString().slice(0, 10)) return blocked('SOURCE_DAY_STALE', 'Source is not from the requested UTC day')
  return { ok: true, age_seconds: Math.max(0, age) }
}

function weeklyAnchorStatus(anchor, options = {}) {
  const week = String(options.isoWeek || '')
  const current = nowMs(options.now ?? Date.now)
  const maxAgeSeconds = Number(options.maxAgeDays ?? 8) * 86400
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return { ok: false, code: 'WEEKLY_ANCHOR_MISSING' }
  if (anchor.schema !== WEEKLY_SCHEMA || anchor.status !== 'active' || anchor.iso_week !== week) return { ok: false, code: 'WEEKLY_ANCHOR_INVALID' }
  if (!Array.isArray(anchor.execution_candidates) || anchor.execution_candidates.length !== 0) return { ok: false, code: 'WEEKLY_ANCHOR_EXECUTION_INVALID' }
  if (!anchor.assets || !anchor.assets.BTC || !anchor.assets.ETH) return { ok: false, code: 'WEEKLY_ANCHOR_ASSETS_INCOMPLETE' }
  for (const asset of ['BTC', 'ETH']) {
    if (!['long', 'neutral', 'reduce'].includes(anchor.assets[asset].spot_bias) || !['long', 'short', 'neutral', 'reduce'].includes(anchor.assets[asset].usdm_bias)) return { ok: false, code: 'WEEKLY_ANCHOR_BIAS_INVALID' }
  }
  const fresh = timestampFresh(anchor.generated_at, current, maxAgeSeconds)
  return fresh.ok ? { ok: true } : { ok: false, code: 'WEEKLY_ANCHOR_STALE' }
}

export function validateExecutionSource(source = {}, options = {}) {
  const product = String(options.product || '').toLowerCase()
  if (!['spot', 'usdm'].includes(product)) return blocked('SOURCE_PRODUCT_UNSUPPORTED', 'Product must be spot or usdm')
  const current = nowMs(options.now ?? Date.now)
  const date = String(options.date || new Date(current).toISOString().slice(0, 10))
  const week = String(options.isoWeek || isoWeek(current))
  const maxAge = Number(options.maxAgeSeconds ?? 900)
  if (!validDate(date) || !validWeek(week)) return blocked('SOURCE_REQUEST_ANCHOR_INVALID', 'Planning requires a valid date and ISO week')
  if (!source || typeof source !== 'object' || Array.isArray(source)) return blocked('SOURCE_SCHEMA_INVALID', 'Execution source must be an object')
  if (source.schema === WEEKLY_SCHEMA) {
    if (!Array.isArray(source.execution_candidates) || source.execution_candidates.length !== 0) return blocked('WEEKLY_EXECUTION_FORBIDDEN', 'Weekly output must have zero execution candidates')
    return blocked('WEEKLY_EXECUTION_FORBIDDEN', 'Weekly strategy is an anchor and cannot be planned for execution')
  }
  if (source.schema !== DAILY_SCHEMA) return blocked('SOURCE_SCHEMA_INVALID', `Daily source schema must be ${DAILY_SCHEMA}`)
  if (source.date !== date || source.iso_week !== week) return blocked('SOURCE_DATE_WEEK_MISMATCH', 'Daily source date and week must match the requested anchors')
  const freshness = timestampFresh(source.generated_at, current, maxAge, true)
  if (!freshness.ok) return freshness
  if (!Array.isArray(source.execution_candidates)) return blocked('SOURCE_CANDIDATES_INVALID', 'execution_candidates must be an array')
  if (source.execution_candidates.length > 8) return blocked('SOURCE_CANDIDATE_CAP', 'A daily source may contain at most eight semantic candidates')
  const anchorProof = weeklyAnchorStatus(options.weeklyAnchor, { isoWeek: week, now: current, maxAgeDays: options.weeklyAnchorMaxAgeDays })
  const anchorStale = !anchorProof.ok || source.anchor_fresh !== true || source.anchored_week !== week
  const accepted = []
  const rejected = []
  for (const [index, candidate] of source.execution_candidates.entries()) {
    if (String(candidate?.product || '').toLowerCase() !== product) continue
    const action = upper(candidate?.position_intent)
    if (anchorStale && !REDUCTION_ACTIONS.has(action)) {
      rejected.push({ index, code: 'ANCHOR_STALE_ENTRY_BLOCKED', symbol: candidate?.symbol || null })
      continue
    }
    accepted.push(candidate)
  }
  return { ok: true, date, iso_week: week, anchor_stale: anchorStale, anchor_proof: anchorProof, candidates: accepted, rejected }
}

function marketSnapshotStatus(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.schema !== 'tyche_crypto_market/v1') return blocked('MARKET_SNAPSHOT_MISSING', 'A canonical market snapshot is required')
  if (snapshot.date !== options.date || snapshot.iso_week !== options.isoWeek) return blocked('MARKET_SNAPSHOT_ANCHOR_MISMATCH', 'Market snapshot date/week does not match the plan')
  const fresh = timestampFresh(snapshot.generated_at, nowMs(options.now ?? Date.now), Number(options.maxAgeSeconds ?? 900))
  if (!fresh.ok) return blocked('MARKET_SNAPSHOT_STALE', fresh.message)
  if (!snapshot.assets?.BTC || !snapshot.assets?.ETH) return blocked('MARKET_SNAPSHOT_INCOMPLETE', 'Market snapshot must contain BTC and ETH')
  return { ok: true }
}

function marketPriceProof(candidate, product, snapshot, options = {}) {
  const status = marketSnapshotStatus(snapshot, options)
  if (!status.ok) return status
  if (candidate.data_as_of !== snapshot.generated_at) return blocked('CANDIDATE_MARKET_TIME_MISMATCH', 'Candidate data_as_of must equal the canonical market snapshot time')
  const asset = snapshot.assets?.[candidate.asset]
  const productBlock = asset?.[product]
  if (!productBlock) return blocked('CANDIDATE_MARKET_SCOPE_MISSING', 'Candidate product data is missing from the market snapshot')
  const action = upper(candidate.position_intent)
  const reducing = REDUCTION_ACTIONS.has(action)
  const levels = []
  for (const timeframe of ['daily', 'four_hour']) {
    const sets = productBlock.technical?.[timeframe]?.level_sets || {}
    for (const [name, set] of Object.entries(sets)) if (set && typeof set === 'object') levels.push({ ref: `assets.${candidate.asset}.${product}.technical.${timeframe}.level_sets.${name}`, set })
  }
  const equal = (left, right) => {
    try { return decimalCompare(String(left), String(right)) === 0 } catch { return false }
  }
  if (reducing) {
    const direct = [productBlock.ticker?.last, productBlock.ticker?.mark_price, productBlock.ticker?.index_price].filter((value) => value !== null && value !== undefined)
    if (direct.some((value) => equal(candidate.entry_price, value))) return { ok: true, market_level_ref: `assets.${candidate.asset}.${product}.ticker` }
    const match = levels.find(({ set }) => equal(candidate.entry_price, set.entry))
    return match ? { ok: true, market_level_ref: match.ref } : blocked('CANDIDATE_PRICE_UNPROVEN', 'Reduction limit is not present in the current market snapshot')
  }
  const match = levels.find(({ set }) => equal(candidate.entry_price, set.entry) && equal(candidate.stop_price, set.stop) && equal(candidate.take_profit_price, set.target))
  return match ? { ok: true, market_level_ref: match.ref } : blocked('CANDIDATE_LEVEL_SET_UNPROVEN', 'Entry, stop, and target must match one complete deterministic level set')
}

function weeklyDirectionProof(candidate, anchor) {
  if (!ENTRY_ACTIONS.has(upper(candidate.position_intent)) || !anchor) return { ok: true, anchor_direction_ref: null }
  const row = anchor.assets?.[candidate.asset]
  const field = candidate.product === 'spot' ? 'spot_bias' : 'usdm_bias'
  const expected = upper(candidate.position_intent) === 'ENTER_SHORT' ? 'short' : 'long'
  if (!row || row[field] !== expected) return blocked('WEEKLY_DIRECTION_MISMATCH', `Weekly ${candidate.asset} ${field} does not authorize ${expected} entry`)
  return { ok: true, anchor_direction_ref: `assets.${candidate.asset}.${field}` }
}

export function validateCandidate(candidate = {}, options = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return blocked('CANDIDATE_INVALID', 'Candidate must be an object')
  const extra = Object.keys(candidate).filter((key) => !CANDIDATE_KEYS.has(key))
  if (extra.length) return blocked('AGENT_FIELD_FORBIDDEN', `Candidate contains script-owned or unsupported fields: ${extra.join(', ')}`, { fields: extra })
  if (candidate.schema !== CANDIDATE_SCHEMA) return blocked('CANDIDATE_SCHEMA_INVALID', `Candidate schema must be ${CANDIDATE_SCHEMA}`)
  const product = String(options.product || candidate.product || '').toLowerCase()
  if (!['spot', 'usdm'].includes(product) || candidate.product !== product) return blocked('CANDIDATE_PRODUCT_INVALID', 'Candidate product identity is invalid')
  const pair = exactPair(candidate.symbol)
  if (!pair || candidate.asset !== ASSET_BY_PAIR[pair]) return blocked('CANDIDATE_SYMBOL_INVALID', 'Candidate asset and symbol must identify BTC_USDT or ETH_USDT exactly')
  if (upper(candidate.order_style || 'LIMIT') !== 'LIMIT') return blocked('ORDER_STYLE_UNSUPPORTED', 'Only semantic LIMIT candidates are supported')
  const action = upper(candidate.position_intent)
  const allowed = product === 'spot'
    ? new Set(['ENTER_LONG', 'REDUCE_LONG', 'EXIT_LONG', 'NO_TRADE'])
    : new Set(['ENTER_LONG', 'ENTER_SHORT', 'REDUCE_LONG', 'REDUCE_SHORT', 'EXIT_LONG', 'EXIT_SHORT', 'NO_TRADE'])
  if (!allowed.has(action)) {
    if (product === 'spot' && action.includes('SHORT')) return blocked('SPOT_SHORT_FORBIDDEN', 'Spot short entry and short-position management are unsupported')
    return blocked('CANDIDATE_ACTION_INVALID', `Unsupported ${product} intent: ${action || '(missing)'}`)
  }
  if (!validWeek(candidate.anchor_week)) return blocked('CANDIDATE_WEEK_INVALID', 'Candidate anchor_week must use YYYY-Www')
  if (!Number.isFinite(Date.parse(String(candidate.data_as_of || '')))) return blocked('CANDIDATE_TIME_INVALID', 'Candidate data_as_of must be an ISO timestamp')
  const freshness = timestampFresh(candidate.data_as_of, nowMs(options.now ?? Date.now), Number(options.maxAgeSeconds ?? 900))
  if (!freshness.ok) return blocked('CANDIDATE_STALE', freshness.message)
  const reducing = REDUCTION_ACTIONS.has(action)
  if (candidate.anchor_fresh !== true && !reducing && action !== 'NO_TRADE') return blocked('CANDIDATE_ANCHOR_STALE', 'Only managed reduction or exit is allowed with a stale anchor')
  if (candidate.anchor_fresh === true && candidate.anchor_week !== options.isoWeek) return blocked('CANDIDATE_ANCHOR_MISMATCH', 'Fresh candidate anchor does not match the requested week')
  if (candidate.evidence_refs !== undefined && (!Array.isArray(candidate.evidence_refs) || candidate.evidence_refs.some((item) => typeof item !== 'string' || !item.trim()))) return blocked('CANDIDATE_EVIDENCE_INVALID', 'evidence_refs must contain non-empty strings')
  if (candidate.signal_id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(candidate.signal_id))) return blocked('CANDIDATE_SIGNAL_ID_INVALID', 'signal_id has an unsupported format')
  if (action === 'NO_TRADE') return { ok: true, product, pair, symbol: pair, asset: candidate.asset, action, no_trade: true, candidate }
  const directionProof = weeklyDirectionProof(candidate, options.weeklyAnchor)
  if (!directionProof.ok) return directionProof

  const entryCheck = positiveDecimal(candidate.entry_price, 'entry_price')
  if (!entryCheck.ok) return entryCheck
  const entry = entryCheck.value
  if (reducing) {
    const defaultBps = action.startsWith('EXIT_') ? 10000 : null
    const bps = candidate.reduce_fraction_bps ?? defaultBps
    if (!Number.isInteger(Number(bps)) || Number(bps) <= 0 || Number(bps) > 10000) return blocked('REDUCTION_FRACTION_INVALID', 'Reduction requires integer reduce_fraction_bps in (0,10000]')
    const market = marketPriceProof(candidate, product, options.marketSnapshot, options)
    if (!market.ok) return market
    return { ok: true, product, pair, symbol: pair, asset: candidate.asset, action, reducing: true, entry_price: entry, reduction_bps: Number(bps), market_level_ref: market.market_level_ref, candidate }
  }

  const stopCheck = positiveDecimal(candidate.stop_price, 'stop_price')
  const targetCheck = positiveDecimal(candidate.take_profit_price, 'take_profit_price')
  if (!stopCheck.ok) return stopCheck
  if (!targetCheck.ok) return targetCheck
  const stop = stopCheck.value
  const target = targetCheck.value
  const direction = action === 'ENTER_SHORT' ? 'short' : 'long'
  const geometry = direction === 'long'
    ? decimalCompare(stop, entry) < 0 && decimalCompare(entry, target) < 0
    : decimalCompare(target, entry) < 0 && decimalCompare(entry, stop) < 0
  if (!geometry) return blocked('GEOMETRY_INVALID', `${direction} entry, stop, and target geometry is invalid`)
  const risk = direction === 'long' ? decimalSubtract(entry, stop) : decimalSubtract(stop, entry)
  const reward = direction === 'long' ? decimalSubtract(target, entry) : decimalSubtract(entry, target)
  const minimum = String(options.minimumRR ?? 1.5)
  if (!ratioAtLeast(reward, risk, minimum)) return blocked('RR_BELOW_MINIMUM', `Candidate R:R is below ${minimum}`)
  const market = marketPriceProof(candidate, product, options.marketSnapshot, options)
  if (!market.ok) return market
  return { ok: true, product, pair, symbol: pair, asset: candidate.asset, action, direction, entry_price: entry, stop_price: stop, target_price: target, market_level_ref: market.market_level_ref, anchor_direction_ref: directionProof.anchor_direction_ref, candidate }
}

function precisionStep(value) {
  const precision = Number(value)
  if (!Number.isInteger(precision) || precision < 0 || precision > 30) return null
  return precision === 0 ? '1' : `0.${'0'.repeat(precision - 1)}1`
}

export function parseSpotRule(input = {}) {
  const pair = exactPair(input.id || input.currency_pair || input.symbol)
  const rule = {
    product: 'spot',
    symbol: pair,
    base: upper(input.base),
    quote: upper(input.quote),
    trade_status: String(input.trade_status || '').toLowerCase(),
    tick_size: precisionStep(input.precision),
    step_size: precisionStep(input.amount_precision),
    min_quantity: input.min_base_amount === undefined ? null : String(input.min_base_amount),
    max_quantity: input.max_base_amount === undefined ? null : String(input.max_base_amount),
    min_notional: input.min_quote_amount === undefined ? null : String(input.min_quote_amount),
    max_notional: input.max_quote_amount === undefined ? null : String(input.max_quote_amount),
    buy_start: Number(input.buy_start || 0),
    sell_start: Number(input.sell_start || 0),
    fetched_at: input._fetched_at || input.fetched_at || null
  }
  const required = [rule.symbol, rule.tick_size, rule.step_size, rule.min_notional]
  if (required.some((value) => !value) || rule.base !== ASSET_BY_PAIR[pair] || rule.quote !== 'USDT') return blocked('SPOT_RULE_INVALID', 'Spot rule identity or precision is incomplete')
  if (![rule.tick_size, rule.step_size, rule.min_notional].every(decimalPositive)) return blocked('SPOT_RULE_INVALID', 'Spot rule contains non-positive precision or minimum notional')
  return { ok: true, ...rule }
}

export function parseUsdmRule(input = {}) {
  const pair = exactPair(input.name || input.contract || input.symbol)
  const rule = {
    product: 'usdm',
    symbol: pair,
    tick_size: input.order_price_round === undefined ? null : String(input.order_price_round),
    quanto_multiplier: input.quanto_multiplier === undefined ? null : String(input.quanto_multiplier),
    min_contracts: String(input.order_size_min ?? '1'),
    max_contracts: input.order_size_max === undefined ? null : String(input.order_size_max),
    min_notional: input.min_notional === undefined ? null : String(input.min_notional),
    max_leverage: input.leverage_max === undefined ? null : String(input.leverage_max),
    maintenance_rate: input.maintenance_rate === undefined ? null : String(input.maintenance_rate),
    maker_fee_rate: input.maker_fee_rate === undefined ? null : String(input.maker_fee_rate),
    taker_fee_rate: input.taker_fee_rate === undefined ? null : String(input.taker_fee_rate),
    funding_interval: input.funding_interval === undefined ? null : Number(input.funding_interval),
    funding_next_apply: input.funding_next_apply === undefined ? null : Number(input.funding_next_apply),
    trade_status: input.status === undefined || input.status === null ? null : String(input.status).toLowerCase(),
    circuit_breaker: input.enable_circuit_breaker === true,
    delisting: input.in_delisting === true,
    fetched_at: input._fetched_at || input.fetched_at || null
  }
  if (!rule.symbol || !decimalPositive(rule.tick_size) || !decimalPositive(rule.quanto_multiplier) || !decimalPositive(rule.min_contracts) || rule.delisting || rule.circuit_breaker || rule.trade_status !== 'trading') {
    const code = rule.delisting ? 'USDM_CONTRACT_DELISTING' : rule.circuit_breaker ? 'USDM_CONTRACT_CIRCUIT_BREAKER' : rule.trade_status !== 'trading' ? 'USDM_CONTRACT_NOT_TRADING' : 'USDM_RULE_INVALID'
    return blocked(code, 'USDT-M contract rule is incomplete or unavailable')
  }
  return { ok: true, ...rule }
}

function candidateSignal(candidate, index) {
  return String(candidate?.signal_id || `candidate:${index}`)
}

function candidateRank(candidate, snapshot) {
  const action = upper(candidate.position_intent)
  const long = action === 'ENTER_LONG'
  const entry = Number(candidate.entry_price)
  const stop = Number(candidate.stop_price)
  const target = Number(candidate.take_profit_price)
  const risk = long ? entry - stop : stop - entry
  const reward = long ? target - entry : entry - target
  const rr = risk > 0 ? reward / risk : -Infinity
  const markRaw = snapshot?.assets?.[candidate.asset]?.usdm?.ticker?.mark_price ?? snapshot?.assets?.[candidate.asset]?.usdm?.ticker?.last
  const mark = Number(markRaw)
  const distance = mark > 0 && entry > 0 ? Math.abs(entry - mark) / mark : Infinity
  return { rr, distance }
}

function selectionContext(options = {}) {
  if (options.managedQuantities) return Object.fromEntries([...PAIRS].map((pair) => [pair, String(options.managedQuantities[pair] || '0')]))
  const accounts = options.context?.accounts || {}
  return Object.fromEntries([...PAIRS].map((pair) => [pair, String(accounts[`usdm:${pair}`]?.managed_quantity || '0')]))
}

export function selectUsdmCandidates(candidates = [], options = {}) {
  const rows = []
  const rejected = []
  const signalCounts = new Map(candidates.map((candidate, index) => [candidateSignal(candidate, index), 0]))
  for (const [index, candidate] of candidates.entries()) {
    const signal = candidateSignal(candidate, index)
    signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1)
  }
  const rawDirections = new Map()
  for (const candidate of candidates) {
    const pair = exactPair(candidate?.symbol)
    const action = upper(candidate?.position_intent)
    if (!pair || !['ENTER_LONG', 'ENTER_SHORT'].includes(action)) continue
    if (!rawDirections.has(pair)) rawDirections.set(pair, new Set())
    rawDirections.get(pair).add(action)
  }
  const conflictedPairs = new Set([...rawDirections.entries()].filter(([, directions]) => directions.size > 1).map(([pair]) => pair))
  const managed = selectionContext(options)
  const controls = {
    entry_block_code: options.controls?.entry_block_code || null,
    max_spread_bps: options.controls?.max_spread_bps ?? null,
    max_entry_distance_bps: options.controls?.max_entry_distance_bps ?? null
  }
  for (const [index, candidate] of candidates.entries()) {
    const valid = validateCandidate(candidate, options)
    const signal = candidateSignal(candidate, index)
    const rawPair = exactPair(candidate?.symbol)
    const rawAction = upper(candidate?.position_intent)
    if (rawPair && conflictedPairs.has(rawPair) && ['ENTER_LONG', 'ENTER_SHORT'].includes(rawAction)) {
      rejected.push({ index, symbol: rawPair, signal_id: signal, code: 'SIGNAL_DIRECTION_CONFLICT' })
      continue
    }
    if ((signalCounts.get(signal) || 0) > 1) {
      rejected.push({ index, symbol: rawPair, signal_id: signal, code: 'DUPLICATE_SIGNAL_ID' })
      continue
    }
    if (!valid.ok) {
      rejected.push({ index, symbol: candidate?.symbol || null, signal_id: signal, code: valid.code, message: valid.message })
      continue
    }
    if (valid.no_trade) {
      rejected.push({ index, symbol: valid.symbol, signal_id: signal, code: 'NO_TRADE' })
      continue
    }
    rows.push({ index, candidate, valid, signal, rank: valid.reducing ? null : candidateRank(candidate, options.marketSnapshot) })
  }

  const reductions = []
  const entries = []
  for (const pair of [...PAIRS].sort()) {
    const scoped = rows.filter((row) => row.valid.symbol === pair)
    const reducing = scoped.filter((row) => row.valid.reducing).sort((left, right) => {
      const exitLeft = left.valid.action.startsWith('EXIT_') ? 0 : 1
      const exitRight = right.valid.action.startsWith('EXIT_') ? 0 : 1
      return exitLeft - exitRight || Number(right.valid.reduction_bps) - Number(left.valid.reduction_bps) || left.signal.localeCompare(right.signal)
    })
    for (const row of [...reducing]) {
      let quantitySign = 0
      try { quantitySign = decimalCompare(managed[pair], '0') } catch {}
      const expectsLong = ['REDUCE_LONG', 'EXIT_LONG'].includes(row.valid.action)
      if ((quantitySign > 0 && !expectsLong) || (quantitySign < 0 && expectsLong) || quantitySign === 0) {
        reducing.splice(reducing.indexOf(row), 1)
        rejected.push({ index: row.index, symbol: pair, signal_id: row.signal, code: quantity === 0 ? 'MANAGED_QUANTITY_UNAVAILABLE' : 'MANAGED_DIRECTION_MISMATCH' })
      }
    }
    if (reducing.length) {
      reductions.push(reducing[0])
      for (const row of reducing.slice(1)) rejected.push({ index: row.index, symbol: pair, signal_id: row.signal, code: 'REDUCTION_SUPERSEDED' })
      for (const row of scoped.filter((candidate) => !candidate.valid.reducing)) rejected.push({ index: row.index, symbol: pair, signal_id: row.signal, code: 'SAME_CYCLE_REVERSAL_FORBIDDEN' })
      continue
    }
    const opening = scoped.filter((row) => !row.valid.reducing)
    const directions = new Set(opening.map((row) => row.valid.direction))
    if (directions.size > 1) {
      for (const row of opening) rejected.push({ index: row.index, symbol: pair, signal_id: row.signal, code: 'SIGNAL_DIRECTION_CONFLICT' })
      continue
    }
    if (decimalPositive(decimalAbs(managed[pair]))) {
      for (const row of opening) rejected.push({ index: row.index, symbol: pair, signal_id: row.signal, code: 'POSITION_ALREADY_MANAGED' })
      continue
    }
    if (controls.entry_block_code) {
      for (const row of opening) rejected.push({ index: row.index, symbol: pair, signal_id: row.signal, code: controls.entry_block_code })
      continue
    }
    const ticker = options.marketSnapshot?.assets?.[ASSET_BY_PAIR[pair]]?.usdm?.ticker || {}
    const book = options.marketSnapshot?.assets?.[ASSET_BY_PAIR[pair]]?.usdm?.order_book || {}
    const bid = Number(ticker.highest_bid ?? ticker.bid ?? book.bids?.[0]?.price)
    const ask = Number(ticker.lowest_ask ?? ticker.ask ?? book.asks?.[0]?.price)
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : NaN
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10000 : Infinity
    const eligible = opening.filter((row) => {
      if (controls.max_spread_bps !== null && !(spreadBps <= Number(controls.max_spread_bps))) {
        rejected.push({ index: row.index, symbol: pair, signal_id: row.signal, code: 'SPREAD_LIMIT' })
        return false
      }
      if (controls.max_entry_distance_bps !== null && !(row.rank.distance * 10000 <= Number(controls.max_entry_distance_bps))) {
        rejected.push({ index: row.index, symbol: pair, signal_id: row.signal, code: 'ENTRY_DISTANCE_LIMIT' })
        return false
      }
      return true
    })
    eligible.sort((left, right) => right.rank.rr - left.rank.rr || left.rank.distance - right.rank.distance || left.signal.localeCompare(right.signal))
    if (eligible.length) entries.push(eligible[0])
    for (const row of eligible.slice(1)) rejected.push({ index: row.index, symbol: pair, signal_id: row.signal, code: 'ENTRY_SUPERSEDED' })
  }
  entries.sort((left, right) => right.rank.rr - left.rank.rr || left.rank.distance - right.rank.distance || left.valid.symbol.localeCompare(right.valid.symbol) || left.signal.localeCompare(right.signal))
  reductions.sort((left, right) => {
    const exitLeft = left.valid.action.startsWith('EXIT_') ? 0 : 1
    const exitRight = right.valid.action.startsWith('EXIT_') ? 0 : 1
    return exitLeft - exitRight || left.valid.symbol.localeCompare(right.valid.symbol) || left.signal.localeCompare(right.signal)
  })
  const selected = [...reductions, ...entries]
  const body = {
    policy: 'tyche_usdm_selection/v1',
    managed_quantities: managed,
    controls,
    selected: selected.map((row) => ({ index: row.index, symbol: row.valid.symbol, action: row.valid.action, signal_id: row.signal })),
    rejected: rejected.map((row) => ({ index: row.index, symbol: row.symbol || null, signal_id: row.signal_id, code: row.code }))
  }
  return { selected, rejected, proof: { ...body, digest: sha256Hex(body) } }
}

function quoteFromRows(payload, pair, product, generatedAt) {
  const rows = Array.isArray(payload) ? payload : [payload]
  const row = rows.find((item) => exactPair(item?.currency_pair || item?.contract || item?.name || item?.id) === pair)
  if (!row) return blocked('QUOTE_IDENTITY_UNPROVEN', `No exact ${product} quote for ${pair}`)
  const bid = String(row.highest_bid ?? row.bid ?? '')
  const ask = String(row.lowest_ask ?? row.ask ?? '')
  const last = String(row.last ?? row.mark_price ?? row.index_price ?? '')
  const price = decimalPositive(last) ? last : decimalPositive(bid) && decimalPositive(ask) ? decimalMultiply(decimalAdd(bid, ask), '0.5') : null
  if (!price) return blocked('QUOTE_PRICE_UNAVAILABLE', `${pair} has no positive quote price`)
  if (bid && ask && decimalPositive(bid) && decimalPositive(ask) && decimalCompare(bid, ask) > 0) return blocked('QUOTE_BOOK_CROSSED', `${pair} bid exceeds ask`)
  return { ok: true, product, symbol: pair, price, bid: decimalPositive(bid) ? bid : null, ask: decimalPositive(ask) ? ask : null, fetched_at: generatedAt }
}

function proofFresh(proof, current, maxAge, code) {
  const result = timestampFresh(proof?.fetched_at || proof?.generated_at, current, maxAge)
  return result.ok ? result : blocked(code, result.message)
}

function minDecimal(values) {
  const valid = values.filter((value) => value !== null && value !== undefined && decimalPositive(value))
  if (!valid.length) return null
  return valid.reduce((left, right) => decimalCompare(left, right) <= 0 ? left : right)
}

function capsReady(config) {
  const names = ['risk_per_trade_bps', 'max_order_notional_usdt', 'daily_new_notional_cap_usdt', 'max_managed_notional_usdt']
  return names.every((name) => decimalPositive(config[name]))
}

function riskPolicy(productConfig, rootConfig = null) {
  return {
    product: {
      enabled: productConfig.enabled,
      environment: productConfig.environment,
      risk_per_trade_bps: productConfig.risk_per_trade_bps,
      max_order_notional_usdt: productConfig.max_order_notional_usdt,
      daily_new_notional_cap_usdt: productConfig.daily_new_notional_cap_usdt,
      max_managed_notional_usdt: productConfig.max_managed_notional_usdt,
      configured_leverage: productConfig.configured_leverage ?? null,
      max_leverage: productConfig.max_leverage ?? null,
      position_mode: productConfig.position_mode ?? null,
      margin_type: productConfig.margin_type ?? null,
      risk_capital_fraction_bps: productConfig.risk_capital_fraction_bps,
      balance_buffer_bps: productConfig.balance_buffer_bps
    },
    controls: rootConfig ? {
      gate_enabled: rootConfig.gate.enabled,
      submission_mode: rootConfig.gate.submission_mode,
      plan_ttl_seconds: rootConfig.gate.plan_ttl_seconds,
      quote_max_age_seconds: rootConfig.gate.quote_max_age_seconds,
      account_max_age_seconds: rootConfig.gate.account_max_age_seconds,
      rules_max_age_seconds: rootConfig.gate.rules_max_age_seconds,
      reconciliation_max_age_seconds: rootConfig.gate.reconciliation_max_age_seconds,
      entry_watch_seconds: rootConfig.gate.entry_watch_seconds,
      poll_interval_ms: rootConfig.gate.poll_interval_ms,
      weekly_anchor_max_age_days: rootConfig.analysis.weekly_anchor_max_age_days,
      candidate_max_age_seconds: rootConfig.analysis.candidate_max_age_seconds,
      minimum_rr: rootConfig.analysis.minimum_rr
    } : null
  }
}

function priceForSide(value, step, side) {
  return side === 'BUY' ? quantizeDown(value, step) : quantizeUp(value, step)
}

function triggerPrice(value, step, direction, kind) {
  if (direction === 'long') return kind === 'stop' ? quantizeUp(value, step) : quantizeDown(value, step)
  return kind === 'stop' ? quantizeDown(value, step) : quantizeUp(value, step)
}

export function buildOrderText(seed = {}, role = 'entry') {
  const tag = role === 'stop' || role === 'target' ? 'P' : 'E'
  const text = `t-TY${tag}${sha256Hex({ ...seed, role }).slice(0, 22)}`
  if (!BOT_TEXT.test(text)) throwCode('ORDER_TEXT_INVALID', 'Generated Gate text violates the Tyche identity format')
  return text
}

function entrySizing(valid, productConfig, rule, account) {
  if (!capsReady(productConfig)) return blocked('EXECUTION_LIMITS_UNSET', 'Positive user-defined risk and notional limits are required for deterministic sizing')
  if (account?.schema !== 'tyche_account_epoch/v1') return blocked('ACCOUNT_EPOCH_REQUIRED', 'A fresh product-local account epoch is required')
  if (!decimalPositive(account.effective_risk_capital) || !decimalPositive(account.available_quote)) return blocked('ACCOUNT_CAPITAL_UNAVAILABLE', 'Account-derived capital is unavailable')
  const riskDistance = decimalAbs(decimalSubtract(valid.entry_price, valid.stop_price))
  if (!decimalPositive(riskDistance)) return blocked('STOP_DISTANCE_INVALID', 'Stop distance must be positive')
  const riskBudget = decimalMultiply(account.effective_risk_capital, decimalMultiply(String(productConfig.risk_per_trade_bps), '0.0001'))
  const dailyRoom = decimalSubtract(String(productConfig.daily_new_notional_cap_usdt), String(account.daily_new_notional_used || '0'))
  const managedRoom = decimalSubtract(String(productConfig.max_managed_notional_usdt), String(account.managed_notional || '0'))
  if (!decimalPositive(dailyRoom)) return blocked('DAILY_NOTIONAL_LIMIT', 'Daily new-notional limit has no remaining room')
  if (!decimalPositive(managedRoom)) return blocked('MANAGED_NOTIONAL_LIMIT', 'Managed-notional limit has no remaining room')
  const leverage = valid.product === 'usdm' ? String(productConfig.configured_leverage) : '1'
  const step = valid.product === 'usdm' ? rule.quanto_multiplier : rule.step_size
  const takerFeeRate = valid.product === 'usdm' ? nonNegativeDecimal(rule.taker_fee_rate) : '0'
  if (valid.product === 'usdm' && takerFeeRate === null) return blocked('FEE_RATE_UNAVAILABLE', 'USDT-M taker fee rate is required for fee-aware sizing')
  const capitalCostPerBase = valid.product === 'usdm'
    ? decimalMultiply(valid.entry_price, decimalAdd(divideToStep('1', leverage, '0.000000000000000001'), decimalMultiply(takerFeeRate, '2')))
    : valid.entry_price
  const candidates = [
    divideToStep(riskBudget, riskDistance, step),
    divideToStep(String(productConfig.max_order_notional_usdt), valid.entry_price, step),
    divideToStep(dailyRoom, valid.entry_price, step),
    divideToStep(managedRoom, valid.entry_price, step),
    divideToStep(account.available_quote, capitalCostPerBase, step)
  ]
  const baseQuantity = minDecimal(candidates)
  if (!baseQuantity || !decimalPositive(baseQuantity)) return blocked('QUANTITY_ROUNDS_TO_ZERO', 'All risk limits round quantity to zero')
  const notional = decimalMultiply(baseQuantity, valid.entry_price)
  if (valid.product === 'spot') {
    if (rule.min_quantity && decimalCompare(baseQuantity, rule.min_quantity) < 0) return blocked('MINIMUM_QUANTITY', 'Spot quantity is below the venue minimum')
    if (rule.max_quantity && decimalPositive(rule.max_quantity) && decimalCompare(baseQuantity, rule.max_quantity) > 0) return blocked('MAXIMUM_QUANTITY', 'Spot quantity exceeds the venue maximum')
    if (rule.min_notional && decimalCompare(notional, rule.min_notional) < 0) return blocked('MINIMUM_NOTIONAL', 'Spot notional is below the venue minimum')
    if (rule.max_notional && decimalPositive(rule.max_notional) && decimalCompare(notional, rule.max_notional) > 0) return blocked('MAXIMUM_NOTIONAL', 'Spot notional exceeds the venue maximum')
    return { ok: true, quantity: baseQuantity, base_quantity: baseQuantity, estimated_notional: notional, risk_budget: riskBudget }
  }
  const contractText = divideToStep(baseQuantity, rule.quanto_multiplier, '1')
  if (!/^\d+$/.test(contractText) || !decimalPositive(contractText)) return blocked('CONTRACTS_ROUND_TO_ZERO', 'USDT-M contract count rounds to zero')
  if (!Number.isSafeInteger(Number(contractText))) return blocked('CONTRACT_COUNT_UNSAFE', 'USDT-M contract count exceeds the exact integer range')
  if (decimalCompare(contractText, rule.min_contracts) < 0) return blocked('MINIMUM_CONTRACTS', 'Contract count is below the venue minimum')
  if (rule.max_contracts && decimalPositive(rule.max_contracts) && decimalCompare(contractText, rule.max_contracts) > 0) return blocked('MAXIMUM_CONTRACTS', 'Contract count exceeds the venue maximum')
  const estimatedNotional = decimalMultiply(decimalMultiply(contractText, rule.quanto_multiplier), valid.entry_price)
  if (rule.min_notional && decimalPositive(rule.min_notional) && decimalCompare(estimatedNotional, rule.min_notional) < 0) return blocked('MINIMUM_NOTIONAL', 'USDT-M notional is below the venue minimum')
  const estimatedOpenFee = decimalMultiply(estimatedNotional, takerFeeRate)
  const estimatedCloseFee = decimalMultiply(estimatedNotional, takerFeeRate)
  return { ok: true, quantity: contractText, base_quantity: decimalMultiply(contractText, rule.quanto_multiplier), estimated_notional: estimatedNotional, risk_budget: riskBudget, estimated_open_fee: estimatedOpenFee, estimated_close_fee: estimatedCloseFee, margin_debit: decimalAdd(divideToStep(estimatedNotional, leverage, '0.00000001'), decimalAdd(estimatedOpenFee, estimatedCloseFee)) }
}

function reductionSizing(valid, rule, account) {
  if (account?.schema !== 'tyche_account_epoch/v1') return blocked('ACCOUNT_EPOCH_REQUIRED', 'A fresh product-local account epoch is required')
  const managed = decimalAbs(account.managed_quantity || '0')
  if (!decimalPositive(managed)) return blocked('MANAGED_QUANTITY_UNAVAILABLE', 'No Tyche-managed quantity is available for reduction')
  const raw = decimalMultiply(managed, decimalMultiply(String(valid.reduction_bps), '0.0001'))
  const step = valid.product === 'usdm' ? '1' : rule.step_size
  const quantity = quantizeDown(raw, step)
  if (!decimalPositive(quantity)) return blocked('QUANTITY_ROUNDS_TO_ZERO', 'Reduction quantity rounds to zero')
  const baseQuantity = valid.product === 'usdm' ? decimalMultiply(quantity, rule.quanto_multiplier) : quantity
  return { ok: true, quantity, base_quantity: baseQuantity, estimated_notional: decimalMultiply(baseQuantity, valid.entry_price) }
}

function dualExpressionConflict(candidate, product, ledger) {
  if (!ENTRY_ACTIONS.has(upper(candidate.position_intent)) || !candidate.signal_id) return null
  for (const plan of ledger.plans || []) {
    if (plan.product === product) continue
    for (const intent of plan.intents || []) {
      if (intent.role === 'ENTRY' && intent.signal_id === candidate.signal_id) return { product: plan.product, plan_id: plan.plan_id }
    }
  }
  return null
}

function buildIntent(valid, options) {
  const { config, rule, account, environment, sourceDate, sourceWeek, venue = 'gate' } = options
  const sizing = valid.reducing ? reductionSizing(valid, rule, account) : entrySizing(valid, config, rule, account)
  if (!sizing.ok) return sizing
  const entry = !valid.reducing
  const longExposure = valid.action === 'ENTER_LONG' || ['REDUCE_LONG', 'EXIT_LONG'].includes(valid.action)
  const side = entry ? (valid.direction === 'short' ? 'SELL' : 'BUY') : (longExposure ? 'SELL' : 'BUY')
  const price = priceForSide(valid.entry_price, rule.tick_size, side)
  const seed = {
    venue,
    product: valid.product,
    environment,
    symbol: valid.symbol,
    action: valid.action,
    price,
    quantity: sizing.quantity,
    source_date: sourceDate,
    source_week: sourceWeek,
    signal_id: valid.candidate.signal_id || null
  }
  const identity = buildOrderText(seed, entry ? 'entry' : 'reduction')
  const intent = {
    intent_id: identity,
    product: valid.product,
    environment,
    symbol: valid.symbol,
    asset: valid.asset,
    action: valid.action,
    role: entry ? 'ENTRY' : 'REDUCTION',
    signal_id: valid.candidate.signal_id || null,
    market_level_ref: valid.market_level_ref,
    anchor_direction_ref: valid.anchor_direction_ref || null,
    side,
    order_type: 'limit',
    price,
    quantity: sizing.quantity,
    base_quantity: sizing.base_quantity,
    estimated_notional: sizing.estimated_notional,
    text: identity,
    account_epoch_id: account.account_epoch_id,
    sizing_context: {
      available_quote: account.available_quote,
      effective_risk_capital: account.effective_risk_capital,
      managed_quantity: account.managed_quantity || '0',
      managed_notional: account.managed_notional || '0',
      daily_new_notional_used: account.daily_new_notional_used || '0'
    },
    rule_digest: sha256Hex(rule)
  }
  if (valid.product === 'usdm') {
    const contracts = Number(sizing.quantity)
    if (!Number.isSafeInteger(contracts) || contracts <= 0) return blocked('CONTRACT_COUNT_UNSAFE', 'USDT-M contract count is not an exact positive integer')
    const sign = side === 'BUY' ? 1 : -1
    intent.size = sign * contracts
    intent.reduce_only = !entry
    if (entry) {
      intent.estimated_open_fee = sizing.estimated_open_fee
      intent.estimated_close_fee = sizing.estimated_close_fee
      intent.margin_debit = sizing.margin_debit
      intent.protection = {
        required: true,
        stop_price: triggerPrice(valid.stop_price, rule.tick_size, valid.direction, 'stop'),
        target_price: triggerPrice(valid.target_price, rule.tick_size, valid.direction, 'target'),
        direction: valid.direction,
        quantity_source: 'IDENTIFIABLE_EXCHANGE_FILLS'
      }
    }
  }
  return { ok: true, intent }
}

function canonicalPlanBody(plan, current, ttlSeconds) {
  const copy = clone(plan)
  delete copy.plan_id
  delete copy.plan_hash
  delete copy.sealed
  delete copy.created_at
  delete copy.expires_at
  delete copy.ttl_seconds
  if (!Number.isFinite(current) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throwCode('PLAN_TIME_INVALID', 'Plan sealing clock and configured lifetime must be valid')
  const createdAt = new Date(current).toISOString()
  const expiresAt = new Date(current + ttlSeconds * 1000).toISOString()
  return { schema: PLAN_SCHEMA, ...copy, created_at: createdAt, expires_at: expiresAt, ttl_seconds: ttlSeconds, sealed: true }
}

export function sealPlan(plan = {}, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'ttlSeconds')) throwCode('PLAN_SEAL_OPTION_FORBIDDEN', 'Plan lifetime comes only from validated configuration')
  const config = options.config
  validateConfig(config)
  const current = nowMs(options.now ?? Date.now)
  const ttl = Number(config.gate.plan_ttl_seconds)
  const body = canonicalPlanBody(plan, current, ttl)
  const seed = sha256Hex(body)
  const withId = { ...body, plan_id: `tp-${body.created_at.slice(0, 10).replace(/-/g, '')}-${seed.slice(0, 12)}` }
  return deepFreeze({ ...withId, plan_hash: sha256Hex(withId) })
}

export function verifyPlan(plan = {}, expected = {}) {
  if (!plan || plan.schema !== PLAN_SCHEMA || plan.sealed !== true) return blocked('PLAN_SCHEMA_INVALID', 'Plan is not a sealed Tyche plan')
  const copy = clone(plan)
  const claimed = copy.plan_hash
  delete copy.plan_hash
  const actual = sha256Hex(copy)
  if (!SHA256.test(String(claimed || '')) || claimed !== actual) return blocked('PLAN_HASH_MISMATCH', 'Plan changed after sealing')
  if (expected.planId && expected.planId !== plan.plan_id) return blocked('PLAN_ID_MISMATCH', 'Supplied plan ID does not match the sealed plan')
  if (expected.planHash && expected.planHash !== plan.plan_hash) return blocked('PLAN_HASH_CONFIRMATION_MISMATCH', 'Supplied plan hash does not match')
  const created = Date.parse(String(plan.created_at || ''))
  const expires = Date.parse(String(plan.expires_at || ''))
  const ttl = Number(plan.ttl_seconds)
  if (!Number.isFinite(created) || !Number.isFinite(expires) || new Date(created).toISOString() !== plan.created_at || new Date(expires).toISOString() !== plan.expires_at || !Number.isSafeInteger(ttl) || ttl <= 0 || expires - created !== ttl * 1000) {
    return blocked('PLAN_TIME_INVALID', 'Plan timestamps do not encode the exact sealed lifetime')
  }
  if (expected.planTtlSeconds !== undefined && ttl !== Number(expected.planTtlSeconds)) return blocked('PLAN_TTL_MISMATCH', 'Sealed plan lifetime differs from current configuration')
  const current = nowMs(expected.now ?? Date.now)
  if (!expected.skipCurrentTime && !Number.isFinite(current)) return blocked('PLAN_TIME_INVALID', 'Execution clock is invalid')
  if (!expected.skipCurrentTime && created > current) return blocked('PLAN_CREATED_IN_FUTURE', `Plan was created at ${plan.created_at}`)
  if (!expected.skipCurrentTime && !expected.allowExpired && expires <= current) return blocked('PLAN_EXPIRED', `Plan expired at ${plan.expires_at}`)
  const ids = (plan.intents || []).map((intent) => intent.intent_id)
  if (ids.some((id) => !BOT_TEXT.test(String(id))) || new Set(ids).size !== ids.length) return blocked('PLAN_INTENT_ID_INVALID', 'Plan intent identities are invalid or duplicated')
  return { ok: true, plan_id: plan.plan_id, plan_hash: plan.plan_hash }
}

function freshContextProofs(plan, config, current) {
  for (const intent of plan.intents || []) {
    const proof = plan.proofs?.[intent.symbol]
    if (!proof) return blocked('PLAN_PROOF_MISSING', `Plan lacks proofs for ${intent.symbol}`)
    for (const [name, maxAge] of [['rule', config.gate.rules_max_age_seconds], ['quote', config.gate.quote_max_age_seconds], ['account', config.gate.account_max_age_seconds]]) {
      const result = proofFresh(proof[name], current, maxAge, `PLAN_${name.toUpperCase()}_STALE`)
      if (!result.ok) return result
    }
  }
  if (plan.product === 'usdm') {
    if (plan.reconciliation?.status !== 'ok') return blocked('PLAN_RECONCILIATION_NOT_GREEN', 'Plan lacks green reconciliation proof')
    const fresh = timestampFresh(plan.reconciliation.generated_at, current, config.gate.reconciliation_max_age_seconds)
    if (!fresh.ok) return blocked('PLAN_RECONCILIATION_STALE', fresh.message)
  }
  return { ok: true }
}

function verifyPlanDerivation(plan, source, options = {}) {
  const config = options.config
  if (!source || source.schema !== DAILY_SCHEMA || !plan.daily_source_proof || plan.daily_source_proof.digest !== sha256Hex(source) || plan.daily_source_proof.generated_at !== source.generated_at) return blocked('DAILY_SOURCE_DRIFT', 'Canonical daily source differs from the one sealed into the plan')
  const sourceCheck = validateExecutionSource(source, {
    product: plan.product,
    date: plan.source?.date,
    isoWeek: plan.source?.iso_week,
    now: options.now,
    maxAgeSeconds: config.analysis.candidate_max_age_seconds,
    weeklyAnchor: options.weeklyAnchor,
    weeklyAnchorMaxAgeDays: config.analysis.weekly_anchor_max_age_days
  })
  if (!sourceCheck.ok) return sourceCheck
  let derivationCandidates = sourceCheck.candidates
  if (plan.product === 'usdm') {
    const claimed = plan.selection_proof
    if (!claimed || claimed.policy !== 'tyche_usdm_selection/v1' || !claimed.digest) return blocked('PLAN_SELECTION_PROOF_MISSING', 'USDT-M plan lacks a deterministic selection proof')
    const body = clone(claimed)
    delete body.digest
    if (claimed.digest !== sha256Hex(body)) return blocked('PLAN_SELECTION_PROOF_INVALID', 'USDT-M selection proof digest is invalid')
    const selection = selectUsdmCandidates(sourceCheck.candidates, {
      product: plan.product,
      isoWeek: plan.source?.iso_week,
      date: plan.source?.date,
      now: options.now,
      maxAgeSeconds: config.analysis.candidate_max_age_seconds,
      minimumRR: config.analysis.minimum_rr,
      marketSnapshot: options.marketSnapshot,
      weeklyAnchor: options.weeklyAnchor,
      managedQuantities: claimed.managed_quantities,
      controls: claimed.controls
    })
    if (stableStringify(selection.proof) !== stableStringify(claimed)) return blocked('PLAN_SELECTION_DRIFT', 'USDT-M candidate selection differs from the sealed proof')
    derivationCandidates = selection.selected.map((row) => row.candidate)
  }
  const used = new Set()
  let projectedDailyUsed = null
  let projectedManaged = null
  let projectedAvailable = null
  const projectedManagedQuantity = new Map()
  for (const actual of plan.intents) {
    const proof = plan.proofs?.[actual.symbol]
    if (!proof?.rule || !proof?.account || !actual.sizing_context) return blocked('PLAN_DERIVATION_PROOF_MISSING', `Intent ${actual.intent_id} lacks sizing proof`)
    if (projectedDailyUsed === null) projectedDailyUsed = String(proof.account.daily_new_notional_used || '0')
    if (projectedManaged === null) projectedManaged = String(proof.account.managed_notional || '0')
    if (projectedAvailable === null) projectedAvailable = String(proof.account.available_quote || '0')
    if (!projectedManagedQuantity.has(actual.symbol)) projectedManagedQuantity.set(actual.symbol, String(proof.account.managed_quantity || '0'))
    const account = { ...proof.account, daily_new_notional_used: projectedDailyUsed, managed_notional: projectedManaged, available_quote: projectedAvailable, managed_quantity: projectedManagedQuantity.get(actual.symbol) }
    let matched = null
    for (const [index, candidate] of derivationCandidates.entries()) {
      if (used.has(index)) continue
      const valid = validateCandidate(candidate, {
        product: plan.product,
        isoWeek: plan.source?.iso_week,
        date: plan.source?.date,
        now: options.now,
        maxAgeSeconds: config.analysis.candidate_max_age_seconds,
        minimumRR: config.analysis.minimum_rr,
        marketSnapshot: options.marketSnapshot,
        weeklyAnchor: options.weeklyAnchor
      })
      if (!valid.ok || valid.no_trade || valid.symbol !== actual.symbol || valid.action !== actual.action) continue
      const rebuilt = buildIntent(valid, {
        config: config.gate[plan.product],
        rule: proof.rule,
        account,
        environment: plan.environment,
        venue: plan.venue || 'gate',
        sourceDate: plan.source?.date,
        sourceWeek: plan.source?.iso_week
      })
      if (rebuilt.ok && stableStringify(rebuilt.intent) === stableStringify(actual)) {
        used.add(index)
        matched = rebuilt.intent
        break
      }
    }
    if (!matched) return blocked('PLAN_DERIVATION_MISMATCH', `Intent ${actual.intent_id} cannot be re-derived from the canonical daily source`)
    if (matched.role === 'ENTRY') {
      projectedDailyUsed = decimalAdd(projectedDailyUsed, matched.estimated_notional)
      projectedManaged = decimalAdd(projectedManaged, matched.estimated_notional)
      const marginUse = plan.product === 'usdm'
        ? matched.margin_debit
        : matched.estimated_notional
      projectedAvailable = decimalSubtract(projectedAvailable, marginUse)
    } else if (matched.role === 'REDUCTION') {
      const currentQuantity = projectedManagedQuantity.get(matched.symbol)
      projectedManagedQuantity.set(matched.symbol, ['REDUCE_LONG', 'EXIT_LONG'].includes(matched.action) ? decimalSubtract(currentQuantity, matched.quantity) : decimalAdd(currentQuantity, matched.quantity))
      const remaining = decimalSubtract(projectedManaged, matched.estimated_notional)
      projectedManaged = decimalCompare(remaining, '0') > 0 ? remaining : '0'
    }
  }
  return { ok: true }
}

export function createPlan(source = {}, options = {}) {
  const venue = String(options.venue || 'gate').trim().toLowerCase()
  const suppliedConfig = options.config
  validateConfig(suppliedConfig)
  const config = venue === 'binance' ? mapExecutionConfig(suppliedConfig, venue) : suppliedConfig
  const product = String(options.product || '').toLowerCase()
  const productConfig = config.gate[product]
  const environment = String(options.environment || productConfig?.environment || '').toLowerCase()
  const current = nowMs(options.now ?? Date.now)
  const sourceCheck = validateExecutionSource(source, {
    product,
    date: options.date,
    isoWeek: options.isoWeek,
    now: current,
    maxAgeSeconds: config.analysis.candidate_max_age_seconds,
    weeklyAnchor: options.weeklyAnchor,
    weeklyAnchorMaxAgeDays: config.analysis.weekly_anchor_max_age_days
  })
  const blockers = [...(options.context?.blockers || [])]
  if (!['gate', 'binance'].includes(venue)) blockers.push({ code: 'VENUE_UNSUPPORTED', message: 'Venue must be gate or binance' })
  const skipped = sourceCheck.ok ? [...sourceCheck.rejected] : []
  const intents = []
  let selection = null
  let planningCandidates = sourceCheck.ok ? sourceCheck.candidates : []
  if (sourceCheck.ok && product === 'usdm') {
    selection = selectUsdmCandidates(sourceCheck.candidates, {
      product,
      isoWeek: sourceCheck.iso_week,
      date: sourceCheck.date,
      now: current,
      maxAgeSeconds: config.analysis.candidate_max_age_seconds,
      minimumRR: config.analysis.minimum_rr,
      marketSnapshot: options.marketSnapshot,
      weeklyAnchor: options.weeklyAnchor,
      context: options.context,
      controls: options.selectionControls
    })
    planningCandidates = selection.selected.map((row) => row.candidate)
    skipped.push(...selection.rejected)
  }
  let projectedDailyUsed = null
  let projectedManaged = null
  let projectedAvailable = null
  const projectedManagedQuantity = new Map()
  if (!sourceCheck.ok) blockers.push({ code: sourceCheck.code, message: sourceCheck.message })
  if (config.gate.enabled !== true) blockers.push({ code: 'GATE_DISABLED', message: 'Gate integration is disabled' })
  if (!productConfig || productConfig.enabled !== true) blockers.push({ code: 'PRODUCT_DISABLED', message: `${product} is disabled` })
  if (product === 'spot' && environment !== 'dry-run') blockers.push({ code: 'SPOT_ENVIRONMENT_UNSUPPORTED', message: 'Spot is dry-run only' })
  if (product === 'usdm' && !['dry-run', 'testnet'].includes(environment)) blockers.push({ code: 'USDM_ENVIRONMENT_UNSUPPORTED', message: 'USDT-M supports dry-run or testnet planning only' })
  if (!['spot', 'usdm'].includes(product)) blockers.push({ code: 'PRODUCT_UNSUPPORTED', message: 'Product must be spot or usdm' })

  if (sourceCheck.ok && !blockers.length) {
    for (const [index, candidate] of planningCandidates.entries()) {
      const valid = validateCandidate(candidate, {
        product,
        isoWeek: sourceCheck.iso_week,
        now: current,
        maxAgeSeconds: config.analysis.candidate_max_age_seconds,
        minimumRR: config.analysis.minimum_rr,
        marketSnapshot: options.marketSnapshot,
        weeklyAnchor: options.weeklyAnchor,
        date: sourceCheck.date
      })
      if (!valid.ok) {
        skipped.push({ index, symbol: candidate?.symbol || null, code: valid.code, message: valid.message })
        continue
      }
      if (valid.no_trade) {
        skipped.push({ index, symbol: valid.symbol, code: 'NO_TRADE' })
        continue
      }
      const conflict = dualExpressionConflict(candidate, product, options.ledger || EMPTY_LEDGER)
      if (conflict) {
        skipped.push({ index, symbol: valid.symbol, code: 'DUAL_PRODUCT_ENTRY_FORBIDDEN', message: `Signal already has a ${conflict.product} entry plan` })
        continue
      }
      const rawRule = options.context?.rules?.[valid.symbol]
      const rule = product === 'spot' ? parseSpotRule(rawRule) : parseUsdmRule(rawRule)
      if (!rule.ok) {
        skipped.push({ index, symbol: valid.symbol, code: rule.code, message: rule.message })
        continue
      }
      const ruleFresh = proofFresh(rule, current, config.gate.rules_max_age_seconds, 'EXCHANGE_RULE_STALE')
      if (!ruleFresh.ok) {
        skipped.push({ index, symbol: valid.symbol, code: ruleFresh.code, message: ruleFresh.message })
        continue
      }
      if (product === 'spot' && (rule.trade_status !== 'tradable' || (rule.buy_start && rule.buy_start * 1000 > current) || (rule.sell_start && rule.sell_start * 1000 > current))) {
        skipped.push({ index, symbol: valid.symbol, code: 'SPOT_PAIR_NOT_TRADABLE' })
        continue
      }
      if (product === 'usdm') {
        const configured = String(productConfig.configured_leverage ?? '')
        if (!decimalPositive(configured) || (rule.max_leverage && decimalCompare(configured, rule.max_leverage) > 0)) {
          skipped.push({ index, symbol: valid.symbol, code: 'LEVERAGE_RULE_INVALID' })
          continue
        }
        if (options.context?.reconciliation?.status !== 'ok') {
          skipped.push({ index, symbol: valid.symbol, code: 'RECONCILIATION_NOT_GREEN' })
          continue
        }
      }
      const quote = options.context?.quotes?.[valid.symbol]
      const quoteFresh = proofFresh(quote, current, config.gate.quote_max_age_seconds, 'QUOTE_STALE')
      if (!quoteFresh.ok || !decimalPositive(quote?.price)) {
        skipped.push({ index, symbol: valid.symbol, code: quoteFresh.ok ? 'QUOTE_INVALID' : quoteFresh.code })
        continue
      }
      const baseAccount = options.context?.accounts?.[`${product}:${valid.symbol}`]
      const accountFresh = proofFresh(baseAccount, current, config.gate.account_max_age_seconds, 'ACCOUNT_EPOCH_STALE')
      if (!accountFresh.ok) {
        skipped.push({ index, symbol: valid.symbol, code: accountFresh.code })
        continue
      }
      if (projectedDailyUsed === null) projectedDailyUsed = String(baseAccount.daily_new_notional_used || '0')
      if (projectedManaged === null) projectedManaged = String(baseAccount.managed_notional || '0')
      if (projectedAvailable === null) projectedAvailable = String(baseAccount.available_quote || '0')
      if (!projectedManagedQuantity.has(valid.symbol)) projectedManagedQuantity.set(valid.symbol, String(baseAccount.managed_quantity || '0'))
      const account = { ...baseAccount, daily_new_notional_used: projectedDailyUsed, managed_notional: projectedManaged, available_quote: projectedAvailable, managed_quantity: projectedManagedQuantity.get(valid.symbol) }
      const built = buildIntent(valid, {
        config: productConfig,
        rule,
        account,
        environment,
        venue,
        sourceDate: sourceCheck.date,
        sourceWeek: sourceCheck.iso_week
      })
      if (!built.ok) {
        skipped.push({ index, symbol: valid.symbol, code: built.code, message: built.message })
        continue
      }
      intents.push(built.intent)
      if (built.intent.role === 'ENTRY') {
        projectedDailyUsed = decimalAdd(projectedDailyUsed, built.intent.estimated_notional)
        projectedManaged = decimalAdd(projectedManaged, built.intent.estimated_notional)
        const marginUse = product === 'usdm'
          ? built.intent.margin_debit
          : built.intent.estimated_notional
        projectedAvailable = decimalSubtract(projectedAvailable, marginUse)
      } else if (built.intent.role === 'REDUCTION') {
        const currentQuantity = projectedManagedQuantity.get(built.intent.symbol)
        projectedManagedQuantity.set(built.intent.symbol, ['REDUCE_LONG', 'EXIT_LONG'].includes(built.intent.action) ? decimalSubtract(currentQuantity, built.intent.quantity) : decimalAdd(currentQuantity, built.intent.quantity))
        const remaining = decimalSubtract(projectedManaged, built.intent.estimated_notional)
        projectedManaged = decimalCompare(remaining, '0') > 0 ? remaining : '0'
      }
    }
  }

  const candidates = sourceCheck.ok ? sourceCheck.candidates : []
  const explicitNoAction = sourceCheck.ok && sourceCheck.rejected.length === 0 && (candidates.length === 0 || candidates.every((candidate) => upper(candidate.position_intent) === 'NO_TRADE'))
  if (sourceCheck.ok && !intents.length && !explicitNoAction && !blockers.length) blockers.push({ code: 'NO_EXECUTABLE_INTENTS', message: 'No candidate survived deterministic checks' })
  const proofs = {}
  for (const intent of intents) {
    proofs[intent.symbol] = {
      rule: sanitize(product === 'spot' ? parseSpotRule(options.context.rules[intent.symbol]) : parseUsdmRule(options.context.rules[intent.symbol])),
      quote: sanitize(options.context.quotes[intent.symbol]),
      account: sanitize(options.context.accounts[`${product}:${intent.symbol}`])
    }
  }
  return sealPlan({
    venue,
    product,
    environment,
    source: { schema: source.schema || null, date: sourceCheck.date || source.date || null, iso_week: sourceCheck.iso_week || source.iso_week || null, anchor_stale: sourceCheck.anchor_stale ?? null, anchor_proof_code: sourceCheck.anchor_proof?.ok ? null : sourceCheck.anchor_proof?.code || null },
    daily_source_proof: source.schema === DAILY_SCHEMA ? { generated_at: source.generated_at || null, digest: sha256Hex(source) } : null,
    status: blockers.length ? 'BLOCKED' : explicitNoAction ? 'NO_ACTION' : 'READY',
    intents,
    blockers,
    skipped,
    selection_proof: selection?.proof || null,
    risk_policy: riskPolicy(productConfig || {}, config),
    risk_policy_digest: sha256Hex(riskPolicy(productConfig || {}, config)),
    market_snapshot_proof: options.marketSnapshot ? { generated_at: options.marketSnapshot.generated_at || null, digest: sha256Hex(options.marketSnapshot) } : null,
    weekly_anchor_proof: options.weeklyAnchor ? { iso_week: options.weeklyAnchor.iso_week || null, generated_at: options.weeklyAnchor.generated_at || null, digest: sha256Hex(options.weeklyAnchor) } : null,
    proofs,
    reconciliation: product === 'usdm' ? sanitize(options.context?.reconciliation || null) : { status: 'not_applicable' }
  }, { now: current, config })
}

function ledgerShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== LEDGER_SCHEMA) throwCode('LEDGER_SCHEMA_INVALID', 'Ledger schema is invalid')
  for (const key of ['plans', 'events', 'fills', 'reconciliations']) if (!Array.isArray(value[key])) throwCode('LEDGER_SCHEMA_INVALID', `Ledger ${key} must be an array`)
  for (const receipt of value.reconciliations) {
    if (receipt?.sealed === true || receipt?.receipt_hash || (receipt?.resolutions || []).length || (receipt?.recovered_fills || []).length) {
      const verified = verifyReconciliationReceipt(receipt)
      if (!verified.ok) throwCode(verified.code, verified.message)
    }
  }
  return value
}

export function readLedger(filePath = LEDGER_PATH) {
  return ledgerShape(readJsonStrict(filePath, { missingDefault: EMPTY_LEDGER }))
}

function allowedTransition(previous, next) {
  if (previous === next) return true
  return TRANSITIONS[previous]?.has(next) === true
}

function fillKey(fill) {
  const id = fill.id ?? fill.trade_id
  const pair = exactPair(fill.symbol || fill.contract)
  return id === undefined || id === null || id === '' || !pair ? null : `usdm:${pair}:${id}`
}

export function sealReconciliationReceipt(receipt = {}) {
  const core = clone(receipt)
  delete core.receipt_id
  delete core.receipt_hash
  delete core.sealed
  const sealedCore = { ...core, sealed: true }
  const receiptId = `tr_${sha256Hex(sealedCore).slice(0, 24)}`
  const withId = { ...sealedCore, receipt_id: receiptId }
  return deepFreeze({ ...withId, receipt_hash: sha256Hex(withId) })
}

export function verifyReconciliationReceipt(receipt = {}) {
  if (!receipt || receipt.sealed !== true || !/^tr_[0-9a-f]{24}$/.test(String(receipt.receipt_id || '')) || !SHA256.test(String(receipt.receipt_hash || ''))) {
    return blocked('RECONCILIATION_RECEIPT_UNSEALED', 'Resolution receipts must be sealed with deterministic identity and hash')
  }
  const copy = clone(receipt)
  const claimedHash = copy.receipt_hash
  delete copy.receipt_hash
  if (sha256Hex(copy) !== claimedHash) return blocked('RECONCILIATION_RECEIPT_HASH_MISMATCH', 'Reconciliation receipt changed after sealing')
  const claimedId = copy.receipt_id
  delete copy.receipt_id
  if (`tr_${sha256Hex(copy).slice(0, 24)}` !== claimedId) return blocked('RECONCILIATION_RECEIPT_ID_MISMATCH', 'Reconciliation receipt identity does not match its complete evidence')
  return { ok: true, receipt_id: claimedId, receipt_hash: claimedHash }
}

function eventIdentity(event) {
  const copy = clone(event)
  delete copy.event_id
  return `te_${sha256Hex(copy).slice(0, 24)}`
}

function validateEmergencyEventBinding(ledger, event) {
  if (event.role !== 'EMERGENCY_REDUCTION') return
  const plan = ledger.plans.find((row) => row.plan_id === event.plan_id && row.plan_hash === event.plan_hash)
  const parent = plan?.intents?.find((intent) => intent.intent_id === event.emergency_parent_intent_id && intent.role === 'ENTRY')
  const contracts = String(event.emergency_contracts || '')
  const signed = String(event.emergency_signed_contracts || '')
  if (!parent || event.symbol !== parent.symbol || !/^\d+$/.test(contracts) || !/^-?\d+$/.test(signed) || !decimalPositive(contracts) || decimalCompare(decimalAbs(signed), contracts) !== 0) {
    throwCode('EMERGENCY_EVENT_BINDING_INVALID', 'Emergency lifecycle event is not bound to an exact sealed parent quantity')
  }
  const correctSign = parent.size > 0 ? signed.startsWith('-') : !signed.startsWith('-')
  if (!correctSign) throwCode('EMERGENCY_EVENT_DIRECTION_INVALID', 'Emergency lifecycle event does not reduce its sealed parent direction')
  const expectedIdentity = buildOrderText({
    plan_id: plan.plan_id,
    parent: parent.intent_id,
    cause_id: event.emergency_cause_id,
    cause_intent_id: event.emergency_cause_intent_id,
    contracts,
    size: Number(signed)
  }, 'emergency')
  if (event.intent_id !== expectedIdentity) throwCode('EMERGENCY_EVENT_IDENTITY_INVALID', 'Emergency lifecycle identity does not match its sealed parent and cause')
  const priorReservation = [...ledger.events].reverse().find((row) => row.intent_id === event.intent_id && row.state === 'SUBMISSION_RESERVED')
  if (event.state === 'SUBMISSION_RESERVED') {
    const cause = unresolvedRedCauses(ledger).find((row) => row.cause_id === event.emergency_cause_id && row.intent_id === event.emergency_cause_intent_id)
    const childEvent = (ledger.events || []).find((row) => row.intent_id === event.emergency_cause_intent_id && row.parent_intent_id === parent.intent_id)
    if (!cause || !childEvent) throwCode('EMERGENCY_CAUSE_BINDING_INVALID', 'Emergency reservation is not caused by the exact failed protection child')
  } else if (!priorReservation || ['emergency_parent_intent_id', 'emergency_cause_id', 'emergency_cause_intent_id', 'emergency_contracts', 'emergency_signed_contracts'].some((key) => String(priorReservation[key] || '') !== String(event[key] || ''))) {
    throwCode('EMERGENCY_EVENT_RESERVATION_INVALID', 'Emergency lifecycle event does not match its atomic reservation')
  }
}

function validateEmergencyFillBinding(ledger, fill) {
  if (fill?.ledger_role !== 'EMERGENCY_REDUCTION') return
  const reservation = (ledger.events || []).find((event) => event.intent_id === fill.intent_id && event.state === 'SUBMISSION_RESERVED' && event.role === 'EMERGENCY_REDUCTION')
  const submitted = [...(ledger.events || [])].reverse().find((event) => event.intent_id === fill.intent_id && event.exchange_order_id)
  if (!reservation || !submitted || String(fill.order_id || '') !== String(submitted.exchange_order_id || '') || fill.parent_intent_id !== reservation.emergency_parent_intent_id || fill.cause_id !== reservation.emergency_cause_id || fill.cause_intent_id !== reservation.emergency_cause_intent_id || String(fill.signed_contracts || '') !== String(reservation.emergency_signed_contracts || '')) {
    throwCode('EMERGENCY_FILL_BINDING_INVALID', 'Emergency fill is not bound to its reserved parent, cause, and venue order')
  }
}

export function reduceLedger(current = EMPTY_LEDGER, record) {
  const ledger = clone(ledgerShape(current))
  if (!record) return ledger
  const kind = upper(record.kind)
  if (kind === 'PLAN') {
    const plan = record.plan
    const verified = verifyPlan(plan, { allowExpired: true, skipCurrentTime: true })
    if (!verified.ok) throwCode(verified.code, verified.message)
    const existing = ledger.plans.find((row) => row.plan_id === plan.plan_id)
    if (existing && existing.plan_hash !== plan.plan_hash) throwCode('LEDGER_PLAN_DRIFT', 'Plan ID already exists with a different hash')
    if (!existing) ledger.plans.push(sanitize(plan))
    return ledger
  }
  if (kind === 'FILL') {
    const fill = sanitize(record.fill)
    validateEmergencyFillBinding(ledger, fill)
    const key = fillKey(fill)
    const contracts = decimalAbs(fill.contracts ?? fill.size ?? '0')
    if (!key || !/^\d+$/.test(contracts) || !Number.isSafeInteger(Number(contracts)) || !decimalPositive(contracts) || !decimalPositive(fill.price)) throwCode('LEDGER_FILL_INVALID', 'Fill requires trade identity, exact integer contracts, and price')
    if (!ledger.fills.some((row) => fillKey(row) === key)) ledger.fills.push(fill)
    return ledger
  }
  if (kind === 'RECONCILIATION') {
    const receipt = sanitize(record.reconciliation)
    if (!receipt || !['ok', 'red'].includes(receipt.status) || !Number.isFinite(Date.parse(receipt.generated_at))) throwCode('LEDGER_RECONCILIATION_INVALID', 'Reconciliation receipt is invalid')
    if (Object.prototype.hasOwnProperty.call(receipt, 'clears_red_id')) throwCode('LEDGER_LEGACY_CLEAR_FORBIDDEN', 'Legacy receipt linkage cannot resolve red state')
    const verified = verifyReconciliationReceipt(receipt)
    if (!verified.ok) throwCode(verified.code, verified.message)
    const resolutions = Array.isArray(receipt.resolutions) ? receipt.resolutions : []
    const resolvedIds = Array.isArray(receipt.resolved_cause_ids) ? receipt.resolved_cause_ids : []
    const recoveredFills = Array.isArray(receipt.recovered_fills) ? receipt.recovered_fills : []
    const causeEvidence = Array.isArray(receipt.cause_evidence) ? receipt.cause_evidence : []
    if (resolvedIds.length !== resolutions.length || resolvedIds.some((id, index) => id !== resolutions[index]?.cause_id)) throwCode('LEDGER_RESOLUTION_LINK_INVALID', 'Resolved cause IDs must exactly match ordered resolution evidence')
    const causes = new Map(unresolvedRedCauses(ledger).map((cause) => [cause.cause_id, cause]))
    for (const resolution of resolutions) {
      const cause = causes.get(resolution.cause_id)
      if (!cause || !resolutionMatchesCause(resolution, cause, { ledger, recoveredFills })) throwCode('LEDGER_RESOLUTION_EVIDENCE_INVALID', 'Resolution evidence does not match an unresolved cause')
    }
    const evidencedTrades = new Set(causeEvidence.flatMap((evidence) => Array.isArray(evidence?.trade_ids) ? evidence.trade_ids.map(String) : []))
    for (const fill of recoveredFills) {
      const id = String(fill?.id ?? fill?.trade_id ?? '')
      if (!id || !evidencedTrades.has(id)) throwCode('LEDGER_RECOVERED_FILL_UNLINKED', 'Recovered fill is not linked to exact terminal identity evidence')
    }
    let next = ledger
    for (const fill of recoveredFills) next = reduceLedger(next, { kind: 'FILL', fill })
    if (!next.reconciliations.some((row) => row.receipt_id === receipt.receipt_id)) next.reconciliations.push(receipt)
    return next
  }
  if (kind !== 'EVENT') throwCode('LEDGER_RECORD_UNSUPPORTED', `Unsupported ledger record kind: ${kind}`)
  const event = sanitize(record.event)
  if (!event?.intent_id || !event.state || !BOT_TEXT.test(String(event.intent_id))) throwCode('LEDGER_EVENT_INVALID', 'Ledger event requires a Tyche intent ID and state')
  const previous = [...ledger.events].reverse().find((row) => row.intent_id === event.intent_id)?.state || 'PLANNED'
  if (!allowedTransition(previous, event.state)) throwCode('LEDGER_TRANSITION_INVALID', `${previous} -> ${event.state} is not allowed`)
  validateEmergencyEventBinding(ledger, event)
  if (!event.event_id) event.event_id = eventIdentity(event)
  if (!ledger.events.some((row) => row.event_id === event.event_id)) ledger.events.push(event)
  return ledger
}

function appendRecord(filePath, record) {
  return updateJsonLocked(filePath, (current) => reduceLedger(current, record), { missingDefault: EMPTY_LEDGER })
}

function eventFor(plan, intent, state, at, extra = {}) {
  const event = {
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    intent_id: intent.intent_id,
    product: plan.product,
    environment: plan.environment,
    symbol: intent.symbol,
    role: intent.role,
    state,
    at,
    ...extra
  }
  return { kind: 'EVENT', event: { ...event, event_id: eventIdentity(event) } }
}

function intentRecord(ledger, intentId) {
  for (const plan of ledger.plans || []) {
    const intent = (plan.intents || []).find((row) => row.intent_id === intentId)
    if (intent) return { plan, intent }
  }
  return null
}

function eventSourceId(event, type) {
  return String(event?.event_id || `te_${sha256Hex({ intent_id: event?.intent_id || null, at: event?.at || null, type }).slice(0, 24)}`)
}

function eventCause(event, type, exchangeOrderId = null) {
  const sourceEventId = eventSourceId(event, type)
  const clientOrderId = String(event.intent_id || '')
  return {
    cause_id: `rc_${sha256Hex({ source_event_id: sourceEventId, type, client_order_id: clientOrderId }).slice(0, 24)}`,
    type,
    source_event_id: sourceEventId,
    intent_id: clientOrderId,
    client_order_id: clientOrderId,
    exchange_order_id: exchangeOrderId ? String(exchangeOrderId) : null,
    generated_at: event.at || null,
    source: type === 'AMBIGUOUS_SUBMISSION' ? 'event:ambiguous' : 'event:red'
  }
}

function terminalEvidenceMatchesCause(evidence, cause) {
  if (!evidence || !['AMBIGUOUS_SUBMISSION', 'RECONCILE_EVENT'].includes(cause.type)) return false
  if (evidence.cause_id !== cause.cause_id || evidence.source_event_id !== cause.source_event_id) return false
  if (evidence.evidence_kind !== 'EXACT_TERMINAL_IDENTITY' || evidence.intent_id !== cause.intent_id || evidence.client_order_id !== cause.client_order_id) return false
  if (evidence.exact_client_text !== true || evidence.terminal !== true || evidence.unknown_state !== false) return false
  if (!['FILLED', 'CANCELLED', 'REJECTED', 'NOT_FOUND'].includes(evidence.terminal_status)) return false
  const tradeIds = Array.isArray(evidence.trade_ids) ? evidence.trade_ids.map(String) : []
  let executed = '0'
  try { executed = decimalAbs(evidence.executed_contracts || '0') } catch { return false }
  if (evidence.terminal_status === 'NOT_FOUND') {
    const misses = new Set((evidence.not_found_identities || []).map(String))
    if (evidence.definitive_not_found !== true || !misses.has(cause.client_order_id) || decimalPositive(executed) || tradeIds.length) return false
    if (cause.exchange_order_id && !misses.has(cause.exchange_order_id)) return false
    return true
  }
  if (evidence.exact_order_id !== true || !String(evidence.order_id || '')) return false
  if (cause.exchange_order_id && String(evidence.order_id) !== cause.exchange_order_id) return false
  if (evidence.terminal_status === 'FILLED' && (!decimalPositive(executed) || evidence.trades_complete !== true || tradeIds.length === 0)) return false
  if (evidence.terminal_status === 'CANCELLED' && (evidence.cancellation_proof !== true || evidence.trades_complete !== true)) return false
  if (evidence.terminal_status === 'CANCELLED' && decimalPositive(executed) && tradeIds.length === 0) return false
  if (evidence.terminal_status === 'REJECTED' && (evidence.venue_rejection !== true || decimalPositive(executed) || tradeIds.length)) return false
  return true
}

function resolutionMatchesCause(resolution, cause, context = {}) {
  if (!resolution || resolution.cause_id !== cause.cause_id || resolution.state_reconciled !== true) return false
  if (cause.type === 'RECONCILIATION_STATE') {
    return resolution.evidence_kind === 'ACCOUNT_STATE_RECONCILED'
      && resolution.source_receipt_id === cause.source_receipt_id
      && resolution.issue_fingerprint === cause.issue_fingerprint
  }
  if (!terminalEvidenceMatchesCause(resolution, cause)) return false
  const tradeIds = Array.isArray(resolution.trade_ids) ? resolution.trade_ids.map(String) : []
  if (!tradeIds.length) return true
  const available = new Set([...(context.ledger?.fills || []), ...(context.recoveredFills || [])]
    .filter((fill) => fill.intent_id === cause.intent_id)
    .map((fill) => String(fill.id ?? fill.trade_id ?? ''))
    .filter(Boolean))
  return tradeIds.every((id) => available.has(id))
}

function reconciliationIssueFingerprint(receipt) {
  const issues = (receipt.state_issues || receipt.issues || []).map((issue) => ({
    code: String(issue?.code || ''),
    symbol: issue?.symbol || null,
    order_text: issue?.order_text || null,
    fill_key: issue?.fill_key || null
  })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))
  return sha256Hex(issues)
}

export function unresolvedRedCauses(ledger = EMPTY_LEDGER) {
  ledgerShape(ledger)
  const causes = []
  const consumedRedEvents = new Set()
  const events = ledger.events || []
  for (const [index, event] of events.entries()) {
    if (event.state !== 'SUBMISSION_AMBIGUOUS') continue
    const later = events.slice(index + 1).filter((candidate) => candidate.intent_id === event.intent_id)
    const directRedMarker = later[0]?.state === 'RECONCILE_RED'
      && later[0]?.reason === 'Ambiguous submission was not resolved by exact order identity'
      ? later[0]
      : null
    if (directRedMarker?.event_id) consumedRedEvents.add(directRedMarker.event_id)
    const exchangeEvent = [...later].reverse().find((candidate) => candidate.exchange_order_id)
    causes.push(eventCause(event, 'AMBIGUOUS_SUBMISSION', exchangeEvent?.exchange_order_id || event.exchange_order_id || null))
  }
  for (const event of events) {
    if (event.state !== 'RECONCILE_RED' || consumedRedEvents.has(event.event_id)) continue
    const index = events.indexOf(event)
    const exchangeEvent = [...events.slice(0, index + 1)].reverse().find((candidate) => candidate.intent_id === event.intent_id && candidate.exchange_order_id)
    causes.push(eventCause(event, 'RECONCILE_EVENT', event.exchange_order_id || exchangeEvent?.exchange_order_id || null))
  }
  for (const receipt of ledger.reconciliations || []) {
    if (receipt.status !== 'red' || receipt.sticky_cause !== true) continue
    const fingerprint = reconciliationIssueFingerprint(receipt)
    const sourceReceiptId = String(receipt.receipt_id || `tr_legacy_${fingerprint.slice(0, 16)}`)
    causes.push({
      cause_id: `rc_${sha256Hex({ type: 'RECONCILIATION_STATE', source_receipt_id: sourceReceiptId, issue_fingerprint: fingerprint }).slice(0, 24)}`,
      type: 'RECONCILIATION_STATE',
      source_receipt_id: sourceReceiptId,
      issue_fingerprint: fingerprint,
      intent_id: null,
      client_order_id: null,
      exchange_order_id: null,
      generated_at: receipt.generated_at || null,
      source: 'reconciliation:red'
    })
  }
  const unique = new Map(causes.filter((cause) => cause.cause_id).map((cause) => [cause.cause_id, cause]))
  for (const receipt of ledger.reconciliations || []) {
    const recoveredFills = Array.isArray(receipt.recovered_fills) ? receipt.recovered_fills : []
    for (const resolution of receipt.resolutions || []) {
      const cause = unique.get(resolution?.cause_id)
      if (!cause) continue
      const causeTime = Date.parse(cause.generated_at || '')
      const receiptTime = Date.parse(receipt.generated_at || '')
      if (Number.isFinite(causeTime) && (!Number.isFinite(receiptTime) || receiptTime < causeTime)) continue
      if (resolutionMatchesCause(resolution, cause, { ledger, recoveredFills })) unique.delete(cause.cause_id)
    }
  }
  return [...unique.values()].sort((left, right) => String(left.cause_id).localeCompare(String(right.cause_id)))
}

const ACTIVE_RESERVATION_OWNERS = new Set()

function latestIntentEvent(ledger, intentId) {
  return [...(ledger.events || [])].reverse().find((event) => event.intent_id === intentId) || null
}

function newReservationOwner() {
  return { id: randomUUID(), pid: process.pid }
}

function reservationOwnerActive(event) {
  const ownerId = String(event?.reservation_owner_id || '')
  const ownerPid = Number(event?.reservation_owner_pid)
  if (ownerId && ACTIVE_RESERVATION_OWNERS.has(ownerId)) return true
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) return false
  try {
    process.kill(ownerPid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function leverageForPlan(plan, fallback = '1') {
  const configured = String(plan?.risk_policy?.product?.configured_leverage ?? fallback)
  return decimalPositive(configured) ? configured : '1'
}

function marginDebit(notional, leverage, takerFeeRate = '0') {
  const margin = divideToStep(notional, decimalPositive(leverage) ? leverage : '1', '0.00000001')
  const fee = nonNegativeDecimal(takerFeeRate) ?? '0'
  return decimalAdd(margin, decimalMultiply(decimalMultiply(notional, fee), '2'))
}

function planMarginDebit(plan, intent, notional) {
  return marginDebit(notional, leverageForPlan(plan), plan?.proofs?.[intent.symbol]?.rule?.taker_fee_rate || '0')
}

function fillNotional(match, fill) {
  if (decimalPositive(fill?.notional)) return String(fill.notional)
  const contracts = decimalAbs(fill?.contracts ?? fill?.size ?? '0')
  const price = String(fill?.price ?? '')
  const multiplier = String(match?.plan?.proofs?.[match.intent.symbol]?.rule?.quanto_multiplier || '')
  if (!decimalPositive(contracts) || !decimalPositive(price) || !decimalPositive(multiplier)) throwCode('CAPACITY_FILL_NOTIONAL_UNPROVEN', 'Ledger fill notional cannot be reconstructed from sealed venue rules')
  return decimalMultiply(decimalMultiply(contracts, multiplier), price)
}

function atomicCapacityUsage(ledger, product, limits = {}) {
  const entries = reservationEntries(ledger, product)
  const pendingNotional = entries.reduce((sum, entry) => decimalAdd(sum, entry.pending_notional), '0')
  const managedFilled = managedNotional(ledger, product, limits.quotes || {}, limits.rules || {})
  const snapshotAt = Date.parse(String(limits.accountSnapshotAt || ''))
  let unavailableMargin = '0'
  if (Number.isFinite(snapshotAt)) {
    for (const entry of entries) {
      if (!decimalPositive(entry.pending_notional)) continue
      const latestAt = Date.parse(String(entry.latest_at || entry.reservation_at || ''))
      if (entry.state === 'SUBMISSION_RESERVED' || (Number.isFinite(latestAt) && latestAt >= snapshotAt)) {
        unavailableMargin = decimalAdd(unavailableMargin, planMarginDebit(entry.plan, entry.intent, entry.pending_notional))
      }
    }
    for (const fill of ledger.fills || []) {
      const match = intentRecord(ledger, fill.intent_id)
      if (!match || match.plan.product !== product || match.intent.role !== 'ENTRY') continue
      const fillAt = Date.parse(String(fill.at || ''))
      if (!Number.isFinite(fillAt) || fillAt < snapshotAt) continue
      unavailableMargin = decimalAdd(unavailableMargin, planMarginDebit(match.plan, match.intent, fillNotional(match, fill)))
    }
  }
  return {
    daily: dailyUsage(ledger, product, limits.now),
    managed_filled_notional: managedFilled,
    pending_notional: pendingNotional,
    managed_and_pending_notional: decimalAdd(managedFilled, pendingNotional),
    unavailable_margin: unavailableMargin
  }
}

function capacityBlock(ledger, plan, intent, limits) {
  if (intent.role !== 'ENTRY') return null
  const usage = atomicCapacityUsage(ledger, plan.product, limits)
  if (decimalCompare(decimalAdd(usage.daily.daily_new_notional_used, intent.estimated_notional), String(limits.dailyCap)) > 0) {
    return { state: 'DAILY_NOTIONAL_LIMIT', code: 'DAILY_NOTIONAL_LIMIT_DRIFT' }
  }
  if (decimalCompare(decimalAdd(usage.managed_and_pending_notional, intent.estimated_notional), String(limits.managedCap)) > 0) {
    return { state: 'MANAGED_NOTIONAL_LIMIT', code: 'MANAGED_NOTIONAL_LIMIT_DRIFT' }
  }
  const newMargin = planMarginDebit(plan, intent, intent.estimated_notional)
  if (!decimalPositive(limits.availableQuote) || decimalCompare(decimalAdd(usage.unavailable_margin, newMargin), String(limits.availableQuote)) > 0) {
    return { state: 'ACCOUNT_AVAILABLE_LIMIT', code: 'ACCOUNT_AVAILABLE_LIMIT_DRIFT' }
  }
  return null
}

function redCausesAllowed(ledger, intent, limits) {
  const unresolved = unresolvedRedCauses(ledger)
  if (!unresolved.length) return true
  if (!['PROTECTION', 'EMERGENCY_REDUCTION'].includes(intent.role)) return false
  const allowed = new Set(limits.allowRedCauseIds || [])
  return unresolved.every((cause) => allowed.has(cause.cause_id))
}

function reserveInLedger(ledger, plan, intent, at, limits) {
  if (!redCausesAllowed(ledger, intent, limits)) return { ledger, state: 'STICKY_RECONCILE_RED', code: 'STICKY_RECONCILE_RED', claimed: false }
  const capacity = capacityBlock(ledger, plan, intent, limits)
  if (capacity) return { ledger, ...capacity, claimed: false }
  const attempt = (ledger.events || []).filter((event) => event.intent_id === intent.intent_id && event.state === 'SUBMISSION_RESERVED').length + 1
  const extra = {
    reservation_attempt: attempt,
    reservation_owner_id: limits.owner?.id || null,
    reservation_owner_pid: limits.owner?.pid || null,
    ...(intent.role === 'ENTRY' ? {
      reservation_notional: intent.estimated_notional,
      reservation_margin_debit: planMarginDebit(plan, intent, intent.estimated_notional),
      account_snapshot_at: limits.accountSnapshotAt || null,
      account_available_quote: limits.availableQuote || null
    } : {}),
    ...(limits.eventExtra || {})
  }
  const record = eventFor(plan, intent, 'SUBMISSION_RESERVED', at, extra)
  return { ledger: reduceLedger(ledger, record), state: 'SUBMISSION_RESERVED', claimed: true, event: record.event }
}

function claimSubmission(filePath, plan, intent, at, limits = {}) {
  let result = { claimed: false, state: 'PLANNED', code: null, reservation_event: null }
  updateJsonLocked(filePath, (current) => {
    let next = reduceLedger(ledgerShape(current), { kind: 'PLAN', plan })
    const latest = latestIntentEvent(next, intent.intent_id)
    const state = latest?.state || 'PLANNED'
    if (!['PLANNED', 'RESERVATION_RELEASED'].includes(state)) {
      result = { claimed: false, state, code: null, reservation_event: latest }
      return next
    }
    const reserved = reserveInLedger(next, plan, intent, at, limits)
    result = { claimed: reserved.claimed, state: reserved.state, code: reserved.code || null, reservation_event: reserved.event || null }
    return reserved.ledger
  }, { missingDefault: EMPTY_LEDGER })
  return result
}

function releaseReservedSubmission(filePath, plan, intent, observedReservation, evidence, at) {
  let result = { released: false, state: 'SUBMISSION_RESERVED_CHANGED', event: null }
  updateJsonLocked(filePath, (current) => {
    let next = reduceLedger(ledgerShape(current), { kind: 'PLAN', plan })
    const latest = latestIntentEvent(next, intent.intent_id)
    if (latest?.state !== 'SUBMISSION_RESERVED' || latest.event_id !== observedReservation?.event_id) {
      result = { released: false, state: latest?.state || 'PLANNED', event: latest }
      return next
    }
    const record = eventFor(plan, intent, 'RESERVATION_RELEASED', at, {
      released_reservation_event_id: latest.event_id,
      release_reason: 'EXACT_IDENTITY_NOT_FOUND',
      exact_client_text: evidence.exact_client_text === true,
      definitive_not_found: evidence.definitive_not_found === true,
      not_found_identities: evidence.not_found_identities
    })
    next = reduceLedger(next, record)
    result = { released: true, state: 'RESERVATION_RELEASED', event: record.event }
    return next
  }, { missingDefault: EMPTY_LEDGER })
  return result
}

function releaseAndReclaimSubmission(filePath, plan, intent, observedReservation, evidence, at, limits) {
  let result = { claimed: false, state: 'SUBMISSION_RESERVED_CHANGED', code: null, reservation_event: null }
  updateJsonLocked(filePath, (current) => {
    let next = reduceLedger(ledgerShape(current), { kind: 'PLAN', plan })
    const latest = latestIntentEvent(next, intent.intent_id)
    if (latest?.state !== 'SUBMISSION_RESERVED' || latest.event_id !== observedReservation?.event_id) {
      result = { claimed: false, state: latest?.state || 'PLANNED', code: null, reservation_event: latest }
      return next
    }
    next = reduceLedger(next, eventFor(plan, intent, 'RESERVATION_RELEASED', at, {
      released_reservation_event_id: latest.event_id,
      release_reason: 'EXACT_IDENTITY_NOT_FOUND',
      exact_client_text: evidence.exact_client_text === true,
      definitive_not_found: evidence.definitive_not_found === true,
      not_found_identities: evidence.not_found_identities
    }))
    const reserved = reserveInLedger(next, plan, intent, at, limits)
    result = { claimed: reserved.claimed, state: reserved.state, code: reserved.code || null, reservation_event: reserved.event || null }
    return reserved.ledger
  }, { missingDefault: EMPTY_LEDGER })
  return result
}

function markReservedUnknown(filePath, plan, intent, observedReservation, at, details = {}) {
  let marked = false
  updateJsonLocked(filePath, (current) => {
    let next = reduceLedger(ledgerShape(current), { kind: 'PLAN', plan })
    const latest = latestIntentEvent(next, intent.intent_id)
    if (latest?.state !== 'SUBMISSION_RESERVED' || latest.event_id !== observedReservation?.event_id) return next
    next = reduceLedger(next, eventFor(plan, intent, 'SUBMISSION_AMBIGUOUS', at, {
      reservation_recovery: true,
      exchange_order_id: details.exchange_order_id || null,
      error_code: details.error_code || 'RESERVATION_IDENTITY_UNKNOWN'
    }))
    next = reduceLedger(next, eventFor(plan, intent, 'RECONCILE_RED', at, {
      sticky: true,
      exchange_order_id: details.exchange_order_id || null,
      reason: 'Ambiguous submission was not resolved by exact order identity'
    }))
    marked = true
    return next
  }, { missingDefault: EMPTY_LEDGER })
  return marked
}

function recoverReservedFound(filePath, plan, intent, observedReservation, order, at) {
  let recovered = false
  let state = null
  updateJsonLocked(filePath, (current) => {
    let next = reduceLedger(ledgerShape(current), { kind: 'PLAN', plan })
    const latest = latestIntentEvent(next, intent.intent_id)
    if (latest?.state !== 'SUBMISSION_RESERVED' || latest.event_id !== observedReservation?.event_id) {
      state = latest?.state || 'PLANNED'
      return next
    }
    const exchangeOrderId = String(order?.id ?? order?.order_id ?? '')
    next = reduceLedger(next, eventFor(plan, intent, 'SUBMITTED', at, { exchange_order_id: exchangeOrderId, recovered_by_identity: true, reservation_recovery: true }))
    recovered = true
    state = 'SUBMITTED'
    return next
  }, { missingDefault: EMPTY_LEDGER })
  return { recovered, state }
}

function knownBotTexts(ledger) {
  const known = new Set()
  for (const plan of ledger.plans || []) for (const intent of plan.intents || []) known.add(intent.intent_id)
  for (const event of ledger.events || []) known.add(event.intent_id)
  return known
}

function exchangePositionMap(positions = []) {
  const map = new Map()
  for (const row of positions || []) {
    const pair = exactPair(row?.contract || row?.symbol)
    if (pair) map.set(pair, row)
  }
  return map
}

function protectionText(order) {
  return String(order?.initial?.text ?? order?.text ?? '')
}

function protectionIsActive(order) {
  return String(order?.status || '').trim().toLowerCase() === 'open'
}

function terminalIdentityResolution(cause, snapshot) {
  const open = (snapshot.open_orders || []).filter((order) => {
    const orderId = String(order?.id ?? order?.order_id ?? '')
    return String(order?.text || '') === cause.client_order_id || (cause.exchange_order_id && orderId === cause.exchange_order_id)
  })
  if (open.length) return blocked('AMBIGUOUS_ORDER_STILL_OPEN', 'Matching ambiguous order is still open')
  const evidence = (snapshot.identity_resolutions || []).find((row) => row?.cause_id === cause.cause_id)
  if (!evidence) return blocked('AMBIGUOUS_IDENTITY_EVIDENCE_MISSING', 'Absence from bounded order snapshots is not terminal evidence')
  const orderId = evidence.order_id === null || evidence.order_id === undefined ? null : String(evidence.order_id)
  const matchingTrades = (snapshot.trades || []).filter((trade) => {
    const tradeOrderId = String(trade?.order_id ?? trade?.order ?? '')
    const tradeText = String(trade?.text || '')
    const exactOrder = orderId ? tradeOrderId === orderId : false
    const exactText = tradeText === cause.client_order_id
    const id = trade?.id ?? trade?.trade_id
    let quantityValid = false
    try { quantityValid = /^\d+$/.test(decimalAbs(trade?.size ?? trade?.contracts ?? '0')) && decimalPositive(decimalAbs(trade?.size ?? trade?.contracts ?? '0')) } catch { quantityValid = false }
    return (orderId ? exactOrder && (!tradeText || exactText) : exactText)
      && id !== undefined && id !== null && id !== '' && quantityValid && decimalPositive(trade?.price)
  })
  const tradeIds = [...new Set(matchingTrades.map((trade) => String(trade.id ?? trade.trade_id)))]
  const tradeContracts = matchingTrades.reduce((sum, trade) => decimalAdd(sum, decimalAbs(trade.size ?? trade.contracts ?? '0')), '0')
  const candidate = {
    cause_id: cause.cause_id,
    source_event_id: cause.source_event_id,
    evidence_kind: 'EXACT_TERMINAL_IDENTITY',
    intent_id: cause.intent_id,
    client_order_id: evidence.client_order_id,
    order_id: orderId,
    exact_client_text: evidence.exact_client_text === true,
    exact_order_id: evidence.exact_order_id === true,
    terminal_status: evidence.terminal_status,
    terminal: evidence.terminal === true,
    unknown_state: evidence.terminal_status === 'UNKNOWN' || evidence.terminal !== true,
    checked_at: evidence.checked_at || snapshot.generated_at,
    terminal_reason: evidence.terminal_reason || null,
    executed_contracts: String(evidence.executed_contracts || '0'),
    cancellation_proof: evidence.cancellation_proof === true,
    venue_rejection: evidence.venue_rejection === true,
    definitive_not_found: evidence.definitive_not_found === true,
    not_found_identities: Array.isArray(evidence.not_found_identities) ? evidence.not_found_identities.map(String) : [],
    trades_complete: evidence.trades_complete === true,
    trade_ids: tradeIds
  }
  let executed = '0'
  try { executed = decimalAbs(candidate.executed_contracts) } catch { return blocked('AMBIGUOUS_TERMINAL_EVIDENCE_INVALID', 'Terminal executed quantity is invalid') }
  if (decimalPositive(executed) && decimalCompare(executed, tradeContracts) !== 0) return blocked('AMBIGUOUS_FILL_QUANTITY_MISMATCH', 'Exact trade records do not match terminal executed quantity')
  if (!decimalPositive(executed) && tradeIds.length) return blocked('AMBIGUOUS_UNEXPECTED_TRADE', 'Terminal evidence claims no execution but exact trades exist')
  return terminalEvidenceMatchesCause(candidate, cause)
    ? { ok: true, evidence: candidate }
    : blocked('AMBIGUOUS_TERMINAL_EVIDENCE_INVALID', 'Exact identity lookup did not prove a terminal outcome')
}

function recoveredFillsFromEvidence(snapshot, ledger, evidenceRows) {
  const byTradeId = new Map((snapshot.trades || []).map((trade) => [String(trade?.id ?? trade?.trade_id ?? ''), trade]))
  const output = []
  const existing = new Set((ledger.fills || []).map(fillKey).filter(Boolean))
  for (const evidence of evidenceRows) {
    const match = intentRecord(ledger, evidence.intent_id)
    if (!match) continue
    for (const tradeId of evidence.trade_ids || []) {
      const trade = byTradeId.get(String(tradeId))
      if (!trade) continue
      const contracts = decimalAbs(trade.size ?? trade.contracts ?? '0')
      const fill = {
        id: String(tradeId),
        product: 'usdm',
        environment: 'testnet',
        plan_id: match.plan.plan_id,
        intent_id: evidence.intent_id,
        symbol: match.intent.symbol,
        contracts,
        price: String(trade.price),
        order_id: String(trade.order_id ?? trade.order ?? evidence.order_id ?? ''),
        at: snapshot.generated_at
      }
      const key = fillKey(fill)
      if (key && !existing.has(key)) {
        existing.add(key)
        output.push(fill)
      }
    }
  }
  return output
}

function reconciliationStateIssues(snapshot, ledger, current, options = {}) {
  const issues = []
  const known = knownBotTexts(ledger)
  const openOrders = Array.isArray(snapshot.open_orders) ? snapshot.open_orders : []
  const protections = Array.isArray(snapshot.protections) ? snapshot.protections : []
  const trades = Array.isArray(snapshot.trades) ? snapshot.trades : []
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : []
  if (snapshot.account?.in_dual_mode !== false) issues.push({ code: 'ONE_WAY_MODE_UNPROVEN' })
  for (const order of openOrders) {
    const text = String(order?.text || '')
    if (BOT_TEXT.test(text) && !known.has(text)) issues.push({ code: 'UNKNOWN_BOT_ORDER', order_text: text })
  }
  for (const order of protections) {
    const text = protectionText(order)
    if (BOT_TEXT.test(text) && !known.has(text)) issues.push({ code: 'UNKNOWN_BOT_PROTECTION', order_text: text })
  }
  const eventOrderIds = new Map()
  for (const event of ledger.events || []) if (event.exchange_order_id) eventOrderIds.set(String(event.exchange_order_id), event.intent_id)
  const ledgerFillKeys = new Set((ledger.fills || []).map(fillKey).filter(Boolean))
  const seenTradeIds = new Set()
  for (const trade of trades) {
    const pair = exactPair(trade.contract || trade.symbol)
    const id = trade.id ?? trade.trade_id
    const key = pair && id !== undefined ? `usdm:${pair}:${id}` : null
    if (!key || seenTradeIds.has(key)) {
      issues.push({ code: key ? 'DUPLICATE_EXCHANGE_FILL' : 'UNIDENTIFIED_EXCHANGE_FILL' })
      continue
    }
    seenTradeIds.add(key)
    const text = String(trade.text || '')
    if (BOT_TEXT.test(text) && !known.has(text)) issues.push({ code: 'UNKNOWN_BOT_FILL', fill_key: key, order_text: text })
    const intentId = BOT_TEXT.test(text) ? text : eventOrderIds.get(String(trade.order_id ?? trade.order ?? ''))
    if (intentId && known.has(intentId) && !ledgerFillKeys.has(key)) issues.push({ code: 'MISSING_LEDGER_FILL', fill_key: key })
  }
  const recentCutoff = current - 86400000
  for (const fill of ledger.fills || []) {
    const time = Date.parse(fill.at || fill.create_time || '')
    const key = fillKey(fill)
    if (key && Number.isFinite(time) && time >= recentCutoff && !seenTradeIds.has(key)) issues.push({ code: 'MISSING_EXCHANGE_FILL', fill_key: key })
  }
  const managed = managedQuantities(ledger, 'usdm')
  const pendingProtectionIds = new Set(options.pendingProtectionIntentIds || [])
  const protectedLedger = pendingProtectionIds.size
    ? { ...ledger, fills: (ledger.fills || []).filter((fill) => !pendingProtectionIds.has(fill.intent_id)) }
    : ledger
  const protectionRequired = managedQuantities(protectedLedger, 'usdm')
  const positionMap = exchangePositionMap(positions)
  for (const pair of PAIRS) {
    const expected = String(managed[pair] || '0')
    const position = positionMap.get(pair)
    const actual = String(position?.size ?? '0')
    if (position && position.mode !== undefined && String(position.mode).toLowerCase() !== 'single') issues.push({ code: 'POSITION_MODE_INVALID', symbol: pair })
    try {
      if (decimalCompare(actual, expected) !== 0) issues.push({ code: 'POSITION_OWNERSHIP_DRIFT', symbol: pair })
    } catch {
      issues.push({ code: 'POSITION_SIZE_INVALID', symbol: pair })
    }
    const active = protections.filter((order) => {
      const text = protectionText(order)
      return protectionIsActive(order) && exactPair(order?.initial?.contract || order?.contract) === pair && order?.initial?.reduce_only === true && BOT_TEXT.test(text) && known.has(text)
    })
    const expectedAbs = decimalAbs(expected)
    const requiredExpected = String(protectionRequired[pair] || '0')
    const requiredAbs = decimalAbs(requiredExpected)
    if (decimalPositive(requiredAbs)) {
      if (active.length < 2) issues.push({ code: 'MANAGED_POSITION_UNPROTECTED', symbol: pair, active_protections: active.length })
      let ruleOne = '0'
      let ruleTwo = '0'
      for (const order of active) {
        const size = String(order?.initial?.size ?? '0')
        const opposite = requiredExpected.startsWith('-') ? !size.startsWith('-') : size.startsWith('-')
        if (!opposite) {
          issues.push({ code: 'PROTECTION_SIDE_INVALID', symbol: pair })
          continue
        }
        let quantity
        try { quantity = decimalAbs(size) } catch {
          issues.push({ code: 'PROTECTION_SIZE_INVALID', symbol: pair })
          continue
        }
        if (Number(order?.trigger?.rule) === 1) ruleOne = decimalAdd(ruleOne, quantity)
        if (Number(order?.trigger?.rule) === 2) ruleTwo = decimalAdd(ruleTwo, quantity)
      }
      if (decimalCompare(ruleOne, requiredAbs) !== 0 || decimalCompare(ruleTwo, requiredAbs) !== 0) issues.push({ code: 'PROTECTION_QUANTITY_DRIFT', symbol: pair })
    }
    if (!decimalPositive(expectedAbs) && active.length) issues.push({ code: 'ORPHAN_BOT_PROTECTION', symbol: pair })
  }
  return issues
}

export function reconcileSnapshot(snapshot = {}, ledger = EMPTY_LEDGER, options = {}) {
  ledgerShape(ledger)
  const current = nowMs(options.now ?? Date.now)
  const generatedAt = snapshot.generated_at || new Date(current).toISOString()
  const openOrders = Array.isArray(snapshot.open_orders) ? snapshot.open_orders : []
  const protections = Array.isArray(snapshot.protections) ? snapshot.protections : []
  const trades = Array.isArray(snapshot.trades) ? snapshot.trades : []
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : []
  const unresolved = unresolvedRedCauses(ledger)
  const requested = new Set(options.requestedCauseIds || [])
  const causeEvidence = []
  const terminalFailures = new Map()
  for (const cause of unresolved) {
    if (!requested.has(cause.cause_id) || cause.type === 'RECONCILIATION_STATE') continue
    const terminal = terminalIdentityResolution(cause, { ...snapshot, open_orders: openOrders, trades })
    if (terminal.ok) causeEvidence.push(terminal.evidence)
    else terminalFailures.set(cause.cause_id, terminal.code)
  }
  const recoveredFills = recoveredFillsFromEvidence({ ...snapshot, trades, generated_at: generatedAt }, ledger, causeEvidence)
  let projectedLedger = ledger
  for (const fill of recoveredFills) projectedLedger = reduceLedger(projectedLedger, { kind: 'FILL', fill })
  const stateIssues = reconciliationStateIssues({ ...snapshot, open_orders: openOrders, protections, trades, positions }, projectedLedger, current, options)
  if (!Number.isFinite(Date.parse(generatedAt))) stateIssues.unshift({ code: 'RECONCILIATION_TIME_INVALID' })
  const issues = [...stateIssues]
  const resolutions = []
  for (const cause of unresolved) {
    if (!requested.has(cause.cause_id)) {
      issues.push({ code: 'RED_CAUSE_AWAITING_EXPLICIT_RESOLUTION', cause_id: cause.cause_id, intent_id: cause.intent_id })
      continue
    }
    if (cause.type === 'RECONCILIATION_STATE') {
      if (stateIssues.length) {
        issues.push({ code: 'RED_CAUSE_CURRENT_STATE_NOT_RECONCILED', cause_id: cause.cause_id })
      } else {
        resolutions.push({
          cause_id: cause.cause_id,
          evidence_kind: 'ACCOUNT_STATE_RECONCILED',
          source_receipt_id: cause.source_receipt_id,
          issue_fingerprint: cause.issue_fingerprint,
          state_reconciled: true,
          checked_at: generatedAt
        })
      }
      continue
    }
    const evidence = causeEvidence.find((row) => row.cause_id === cause.cause_id)
    if (!evidence) {
      issues.push({ code: terminalFailures.get(cause.cause_id) || 'AMBIGUOUS_TERMINAL_EVIDENCE_MISSING', cause_id: cause.cause_id, intent_id: cause.intent_id })
      continue
    }
    if (stateIssues.length) {
      issues.push({ code: 'AMBIGUOUS_RESULTING_STATE_NOT_RECONCILED', cause_id: cause.cause_id, intent_id: cause.intent_id })
      continue
    }
    const resolution = { ...evidence, state_reconciled: true }
    if (!resolutionMatchesCause(resolution, cause, { ledger: projectedLedger, recoveredFills })) {
      issues.push({ code: 'AMBIGUOUS_RESOLUTION_EVIDENCE_INVALID', cause_id: cause.cause_id, intent_id: cause.intent_id })
      continue
    }
    resolutions.push(resolution)
  }
  const resolvedCauseIds = resolutions.map((resolution) => resolution.cause_id)
  return sealReconciliationReceipt({
    status: issues.length ? 'red' : 'ok',
    sticky: issues.length > 0,
    sticky_cause: stateIssues.length > 0,
    generated_at: generatedAt,
    product: 'usdm',
    environment: 'testnet',
    issues,
    state_issues: stateIssues,
    requested_cause_ids: [...requested].sort(),
    pending_protection_intent_ids: [...new Set(options.pendingProtectionIntentIds || [])].sort(),
    resolved_cause_ids: resolvedCauseIds,
    cause_evidence: causeEvidence,
    recovered_fills: recoveredFills,
    resolutions,
    observed_cause_ids: unresolved.map((cause) => cause.cause_id),
    summary: {
      open_orders: openOrders.length,
      protections: protections.length,
      trades: trades.length,
      positions: positions.length,
      unresolved_causes: unresolved.length - resolvedCauseIds.length,
      resolved_causes: resolvedCauseIds.length
    }
  })
}

function classifyOrder(order = {}) {
  const original = decimalAbs(String(order.size ?? order.quantity ?? '0'))
  const left = decimalAbs(String(order.left ?? '0'))
  let executed = '0'
  if (decimalPositive(original) && decimalCompare(original, left) >= 0) executed = decimalSubtract(original, left)
  const status = String(order.status || '').toLowerCase()
  const finish = String(order.finish_as || '').toLowerCase()
  if (status === 'open') return { state: decimalPositive(executed) ? 'PARTIALLY_FILLED' : 'SUBMITTED', terminal: false, executed_contracts: executed }
  if (status === 'finished') {
    if (finish === 'filled' || (!finish && !decimalPositive(left))) return { state: 'FILLED', terminal: true, executed_contracts: decimalPositive(executed) ? executed : original }
    if (['cancelled', 'canceled', 'ioc', 'stp', 'expired'].includes(finish)) return { state: 'CANCELLED', terminal: true, executed_contracts: executed }
    if (['rejected', 'reject', 'failed'].includes(finish)) return { state: 'REJECTED', terminal: true, executed_contracts: executed }
    if (finish === 'liquidated') return { state: 'RECONCILE_RED', terminal: true, executed_contracts: executed }
  }
  if (['cancelled', 'canceled', 'expired'].includes(status)) return { state: 'CANCELLED', terminal: true, executed_contracts: executed }
  if (['rejected', 'reject', 'failed'].includes(status)) return { state: 'REJECTED', terminal: true, executed_contracts: executed }
  return { state: 'UNKNOWN', terminal: false, executed_contracts: executed }
}

async function inspectReservedIntent(client, plan, intent, reservation, options) {
  if (reservationOwnerActive(reservation)) return { kind: 'ACTIVE', state: 'SUBMISSION_RESERVED', reservation }
  let order
  try {
    order = await client.findUsdmOrderByText(intent.intent_id)
  } catch (error) {
    if (isDefinitiveOrderNotFound(error, intent.intent_id)) {
      return {
        kind: 'NOT_FOUND',
        reservation,
        evidence: {
          exact_client_text: true,
          definitive_not_found: true,
          not_found_identities: [intent.intent_id],
          checked_at: nowIso(options.now || Date.now)
        }
      }
    }
    markReservedUnknown(options.ledgerPath, plan, intent, reservation, nowIso(options.now || Date.now), { error_code: error?.code || 'RESERVATION_IDENTITY_UNKNOWN' })
    return { kind: 'RED', code: 'RESERVATION_IDENTITY_UNKNOWN' }
  }
  const exchangeOrderId = String(order?.id ?? order?.order_id ?? '')
  try {
    requireExactOrderIdentity(order, intent)
  } catch (error) {
    markReservedUnknown(options.ledgerPath, plan, intent, reservation, nowIso(options.now || Date.now), { exchange_order_id: exchangeOrderId, error_code: 'RESERVATION_IDENTITY_MISMATCH' })
    return { kind: 'RED', code: 'RESERVATION_IDENTITY_MISMATCH' }
  }
  const classified = classifyOrder(order)
  if (classified.state === 'UNKNOWN') {
    markReservedUnknown(options.ledgerPath, plan, intent, reservation, nowIso(options.now || Date.now), { exchange_order_id: exchangeOrderId, error_code: 'RESERVATION_ORDER_STATE_UNKNOWN' })
    return { kind: 'RED', code: 'RESERVATION_ORDER_STATE_UNKNOWN' }
  }
  const recovered = recoverReservedFound(options.ledgerPath, plan, intent, reservation, order, nowIso(options.now || Date.now))
  if (!recovered.recovered) return { kind: 'CHANGED', state: recovered.state }
  let fillProof = { fills: [], contracts: '0' }
  if (decimalPositive(classified.executed_contracts)) {
    try { fillProof = await identifiableFills(client, plan, intent, order, options) } catch {}
    if (!decimalPositive(fillProof.contracts) || decimalCompare(fillProof.contracts, classified.executed_contracts) !== 0) {
      appendRecord(options.ledgerPath, eventFor(plan, intent, 'RECONCILE_RED', nowIso(options.now || Date.now), { sticky: true, exchange_order_id: exchangeOrderId, reason: 'Recovered execution lacks exact identifiable fills' }))
      return { kind: 'RED', code: 'FILL_IDENTITY_UNPROVEN' }
    }
  }
  if (classified.state !== 'SUBMITTED') {
    appendRecord(options.ledgerPath, eventFor(plan, intent, classified.state, nowIso(options.now || Date.now), {
      exchange_order_id: exchangeOrderId,
      executed_contracts: classified.executed_contracts,
      recovered_by_identity: true,
      ...(classified.state === 'REJECTED' ? { venue_reached: true } : {})
    }))
  }
  return { kind: 'FOUND', order, state: classified, fillProof, pendingProtection: intent.role === 'ENTRY' && decimalPositive(fillProof.contracts) }
}

async function recoverReservedBeforePreflight(client, plan, options) {
  const output = new Map()
  const ledger = readLedger(options.ledgerPath)
  const reservations = new Map(strandedReservationsForPlan(ledger, plan).map((event) => [event.intent_id, event]))
  for (const intent of plan.intents) {
    const reservation = reservations.get(intent.intent_id)
    if (!reservation) continue
    output.set(intent.intent_id, await inspectReservedIntent(client, plan, intent, reservation, options))
  }
  return output
}

async function collectUsdmSnapshot(client, symbols, current = Date.now) {
  const generatedAt = nowIso(current)
  const [accountResult, positionsResult, ordersResult, protectionsResult, ...tradeResults] = await Promise.all([
    client.usdmAccount(),
    client.usdmPositions(),
    client.usdmOrders({ status: 'open', limit: 100 }),
    client.usdmPriceOrders({ status: 'open', limit: 100 }),
    ...symbols.map((contract) => client.usdmTrades({ contract, limit: 100 }))
  ])
  return {
    generated_at: generatedAt,
    account: accountResult.data,
    positions: Array.isArray(positionsResult.data) ? positionsResult.data : [],
    open_orders: Array.isArray(ordersResult.data) ? ordersResult.data : [],
    protections: Array.isArray(protectionsResult.data) ? protectionsResult.data : [],
    trades: tradeResults.flatMap((result) => Array.isArray(result.data) ? result.data : [])
  }
}

function managedNotional(ledger, product, quotes, rules) {
  const managed = managedQuantities(ledger, product)
  let total = '0'
  for (const [pair, quantityRaw] of Object.entries(managed)) {
    const quantity = decimalAbs(quantityRaw)
    const price = quotes[pair]?.price
    if (!decimalPositive(quantity) || !decimalPositive(price)) continue
    const base = product === 'usdm' ? decimalMultiply(quantity, rules[pair]?.quanto_multiplier || '0') : quantity
    if (decimalPositive(base)) total = decimalAdd(total, decimalMultiply(base, price))
  }
  return total
}

export async function acquirePlanningContext(options) {
  const { product, environment, config, symbols, ledger } = options
  const current = options.now ?? Date.now
  const at = nowIso(current)
  const context = { rules: {}, quotes: {}, accounts: {}, reconciliation: null, blockers: [] }
  if (!symbols.length) return context
  try {
    if (product === 'spot') {
      const publicClient = options.clientFactory
        ? await options.clientFactory({ product: 'spot', environment: 'public', readOnly: true })
        : createGateClient({ product: 'spot', environment: 'public', readOnly: true })
      for (const pair of symbols) {
        const [ruleResult, tickerResult] = await Promise.all([publicClient.spotPair({ currency_pair: pair }), publicClient.spotTickers({ currency_pair: pair })])
        context.rules[pair] = { ...ruleResult.data, _fetched_at: at }
        const quote = quoteFromRows(tickerResult.data, pair, 'spot', at)
        if (!quote.ok) throwCode(quote.code, quote.message)
        context.quotes[pair] = quote
      }
      if (config.gate.spot.account_read_enabled !== true) {
        context.blockers.push({ code: 'SPOT_ACCOUNT_READ_DISABLED', message: 'Spot account read is disabled; quantity cannot be proven' })
        return context
      }
      const accountClient = options.clientFactory
        ? await options.clientFactory({ product: 'spot', environment: 'dry-run', readOnly: true })
        : createGateClient({ product: 'spot', environment: 'dry-run', readOnly: true })
      const accountResult = await accountClient.spotAccounts({ currency: 'USDT' })
      const funding = applyFundingPolicy(normalizeSpotFunding(accountResult.data, { now: current }), config.gate.spot)
      context.accounts = buildAccountEpochs(funding, { symbols, ledger, now: current })
      const totalManaged = managedNotional(ledger, product, context.quotes, context.rules)
      for (const epoch of Object.values(context.accounts)) epoch.managed_notional = totalManaged
      return context
    }

    const client = options.clientFactory
      ? await options.clientFactory({ product: 'usdm', environment, readOnly: true })
      : createGateClient({ product: 'usdm', environment, readOnly: true })
    for (const pair of PAIRS) {
      const [ruleResult, tickerResult] = await Promise.all([client.usdmContract({ contract: pair }), client.usdmTickers({ contract: pair })])
      const rawRule = Array.isArray(ruleResult.data) ? ruleResult.data.find((row) => exactPair(row?.name || row?.contract) === pair) : ruleResult.data
      context.rules[pair] = { ...rawRule, _fetched_at: at }
      const quote = quoteFromRows(tickerResult.data, pair, 'usdm', at)
      if (!quote.ok) throwCode(quote.code, quote.message)
      context.quotes[pair] = quote
    }
    if (environment !== 'testnet') {
      context.blockers.push({ code: 'USDM_TESTNET_ACCOUNT_REQUIRED', message: 'Dry-run public data is available, but deterministic quantity requires a testnet account context' })
      return context
    }
    const snapshot = await collectUsdmSnapshot(client, [...PAIRS], current)
    const reconciliation = reconcileSnapshot(snapshot, ledger, { now: current })
    context.reconciliation = reconciliation
    const funding = applyFundingPolicy(normalizeUsdmFunding(snapshot.account, { now: current }), config.gate.usdm)
    context.accounts = buildAccountEpochs(funding, { symbols, ledger, now: current })
    const normalizedRules = Object.fromEntries(Object.entries(context.rules).map(([pair, rule]) => [pair, parseUsdmRule(rule)]))
    const totalManaged = managedNotional(ledger, product, context.quotes, normalizedRules)
    for (const epoch of Object.values(context.accounts)) epoch.managed_notional = totalManaged
    return context
  } catch (error) {
    context.blockers.push({ code: error.code || 'PLANNING_CONTEXT_UNAVAILABLE', message: safeText(error.message || error) })
    return context
  }
}

function unattended(options = {}) {
  const env = options.env || process.env
  if (String(env.CI || '').trim()) return { blocked: true, evidence: 'CI' }
  if (String(env.TYCHE_UNATTENDED || '').trim()) return { blocked: true, evidence: 'TYCHE_UNATTENDED' }
  return { blocked: false, evidence: null }
}

function strandedReservationsForPlan(ledger, plan) {
  const wanted = new Set((plan.intents || []).map((intent) => intent.intent_id))
  const latest = new Map()
  for (const event of ledger.events || []) {
    if (!wanted.has(event.intent_id) || event.plan_id !== plan.plan_id || event.plan_hash !== plan.plan_hash) continue
    latest.set(event.intent_id, event)
  }
  return [...latest.values()].filter((event) => event.state === 'SUBMISSION_RESERVED')
}

function staticReservationRecoveryGate(plan, options = {}) {
  const automatic = options.executionMode === 'automatic_testnet'
  const expectedVenue = automatic ? String(options.venue || '').toLowerCase() : 'gate'
  let config = options.config
  try {
    validateConfig(config)
    if (automatic && expectedVenue === 'binance') config = mapExecutionConfig(config, expectedVenue)
  } catch (error) { return blocked(error.code || 'CONFIG_INVALID', error.message) }
  const verified = verifyPlan(plan, {
    planId: options.planId,
    planHash: options.planHash,
    planTtlSeconds: config.gate.plan_ttl_seconds,
    now: options.now,
    allowExpired: true
  })
  if (!verified.ok) return verified
  if (plan.product !== 'usdm' || plan.environment !== 'testnet') return blocked('TESTNET_USDM_ONLY', 'Only USDT-M testnet plans can be recovered')
  if (!['gate', 'binance'].includes(expectedVenue) || String(plan.venue || 'gate') !== expectedVenue) return blocked('PLAN_VENUE_MISMATCH', 'Sealed plan venue does not match the executor')
  if (automatic) {
    if (config.gate.submission_mode !== 'automatic_testnet') return blocked('SUBMISSION_MODE_LOCKED', 'Configuration does not authorize automatic testnet recovery')
    if (options.automaticAuthorization !== AUTOMATIC_TESTNET_AUTHORIZATION) return blocked('AUTOMATIC_TESTNET_AUTHORIZATION_REQUIRED', 'Automatic testnet recovery requires the internal executor capability')
  } else if (config.gate.submission_mode !== 'manual_testnet') return blocked('SUBMISSION_MODE_LOCKED', 'Configuration does not authorize manual testnet recovery')
  if (config.gate.enabled !== true || config.gate.usdm.enabled !== true) return blocked('USDM_DISABLED', 'USDT-M is disabled')
  if (plan.status !== 'READY' || plan.blockers?.length || !Array.isArray(plan.intents) || plan.intents.length === 0) return blocked('PLAN_BLOCKED', 'Only a sealed READY plan with intents can be recovered')
  if (!automatic) {
    if (!options.commit) return blocked('COMMIT_REQUIRED', 'Recovery requires --commit')
    const phrase = `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`
    if (options.confirm !== phrase) return blocked('TESTNET_CONFIRMATION_MISMATCH', `Exact confirmation required: ${phrase}`)
    if (options.interactive !== true) return blocked('REAL_TTY_REQUIRED', 'Manual testnet recovery requires a real stdin and stdout TTY')
    const unattendedResult = unattended(options)
    if (unattendedResult.blocked) return blocked('UNATTENDED_EXECUTION_FORBIDDEN', 'Manual testnet recovery is unavailable in unattended contexts', unattendedResult)
  }
  const killPath = options.killPath || path.join(ROOT, expectedVenue === 'binance' ? 'data/binance_KILL' : config.gate.kill_switch_path)
  if (fs.existsSync(killPath)) return blocked('GATE_KILL_ACTIVE', 'Kill switch blocks recovery mutations')
  let ledger
  try { ledger = readLedger(options.ledgerPath || LEDGER_PATH) } catch (error) { return blocked(error.code || 'LEDGER_UNAVAILABLE', error.message) }
  const reservations = strandedReservationsForPlan(ledger, plan)
  const stored = (ledger.plans || []).find((candidate) => candidate.plan_id === plan.plan_id && candidate.plan_hash === plan.plan_hash)
  if (reservations.length && !stored) return blocked('RECOVERY_PLAN_NOT_RECORDED', 'The reserved sealed plan is not present in the execution ledger')
  return { ok: true, ledger, reservations }
}

function staticExecutionGateForMode(plan, options = {}) {
  const automatic = options.executionMode === 'automatic_testnet'
  const expectedVenue = automatic ? String(options.venue || '').toLowerCase() : 'gate'
  let config = options.config
  try {
    validateConfig(config)
    if (automatic && expectedVenue === 'binance') config = mapExecutionConfig(config, expectedVenue)
  } catch (error) { return blocked(error.code || 'CONFIG_INVALID', error.message) }
  const verified = verifyPlan(plan, { planId: options.planId, planHash: options.planHash, planTtlSeconds: config.gate.plan_ttl_seconds, now: options.now })
  if (!verified.ok) return verified
  if (plan.product !== 'usdm' || plan.environment !== 'testnet') return blocked('TESTNET_USDM_ONLY', 'Only USDT-M testnet plans can execute')
  if (!['gate', 'binance'].includes(expectedVenue) || String(plan.venue || 'gate') !== expectedVenue) return blocked('PLAN_VENUE_MISMATCH', 'Sealed plan venue does not match the executor')
  if (automatic) {
    if (config.gate.submission_mode !== 'automatic_testnet') return blocked('SUBMISSION_MODE_LOCKED', 'Configuration does not authorize automatic testnet submission')
    if (options.automaticAuthorization !== AUTOMATIC_TESTNET_AUTHORIZATION) return blocked('AUTOMATIC_TESTNET_AUTHORIZATION_REQUIRED', 'Automatic testnet submission requires the internal executor capability')
  } else if (config.gate.submission_mode !== 'manual_testnet') return blocked('SUBMISSION_MODE_LOCKED', 'Configuration does not authorize manual testnet submission')
  if (config.gate.enabled !== true || config.gate.usdm.enabled !== true) return blocked('USDM_DISABLED', 'USDT-M is disabled')
  const currentPolicy = riskPolicy(config.gate.usdm, config)
  if (!plan.risk_policy_digest || plan.risk_policy_digest !== sha256Hex(currentPolicy) || stableStringify(plan.risk_policy) !== stableStringify(currentPolicy)) return blocked('RISK_POLICY_DRIFT', 'Risk limits or leverage changed after the plan was sealed; regenerate the plan')
  if (plan.intents.some((intent) => intent.role === 'ENTRY')) {
    const anchor = weeklyAnchorStatus(options.weeklyAnchor, { isoWeek: plan.source?.iso_week, now: options.now, maxAgeDays: config.analysis.weekly_anchor_max_age_days })
    if (!anchor.ok) return blocked(anchor.code, 'Canonical weekly anchor no longer authorizes new risk')
    if (!plan.weekly_anchor_proof || plan.weekly_anchor_proof.digest !== sha256Hex(options.weeklyAnchor) || plan.weekly_anchor_proof.generated_at !== options.weeklyAnchor.generated_at) return blocked('WEEKLY_ANCHOR_DRIFT', 'Canonical weekly anchor differs from the one sealed into the plan')
  }
  const market = marketSnapshotStatus(options.marketSnapshot, { date: plan.source?.date, isoWeek: plan.source?.iso_week, now: options.now, maxAgeSeconds: config.analysis.candidate_max_age_seconds })
  if (!market.ok) return market
  if (!plan.market_snapshot_proof || plan.market_snapshot_proof.digest !== sha256Hex(options.marketSnapshot) || plan.market_snapshot_proof.generated_at !== options.marketSnapshot.generated_at) return blocked('MARKET_SNAPSHOT_DRIFT', 'Canonical market snapshot differs from the one sealed into the plan')
  const derivation = verifyPlanDerivation(plan, options.executionSource, { config, weeklyAnchor: options.weeklyAnchor, marketSnapshot: options.marketSnapshot, now: options.now })
  if (!derivation.ok) return derivation
  if (plan.status !== 'READY' || plan.blockers?.length) return blocked('PLAN_BLOCKED', 'Only blocker-free READY plans may execute')
  if (!Array.isArray(plan.intents) || plan.intents.length === 0) return blocked('PLAN_EMPTY', 'READY plan must contain at least one intent')
  if (!automatic) {
    if (!options.commit) return blocked('COMMIT_REQUIRED', 'Execution requires --commit')
    const phrase = `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`
    if (options.confirm !== phrase) return blocked('TESTNET_CONFIRMATION_MISMATCH', `Exact confirmation required: ${phrase}`)
    if (options.interactive !== true) return blocked('REAL_TTY_REQUIRED', 'Manual testnet execution requires a real stdin and stdout TTY')
    const unattendedResult = unattended(options)
    if (unattendedResult.blocked) return blocked('UNATTENDED_EXECUTION_FORBIDDEN', 'Manual testnet execution is unavailable in unattended contexts', unattendedResult)
  }
  const killPath = options.killPath || path.join(ROOT, expectedVenue === 'binance' ? 'data/binance_KILL' : config.gate.kill_switch_path)
  if (fs.existsSync(killPath)) return blocked('GATE_KILL_ACTIVE', 'Kill switch blocks new plans and submissions')
  let ledger
  try { ledger = readLedger(options.ledgerPath || LEDGER_PATH) } catch (error) { return blocked(error.code || 'LEDGER_UNAVAILABLE', error.message) }
  const unresolved = unresolvedRedCauses(ledger)
  if (unresolved.length) return blocked('STICKY_RECONCILE_RED', 'Every unresolved red cause must receive exact terminal resolution evidence', { cause_ids: unresolved.map((cause) => cause.cause_id) })
  const proofs = freshContextProofs(plan, config, nowMs(options.now ?? Date.now))
  if (!proofs.ok) return proofs
  return { ok: true }
}

export function staticExecutionGate(plan, options = {}) {
  return staticExecutionGateForMode(plan, { ...options, executionMode: 'manual_testnet', venue: 'gate' })
}

export function staticAutomaticExecutionGate(plan, options = {}) {
  return staticExecutionGateForMode(plan, { ...options, executionMode: 'automatic_testnet' })
}

function sameRule(left, right) {
  const keys = [
    'symbol', 'tick_size', 'quanto_multiplier', 'min_contracts', 'max_contracts', 'min_notional',
    'max_leverage', 'maintenance_rate', 'maker_fee_rate', 'taker_fee_rate', 'funding_interval',
    'funding_next_apply', 'trade_status', 'circuit_breaker', 'delisting'
  ]
  return keys.every((key) => String(left?.[key] ?? '') === String(right?.[key] ?? ''))
}

async function dynamicExecutionPreflight(plan, options) {
  const client = options.client
  const config = options.config
  const current = options.now ?? Date.now
  const at = nowIso(current)
  const symbols = [...new Set(plan.intents.map((intent) => intent.symbol))]
  const rules = {}
  const quotes = {}
  const positionProofs = {}
  for (const pair of PAIRS) {
    const [ruleResult, tickerResult] = await Promise.all([
      client.usdmContract({ contract: pair }),
      client.usdmTickers({ contract: pair })
    ])
    const rawRule = Array.isArray(ruleResult.data) ? ruleResult.data.find((row) => exactPair(row?.name || row?.contract) === pair) : ruleResult.data
    const rule = parseUsdmRule({ ...rawRule, _fetched_at: at })
    if (!rule.ok) return rule
    const quote = quoteFromRows(tickerResult.data, pair, 'usdm', at)
    if (!quote.ok) return quote
    rules[pair] = rule
    quotes[pair] = quote
    if (symbols.includes(pair)) {
      const plannedRule = plan.proofs?.[pair]?.rule
      if (!sameRule(rule, plannedRule)) return blocked('EXCHANGE_RULE_DRIFT', `${pair} rules changed after the plan was sealed`)
      positionProofs[pair] = (await client.usdmPosition({ contract: pair })).data
    }
  }
  const ledger = readLedger(options.ledgerPath)
  const snapshot = await collectUsdmSnapshot(client, [...PAIRS], current)
  const reconciliation = reconcileSnapshot(snapshot, ledger, { now: current, pendingProtectionIntentIds: options.pendingProtectionIntentIds || [] })
  appendRecord(options.ledgerPath, { kind: 'RECONCILIATION', reconciliation })
  if (reconciliation.status !== 'ok') return blocked('PRE_SUBMIT_RECONCILIATION_RED', 'Fresh exchange reconciliation is red', reconciliation.issues)
  const funding = applyFundingPolicy(normalizeUsdmFunding(snapshot.account, { now: current }), config.gate.usdm)
  if (funding.one_way_proof !== true) return blocked('ONE_WAY_MODE_UNPROVEN', 'USDT-M account response does not prove one-way mode')
  for (const pair of symbols) {
    try {
      normalizeUsdmPositionReadiness(positionProofs[pair], { configuredLeverage: config.gate.usdm.configured_leverage })
    } catch (error) {
      return blocked(error.code || 'USDM_POSITION_READINESS_UNPROVEN', safeText(error.message || error))
    }
  }
  const managedBySymbol = managedQuantities(ledger, 'usdm')
  for (const intent of plan.intents.filter((row) => row.role === 'ENTRY')) {
    const lifecycle = latestIntentEvent(ledger, intent.intent_id)?.state || 'PLANNED'
    if (['PLANNED', 'RESERVATION_RELEASED'].includes(lifecycle) && decimalPositive(decimalAbs(managedBySymbol[intent.symbol] || '0'))) return blocked('POSITION_ALREADY_MANAGED', `${intent.symbol} already has identifiable Tyche-managed exposure`)
  }
  for (const intent of plan.intents.filter((row) => row.role === 'REDUCTION')) {
    const managed = String(managedBySymbol[intent.symbol] || '0')
    const correctSide = ['REDUCE_LONG', 'EXIT_LONG'].includes(intent.action) ? decimalCompare(managed, '0') > 0 : decimalCompare(managed, '0') < 0
    if (!correctSide || decimalCompare(String(intent.quantity), decimalAbs(managed)) > 0) return blocked('REDUCTION_EXCEEDS_MANAGED', `${intent.symbol} reduction is not supported by identifiable Tyche fills`)
  }
  if (options.recoveryOnly !== true) {
    const currentUsage = dailyUsage(ledger, 'usdm', current)
    const capacityUsage = atomicCapacityUsage(ledger, 'usdm', {
      now: current,
      quotes,
      rules,
      accountSnapshotAt: funding.generated_at,
      configuredLeverage: config.gate.usdm.configured_leverage
    })
    const plannedEntries = plan.intents.filter((intent) => {
      if (intent.role !== 'ENTRY') return false
      const state = latestIntentEvent(ledger, intent.intent_id)?.state || 'PLANNED'
      return state === 'PLANNED' || state === 'RESERVATION_RELEASED'
    })
    const plannedNew = plannedEntries.reduce((sum, intent) => decimalAdd(sum, intent.estimated_notional), '0')
    const plannedMargin = plannedEntries.reduce((sum, intent) => decimalAdd(sum, planMarginDebit(plan, intent, intent.estimated_notional)), '0')
    if (decimalCompare(decimalAdd(currentUsage.daily_new_notional_used, plannedNew), String(config.gate.usdm.daily_new_notional_cap_usdt)) > 0) return blocked('DAILY_NOTIONAL_LIMIT_DRIFT', 'Current reservations and fills plus this plan exceed the daily limit')
    if (decimalCompare(decimalAdd(capacityUsage.managed_and_pending_notional, plannedNew), String(config.gate.usdm.max_managed_notional_usdt)) > 0) return blocked('MANAGED_NOTIONAL_LIMIT_DRIFT', 'Current managed fills and pending reservations plus this plan exceed the managed limit')
    if (decimalCompare(decimalAdd(capacityUsage.unavailable_margin, plannedMargin), funding.available_quote) > 0) return blocked('ACCOUNT_AVAILABLE_LIMIT_DRIFT', 'Current account snapshot cannot fund active reservations, later fills, and this plan')
    for (const intent of plan.intents) {
      const planned = plan.proofs?.[intent.symbol]?.account
      if (!planned || planned.funding_source !== funding.funding_source || planned.wallet !== funding.wallet || planned.asset !== funding.asset) return blocked('ACCOUNT_SCOPE_DRIFT', 'Account scope changed after planning')
      if (decimalCompare(funding.available_quote, planned.available_quote) < 0 || decimalCompare(funding.effective_risk_capital, planned.effective_risk_capital) < 0) return blocked('ACCOUNT_CAPITAL_DECLINED', 'Product-local available capital declined after planning')
    }
  }
  return { ok: true, rules, quotes, funding: fundingProjection(funding), reconciliation }
}

function orderText(order) {
  return String(order?.text || order?.initial?.text || '')
}

function orderContract(order) {
  return exactPair(order?.contract || order?.symbol || order?.initial?.contract || order?.initial?.symbol)
}

function requireExactOrderIdentity(order, intent, label = 'order') {
  const exchangeOrderId = String(order?.id ?? order?.order_id ?? '')
  if (!exchangeOrderId || orderText(order) !== String(intent?.intent_id || '')) {
    throwCode('ORDER_IDENTITY_UNPROVEN', `Exact ${label} identity was not returned by the venue`)
  }
  const contract = orderContract(order)
  if (contract && contract !== intent.symbol) throwCode('ORDER_CONTRACT_MISMATCH', `Exact ${label} contract does not match the sealed intent`)
  if (intent.reduce_only === true) {
    const reduceOnly = order?.reduce_only ?? order?.initial?.reduce_only
    if (reduceOnly !== undefined && reduceOnly !== true) throwCode('REDUCE_ONLY_UNPROVEN', `Exact ${label} did not prove reduce-only semantics`)
  }
  return order
}

async function exactOrder(client, identity, exchangeId = null, intent = null) {
  if (exchangeId !== null && exchangeId !== undefined && exchangeId !== '') {
    try {
      const order = (await client.usdmOrder({ order_id: String(exchangeId) })).data
      return intent ? requireExactOrderIdentity(order, intent) : order
    } catch (error) { if (error.ambiguous) throw error }
  }
  const order = await client.findUsdmOrderByText(identity)
  return intent ? requireExactOrderIdentity(order, intent) : order
}

async function findPriceOrder(client, identity, exchangeId = null) {
  if (exchangeId !== null && exchangeId !== undefined && exchangeId !== '') {
    try { return (await client.usdmPriceOrder({ order_id: String(exchangeId) })).data } catch (error) { if (error.ambiguous) throw error }
  }
  if (typeof client.findUsdmPriceOrderByText === 'function') return client.findUsdmPriceOrderByText(identity)
  const rows = []
  for (const status of ['open', 'finished']) {
    const result = await client.usdmPriceOrders({ status, limit: 100 })
    if (Array.isArray(result.data)) rows.push(...result.data)
  }
  const matches = rows.filter((order) => String(order?.initial?.text ?? order?.text ?? '') === identity)
  if (matches.length !== 1) throwCode(matches.length ? 'PRICE_ORDER_IDENTITY_AMBIGUOUS' : 'PRICE_ORDER_NOT_FOUND', 'Exact protection identity was not proven')
  return matches[0]
}

async function pollOrder(client, plan, intent, first, options = {}) {
  const watchMs = Number(options.config.gate.entry_watch_seconds) * 1000
  const interval = Number(options.config.gate.poll_interval_ms)
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const clock = options.now || Date.now
  const deadline = nowMs(clock) + watchMs
  let order = first
  while (true) {
    const state = classifyOrder(order)
    if (state.terminal) return { order, state }
    if (nowMs(clock) >= deadline) break
    await sleep(Math.min(interval, Math.max(0, deadline - nowMs(clock))))
    order = await exactOrder(client, intent.intent_id, order?.id ?? order?.order_id, intent)
  }
  const state = classifyOrder(order)
  if (['SUBMITTED', 'PARTIALLY_FILLED', 'UNKNOWN'].includes(state.state)) {
    const exchangeId = order?.id ?? order?.order_id
    if (exchangeId === undefined || exchangeId === null) throwCode('ORDER_CANCEL_ID_UNPROVEN', 'Cannot cancel an order without a proven exchange ID')
    appendRecord(options.ledgerPath, eventFor(plan, intent, 'CANCEL_REQUESTED', nowIso(clock), { exchange_order_id: String(exchangeId), ...(options.eventExtra || {}) }))
    try {
      await client.usdmCancelOrder({ order_id: String(exchangeId) })
    } catch (error) {
      const check = await exactOrder(client, intent.intent_id, exchangeId, intent)
      if (!classifyOrder(check).terminal) throwCode('CANCEL_AMBIGUOUS_UNRESOLVED', 'Single-order cancellation was not proven')
      order = check
    }
    order = await exactOrder(client, intent.intent_id, exchangeId, intent)
  }
  const final = classifyOrder(order)
  if (!final.terminal) throwCode('ORDER_STATE_UNPROVEN', `Order state remains ${final.state}; cancellation of any remainder is not proven`)
  return { order, state: final }
}

function submissionPayload(intent) {
  return {
    contract: intent.symbol,
    size: intent.size,
    price: intent.price,
    tif: 'gtc',
    text: intent.intent_id,
    ...(intent.reduce_only === true ? { reduce_only: true } : {})
  }
}

async function identifiableFills(client, plan, intent, order, options) {
  const expectedOrderId = String(order?.id ?? order?.order_id ?? '')
  if (!expectedOrderId) return { fills: [], contracts: '0' }
  const result = await client.usdmTrades({ contract: intent.symbol, order: expectedOrderId, limit: 100 })
  const rows = Array.isArray(result.data) ? result.data : []
  const seen = new Set()
  const fills = []
  const multiplier = String(plan.proofs?.[intent.symbol]?.rule?.quanto_multiplier || '')
  for (const row of rows) {
    const id = row.id ?? row.trade_id
    const contracts = decimalAbs(String(row.size ?? row.contracts ?? '0'))
    const price = String(row.price ?? '')
    const rowOrderId = String(row.order_id ?? row.order ?? '')
    const rowText = String(row.text || '')
    const rowContract = row?.contract === undefined && row?.symbol === undefined ? intent.symbol : exactPair(row.contract || row.symbol)
    if (id === undefined || id === null || id === '' || seen.has(String(id)) || rowOrderId !== expectedOrderId || rowContract !== intent.symbol || (rowText && rowText !== intent.intent_id) || !/^\d+$/.test(contracts) || !Number.isSafeInteger(Number(contracts)) || !decimalPositive(contracts) || !decimalPositive(price) || !decimalPositive(multiplier)) continue
    seen.add(String(id))
    const fill = {
      id: String(id),
      product: 'usdm',
      environment: 'testnet',
      plan_id: plan.plan_id,
      intent_id: intent.intent_id,
      symbol: intent.symbol,
      contracts,
      price,
      notional: decimalMultiply(decimalMultiply(contracts, multiplier), price),
      order_id: rowOrderId,
      at: nowIso(options.now || Date.now),
      ...(options.fillMetadata || {})
    }
    appendRecord(options.ledgerPath, { kind: 'FILL', fill })
    fills.push(fill)
  }
  const contracts = fills.reduce((sum, fill) => decimalAdd(sum, fill.contracts), '0')
  return { fills, contracts }
}

async function submitWithIdentity(client, plan, intent, payload, options) {
  const owner = newReservationOwner()
  const capacity = options.capacity || {}
  const limits = {
    dailyCap: options.config?.gate?.usdm?.daily_new_notional_cap_usdt,
    managedCap: options.config?.gate?.usdm?.max_managed_notional_usdt,
    configuredLeverage: options.config?.gate?.usdm?.configured_leverage,
    availableQuote: capacity.funding?.available_quote,
    accountSnapshotAt: capacity.funding?.generated_at,
    quotes: capacity.quotes,
    rules: capacity.rules,
    now: options.now,
    owner,
    allowRedCauseIds: options.allowRedCauseIds || [],
    eventExtra: options.eventExtra || {}
  }
  let claim
  if (options.reservationRecovery?.kind === 'NOT_FOUND') {
    claim = releaseAndReclaimSubmission(options.ledgerPath, plan, intent, options.reservationRecovery.reservation, options.reservationRecovery.evidence, nowIso(options.now || Date.now), limits)
  } else {
    claim = claimSubmission(options.ledgerPath, plan, intent, nowIso(options.now || Date.now), limits)
  }
  if (!claim.claimed && claim.state === 'SUBMISSION_RESERVED' && !reservationOwnerActive(claim.reservation_event)) {
    const recovery = await inspectReservedIntent(client, plan, intent, claim.reservation_event, options)
    if (recovery.kind === 'FOUND') return { ok: true, order: recovery.order, recovered: true, preclassified: recovery.state, fillProof: recovery.fillProof }
    if (recovery.kind === 'NOT_FOUND') claim = releaseAndReclaimSubmission(options.ledgerPath, plan, intent, recovery.reservation, recovery.evidence, nowIso(options.now || Date.now), limits)
    else return { ok: false, duplicate: recovery.kind === 'ACTIVE' || recovery.kind === 'CHANGED', state: recovery.state || 'RECONCILE_RED', code: recovery.code || null }
  }
  if (!claim.claimed) {
    if (claim.code) return { ...blocked(claim.code, `Atomic reservation blocked by ${claim.state}`), capacityBlocked: true, state: claim.state }
    return { ok: false, duplicate: true, state: claim.state }
  }
  ACTIVE_RESERVATION_OWNERS.add(owner.id)
  let acknowledged = false
  try {
    const response = await client.usdmPlaceOrder(payload)
    acknowledged = true
    let order = response.data
    if (order?.id === undefined && order?.order_id === undefined) order = await exactOrder(client, intent.intent_id, null, intent)
    requireExactOrderIdentity(order, intent)
    appendRecord(options.ledgerPath, eventFor(plan, intent, 'SUBMITTED', nowIso(options.now || Date.now), { exchange_order_id: String(order?.id ?? order?.order_id ?? ''), ...(options.eventExtra || {}) }))
    return { ok: true, order }
  } catch (error) {
    if (error.rateLimited) {
      appendRecord(options.ledgerPath, eventFor(plan, intent, 'RECONCILE_RED', nowIso(options.now || Date.now), { sticky: true, reason: 'Rate limited after submission reservation', ...(options.eventExtra || {}) }))
      return blocked('RATE_LIMITED_AFTER_RESERVATION', 'Submission outcome cannot be safely repeated')
    }
    if (!acknowledged && !isAmbiguousSubmit(error)) {
      const status = Number(error.status)
      const venueReached = Number.isFinite(status) && status >= 400 && status < 500
      appendRecord(options.ledgerPath, eventFor(plan, intent, 'REJECTED', nowIso(options.now || Date.now), { error_code: error.label || error.code || 'SUBMIT_REJECTED', reason: safeText(error.message || error), venue_reached: venueReached, ...(options.eventExtra || {}) }))
      return { ...blocked(error.label || error.code || 'SUBMIT_REJECTED', venueReached ? 'Exchange rejected the order' : 'Local transport validation blocked the order before venue acknowledgement'), rejected: venueReached, localBlocked: !venueReached }
    }
    appendRecord(options.ledgerPath, eventFor(plan, intent, 'SUBMISSION_AMBIGUOUS', nowIso(options.now || Date.now), { error_code: error.code || null, ...(options.eventExtra || {}) }))
    try {
      const order = await exactOrder(client, intent.intent_id, null, intent)
      const state = classifyOrder(order)
      if (state.state === 'UNKNOWN') throwCode('AMBIGUOUS_STATE_UNKNOWN', 'Recovered order has unknown state')
      const recoveredState = ['FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED', 'RECONCILE_RED'].includes(state.state) ? state.state : 'SUBMITTED'
      appendRecord(options.ledgerPath, eventFor(plan, intent, recoveredState, nowIso(options.now || Date.now), { exchange_order_id: String(order?.id ?? order?.order_id ?? ''), executed_contracts: state.executed_contracts, recovered_by_identity: true, ...(recoveredState === 'REJECTED' ? { venue_reached: true } : {}), ...(options.eventExtra || {}) }))
      return { ok: true, order, recovered: true, preclassified: state }
    } catch {
      appendRecord(options.ledgerPath, eventFor(plan, intent, 'RECONCILE_RED', nowIso(options.now || Date.now), { sticky: true, reason: 'Ambiguous submission was not resolved by exact order identity', ...(options.eventExtra || {}) }))
      return blocked('AMBIGUOUS_SUBMISSION_UNRESOLVED', 'No blind retry was attempted')
    }
  } finally {
    ACTIVE_RESERVATION_OWNERS.delete(owner.id)
  }
}

async function cancelProtection(client, plan, intent, order, options) {
  const id = order?.id ?? order?.order_id
  if (id === undefined || id === null) return false
  appendRecord(options.ledgerPath, eventFor(plan, intent, 'CANCEL_REQUESTED', nowIso(options.now || Date.now), { exchange_order_id: String(id) }))
  try {
    await client.usdmCancelPriceOrder({ order_id: String(id) })
    appendRecord(options.ledgerPath, eventFor(plan, intent, 'CANCELLED', nowIso(options.now || Date.now), { exchange_order_id: String(id) }))
    return true
  } catch {
    try {
      const current = await findPriceOrder(client, intent.intent_id, id)
      const status = String(current?.status || '').toLowerCase()
      if (['finished', 'cancelled', 'canceled'].includes(status)) {
        appendRecord(options.ledgerPath, eventFor(plan, intent, 'CANCELLED', nowIso(options.now || Date.now), { exchange_order_id: String(id) }))
        return true
      }
    } catch {}
    return false
  }
}

function protectionFailureCause(ledgerPath, plan, parent, child, error, options) {
  const latest = latestIntentEvent(readLedger(ledgerPath), child.intent_id)
  const reason = latest?.state === 'SUBMISSION_AMBIGUOUS'
    ? 'Ambiguous submission was not resolved by exact order identity'
    : `Protection child failed: ${safeText(error.code || error.message || error)}`
  if (latest?.state !== 'RECONCILE_RED' && latest && allowedTransition(latest.state, 'RECONCILE_RED')) {
    appendRecord(ledgerPath, eventFor(plan, child, 'RECONCILE_RED', nowIso(options.now || Date.now), {
      sticky: true,
      reason,
      parent_intent_id: parent.intent_id,
      protection_role: child.protection_role || null
    }))
  }
  const causes = unresolvedRedCauses(readLedger(ledgerPath))
  const childCause = causes.find((cause) => cause.intent_id === child.intent_id)
  return { childCause, relatedCauses: causes.filter((cause) => cause.intent_id === child.intent_id || cause.intent_id === parent.intent_id) }
}

async function emergencyReduce(client, plan, parent, childCause, relatedCauses, contracts, options) {
  const exactContracts = Number(contracts)
  if (!Number.isSafeInteger(exactContracts) || exactContracts <= 0) return blocked('CONTRACT_COUNT_UNSAFE', 'Emergency reduction requires an exact positive contract count')
  if (!childCause?.cause_id || childCause.intent_id === parent.intent_id) return blocked('EMERGENCY_CAUSE_UNPROVEN', 'Emergency reduction requires the exact failed protection-child cause')
  const size = parent.size > 0 ? -exactContracts : exactContracts
  const identity = buildOrderText({ plan_id: plan.plan_id, parent: parent.intent_id, cause_id: childCause.cause_id, cause_intent_id: childCause.intent_id, contracts, size }, 'emergency')
  const intent = { ...parent, intent_id: identity, text: identity, role: 'EMERGENCY_REDUCTION', action: parent.size > 0 ? 'EXIT_LONG' : 'EXIT_SHORT', size, price: '0', reduce_only: true, quantity: contracts }
  const eventExtra = {
    emergency_parent_intent_id: parent.intent_id,
    emergency_cause_id: childCause.cause_id,
    emergency_cause_intent_id: childCause.intent_id,
    emergency_contracts: String(contracts),
    emergency_signed_contracts: String(size)
  }
  const submitted = await submitWithIdentity(client, plan, intent, { contract: intent.symbol, size, price: '0', tif: 'ioc', text: identity, reduce_only: true }, {
    ...options,
    allowRedCauseIds: relatedCauses.map((cause) => cause.cause_id),
    eventExtra
  })
  if (!submitted.ok) return submitted
  let final
  try {
    final = await pollOrder(client, plan, intent, submitted.order, { ...options, eventExtra, config: { ...options.config, gate: { ...options.config.gate, entry_watch_seconds: 5 } } })
  } catch (error) {
    appendRecord(options.ledgerPath, eventFor(plan, intent, 'RECONCILE_RED', nowIso(options.now || Date.now), { sticky: true, reason: safeText(error.code || error.message || error), ...eventExtra }))
    return blocked(error.code || 'EMERGENCY_REDUCTION_UNPROVEN', error.message)
  }
  const state = final.state
  const exchangeOrderId = String(final.order?.id ?? final.order?.order_id ?? '')
  if (state.state !== 'FILLED' || !exchangeOrderId || !decimalPositive(state.executed_contracts)) {
    if (['CANCELLED', 'REJECTED', 'RECONCILE_RED'].includes(state.state)) {
      const previous = latestIntentEvent(readLedger(options.ledgerPath), intent.intent_id)?.state || 'PLANNED'
      if (previous !== state.state && allowedTransition(previous, state.state)) appendRecord(options.ledgerPath, eventFor(plan, intent, state.state, nowIso(options.now || Date.now), { exchange_order_id: exchangeOrderId, executed_contracts: state.executed_contracts, ...(state.state === 'REJECTED' ? { venue_reached: true } : {}), ...eventExtra }))
    }
    return blocked('EMERGENCY_REDUCTION_UNPROVEN', 'Emergency reduce-only close was not proven filled')
  }
  let fillProof
  try {
    fillProof = await identifiableFills(client, plan, intent, final.order, {
      ...options,
      fillMetadata: {
        ledger_role: 'EMERGENCY_REDUCTION',
        parent_intent_id: parent.intent_id,
        cause_id: childCause.cause_id,
        cause_intent_id: childCause.intent_id,
        signed_contracts: String(size)
      }
    })
  } catch {
    fillProof = { fills: [], contracts: '0' }
  }
  if (!decimalPositive(fillProof.contracts) || decimalCompare(fillProof.contracts, state.executed_contracts) !== 0) {
    appendRecord(options.ledgerPath, eventFor(plan, intent, 'RECONCILE_RED', nowIso(options.now || Date.now), { sticky: true, exchange_order_id: exchangeOrderId, reason: 'Emergency execution lacks exact identifiable fills', ...eventExtra }))
    return blocked('EMERGENCY_FILL_IDENTITY_UNPROVEN', 'Emergency reduction fill proof is incomplete')
  }
  const previous = latestIntentEvent(readLedger(options.ledgerPath), intent.intent_id)?.state || 'PLANNED'
  if (previous !== 'FILLED') appendRecord(options.ledgerPath, eventFor(plan, intent, 'FILLED', nowIso(options.now || Date.now), { exchange_order_id: exchangeOrderId, executed_contracts: fillProof.contracts, ...eventExtra }))
  return { ok: true, outcome: 'EMERGENCY_REDUCED', exchange_order_id: exchangeOrderId, filled_contracts: fillProof.contracts, trade_ids: fillProof.fills.map((fill) => fill.id) }
}

async function placeProtection(client, plan, parent, contracts, options) {
  const exactContracts = Number(contracts)
  if (!Number.isSafeInteger(exactContracts) || exactContracts <= 0) {
    appendRecord(options.ledgerPath, eventFor(plan, parent, 'RECONCILE_RED', nowIso(options.now || Date.now), { sticky: true, reason: 'Fill contract count is outside the exact integer range' }))
    return blocked('CONTRACT_COUNT_UNSAFE', 'Protection requires an exact positive fill contract count')
  }
  appendRecord(options.ledgerPath, eventFor(plan, parent, 'PROTECTION_PENDING', nowIso(options.now || Date.now), { proven_fill_contracts: contracts }))
  const closeSize = parent.size > 0 ? -exactContracts : exactContracts
  const stopRule = parent.size > 0 ? 2 : 1
  const targetRule = parent.size > 0 ? 1 : 2
  const specifications = [
    { role: 'stop', price: parent.protection.stop_price, rule: stopRule },
    { role: 'target', price: parent.protection.target_price, rule: targetRule }
  ]
  const created = []
  let failedChild = null
  try {
    for (const specification of specifications) {
      const identity = buildOrderText({ plan_id: plan.plan_id, parent: parent.intent_id, contracts, price: specification.price }, specification.role)
      const child = { ...parent, intent_id: identity, text: identity, role: 'PROTECTION', action: parent.action, size: closeSize, quantity: contracts, reduce_only: true, parent_intent_id: parent.intent_id, protection_role: specification.role }
      failedChild = child
      const childEventExtra = { parent_intent_id: parent.intent_id, protection_role: specification.role }
      const payload = {
        initial: { contract: parent.symbol, size: closeSize, price: '0', tif: 'ioc', text: identity, reduce_only: true },
        trigger: { strategy_type: 0, price_type: 1, price: specification.price, rule: specification.rule, expiration: 86400 }
      }
      const parentCauseIds = unresolvedRedCauses(readLedger(options.ledgerPath)).filter((cause) => cause.intent_id === parent.intent_id).map((cause) => cause.cause_id)
      const owner = newReservationOwner()
      const claim = claimSubmission(options.ledgerPath, plan, child, nowIso(options.now || Date.now), { owner, allowRedCauseIds: parentCauseIds, eventExtra: childEventExtra })
      if (!claim.claimed) throwCode('PROTECTION_IDENTITY_REUSED', `Protection identity already has state ${claim.state}`)
      ACTIVE_RESERVATION_OWNERS.add(owner.id)
      let order
      let acknowledged = false
      let recoveredByIdentity = false
      try {
        const response = await client.usdmPlacePriceOrder(payload)
        acknowledged = true
        order = response.data
        if (order?.id === undefined && order?.order_id === undefined) order = await findPriceOrder(client, identity)
      } catch (error) {
        if (!acknowledged && !isAmbiguousSubmit(error)) {
          appendRecord(options.ledgerPath, eventFor(plan, child, 'REJECTED', nowIso(options.now || Date.now), { error_code: error.code || null, reason: safeText(error.message || error), ...childEventExtra }))
          throw error
        }
        appendRecord(options.ledgerPath, eventFor(plan, child, 'SUBMISSION_AMBIGUOUS', nowIso(options.now || Date.now), childEventExtra))
        order = await findPriceOrder(client, identity)
        recoveredByIdentity = true
      } finally {
        ACTIVE_RESERVATION_OWNERS.delete(owner.id)
      }
      requireExactOrderIdentity(order, child, 'protection order')
      if (!protectionIsActive(order)) throwCode('PROTECTION_NOT_ACTIVE', `${specification.role} protection is not explicitly open`)
      appendRecord(options.ledgerPath, eventFor(plan, child, 'SUBMITTED', nowIso(options.now || Date.now), { exchange_order_id: String(order?.id ?? order?.order_id ?? ''), ...childEventExtra, ...(recoveredByIdentity ? { recovered_by_identity: true } : {}) }))
      created.push({ child, order })
      failedChild = null
    }
    appendRecord(options.ledgerPath, eventFor(plan, parent, 'PROTECTED', nowIso(options.now || Date.now), { proven_fill_contracts: contracts, protection_orders: created.map((row) => String(row.order?.id ?? row.order?.order_id ?? '')) }))
    return { ok: true, protected: true, orders: created.length }
  } catch (error) {
    for (const row of created) await cancelProtection(client, plan, row.child, row.order, options)
    const failure = failedChild ? protectionFailureCause(options.ledgerPath, plan, parent, failedChild, error, options) : { childCause: null, relatedCauses: [] }
    const emergency = await emergencyReduce(client, plan, parent, failure.childCause, failure.relatedCauses, contracts, options)
    appendRecord(options.ledgerPath, eventFor(plan, parent, 'RECONCILE_RED', nowIso(options.now || Date.now), { sticky: true, reason: `Protection failed: ${safeText(error.code || error.message || error)}`, emergency_outcome: emergency.ok ? emergency.outcome : emergency.code, protection_cause_id: failure.childCause?.cause_id || null }))
    return blocked('PROTECTION_FAILED', 'Protection was not proven active; exact-size emergency reduction was attempted', emergency)
  }
}

function lifecycleForPlan(ledger, planId) {
  const events = ledger.events.filter((event) => event.plan_id === planId)
  const fills = ledger.fills.filter((fill) => fill.plan_id === planId)
  return events.map((event) => {
    const related = fills.filter((fill) => fill.intent_id === event.intent_id)
    const contracts = related.reduce((sum, fill) => decimalAdd(sum, fill.contracts), '0')
    const value = related.reduce((sum, fill) => decimalAdd(sum, decimalMultiply(fill.contracts, fill.price)), '0')
    const average = decimalPositive(contracts) ? Number(value) / Number(contracts) : null
    return {
      status: event.state,
      intent_id: event.intent_id,
      symbol: event.symbol,
      exchange_order_id: event.exchange_order_id || null,
      at: event.at,
      ...(event.error_code ? { code: event.error_code, reason: event.reason || null } : {}),
      ...(event.venue_reached !== undefined ? { venue_reached: event.venue_reached } : {}),
      ...(related.length ? { fill_id: related.map((fill) => fill.id).join(','), filled_quantity: Number(contracts), average_fill_price: average } : {})
    }
  })
}

function executionSummary(plan, ledgerPath, results) {
  const ledger = readLedger(ledgerPath)
  const lifecycle = lifecycleForPlan(ledger, plan.plan_id)
  const submittedCount = new Set(lifecycle.filter((event) => ['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'PROTECTION_PENDING', 'PROTECTED', 'RECONCILE_RED'].includes(event.status) || (event.status === 'REJECTED' && event.venue_reached === true)).map((event) => event.intent_id)).size
  const counts = {
    submitted: submittedCount,
    filled: new Set(ledger.fills.filter((fill) => fill.plan_id === plan.plan_id).map((fill) => fill.intent_id)).size,
    rejected: new Set(lifecycle.filter((event) => event.status === 'REJECTED' && event.venue_reached === true).map((event) => event.intent_id)).size,
    cancelled: new Set(lifecycle.filter((event) => event.status === 'CANCELLED').map((event) => event.intent_id)).size
  }
  const unresolved = unresolvedRedCauses(ledger)
  const outcome = unresolved.length > 0 || results.some((row) => row.outcome === 'RECONCILE_RED')
    ? 'RECONCILE_RED'
    : results.some((row) => row.outcome === 'REJECTED')
      ? 'REJECTED'
      : results.some((row) => row.outcome === 'BLOCKED')
        ? 'BLOCKED'
        : results.length > 0 && results.every((row) => row.outcome === 'DUPLICATE_SUPPRESSED')
          ? 'DUPLICATE_SUPPRESSED'
          : 'COMPLETE'
  return {
    outcome,
    venue: String(plan.venue || 'gate'),
    product: 'usdm',
    environment: 'testnet',
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    planned_orders: plan.intents.map((intent) => ({ symbol: intent.symbol, product: intent.product, position_intent: intent.action, entry_price: intent.price })),
    results,
    lifecycle,
    counts,
    sticky_red: unresolved.length > 0,
    unresolved_red_causes: unresolved
  }
}

export async function executePlan(plan, options = {}) {
  if (options.executionMode === 'automatic_testnet' && String(options.venue || '').toLowerCase() === 'binance') {
    try {
      options = { ...options, config: mapExecutionConfig(options.config, 'binance') }
    } catch (error) {
      return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...blocked(error.code || 'CONFIG_INVALID', safeText(error.message || error)), lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
    }
  }
  const ledgerPath = options.ledgerPath || LEDGER_PATH
  const gate = options.executionMode === 'automatic_testnet'
    ? staticAutomaticExecutionGate(plan, { ...options, ledgerPath })
    : staticExecutionGate(plan, { ...options, ledgerPath })
  let recoveryOnly = false
  if (!gate.ok) {
    if (gate.code !== 'PLAN_EXPIRED') return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...gate, lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
    const recoveryGate = staticReservationRecoveryGate(plan, { ...options, ledgerPath })
    if (!recoveryGate.ok) return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...recoveryGate, lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
    if (!recoveryGate.reservations.length) return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...gate, lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
    recoveryOnly = true
  }
  if (!options.client) return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...blocked('CLIENT_REQUIRED', 'An injected USDT-M testnet client is required'), lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
  const reportedVenue = String(options.client.venue || '').trim().toLowerCase()
  const reportedProduct = String(options.client.product || '').trim().toLowerCase()
  const reportedEnvironment = String(options.client.environment || '').trim().toLowerCase()
  if (reportedVenue && reportedVenue !== String(plan.venue || '').toLowerCase()) return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...blocked('CLIENT_VENUE_MISMATCH', 'Client venue does not match the sealed plan'), lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
  if (reportedProduct && reportedProduct !== 'usdm') return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...blocked('CLIENT_PRODUCT_MISMATCH', 'Execution requires a USDT-M client'), lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
  if (reportedEnvironment && reportedEnvironment !== 'testnet') return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...blocked('CLIENT_ENVIRONMENT_MISMATCH', 'Execution requires a testnet client'), lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
  let recoveries
  try { recoveries = await recoverReservedBeforePreflight(options.client, plan, { ...options, ledgerPath }) } catch (error) {
    return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...blocked(error.code || 'RESERVATION_RECOVERY_FAILED', safeText(error.message || error)), lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
  }
  if (recoveryOnly) {
    for (const [intentId, recovery] of recoveries.entries()) {
      if (recovery.kind !== 'NOT_FOUND') continue
      const intent = plan.intents.find((candidate) => candidate.intent_id === intentId)
      const released = releaseReservedSubmission(ledgerPath, plan, intent, recovery.reservation, recovery.evidence, nowIso(options.now || Date.now))
      recoveries.set(intentId, { kind: released.released ? 'RELEASED' : 'CHANGED', state: released.state })
    }
  }
  const recoveryRed = [...recoveries.entries()].filter(([, recovery]) => recovery.kind === 'RED')
  if (recoveryRed.length) return executionSummary(plan, ledgerPath, recoveryRed.map(([intentId, recovery]) => ({ intent_id: intentId, outcome: 'RECONCILE_RED', code: recovery.code })))
  if (recoveries.size === plan.intents.length && [...recoveries.values()].every((recovery) => ['ACTIVE', 'CHANGED'].includes(recovery.kind))) {
    return executionSummary(plan, ledgerPath, plan.intents.map((intent) => ({ intent_id: intent.intent_id, outcome: 'DUPLICATE_SUPPRESSED', state: recoveries.get(intent.intent_id)?.state || 'SUBMISSION_RESERVED' })))
  }
  const foundRecoveries = [...recoveries.values()].filter((recovery) => recovery.kind === 'FOUND')
  const results = recoveryOnly
    ? plan.intents.flatMap((intent) => {
        const recovery = recoveries.get(intent.intent_id)
        if (recovery?.kind === 'FOUND') return []
        if (recovery?.kind === 'ACTIVE' || recovery?.kind === 'CHANGED') return [{ intent_id: intent.intent_id, outcome: 'DUPLICATE_SUPPRESSED', state: recovery.state || 'SUBMISSION_RESERVED' }]
        return [{ intent_id: intent.intent_id, outcome: 'BLOCKED', code: 'PLAN_EXPIRED', state: recovery?.state || 'PLANNED' }]
      })
    : []
  if (recoveryOnly && !foundRecoveries.length) {
    const summary = executionSummary(plan, ledgerPath, results)
    return { ...summary, outcome: summary.outcome === 'RECONCILE_RED' ? summary.outcome : 'BLOCKED', code: 'PLAN_EXPIRED', message: gate.message }
  }
  const pendingProtectionIntentIds = [...recoveries.entries()].filter(([, recovery]) => recovery.pendingProtection).map(([intentId]) => intentId)
  let dynamic
  try { dynamic = await dynamicExecutionPreflight(plan, { ...options, ledgerPath, pendingProtectionIntentIds, recoveryOnly }) } catch (error) { dynamic = blocked(error.code || 'DYNAMIC_PREFLIGHT_FAILED', safeText(error.message || error)) }
  if (!dynamic.ok) {
    if (recoveries.size) return executionSummary(plan, ledgerPath, [...results, { intent_id: null, outcome: 'BLOCKED', code: dynamic.code }])
    return { outcome: 'BLOCKED', product: plan.product, environment: plan.environment, ...dynamic, lifecycle: [], counts: { submitted: 0, filled: 0, rejected: 0, cancelled: 0 } }
  }

  for (const intent of plan.intents) {
    const recovery = recoveries.get(intent.intent_id)
    if (recoveryOnly && recovery?.kind !== 'FOUND') continue
    if (recovery && ['ACTIVE', 'CHANGED'].includes(recovery.kind)) {
      results.push({ intent_id: intent.intent_id, outcome: 'DUPLICATE_SUPPRESSED', state: recovery.state || 'SUBMISSION_RESERVED' })
      continue
    }
    const submitted = recovery?.kind === 'FOUND'
      ? { ok: true, order: recovery.order, recovered: true, preclassified: recovery.state, fillProof: recovery.fillProof }
      : await submitWithIdentity(options.client, plan, intent, submissionPayload(intent), {
          ...options,
          ledgerPath,
          capacity: dynamic,
          reservationRecovery: recovery?.kind === 'NOT_FOUND' ? recovery : null
        })
    if (!submitted.ok) {
      const outcome = submitted.duplicate ? 'DUPLICATE_SUPPRESSED' : submitted.rejected ? 'REJECTED' : submitted.localBlocked || submitted.capacityBlocked ? 'BLOCKED' : submitted.code
      results.push({ intent_id: intent.intent_id, outcome, code: submitted.code || null, state: submitted.state || null })
      if (!submitted.duplicate || submitted.state === 'STICKY_RECONCILE_RED') break
      continue
    }
    let final
    try {
      final = await pollOrder(options.client, plan, intent, submitted.order, { ...options, ledgerPath })
    } catch (error) {
      appendRecord(ledgerPath, eventFor(plan, intent, 'RECONCILE_RED', nowIso(options.now || Date.now), { sticky: true, reason: safeText(error.code || error.message || error) }))
      results.push({ intent_id: intent.intent_id, outcome: 'RECONCILE_RED', code: error.code || 'ORDER_STATE_UNPROVEN' })
      break
    }
    const finalState = ['FILLED', 'PARTIALLY_FILLED', 'RECONCILE_RED', 'REJECTED', 'CANCELLED'].includes(final.state.state) ? final.state.state : 'RECONCILE_RED'
    const previous = latestIntentEvent(readLedger(ledgerPath), intent.intent_id)?.state
    if (previous !== finalState && allowedTransition(previous || 'PLANNED', finalState)) appendRecord(ledgerPath, eventFor(plan, intent, finalState, nowIso(options.now || Date.now), { exchange_order_id: String(final.order?.id ?? final.order?.order_id ?? ''), executed_contracts: final.state.executed_contracts, ...(finalState === 'REJECTED' ? { venue_reached: true } : {}) }))
    if (!decimalPositive(final.state.executed_contracts)) {
      results.push({ intent_id: intent.intent_id, outcome: finalState, filled_contracts: '0' })
      continue
    }
    let fillProof = submitted.fillProof
    if (!fillProof || decimalCompare(fillProof.contracts || '0', final.state.executed_contracts) !== 0) {
      try { fillProof = await identifiableFills(options.client, plan, intent, final.order, { ...options, ledgerPath }) } catch { fillProof = { fills: [], contracts: '0' } }
    }
    if (!decimalPositive(fillProof.contracts) || decimalCompare(fillProof.contracts, final.state.executed_contracts) !== 0) {
      appendRecord(ledgerPath, eventFor(plan, intent, 'RECONCILE_RED', nowIso(options.now || Date.now), { sticky: true, reason: 'Executed contracts do not match identifiable exchange fills' }))
      results.push({ intent_id: intent.intent_id, outcome: 'RECONCILE_RED', code: 'FILL_IDENTITY_UNPROVEN' })
      break
    }
    if (intent.role === 'ENTRY' && intent.protection?.required) {
      const protection = await placeProtection(options.client, plan, intent, fillProof.contracts, { ...options, ledgerPath })
      results.push({ intent_id: intent.intent_id, outcome: protection.ok ? 'PROTECTED' : 'RECONCILE_RED', filled_contracts: fillProof.contracts, protection })
      if (!protection.ok) break
    } else {
      results.push({ intent_id: intent.intent_id, outcome: finalState, filled_contracts: fillProof.contracts })
    }
  }
  return executionSummary(plan, ledgerPath, results)
}

function unknownIdentityEvidence(cause, checkedAt, extra = {}) {
  return {
    cause_id: cause.cause_id,
    source_event_id: cause.source_event_id,
    intent_id: cause.intent_id,
    client_order_id: cause.client_order_id,
    order_id: extra.order_id || null,
    exact_client_text: extra.exact_client_text === true,
    exact_order_id: false,
    terminal_status: 'UNKNOWN',
    terminal: false,
    terminal_reason: extra.terminal_reason || null,
    executed_contracts: '0',
    cancellation_proof: false,
    venue_rejection: false,
    definitive_not_found: false,
    not_found_identities: extra.not_found_identities || [],
    trades_complete: false,
    checked_at: checkedAt
  }
}

function identityEvidenceFromOrder(cause, order, checkedAt) {
  const orderId = String(order?.id ?? order?.order_id ?? '')
  const returnedText = String(order?.text || '')
  if (!orderId || returnedText !== cause.client_order_id) return unknownIdentityEvidence(cause, checkedAt, { order_id: orderId, terminal_reason: 'IDENTITY_MISMATCH' })
  if (cause.exchange_order_id && orderId !== cause.exchange_order_id) return unknownIdentityEvidence(cause, checkedAt, { order_id: orderId, exact_client_text: true, terminal_reason: 'ORDER_ID_MISMATCH' })
  const state = classifyOrder(order)
  const finish = String(order?.finish_as || '').toLowerCase()
  const status = String(order?.status || '').toLowerCase()
  return {
    cause_id: cause.cause_id,
    source_event_id: cause.source_event_id,
    intent_id: cause.intent_id,
    client_order_id: cause.client_order_id,
    order_id: orderId,
    exact_client_text: true,
    exact_order_id: true,
    terminal_status: state.state,
    terminal: state.terminal,
    terminal_reason: finish || status || null,
    executed_contracts: state.executed_contracts,
    cancellation_proof: state.state === 'CANCELLED' && ['cancelled', 'canceled', 'ioc', 'stp', 'expired'].includes(finish || status),
    venue_rejection: state.state === 'REJECTED' && ['rejected', 'reject', 'failed'].includes(finish || status),
    definitive_not_found: false,
    not_found_identities: [],
    trades_complete: false,
    checked_at: checkedAt
  }
}

async function exactIdentityLookup(client, cause, current) {
  const checkedAt = nowIso(current)
  const misses = []
  let order = null
  try {
    order = await client.findUsdmOrderByText(cause.client_order_id)
  } catch (error) {
    if (isDefinitiveOrderNotFound(error, cause.client_order_id)) misses.push(cause.client_order_id)
    else return unknownIdentityEvidence(cause, checkedAt, { terminal_reason: error?.code || 'CLIENT_TEXT_LOOKUP_FAILED' })
  }
  if (!order && cause.exchange_order_id) {
    try {
      order = (await client.usdmOrder({ order_id: cause.exchange_order_id })).data
    } catch (error) {
      if (isDefinitiveOrderNotFound(error, cause.exchange_order_id)) misses.push(cause.exchange_order_id)
      else return unknownIdentityEvidence(cause, checkedAt, { exact_client_text: misses.includes(cause.client_order_id), order_id: cause.exchange_order_id, not_found_identities: misses, terminal_reason: error?.code || 'ORDER_ID_LOOKUP_FAILED' })
    }
  }
  if (!order) {
    const complete = misses.includes(cause.client_order_id) && (!cause.exchange_order_id || misses.includes(cause.exchange_order_id))
    return {
      ...unknownIdentityEvidence(cause, checkedAt, { exact_client_text: misses.includes(cause.client_order_id), order_id: cause.exchange_order_id, not_found_identities: misses }),
      exact_order_id: cause.exchange_order_id ? misses.includes(cause.exchange_order_id) : false,
      terminal_status: complete ? 'NOT_FOUND' : 'UNKNOWN',
      terminal: complete,
      definitive_not_found: complete
    }
  }
  const discoveredOrderId = String(order.id ?? order.order_id ?? '')
  if (!discoveredOrderId) return unknownIdentityEvidence(cause, checkedAt, { exact_client_text: String(order?.text || '') === cause.client_order_id, terminal_reason: 'ORDER_ID_MISSING' })
  try {
    const byId = (await client.usdmOrder({ order_id: discoveredOrderId })).data
    const returnedOrderId = String(byId?.id ?? byId?.order_id ?? '')
    if (returnedOrderId !== discoveredOrderId) return unknownIdentityEvidence(cause, checkedAt, { exact_client_text: true, order_id: discoveredOrderId, terminal_reason: 'ORDER_ID_RESPONSE_MISMATCH' })
    order = byId
  } catch (error) {
    return unknownIdentityEvidence(cause, checkedAt, { exact_client_text: true, order_id: discoveredOrderId, terminal_reason: error?.code || 'ORDER_ID_CONFIRMATION_FAILED' })
  }
  return identityEvidenceFromOrder(cause, order, checkedAt)
}

async function reconcileWithClient(client, ledger, current, requestedCauseIds = []) {
  const snapshot = await collectUsdmSnapshot(client, ['BTC_USDT', 'ETH_USDT'], current)
  const causes = unresolvedRedCauses(ledger).filter((cause) => ['AMBIGUOUS_SUBMISSION', 'RECONCILE_EVENT'].includes(cause.type))
  snapshot.identity_resolutions = await Promise.all(causes.map((cause) => exactIdentityLookup(client, cause, current)))
  const exactTrades = []
  for (const evidence of snapshot.identity_resolutions) {
    const needsExactTrades = evidence.terminal === true
      && evidence.order_id
      && ['FILLED', 'CANCELLED'].includes(evidence.terminal_status)
    if (!needsExactTrades) continue
    const symbol = intentRecord(ledger, evidence.intent_id)?.intent?.symbol
    if (!symbol) {
      evidence.trades_complete = false
      continue
    }
    try {
      const result = await client.usdmTrades({ contract: symbol, order: evidence.order_id, limit: 100 })
      const rows = Array.isArray(result.data) ? result.data : []
      exactTrades.push(...rows)
      evidence.trades_complete = true
    } catch {
      evidence.trades_complete = false
    }
  }
  const seen = new Set()
  snapshot.trades = [...(snapshot.trades || []), ...exactTrades].filter((trade) => {
    const key = `${exactPair(trade?.contract || trade?.symbol) || ''}:${String(trade?.id ?? trade?.trade_id ?? '')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { snapshot, receipt: reconcileSnapshot(snapshot, ledger, { now: current, requestedCauseIds }) }
}

function planFile(plan) {
  return path.join(ROOT, 'outputs', 'plans', `gate-plan-${plan.plan_id}.json`)
}

function planReportFile(plan) {
  return path.join(ROOT, 'outputs', 'reports', `gate-plan-${plan.plan_id}.md`)
}

function executionReportFile(plan) {
  return path.join(ROOT, 'outputs', 'reports', `gate-execution-${plan.plan_id}.md`)
}

function renderPlanReport(plan, planPath) {
  const planned = plan.intents.map((intent) => ({ symbol: intent.symbol, product: intent.product, position_intent: intent.action, entry_price: intent.price }))
  return renderConciseReport({
    title: `Gate plan ${plan.status}`,
    as_of: plan.created_at,
    scope: { product: plan.product, environment: plan.environment },
    conclusions: [plan.status === 'READY' ? 'A sealed deterministic plan is ready for review.' : plan.status === 'NO_ACTION' ? 'No actionable candidate was present.' : 'The plan is blocked and cannot execute.'],
    execution: { mode: 'dry_run', planned_orders: planned, events: [], submitted: 0, filled: 0, rejected: 0, cancelled: 0 },
    recommendations: planned,
    blockers: plan.blockers,
    risks: plan.product === 'usdm' ? ['Perpetual losses and liquidation can exceed modeled stop behavior.'] : [],
    audit_artifacts: [{ label: 'Sealed plan', path: path.relative(ROOT, planPath).split(path.sep).join('/') }, { label: 'Ledger', path: 'data/gate_order_ledger.json' }]
  })
}

function parseCli(argv) {
  const values = argv.slice(2)
  const command = values[0] || 'status'
  const get = (flag, fallback = null) => {
    const indexes = values.map((value, index) => value === flag ? index : -1).filter((index) => index >= 0)
    if (indexes.length > 1) throwCode('CLI_DUPLICATE_FLAG', `${flag} may be supplied only once`)
    if (!indexes.length) return fallback
    const value = values[indexes[0] + 1]
    if (!value || value.startsWith('--')) throwCode('CLI_ARGUMENT_INVALID', `${flag} requires a value`)
    return value
  }
  if (values.includes('--live') || values.includes('--production') || values.includes('--prod')) throwCode('PRODUCTION_EXECUTION_UNSUPPORTED', 'Production mutation flags are unsupported')
  const environmentIndex = values.indexOf('--environment')
  if (environmentIndex >= 0 && /^(?:live|prod|production)$/i.test(String(values[environmentIndex + 1] || ''))) throwCode('PRODUCTION_EXECUTION_UNSUPPORTED', 'Production mutation environments are unsupported')
  return { command, values, get, has: (flag) => values.includes(flag) }
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function requireJson(filePath, code) {
  if (!filePath) throwCode(code, 'A JSON file path is required')
  return readJsonStrict(path.resolve(filePath))
}

async function planCommand(args, config, configPath) {
  const product = String(args.get('--product', '')).toLowerCase()
  if (!['spot', 'usdm'].includes(product)) throwCode('PRODUCT_REQUIRED', 'plan requires --product spot or usdm')
  const environment = String(args.get('--environment', config.gate[product].environment)).toLowerCase()
  if (/^(?:live|prod|production)$/.test(environment)) throwCode('PRODUCTION_EXECUTION_UNSUPPORTED', 'Production mutation environments are unsupported')
  if (environment !== config.gate[product].environment) throwCode('CONFIG_ENVIRONMENT_MISMATCH', 'CLI environment must match the selected configuration')
  const date = args.get('--date')
  const week = args.get('--iso-week')
  if (!validDate(date) || !validWeek(week)) throwCode('PLAN_ANCHORS_REQUIRED', 'plan requires --date YYYY-MM-DD and --iso-week YYYY-Www')
  const killPath = path.join(ROOT, config.gate.kill_switch_path)
  if (fs.existsSync(killPath)) throwCode('GATE_KILL_ACTIVE', 'Kill switch blocks new plans')
  const source = requireJson(args.get('--source'), 'SOURCE_REQUIRED')
  const weeklyAnchor = readJsonStrict(path.join(ROOT, 'data', 'crypto_strategy.json'), { missingDefault: null })
  const marketSnapshot = readJsonStrict(path.join(ROOT, 'data', 'crypto_market.json'), { missingDefault: null })
  const initialCheck = validateExecutionSource(source, { product, date, isoWeek: week, maxAgeSeconds: config.analysis.candidate_max_age_seconds, weeklyAnchor, weeklyAnchorMaxAgeDays: config.analysis.weekly_anchor_max_age_days })
  const ledger = readLedger()
  let context = { rules: {}, quotes: {}, accounts: {}, reconciliation: null, blockers: [] }
  if (initialCheck.ok) {
    const symbols = [...new Set(initialCheck.candidates.filter((candidate) => upper(candidate.position_intent) !== 'NO_TRADE').map((candidate) => exactPair(candidate.symbol)).filter(Boolean))]
    const market = symbols.length ? marketSnapshotStatus(marketSnapshot, { date, isoWeek: week, now: Date.now(), maxAgeSeconds: config.analysis.candidate_max_age_seconds }) : { ok: true }
    context = market.ok
      ? await acquirePlanningContext({ product, environment, config, symbols, ledger })
      : { rules: {}, quotes: {}, accounts: {}, reconciliation: null, blockers: [{ code: market.code, message: market.message }] }
  }
  const plan = createPlan(source, { product, environment, config, context, ledger, date, isoWeek: week, weeklyAnchor, marketSnapshot })
  if (context.reconciliation) appendRecord(LEDGER_PATH, { kind: 'RECONCILIATION', reconciliation: context.reconciliation })
  appendRecord(LEDGER_PATH, { kind: 'PLAN', plan })
  const target = planFile(plan)
  writeJsonAtomic(target, plan)
  const report = planReportFile(plan)
  writeTextAtomic(report, renderPlanReport(plan, target))
  json({
    outcome: plan.status,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    product,
    environment,
    intents: plan.intents.length,
    blockers: plan.blockers,
    skipped: plan.skipped,
    plan_path: path.relative(ROOT, target).split(path.sep).join('/'),
    report_path: path.relative(ROOT, report).split(path.sep).join('/'),
    config_path: path.relative(ROOT, path.resolve(configPath)).split(path.sep).join('/'),
    submitted: 0,
    filled: 0
  })
}

async function executeCommand(args, config) {
  const planPathRaw = args.get('--plan')
  const plan = requireJson(planPathRaw, 'PLAN_REQUIRED')
  const planId = args.get('--plan-id')
  const planHash = args.get('--hash')
  const confirm = args.get('--confirm')
  const marketSnapshot = readJsonStrict(path.join(ROOT, 'data', 'crypto_market.json'), { missingDefault: null })
  const weeklyAnchor = readJsonStrict(path.join(ROOT, 'data', 'crypto_strategy.json'), { missingDefault: null })
  const executionSource = readJsonStrict(path.join(ROOT, 'data', 'crypto_daily.json'), { missingDefault: null })
  if (!planId || !planHash || !confirm) throwCode('PLAN_CONFIRMATION_REQUIRED', 'execute requires exact plan ID, hash, and confirmation')
  const baseOptions = {
    config,
    planId,
    planHash,
    commit: args.has('--commit'),
    confirm,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ledgerPath: LEDGER_PATH,
    killPath: path.join(ROOT, config.gate.kill_switch_path),
    env: process.env,
    marketSnapshot,
    weeklyAnchor,
    executionSource
  }
  const gate = staticExecutionGate(plan, baseOptions)
  if (!gate.ok) {
    json({ outcome: 'BLOCKED', ...gate, submitted: 0, filled: 0 })
    process.exitCode = 2
    return
  }
  const client = createGateClient({ product: 'usdm', environment: 'testnet', readOnly: false })
  const result = await executePlan(plan, { ...baseOptions, client })
  result.plan_path = path.relative(ROOT, path.resolve(planPathRaw)).split(path.sep).join('/')
  const reportPath = executionReportFile(plan)
  writeTextAtomic(reportPath, renderConciseReport(reportFromExecution(result)))
  json({ ...result, report_path: path.relative(ROOT, reportPath).split(path.sep).join('/') })
  if (result.outcome === 'RECONCILE_RED' || result.outcome === 'BLOCKED') process.exitCode = 2
}

async function reconcileCommand(args, config) {
  const product = String(args.get('--product', '')).toLowerCase()
  const environment = String(args.get('--environment', '')).toLowerCase()
  if (product !== 'usdm' || environment !== 'testnet') throwCode('RECONCILIATION_SCOPE_INVALID', 'Reconciliation supports USDT-M testnet only')
  const ledger = readLedger()
  const unresolved = unresolvedRedCauses(ledger)
  const rawRequested = String(args.get('--resolve-cause', '') || '')
  const requestedCauseIds = rawRequested ? rawRequested.split(',').map((value) => value.trim()).filter(Boolean) : []
  if (new Set(requestedCauseIds).size !== requestedCauseIds.length) throwCode('RECONCILIATION_CAUSE_DUPLICATE', '--resolve-cause must contain unique cause IDs')
  const known = new Set(unresolved.map((cause) => cause.cause_id))
  const unknown = requestedCauseIds.filter((causeId) => !known.has(causeId))
  if (unknown.length) throwCode('RECONCILIATION_CAUSE_MISMATCH', `Unknown or already resolved cause IDs: ${unknown.join(', ')}`)
  const client = createGateClient({ product: 'usdm', environment: 'testnet', readOnly: true })
  const { receipt } = await reconcileWithClient(client, ledger, Date.now, requestedCauseIds)
  appendRecord(LEDGER_PATH, { kind: 'RECONCILIATION', reconciliation: receipt })
  json({ outcome: receipt.status === 'ok' ? 'RECONCILED' : 'RECONCILE_RED', receipt })
  if (receipt.status !== 'ok') process.exitCode = 2
}

function statusCommand(config) {
  const ledger = readLedger()
  const unresolved = unresolvedRedCauses(ledger)
  json({
    outcome: 'STATUS',
    schema: ledger.schema,
    submission_mode: config.gate.submission_mode,
    plans: ledger.plans.length,
    events: ledger.events.length,
    fills: ledger.fills.length,
    reconciliations: ledger.reconciliations.length,
    sticky_red: unresolved.length > 0,
    unresolved_red_causes: unresolved
  })
}

function manualTestConfig() {
  const config = loadConfig()
  const copy = clone(config)
  copy.gate.submission_mode = 'manual_testnet'
  copy.gate.usdm.environment = 'testnet'
  copy.gate.usdm.configured_leverage = 2
  copy.gate.usdm.risk_per_trade_bps = 25
  copy.gate.usdm.max_order_notional_usdt = 100
  copy.gate.usdm.daily_new_notional_cap_usdt = 200
  copy.gate.usdm.max_managed_notional_usdt = 300
  validateConfig(copy)
  return copy
}

export async function selftest() {
  const config = manualTestConfig()
  const current = Date.now()
  const date = new Date(current).toISOString().slice(0, 10)
  const week = isoWeek(current)
  const at = new Date(current).toISOString()
  const source = {
    schema: DAILY_SCHEMA,
    date,
    iso_week: week,
    generated_at: at,
    anchored_week: week,
    anchor_fresh: true,
    execution_candidates: [{
      schema: CANDIDATE_SCHEMA,
      asset: 'BTC',
      product: 'usdm',
      symbol: 'BTC_USDT',
      position_intent: 'ENTER_LONG',
      order_style: 'LIMIT',
      entry_price: 100,
      stop_price: 90,
      take_profit_price: 120,
      reduce_fraction_bps: null,
      data_as_of: at,
      anchor_week: week,
      anchor_fresh: true,
      thesis_invalidation: 'synthetic self-test only',
      evidence_refs: ['selftest'],
      signal_id: 'selftest:btc'
    }]
  }
  const weeklyAnchor = { schema: WEEKLY_SCHEMA, date, iso_week: week, generated_at: at, status: 'active', assets: { BTC: { spot_bias: 'long', usdm_bias: 'long' }, ETH: { spot_bias: 'neutral', usdm_bias: 'neutral' } }, execution_candidates: [] }
  const marketSnapshot = { schema: 'tyche_crypto_market/v1', date, iso_week: week, generated_at: at, assets: { BTC: { usdm: { ticker: { last: '100' }, technical: { daily: { level_sets: { selftest: { entry: 100, stop: 90, target: 120 } } }, four_hour: { level_sets: {} } } } }, ETH: {} } }
  const rule = { name: 'BTC_USDT', order_price_round: '0.1', quanto_multiplier: '0.001', order_size_min: '1', order_size_max: '100000', leverage_max: '3', maintenance_rate: '0.005', maker_fee_rate: '-0.0001', taker_fee_rate: '0.0005', status: 'trading', in_delisting: false, _fetched_at: at }
  const account = { schema: 'tyche_account_epoch/v1', account_epoch_id: 'tae_selftest', product: 'usdm', environment: 'testnet', funding_source: 'usdm_testnet_available', wallet: 'USDT_FUTURES_TESTNET', asset: 'USDT', symbol: 'BTC_USDT', generated_at: at, available_quote: '1000', effective_risk_capital: '1000', managed_quantity: '0', managed_notional: '0', daily_new_notional_used: '0', daily_order_count: 0 }
  const context = { rules: { BTC_USDT: rule }, quotes: { BTC_USDT: { symbol: 'BTC_USDT', price: '100', fetched_at: at } }, accounts: { 'usdm:BTC_USDT': account }, reconciliation: { status: 'ok', generated_at: at, receipt_id: 'tr_selftest', issues: [] }, blockers: [] }
  const plan = createPlan(source, { product: 'usdm', environment: 'testnet', config, context, ledger: EMPTY_LEDGER, date, isoWeek: week, weeklyAnchor, marketSnapshot, now: current })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-selftest-'))
  const ledgerPath = path.join(temp, 'ledger.json')
  const common = { config, planId: plan.plan_id, planHash: plan.plan_hash, confirm: `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`, interactive: true, env: {}, dataDir: temp, ledgerPath, killPath: path.join(temp, 'gate_KILL'), marketSnapshot, weeklyAnchor, executionSource: source, now: current }
  const checks = [
    [plan.status === 'READY', 'ready sealed plan'],
    [verifyPlan(plan, { planId: plan.plan_id, planHash: plan.plan_hash, now: current }).ok, 'plan hash verification'],
    [staticExecutionGate(plan, { ...common, commit: false }).code === 'COMMIT_REQUIRED', 'commit gate'],
    [staticExecutionGate(plan, { ...common, commit: true, confirm: 'wrong' }).code === 'TESTNET_CONFIRMATION_MISMATCH', 'confirmation gate'],
    [staticExecutionGate(plan, { ...common, commit: true, interactive: false }).code === 'REAL_TTY_REQUIRED', 'TTY gate'],
    [staticExecutionGate(plan, { ...common, commit: true, env: { CI: '1' } }).code === 'UNATTENDED_EXECUTION_FORBIDDEN', 'unattended gate'],
    [staticExecutionGate(plan, { ...common, commit: true }).ok, 'all static testnet gates']
  ]
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label)
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed }, null, 2)}\n`)
  return failed.length === 0
}

async function cli(argv) {
  if (argv.slice(2)[0] === 'selftest' || argv.includes('--selftest')) {
    process.exitCode = await selftest() ? 0 : 1
    return
  }
  const args = parseCli(argv)
  const configPath = args.get('--config', path.join(ROOT, 'config', 'tyche.json'))
  const config = loadConfig({ filePath: configPath })
  if (args.command === 'status') return statusCommand(config)
  if (args.command === 'plan') return planCommand(args, config, configPath)
  if (args.command === 'execute') return executeCommand(args, config)
  if (args.command === 'reconcile') return reconcileCommand(args, config)
  throwCode('CLI_COMMAND_UNSUPPORTED', 'Commands: status, plan, execute, reconcile, selftest')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  cli(process.argv).catch((error) => {
    json({ outcome: 'BLOCKED', code: error.code || 'GATE_TRADE_ERROR', message: safeText(error.message || error), submitted: 0, filled: 0 })
    process.exitCode = 1
  })
}
