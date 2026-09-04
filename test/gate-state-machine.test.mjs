import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  executePlan,
  readLedger,
  reconcileSnapshot,
  reduceLedger,
  unresolvedRedCauses
} from '../scripts/gate-trade.mjs'
import { managedQuantities, reservationEntries } from '../scripts/gate-account-context.mjs'
import { updateJsonLocked } from '../scripts/lib-iolock.mjs'
import {
  DATE,
  NOW,
  dailySource,
  manualConfig,
  marketSnapshot,
  planContext,
  readyPlan,
  weeklyAnchor
} from './helpers.mjs'

function emptyLedger() {
  return { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }
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
    ledgerPath: path.join(directory, 'ledger.json'),
    killPath: path.join(directory, 'gate_KILL'),
    marketSnapshot: marketSnapshot(),
    weeklyAnchor: weeklyAnchor(),
    executionSource: dailySource({ candidate: { signal_id: plan.intents[0].signal_id } }),
    now: () => NOW,
    sleep: async () => {}
  }
}

function definitiveNotFound(identity) {
  const error = new Error('exact order not found')
  error.code = 'GATE_HTTP_404'
  error.status = 404
  error.operation = 'usdmOrder'
  error.lookupIdentity = identity
  error.definitiveNotFound = true
  error.ambiguous = false
  return error
}

function strandedLedger(plan, options = {}) {
  let ledger = reduceLedger(emptyLedger(), { kind: 'PLAN', plan })
  ledger = reduceLedger(ledger, {
    kind: 'EVENT',
    event: {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      intent_id: plan.intents[0].intent_id,
      product: 'usdm',
      environment: 'testnet',
      symbol: plan.intents[0].symbol,
      role: plan.intents[0].role,
      state: 'SUBMISSION_RESERVED',
      at: new Date(NOW).toISOString(),
      reservation_owner_id: options.ownerId || 'stranded-owner',
      reservation_owner_pid: options.ownerPid || 999999
    }
  })
  return ledger
}

function twoPartyBarrier() {
  let arrivals = 0
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  return async () => {
    arrivals += 1
    if (arrivals === 2) release()
    await waiting
  }
}

function appendUnrelatedRed(ledgerPath) {
  const intentId = `t-TYE${'f'.repeat(22)}`
  updateJsonLocked(ledgerPath, (current) => {
    let next = reduceLedger(current, {
      kind: 'EVENT',
      event: { intent_id: intentId, state: 'SUBMISSION_RESERVED', at: new Date(NOW).toISOString(), role: 'ENTRY' }
    })
    next = reduceLedger(next, {
      kind: 'EVENT',
      event: { intent_id: intentId, state: 'RECONCILE_RED', at: new Date(NOW).toISOString(), role: 'ENTRY', sticky: true, reason: 'Unrelated injected red cause' }
    })
    return next
  })
}

