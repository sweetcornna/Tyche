#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'tyche.json')
const ASSETS = Object.freeze(['BTC', 'ETH'])
const SYMBOLS = Object.freeze(['BTC_USDT', 'ETH_USDT'])
const SECRET_KEY = /(?:api.?key|secret|token|password|passwd|credential|signature|authorization|cookie|passphrase|private.?key)/i
const NETWORK_KEY = /^(?:url|urls|base_?url|host|hostname|endpoint|endpoints|method|methods|headers?)$/i
const ACCOUNT_VALUE_KEY = /(?:balance|available|equity|purchasing.?power|static.?capital|capital.?amount)/i
const ACCOUNT_POLICY_KEYS = new Set(['balance_buffer_bps', 'risk_capital_fraction_bps'])
const TRANSFER_KEY = /(?:transfer|auto_?fund|wallet_?swap|sweep)/i
const URL_VALUE = /^[a-z][a-z0-9+.-]*:\/\//i

export class ConfigError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'ConfigError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new ConfigError(code, message, details)
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CONFIG_SHAPE_INVALID', `${label} must be an object`)
  return value
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(object(value, label)).filter((key) => !allowed.includes(key))
  if (extras.length) fail('CONFIG_UNKNOWN_KEY', `${label} contains unsupported keys: ${extras.join(', ')}`, { path: label, extras })
}

function positiveNumber(value, label, options = {}) {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) fail('CONFIG_NUMBER_FORMAT_INVALID', `${label} must be a plain non-negative decimal`)
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) fail('CONFIG_POSITIVE_REQUIRED', `${label} must be positive`)
  if (options.integer && !Number.isInteger(n)) fail('CONFIG_INTEGER_REQUIRED', `${label} must be an integer`)
  if (options.max !== undefined && n > options.max) fail('CONFIG_RANGE_INVALID', `${label} must be <= ${options.max}`)
  if (options.min !== undefined && n < options.min) fail('CONFIG_RANGE_INVALID', `${label} must be >= ${options.min}`)
  return n
}

function optionalPositive(value, label, options = {}) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (options.allowZero && number === 0) {
    if (!/^(?:0|0\.0+)$/.test(String(value).trim())) fail('CONFIG_NUMBER_FORMAT_INVALID', `${label} must be a plain decimal`)
    return 0
  }
  return positiveNumber(value, label, options)
}

function basisPoints(value, label, { allowZero = false } = {}) {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) fail('CONFIG_NUMBER_FORMAT_INVALID', `${label} must be a plain non-negative decimal`)
  const n = Number(text)
  const lowerOk = allowZero ? n >= 0 : n > 0
  if (!Number.isFinite(n) || !lowerOk || n > 10000) fail('CONFIG_BPS_INVALID', `${label} must be ${allowZero ? 'between 0 and' : 'greater than 0 and no more than'} 10000`)
  return n
}

function assertExactList(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    fail('CONFIG_SCOPE_INVALID', `${label} must be exactly ${expected.join(', ')}`)
  }
}

