#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig, validateConfig } from './config.mjs'
import {
  decimalAbs,
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  decimalPositive,
  decimalSubtract,
  divideToStep,
  quantizeDown,
  quantizeUp
} from './gate-account-context.mjs'
import { createGateClient } from './gate-rest.mjs'
import { createPlan, parseUsdmRule, sealPlan, sha256Hex, stableStringify, verifyPlan } from './gate-trade.mjs'
import { readJsonStrict, updateJsonLocked, withFileLock, writeJsonAtomic, writeTextAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ACTIVE_PATH = path.join(ROOT, 'data', 'paper', 'active.json')
const MARKET_PATH = path.join(ROOT, 'data', 'crypto_market.json')
const DAILY_PATH = path.join(ROOT, 'data', 'crypto_daily.json')
const WEEKLY_PATH = path.join(ROOT, 'data', 'crypto_strategy.json')
const PAPER_SCHEMA = 'tyche_paper_ledger/v1'
const SYMBOLS = Object.freeze(['BTC_USDT', 'ETH_USDT'])
const EVENT_TYPES = new Set([
  'SIMULATED_ORDER_OPEN',
  'SIMULATED_PARTIAL_FILL',
  'SIMULATED_FILLED',
  'SIMULATED_CANCELLED',
  'SIMULATED_PROTECTION_ARMED',
  'SIMULATED_FUNDING_APPLIED',
  'SIMULATED_POSITION_CLOSED',
  'SIMULATED_LIQUIDATION',
  'SIMULATED_TOUCH_SHADOW',
  'SIMULATED_EQUITY_MARK',
  'SIMULATED_SETTLED_THROUGH',
  'SIMULATION_EVIDENCE_GAP'
])

export class PaperTradeError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'PaperTradeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new PaperTradeError(code, message, details)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function nowMs(value = Date.now) {
  return typeof value === 'function' ? Number(value()) : Number(value)
}

function iso(value = Date.now) {
  const text = new Date(nowMs(value)).toISOString()
  if (!Number.isFinite(Date.parse(text))) fail('PAPER_TIME_INVALID', 'Paper clock is invalid')
  return text
}

function positive(value, label) {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) || !decimalPositive(text)) fail('PAPER_POSITIVE_REQUIRED', `${label} must be a positive plain decimal`)
  return text
}

function nonNegative(value, label) {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) fail('PAPER_DECIMAL_INVALID', `${label} must be a non-negative plain decimal`)
  return text
}

function bps(value, label) {
  const text = positive(value, label)
  if (decimalCompare(text, '10000') > 0) fail('PAPER_BPS_INVALID', `${label} must be no more than 10000`)
  return text
}

function symbol(value) {
  const text = String(value || '').toUpperCase()
  if (!SYMBOLS.includes(text)) fail('PAPER_SYMBOL_INVALID', 'Paper trading supports BTC_USDT and ETH_USDT only')
  return text
}

function ensurePaperConfig(config) {
  validateConfig(config)
  const product = config.gate.usdm
  const caps = ['risk_per_trade_bps', 'max_order_notional_usdt', 'daily_new_notional_cap_usdt', 'max_managed_notional_usdt']
  if (config.gate.submission_mode !== 'locked' || config.gate.enabled !== true || product.enabled !== true || product.environment !== 'dry-run') {
    fail('PAPER_CONFIG_SCOPE_INVALID', 'Paper trading requires locked, enabled USDT-M dry-run configuration')
  }
  if (!caps.every((key) => decimalPositive(String(product[key] ?? ''))) || !Number.isInteger(Number(product.configured_leverage)) || Number(product.configured_leverage) < 1 || Number(product.configured_leverage) > 3) {
    fail('PAPER_CONFIG_LIMITS_REQUIRED', 'Paper trading requires positive USDT-M limits and leverage from 1 through 3')
  }
  return config
}

function validatePolicy(policy) {
  const keys = ['initial_usdt', 'daily_loss_bps', 'max_drawdown_bps', 'max_spread_bps', 'max_entry_distance_bps', 'trigger_slippage_bps', 'max_positions', 'one_position_per_symbol', 'entry_watch_seconds', 'poll_interval_ms', 'configured_leverage']
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some((key) => !keys.includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(policy, key))) fail('PAPER_POLICY_INVALID', 'Paper policy shape is invalid')
  positive(policy.initial_usdt, 'initial_usdt')
  for (const key of ['daily_loss_bps', 'max_drawdown_bps', 'max_spread_bps', 'max_entry_distance_bps', 'trigger_slippage_bps']) bps(policy[key], key)
  if (policy.max_positions !== 2 || policy.one_position_per_symbol !== true) fail('PAPER_POSITION_POLICY_INVALID', 'Paper policy is fixed to one position per symbol and two total')
  if (!Number.isFinite(Number(policy.entry_watch_seconds)) || Number(policy.entry_watch_seconds) <= 0 || !Number.isFinite(Number(policy.poll_interval_ms)) || Number(policy.poll_interval_ms) <= 0) fail('PAPER_WATCH_POLICY_INVALID', 'Paper watch timing is invalid')
  if (!Number.isInteger(Number(policy.configured_leverage)) || Number(policy.configured_leverage) < 1 || Number(policy.configured_leverage) > 3) fail('PAPER_LEVERAGE_INVALID', 'Paper leverage must be an integer from 1 through 3')
  return policy
}

export function createPaperLedger(options = {}) {
  const config = ensurePaperConfig(options.config)
  const createdAt = iso(options.now)
  const policy = validatePolicy({
    initial_usdt: positive(options.initialUsdt, 'initial-usdt'),
    daily_loss_bps: bps(options.dailyLossBps, 'daily-loss-bps'),
    max_drawdown_bps: bps(options.maxDrawdownBps, 'max-drawdown-bps'),
    max_spread_bps: bps(options.maxSpreadBps, 'max-spread-bps'),
    max_entry_distance_bps: bps(options.maxEntryDistanceBps, 'max-entry-distance-bps'),
    trigger_slippage_bps: bps(options.triggerSlippageBps, 'trigger-slippage-bps'),
    max_positions: 2,
    one_position_per_symbol: true,
    entry_watch_seconds: Number(config.gate.entry_watch_seconds),
    poll_interval_ms: Number(config.gate.poll_interval_ms),
    configured_leverage: Number(config.gate.usdm.configured_leverage)
  })
  const identity = { created_at: createdAt, policy, config_digest: sha256Hex(config) }
  return {
    schema: PAPER_SCHEMA,
    account_id: `pa_${sha256Hex(identity).slice(0, 24)}`,
    created_at: createdAt,
    policy,
    policy_digest: sha256Hex(policy),
    config_digest: identity.config_digest,
    events: []
  }
}

function eventBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !EVENT_TYPES.has(raw.type)) fail('PAPER_EVENT_TYPE_INVALID', 'Paper event type is invalid')
  const at = String(raw.at || '')
  if (!Number.isFinite(Date.parse(at)) || new Date(Date.parse(at)).toISOString() !== at) fail('PAPER_EVENT_TIME_INVALID', 'Paper event time must be exact ISO')
  const sourceId = String(raw.source_id || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(sourceId)) fail('PAPER_EVENT_SOURCE_INVALID', 'Paper event source identity is invalid')
  if (!raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) fail('PAPER_EVENT_DATA_INVALID', 'Paper event data must be an object')
  return { type: raw.type, at, source_id: sourceId, data: clone(raw.data) }
}

function sealEvent(ledger, raw) {
  const body = eventBody(raw)
  const eventId = `pe_${sha256Hex(body).slice(0, 24)}`
  const sequence = ledger.events.length + 1
  const previousHash = ledger.events.at(-1)?.event_hash || null
  const core = { event_id: eventId, sequence, previous_hash: previousHash, ...body }
  return { ...core, event_hash: sha256Hex({ account_id: ledger.account_id, ...core }) }
}