function makeClient(plan, options = {}) {
  const main = plan.intents[0]
  const orders = new Map()
  const protectionPayloads = []
  let mainPlaceCalls = 0
  let emergencyPlaceCalls = 0
  let protectionCalls = 0
  let reservationLookupCalls = 0
  let lookupHookCalled = false

  const mainFill = (orderId = 'entry-1', text = main.intent_id) => ({
    id: `trade-${orderId}`,
    order_id: orderId,
    contract: main.symbol,
    size: String(Math.abs(main.size)),
    price: main.price,
    text
  })

  const client = {
    usdmContract: async ({ contract }) => ({ data: { name: contract, order_price_round: '0.1', quanto_multiplier: '0.001', order_size_min: '1', order_size_max: '100000', leverage_max: '3', in_delisting: false } }),
    usdmTickers: async ({ contract }) => ({ data: [{ contract, last: '100', mark_price: '100', index_price: '100' }] }),
    usdmPosition: async ({ contract }) => ({
      data: {
        contract,
        mode: options.positionMode ?? 'single',
        ...(options.positionMargin === null ? {} : { pos_margin_mode: options.positionMargin ?? 'isolated' }),
        ...(options.positionLever === null ? {} : { lever: options.positionLever ?? '2' }),
        size: String(options.snapshotPosition || '0')
      }
    }),
    usdmAccount: async () => ({ data: { currency: 'USDT', available: String(options.availableQuote ?? '1000'), in_dual_mode: options.inDualMode ?? false } }),
    usdmPositions: async () => {
      if (options.snapshotBarrier) await options.snapshotBarrier()
      return {
        data: [{
          contract: main.symbol,
          mode: 'single',
          pos_margin_mode: 'isolated',
          lever: String(options.positionLever ?? '2'),
          size: String(options.snapshotPosition || '0')
        }]
      }
    },
    usdmOrders: async () => ({ data: [] }),
    usdmPriceOrders: async () => {
      if (options.onProtectionLookup && !lookupHookCalled) {
        lookupHookCalled = true
        options.onProtectionLookup()
      }
      return { data: options.snapshotProtections || [] }
    },
    usdmTrades: async (query) => {
      if (!query.order) return { data: (options.snapshotTrades || []).filter((trade) => trade.contract === query.contract) }
      const order = orders.get(String(query.order)) || (String(query.order) === 'entry-found' ? options.reservedOrder : null)
      if (!order) return { data: [] }
      if (String(query.order).startsWith('emergency-')) {
        if (options.emergencyFill === false) return { data: [] }
        return { data: [{ id: `trade-${query.order}`, order_id: String(query.order), contract: main.symbol, size: String(Math.abs(order.size)), price: '99', text: order.text }] }
      }
      if (options.mainFill === false) return { data: [] }
      return { data: [mainFill(String(query.order), order.text)] }
    },
    usdmPlaceOrder: async (payload) => {
      const emergency = payload.reduce_only === true && payload.price === '0' && payload.tif === 'ioc'
      if (emergency) {
        emergencyPlaceCalls += 1
        const order = { id: `emergency-${emergencyPlaceCalls}`, status: 'finished', finish_as: 'filled', size: payload.size, left: 0, text: payload.text }
        orders.set(order.id, order)
        return { data: order }
      }
      mainPlaceCalls += 1
      if (options.placeDelayMs) await new Promise((resolve) => setTimeout(resolve, options.placeDelayMs))
      const entryOrderId = options.entryOrderId || 'entry-1'
      const order = options.terminalRejected
        ? { id: entryOrderId, status: 'finished', finish_as: 'rejected', size: payload.size, left: payload.size, text: payload.text }
        : options.terminalCancelled
          ? { id: entryOrderId, status: 'finished', finish_as: 'cancelled', size: payload.size, left: payload.size, text: payload.text }
          : { id: entryOrderId, status: 'finished', finish_as: 'filled', size: payload.size, left: 0, text: payload.text }
      orders.set(order.id, order)
      return { data: order }
    },
    findUsdmOrderByText: async (identity) => {
      reservationLookupCalls += 1
      if (options.reservationLookup === 'not-found') throw definitiveNotFound(identity)
      if (options.reservationLookup === 'unknown') {
        const error = new Error('identity lookup timed out')
        error.code = 'ETIMEDOUT'
        error.ambiguous = true
        throw error
      }
      if (options.reservedOrder) {
        orders.set(String(options.reservedOrder.id), options.reservedOrder)
        return options.reservedOrder
      }
      throw definitiveNotFound(identity)
    },
    usdmOrder: async ({ order_id }) => {
      const order = orders.get(String(order_id))
      if (options.finishReservedOnPoll && order?.status === 'open') {
        const finished = { ...order, status: 'finished', finish_as: 'filled', left: 0 }
        orders.set(String(order_id), finished)
        return { data: finished }
      }
      return { data: order }
    },
    usdmCancelOrder: async ({ order_id }) => ({ data: { ...(orders.get(String(order_id)) || {}), id: String(order_id), status: 'finished', finish_as: 'cancelled' } }),
    usdmPlacePriceOrder: async (payload) => {
      protectionCalls += 1
      if (options.protectionAmbiguous) {
        const error = new Error('protection transport loss')
        error.code = 'ETIMEDOUT'
        error.ambiguous = true
        throw error
      }
      protectionPayloads.push(payload)
      const status = options.inactiveProtectionAt === protectionCalls ? 'inactive' : options.protectionStatus || 'open'
      return { data: { id: `protection-${protectionCalls}`, status, initial: payload.initial, trigger: payload.trigger } }
    },
    usdmPriceOrder: async ({ order_id }) => ({ data: { id: order_id, status: 'open' } }),
    usdmCancelPriceOrder: async ({ order_id }) => ({ data: { id: order_id, status: 'finished' } })
  }

  return {
    client,
    protectionPayloads,
    getMainPlaceCalls: () => mainPlaceCalls,
    getEmergencyPlaceCalls: () => emergencyPlaceCalls,
    getProtectionCalls: () => protectionCalls,
    getReservationLookupCalls: () => reservationLookupCalls
  }
}

