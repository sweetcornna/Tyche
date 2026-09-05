import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executePlan, reconcileSnapshot, readLedger, unresolvedRedCauses } from '../scripts/gate-trade.mjs'
import { NOW, dailySource, marketSnapshot, readyPlan, weeklyAnchor } from './helpers.mjs'

function emptyLedger() {
  return { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }
}

function baseClient(plan, options = {}) {
  const mainSize = plan.intents[0].size
  let placeCalls = 0
  let protectionId = 10
  const protectionPayloads = []
  const client = {
    usdmContract: async ({ contract }) => ({ data: { name: contract, order_price_round: '0.1', quanto_multiplier: '0.001', order_size_min: '1', order_size_max: '100000', leverage_max: '3', maintenance_rate: '0.005', maker_fee_rate: '-0.0001', taker_fee_rate: '0.0005', status: 'trading', in_delisting: false } }),
    usdmTickers: async ({ contract }) => ({ data: [{ contract, last: '100', mark_price: '100', index_price: '100' }] }),
    usdmPosition: async ({ contract }) => ({ data: { contract, mode: 'single', pos_margin_mode: 'isolated', lever: '2', size: String(options.existingPosition || '0') } }),
    usdmAccount: async () => ({ data: { currency: 'USDT', available: '1000', in_dual_mode: false } }),
    usdmPositions: async () => ({ data: [{ contract: 'BTC_USDT', mode: 'single', pos_margin_mode: 'isolated', lever: '2', size: String(options.existingPosition || '0') }] }),
    usdmOrders: async () => ({ data: [] }),
    usdmPriceOrders: async () => ({ data: (options.existingProtections || []).map((payload, index) => ({ id: String(100 + index), status: 'open', initial: payload.initial, trigger: payload.trigger })) }),
    usdmTrades: async (query) => ({ data: (query.order || (options.existingTrades && query.contract === 'BTC_USDT')) ? [{ id: 'fill-1', order_id: String(query.order || 'order-1'), contract: 'BTC_USDT', size: String(mainSize), price: '100' }] : [] }),
    usdmPlaceOrder: async (payload) => {
      placeCalls += 1
      if (options.reject) {
        const error = new Error('simulated venue rejection')
        error.code = 'INVALID_ORDER'
        if (!options.localReject) error.status = 400
        error.ambiguous = false
        throw error
      }
      if (options.ambiguous) {
        const error = new Error('simulated transport loss')
        error.code = 'ETIMEDOUT'
        error.ambiguous = true
        throw error
      }
      return { data: { id: 'order-1', status: 'finished', finish_as: 'filled', size: payload.size, left: 0, text: payload.text } }
    },
    findUsdmOrderByText: async () => {
      if (options.recoverAmbiguous) return { id: 'order-1', status: 'finished', finish_as: 'filled', size: mainSize, left: 0, text: plan.intents[0].intent_id }
      const error = new Error('not found')
      error.code = 'GATE_ORDER_NOT_FOUND'
      throw error
    },
    usdmOrder: async () => ({ data: { id: 'order-1', status: 'finished', finish_as: 'filled', size: mainSize, left: 0, text: plan.intents[0].intent_id } }),
    usdmCancelOrder: async () => ({ data: { id: 'order-1', status: 'finished', finish_as: 'cancelled', size: mainSize, left: mainSize } }),
    usdmPlacePriceOrder: async (payload) => {
      protectionPayloads.push(payload)
      protectionId += 1
      return { data: { id: String(protectionId), status: 'open', initial: payload.initial, trigger: payload.trigger } }
    },
    usdmPriceOrder: async ({ order_id }) => ({ data: { id: order_id, status: 'open' } }),
    usdmCancelPriceOrder: async ({ order_id }) => ({ data: { id: order_id, status: 'finished' } })
  }
  return { client, getPlaceCalls: () => placeCalls, protectionPayloads }
}

function executeOptions(plan, config, directory, client) {
  return {
    config,
    client,
    planId: plan.plan_id,
    planHash: plan.plan_hash,
    commit: true,
    confirm: `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`,
    interactive: true,
    env: {},
    dataDir: directory,
    ledgerPath: path.join(directory, 'ledger.json'),
    killPath: path.join(directory, 'gate_KILL'),
    marketSnapshot: marketSnapshot(),
    weeklyAnchor: weeklyAnchor(),
    executionSource: dailySource(),
    now: () => NOW,
    sleep: async () => {}
  }
}