export function validatePaperLedger(ledger) {
  const keys = ['schema', 'account_id', 'created_at', 'policy', 'policy_digest', 'config_digest', 'events']
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || Object.keys(ledger).some((key) => !keys.includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(ledger, key))) fail('PAPER_LEDGER_INVALID', 'Paper ledger shape is invalid')
  if (ledger.schema !== PAPER_SCHEMA || !/^pa_[a-f0-9]{24}$/.test(String(ledger.account_id || '')) || !/^[a-f0-9]{64}$/.test(String(ledger.config_digest || ''))) fail('PAPER_LEDGER_IDENTITY_INVALID', 'Paper ledger identity is invalid')
  validatePolicy(ledger.policy)
  if (ledger.policy_digest !== sha256Hex(ledger.policy) || !Array.isArray(ledger.events)) fail('PAPER_LEDGER_HASH_INVALID', 'Paper policy digest or event list is invalid')
  const seen = new Set()
  let previousHash = null
  ledger.events.forEach((event, index) => {
    const allowed = ['event_id', 'event_hash', 'sequence', 'previous_hash', 'type', 'at', 'source_id', 'data']
    if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.prototype.hasOwnProperty.call(event, key))) fail('PAPER_EVENT_INVALID', `Paper event ${index} shape is invalid`)
    const body = eventBody(event)
    if (event.sequence !== index + 1 || event.previous_hash !== previousHash || event.event_id !== `pe_${sha256Hex(body).slice(0, 24)}` || seen.has(event.event_id)) fail('PAPER_EVENT_CHAIN_INVALID', `Paper event ${index} chain is invalid`)
    const core = { event_id: event.event_id, sequence: event.sequence, previous_hash: event.previous_hash, ...body }
    if (event.event_hash !== sha256Hex({ account_id: ledger.account_id, ...core })) fail('PAPER_EVENT_HASH_INVALID', `Paper event ${index} hash is invalid`)
    seen.add(event.event_id)
    previousHash = event.event_hash
  })
  return ledger
}

export function appendPaperEventsValue(input, rawEvents = []) {
  const ledger = clone(validatePaperLedger(input))
  for (const raw of rawEvents) {
    const candidate = sealEvent(ledger, raw)
    const existing = ledger.events.find((event) => event.event_id === candidate.event_id)
    if (existing) continue
    ledger.events.push(candidate)
  }
  validatePaperLedger(ledger)
  derivePaperState(ledger)
  return ledger
}

export function appendPaperEvents(filePath, rawEvents) {
  return updateJsonLocked(filePath, (current) => appendPaperEventsValue(current, rawEvents))
}

function signed(value, direction = 1) {
  const text = nonNegative(decimalAbs(value), 'signed value')
  return direction < 0 && decimalPositive(text) ? decimalSubtract('0', text) : text
}

function positionPnl(position, exitPrice, contracts = position.contracts) {
  const base = decimalMultiply(String(contracts), position.multiplier)
  const difference = position.side === 'long'
    ? decimalSubtract(String(exitPrice), position.entry_price)
    : decimalSubtract(position.entry_price, String(exitPrice))
  return decimalMultiply(base, difference)
}

function markPnl(position, mark) {
  return positionPnl(position, mark, position.contracts)
}

