import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  reconcileSnapshot,
  reduceLedger,
  staticExecutionGate,
  unresolvedRedCauses,
  verifyReconciliationReceipt
} from '../scripts/gate-trade.mjs'
import { NOW, dailySource, marketSnapshot, readyPlan, weeklyAnchor } from './helpers.mjs'

const at = new Date(NOW).toISOString()

function ambiguousEvents(intentId, suffix, exchangeOrderId = null) {
  return [
    { event_id: `te_reserved_${suffix}`, intent_id: intentId, state: 'SUBMISSION_RESERVED', at },
    { event_id: `te_ambiguous_${suffix}`, intent_id: intentId, state: 'SUBMISSION_AMBIGUOUS', at },
    { event_id: `te_red_${suffix}`, intent_id: intentId, state: 'RECONCILE_RED', at, reason: 'Ambiguous submission was not resolved by exact order identity', ...(exchangeOrderId ? { exchange_order_id: exchangeOrderId } : {}) }
  ]
}

function ledgerWithAmbiguities(rows, plans = []) {
  return {
    schema: 'tyche_gate_ledger/v1',
    plans,
    events: rows.flatMap(({ intentId, suffix, exchangeOrderId }) => ambiguousEvents(intentId, suffix, exchangeOrderId)),
    fills: [],
    reconciliations: []
  }
}

function snapshot(overrides = {}) {
  return {
    generated_at: at,
    account: { in_dual_mode: false },
    open_orders: [],
    protections: [],
    trades: [],
    positions: [],
    identity_resolutions: [],
    ...overrides
  }
}

function cancelEvidence(cause, orderId) {
  return {
    cause_id: cause.cause_id,
    source_event_id: cause.source_event_id,
    intent_id: cause.intent_id,
    client_order_id: cause.client_order_id,
    order_id: orderId,
    exact_client_text: true,
    exact_order_id: true,
    terminal_status: 'CANCELLED',
    terminal: true,
    terminal_reason: 'cancelled',
    executed_contracts: '0',
    cancellation_proof: true,
    venue_rejection: false,
    definitive_not_found: false,
    not_found_identities: [],
    trades_complete: true,
    checked_at: at
  }
}

function executionGateOptions(plan, config, source, ledgerPath, directory) {
  return {
    config,
    planId: plan.plan_id,
    planHash: plan.plan_hash,
    commit: true,
    confirm: `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`,
    interactive: true,
    env: {},
    ledgerPath,
    killPath: path.join(directory, 'gate_KILL'),
    marketSnapshot: marketSnapshot(),
    weeklyAnchor: weeklyAnchor(),
    executionSource: source,
    now: NOW
  }
}

test('known matching ambiguous order that remains open cannot resolve its cause', () => {
  const intentId = `t-TYE${'1'.repeat(22)}`
  const ledger = ledgerWithAmbiguities([{ intentId, suffix: 'open', exchangeOrderId: '101' }])
  const cause = unresolvedRedCauses(ledger)[0]
  const receipt = reconcileSnapshot(snapshot({
    open_orders: [{ id: '101', text: intentId, status: 'open' }],
    identity_resolutions: [cancelEvidence(cause, '101')]
  }), ledger, { now: NOW, requestedCauseIds: [cause.cause_id] })

  assert.equal(receipt.status, 'red')
  assert.equal(receipt.resolutions.length, 0)
  assert.ok(receipt.issues.some((issue) => issue.code === 'AMBIGUOUS_ORDER_STILL_OPEN'))
})

test('ambiguous protection recovered as an open submitted order remains blocking without a receipt', () => {
  const intentId = `t-TYP${'a'.repeat(22)}`
  const ledger = {
    schema: 'tyche_gate_ledger/v1',
    plans: [],
    events: [
      { event_id: 'te_ambiguous_protection_open', intent_id: intentId, role: 'PROTECTION', state: 'SUBMISSION_AMBIGUOUS', at },
      { event_id: 'te_recovered_protection_open', intent_id: intentId, role: 'PROTECTION', state: 'SUBMITTED', at, exchange_order_id: 'protection-open-101', recovered_by_identity: true }
    ],
    fills: [],
    reconciliations: []
  }

  const causes = unresolvedRedCauses(ledger)
  assert.equal(causes.length, 1)
  assert.equal(causes[0].source_event_id, 'te_ambiguous_protection_open')
  assert.equal(causes[0].exchange_order_id, 'protection-open-101')

  const source = dailySource({ candidate: { signal_id: 'fixture:after-protection-ambiguity' } })
  const { plan, config } = readyPlan({ source })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-open-protection-ambiguity-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
  assert.equal(staticExecutionGate(plan, executionGateOptions(plan, config, source, ledgerPath, directory)).code, 'STICKY_RECONCILE_RED')
})