function distinctReadyPlan(config, signalId, context = planContext()) {
  return readyPlan({ config, source: dailySource({ candidate: { signal_id: signalId } }), context }).plan
}

for (const scenario of [
  { name: 'daily new-notional', cap: 'daily', expectedCode: 'DAILY_NOTIONAL_LIMIT_DRIFT' },
  { name: 'managed notional', cap: 'managed', expectedCode: 'MANAGED_NOTIONAL_LIMIT_DRIFT' },
  { name: 'account available margin', cap: 'available', expectedCode: 'ACCOUNT_AVAILABLE_LIMIT_DRIFT' }
]) {
  test(`atomic reservation serializes concurrent ${scenario.name} capacity`, async () => {
    const config = manualConfig()
    config.gate.usdm.max_order_notional_usdt = 25
    config.gate.usdm.daily_new_notional_cap_usdt = scenario.cap === 'daily' ? 25 : 100
    config.gate.usdm.max_managed_notional_usdt = scenario.cap === 'managed' ? 25 : 100
    if (scenario.cap === 'available') config.gate.usdm.risk_per_trade_bps = 10000
    const context = planContext()
    if (scenario.cap === 'available') {
      context.accounts['usdm:BTC_USDT'].available_quote = '20'
      context.accounts['usdm:BTC_USDT'].effective_risk_capital = '20'
    }
    const firstPlan = distinctReadyPlan(config, `fixture:atomic:${scenario.cap}:one`, context)
    const secondPlan = distinctReadyPlan(config, `fixture:atomic:${scenario.cap}:two`, context)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `tyche-atomic-${scenario.cap}-`))
    const barrier = twoPartyBarrier()
    const first = makeClient(firstPlan, { availableQuote: scenario.cap === 'available' ? '20' : '1000', snapshotBarrier: barrier, placeDelayMs: 20 })
    const second = makeClient(secondPlan, { availableQuote: scenario.cap === 'available' ? '20' : '1000', snapshotBarrier: barrier, placeDelayMs: 20 })

    const [left, right] = await Promise.all([
      executePlan(firstPlan, executeOptions(firstPlan, config, directory, first.client)),
      executePlan(secondPlan, executeOptions(secondPlan, config, directory, second.client))
    ])
    const outcomes = [left, right]
    assert.equal(outcomes.filter((result) => result.outcome === 'COMPLETE').length, 1)
    assert.equal(outcomes.filter((result) => result.outcome === 'BLOCKED').length, 1)
    assert.ok(outcomes.some((result) => result.results.some((row) => row.code === scenario.expectedCode)))
    assert.equal(first.getMainPlaceCalls() + second.getMainPlaceCalls(), 1)
  })
}