export function derivePaperState(input, options = {}) {
  const ledger = validatePaperLedger(input)
  const state = {
    account_id: ledger.account_id,
    balance: String(ledger.policy.initial_usdt),
    available_quote: String(ledger.policy.initial_usdt),
    equity: String(ledger.policy.initial_usdt),
    peak_equity: String(ledger.policy.initial_usdt),
    realized_pnl: '0',
    fees: '0',
    funding: '0',
    positions: {},
    orders: {},
    used_signals: new Set(),
    settled_through: {},
    evidence_gap: false,
    simulated_filled_contracts: '0',
    daily: {},
    daily_equity_change: {},
    daily_opening_equity: {},
    entry_notional_by_day: {}
  }
  const dayStart = {}
  let recordedEquity = null
  let lastKnownEquity = String(ledger.policy.initial_usdt)
  const ensureDay = (at) => {
    const day = String(at).slice(0, 10)
    if (state.daily_opening_equity[day] === undefined) state.daily_opening_equity[day] = lastKnownEquity
    return day
  }
  const impact = (at, amount) => {
    const day = ensureDay(at)
    if (!dayStart[day]) dayStart[day] = state.balance
    state.balance = decimalAdd(state.balance, amount)
    state.daily[day] = decimalAdd(state.daily[day] || '0', amount)
    lastKnownEquity = decimalAdd(lastKnownEquity, amount)
  }
  for (const event of ledger.events) {
    const data = event.data
    if (data.symbol !== undefined) symbol(data.symbol)
    if (event.type === 'SIMULATED_ORDER_OPEN') {
      if (!/^po_[a-f0-9]{24}$/.test(String(data.paper_order_id || '')) || state.orders[data.paper_order_id]) fail('PAPER_ORDER_STATE_INVALID', 'Paper order identity is invalid or duplicated')
      state.orders[data.paper_order_id] = { ...clone(data), status: 'OPEN', opened_at: event.at }
    } else if (event.type === 'SIMULATED_PARTIAL_FILL' || event.type === 'SIMULATED_FILLED') {
      const order = state.orders[data.paper_order_id]
      const contracts = positive(data.contracts, 'fill contracts')
      if (!order || order.status !== 'OPEN' || !/^pf_[a-f0-9]{24}$/.test(String(data.paper_fill_id || ''))) fail('PAPER_FILL_STATE_INVALID', 'Paper fill does not match an open paper order')
      state.simulated_filled_contracts = decimalAdd(state.simulated_filled_contracts, contracts)
      order.filled_contracts = contracts
      order.status = event.type === 'SIMULATED_FILLED' ? 'FILLED' : 'PARTIALLY_FILLED'
      if (data.role === 'ENTRY') {
        if (state.positions[data.symbol]) fail('PAPER_POSITION_ALREADY_OPEN', `${data.symbol} already has a paper position`)
        const fee = nonNegative(data.fee, 'entry fee')
        impact(event.at, signed(fee, -1))
        state.fees = decimalAdd(state.fees, fee)
        state.positions[data.symbol] = {
          symbol: data.symbol,
          side: data.side,
          contracts,
          entry_price: positive(data.price, 'entry price'),
          multiplier: positive(data.multiplier, 'multiplier'),
          margin: positive(data.margin, 'margin'),
          liquidation_price: positive(data.liquidation_price, 'liquidation price'),
          tick_size: positive(data.tick_size, 'tick size'),
          taker_fee_rate: nonNegative(data.taker_fee_rate, 'taker fee rate'),
          maintenance_rate: positive(data.maintenance_rate, 'maintenance rate'),
          tier_deduction: nonNegative(data.tier_deduction, 'tier deduction'),
          signal_id: String(data.signal_id || ''),
          opened_at: event.at,
          last_settled_at: event.at,
          stop_price: null,
          target_price: null
        }
        state.used_signals.add(String(data.signal_id || ''))
        const day = event.at.slice(0, 10)
        state.entry_notional_by_day[day] = decimalAdd(state.entry_notional_by_day[day] || '0', positive(data.notional, 'entry notional'))
      }
    } else if (event.type === 'SIMULATED_CANCELLED') {
      const order = state.orders[data.paper_order_id]
      if (!order || !['OPEN', 'PARTIALLY_FILLED'].includes(order.status)) fail('PAPER_CANCEL_STATE_INVALID', 'Paper cancellation does not match an active order')
      order.status = 'CANCELLED'
      order.cancelled_at = event.at
      order.shadow_recorded = false
    } else if (event.type === 'SIMULATED_PROTECTION_ARMED') {
      const position = state.positions[data.symbol]
      if (!position || decimalCompare(position.contracts, String(data.contracts)) !== 0) fail('PAPER_PROTECTION_STATE_INVALID', 'Paper protection quantity does not match the position')
      position.stop_price = positive(data.stop_price, 'stop price')
      position.target_price = positive(data.target_price, 'target price')
    } else if (event.type === 'SIMULATED_FUNDING_APPLIED') {
      const position = state.positions[data.symbol]
      if (!position || decimalCompare(position.contracts, String(data.contracts)) !== 0) fail('PAPER_FUNDING_STATE_INVALID', 'Paper funding does not match the position')
      const amount = String(data.amount)
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) fail('PAPER_FUNDING_AMOUNT_INVALID', 'Funding amount is invalid')
      const marginAfter = nonNegative(data.margin_after, 'funding margin_after')
      if (decimalCompare(decimalAdd(position.margin, amount), marginAfter) !== 0) fail('PAPER_FUNDING_MARGIN_INVALID', 'Funding must update isolated margin deterministically')
      impact(event.at, amount)
      state.funding = decimalAdd(state.funding, amount)
      position.margin = marginAfter
      position.liquidation_price = positive(data.liquidation_price_after, 'funding liquidation_price_after')
    } else if (event.type === 'SIMULATED_POSITION_CLOSED') {
      const position = state.positions[data.symbol]
      const contracts = positive(data.contracts, 'close contracts')
      if (!position || decimalCompare(contracts, position.contracts) > 0) fail('PAPER_CLOSE_STATE_INVALID', 'Paper close exceeds its position')
      const expectedPnl = positionPnl(position, positive(data.price, 'close price'), contracts)
      if (decimalCompare(expectedPnl, String(data.pnl)) !== 0) fail('PAPER_CLOSE_PNL_INVALID', 'Paper close PnL is not deterministic')
      const fee = nonNegative(data.fee, 'close fee')
      impact(event.at, decimalSubtract(expectedPnl, fee))
      state.realized_pnl = decimalAdd(state.realized_pnl, expectedPnl)
      state.fees = decimalAdd(state.fees, fee)
      if (decimalCompare(contracts, position.contracts) === 0) delete state.positions[data.symbol]
      else {
        const remaining = decimalSubtract(position.contracts, contracts)
        position.margin = divideToStep(decimalMultiply(position.margin, remaining), position.contracts, '0.00000001')
        position.contracts = remaining
      }
    } else if (event.type === 'SIMULATED_LIQUIDATION') {
      const position = state.positions[data.symbol]
      if (!position) fail('PAPER_LIQUIDATION_STATE_INVALID', 'Paper liquidation has no position')
      const loss = nonNegative(data.loss, 'liquidation loss')
      if (decimalCompare(loss, position.margin) !== 0) fail('PAPER_LIQUIDATION_LOSS_INVALID', 'Paper liquidation loss must equal isolated margin')
      impact(event.at, signed(loss, -1))
      state.realized_pnl = decimalSubtract(state.realized_pnl, loss)
      delete state.positions[data.symbol]
    } else if (event.type === 'SIMULATED_SETTLED_THROUGH') {
      state.settled_through[data.symbol] = String(data.through)
      if (state.positions[data.symbol]) state.positions[data.symbol].last_settled_at = String(data.through)
    } else if (event.type === 'SIMULATION_EVIDENCE_GAP') {
      state.evidence_gap = true
    } else if (event.type === 'SIMULATED_TOUCH_SHADOW') {
      if (state.orders[data.paper_order_id]) state.orders[data.paper_order_id].shadow_recorded = true
    } else if (event.type === 'SIMULATED_EQUITY_MARK') {
      const equity = String(data.equity)
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(equity)) fail('PAPER_EQUITY_MARK_INVALID', 'Paper equity mark is invalid')
      const day = ensureDay(event.at)
      state.daily_equity_change[day] = decimalSubtract(equity, state.daily_opening_equity[day])
      if (decimalCompare(equity, state.peak_equity) > 0) state.peak_equity = equity
      state.equity = equity
      recordedEquity = equity
      lastKnownEquity = equity
    }
  }
  let unrealized = '0'
  let locked = '0'
  for (const position of Object.values(state.positions)) {
    const mark = options.marks?.[position.symbol]
    if (mark !== undefined && decimalPositive(String(mark))) unrealized = decimalAdd(unrealized, markPnl(position, String(mark)))
    locked = decimalAdd(locked, position.margin)
  }
  const suppliedMarks = options.marks && Object.keys(options.marks).length > 0
  state.equity = suppliedMarks || Object.keys(state.positions).length === 0 ? decimalAdd(state.balance, unrealized) : (recordedEquity || state.balance)
  state.available_quote = decimalSubtract(state.balance, locked)
  state.unrealized_pnl = unrealized
  state.locked_margin = locked
  state.day_start_balance = dayStart
  const peak = decimalCompare(state.peak_equity, state.equity) >= 0 ? state.peak_equity : state.equity
  state.peak_equity = peak
  state.drawdown = decimalPositive(peak) && decimalCompare(peak, state.equity) > 0 ? divideToStep(decimalSubtract(peak, state.equity), peak, '0.00000001') : '0'
  return state
}

export function paperEntryBlocker(ledger, state, current = Date.now) {
  if (state.evidence_gap) return 'SIMULATION_EVIDENCE_GAP'
  if (Object.keys(state.positions).length >= ledger.policy.max_positions) return 'PAPER_MAX_POSITIONS'
  const day = iso(current).slice(0, 10)
  const daily = state.daily_equity_change[day] ?? state.daily[day] ?? '0'
  const start = state.daily_opening_equity[day] || state.day_start_balance[day] || state.balance
  const dailyLimit = decimalMultiply(start, decimalMultiply(String(ledger.policy.daily_loss_bps), '0.0001'))
  if (decimalCompare(daily, decimalSubtract('0', dailyLimit)) <= 0) return 'PAPER_DAILY_LOSS_BREAKER'
  const drawdownLimit = decimalMultiply(String(ledger.policy.max_drawdown_bps), '0.0001')
  if (decimalCompare(state.drawdown, drawdownLimit) >= 0) return 'PAPER_DRAWDOWN_BREAKER'
  return null
}

function marketMarks(snapshot) {
  return Object.fromEntries(SYMBOLS.map((pair) => {
    const asset = pair.startsWith('BTC') ? 'BTC' : 'ETH'
    return [pair, snapshot?.assets?.[asset]?.usdm?.ticker?.mark_price ?? snapshot?.assets?.[asset]?.usdm?.ticker?.last]
  }))
}

function paperContext(ledger, snapshot, config, current, options = {}) {
  const marks = marketMarks(snapshot)
  const state = derivePaperState(ledger, { marks })
  const managedNotional = Object.values(state.positions).reduce((sum, position) => decimalAdd(sum, decimalMultiply(decimalMultiply(position.contracts, position.multiplier), marks[position.symbol])), '0')
  const fraction = decimalMultiply(String(config.gate.usdm.risk_capital_fraction_bps), '0.0001')
  const buffer = decimalMultiply(decimalSubtract('10000', String(config.gate.usdm.balance_buffer_bps)), '0.0001')
  const effective = decimalMultiply(decimalMultiply(state.equity, buffer), fraction)
  const day = iso(current).slice(0, 10)
  const accounts = {}
  const rules = {}
  const quotes = {}
  for (const pair of SYMBOLS) {
    const asset = pair.startsWith('BTC') ? 'BTC' : 'ETH'
    const block = snapshot.assets?.[asset]?.usdm
    const rule = parseUsdmRule({ ...block?.rule, _fetched_at: snapshot.generated_at })
    rules[pair] = { ...block?.rule, _fetched_at: snapshot.generated_at }
    const position = state.positions[pair]
    const managed = position ? (position.side === 'long' ? position.contracts : decimalSubtract('0', position.contracts)) : '0'
    const book = block?.order_book || {}
    const bid = book.bids?.[0]?.price || null
    const ask = book.asks?.[0]?.price || null
    quotes[pair] = { product: 'usdm', symbol: pair, price: String(marks[pair] || ''), bid, ask, fetched_at: snapshot.generated_at }
    const identity = { product: 'usdm', environment: 'dry-run', funding_source: 'paper_usdt_available', wallet: 'PAPER_USDT_FUTURES', asset: 'USDT', symbol: pair, generated_at: snapshot.generated_at, available_quote: state.available_quote, effective_risk_capital: effective, managed_quantity: managed, managed_notional: managedNotional, daily_new_notional_used: state.entry_notional_by_day[day] || '0', daily_order_count: 0 }
    accounts[`usdm:${pair}`] = { schema: 'tyche_account_epoch/v1', account_epoch_id: `tae_${sha256Hex(identity).slice(0, 24)}`, ...identity }
  }
  const entryBlock = options.killActive ? 'GATE_KILL_ACTIVE' : paperEntryBlocker(ledger, state, current)
  return {
    state,
    context: { rules, quotes, accounts, reconciliation: { status: 'ok', generated_at: snapshot.generated_at, receipt_id: `pr_${sha256Hex({ account: ledger.account_id, at: snapshot.generated_at }).slice(0, 24)}`, issues: [] }, blockers: [] },
    selectionControls: { entry_block_code: entryBlock, max_spread_bps: ledger.policy.max_spread_bps, max_entry_distance_bps: ledger.policy.max_entry_distance_bps }
  }
}

