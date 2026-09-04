import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executionConfigForVenue, loadConfig, validateConfig } from '../scripts/config.mjs'
import { AUTOMATIC_TESTNET_AUTHORIZATION, executePlan, staticAutomaticExecutionGate } from '../scripts/gate-trade.mjs'
import { executeAutomaticTestnetPlan, runAutomaticTestnetCycle } from '../scripts/testnet-trade.mjs'
import { DATE, NOW, dailySource, marketSnapshot, readyPlan, weeklyAnchor } from './helpers.mjs'

function automaticConfig(venue = 'gate') {
  const config = structuredClone(loadConfig())
  const block = venue === 'gate' ? config.gate : config.binance
  block.enabled = true
  block.submission_mode = 'automatic_testnet'
  block.usdm.enabled = true
  block.usdm.environment = 'testnet'
  block.usdm.configured_leverage = 2
  block.usdm.risk_per_trade_bps = 25
  block.usdm.max_order_notional_usdt = 100
  block.usdm.daily_new_notional_cap_usdt = 200
  block.usdm.max_managed_notional_usdt = 300
  validateConfig(config)
  return config
}

function options(plan, config, directory) {
  return {
    config,
    planId: plan.plan_id,
    planHash: plan.plan_hash,
    executionMode: 'automatic_testnet',
    automaticAuthorization: AUTOMATIC_TESTNET_AUTHORIZATION,
    venue: 'gate',
    ledgerPath: path.join(directory, 'ledger.json'),
    killPath: path.join(directory, 'gate_KILL'),
    marketSnapshot: marketSnapshot(),
    weeklyAnchor: weeklyAnchor(),
    executionSource: dailySource({ candidate: { signal_id: plan.intents[0].signal_id } }),
    now: () => NOW,
    sleep: async () => {}
  }
}

function filledClient(plan) {
  const entry = plan.intents[0]
  const orders = new Map()
  let placeCalls = 0
  let protectionCalls = 0
  const client = {
    usdmContract: async ({ contract }) => ({ data: { name: contract, order_price_round: '0.1', quanto_multiplier: '0.001', order_size_min: '1', order_size_max: '100000', leverage_max: '3', maintenance_rate: '0.005', maker_fee_rate: '-0.0001', taker_fee_rate: '0.0005', status: 'trading', in_delisting: false } }),
    usdmTickers: async ({ contract }) => ({ data: [{ contract, last: '100', mark_price: '100', index_price: '100' }] }),
    usdmPosition: async ({ contract }) => ({ data: { contract, mode: 'single', pos_margin_mode: 'isolated', lever: '2', size: '0' } }),
    usdmAccount: async () => ({ data: { currency: 'USDT', available: '1000', in_dual_mode: false } }),
    usdmPositions: async () => ({ data: [{ contract: entry.symbol, mode: 'single', pos_margin_mode: 'isolated', lever: '2', size: '0' }] }),
    usdmOrders: async () => ({ data: [] }),
    usdmPriceOrders: async () => ({ data: [] }),
    usdmTrades: async ({ order }) => order ? { data: [{ id: `trade-${order}`, order_id: String(order), contract: entry.symbol, size: String(Math.abs(entry.size)), price: entry.price, text: entry.intent_id }] } : { data: [] },
    usdmPlaceOrder: async (payload) => {
      placeCalls += 1
      const order = { id: 'testnet-entry-1', status: 'finished', finish_as: 'filled', size: payload.size, left: 0, text: payload.text }
      orders.set(order.id, order)
      return { data: order }
    },
    usdmOrder: async ({ order_id }) => ({ data: orders.get(String(order_id)) }),
    findUsdmOrderByText: async () => { throw new Error('not expected') },
    usdmCancelOrder: async () => { throw new Error('not expected') },
    usdmPlacePriceOrder: async (payload) => ({ data: { id: `protection-${++protectionCalls}`, status: 'open', initial: payload.initial, trigger: payload.trigger } }),
    usdmPriceOrder: async ({ order_id }) => ({ data: { id: order_id, status: 'open' } }),
    usdmCancelPriceOrder: async ({ order_id }) => ({ data: { id: order_id, status: 'finished' } })
  }
  return { client, placeCalls: () => placeCalls, protectionCalls: () => protectionCalls }
}

test('automatic testnet mode is explicit, venue-bound, and does not require TTY or a phrase', () => {
  const config = automaticConfig('gate')
  const { plan } = readyPlan({ config })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-auto-gate-'))
  const common = options(plan, config, directory)
  assert.equal(staticAutomaticExecutionGate(plan, common).ok, true)
  assert.equal(staticAutomaticExecutionGate(plan, { ...common, automaticAuthorization: null }).code, 'AUTOMATIC_TESTNET_AUTHORIZATION_REQUIRED')
  assert.equal(staticAutomaticExecutionGate(plan, { ...common, venue: 'binance' }).code, 'PLAN_VENUE_MISMATCH')
  const manual = structuredClone(config)
  manual.gate.submission_mode = 'manual_testnet'
  assert.equal(staticAutomaticExecutionGate(plan, { ...common, config: manual }).code, 'SUBMISSION_MODE_LOCKED')
})