test('terminal rejection and zero-fill cancellation release reserved daily capacity', async () => {
  for (const terminal of ['rejected', 'cancelled']) {
    const config = manualConfig()
    config.gate.usdm.max_order_notional_usdt = 25
    config.gate.usdm.daily_new_notional_cap_usdt = 25
    const firstPlan = distinctReadyPlan(config, `fixture:release:${terminal}:one`)
    const secondPlan = distinctReadyPlan(config, `fixture:release:${terminal}:two`)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `tyche-release-${terminal}-`))
    const first = makeClient(firstPlan, terminal === 'rejected' ? { terminalRejected: true } : { terminalCancelled: true })
    const firstResult = await executePlan(firstPlan, executeOptions(firstPlan, config, directory, first.client))
    assert.equal(firstResult.results[0].outcome, terminal === 'rejected' ? 'REJECTED' : 'CANCELLED')
    const second = makeClient(secondPlan)
    const secondResult = await executePlan(secondPlan, executeOptions(secondPlan, config, directory, second.client))
    assert.equal(secondResult.outcome, 'COMPLETE')
    assert.equal(second.getMainPlaceCalls(), 1)
  }
})

test('filled managed exposure replaces its reservation instead of being double counted', async () => {
  const config = manualConfig()
  config.gate.usdm.max_order_notional_usdt = 25
  config.gate.usdm.daily_new_notional_cap_usdt = 50
  config.gate.usdm.max_managed_notional_usdt = 50
  const firstPlan = distinctReadyPlan(config, 'fixture:managed-fill:one')
  const secondPlan = distinctReadyPlan(config, 'fixture:managed-fill:two')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-managed-fill-'))
  const first = makeClient(firstPlan)
  const firstResult = await executePlan(firstPlan, executeOptions(firstPlan, config, directory, first.client))
  assert.equal(firstResult.outcome, 'COMPLETE')

  const existingProtections = first.protectionPayloads.map((payload, index) => ({ id: `existing-${index}`, status: 'open', initial: payload.initial, trigger: payload.trigger }))
  const existingTrade = { id: 'trade-entry-1', order_id: 'entry-1', contract: firstPlan.intents[0].symbol, size: String(Math.abs(firstPlan.intents[0].size)), price: firstPlan.intents[0].price, text: firstPlan.intents[0].intent_id }
  const second = makeClient(secondPlan, { entryOrderId: 'entry-2', snapshotPosition: firstPlan.intents[0].size, snapshotProtections: existingProtections, snapshotTrades: [existingTrade] })
  const secondResult = await executePlan(secondPlan, executeOptions(secondPlan, config, directory, second.client))
  const managed = managedQuantities(readLedger(path.join(directory, 'ledger.json')), 'usdm')

  assert.equal(secondResult.outcome, 'COMPLETE')
  assert.equal(second.getMainPlaceCalls(), 1)
  assert.equal(managed.BTC_USDT, String(firstPlan.intents[0].size + secondPlan.intents[0].size))
})

test('stranded reservation recovers an exact terminal order without reposting', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-reserved-found-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(strandedLedger(plan)))
  const reservedOrder = { id: 'entry-found', status: 'finished', finish_as: 'filled', size: plan.intents[0].size, left: 0, text: plan.intents[0].intent_id }
  const snapshotTrade = { id: 'trade-entry-found', order_id: 'entry-found', contract: plan.intents[0].symbol, size: String(Math.abs(plan.intents[0].size)), price: plan.intents[0].price, text: plan.intents[0].intent_id }
  const mock = makeClient(plan, { reservedOrder, snapshotPosition: plan.intents[0].size, snapshotTrades: [snapshotTrade] })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))

  assert.equal(result.outcome, 'COMPLETE')
  assert.equal(mock.getMainPlaceCalls(), 0)
  assert.ok(result.lifecycle.some((event) => event.status === 'SUBMITTED'))
  assert.ok(result.lifecycle.some((event) => event.status === 'FILLED'))
  assert.ok(result.lifecycle.some((event) => event.status === 'PROTECTED'))
})