function tierForNotional(block, notional) {
  const tiers = Array.isArray(block?.risk_limit_tiers) ? block.risk_limit_tiers : []
  const usable = tiers.filter((tier) => decimalPositive(String(tier.risk_limit || '')) && decimalPositive(String(tier.maintenance_rate || ''))).sort((a, b) => Number(a.risk_limit) - Number(b.risk_limit))
  return usable.find((tier) => decimalCompare(String(notional), String(tier.risk_limit)) <= 0) || null
}

function riskProof(intent, snapshot, policy) {
  const asset = intent.symbol.startsWith('BTC') ? 'BTC' : 'ETH'
  const block = snapshot.assets[asset].usdm
  const rule = parseUsdmRule({ ...block.rule, _fetched_at: snapshot.generated_at })
  if (!rule.ok || block.rule?.status !== 'trading' || block.rule?.in_delisting === true || block.rule?.enable_circuit_breaker === true || !decimalPositive(rule.taker_fee_rate || '') || !decimalPositive(rule.maintenance_rate || '')) return { ok: false, code: 'PAPER_RISK_RULE_UNAVAILABLE' }
  const tier = tierForNotional(block, intent.estimated_notional)
  if (!tier) return { ok: false, code: 'PAPER_RISK_TIER_UNAVAILABLE' }
  if (!decimalPositive(String(tier.leverage_max || '')) || decimalCompare(String(policy.configured_leverage), String(tier.leverage_max)) > 0) return { ok: false, code: 'PAPER_RISK_TIER_LEVERAGE' }
  const feeRate = String(rule.taker_fee_rate)
  const mmr = String(tier.maintenance_rate)
  const deduction = nonNegative(String(tier.deduction ?? '0'), 'risk tier deduction')
  const leverage = String(policy.configured_leverage)
  const entry = String(intent.price)
  const base = decimalMultiply(String(intent.quantity), rule.quanto_multiplier)
  const initialMargin = divideToStep(intent.estimated_notional, leverage, '0.00000001')
  const entryFee = decimalMultiply(intent.estimated_notional, feeRate)
  const exitFeeReserve = decimalMultiply(intent.estimated_notional, feeRate)
  const margin = decimalSubtract(initialMargin, entryFee)
  if (!decimalPositive(margin)) return { ok: false, code: 'PAPER_MARGIN_INSUFFICIENT' }
  const liquidation = liquidationPrice({ side: intent.size > 0 ? 'long' : 'short', entry, base, margin, maintenanceRate: mmr, deduction, feeRate, tickSize: rule.tick_size })
  const safe = intent.size > 0 ? decimalCompare(intent.protection.stop_price, liquidation) > 0 : decimalCompare(intent.protection.stop_price, liquidation) < 0
  return {
    ok: safe,
    code: safe ? null : 'PAPER_STOP_LIQUIDATION_UNSAFE',
    proof: { symbol: intent.symbol, contracts: intent.quantity, multiplier: rule.quanto_multiplier, tick_size: rule.tick_size, taker_fee_rate: feeRate, maintenance_rate: mmr, tier_deduction: deduction, risk_limit: String(tier.risk_limit), initial_margin: initialMargin, entry_fee: entryFee, exit_fee_reserve: exitFeeReserve, margin, liquidation_price: liquidation, fee_estimated: true, liquidation_estimated: true }
  }
}

function liquidationPrice({ side, entry, base, margin, maintenanceRate, deduction, feeRate, tickSize }) {
  const marginAndDeductionPerBase = divideToStep(decimalAdd(margin, deduction), base, '0.00000001')
  const rate = decimalAdd(maintenanceRate, feeRate)
  const raw = side === 'long'
    ? divideToStep(decimalSubtract(entry, marginAndDeductionPerBase), decimalSubtract('1', rate), tickSize)
    : divideToStep(decimalAdd(entry, marginAndDeductionPerBase), decimalAdd('1', rate), tickSize)
  return side === 'long' ? quantizeUp(raw, tickSize) : quantizeDown(raw, tickSize)
}