function scanUnsafe(value, location = '$', seen = new Set()) {
  if (typeof value === 'string') {
    if (URL_VALUE.test(value)) fail('CONFIG_NETWORK_LOCATION_FORBIDDEN', `${location} must not contain a URL`)
    if (/^(?:live|prod|production)$/i.test(value)) fail('CONFIG_ENVIRONMENT_UNSUPPORTED', `${location} selects an unsupported production mutation environment`)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) fail('CONFIG_CYCLE', `${location} is circular`)
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`
    if (SECRET_KEY.test(key)) fail('CONFIG_SECRET_KEY_FORBIDDEN', `${childLocation} is secret-shaped; credentials must be environment-only`)
    if (NETWORK_KEY.test(key)) fail('CONFIG_NETWORK_LOCATION_FORBIDDEN', `${childLocation} cannot override fixed transport routing`)
    if (ACCOUNT_VALUE_KEY.test(key) && !ACCOUNT_POLICY_KEYS.has(key)) fail('CONFIG_STATIC_ACCOUNT_VALUE_FORBIDDEN', `${childLocation} cannot contain a static account value`)
    if (TRANSFER_KEY.test(key)) fail('CONFIG_TRANSFER_FORBIDDEN', `${childLocation} cannot configure transfers or wallet swaps`)
    scanUnsafe(child, childLocation, seen)
  }
  seen.delete(value)
}

function validateProductCommon(product, label, options = {}) {
  if (product.enabled !== true && product.enabled !== false) fail('CONFIG_BOOLEAN_REQUIRED', `${label}.enabled must be boolean`)
  if (product.asset !== 'USDT') fail('CONFIG_ACCOUNT_SCOPE_INVALID', `${label}.asset must be USDT`)
  basisPoints(product.risk_capital_fraction_bps, `${label}.risk_capital_fraction_bps`)
  basisPoints(product.balance_buffer_bps, `${label}.balance_buffer_bps`, { allowZero: true })
  if (Number(product.balance_buffer_bps) >= 10000) fail('CONFIG_BPS_INVALID', `${label}.balance_buffer_bps must be below 10000`)
  optionalPositive(product.risk_per_trade_bps, `${label}.risk_per_trade_bps`, { max: 10000, allowZero: options.locked === true })
  optionalPositive(product.max_order_notional_usdt, `${label}.max_order_notional_usdt`, { allowZero: options.locked === true })
  optionalPositive(product.daily_new_notional_cap_usdt, `${label}.daily_new_notional_cap_usdt`, { allowZero: options.locked === true })
  optionalPositive(product.max_managed_notional_usdt, `${label}.max_managed_notional_usdt`, { allowZero: options.locked === true })

  const caps = [product.risk_per_trade_bps, product.max_order_notional_usdt, product.daily_new_notional_cap_usdt, product.max_managed_notional_usdt]
  const populated = caps.filter((value) => Number(value) > 0).length
  if (populated !== 0 && populated !== caps.length) fail('CONFIG_CAPS_PARTIAL', `${label} risk and notional limits must be all zero/unset or all positive`)
  if (populated === caps.length) {
    if (Number(product.max_order_notional_usdt) > Number(product.daily_new_notional_cap_usdt)) fail('CONFIG_CAP_ORDER_INVALID', `${label}.max_order_notional_usdt cannot exceed the daily cap`)
    if (Number(product.max_order_notional_usdt) > Number(product.max_managed_notional_usdt)) fail('CONFIG_CAP_ORDER_INVALID', `${label}.max_order_notional_usdt cannot exceed the managed cap`)
  }
  return populated === caps.length
}

function validateBinance(config) {
  exactKeys(config.binance, [
    'enabled', 'submission_mode', 'plan_ttl_seconds', 'quote_max_age_seconds', 'account_max_age_seconds',
    'rules_max_age_seconds', 'reconciliation_max_age_seconds', 'entry_watch_seconds', 'poll_interval_ms',
    'kill_switch_path', 'usdm'
  ], 'binance')
  if (config.binance.enabled !== true && config.binance.enabled !== false) fail('CONFIG_BOOLEAN_REQUIRED', 'binance.enabled must be boolean')
  if (!['locked', 'automatic_testnet'].includes(config.binance.submission_mode)) fail('CONFIG_SUBMISSION_MODE_INVALID', 'binance.submission_mode must be locked or automatic_testnet')
  positiveNumber(config.binance.plan_ttl_seconds, 'binance.plan_ttl_seconds', { integer: true, min: 60, max: 86400 })
  positiveNumber(config.binance.quote_max_age_seconds, 'binance.quote_max_age_seconds', { max: 300 })
  positiveNumber(config.binance.account_max_age_seconds, 'binance.account_max_age_seconds', { max: 300 })
  positiveNumber(config.binance.rules_max_age_seconds, 'binance.rules_max_age_seconds', { max: 86400 })
  positiveNumber(config.binance.reconciliation_max_age_seconds, 'binance.reconciliation_max_age_seconds', { max: 3600 })
  positiveNumber(config.binance.entry_watch_seconds, 'binance.entry_watch_seconds', { max: 600 })
  positiveNumber(config.binance.poll_interval_ms, 'binance.poll_interval_ms', { min: 100, max: 30000 })
  if (config.binance.kill_switch_path !== 'data/binance_KILL') fail('CONFIG_KILL_PATH_INVALID', 'binance.kill_switch_path is fixed to data/binance_KILL')

  exactKeys(config.binance.usdm, [
    'enabled', 'environment', 'wallet', 'asset', 'position_mode', 'margin_type', 'configured_leverage',
    'max_leverage', 'risk_capital_fraction_bps', 'balance_buffer_bps', 'risk_per_trade_bps',
    'max_order_notional_usdt', 'daily_new_notional_cap_usdt', 'max_managed_notional_usdt'
  ], 'binance.usdm')
  if (!['dry-run', 'testnet'].includes(config.binance.usdm.environment)) fail('CONFIG_USDM_ENVIRONMENT_INVALID', 'binance.usdm.environment must be dry-run or testnet')
  if (config.binance.usdm.wallet !== 'BINANCE_USDT_FUTURES_TESTNET') fail('CONFIG_ACCOUNT_SCOPE_INVALID', 'binance.usdm.wallet must be BINANCE_USDT_FUTURES_TESTNET')
  if (config.binance.usdm.position_mode !== 'ONE_WAY') fail('CONFIG_POSITION_MODE_INVALID', 'binance.usdm.position_mode must be ONE_WAY')
  if (config.binance.usdm.margin_type !== 'ISOLATED') fail('CONFIG_MARGIN_MODE_INVALID', 'binance.usdm.margin_type must be ISOLATED')
  positiveNumber(config.binance.usdm.max_leverage, 'binance.usdm.max_leverage', { integer: true, min: 1, max: 3 })
  const configuredLeverage = optionalPositive(config.binance.usdm.configured_leverage, 'binance.usdm.configured_leverage', { integer: true, min: 1, max: 3, allowZero: config.binance.submission_mode === 'locked' })
  if (configuredLeverage !== null && configuredLeverage > 0 && configuredLeverage > Number(config.binance.usdm.max_leverage)) fail('CONFIG_LEVERAGE_INVALID', 'binance configured leverage exceeds max leverage')
  const capsReady = validateProductCommon(config.binance.usdm, 'binance.usdm', { locked: config.binance.submission_mode === 'locked' })
  if (config.binance.submission_mode === 'automatic_testnet') {
    if (config.binance.enabled !== true || config.binance.usdm.enabled !== true) fail('CONFIG_AUTOMATIC_TESTNET_DISABLED', 'automatic_testnet requires Binance and USDT-M enabled')
    if (config.binance.usdm.environment !== 'testnet') fail('CONFIG_AUTOMATIC_TESTNET_ENVIRONMENT', 'automatic_testnet requires binance.usdm.environment=testnet')
    if (!capsReady || configuredLeverage === null) fail('CONFIG_AUTOMATIC_TESTNET_LIMITS', 'automatic_testnet requires positive user-supplied Binance USDT-M limits and leverage')
  }
}

export function validateConfig(input) {
  const config = object(input, '$')
  scanUnsafe(config)
  exactKeys(config, ['schema', 'assets', 'symbols', 'analysis', 'gate', 'binance'], '$')
  if (config.schema !== 'tyche_config/v1') fail('CONFIG_SCHEMA_INVALID', 'schema must be tyche_config/v1')
  assertExactList(config.assets, ASSETS, 'assets')

  exactKeys(config.symbols, ['spot', 'usdm'], 'symbols')
  assertExactList(config.symbols.spot, SYMBOLS, 'symbols.spot')
  assertExactList(config.symbols.usdm, SYMBOLS, 'symbols.usdm')

  exactKeys(config.analysis, ['weekly_anchor_max_age_days', 'candidate_max_age_seconds', 'minimum_rr'], 'analysis')
  positiveNumber(config.analysis.weekly_anchor_max_age_days, 'analysis.weekly_anchor_max_age_days', { max: 31 })
  positiveNumber(config.analysis.candidate_max_age_seconds, 'analysis.candidate_max_age_seconds', { max: 86400 })
  positiveNumber(config.analysis.minimum_rr, 'analysis.minimum_rr', { min: 1.5, max: 20 })

  exactKeys(config.gate, [
    'enabled', 'submission_mode', 'plan_ttl_seconds', 'quote_max_age_seconds', 'account_max_age_seconds',
    'rules_max_age_seconds', 'reconciliation_max_age_seconds', 'entry_watch_seconds', 'poll_interval_ms',
    'kill_switch_path', 'spot', 'usdm'
  ], 'gate')
  if (config.gate.enabled !== true && config.gate.enabled !== false) fail('CONFIG_BOOLEAN_REQUIRED', 'gate.enabled must be boolean')
  if (!['locked', 'manual_testnet', 'automatic_testnet'].includes(config.gate.submission_mode)) fail('CONFIG_SUBMISSION_MODE_INVALID', 'gate.submission_mode must be locked, manual_testnet, or automatic_testnet')
  positiveNumber(config.gate.plan_ttl_seconds, 'gate.plan_ttl_seconds', { integer: true, min: 60, max: 86400 })
  positiveNumber(config.gate.quote_max_age_seconds, 'gate.quote_max_age_seconds', { max: 300 })
  positiveNumber(config.gate.account_max_age_seconds, 'gate.account_max_age_seconds', { max: 300 })
  positiveNumber(config.gate.rules_max_age_seconds, 'gate.rules_max_age_seconds', { max: 86400 })
  positiveNumber(config.gate.reconciliation_max_age_seconds, 'gate.reconciliation_max_age_seconds', { max: 3600 })
  positiveNumber(config.gate.entry_watch_seconds, 'gate.entry_watch_seconds', { max: 600 })
  positiveNumber(config.gate.poll_interval_ms, 'gate.poll_interval_ms', { min: 100, max: 30000 })
  if (config.gate.kill_switch_path !== 'data/gate_KILL') fail('CONFIG_KILL_PATH_INVALID', 'gate.kill_switch_path is fixed to data/gate_KILL')

  exactKeys(config.gate.spot, [
    'enabled', 'environment', 'account_read_enabled', 'wallet', 'asset', 'risk_capital_fraction_bps',
    'balance_buffer_bps', 'risk_per_trade_bps', 'max_order_notional_usdt', 'daily_new_notional_cap_usdt',
    'max_managed_notional_usdt'
  ], 'gate.spot')
  if (config.gate.spot.environment !== 'dry-run') fail('CONFIG_SPOT_ENVIRONMENT_INVALID', 'gate.spot.environment must be dry-run')
  if (config.gate.spot.account_read_enabled !== true && config.gate.spot.account_read_enabled !== false) fail('CONFIG_BOOLEAN_REQUIRED', 'gate.spot.account_read_enabled must be boolean')
  if (config.gate.spot.wallet !== 'SPOT') fail('CONFIG_ACCOUNT_SCOPE_INVALID', 'gate.spot.wallet must be SPOT')
  validateProductCommon(config.gate.spot, 'gate.spot', { locked: config.gate.submission_mode === 'locked' })

  exactKeys(config.gate.usdm, [
    'enabled', 'environment', 'wallet', 'asset', 'position_mode', 'margin_type', 'configured_leverage',
    'max_leverage', 'risk_capital_fraction_bps', 'balance_buffer_bps', 'risk_per_trade_bps',
    'max_order_notional_usdt', 'daily_new_notional_cap_usdt', 'max_managed_notional_usdt'
  ], 'gate.usdm')
  if (!['dry-run', 'testnet'].includes(config.gate.usdm.environment)) fail('CONFIG_USDM_ENVIRONMENT_INVALID', 'gate.usdm.environment must be dry-run or testnet')
  if (config.gate.usdm.wallet !== 'USDT_FUTURES_TESTNET') fail('CONFIG_ACCOUNT_SCOPE_INVALID', 'gate.usdm.wallet must be USDT_FUTURES_TESTNET')
  if (config.gate.usdm.position_mode !== 'ONE_WAY') fail('CONFIG_POSITION_MODE_INVALID', 'gate.usdm.position_mode must be ONE_WAY')
  if (config.gate.usdm.margin_type !== 'ISOLATED') fail('CONFIG_MARGIN_MODE_INVALID', 'gate.usdm.margin_type must be ISOLATED')
  positiveNumber(config.gate.usdm.max_leverage, 'gate.usdm.max_leverage', { integer: true, min: 1, max: 3 })
  const configuredLeverage = optionalPositive(config.gate.usdm.configured_leverage, 'gate.usdm.configured_leverage', { integer: true, min: 1, max: 3, allowZero: config.gate.submission_mode === 'locked' })
  if (configuredLeverage !== null && configuredLeverage > 0 && configuredLeverage > Number(config.gate.usdm.max_leverage)) fail('CONFIG_LEVERAGE_INVALID', 'configured leverage exceeds max leverage')
  const usdmCapsReady = validateProductCommon(config.gate.usdm, 'gate.usdm', { locked: config.gate.submission_mode === 'locked' })

  if (['manual_testnet', 'automatic_testnet'].includes(config.gate.submission_mode)) {
    const prefix = config.gate.submission_mode === 'manual_testnet' ? 'MANUAL' : 'AUTOMATIC'
    if (config.gate.enabled !== true || config.gate.usdm.enabled !== true) fail(`CONFIG_${prefix}_TESTNET_DISABLED`, `${config.gate.submission_mode} requires Gate and USDT-M enabled`)
    if (config.gate.usdm.environment !== 'testnet') fail(`CONFIG_${prefix}_TESTNET_ENVIRONMENT`, `${config.gate.submission_mode} requires gate.usdm.environment=testnet`)
    if (!usdmCapsReady || configuredLeverage === null) fail(`CONFIG_${prefix}_TESTNET_LIMITS`, `${config.gate.submission_mode} requires positive user-supplied USDT-M limits and leverage`)
  }

  validateBinance(config)

  return Object.freeze({ ok: true, config })
}

export function resolveConfigPath(filePath = DEFAULT_CONFIG) {
  const raw = String(filePath || '').trim()
  if (!raw) fail('CONFIG_PATH_INVALID', 'Config path is empty')
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw))
}

export function loadConfig(options = {}) {
  const target = resolveConfigPath(options.filePath || options.configPath || DEFAULT_CONFIG)
  let raw
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch (error) {
    fail('CONFIG_READ_FAILED', `Cannot read configuration: ${path.relative(ROOT, target) || path.basename(target)}`, { cause: error?.code || null })
  }
  if (!raw.trim()) fail('CONFIG_EMPTY', 'Configuration file is empty')
  let parsed
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''))
  } catch (error) {
    fail('CONFIG_JSON_INVALID', `Configuration JSON is invalid: ${error.message}`)
  }
  validateConfig(parsed)
  return parsed
}

export function productConfig(config, product) {
  validateConfig(config)
  const normalized = String(product || '').trim().toLowerCase()
  if (!['spot', 'usdm'].includes(normalized)) fail('CONFIG_PRODUCT_UNSUPPORTED', 'Product must be spot or usdm')
  return config.gate[normalized]
}

export function executionConfigForVenue(input, venue) {
  validateConfig(input)
  const normalized = String(venue || '').trim().toLowerCase()
  if (normalized === 'gate') return input
  if (normalized !== 'binance') fail('CONFIG_VENUE_UNSUPPORTED', 'Venue must be gate or binance')
  const copy = structuredClone(input)
  copy.gate = {
    ...copy.binance,
    kill_switch_path: 'data/gate_KILL',
    spot: copy.gate.spot,
    usdm: { ...copy.binance.usdm, wallet: 'USDT_FUTURES_TESTNET' }
  }
  validateConfig(copy)
  return copy
}

function parseCli(argv) {
  const values = argv.slice(2)
  const command = values[0] || 'check'
  const at = values.indexOf('--config')
  const configPath = at >= 0 ? values[at + 1] : DEFAULT_CONFIG
  if (at >= 0 && (!configPath || String(configPath).startsWith('--'))) fail('CONFIG_ARGS_INVALID', '--config requires a file path')
  return { command, configPath }
}

function cli(argv) {
  const { command, configPath } = parseCli(argv)
  if (command !== 'check') fail('CONFIG_COMMAND_UNSUPPORTED', 'Supported command: check')
  const config = loadConfig({ filePath: configPath })
  process.stdout.write(JSON.stringify({ ok: true, schema: config.schema, assets: config.assets, submission_modes: { gate: config.gate.submission_mode, binance: config.binance.submission_mode } }, null, 2) + '\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    cli(process.argv)
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'CONFIG_ERROR', message: String(error.message || error) }, null, 2) + '\n')
    process.exitCode = 1
  }
}