test('ambiguous entry remains blocking after recovered fill and protection events without a receipt', () => {
  const { plan, config, source } = readyPlan()
  const intent = plan.intents[0]
  const ledger = {
    schema: 'tyche_gate_ledger/v1',
    plans: [plan],
    events: [
      { event_id: 'te_ambiguous_entry_recovered', intent_id: intent.intent_id, role: 'ENTRY', state: 'SUBMISSION_AMBIGUOUS', at },
      { event_id: 'te_recovered_entry_fill', intent_id: intent.intent_id, role: 'ENTRY', state: 'FILLED', at, exchange_order_id: 'entry-filled-202', recovered_by_identity: true },
      { event_id: 'te_recovered_entry_protected', intent_id: intent.intent_id, role: 'ENTRY', state: 'PROTECTED', at, exchange_order_id: 'entry-filled-202' }
    ],
    fills: [{ id: 'trade-entry-202', product: 'usdm', environment: 'testnet', plan_id: plan.plan_id, intent_id: intent.intent_id, symbol: intent.symbol, contracts: String(Math.abs(intent.size)), price: intent.price, order_id: 'entry-filled-202', at }],
    reconciliations: []
  }

  const causes = unresolvedRedCauses(ledger)
  assert.equal(causes.length, 1)
  assert.equal(causes[0].source_event_id, 'te_ambiguous_entry_recovered')
  assert.equal(causes[0].exchange_order_id, 'entry-filled-202')

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-filled-entry-ambiguity-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
  assert.equal(staticExecutionGate(plan, executionGateOptions(plan, config, source, ledgerPath, directory)).code, 'STICKY_RECONCILE_RED')
})

test('absence from bounded open-order snapshots is not terminal proof', () => {
  const intentId = `t-TYE${'2'.repeat(22)}`
  const ledger = ledgerWithAmbiguities([{ intentId, suffix: 'absent' }])
  const cause = unresolvedRedCauses(ledger)[0]
  const receipt = reconcileSnapshot(snapshot(), ledger, { now: NOW, requestedCauseIds: [cause.cause_id] })

  assert.equal(receipt.status, 'red')
  assert.equal(receipt.resolutions.length, 0)
  assert.ok(receipt.issues.some((issue) => issue.code === 'AMBIGUOUS_IDENTITY_EVIDENCE_MISSING'))
})

test('definitive exact-identity not-found evidence can resolve when no venue ID is known', () => {
  const intentId = `t-TYE${'8'.repeat(22)}`
  const ledger = ledgerWithAmbiguities([{ intentId, suffix: 'not-found' }])
  const cause = unresolvedRedCauses(ledger)[0]
  const receipt = reconcileSnapshot(snapshot({
    identity_resolutions: [{
      cause_id: cause.cause_id,
      source_event_id: cause.source_event_id,
      intent_id: cause.intent_id,
      client_order_id: cause.client_order_id,
      order_id: null,
      exact_client_text: true,
      exact_order_id: false,
      terminal_status: 'NOT_FOUND',
      terminal: true,
      terminal_reason: 'ORDER_NOT_FOUND',
      executed_contracts: '0',
      cancellation_proof: false,
      venue_rejection: false,
      definitive_not_found: true,
      not_found_identities: [cause.client_order_id],
      trades_complete: true,
      checked_at: at
    }]
  }), ledger, { now: NOW, requestedCauseIds: [cause.cause_id] })

  assert.equal(receipt.status, 'ok')
  assert.equal(unresolvedRedCauses(reduceLedger(ledger, { kind: 'RECONCILIATION', reconciliation: receipt })).length, 0)
})

test('exact terminal cancellation resolves one cause with a sealed complete receipt', () => {
  const intentId = `t-TYE${'3'.repeat(22)}`
  const ledger = ledgerWithAmbiguities([{ intentId, suffix: 'cancel', exchangeOrderId: '303' }])
  const cause = unresolvedRedCauses(ledger)[0]
  const receipt = reconcileSnapshot(snapshot({ identity_resolutions: [cancelEvidence(cause, '303')] }), ledger, { now: NOW, requestedCauseIds: [cause.cause_id] })

  assert.equal(receipt.status, 'ok')
  assert.deepEqual(receipt.resolved_cause_ids, [cause.cause_id])
  assert.equal(verifyReconciliationReceipt(receipt).ok, true)
  assert.equal(unresolvedRedCauses(reduceLedger(ledger, { kind: 'RECONCILIATION', reconciliation: receipt })).length, 0)

  const tampered = structuredClone(receipt)
  tampered.resolutions[0].terminal_status = 'FILLED'
  assert.throws(() => reduceLedger(ledger, { kind: 'RECONCILIATION', reconciliation: tampered }), { code: 'RECONCILIATION_RECEIPT_HASH_MISMATCH' })
})