test('automatic Gate execution preserves reservation, fill proof, and exact protection lifecycle', async () => {
  const config = automaticConfig('gate')
  const { plan } = readyPlan({ config })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-auto-execute-'))
  const mock = filledClient(plan)
  const result = await executePlan(plan, { ...options(plan, config, directory), client: mock.client })
  assert.equal(result.outcome, 'COMPLETE')
  assert.equal(result.venue, 'gate')
  assert.equal(result.counts.submitted, 3)
  assert.equal(result.counts.filled, 1)
  assert.equal(mock.placeCalls(), 1)
  assert.equal(mock.protectionCalls(), 2)
  assert.ok(result.lifecycle.some((row) => row.status === 'PROTECTED'))
})

test('high-level automatic executor stays locked by config and writes no venue order', async () => {
  const config = structuredClone(loadConfig())
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-auto-locked-'))
  const { plan } = readyPlan({ config: automaticConfig('gate') })
  let calls = 0
  await assert.rejects(executeAutomaticTestnetPlan({
    venue: 'gate',
    config,
    plan,
    ledgerPath: path.join(directory, 'ledger.json'),
    killPath: path.join(directory, 'gate_KILL'),
    weeklyAnchor: weeklyAnchor(),
    marketSnapshot: marketSnapshot(),
    executionSource: dailySource(),
    client: { usdmPlaceOrder: async () => { calls += 1 } },
    now: () => NOW
  }), { code: 'AUTOMATIC_TESTNET_LOCKED' })
  assert.equal(calls, 0)
})

test('Binance execution config is isolated from Gate limits and remains testnet-only', () => {
  const config = automaticConfig('binance')
  const mapped = executionConfigForVenue(config, 'binance')
  assert.equal(mapped.gate.submission_mode, 'automatic_testnet')
  assert.equal(config.binance.usdm.wallet, 'BINANCE_USDT_FUTURES_TESTNET')
  assert.equal(mapped.gate.usdm.wallet, 'USDT_FUTURES_TESTNET')
  assert.equal(mapped.gate.usdm.environment, 'testnet')
  assert.equal(config.gate.submission_mode, 'locked')
})

test('one venue-bound Binance cycle plans, submits once, proves the fill, and arms both protections', async () => {
  const config = automaticConfig('binance')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-binance-cycle-'))
  const orders = new Map()
  let placeCalls = 0
  let protectionCalls = 0
  const rule = (contract) => ({ name: contract, order_price_round: '0.1', quanto_multiplier: '0.001', order_size_min: '1', order_size_max: '100000', leverage_max: '3', maintenance_rate: '0.005', maker_fee_rate: '0.0002', taker_fee_rate: '0.0005', status: 'trading', in_delisting: false })
  const client = {
    usdmContract: async ({ contract }) => ({ data: rule(contract) }),
    usdmTickers: async ({ contract }) => ({ data: [{ contract, last: '100', mark_price: '100', index_price: '100' }] }),
    usdmPosition: async ({ contract }) => ({ data: { contract, mode: 'single', pos_margin_mode: 'isolated', lever: '2', size: '0' } }),
    usdmAccount: async () => ({ data: { currency: 'USDT', available: '1000', in_dual_mode: false, _tyche_wallet: 'BINANCE_USDT_FUTURES_TESTNET', _tyche_funding_source: 'binance_usdm_testnet_available' } }),
    usdmPositions: async () => ({ data: ['BTC_USDT', 'ETH_USDT'].map((contract) => ({ contract, mode: 'single', pos_margin_mode: 'isolated', lever: '2', size: '0' })) }),
    usdmOrders: async () => ({ data: [] }),
    usdmPriceOrders: async () => ({ data: [] }),
    usdmTrades: async ({ contract, order }) => {
      if (!order) return { data: [] }
      const placed = orders.get(String(order))
      return placed ? { data: [{ id: `trade-${order}`, order_id: String(order), contract, size: String(Math.abs(placed.size)), price: placed.price, text: placed.text }] } : { data: [] }
    },
    usdmPlaceOrder: async (payload) => {
      placeCalls += 1
      const row = { id: `binance-entry-${placeCalls}`, status: 'finished', finish_as: 'filled', size: payload.size, left: 0, price: payload.price, text: payload.text }
      orders.set(row.id, row)
      return { data: row }
    },
    usdmOrder: async ({ order_id }) => ({ data: orders.get(String(order_id)) }),
    findUsdmOrderByText: async () => { throw new Error('not expected') },
    usdmCancelOrder: async () => { throw new Error('not expected') },
    usdmPlacePriceOrder: async (payload) => ({ data: { id: `binance-protection-${++protectionCalls}`, status: 'open', initial: payload.initial, trigger: payload.trigger } }),
    usdmPriceOrder: async ({ order_id }) => ({ data: { id: order_id, status: 'open' } }),
    usdmCancelPriceOrder: async ({ order_id }) => ({ data: { id: order_id, status: 'finished' } })
  }
  const result = await runAutomaticTestnetCycle({
    venue: 'binance',
    config,
    source: dailySource(),
    date: DATE,
    isoWeek: '2030-W02',
    weeklyAnchor: weeklyAnchor(),
    marketSnapshot: marketSnapshot(),
    client,
    ledgerPath: path.join(directory, 'ledger.json'),
    killPath: path.join(directory, 'binance_KILL'),
    planPath: path.join(directory, 'plan.json'),
    reportPath: path.join(directory, 'report.md'),
    now: () => NOW,
    sleep: async () => {}
  })
  assert.equal(result.phase, 'COMPLETE')
  assert.equal(result.venue, 'binance')
  assert.equal(result.execution.outcome, 'COMPLETE')
  assert.equal(result.execution.submitted, 3)
  assert.equal(result.execution.filled, 1)
  assert.equal(placeCalls, 1)
  assert.equal(protectionCalls, 2)
})
