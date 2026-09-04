import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyFundingPolicy,
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  divideToStep,
  managedQuantities,
  normalizeSpotFunding,
  normalizeUsdmFunding,
  normalizeUsdmPositionReadiness,
  quantizeDown,
  quantizeUp
} from '../scripts/gate-account-context.mjs'
import { NOW } from './helpers.mjs'

test('decimal helpers quantize without binary floating-point drift', () => {
  assert.equal(decimalAdd('0.1', '0.2'), '0.3')
  assert.equal(decimalMultiply('12.5', '0.08'), '1')
  assert.equal(quantizeDown('1.239', '0.01'), '1.23')
  assert.equal(quantizeUp('1.231', '0.01'), '1.24')
  assert.equal(divideToStep('10', '3', '0.01'), '3.33')
  assert.equal(decimalCompare('1.000', '1'), 0)
})

test('funding normalization preserves product-local wallet identity', () => {
  const spot = normalizeSpotFunding([{ currency: 'USDT', available: '100', locked: '2' }], { now: NOW })
  assert.equal(spot.wallet, 'SPOT')
  assert.equal(spot.environment, 'dry-run')
  const usdm = normalizeUsdmFunding({ currency: 'USDT', available: '200', in_dual_mode: false }, { now: NOW })
  assert.equal(usdm.wallet, 'USDT_FUTURES_TESTNET')
  assert.equal(usdm.environment, 'testnet')
  const buffered = applyFundingPolicy(usdm, { risk_capital_fraction_bps: 5000, balance_buffer_bps: 100 })
  assert.equal(buffered.available_quote, '198')
  assert.equal(buffered.effective_risk_capital, '99')
})

test('USDT-M readiness accepts only exchange-proven one-way isolated leverage at or below config', () => {
  const isolated = normalizeUsdmPositionReadiness({ contract: 'BTC_USDT', mode: 'single', pos_margin_mode: 'isolated', lever: '1' }, { configuredLeverage: 2 })
  assert.equal(isolated.margin_mode, 'isolated')
  assert.equal(isolated.actual_leverage, '1')
  assert.throws(() => normalizeUsdmPositionReadiness({ contract: 'BTC_USDT', mode: 'single', pos_margin_mode: 'cross', lever: '2' }, { configuredLeverage: 2 }), { code: 'ISOLATED_MARGIN_MODE_UNPROVEN' })
  assert.throws(() => normalizeUsdmPositionReadiness({ contract: 'BTC_USDT', mode: 'single', lever: '2' }, { configuredLeverage: 2 }), { code: 'ISOLATED_MARGIN_MODE_UNPROVEN' })
  assert.throws(() => normalizeUsdmPositionReadiness({ contract: 'BTC_USDT', mode: 'single', pos_margin_mode: 'isolated', lever: '3' }, { configuredLeverage: 2 }), { code: 'ISOLATED_LEVERAGE_UNPROVEN' })
  assert.throws(() => normalizeUsdmPositionReadiness({ contract: 'BTC_USDT', mode: 'dual_long', pos_margin_mode: 'isolated', lever: '2' }, { configuredLeverage: 2 }), { code: 'ONE_WAY_POSITION_UNPROVEN' })
})

test('managed exposure is reconstructed only from identifiable ledger fills', () => {
  const ledger = {
    schema: 'tyche_gate_ledger/v1',
    plans: [{ product: 'usdm', intents: [{ intent_id: 't-TYE' + 'a'.repeat(22), symbol: 'BTC_USDT', action: 'ENTER_LONG' }, { intent_id: 't-TYE' + 'b'.repeat(22), symbol: 'BTC_USDT', action: 'REDUCE_LONG' }] }],
    events: [],
    fills: [
      { intent_id: 't-TYE' + 'a'.repeat(22), symbol: 'BTC_USDT', contracts: '10' },
      { intent_id: 't-TYE' + 'b'.repeat(22), symbol: 'BTC_USDT', contracts: '3' },
      { intent_id: 'unmanaged', symbol: 'BTC_USDT', contracts: '999' }
    ],
    reconciliations: []
  }
  assert.deepEqual(managedQuantities(ledger, 'usdm'), { BTC_USDT: '7' })
})