test('exact terminal fill resolves only when fills, position, and reduce-only protections reconcile', () => {
  const { plan } = readyPlan()
  const intent = plan.intents[0]
  const orderId = '404'
  const protectionOne = `t-TYP${'4'.repeat(22)}`
  const protectionTwo = `t-TYP${'5'.repeat(22)}`
  const ledger = ledgerWithAmbiguities([{ intentId: intent.intent_id, suffix: 'fill', exchangeOrderId: orderId }], [plan])
  ledger.events.push(
    { event_id: 'te_protection_one', intent_id: protectionOne, state: 'SUBMITTED', at, exchange_order_id: 'p-1' },
    { event_id: 'te_protection_two', intent_id: protectionTwo, state: 'SUBMITTED', at, exchange_order_id: 'p-2' }
  )
  ledger.fills.push({ id: 'trade-404', product: 'usdm', environment: 'testnet', plan_id: plan.plan_id, intent_id: intent.intent_id, symbol: intent.symbol, contracts: String(Math.abs(intent.size)), price: intent.price, order_id: orderId, at })
  const cause = unresolvedRedCauses(ledger)[0]
  const fillEvidence = {
    ...cancelEvidence(cause, orderId),
    terminal_status: 'FILLED',
    terminal_reason: 'filled',
    executed_contracts: String(Math.abs(intent.size)),
    cancellation_proof: false,
    trades_complete: true
  }
  const protection = (text, rule) => ({
    id: `p-${rule}`,
    status: 'open',
    initial: { contract: intent.symbol, size: -Math.abs(intent.size), price: '0', tif: 'ioc', text, reduce_only: true },
    trigger: { strategy_type: 0, price_type: 1, price: rule === 1 ? intent.protection.target_price : intent.protection.stop_price, rule, expiration: 86400 }
  })
  const receipt = reconcileSnapshot(snapshot({
    positions: [{ contract: intent.symbol, mode: 'single', size: String(intent.size) }],
    protections: [protection(protectionOne, 1), protection(protectionTwo, 2)],
    trades: [{ id: 'trade-404', order_id: orderId, contract: intent.symbol, size: String(Math.abs(intent.size)), price: intent.price, text: intent.intent_id }],
    identity_resolutions: [fillEvidence]
  }), ledger, { now: NOW, requestedCauseIds: [cause.cause_id] })

  assert.equal(receipt.status, 'ok')
  assert.deepEqual(receipt.resolutions[0].trade_ids, ['trade-404'])
  assert.equal(receipt.resolutions[0].state_reconciled, true)
  assert.equal(unresolvedRedCauses(reduceLedger(ledger, { kind: 'RECONCILIATION', reconciliation: receipt })).length, 0)
})

test('a later protection failure remains independent from an earlier submission ambiguity', () => {
  const intentId = `t-TYE${'9'.repeat(22)}`
  const ledger = {
    schema: 'tyche_gate_ledger/v1',
    plans: [],
    events: [
      { event_id: 'te_ambiguous_independent', intent_id: intentId, role: 'ENTRY', state: 'SUBMISSION_AMBIGUOUS', at },
      { event_id: 'te_recovered_independent', intent_id: intentId, role: 'ENTRY', state: 'FILLED', at, exchange_order_id: '909', recovered_by_identity: true },
      { event_id: 'te_red_independent', intent_id: intentId, role: 'ENTRY', state: 'RECONCILE_RED', at, exchange_order_id: '909', reason: 'Protection failed' }
    ],
    fills: [],
    reconciliations: []
  }

  const causes = unresolvedRedCauses(ledger)
  assert.equal(causes.length, 2)
  assert.deepEqual(new Set(causes.map((cause) => cause.source_event_id)), new Set(['te_ambiguous_independent', 'te_red_independent']))
})

test('multiple red causes resolve independently and later plans stay blocked until all are resolved', () => {
  const firstIntent = `t-TYE${'6'.repeat(22)}`
  const secondIntent = `t-TYE${'7'.repeat(22)}`
  const original = ledgerWithAmbiguities([
    { intentId: firstIntent, suffix: 'first', exchangeOrderId: '601' },
    { intentId: secondIntent, suffix: 'second', exchangeOrderId: '701' }
  ])
  const [firstCause, secondCause] = unresolvedRedCauses(original)
  const firstReceipt = reconcileSnapshot(snapshot({ identity_resolutions: [cancelEvidence(firstCause, firstCause.exchange_order_id)] }), original, { now: NOW, requestedCauseIds: [firstCause.cause_id] })
  assert.equal(firstReceipt.status, 'red')
  assert.deepEqual(firstReceipt.resolved_cause_ids, [firstCause.cause_id])
  let ledger = reduceLedger(original, { kind: 'RECONCILIATION', reconciliation: firstReceipt })
  assert.deepEqual(unresolvedRedCauses(ledger).map((cause) => cause.cause_id), [secondCause.cause_id])

  const source = dailySource({ candidate: { signal_id: 'fixture:later-plan' } })
  const { plan, config } = readyPlan({ source })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-all-causes-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
  const gateOptions = executionGateOptions(plan, config, source, ledgerPath, directory)
  assert.equal(staticExecutionGate(plan, gateOptions).code, 'STICKY_RECONCILE_RED')

  const secondReceipt = reconcileSnapshot(snapshot({ identity_resolutions: [cancelEvidence(secondCause, secondCause.exchange_order_id)] }), ledger, { now: NOW, requestedCauseIds: [secondCause.cause_id] })
  assert.equal(secondReceipt.status, 'ok')
  ledger = reduceLedger(ledger, { kind: 'RECONCILIATION', reconciliation: secondReceipt })
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
  assert.equal(unresolvedRedCauses(ledger).length, 0)
  assert.equal(staticExecutionGate(plan, gateOptions).ok, true)
})
