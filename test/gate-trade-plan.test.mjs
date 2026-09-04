import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../scripts/config.mjs'
import {
  createPlan,
  sealPlan,
  sha256Hex,
  staticExecutionGate,
  validateCandidate,
  validateExecutionSource,
  verifyPlan
} from '../scripts/gate-trade.mjs'
import { DATE, WEEK, NOW, dailySource, manualConfig, marketSnapshot, planContext, readyPlan, weeklyAnchor } from './helpers.mjs'

test('weekly output can never enter the planner', () => {
  const weekly = { schema: 'tyche_weekly_strategy/v1', date: DATE, iso_week: WEEK, generated_at: new Date(NOW).toISOString(), status: 'active', assets: {}, execution_candidates: [] }
  assert.equal(validateExecutionSource(weekly, { product: 'usdm', date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW }).code, 'WEEKLY_EXECUTION_FORBIDDEN')
  weekly.execution_candidates.push(dailySource().execution_candidates[0])
  assert.equal(validateExecutionSource(weekly, { product: 'usdm', date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW }).code, 'WEEKLY_EXECUTION_FORBIDDEN')
})

test('daily anchor freshness is proven from the weekly file rather than trusted from agent flags', () => {
  const source = dailySource()
  const missing = validateExecutionSource(source, { product: 'usdm', date: DATE, isoWeek: WEEK, now: NOW })
  assert.equal(missing.candidates.length, 0)
  assert.equal(missing.anchor_proof.code, 'WEEKLY_ANCHOR_MISSING')
  const valid = validateExecutionSource(source, { product: 'usdm', date: DATE, isoWeek: WEEK, now: NOW, weeklyAnchor: weeklyAnchor(), weeklyAnchorMaxAgeDays: 8 })
  assert.equal(valid.candidates.length, 1)
  assert.equal(valid.anchor_proof.ok, true)
  const wrongWeek = validateExecutionSource(source, { product: 'usdm', date: DATE, isoWeek: WEEK, now: NOW, weeklyAnchor: weeklyAnchor({ iso_week: '2029-W52' }), weeklyAnchorMaxAgeDays: 8 })
  assert.equal(wrongWeek.candidates.length, 0)
  assert.equal(wrongWeek.anchor_proof.code, 'WEEKLY_ANCHOR_INVALID')
})

test('stale anchor blocks entries but retains managed reduction semantics', () => {
  const entry = dailySource({ anchor_fresh: false, anchored_week: '2029-W52', candidate: { anchor_fresh: false, anchor_week: '2029-W52' } })
  const checkedEntry = validateExecutionSource(entry, { product: 'usdm', date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW })
  assert.equal(checkedEntry.ok, true)
  assert.equal(checkedEntry.candidates.length, 0)
  assert.equal(checkedEntry.rejected[0].code, 'ANCHOR_STALE_ENTRY_BLOCKED')

  const reduction = dailySource({ anchor_fresh: false, anchored_week: '2029-W52', candidate: { position_intent: 'REDUCE_LONG', stop_price: null, take_profit_price: null, reduce_fraction_bps: 5000, anchor_fresh: false, anchor_week: '2029-W52' } })
  const checkedReduction = validateExecutionSource(reduction, { product: 'usdm', date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW })
  assert.equal(checkedReduction.ok, true)
  assert.equal(checkedReduction.candidates.length, 1)
})

test('candidate contract rejects agent-owned execution fields and Spot shorting', () => {
  const base = dailySource().execution_candidates[0]
  assert.equal(validateCandidate({ ...base, quantity: '1' }, { product: 'usdm', isoWeek: WEEK, now: NOW }).code, 'AGENT_FIELD_FORBIDDEN')
  assert.equal(validateCandidate({ ...base, leverage: 2 }, { product: 'usdm', isoWeek: WEEK, now: NOW }).code, 'AGENT_FIELD_FORBIDDEN')
  assert.equal(validateCandidate({ ...base, reduce_only: false }, { product: 'usdm', isoWeek: WEEK, now: NOW }).code, 'AGENT_FIELD_FORBIDDEN')
  const spotShort = { ...base, product: 'spot', position_intent: 'ENTER_SHORT' }
  assert.equal(validateCandidate(spotShort, { product: 'spot', isoWeek: WEEK, now: NOW }).code, 'SPOT_SHORT_FORBIDDEN')
})