export function createPaperPlan(source, options = {}) {
  const config = ensurePaperConfig(options.config)
  const ledger = validatePaperLedger(options.ledger)
  if (ledger.config_digest !== sha256Hex(config)) fail('PAPER_CONFIG_DRIFT', 'Paper ledger was initialized with a different configuration')
  const current = nowMs(options.now)
  const prepared = paperContext(ledger, options.marketSnapshot, config, current, { killActive: options.killActive === true })
  const baseOptions = { product: 'usdm', environment: 'dry-run', config, context: prepared.context, ledger: { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: options.date, isoWeek: options.isoWeek, weeklyAnchor: options.weeklyAnchor, marketSnapshot: options.marketSnapshot, selectionControls: prepared.selectionControls, now: current }
  let plan = createPlan(source, baseOptions)
  const risks = {}
  let riskFailure = null
  if (plan.status === 'READY') {
    for (const intent of plan.intents.filter((row) => row.role === 'ENTRY')) {
      const result = riskProof(intent, options.marketSnapshot, ledger.policy)
      if (!result.ok) riskFailure ||= result.code
      else risks[intent.intent_id] = result.proof
    }
  }
  if (riskFailure) plan = createPlan(source, { ...baseOptions, context: { ...prepared.context, blockers: [{ code: riskFailure, message: 'Paper stop is not safely ahead of estimated liquidation or risk evidence is missing' }] } })
  return sealPlan({ ...plan, paper_policy_proof: { account_id: ledger.account_id, policy_digest: ledger.policy_digest, config_digest: ledger.config_digest }, paper_risk_proof: riskFailure ? {} : risks }, { now: current, config })
}

function levelRows(book, side) {
  const rows = Array.isArray(book?.[side]) ? book[side] : []
  return rows.map((row) => Array.isArray(row) ? { price: String(row[0]), quantity: String(row[1]) } : { price: String(row?.p ?? row?.price ?? ''), quantity: String(row?.s ?? row?.size ?? row?.quantity ?? '') }).filter((row) => decimalPositive(row.price) && decimalPositive(decimalAbs(row.quantity)))
}

export function simulateBookFill(intent, book) {
  const bookId = String(book?.id ?? '')
  const current = Number(book?.current)
  const update = Number(book?.update)
  if (!bookId || !Number.isFinite(current) || current <= 0 || !Number.isFinite(update) || update <= 0 || update > current) fail('PAPER_BOOK_EVIDENCE_INVALID', 'Order book must include coherent id/current/update evidence')
  const buy = intent.side === 'BUY'
  const crossing = levelRows(book, buy ? 'asks' : 'bids').filter((row) => buy ? decimalCompare(row.price, intent.price) <= 0 : decimalCompare(row.price, intent.price) >= 0)
  const visible = crossing.reduce((sum, row) => decimalAdd(sum, decimalAbs(row.quantity)), '0')
  const wanted = String(intent.quantity)
  const contracts = decimalCompare(visible, wanted) >= 0 ? wanted : quantizeDown(visible, '1')
  if (!decimalPositive(contracts)) return null
  return { contracts, price: String(intent.price), complete: decimalCompare(contracts, wanted) === 0, book_id: bookId, book_current: String(book.current), book_update: String(book.update), visible_contracts: visible }
}

function closeData(position, contracts, price, reason, feeRate) {
  const notional = decimalMultiply(decimalMultiply(String(contracts), position.multiplier), String(price))
  const fee = decimalMultiply(notional, feeRate)
  return { symbol: position.symbol, side: position.side, contracts: String(contracts), price: String(price), pnl: positionPnl(position, price, contracts), fee, fee_estimated: true, reason }
}

function slippagePrice(position, trigger, open, policy, kind) {
  const rate = decimalMultiply(String(policy.trigger_slippage_bps), '0.0001')
  let base = String(trigger)
  if (kind === 'stop') {
    if (position.side === 'long' && decimalCompare(String(open), base) < 0) base = String(open)
    if (position.side === 'short' && decimalCompare(String(open), base) > 0) base = String(open)
  }
  const adjusted = position.side === 'long' ? decimalMultiply(base, decimalSubtract('1', rate)) : decimalMultiply(base, decimalAdd('1', rate))
  return position.side === 'long' ? quantizeDown(adjusted, position.tick_size) : quantizeUp(adjusted, position.tick_size)
}

export function evaluateProtectionBars(position, bars, policy) {
  for (const bar of bars) {
    const low = String(bar.l ?? bar.low)
    const high = String(bar.h ?? bar.high)
    const open = String(bar.o ?? bar.open)
    if (![low, high, open].every(decimalPositive)) fail('PAPER_BAR_INVALID', 'Protection bar is invalid')
    const liquidated = position.side === 'long' ? decimalCompare(low, position.liquidation_price) <= 0 : decimalCompare(high, position.liquidation_price) >= 0
    if (liquidated) return { kind: 'liquidation', bar }
    const stop = position.side === 'long' ? decimalCompare(low, position.stop_price) <= 0 : decimalCompare(high, position.stop_price) >= 0
    const target = position.side === 'long' ? decimalCompare(high, position.target_price) >= 0 : decimalCompare(low, position.target_price) <= 0
    if (stop) return { kind: 'stop', price: slippagePrice(position, position.stop_price, open, policy, 'stop'), bar }
    if (target) return { kind: 'target', price: slippagePrice(position, position.target_price, open, policy, 'target'), bar }
  }
  return null
}

export async function fetchMinuteBars(client, contract, startMs, endMs) {
  const first = Math.ceil(startMs / 60000) * 60
  const final = Math.floor(endMs / 60000) * 60 - 60
  if (final < first) return []
  const rows = []
  for (let from = first; from <= final; from += 1999 * 60) {
    const to = Math.min(final + 60, from + 1999 * 60)
    const response = await client.usdmCandlesticks({ contract, interval: '1m', from, to, limit: 2000 })
    rows.push(...(Array.isArray(response.data) ? response.data : []))
  }
  const unique = new Map(rows
    .map((row) => [Number(row.t ?? row[0]), row])
    .filter(([timestamp]) => timestamp >= first && timestamp <= final))
  const output = [...unique.entries()].sort(([left], [right]) => left - right).map(([, row]) => row)
  for (let index = 1; index < output.length; index += 1) if (Number(output[index].t ?? output[index][0]) - Number(output[index - 1].t ?? output[index - 1][0]) !== 60) fail('PAPER_MINUTE_DATA_GAP', `${contract} minute history is not contiguous`)
  if (output.length && (Number(output[0].t ?? output[0][0]) !== first || Number(output.at(-1).t ?? output.at(-1)[0]) !== final)) fail('PAPER_MINUTE_DATA_GAP', `${contract} minute history does not cover the requested window`)
  if (!output.length && final >= first) fail('PAPER_MINUTE_DATA_GAP', `${contract} minute history is missing`)
  return output
}

export async function settlePaper(options = {}) {
  const filePath = options.filePath || ACTIVE_PATH
  const ledger = readJsonStrict(filePath)
  const state = derivePaperState(ledger)
  const current = nowMs(options.now)
  const client = options.client || createGateClient({ product: 'usdm', environment: 'public', readOnly: true, now: typeof options.now === 'function' ? options.now : Date.now })
  const allEvents = []
  const evidence = { schema: 'tyche_paper_evidence/v1', account_id: ledger.account_id, generated_at: iso(current), positions: {} }
  const marks = {}
  for (const position of Object.values(state.positions)) {
    let bars
    try { bars = options.bars?.[position.symbol] || await fetchMinuteBars(client, `mark_${position.symbol}`, Date.parse(position.last_settled_at), current) } catch (error) {
      allEvents.push({ type: 'SIMULATION_EVIDENCE_GAP', at: iso(current), source_id: `gap:${position.symbol}:${Math.floor(current / 60000)}`, data: { symbol: position.symbol, code: error.code || 'PAPER_MINUTE_DATA_GAP' } })
      continue
    }
    bars = [...bars].sort((left, right) => Number(left.t ?? left[0]) - Number(right.t ?? right[0]))
    const latestBar = bars.at(-1)
    if (latestBar) marks[position.symbol] = String(latestBar.c ?? latestBar.close ?? latestBar[2])
    let fundingRows = []
    let appliedFunding = []
    let trigger = null
    let triggerAt = current
    const virtual = clone(position)
    try {
      const funding = options.funding?.[position.symbol] || (await client.usdmFundingRate({ contract: position.symbol, limit: 1000 })).data
      fundingRows = (Array.isArray(funding) ? funding : [])
        .map((row) => ({ ...row, funding_time: Number(row.t ?? row.funding_time) }))
        .filter((row) => Number.isFinite(row.funding_time) && row.funding_time * 1000 > Date.parse(position.last_settled_at) && row.funding_time * 1000 <= current)
        .sort((left, right) => left.funding_time - right.funding_time)
      let fundingIndex = 0
      for (const bar of bars) {
        trigger = evaluateProtectionBars(virtual, [bar], ledger.policy)
        const barClose = Number(bar.t ?? bar[0]) * 1000 + 60000
        if (trigger) {
          triggerAt = barClose
          break
        }
        while (fundingIndex < fundingRows.length && fundingRows[fundingIndex].funding_time * 1000 <= barClose) {
          const row = fundingRows[fundingIndex]
          const fundingTime = row.funding_time * 1000
          const mark = String(bar.c ?? bar.close ?? bar[2])
          const value = decimalMultiply(decimalMultiply(virtual.contracts, virtual.multiplier), mark)
          const rawAmount = decimalMultiply(value, String(row.r))
          const amount = virtual.side === 'long' ? decimalSubtract('0', rawAmount) : rawAmount
          const marginAfter = decimalAdd(virtual.margin, amount)
          const liquidationAfter = decimalPositive(marginAfter)
            ? liquidationPrice({ side: virtual.side, entry: virtual.entry_price, base: decimalMultiply(virtual.contracts, virtual.multiplier), margin: marginAfter, maintenanceRate: virtual.maintenance_rate, deduction: virtual.tier_deduction, feeRate: virtual.taker_fee_rate, tickSize: virtual.tick_size })
            : mark
          allEvents.push({ type: 'SIMULATED_FUNDING_APPLIED', at: new Date(fundingTime).toISOString(), source_id: `funding:${position.symbol}:${row.funding_time}`, data: { symbol: position.symbol, contracts: position.contracts, rate: String(row.r), mark_price: mark, position_value: value, amount, margin_after: marginAfter, liquidation_price_after: liquidationAfter } })
          appliedFunding.push(row)
          virtual.margin = marginAfter
          virtual.liquidation_price = liquidationAfter
          fundingIndex += 1
          const fundingLiquidation = !decimalPositive(marginAfter) || (virtual.side === 'long' ? decimalCompare(mark, liquidationAfter) <= 0 : decimalCompare(mark, liquidationAfter) >= 0)
          if (fundingLiquidation) {
            trigger = { kind: 'liquidation', bar, at: fundingTime }
            triggerAt = fundingTime
            break
          }
        }
        if (trigger) break
      }
    } catch (error) {
      allEvents.push({ type: 'SIMULATION_EVIDENCE_GAP', at: iso(current), source_id: `funding-gap:${position.symbol}:${Math.floor(current / 60000)}`, data: { symbol: position.symbol, code: error.code || 'PAPER_FUNDING_DATA_GAP' } })
      continue
    }
    evidence.positions[position.symbol] = { bars, funding: appliedFunding }
    if (trigger?.kind === 'liquidation') {
      const at = new Date(trigger.at ?? triggerAt).toISOString()
      allEvents.push({ type: 'SIMULATED_LIQUIDATION', at, source_id: `liq:${position.symbol}:${Math.floor((trigger.at ?? triggerAt) / 1000)}`, data: { symbol: position.symbol, loss: virtual.margin, liquidation_price: virtual.liquidation_price, estimated: true } })
      continue
    }
    if (trigger) {
      const at = new Date(Number(trigger.bar.t ?? trigger.bar[0]) * 1000 + 60000).toISOString()
      allEvents.push({ type: 'SIMULATED_POSITION_CLOSED', at, source_id: `protect:${position.symbol}:${trigger.kind}:${trigger.bar.t ?? trigger.bar[0]}`, data: closeData(position, position.contracts, trigger.price, trigger.kind.toUpperCase(), position.taker_fee_rate) })
      continue
    }
    if (latestBar) {
      const throughMs = Number(latestBar.t ?? latestBar[0]) * 1000 + 60000
      allEvents.push({ type: 'SIMULATED_SETTLED_THROUGH', at: iso(current), source_id: `settled:${position.symbol}:${Math.floor(throughMs / 60000)}`, data: { symbol: position.symbol, through: iso(throughMs) } })
    }
  }
  for (const order of Object.values(state.orders).filter((row) => row.status === 'CANCELLED' && row.role === 'ENTRY' && row.shadow_recorded !== true)) {
    try {
      const bars = options.touchBars?.[order.symbol] || await fetchMinuteBars(client, order.symbol, Date.parse(order.cancelled_at), current)
      const touched = bars.find((bar) => order.side === 'BUY' ? decimalCompare(String(bar.l ?? bar.low ?? bar[4]), String(order.price)) <= 0 : decimalCompare(String(bar.h ?? bar.high ?? bar[3]), String(order.price)) >= 0)
      if (touched) allEvents.push({ type: 'SIMULATED_TOUCH_SHADOW', at: new Date(Number(touched.t ?? touched[0]) * 1000 + 60000).toISOString(), source_id: `touch:${order.paper_order_id}`, data: { paper_order_id: order.paper_order_id, symbol: order.symbol, price: order.price, bar_time: Number(touched.t ?? touched[0]) } })
    } catch (error) {
      allEvents.push({ type: 'SIMULATION_EVIDENCE_GAP', at: iso(current), source_id: `touch-gap:${order.paper_order_id}`, data: { symbol: order.symbol, code: error.code || 'PAPER_TOUCH_DATA_GAP' } })
    }
  }
  let next = allEvents.length ? appendPaperEvents(filePath, allEvents) : ledger
  const active = derivePaperState(next)
  const activeMarks = Object.fromEntries(Object.keys(active.positions).filter((pair) => marks[pair] !== undefined).map((pair) => [pair, marks[pair]]))
  const marked = derivePaperState(next, { marks: activeMarks })
  const markEvent = { type: 'SIMULATED_EQUITY_MARK', at: iso(current), source_id: `equity:${Math.floor(current / 60000)}`, data: { equity: marked.equity, marks: activeMarks } }
  next = appendPaperEvents(filePath, [markEvent])
  const nextState = derivePaperState(next)
  const receiptId = `psr_${sha256Hex({ account: ledger.account_id, at: evidence.generated_at, events: allEvents }).slice(0, 24)}`
  evidence.receipt_id = receiptId
  evidence.events = allEvents.map((event) => ({ type: event.type, source_id: event.source_id }))
  evidence.evidence_hash = sha256Hex(evidence)
  if (!options.skipWriteEvidence) writeJsonAtomic(path.join(ROOT, 'data', 'paper', 'evidence', `${receiptId}.json`), evidence)
  return { outcome: nextState.evidence_gap ? 'BLOCKED' : 'SETTLED', receipt_id: receiptId, events: allEvents.length, submitted: 0, filled: 0, state: publicState(nextState) }
}

async function watchBook(intent, options) {
  const current = options.now || Date.now
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = Number(options.openedAt ?? nowMs(current)) + Number(options.policy.entry_watch_seconds) * 1000
  while (true) {
    const book = await options.bookProvider(intent.symbol)
    const bookCurrentMs = Number(book?.current) * (Number(book?.current) < 1e12 ? 1000 : 1)
    const observedAt = nowMs(current)
    if (!Number.isFinite(bookCurrentMs) || bookCurrentMs > observedAt + 1000 || observedAt - bookCurrentMs > Number(options.maxBookAgeSeconds) * 1000) fail('PAPER_BOOK_STALE', 'Order-book evidence is missing, future-dated, or stale')
    const fill = simulateBookFill(intent, book)
    if (fill) return fill
    const now = nowMs(current)
    if (now >= deadline) return null
    await sleep(Math.min(Number(options.policy.poll_interval_ms), Math.max(0, deadline - now)))
  }
}

export async function applyPaperPlan(plan, options = {}) {
  const filePath = options.filePath || ACTIVE_PATH
  const config = ensurePaperConfig(options.config)
  let ledger = readJsonStrict(filePath)
  validatePaperLedger(ledger)
  const current = options.now || Date.now
  const verified = verifyPlan(plan, { planId: plan.plan_id, planHash: plan.plan_hash, planTtlSeconds: config.gate.plan_ttl_seconds, now: current })
  if (!verified.ok || plan.product !== 'usdm' || plan.environment !== 'dry-run' || plan.status !== 'READY') fail(verified.code || 'PAPER_PLAN_INVALID', verified.message || 'Paper apply requires a READY USDT-M dry-run plan')
  if (plan.paper_policy_proof?.account_id !== ledger.account_id || plan.paper_policy_proof?.policy_digest !== ledger.policy_digest || plan.paper_policy_proof?.config_digest !== ledger.config_digest) fail('PAPER_PLAN_POLICY_DRIFT', 'Paper plan does not match the active paper account policy')
  const killPath = options.killPath || path.join(ROOT, config.gate.kill_switch_path)
  const client = options.client || createGateClient({ product: 'usdm', environment: 'public', readOnly: true, now: typeof current === 'function' ? current : Date.now })
  const provider = options.bookProvider || (async (pair) => (await client.usdmOrderBook({ contract: pair, limit: 5, with_id: true })).data)
  let filledContracts = '0'
  const outcomes = []
  for (const intent of plan.intents) {
    ledger = readJsonStrict(filePath)
    const state = derivePaperState(ledger)
    const paperOrderId = `po_${sha256Hex({ plan_id: plan.plan_id, intent_id: intent.intent_id }).slice(0, 24)}`
    const previous = state.orders[paperOrderId]
    if (previous && previous.status !== 'OPEN') {
      const previousContracts = String(previous.filled_contracts || '0')
      const previousOutcome = decimalPositive(previousContracts)
        ? (decimalCompare(previousContracts, String(previous.quantity)) === 0 ? 'SIMULATED_FILLED' : 'SIMULATED_PARTIAL_FILL')
        : 'SIMULATED_CANCELLED'
      if (decimalPositive(previousContracts)) filledContracts = decimalAdd(filledContracts, previousContracts)
      outcomes.push({ intent_id: intent.intent_id, outcome: previousOutcome, ...(decimalPositive(previousContracts) ? { contracts: previousContracts } : {}), reused: true })
      continue
    }
    if (intent.role === 'ENTRY') {
      const blocker = paperEntryBlocker(ledger, state, current)
      const entryBlocker = fs.existsSync(killPath) ? 'GATE_KILL_ACTIVE' : blocker
      if (entryBlocker || state.positions[intent.symbol]) {
        outcomes.push({ intent_id: intent.intent_id, outcome: 'BLOCKED', code: entryBlocker || 'POSITION_ALREADY_MANAGED' })
        continue
      }
    }
    const openedAt = previous?.opened_at || iso(current)
    if (!previous) appendPaperEvents(filePath, [{ type: 'SIMULATED_ORDER_OPEN', at: openedAt, source_id: `${paperOrderId}:open`, data: { paper_order_id: paperOrderId, plan_id: plan.plan_id, intent_id: intent.intent_id, symbol: intent.symbol, role: intent.role, side: intent.side, quantity: intent.quantity, price: intent.price, signal_id: intent.signal_id } }])
    let fill
    try { fill = await watchBook(intent, { policy: ledger.policy, bookProvider: provider, now: current, sleep: options.sleep, openedAt: Date.parse(openedAt), maxBookAgeSeconds: config.gate.quote_max_age_seconds }) } catch (error) {
      appendPaperEvents(filePath, [{ type: 'SIMULATED_CANCELLED', at: iso(current), source_id: `${paperOrderId}:gap-cancel`, data: { paper_order_id: paperOrderId, symbol: intent.symbol, reason: 'EVIDENCE_GAP' } }, { type: 'SIMULATION_EVIDENCE_GAP', at: iso(current), source_id: `${paperOrderId}:gap`, data: { symbol: intent.symbol, code: error.code || 'PAPER_BOOK_UNAVAILABLE' } }])
      outcomes.push({ intent_id: intent.intent_id, outcome: 'BLOCKED', code: error.code || 'PAPER_BOOK_UNAVAILABLE' })
      continue
    }
    if (!fill) {
      appendPaperEvents(filePath, [{ type: 'SIMULATED_CANCELLED', at: iso(current), source_id: `${paperOrderId}:timeout`, data: { paper_order_id: paperOrderId, symbol: intent.symbol, reason: 'WATCH_EXPIRED', side: intent.side, price: intent.price } }])
      outcomes.push({ intent_id: intent.intent_id, outcome: 'SIMULATED_CANCELLED' })
      continue
    }
    const at = iso(current)
    const fillType = fill.complete ? 'SIMULATED_FILLED' : 'SIMULATED_PARTIAL_FILL'
    const paperFillId = `pf_${sha256Hex({ paper_order_id: paperOrderId, fill }).slice(0, 24)}`
    if (intent.role === 'ENTRY') {
      const risk = plan.paper_risk_proof?.[intent.intent_id]
      if (!risk) fail('PAPER_RISK_PROOF_MISSING', 'Paper entry lacks sealed liquidation and margin proof')
      const notional = decimalMultiply(decimalMultiply(fill.contracts, risk.multiplier), fill.price)
      const fee = decimalMultiply(notional, risk.taker_fee_rate)
      const margin = divideToStep(decimalMultiply(risk.margin, fill.contracts), intent.quantity, '0.00000001')
      appendPaperEvents(filePath, [
        { type: fillType, at, source_id: `${paperFillId}:entry`, data: { paper_order_id: paperOrderId, paper_fill_id: paperFillId, plan_id: plan.plan_id, intent_id: intent.intent_id, symbol: intent.symbol, role: 'ENTRY', side: intent.size > 0 ? 'long' : 'short', contracts: fill.contracts, price: fill.price, notional, fee, fee_estimated: true, multiplier: risk.multiplier, margin, liquidation_price: risk.liquidation_price, tick_size: risk.tick_size, taker_fee_rate: risk.taker_fee_rate, maintenance_rate: risk.maintenance_rate, tier_deduction: risk.tier_deduction, signal_id: intent.signal_id, book_id: fill.book_id, book_current: fill.book_current, book_update: fill.book_update } },
        { type: 'SIMULATED_PROTECTION_ARMED', at, source_id: `${paperFillId}:protection`, data: { symbol: intent.symbol, contracts: fill.contracts, stop_price: intent.protection.stop_price, target_price: intent.protection.target_price } },
        ...(!fill.complete ? [{ type: 'SIMULATED_CANCELLED', at, source_id: `${paperOrderId}:remainder`, data: { paper_order_id: paperOrderId, symbol: intent.symbol, reason: 'VISIBLE_DEPTH_EXHAUSTED' } }] : [])
      ])
    } else {
      const position = state.positions[intent.symbol]
      if (!position) fail('PAPER_REDUCTION_POSITION_MISSING', 'Paper reduction has no managed position')
      const contracts = decimalCompare(fill.contracts, position.contracts) > 0 ? position.contracts : fill.contracts
      const closing = closeData(position, contracts, fill.price, intent.action, position.taker_fee_rate)
      const fillEvent = { type: fillType, at, source_id: `${paperFillId}:reduction`, data: { paper_order_id: paperOrderId, paper_fill_id: paperFillId, plan_id: plan.plan_id, intent_id: intent.intent_id, symbol: intent.symbol, role: 'REDUCTION', side: position.side, contracts, price: fill.price, notional: decimalMultiply(decimalMultiply(contracts, position.multiplier), fill.price), fee: closing.fee, fee_estimated: true, signal_id: intent.signal_id, book_id: fill.book_id, book_current: fill.book_current, book_update: fill.book_update } }
      appendPaperEvents(filePath, [fillEvent, { type: 'SIMULATED_POSITION_CLOSED', at, source_id: `${paperFillId}:close`, data: closing }, ...(!fill.complete ? [{ type: 'SIMULATED_CANCELLED', at, source_id: `${paperOrderId}:remainder`, data: { paper_order_id: paperOrderId, symbol: intent.symbol, reason: 'VISIBLE_DEPTH_EXHAUSTED' } }] : [])])
    }
    filledContracts = decimalAdd(filledContracts, fill.contracts)
    outcomes.push({ intent_id: intent.intent_id, outcome: fillType, contracts: fill.contracts })
  }
  const finalLedger = readJsonStrict(filePath)
  validatePaperLedger(finalLedger)
  const receipt = { schema: 'tyche_paper_apply_receipt/v1', account_id: ledger.account_id, plan_id: plan.plan_id, plan_hash: plan.plan_hash, generated_at: iso(current), outcomes, simulated_filled_contracts: filledContracts, paper_ledger_digest: sha256Hex(finalLedger), submitted: 0, filled: 0 }
  receipt.receipt_id = `par_${sha256Hex(receipt).slice(0, 24)}`
  receipt.receipt_hash = sha256Hex(receipt)
  return receipt
}

function publicState(state) {
  return {
    account_id: state.account_id,
    balance: state.balance,
    available_quote: state.available_quote,
    equity: state.equity,
    realized_pnl: state.realized_pnl,
    unrealized_pnl: state.unrealized_pnl,
    fees: state.fees,
    funding: state.funding,
    daily_equity_change: state.daily_equity_change,
    drawdown: state.drawdown,
    evidence_gap: state.evidence_gap,
    positions: Object.values(state.positions),
    active_orders: Object.values(state.orders).filter((order) => ['OPEN', 'PARTIALLY_FILLED'].includes(order.status)),
    simulated_filled_contracts: state.simulated_filled_contracts
  }
}

export function writePaperReport(input, options = {}) {
  const ledger = validatePaperLedger(input)
  const state = publicState(derivePaperState(ledger))
  const reportPath = options.reportPath || path.join(ROOT, 'outputs', 'paper-report.md')
  const asOf = iso(options.now)
  const latestDaily = Object.entries(state.daily_equity_change).sort(([left], [right]) => left.localeCompare(right)).at(-1) || [asOf.slice(0, 10), '0']
  const markdown = `# Tyche USDT-M paper report\n\nAs of: ${asOf}\n\n- Account: ${state.account_id}\n- Balance: ${state.balance} USDT\n- Equity: ${state.equity} USDT\n- Available: ${state.available_quote} USDT\n- Realized PnL: ${state.realized_pnl} USDT\n- Unrealized PnL: ${state.unrealized_pnl} USDT\n- Fees (estimated): ${state.fees} USDT\n- Funding: ${state.funding} USDT\n- Latest UTC daily equity change (${latestDaily[0]}): ${latestDaily[1]} USDT\n- Drawdown ratio: ${state.drawdown}\n- Evidence gap: ${state.evidence_gap}\n- Simulated filled contracts: ${state.simulated_filled_contracts}\n- Open positions: ${state.positions.length}\n- Venue submitted: 0; venue filled: 0\n`
  writeTextAtomic(reportPath, markdown)
  return { outcome: 'REPORTED', report_path: path.relative(ROOT, reportPath).split(path.sep).join('/'), state, submitted: 0, filled: 0 }
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const command = values[0]
  const get = (flag, fallback = null) => {
    const positions = values.map((value, index) => value === flag ? index : -1).filter((index) => index >= 0)
    if (positions.length > 1) fail('PAPER_DUPLICATE_FLAG', `${flag} may appear only once`)
    if (!positions.length) return fallback
    const value = values[positions[0] + 1]
    if (!value || value.startsWith('--')) fail('PAPER_ARGUMENT_INVALID', `${flag} requires a value`)
    return value
  }
  if (!['init', 'status', 'settle', 'plan', 'apply', 'report', 'archive'].includes(command)) fail('PAPER_COMMAND_UNSUPPORTED', 'Commands: init, status, settle, plan, apply, report, archive')
  return { command, get, configPath: get('--config', path.join(ROOT, 'config', 'tyche.json')) }
}

function writePlan(plan) {
  const target = path.join(ROOT, 'outputs', 'plans', `gate-plan-${plan.plan_id}.json`)
  const report = path.join(ROOT, 'outputs', 'reports', `gate-plan-${plan.plan_id}.md`)
  writeJsonAtomic(target, plan)
  writeTextAtomic(report, `# Tyche USDT-M paper plan ${plan.status}\n\nAs of: ${plan.created_at}\n\n- Plan: ${plan.plan_id}\n- Intents: ${plan.intents.length}\n- Blockers: ${plan.blockers.length}\n- Environment: dry-run\n- Venue submitted: 0; venue filled: 0\n`)
  return { plan_path: path.relative(ROOT, target).split(path.sep).join('/'), report_path: path.relative(ROOT, report).split(path.sep).join('/') }
}

async function cli(argv) {
  const args = parseArgs(argv)
  if (args.command === 'init') {
    const config = loadConfig({ filePath: args.configPath })
    const ledger = createPaperLedger({ config, initialUsdt: args.get('--initial-usdt'), dailyLossBps: args.get('--daily-loss-bps'), maxDrawdownBps: args.get('--max-drawdown-bps'), maxSpreadBps: args.get('--max-spread-bps'), maxEntryDistanceBps: args.get('--max-entry-distance-bps'), triggerSlippageBps: args.get('--trigger-slippage-bps') })
    withFileLock(ACTIVE_PATH, () => {
      if (fs.existsSync(ACTIVE_PATH)) fail('PAPER_ACCOUNT_EXISTS', 'Active paper account already exists')
      writeJsonAtomic(ACTIVE_PATH, ledger)
    })
    process.stdout.write(`${JSON.stringify({ outcome: 'INITIALIZED', account_id: ledger.account_id, path: 'data/paper/active.json', submitted: 0, filled: 0 }, null, 2)}\n`)
    return
  }
  const ledger = readJsonStrict(ACTIVE_PATH)
  validatePaperLedger(ledger)
  if (args.command === 'status') {
    process.stdout.write(`${JSON.stringify({ outcome: 'STATUS', ...publicState(derivePaperState(ledger)), submitted: 0, filled: 0 }, null, 2)}\n`)
    return
  }
  if (args.command === 'settle') {
    const result = await settlePaper({ filePath: ACTIVE_PATH })
    const report = writePaperReport(readJsonStrict(ACTIVE_PATH))
    process.stdout.write(`${JSON.stringify({ ...result, paper_report_path: report.report_path }, null, 2)}\n`)
    return
  }
  if (args.command === 'plan') {
    const config = loadConfig({ filePath: args.configPath })
    const date = args.get('--date')
    const isoWeek = args.get('--iso-week')
    const plan = createPaperPlan(readJsonStrict(args.get('--source', DAILY_PATH)), { config, ledger, marketSnapshot: readJsonStrict(MARKET_PATH), weeklyAnchor: readJsonStrict(WEEKLY_PATH, { missingDefault: null }), date, isoWeek, now: Date.now(), killActive: fs.existsSync(path.join(ROOT, config.gate.kill_switch_path)) })
    const paths = writePlan(plan)
    process.stdout.write(`${JSON.stringify({ outcome: plan.status, product: 'usdm', environment: 'dry-run', plan_id: plan.plan_id, plan_hash: plan.plan_hash, intents: plan.intents.length, blockers: plan.blockers, skipped: plan.skipped, ...paths, submitted: 0, filled: 0 }, null, 2)}\n`)
    return
  }
  if (args.command === 'apply') {
    const config = loadConfig({ filePath: args.configPath })
    const receipt = await applyPaperPlan(readJsonStrict(args.get('--plan')), { filePath: ACTIVE_PATH, config })
    writePaperReport(readJsonStrict(ACTIVE_PATH))
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    return
  }
  if (args.command === 'report') {
    process.stdout.write(`${JSON.stringify(writePaperReport(ledger), null, 2)}\n`)
    return
  }
  if (args.command === 'archive') {
    const accountId = args.get('--account-id')
    if (accountId !== ledger.account_id || args.get('--confirm') !== `ARCHIVE PAPER ${ledger.account_id}`) fail('PAPER_ARCHIVE_CONFIRMATION_INVALID', 'Exact paper archive identity and confirmation are required')
    const target = path.join(ROOT, 'data', 'paper', 'archive', `${ledger.account_id}.json`)
    withFileLock(ACTIVE_PATH, () => {
      const currentLedger = readJsonStrict(ACTIVE_PATH)
      validatePaperLedger(currentLedger)
      if (currentLedger.account_id !== ledger.account_id) fail('PAPER_ARCHIVE_ACCOUNT_DRIFT', 'Active paper account changed before archive')
      const state = derivePaperState(currentLedger)
      if (Object.keys(state.positions).length || Object.values(state.orders).some((order) => ['OPEN', 'PARTIALLY_FILLED'].includes(order.status))) fail('PAPER_ARCHIVE_ACTIVE_RISK', 'Cannot archive with active paper positions or orders')
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      if (fs.existsSync(target)) fail('PAPER_ARCHIVE_EXISTS', 'Paper archive already exists')
      fs.renameSync(ACTIVE_PATH, target)
    })
    process.stdout.write(`${JSON.stringify({ outcome: 'ARCHIVED', account_id: ledger.account_id, archive_path: path.relative(ROOT, target).split(path.sep).join('/'), submitted: 0, filled: 0 }, null, 2)}\n`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  cli(process.argv).catch((error) => {
    process.stdout.write(`${JSON.stringify({ outcome: 'BLOCKED', code: error.code || 'PAPER_ERROR', message: String(error.message || error), submitted: 0, filled: 0 }, null, 2)}\n`)
    process.exitCode = 1
  })
}