test('stranded reservation recovers an exact open order and resumes its canonical lifecycle', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-reserved-open-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(strandedLedger(plan)))
  const reservedOrder = { id: 'entry-found', status: 'open', size: plan.intents[0].size, left: plan.intents[0].size, text: plan.intents[0].intent_id }
  const mock = makeClient(plan, { reservedOrder, finishReservedOnPoll: true })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))

  assert.equal(result.outcome, 'COMPLETE')
  assert.equal(mock.getMainPlaceCalls(), 0)
  assert.ok(result.lifecycle.some((event) => event.status === 'SUBMITTED'))
  assert.ok(result.lifecycle.some((event) => event.status === 'FILLED'))
  assert.ok(result.lifecycle.some((event) => event.status === 'PROTECTED'))
})

test('definitive exact not-found releases and atomically re-reserves before one POST', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-reserved-not-found-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(strandedLedger(plan)))
  const mock = makeClient(plan, { reservationLookup: 'not-found' })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
  const ledger = readLedger(ledgerPath)

  assert.equal(result.outcome, 'COMPLETE')
  assert.equal(mock.getMainPlaceCalls(), 1)
  assert.equal(ledger.events.filter((event) => event.intent_id === plan.intents[0].intent_id && event.state === 'SUBMISSION_RESERVED').length, 2)
  assert.ok(ledger.events.some((event) => event.state === 'RESERVATION_RELEASED' && event.definitive_not_found === true))
})

test('unknown stranded-reservation identity becomes sticky red without POST', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-reserved-unknown-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(strandedLedger(plan)))
  const mock = makeClient(plan, { reservationLookup: 'unknown' })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))

  assert.equal(result.outcome, 'RECONCILE_RED')
  assert.equal(mock.getMainPlaceCalls(), 0)
  assert.ok(readLedger(ledgerPath).events.some((event) => event.state === 'RECONCILE_RED'))
})

test('expired stranded reservation exact-not-found releases capacity without resubmission', async () => {
  const { plan, config } = readyPlan()
  const expiredNow = Date.parse(plan.expires_at) + 1
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-expired-not-found-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(strandedLedger(plan)))
  const mock = makeClient(plan, { reservationLookup: 'not-found' })
  const result = await executePlan(plan, { ...executeOptions(plan, config, directory, mock.client), now: () => expiredNow })
  const ledger = readLedger(ledgerPath)

  assert.equal(result.outcome, 'BLOCKED')
  assert.equal(result.code, 'PLAN_EXPIRED')
  assert.equal(mock.getReservationLookupCalls(), 1)
  assert.equal(mock.getMainPlaceCalls(), 0)
  assert.equal(ledger.events.at(-1).state, 'RESERVATION_RELEASED')
  assert.equal(reservationEntries(ledger, 'usdm')[0].pending_notional, '0')
})

test('expired post-submit terminal fill is recovered and protected without reposting', async () => {
  const { plan, config } = readyPlan()
  const expiredNow = Date.parse(plan.expires_at) + 1
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-expired-filled-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(strandedLedger(plan)))
  const reservedOrder = { id: 'entry-found', status: 'finished', finish_as: 'filled', size: plan.intents[0].size, left: 0, text: plan.intents[0].intent_id }
  const snapshotTrade = { id: 'trade-entry-found', order_id: 'entry-found', contract: plan.intents[0].symbol, size: String(Math.abs(plan.intents[0].size)), price: plan.intents[0].price, text: plan.intents[0].intent_id }
  const mock = makeClient(plan, { reservedOrder, snapshotPosition: plan.intents[0].size, snapshotTrades: [snapshotTrade] })
  const result = await executePlan(plan, { ...executeOptions(plan, config, directory, mock.client), now: () => expiredNow })

  assert.equal(result.outcome, 'COMPLETE')
  assert.equal(mock.getReservationLookupCalls(), 1)
  assert.equal(mock.getMainPlaceCalls(), 0)
  assert.ok(result.lifecycle.some((event) => event.status === 'FILLED'))
  assert.ok(result.lifecycle.some((event) => event.status === 'PROTECTED'))
})