test('candidate geometry enforces minimum R:R 1.5', () => {
  const candidate = dailySource({ candidate: { take_profit_price: 110 } }).execution_candidates[0]
  assert.equal(validateCandidate(candidate, { product: 'usdm', isoWeek: WEEK, now: NOW, minimumRR: 1.5 }).code, 'RR_BELOW_MINIMUM')
})

test('candidate prices must match one complete canonical market level set', () => {
  const candidate = dailySource({ candidate: { take_profit_price: 130 } }).execution_candidates[0]
  const result = validateCandidate(candidate, { product: 'usdm', isoWeek: WEEK, date: DATE, now: NOW, minimumRR: 1.5, marketSnapshot: marketSnapshot() })
  assert.equal(result.code, 'CANDIDATE_LEVEL_SET_UNPROVEN')
})

test('daily entry direction must match the weekly product bias', () => {
  const candidate = dailySource().execution_candidates[0]
  const anchor = weeklyAnchor()
  anchor.assets.BTC.usdm_bias = 'short'
  const result = validateCandidate(candidate, { product: 'usdm', isoWeek: WEEK, date: DATE, now: NOW, minimumRR: 1.5, marketSnapshot: marketSnapshot(), weeklyAnchor: anchor })
  assert.equal(result.code, 'WEEKLY_DIRECTION_MISMATCH')
})

test('planner owns sizing, contract count, leverage use, identities, and reduce-only', () => {
  const { plan } = readyPlan()
  assert.equal(plan.status, 'READY')
  assert.equal(plan.intents.length, 1)
  const intent = plan.intents[0]
  assert.equal(intent.quantity, '250')
  assert.equal(intent.base_quantity, '0.25')
  assert.equal(intent.estimated_notional, '25')
  assert.equal(intent.size, 250)
  assert.equal(intent.reduce_only, false)
  assert.match(intent.intent_id, /^t-TYE[0-9a-f]{22}$/)
  assert.equal(intent.protection.quantity_source, 'IDENTIFIABLE_EXCHANGE_FILLS')
  assert.equal(intent.margin_debit, '12.525')
  assert.equal(intent.estimated_open_fee, '0.0125')
  assert.equal(intent.estimated_close_fee, '0.0125')
})

test('USDT-M sizing enforces a venue minimum notional when the adapter supplies one', () => {
  const config = manualConfig()
  const context = planContext()
  context.rules.BTC_USDT.min_notional = '30'
  const plan = createPlan(dailySource(), { product: 'usdm', environment: 'testnet', config, context, ledger: { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW })
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.intents.length, 0)
  assert.ok(plan.skipped.some((row) => row.code === 'MINIMUM_NOTIONAL'))
})