test('happy path reserves, submits once, proves fills, and creates exact reduce-only protections', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-exec-'))
  const mock = baseClient(plan)
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
  assert.equal(result.outcome, 'COMPLETE')
  assert.equal(mock.getPlaceCalls(), 1)
  assert.equal(result.results[0].outcome, 'PROTECTED')
  assert.equal(mock.protectionPayloads.length, 2)
  for (const payload of mock.protectionPayloads) {
    assert.equal(payload.initial.reduce_only, true)
    assert.equal(payload.initial.size, -plan.intents[0].size)
    assert.equal(payload.initial.contract, 'BTC_USDT')
    assert.match(payload.initial.text, /^t-TYP[0-9a-f]{22}$/)
  }
  const ledger = readLedger(path.join(directory, 'ledger.json'))
  assert.equal(ledger.fills.length, 1)
  assert.equal(ledger.fills[0].contracts, String(plan.intents[0].size))
  assert.ok(ledger.events.some((event) => event.intent_id === plan.intents[0].intent_id && event.state === 'SUBMISSION_RESERVED'))
  assert.ok(ledger.events.some((event) => event.intent_id === plan.intents[0].intent_id && event.state === 'PROTECTED'))
})

test('a second execution of the same plan is suppressed before another POST', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-dedupe-'))
  const first = baseClient(plan)
  const options = executeOptions(plan, config, directory, first.client)
  assert.equal((await executePlan(plan, options)).outcome, 'COMPLETE')
  const second = baseClient(plan, { existingPosition: plan.intents[0].size, existingProtections: first.protectionPayloads, existingTrades: true })
  const repeated = await executePlan(plan, { ...options, client: second.client })
  assert.equal(repeated.outcome, 'DUPLICATE_SUPPRESSED')
  assert.equal(second.getPlaceCalls(), 0)
})

test('ambiguous submission recovers exact identity once without blind repost but remains red pending receipt', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-ambiguous-'))
  const mock = baseClient(plan, { ambiguous: true, recoverAmbiguous: true })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
  assert.equal(mock.getPlaceCalls(), 1)
  assert.equal(result.outcome, 'RECONCILE_RED')
  const ledger = readLedger(path.join(directory, 'ledger.json'))
  assert.ok(ledger.events.some((event) => event.state === 'SUBMISSION_AMBIGUOUS'))
  assert.ok(ledger.events.some((event) => event.recovered_by_identity === true))
  assert.equal(unresolvedRedCauses(ledger).length, 1)
})

test('unresolved ambiguity becomes sticky red without a second POST', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-red-'))
  const mock = baseClient(plan, { ambiguous: true, recoverAmbiguous: false })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
  assert.equal(mock.getPlaceCalls(), 1)
  assert.equal(result.outcome, 'RECONCILE_RED')
  const ledger = readLedger(path.join(directory, 'ledger.json'))
  assert.ok(ledger.events.some((event) => event.state === 'RECONCILE_RED'))
})

test('definitive venue rejection is reported as rejected rather than complete', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-reject-'))
  const mock = baseClient(plan, { reject: true })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
  assert.equal(mock.getPlaceCalls(), 1)
  assert.equal(result.outcome, 'REJECTED')
  assert.equal(result.counts.submitted, 1)
  assert.equal(result.counts.rejected, 1)
})

test('local transport rejection does not claim the venue received an order', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-local-block-'))
  const mock = baseClient(plan, { reject: true, localReject: true })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
  assert.equal(result.outcome, 'BLOCKED')
  assert.equal(result.counts.submitted, 0)
  assert.equal(result.counts.rejected, 0)
})

test('reconciliation rejects unknown bot orders and account-position ownership drift', () => {
  const receipt = reconcileSnapshot({
    generated_at: new Date(NOW).toISOString(),
    account: { in_dual_mode: false },
    open_orders: [{ text: `t-TYE${'f'.repeat(22)}` }],
    protections: [],
    trades: [{ id: 'unknown-fill', contract: 'BTC_USDT', size: '1', price: '100', text: `t-TYE${'e'.repeat(22)}` }],
    positions: [{ contract: 'BTC_USDT', mode: 'single', size: '2' }]
  }, emptyLedger(), { now: NOW })
  assert.equal(receipt.status, 'red')
  assert.ok(receipt.issues.some((issue) => issue.code === 'UNKNOWN_BOT_ORDER'))
  assert.ok(receipt.issues.some((issue) => issue.code === 'UNKNOWN_BOT_FILL'))
  assert.ok(receipt.issues.some((issue) => issue.code === 'POSITION_OWNERSHIP_DRIFT'))
})