test('expired post-submit open order resumes canonical lifecycle without reposting', async () => {
  const { plan, config } = readyPlan()
  const expiredNow = Date.parse(plan.expires_at) + 1
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-expired-open-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(strandedLedger(plan)))
  const reservedOrder = { id: 'entry-found', status: 'open', size: plan.intents[0].size, left: plan.intents[0].size, text: plan.intents[0].intent_id }
  const mock = makeClient(plan, { reservedOrder, finishReservedOnPoll: true })
  const result = await executePlan(plan, { ...executeOptions(plan, config, directory, mock.client), now: () => expiredNow })

  assert.equal(result.outcome, 'COMPLETE')
  assert.equal(mock.getReservationLookupCalls(), 1)
  assert.equal(mock.getMainPlaceCalls(), 0)
  assert.ok(result.lifecycle.some((event) => event.status === 'FILLED'))
  assert.ok(result.lifecycle.some((event) => event.status === 'PROTECTED'))
})

test('expired stranded reservation with unknown identity remains sticky red without POST', async () => {
  const { plan, config } = readyPlan()
  const expiredNow = Date.parse(plan.expires_at) + 1
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-expired-unknown-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(strandedLedger(plan)))
  const mock = makeClient(plan, { reservationLookup: 'unknown' })
  const result = await executePlan(plan, { ...executeOptions(plan, config, directory, mock.client), now: () => expiredNow })

  assert.equal(result.outcome, 'RECONCILE_RED')
  assert.equal(mock.getReservationLookupCalls(), 1)
  assert.equal(mock.getMainPlaceCalls(), 0)
  assert.equal(unresolvedRedCauses(readLedger(ledgerPath)).length, 1)
})

test('expired plan without a stranded reservation performs no recovery lookup or POST', async () => {
  const { plan, config } = readyPlan()
  const expiredNow = Date.parse(plan.expires_at) + 1
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-expired-empty-'))
  const mock = makeClient(plan)
  const result = await executePlan(plan, { ...executeOptions(plan, config, directory, mock.client), now: () => expiredNow })

  assert.equal(result.outcome, 'BLOCKED')
  assert.equal(result.code, 'PLAN_EXPIRED')
  assert.equal(mock.getReservationLookupCalls(), 0)
  assert.equal(mock.getMainPlaceCalls(), 0)
})

test('dynamic readiness rejects cross and missing margin proof before POST', async () => {
  for (const positionMargin of ['cross', null]) {
    const { plan, config } = readyPlan()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-margin-proof-'))
    const mock = makeClient(plan, { positionMargin })
    const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
    assert.equal(result.outcome, 'BLOCKED')
    assert.equal(result.code, 'ISOLATED_MARGIN_MODE_UNPROVEN')
    assert.equal(mock.getMainPlaceCalls(), 0)
  }
})

test('HTTP-success terminal venue rejection remains REJECTED end to end', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-terminal-rejected-'))
  const mock = makeClient(plan, { terminalRejected: true })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))

  assert.equal(result.outcome, 'REJECTED')
  assert.equal(result.results[0].outcome, 'REJECTED')
  assert.equal(result.counts.rejected, 1)
  assert.equal(result.counts.cancelled, 0)
  assert.ok(result.lifecycle.some((event) => event.status === 'REJECTED'))
  assert.ok(!result.lifecycle.some((event) => event.status === 'CANCELLED'))
})

