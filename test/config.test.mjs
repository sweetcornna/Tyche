import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, validateConfig } from '../scripts/config.mjs'

function copy() {
  return structuredClone(loadConfig())
}

function codeOf(mutator) {
  const config = copy()
  mutator(config)
  try {
    validateConfig(config)
    return null
  } catch (error) {
    return error.code
  }
}

test('committed configuration is locked with exactly BTC and ETH', () => {
  const config = loadConfig()
  assert.equal(config.gate.submission_mode, 'locked')
  assert.deepEqual(config.assets, ['BTC', 'ETH'])
  assert.deepEqual(config.symbols.spot, ['BTC_USDT', 'ETH_USDT'])
  assert.equal(config.gate.usdm.configured_leverage, null)
  assert.equal(config.gate.usdm.max_order_notional_usdt, null)
})

test('zero or unset limits are valid only while locked', () => {
  const locked = copy()
  locked.gate.usdm.configured_leverage = 0
  locked.gate.usdm.risk_per_trade_bps = 0
  locked.gate.usdm.max_order_notional_usdt = 0
  locked.gate.usdm.daily_new_notional_cap_usdt = 0
  locked.gate.usdm.max_managed_notional_usdt = 0
  assert.equal(validateConfig(locked).ok, true)
  locked.gate.submission_mode = 'manual_testnet'
  locked.gate.usdm.environment = 'testnet'
  assert.throws(() => validateConfig(locked), { code: 'CONFIG_POSITIVE_REQUIRED' })
})

test('manual testnet requires positive user-supplied limits and leverage', () => {
  assert.equal(codeOf((config) => {
    config.gate.submission_mode = 'manual_testnet'
    config.gate.usdm.environment = 'testnet'
  }), 'CONFIG_MANUAL_TESTNET_LIMITS')

  const config = copy()
  config.gate.submission_mode = 'manual_testnet'
  config.gate.usdm.environment = 'testnet'
  config.gate.usdm.configured_leverage = 2
  config.gate.usdm.risk_per_trade_bps = 20
  config.gate.usdm.max_order_notional_usdt = 50
  config.gate.usdm.daily_new_notional_cap_usdt = 100
  config.gate.usdm.max_managed_notional_usdt = 150
  assert.equal(validateConfig(config).ok, true)
})

test('Binance automatic testnet is independently locked and requires explicit positive limits', () => {
  assert.equal(codeOf((config) => {
    config.binance.enabled = true
    config.binance.usdm.enabled = true
    config.binance.submission_mode = 'automatic_testnet'
    config.binance.usdm.environment = 'testnet'
  }), 'CONFIG_AUTOMATIC_TESTNET_LIMITS')

  const config = copy()
  config.binance.enabled = true
  config.binance.submission_mode = 'automatic_testnet'
  config.binance.usdm.enabled = true
  config.binance.usdm.environment = 'testnet'
  config.binance.usdm.configured_leverage = 2
  config.binance.usdm.risk_per_trade_bps = 20
  config.binance.usdm.max_order_notional_usdt = 50
  config.binance.usdm.daily_new_notional_cap_usdt = 100
  config.binance.usdm.max_managed_notional_usdt = 150
  assert.equal(validateConfig(config).ok, true)
  assert.equal(config.gate.submission_mode, 'locked')
})

test('configuration recursively rejects secrets, network overrides, static account values, and transfers', () => {
  assert.equal(codeOf((config) => { config.gate.usdm.nested = { [['api', 'key'].join('_')]: ['not', 'a', 'credential'].join('-') } }), 'CONFIG_SECRET_KEY_FORBIDDEN')
  assert.equal(codeOf((config) => { config.gate.usdm.nested = { endpoint: '/unsafe' } }), 'CONFIG_NETWORK_LOCATION_FORBIDDEN')
  assert.equal(codeOf((config) => { config.gate.usdm.nested = { note: 'https://example.invalid' } }), 'CONFIG_NETWORK_LOCATION_FORBIDDEN')
  assert.equal(codeOf((config) => { config.gate.usdm.nested = { static_available_usdt: 10 } }), 'CONFIG_STATIC_ACCOUNT_VALUE_FORBIDDEN')
  assert.equal(codeOf((config) => { config.gate.usdm.auto_transfer = true }), 'CONFIG_TRANSFER_FORBIDDEN')
})

test('configuration rejects scope and account-mode drift', () => {
  assert.equal(codeOf((config) => { config.assets = ['BTC', 'ETH', 'SOL'] }), 'CONFIG_SCOPE_INVALID')
  assert.equal(codeOf((config) => { config.gate.usdm.environment = 'live' }), 'CONFIG_ENVIRONMENT_UNSUPPORTED')
  assert.equal(codeOf((config) => { config.gate.usdm.wallet = 'SPOT' }), 'CONFIG_ACCOUNT_SCOPE_INVALID')
  assert.equal(codeOf((config) => { config.gate.usdm.position_mode = 'HEDGE' }), 'CONFIG_POSITION_MODE_INVALID')
  assert.equal(codeOf((config) => { config.gate.usdm.margin_type = 'CROSS' }), 'CONFIG_MARGIN_MODE_INVALID')
  assert.equal(codeOf((config) => { config.gate.usdm.max_leverage = 4 }), 'CONFIG_RANGE_INVALID')
  assert.equal(codeOf((config) => { config.gate.plan_ttl_seconds = '1e3' }), 'CONFIG_NUMBER_FORMAT_INVALID')
})