test('multiple same-symbol entries are deterministically reduced to one', () => {
  const config = manualConfig()
  config.gate.usdm.max_order_notional_usdt = 20
  config.gate.usdm.daily_new_notional_cap_usdt = 30
  const source = dailySource()
  source.execution_candidates.push({ ...source.execution_candidates[0], signal_id: 'fixture:btc:second' })
  const plan = createPlan(source, { product: 'usdm', environment: 'testnet', config, context: planContext(), ledger: { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW })
  assert.equal(plan.status, 'READY')
  assert.equal(plan.intents.length, 1)
  assert.deepEqual(plan.intents.map((intent) => intent.estimated_notional), ['20'])
  assert.ok(plan.skipped.some((row) => row.code === 'ENTRY_SUPERSEDED'))
})

test('opposite same-symbol entries and duplicate signals reject every conflicting candidate', () => {
  const config = manualConfig()
  const conflict = dailySource()
  conflict.execution_candidates.push({ ...conflict.execution_candidates[0], position_intent: 'ENTER_SHORT', stop_price: 110, take_profit_price: 80, signal_id: 'fixture:btc:short' })
  const conflictPlan = createPlan(conflict, { product: 'usdm', environment: 'testnet', config, context: planContext(), ledger: { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW })
  assert.equal(conflictPlan.intents.length, 0)
  assert.equal(conflictPlan.skipped.filter((row) => row.code === 'SIGNAL_DIRECTION_CONFLICT').length, 2)

  const duplicate = dailySource()
  duplicate.execution_candidates.push({ ...duplicate.execution_candidates[0] })
  const duplicatePlan = createPlan(duplicate, { product: 'usdm', environment: 'testnet', config, context: planContext(), ledger: { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW })
  assert.equal(duplicatePlan.intents.length, 0)
  assert.equal(duplicatePlan.skipped.filter((row) => row.code === 'DUPLICATE_SIGNAL_ID').length, 2)
})

test('managed exit wins and blocks a same-cycle re-entry', () => {
  const config = manualConfig()
  const entry = dailySource().execution_candidates[0]
  const source = dailySource({ candidate: { position_intent: 'EXIT_LONG', stop_price: null, take_profit_price: null, reduce_fraction_bps: 10000, signal_id: 'fixture:btc:exit' } })
  source.execution_candidates.push({ ...entry, signal_id: 'fixture:btc:reenter' })
  const context = planContext()
  context.accounts['usdm:BTC_USDT'].managed_quantity = '10'
  context.accounts['usdm:BTC_USDT'].managed_notional = '1'
  const plan = createPlan(source, { product: 'usdm', environment: 'testnet', config, context, ledger: { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW })
  assert.equal(plan.intents.length, 1)
  assert.equal(plan.intents[0].action, 'EXIT_LONG')
  assert.ok(plan.skipped.some((row) => row.code === 'SAME_CYCLE_REVERSAL_FORBIDDEN'))
})

test('multiple reductions cannot each consume the full managed quantity', () => {
  const config = manualConfig()
  const source = dailySource({ anchor_fresh: false, anchored_week: '2029-W52', candidate: { position_intent: 'EXIT_LONG', stop_price: null, take_profit_price: null, reduce_fraction_bps: 10000, anchor_fresh: false, anchor_week: '2029-W52' } })
  source.execution_candidates.push({ ...source.execution_candidates[0], signal_id: 'fixture:btc:exit-two' })
  const context = planContext()
  context.accounts['usdm:BTC_USDT'].managed_quantity = '10'
  context.accounts['usdm:BTC_USDT'].managed_notional = '1'
  const plan = createPlan(source, { product: 'usdm', environment: 'testnet', config, context, ledger: { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW })
  assert.equal(plan.status, 'READY')
  assert.equal(plan.intents.length, 1)
  assert.equal(plan.intents[0].quantity, '10')
  assert.ok(plan.skipped.some((row) => row.code === 'REDUCTION_SUPERSEDED'))
})

test('sealed plan hash detects every post-seal change', () => {
  const { plan } = readyPlan()
  assert.equal(verifyPlan(plan, { planId: plan.plan_id, planHash: plan.plan_hash, now: NOW }).ok, true)
  const changed = structuredClone(plan)
  changed.intents[0].price = '101'
  assert.equal(verifyPlan(changed, { planId: plan.plan_id, planHash: plan.plan_hash, now: NOW }).code, 'PLAN_HASH_MISMATCH')
  const ttlConfig = manualConfig()
  ttlConfig.gate.plan_ttl_seconds = 60
  const expired = sealPlan({ product: 'usdm', environment: 'testnet', status: 'NO_ACTION', intents: [], blockers: [], skipped: [], proofs: {}, reconciliation: { status: 'ok', generated_at: new Date(NOW).toISOString() } }, { now: NOW, config: ttlConfig })
  assert.equal(verifyPlan(expired, { now: NOW + 60001 }).code, 'PLAN_EXPIRED')
})

test('sealing ignores payload clocks and enforces the configured exact TTL', () => {
  const config = manualConfig()
  const payload = {
    product: 'usdm',
    environment: 'testnet',
    status: 'NO_ACTION',
    intents: [],
    blockers: [],
    skipped: [],
    proofs: {},
    reconciliation: { status: 'ok', generated_at: new Date(NOW).toISOString() },
    created_at: new Date(NOW - 86400000).toISOString(),
    expires_at: new Date(NOW + 86400000).toISOString(),
    ttl_seconds: 86400
  }
  const plan = sealPlan(payload, { now: NOW, config })
  assert.equal(plan.created_at, new Date(NOW).toISOString())
  assert.equal(plan.expires_at, new Date(NOW + config.gate.plan_ttl_seconds * 1000).toISOString())
  assert.equal(plan.ttl_seconds, config.gate.plan_ttl_seconds)
  assert.equal(Date.parse(plan.expires_at) - Date.parse(plan.created_at), config.gate.plan_ttl_seconds * 1000)
  assert.throws(() => sealPlan(payload, { now: NOW, config, ttlSeconds: 86400 }), { code: 'PLAN_SEAL_OPTION_FORBIDDEN' })
})

test('plan verification rejects future creation, exact expiry boundary, and rehashed TTL drift', () => {
  const { plan, config } = readyPlan()
  assert.equal(verifyPlan(plan, { now: NOW - 1, planTtlSeconds: config.gate.plan_ttl_seconds }).code, 'PLAN_CREATED_IN_FUTURE')
  assert.equal(verifyPlan(plan, { now: Date.parse(plan.expires_at) - 1, planTtlSeconds: config.gate.plan_ttl_seconds }).ok, true)
  assert.equal(verifyPlan(plan, { now: Date.parse(plan.expires_at), planTtlSeconds: config.gate.plan_ttl_seconds }).code, 'PLAN_EXPIRED')

  const extended = structuredClone(plan)
  extended.expires_at = new Date(Date.parse(extended.created_at) + 86400000).toISOString()
  extended.ttl_seconds = 86400
  delete extended.plan_hash
  extended.plan_hash = sha256Hex(extended)
  assert.equal(verifyPlan(extended, { now: NOW, planTtlSeconds: config.gate.plan_ttl_seconds }).code, 'PLAN_TTL_MISMATCH')

  const tampered = structuredClone(plan)
  tampered.created_at = new Date(NOW + 1000).toISOString()
  assert.equal(verifyPlan(tampered, { now: NOW, planTtlSeconds: config.gate.plan_ttl_seconds }).code, 'PLAN_HASH_MISMATCH')
})

test('correctly hashed but hand-edited intents fail deterministic re-derivation', () => {
  const { plan, config } = readyPlan()
  const forgedCore = structuredClone(plan)
  forgedCore.intents[0].quantity = '999'
  forgedCore.intents[0].base_quantity = '0.999'
  forgedCore.intents[0].size = 999
  forgedCore.intents[0].estimated_notional = '99.9'
  const forged = sealPlan(forgedCore, { now: NOW, config })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-derivation-'))
  const result = staticExecutionGate(forged, { config, planId: forged.plan_id, planHash: forged.plan_hash, commit: true, confirm: `EXECUTE GATE TESTNET ${forged.plan_id} ${forged.plan_hash}`, interactive: true, env: {}, dataDir: directory, ledgerPath: path.join(directory, 'ledger.json'), killPath: path.join(directory, 'gate_KILL'), marketSnapshot: marketSnapshot(), weeklyAnchor: weeklyAnchor(), executionSource: dailySource(), now: NOW })
  assert.equal(result.code, 'PLAN_DERIVATION_MISMATCH')
})

test('CLI rejects a production-environment token before loading execution state', () => {
  const script = fileURLToPath(new URL('../scripts/gate-trade.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, 'status', '--environment', 'live'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /PRODUCTION_EXECUTION_UNSUPPORTED/)
})

test('post-seal risk-policy changes require a new plan', () => {
  const { plan, config } = readyPlan()
  const changed = structuredClone(config)
  changed.gate.usdm.max_order_notional_usdt = 99
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-policy-drift-'))
  const result = staticExecutionGate(plan, { config: changed, planId: plan.plan_id, planHash: plan.plan_hash, commit: true, confirm: `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`, interactive: true, env: {}, dataDir: directory, ledgerPath: path.join(directory, 'ledger.json'), killPath: path.join(directory, 'gate_KILL'), now: NOW })
  assert.equal(result.code, 'RISK_POLICY_DRIFT')
})

test('entry execution requires the same canonical weekly anchor sealed into the plan', () => {
  const { plan, config } = readyPlan()
  const changedAnchor = weeklyAnchor({ regime: { label: 'changed' } })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-anchor-drift-'))
  const result = staticExecutionGate(plan, { config, planId: plan.plan_id, planHash: plan.plan_hash, commit: true, confirm: `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`, interactive: true, env: {}, dataDir: directory, ledgerPath: path.join(directory, 'ledger.json'), killPath: path.join(directory, 'gate_KILL'), marketSnapshot: marketSnapshot(), weeklyAnchor: changedAnchor, now: NOW })
  assert.equal(result.code, 'WEEKLY_ANCHOR_DRIFT')
})

test('execution requires the same canonical market snapshot sealed into the plan', () => {
  const { plan, config } = readyPlan()
  const changedMarket = marketSnapshot()
  changedMarket.assets.BTC.usdm.ticker.last = '101'
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-market-drift-'))
  const result = staticExecutionGate(plan, { config, planId: plan.plan_id, planHash: plan.plan_hash, commit: true, confirm: `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`, interactive: true, env: {}, dataDir: directory, ledgerPath: path.join(directory, 'ledger.json'), killPath: path.join(directory, 'gate_KILL'), marketSnapshot: changedMarket, weeklyAnchor: weeklyAnchor(), executionSource: dailySource(), now: NOW })
  assert.equal(result.code, 'MARKET_SNAPSHOT_DRIFT')
})

test('locked or noninteractive execution remains blocked', () => {
  const { plan, config } = readyPlan()
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-gates-'))
  const common = { planId: plan.plan_id, planHash: plan.plan_hash, commit: true, confirm: `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`, interactive: true, env: {}, dataDir: temp, ledgerPath: path.join(temp, 'ledger.json'), killPath: path.join(temp, 'gate_KILL'), marketSnapshot: marketSnapshot(), weeklyAnchor: weeklyAnchor(), executionSource: dailySource(), now: NOW }
  const locked = loadConfig()
  assert.equal(staticExecutionGate(plan, { ...common, config: locked }).code, 'SUBMISSION_MODE_LOCKED')
  assert.equal(staticExecutionGate(plan, { ...common, config, interactive: false }).code, 'REAL_TTY_REQUIRED')
  assert.equal(staticExecutionGate(plan, { ...common, config, env: { TYCHE_UNATTENDED: '1' } }).code, 'UNATTENDED_EXECUTION_FORBIDDEN')
  fs.writeFileSync(common.killPath, 'stop', 'utf8')
  assert.equal(staticExecutionGate(plan, { ...common, config }).code, 'GATE_KILL_ACTIVE')
})

test('legacy reconciliation receipt linkage never clears sticky red', () => {
  const { plan, config } = readyPlan()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-legacy-clear-red-'))
  const ledgerPath = path.join(directory, 'ledger.json')
  const redId = 'te_red_fixture'
  const base = {
    schema: 'tyche_gate_ledger/v1',
    plans: [],
    events: [{ event_id: redId, intent_id: `t-TYE${'d'.repeat(22)}`, state: 'RECONCILE_RED', at: new Date(NOW - 2000).toISOString() }],
    fills: [],
    reconciliations: [{ receipt_id: 'tr_legacy', status: 'ok', generated_at: new Date(NOW - 1000).toISOString(), clears_red_id: redId }]
  }
  const common = { config, planId: plan.plan_id, planHash: plan.plan_hash, commit: true, confirm: `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`, interactive: true, env: {}, dataDir: directory, ledgerPath, killPath: path.join(directory, 'gate_KILL'), marketSnapshot: marketSnapshot(), weeklyAnchor: weeklyAnchor(), executionSource: dailySource(), now: NOW }
  fs.writeFileSync(ledgerPath, JSON.stringify(base))
  assert.equal(staticExecutionGate(plan, common).code, 'STICKY_RECONCILE_RED')
})

test('Spot plans can never pass the execution gate', () => {
  const config = manualConfig()
  const plan = sealPlan({ product: 'spot', environment: 'dry-run', status: 'READY', intents: [], blockers: [], skipped: [], proofs: {}, reconciliation: { status: 'not_applicable' } }, { now: NOW, config })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-spot-gate-'))
  const result = staticExecutionGate(plan, { config, planId: plan.plan_id, planHash: plan.plan_hash, commit: true, confirm: `EXECUTE GATE TESTNET ${plan.plan_id} ${plan.plan_hash}`, interactive: true, env: {}, dataDir: temp, ledgerPath: path.join(temp, 'ledger.json'), killPath: path.join(temp, 'gate_KILL'), now: NOW })
  assert.equal(result.code, 'TESTNET_USDM_ONLY')
})

test('blocked context produces a sealed non-executable plan', () => {
  const config = manualConfig()
  const context = planContext()
  context.blockers.push({ code: 'FIXTURE_BLOCK', message: 'blocked' })
  const plan = createPlan(dailySource(), { product: 'usdm', environment: 'testnet', config, context, ledger: { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: DATE, isoWeek: WEEK, weeklyAnchor: weeklyAnchor(), marketSnapshot: marketSnapshot(), now: NOW })
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.intents.length, 0)
  assert.equal(verifyPlan(plan, { now: NOW }).ok, true)
})