test('inactive stop or target is rejected during submission and never reported protected', async () => {
  for (const inactiveProtectionAt of [1, 2]) {
    const { plan, config } = readyPlan()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `tyche-inactive-protection-${inactiveProtectionAt}-`))
    const mock = makeClient(plan, { inactiveProtectionAt })
    const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))

    assert.equal(result.outcome, 'RECONCILE_RED')
    assert.equal(result.results[0].protection.code, 'PROTECTION_FAILED')
    assert.equal(mock.getProtectionCalls(), inactiveProtectionAt)
    assert.ok(!result.lifecycle.some((event) => event.intent_id === plan.intents[0].intent_id && event.status === 'PROTECTED'))
  }
})

test('reconciliation counts only explicitly open protections', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-inactive-reconcile-'))
  const mock = makeClient(plan)
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
  assert.equal(result.outcome, 'COMPLETE')
  const ledger = readLedger(path.join(directory, 'ledger.json'))
  const inactive = mock.protectionPayloads.map((payload, index) => ({ id: `inactive-${index}`, status: 'inactive', initial: payload.initial, trigger: payload.trigger }))
  const receipt = reconcileSnapshot({
    generated_at: new Date(NOW).toISOString(),
    account: { in_dual_mode: false },
    open_orders: [],
    protections: inactive,
    trades: [{ id: 'trade-entry-1', order_id: 'entry-1', contract: plan.intents[0].symbol, size: String(Math.abs(plan.intents[0].size)), price: plan.intents[0].price, text: plan.intents[0].intent_id }],
    positions: [{ contract: plan.intents[0].symbol, mode: 'single', size: String(plan.intents[0].size) }]
  }, ledger, { now: NOW })
  assert.equal(receipt.status, 'red')
  assert.ok(receipt.issues.some((issue) => issue.code === 'MANAGED_POSITION_UNPROTECTED'))
})

test('exact failed protection-child cause permits fill-proven emergency reduction and reduces managed quantity', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-emergency-success-'))
  const mock = makeClient(plan, { protectionAmbiguous: true })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
  const ledger = readLedger(path.join(directory, 'ledger.json'))
  const emergencyFill = ledger.fills.find((fill) => fill.ledger_role === 'EMERGENCY_REDUCTION')

  assert.equal(result.outcome, 'RECONCILE_RED')
  assert.equal(mock.getEmergencyPlaceCalls(), 1)
  assert.ok(emergencyFill)
  assert.ok(Number(emergencyFill.signed_contracts) < 0)
  assert.ok(ledger.events.some((event) => event.intent_id === emergencyFill.intent_id && event.state === 'FILLED'))
  assert.equal(managedQuantities(ledger, 'usdm').BTC_USDT, '0')
})

test('unrelated sticky red still blocks the exact-cause emergency exception', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-emergency-unrelated-red-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  const mock = makeClient(plan, { protectionAmbiguous: true, onProtectionLookup: () => appendUnrelatedRed(ledgerPath) })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))

  assert.equal(result.outcome, 'RECONCILE_RED')
  assert.equal(mock.getEmergencyPlaceCalls(), 0)
  assert.ok(result.unresolved_red_causes.some((cause) => cause.intent_id === `t-TYE${'f'.repeat(22)}`))
})

test('emergency terminal fill without exact trade proof stays sticky red and does not reduce managed quantity', async () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-emergency-no-fill-'))
  const mock = makeClient(plan, { protectionAmbiguous: true, emergencyFill: false })
  const result = await executePlan(plan, executeOptions(plan, config, directory, mock.client))
  const ledger = readLedger(path.join(directory, 'ledger.json'))

  assert.equal(result.outcome, 'RECONCILE_RED')
  assert.equal(mock.getEmergencyPlaceCalls(), 1)
  assert.equal(ledger.fills.some((fill) => fill.ledger_role === 'EMERGENCY_REDUCTION'), false)
  assert.equal(managedQuantities(ledger, 'usdm').BTC_USDT, String(plan.intents[0].size))
  assert.ok(ledger.events.some((event) => event.role === 'EMERGENCY_REDUCTION' && event.state === 'RECONCILE_RED'))
})
