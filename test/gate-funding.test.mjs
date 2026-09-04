import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../scripts/config.mjs'
import { acquireFunding, hasPositiveFunding } from '../scripts/gate-funding.mjs'
import { manualConfig, NOW } from './helpers.mjs'

test('disabled Spot account read blocks before client creation', async () => {
  let calls = 0
  const projection = await acquireFunding({
    product: 'spot',
    environment: 'dry-run',
    config: loadConfig(),
    now: NOW,
    clientFactory: async () => { calls += 1; return {} }
  })
  assert.equal(projection.status, 'blocked')
  assert.equal(projection.blocker.code, 'SPOT_ACCOUNT_READ_DISABLED')
  assert.equal(calls, 0)
})

test('USDT-M dry-run never substitutes a production or Spot account', async () => {
  let calls = 0
  const config = loadConfig()
  const projection = await acquireFunding({
    product: 'usdm',
    environment: 'dry-run',
    config,
    now: NOW,
    clientFactory: async () => { calls += 1; return {} }
  })
  assert.equal(projection.status, 'blocked')
  assert.equal(projection.blocker.code, 'USDM_TESTNET_ACCOUNT_REQUIRED')
  assert.equal(calls, 0)
})

test('USDT-M testnet funding projection is sanitized and product-scoped', async () => {
  const config = manualConfig()
  const projection = await acquireFunding({
    product: 'usdm',
    environment: 'testnet',
    config,
    now: NOW,
    clientFactory: async (options) => {
      assert.deepEqual(options, { product: 'usdm', environment: 'testnet', readOnly: true, fetchImpl: undefined, now: NOW })
      return { usdmAccount: async () => ({ data: { currency: 'USDT', available: '50', total: '60', in_dual_mode: false, unrelated_private_field: 'must-not-persist' } }) }
    }
  })
  assert.equal(projection.status, 'ok')
  assert.equal(projection.wallet, 'USDT_FUTURES_TESTNET')
  assert.equal(projection.available_quote, '50')
  assert.equal(hasPositiveFunding(projection), true)
  assert.equal(JSON.stringify(projection).includes('unrelated_private_field'), false)
})
