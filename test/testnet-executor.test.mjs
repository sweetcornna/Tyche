import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  createTestnetExecutor,
  createTestnetExecutorServer,
  DEFAULT_KILL_SWITCH_PATHS,
  EXECUTOR_MAX_FRAME_BYTES,
  EXECUTOR_SOCKET_TIMEOUT_MS,
  requestExecutorSocket
} from '../scripts/testnet-executor.mjs'
import { sealReconciliationReceipt, sealPlan } from '../scripts/gate-trade.mjs'
import { NOW, dailySource, readyPlan } from './helpers.mjs'

function tempPaths(prefix = 'tyche-executor-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { directory, statePath: path.join(directory, 'state.json'), socketPath: path.join(directory, 'executor.sock'), killSwitchPath: path.join(directory, 'KILL') }
}

function executorOptions(paths, extra = {}) {
  return {
    venue: 'gate',
    testOnlyAllowUnsafePaths: true,
    statePath: paths.statePath,
    killSwitchPath: paths.killSwitchPath,
    now: () => Date.parse('2030-01-07T12:00:00.000Z'),
    riskDigest: 'risk-fixture',
    configDigest: 'config-fixture',
    policyDigest: 'policy-fixture',
    ...extra
  }
}

function automaticConfig(venue) {
  const { config } = readyPlan()
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
  return config
}

function greenReceipt() {
  return sealReconciliationReceipt({
    status: 'ok',
    sticky: false,
    sticky_cause: false,
    generated_at: new Date(NOW).toISOString(),
    product: 'usdm',
    environment: 'testnet',
    issues: [],
    state_issues: [],
    requested_cause_ids: [],
    pending_protection_intent_ids: [],
    resolved_cause_ids: [],
    cause_evidence: [],
    recovered_fills: [],
    resolutions: [],
    observed_cause_ids: [],
    summary: { open_orders: 0, protections: 0, trades: 0, positions: 0, unresolved_causes: 0, resolved_causes: 0 }
  })
}

async function armedExecutor(extra = {}) {
  const paths = tempPaths()
  const executor = createTestnetExecutor(executorOptions(paths, extra))
  const armed = await executor.handleRequest({ command: 'arm' })
  assert.equal(armed.ok, true)
  return { executor, paths, receipt: armed.receipt }
}

test('executor arm receipt is exact 24 hours, idempotent, and survives restart without renewal', async () => {
  const paths = tempPaths('tyche-executor-arm-')
  let now = Date.parse('2030-01-07T12:00:00.000Z')
  const options = executorOptions(paths, { now: () => now })
  const first = createTestnetExecutor(options)
  const armed = await first.handleRequest({ command: 'arm' })
  assert.equal(armed.receipt.expires_at, '2030-01-08T12:00:00.000Z')
  const repeated = await first.handleRequest({ command: 'arm' })
  assert.equal(repeated.renewed, false)
  assert.deepEqual(repeated.receipt, armed.receipt)
  now += 60 * 60 * 1000
  const restarted = createTestnetExecutor(options)
  const status = await restarted.handleRequest({ command: 'status' })
  assert.equal(status.armed, true)
  assert.equal(status.arm.expires_at, armed.receipt.expires_at)
})

test('executor automatically disarms at exact expiry and on digest changes', async () => {
  const paths = tempPaths('tyche-executor-expiry-')
  let now = Date.parse('2030-01-07T12:00:00.000Z')
  let digests = { risk_digest: 'risk-fixture', config_digest: 'config-fixture', policy_digest: 'policy-fixture' }
  const executor = createTestnetExecutor(executorOptions(paths, { now: () => now, getDigests: () => digests }))
  await executor.handleRequest({ command: 'arm' })
  now += 24 * 60 * 60 * 1000
  const expired = await executor.handleRequest({ command: 'status' })
  assert.equal(expired.armed, false)
  assert.equal(expired.disarm_reason, 'ARM_EXPIRED')
  now += 1
  await executor.handleRequest({ command: 'arm' })
  digests = { ...digests, policy_digest: 'policy-changed' }
  const drift = await executor.handleRequest({ command: 'status' })
  assert.equal(drift.armed, false)
  assert.equal(drift.disarm_reason, 'DIGEST_DRIFT')
})

test('kill switch and sticky reconciliation red block mutation and clear an active arm', async () => {
  const paths = tempPaths('tyche-executor-safety-')
  let safety = { kill_switch: false, sticky_red: false }
  const { executor } = await armedExecutor({ getSafetyState: () => safety })
  safety = { kill_switch: true, sticky_red: false }
  const killed = await executor.handleRequest({ command: 'status' })
  assert.equal(killed.armed, false)
  assert.equal(killed.disarm_reason, 'KILL_SWITCH')
  const rearm = await executor.handleRequest({ command: 'arm' })
  assert.equal(rearm.code, 'EXECUTOR_KILL_SWITCH')
  safety = { kill_switch: false, sticky_red: true }
  const sticky = await executor.handleRequest({ command: 'arm' })
  assert.equal(sticky.code, 'EXECUTOR_STICKY_RED')
  void paths
})

test('default executor kill switch keeps the established paths while tests use an explicit temporary path', async () => {
  assert.equal(DEFAULT_KILL_SWITCH_PATHS.gate, path.resolve('data', 'gate_KILL'))
  assert.equal(DEFAULT_KILL_SWITCH_PATHS.binance, path.resolve('data', 'binance_KILL'))
  const paths = tempPaths('tyche-executor-default-kill-')
  fs.writeFileSync(paths.killSwitchPath, 'test kill switch\n', { mode: 0o600 })
  const executor = createTestnetExecutor(executorOptions(paths))
  const blocked = await executor.handleRequest({ command: 'arm' })
  assert.equal(blocked.code, 'EXECUTOR_KILL_SWITCH')
})

test('plan command is a strict date/week union and internally projects Gate and Binance planning results', async () => {
  const source = dailySource()
  for (const venue of ['gate', 'binance']) {
    const config = automaticConfig(venue)
    const { plan: gatePlan } = readyPlan({ config: automaticConfig('gate'), source })
    const plan = venue === 'gate' ? gatePlan : sealPlan({ ...gatePlan, venue }, { config, now: NOW })
    const paths = tempPaths(`tyche-executor-plan-${venue}-`)
    let calls = 0
    const executor = createTestnetExecutor(executorOptions(paths, {
      venue,
      config,
      testDailySource: source,
      planningClient: {},
      ledgerPath: path.join(paths.directory, 'ledger.json'),
      planFn: async (input) => {
        assert.equal(fs.existsSync(`${paths.statePath}.lock`), false)
        assert.equal(input.venue, venue)
        assert.equal(input.date, '2030-01-07')
        assert.equal(input.isoWeek, '2030-W02')
        assert.equal(input.daily_source_digest, plan.daily_source_proof.digest)
        calls += 1
        return { outcome: 'READY', venue, product: 'usdm', environment: 'testnet', submitted: 0, filled: 0, plan }
      }
    }))
    const generated = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
    assert.equal(generated.ok, true)
    assert.equal(generated.outcome, 'READY')
    assert.equal(generated.plan_summary.plan_hash, plan.plan_hash)
    assert.equal(generated.plan_summary.venue, venue)
    assert.equal(generated.plan_summary.intents.length, 1)
    assert.equal(Object.hasOwn(generated, 'plan'), false)
    assert.doesNotMatch(JSON.stringify(generated), /"(?:account|ledger|fills|proofs)"\s*:/)
    const notArmed = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
    assert.equal(notArmed.code, 'EXECUTOR_NOT_ARMED')
    const status = await executor.handleRequest({ command: 'status' })
    assert.deepEqual(status.latest_plan_summary, generated.plan_summary)
    const duplicate = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
    assert.equal(duplicate.duplicate, true)
    assert.equal(calls, 1)
    assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).plans[plan.plan_hash].plan_hash, plan.plan_hash)
  }
})

test('plan request rejects mixed sealed-plan forms and malformed date/week values', async () => {
  const paths = tempPaths('tyche-executor-plan-protocol-')
  const executor = createTestnetExecutor(executorOptions(paths, {
    config: automaticConfig('gate'),
    testDailySource: dailySource(),
    planningClient: {},
    planFn: async () => { throw new Error('must not run') }
  }))
  for (const request of [
    { command: 'plan', date: '2030-01-07', iso_week: '2030-W02', plan: {} },
    { command: 'plan', date: '2030-01-07', iso_week: '2030-W02', plan_ref: 'hash' },
    { command: 'plan', date: '2030-02-30', iso_week: '2030-W09' },
    { command: 'plan', date: '2030-01-07', iso_week: '2030-W00' },
    { command: 'plan', date: '2030-01-07' }
  ]) {
    const result = await executor.handleRequest(request)
    assert.match(result.code, /FIELD_UNKNOWN|DATE_INVALID|WEEK_INVALID/)
  }
})

test('planning cache keys include the canonical daily digest and only cache READY/NO_ACTION', async () => {
  const sourceOne = dailySource()
  const sourceTwo = dailySource({ candidate: { signal_id: 'fixture:btc:second-daily-source' } })
  const config = automaticConfig('gate')
  const { plan: planOne } = readyPlan({ config, source: sourceOne })
  const { plan: planTwo } = readyPlan({ config, source: sourceTwo })
  const paths = tempPaths('tyche-executor-plan-cache-')
  fs.writeFileSync(path.join(paths.directory, 'crypto_daily.json'), JSON.stringify(sourceOne), { mode: 0o600 })
  const plans = new Map([[planOne.daily_source_proof.digest, planOne], [planTwo.daily_source_proof.digest, planTwo]])
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    runtimeRoot: paths.directory,
    config,
    planFn: async (input) => {
      assert.equal(fs.existsSync(`${paths.statePath}.lock`), false)
      calls += 1
      const plan = plans.get(input.daily_source_digest)
      return { outcome: 'READY', venue: 'gate', product: 'usdm', environment: 'testnet', submitted: 0, filled: 0, plan }
    }
  }))
  const first = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(first.outcome, 'READY')
  fs.writeFileSync(path.join(paths.directory, 'crypto_daily.json'), JSON.stringify(sourceTwo), { mode: 0o600 })
  const second = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(second.outcome, 'READY')
  assert.notEqual(second.plan_summary.plan_hash, first.plan_summary.plan_hash)
  const duplicate = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(duplicate.duplicate, true)
  assert.equal(calls, 2)
  assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).plan_runs ? Object.keys(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).plan_runs).length : 0, 2)
})

test('expired READY cache is re-planned for the same canonical source', async () => {
  const source = dailySource()
  const config = automaticConfig('gate')
  const { plan: basePlan } = readyPlan({ config, source })
  const paths = tempPaths('tyche-executor-plan-cache-expired-')
  let now = NOW
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    now: () => now,
    config,
    testDailySource: source,
    planFn: async ({ now: plannerNow }) => {
      calls += 1
      const plan = sealPlan(basePlan, { config, now: plannerNow() })
      return { outcome: 'READY', venue: 'gate', product: 'usdm', environment: 'testnet', submitted: 0, filled: 0, plan }
    }
  }))
  const first = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(first.outcome, 'READY')
  now = Date.parse(first.plan_summary.expires_at) + 1
  const second = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(second.outcome, 'READY')
  assert.equal(second.duplicate, undefined)
  assert.notEqual(second.plan_summary.plan_hash, first.plan_summary.plan_hash)
  assert.equal(calls, 2)
})

test('tampered READY cache fails closed without invoking the planner', async () => {
  const source = dailySource()
  const config = automaticConfig('gate')
  const { plan } = readyPlan({ config, source })
  const paths = tempPaths('tyche-executor-plan-cache-tamper-')
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    config,
    testDailySource: source,
    planFn: async () => {
      calls += 1
      return { outcome: 'READY', venue: 'gate', product: 'usdm', environment: 'testnet', submitted: 0, filled: 0, plan }
    }
  }))
  const first = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(first.outcome, 'READY')
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'))
  state.plans[plan.plan_hash].plan.intents[0].size += 1
  fs.writeFileSync(paths.statePath, JSON.stringify(state), { mode: 0o600 })
  const blocked = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(blocked.code, 'EXECUTOR_PLAN_STATE_INVALID')
  assert.notEqual(blocked.outcome, 'READY')
  assert.equal(calls, 1)
})

test('planning detects canonical source drift during the external planner call and does not cache the blocked result', async () => {
  const sourceOne = dailySource()
  const sourceTwo = dailySource({ candidate: { signal_id: 'fixture:btc:drifted-source' } })
  const config = automaticConfig('gate')
  const { plan } = readyPlan({ config, source: sourceOne })
  const paths = tempPaths('tyche-executor-plan-drift-')
  const sourcePath = path.join(paths.directory, 'crypto_daily.json')
  fs.writeFileSync(sourcePath, JSON.stringify(sourceOne), { mode: 0o600 })
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    runtimeRoot: paths.directory,
    config,
    planFn: async (input) => {
      calls += 1
      fs.writeFileSync(input.sourcePath, JSON.stringify(sourceTwo), { mode: 0o600 })
      return { outcome: 'READY', venue: 'gate', product: 'usdm', environment: 'testnet', submitted: 0, filled: 0, plan }
    }
  }))
  const result = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(result.code, 'EXECUTOR_PLAN_SOURCE_CHANGED')
  assert.equal(result.outcome, 'BLOCKED')
  assert.equal(calls, 1)
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'))
  assert.deepEqual(state.plan_runs, {})
  assert.equal(Object.keys(state.plans).length, 0)
})

test('NO_ACTION is idempotent but a transient BLOCKED planning result is retried', async () => {
  const source = dailySource()
  const config = automaticConfig('gate')
  const { plan } = readyPlan({ config, source })
  const paths = tempPaths('tyche-executor-plan-outcomes-')
  fs.writeFileSync(path.join(paths.directory, 'crypto_daily.json'), JSON.stringify(source), { mode: 0o600 })
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    runtimeRoot: paths.directory,
    config,
    planFn: async () => {
      calls += 1
      if (calls === 1) return { outcome: 'NO_ACTION', venue: 'gate', product: 'usdm', environment: 'testnet', submitted: 0, filled: 0, blockers: [] }
      return { outcome: 'BLOCKED', venue: 'gate', product: 'usdm', environment: 'testnet', submitted: 0, filled: 0, blockers: [{ code: 'TRANSIENT_INPUT' }] }
    }
  }))
  const noAction = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(noAction.outcome, 'NO_ACTION')
  assert.equal((await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })).duplicate, true)
  assert.equal(calls, 1)

  // A different source key proves that a transient BLOCKED result is not
  // persisted as a day-wide lock and can be retried for the new source.
  const changed = dailySource({ candidate: { signal_id: 'fixture:btc:blocked-retry' } })
  fs.writeFileSync(path.join(paths.directory, 'crypto_daily.json'), JSON.stringify(changed), { mode: 0o600 })
  const blocked = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
  assert.equal(blocked.outcome, 'BLOCKED')
  assert.equal(calls, 2)
})

test('kill and sticky safety gates block internal planning before the client or planner runs', async () => {
  const source = dailySource()
  const config = automaticConfig('gate')
  for (const [label, safety, expected] of [
    ['kill', { kill_switch: true, sticky_red: false }, 'EXECUTOR_KILL_SWITCH'],
    ['sticky', { kill_switch: false, sticky_red: true }, 'EXECUTOR_STICKY_RED']
  ]) {
    const paths = tempPaths(`tyche-executor-plan-safety-${label}-`)
    let calls = 0
    const executor = createTestnetExecutor(executorOptions(paths, {
      config,
      testDailySource: source,
      getSafetyState: () => safety,
      planFn: async () => { calls += 1; return {} }
    }))
    const result = await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })
    assert.equal(result.code, expected)
    assert.equal(calls, 0)
  }
})

test('planning receives a read-only client view', async () => {
  const source = dailySource()
  const config = automaticConfig('gate')
  const { plan } = readyPlan({ config, source })
  const paths = tempPaths('tyche-executor-plan-readonly-')
  const client = { usdmPlaceOrder: async () => ({ data: {} }) }
  const executor = createTestnetExecutor(executorOptions(paths, {
    config,
    testDailySource: source,
    planningClient: client,
    planFn: async ({ client: readOnly }) => {
      assert.throws(() => readOnly.usdmPlaceOrder({}), { code: 'EXECUTOR_PLANNING_MUTATION_FORBIDDEN' })
      return { outcome: 'READY', venue: 'gate', product: 'usdm', environment: 'testnet', submitted: 0, filled: 0, plan }
    }
  }))
  assert.equal((await executor.handleRequest({ command: 'plan', date: '2030-01-07', iso_week: '2030-W02' })).outcome, 'READY')
})

test('fixed protocol rejects unknown fields, routes, methods, and credential fields', async () => {
  const { executor } = await armedExecutor()
  for (const request of [
    { command: 'status', extra: true },
    { command: 'status', host: 'evil' },
    { command: 'status', method: 'POST' },
    { command: 'arm', api_key: 'not-returned' }
  ]) {
    const result = await executor.handleRequest(request)
    assert.equal(result.ok, false)
    assert.match(result.code, /FORBIDDEN|UNKNOWN/)
    assert.doesNotMatch(JSON.stringify(result), /not-returned|evil|POST/)
  }
})

test('registered sealed plan requires exact manual hash and executes once per fixed venue', async () => {
  const { plan } = readyPlan()
  const paths = tempPaths('tyche-executor-manual-')
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    client: {},
    executeFn: async () => {
      assert.equal(fs.existsSync(`${paths.statePath}.lock`), false)
      calls += 1
      return { outcome: 'COMPLETE', submitted: 1 }
    }
  }))
  assert.equal((await executor.handleRequest({ command: 'arm' })).ok, true)
  assert.equal((await executor.registerPlan({ plan })).ok, true)
  const missing = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash })
  assert.equal(missing.code, 'EXECUTOR_PLAN_HASH_CONFIRMATION_REQUIRED')
  const wrong = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: '0'.repeat(64) })
  assert.equal(wrong.code, 'EXECUTOR_PLAN_HASH_CONFIRMATION_REQUIRED')
  const executed = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(executed.outcome, 'COMPLETE')
  const duplicate = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(duplicate.outcome, 'DUPLICATE_SUPPRESSED')
  assert.equal(calls, 1)
  assert.equal((await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash, venue: 'binance' })).code, 'EXECUTOR_FIELD_UNKNOWN')
})

test('executor accepts sealed plan content directly while keeping Binance a separate fixed venue', async () => {
  const { plan } = readyPlan()
  const gatePaths = tempPaths('tyche-executor-direct-plan-')
  let gateCalls = 0
  const gate = createTestnetExecutor(executorOptions(gatePaths, {
    client: {},
    executeFn: async () => { gateCalls += 1; return { outcome: 'COMPLETE' } }
  }))
  await gate.handleRequest({ command: 'arm' })
  const direct = await gate.handleRequest({ command: 'execute', plan, plan_hash: plan.plan_hash, confirm_plan_hash: plan.plan_hash })
  assert.equal(direct.outcome, 'COMPLETE')
  assert.equal(gateCalls, 1)

  const binancePaths = tempPaths('tyche-executor-binance-')
  const binance = createTestnetExecutor({ ...executorOptions(binancePaths), venue: 'binance', client: {} })
  assert.equal((await binance.handleRequest({ command: 'arm' })).receipt.venue, 'binance')
  assert.equal((await binance.registerPlan({ plan })).code, 'EXECUTOR_PLAN_VENUE_MISMATCH')
})

test('shared cycle state permits one active venue and rejects cross-venue failover', async () => {
  const { plan, config } = readyPlan()
  const binancePlan = sealPlan({ ...plan, venue: 'binance' }, { config, now: NOW })
  const paths = tempPaths('tyche-executor-cycle-')
  const cycleStatePath = path.join(paths.directory, 'cycle.json')
  const common = { cycleStatePath, client: {}, executeFn: async () => ({ outcome: 'COMPLETE' }) }
  const gate = createTestnetExecutor(executorOptions({ ...paths, statePath: path.join(paths.directory, 'gate.json') }, common))
  const binance = createTestnetExecutor({ ...executorOptions({ ...paths, statePath: path.join(paths.directory, 'binance.json') }, common), venue: 'binance' })
  await gate.handleRequest({ command: 'arm' })
  await binance.handleRequest({ command: 'arm' })
  assert.equal((await gate.handleRequest({ command: 'execute', plan, plan_hash: plan.plan_hash, confirm_hash: plan.plan_hash })).outcome, 'COMPLETE')
  assert.equal((await binance.handleRequest({ command: 'execute', plan: binancePlan, plan_hash: binancePlan.plan_hash, confirm_hash: binancePlan.plan_hash, cycle_key: 'attacker-selected-cycle' })).code, 'EXECUTOR_FIELD_UNKNOWN')
  assert.equal((await binance.handleRequest({ command: 'execute', plan: binancePlan, plan_hash: binancePlan.plan_hash, confirm_hash: binancePlan.plan_hash })).code, 'EXECUTOR_CYCLE_VENUE_CONFLICT')
  void cycleStatePath
})

test('scheduled execution accepts only the current UTC slot and an in-arm plan', async () => {
  const { plan: basePlan, config } = readyPlan()
  const plan = sealPlan(basePlan, { config, now: Date.parse('2030-01-07T12:10:00.000Z') })
  const paths = tempPaths('tyche-executor-scheduled-')
  let now = Date.parse('2030-01-07T12:00:00.000Z')
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    now: () => now,
    client: {},
    executeFn: async () => { calls += 1; return { outcome: 'COMPLETE' } }
  }))
  await executor.handleRequest({ command: 'arm' })
  now = Date.parse('2030-01-07T12:10:00.000Z')
  assert.equal((await executor.registerPlan({ plan })).ok, true)
  const notCurrent = await executor.handleRequest({ command: 'execute', mode: 'scheduled', slot_key: 'daily:2030-01-07T08:10:00.000Z', plan_ref: plan.plan_hash })
  assert.equal(notCurrent.code, 'EXECUTOR_SLOT_NOT_CURRENT')
  now = Date.parse('2030-01-07T12:10:00.000Z')
  const current = await executor.handleRequest({ command: 'execute', mode: 'scheduled', slot_key: 'daily:2030-01-07T12:10:00.000Z', plan_ref: plan.plan_hash })
  assert.equal(current.outcome, 'COMPLETE')
  assert.equal(calls, 1)
})

test('scheduled execution rejects the overlapping Monday weekly key and plans created before the daily slot', async () => {
  const { plan: basePlan, config } = readyPlan()
  const preSlotPlan = sealPlan(basePlan, { config, now: Date.parse('2030-01-07T12:00:00.000Z') })
  const paths = tempPaths('tyche-executor-scheduled-boundary-')
  let now = Date.parse('2030-01-07T12:00:00.000Z')
  const executor = createTestnetExecutor(executorOptions(paths, {
    now: () => now,
    client: {},
    executeFn: async () => ({ outcome: 'COMPLETE' })
  }))
  await executor.handleRequest({ command: 'arm' })
  await executor.registerPlan({ plan: preSlotPlan })
  now = Date.parse('2030-01-07T12:10:00.000Z')
  const preSlot = await executor.handleRequest({ command: 'execute', mode: 'scheduled', slot_key: 'daily:2030-01-07T12:10:00.000Z', plan_ref: preSlotPlan.plan_hash })
  assert.equal(preSlot.code, 'EXECUTOR_PLAN_OUTSIDE_ARM_WINDOW')

  const mondayPlan = sealPlan(basePlan, { config, now: Date.parse('2030-01-07T00:05:00.000Z') })
  const mondayPaths = tempPaths('tyche-executor-monday-boundary-')
  let mondayNow = Date.parse('2030-01-07T00:05:00.000Z')
  const monday = createTestnetExecutor(executorOptions(mondayPaths, {
    now: () => mondayNow,
    client: {},
    executeFn: async () => ({ outcome: 'COMPLETE' })
  }))
  await monday.handleRequest({ command: 'arm' })
  await monday.registerPlan({ plan: mondayPlan })
  mondayNow = Date.parse('2030-01-07T00:10:00.000Z')
  const weeklyKey = await monday.handleRequest({ command: 'execute', mode: 'scheduled', slot_key: 'weekly:2030-01-07T00:05:00.000Z', plan_ref: mondayPlan.plan_hash })
  assert.equal(weeklyKey.code, 'EXECUTOR_DAILY_SLOT_REQUIRED')
})

test('ambiguous submission locks the venue without retry or failover until reconcile is green', async () => {
  const { plan } = readyPlan()
  const paths = tempPaths('tyche-executor-ambiguous-')
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    client: {},
    executeFn: async () => {
      calls += 1
      const error = new Error('submission outcome unknown')
      error.ambiguous = true
      throw error
    },
    reconcileFn: async () => {
      assert.equal(fs.existsSync(`${paths.statePath}.lock`), false)
      return {
        venue: 'gate',
        receipt: sealReconciliationReceipt({
        status: 'ok',
        sticky: false,
        sticky_cause: false,
        generated_at: new Date(NOW).toISOString(),
        product: 'usdm',
        environment: 'testnet',
        issues: [],
        state_issues: [],
        requested_cause_ids: [],
        pending_protection_intent_ids: [],
        resolved_cause_ids: [],
        cause_evidence: [],
        recovered_fills: [],
        resolutions: [],
        observed_cause_ids: [],
        summary: { open_orders: 0, protections: 0, trades: 0, positions: 0, unresolved_causes: 0, resolved_causes: 0 }
        })
      }
    }
  }))
  await executor.handleRequest({ command: 'arm' })
  await executor.registerPlan({ plan })
  const ambiguous = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(ambiguous.code, 'EXECUTOR_AMBIGUOUS_SUBMISSION')
  const locked = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(locked.code, 'EXECUTOR_VENUE_LOCKED')
  assert.equal(calls, 1)
  const reconciled = await executor.handleRequest({ command: 'reconcile', plan_ref: plan.plan_hash })
  assert.equal(reconciled.outcome, 'RECONCILED')
  const stillNoRetry = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(stillNoRetry.outcome, 'DUPLICATE_SUPPRESSED')
  assert.equal(calls, 1)
})

test('default deterministic reconcile uses read-only fake client, persists GREEN receipt, and keeps lock cleared', async () => {
  const { plan } = readyPlan()
  const paths = tempPaths('tyche-executor-default-reconcile-')
  let calls = 0
  const client = {
    usdmAccount: async () => ({ data: { currency: 'USDT', available: '1000', in_dual_mode: false } }),
    usdmPositions: async () => ({ data: [] }),
    usdmOrders: async () => ({ data: [] }),
    usdmPriceOrders: async () => ({ data: [] }),
    usdmTrades: async () => ({ data: [] })
  }
  const executor = createTestnetExecutor(executorOptions(paths, {
    client,
    ledgerPath: path.join(paths.directory, 'ledger.json'),
    executeFn: async () => {
      calls += 1
      const error = new Error('ambiguous submission')
      error.ambiguous = true
      throw error
    }
  }))
  await executor.handleRequest({ command: 'arm' })
  await executor.registerPlan({ plan })
  assert.equal((await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })).code, 'EXECUTOR_AMBIGUOUS_SUBMISSION')
  const reconciled = await executor.handleRequest({ command: 'reconcile', plan_ref: plan.plan_hash })
  assert.equal(reconciled.outcome, 'RECONCILED')
  assert.equal(reconciled.remaining_red_causes, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.directory, 'ledger.json'), 'utf8')).reconciliations.length, 1)
  const status = await executor.handleRequest({ command: 'status' })
  assert.equal(status.locked, false)
  assert.equal(calls, 1)
})

test('returned RECONCILE_RED is persisted and blocks a second adapter invocation', async () => {
  const { plan } = readyPlan()
  const paths = tempPaths('tyche-executor-returned-red-')
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    client: {},
    executeFn: async () => {
      calls += 1
      return { outcome: 'RECONCILE_RED', code: 'SUBMISSION_AMBIGUOUS', evidence: { ambiguous: true } }
    }
  }))
  await executor.handleRequest({ command: 'arm' })
  await executor.registerPlan({ plan })
  const first = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(first.code, 'EXECUTOR_AMBIGUOUS_SUBMISSION')
  const second = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(second.code, 'EXECUTOR_VENUE_LOCKED')
  assert.equal(calls, 1)
  const persisted = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'))
  assert.equal(persisted.executions[plan.plan_hash].lifecycle, 'reconcile_required')
  assert.equal(persisted.ambiguous_lock.reason, 'AMBIGUOUS_SUBMISSION')
})

test('returned BLOCKED with nested unknown-submission evidence is persisted and blocks replay', async () => {
  const { plan } = readyPlan()
  const paths = tempPaths('tyche-executor-returned-blocked-')
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    client: {},
    executeFn: async () => {
      calls += 1
      return { outcome: 'BLOCKED', evidence: { unknown_submission: true } }
    }
  }))
  await executor.handleRequest({ command: 'arm' })
  await executor.registerPlan({ plan })
  const first = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(first.code, 'EXECUTOR_AMBIGUOUS_SUBMISSION')
  const second = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(second.code, 'EXECUTOR_VENUE_LOCKED')
  assert.equal(calls, 1)
})

test('secondary phase or status RED markers cannot be hidden by a COMPLETE outcome', async () => {
  const { plan } = readyPlan()
  const paths = tempPaths('tyche-executor-secondary-red-')
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    client: {},
    executeFn: async () => {
      calls += 1
      return { outcome: 'COMPLETE', phase: 'RECONCILE_RED', status: 'ok' }
    }
  }))
  await executor.handleRequest({ command: 'arm' })
  await executor.registerPlan({ plan })
  assert.equal((await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })).code, 'EXECUTOR_AMBIGUOUS_SUBMISSION')
  assert.equal((await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })).code, 'EXECUTOR_VENUE_LOCKED')
  assert.equal(calls, 1)
})

test('orphaned reconcile claim rejects wrong token and permits only exact-token recovery', async () => {
  const paths = tempPaths('tyche-executor-reconcile-orphan-')
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    reconcileFn: async () => { calls += 1; return { venue: 'gate', receipt: greenReceipt() } }
  }))
  await executor.handleRequest({ command: 'status' })
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'))
  state.reconcile = { lifecycle: 'running', claim_token: 'reconcile-recovery-token', plan_id: null, plan_hash: null, started_at: '2030-01-07T12:00:00.000Z' }
  fs.writeFileSync(paths.statePath, JSON.stringify(state))
  const wrong = await executor.handleRequest({ command: 'reconcile', claim_token: 'wrong-token' })
  assert.equal(wrong.code, 'EXECUTOR_RECONCILE_ORPHANED')
  assert.equal(calls, 0)
  const status = await executor.handleRequest({ command: 'status' })
  assert.doesNotMatch(JSON.stringify(status), /reconcile-recovery-token/)
  const recovered = await executor.handleRequest({ command: 'reconcile', claim_token: 'reconcile-recovery-token' })
  assert.equal(recovered.outcome, 'RECONCILED')
  assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify(recovered), /reconcile-recovery-token/)
})

test('orphaned execution and cycle claims fail closed, then GREEN reconcile marks both reconciled without resubmission', async () => {
  const { plan } = readyPlan()
  const paths = tempPaths('tyche-executor-execution-orphan-')
  const claimToken = 'execution-recovery-token'
  let executeCalls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    client: {},
    ledgerPath: path.join(paths.directory, 'ledger.json'),
    executeFn: async () => { executeCalls += 1; return { outcome: 'COMPLETE' } },
    reconcileFn: async () => ({ venue: 'gate', receipt: greenReceipt() })
  }))
  await executor.handleRequest({ command: 'arm' })
  await executor.registerPlan({ plan })
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'))
  state.executions[plan.plan_hash] = { lifecycle: 'running', claim_token: claimToken, venue: 'gate', plan_id: plan.plan_id, plan_hash: plan.plan_hash, mode: 'manual', cycle_key: plan.daily_source_proof.digest, claimed_at: '2030-01-07T12:00:00.000Z' }
  fs.writeFileSync(paths.statePath, JSON.stringify(state))
  fs.writeFileSync(path.join(paths.directory, 'testnet_active_cycle.json'), JSON.stringify({ schema: 'tyche_testnet_active_cycle/v1', active: { lifecycle: 'running', cycle_key: plan.daily_source_proof.digest, venue: 'gate', plan_id: plan.plan_id, plan_hash: plan.plan_hash, claim_token: claimToken, claimed_at: '2030-01-07T12:00:00.000Z' } }))
  const blocked = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(blocked.code, 'EXECUTOR_EXECUTION_ORPHANED')
  assert.equal(executeCalls, 0)
  const reconciled = await executor.handleRequest({ command: 'reconcile', plan_ref: plan.plan_hash })
  assert.equal(reconciled.outcome, 'RECONCILED')
  const after = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(after.outcome, 'DUPLICATE_SUPPRESSED')
  assert.equal(executeCalls, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.directory, 'testnet_active_cycle.json'), 'utf8')).active.lifecycle, 'reconciled')
})

test('cycle-only orphan recovery requires the exact persisted cycle token and reconciles the shared claim', async () => {
  const paths = tempPaths('tyche-executor-cycle-only-orphan-')
  let calls = 0
  const executor = createTestnetExecutor(executorOptions(paths, {
    reconcileFn: async () => { calls += 1; return { venue: 'gate', receipt: greenReceipt() } }
  }))
  await executor.handleRequest({ command: 'status' })
  fs.writeFileSync(path.join(paths.directory, 'testnet_active_cycle.json'), JSON.stringify({
    schema: 'tyche_testnet_active_cycle/v1',
    active: { lifecycle: 'running', cycle_key: 'orphan-cycle', venue: 'gate', plan_id: 'orphan-plan', plan_hash: 'f'.repeat(64), claim_token: 'cycle-only-token', claimed_at: '2030-01-07T12:00:00.000Z' }
  }), { mode: 0o600 })
  const wrong = await executor.handleRequest({ command: 'reconcile' })
  assert.equal(wrong.code, 'EXECUTOR_RECONCILE_ORPHANED')
  const recovered = await executor.handleRequest({ command: 'reconcile', claim_token: 'cycle-only-token' })
  assert.equal(recovered.outcome, 'RECONCILED')
  assert.equal(calls, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.directory, 'testnet_active_cycle.json'), 'utf8')).active.lifecycle, 'reconciled')
})

test('clock rollback disarms and remains fail-closed; credentials never enter response or log data', async () => {
  const paths = tempPaths('tyche-executor-clock-')
  let now = Date.parse('2030-01-07T12:00:00.000Z')
  const executor = createTestnetExecutor(executorOptions(paths, { now: () => now, client: {} }))
  await executor.handleRequest({ command: 'arm' })
  now -= 1
  const rollback = await executor.handleRequest({ command: 'status' })
  assert.equal(rollback.code, 'EXECUTOR_CLOCK_ROLLBACK')
  const credential = await executor.handleRequest({ command: 'arm', secret_key: 'never-return-this' })
  assert.doesNotMatch(JSON.stringify(credential), /never-return-this/)
  assert.doesNotMatch(fs.readFileSync(paths.statePath, 'utf8'), /never-return-this/)
})

test('executor redacts credential-shaped adapter errors before returning them', async () => {
  const { plan } = readyPlan()
  const paths = tempPaths('tyche-executor-error-redaction-')
  const executor = createTestnetExecutor(executorOptions(paths, {
    client: {},
    executeFn: async () => { throw new Error('api_key=secret-value secret: another-secret') }
  }))
  await executor.handleRequest({ command: 'arm' })
  await executor.registerPlan({ plan })
  const result = await executor.handleRequest({ command: 'execute', plan_ref: plan.plan_hash, confirm_hash: plan.plan_hash })
  assert.equal(result.code, 'EXECUTOR_EXECUTION_FAILED')
  assert.doesNotMatch(JSON.stringify(result), /secret-value|another-secret/)
  assert.doesNotMatch(fs.readFileSync(paths.statePath, 'utf8'), /secret-value|another-secret/)
})

test('zero-byte or corrupt safety ledgers fail closed and disarm', async () => {
  for (const [label, contents, code] of [
    ['zero', '', 'STATE_ZERO_LENGTH'],
    ['corrupt', '{not-json', 'STATE_JSON_CORRUPT']
  ]) {
    const paths = tempPaths(`tyche-executor-ledger-${label}-`)
    fs.writeFileSync(path.join(paths.directory, 'ledger.json'), contents, { mode: 0o600 })
    const executor = createTestnetExecutor(executorOptions(paths, { ledgerPath: path.join(paths.directory, 'ledger.json') }))
    const result = await executor.handleRequest({ command: 'arm' })
    assert.equal(result.code, code)
    assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).arm, null)
  }
})

test('Unix socket is 0600 and serves only the fixed command protocol', async () => {
  const paths = tempPaths('tyche-executor-socket-')
  const executor = createTestnetExecutor(executorOptions(paths))
  const server = createTestnetExecutorServer({ executor, socketPath: paths.socketPath })
  const running = await server.start()
  const mode = fs.statSync(paths.socketPath).mode & 0o777
  assert.equal(mode, 0o600)
  await assert.rejects(
    () => createTestnetExecutorServer({ executor: createTestnetExecutor(executorOptions(paths)), socketPath: paths.socketPath }).start(),
    { code: 'EXECUTOR_SOCKET_ACTIVE' }
  )
  assert.equal(fs.existsSync(paths.socketPath), true)
  const result = await requestExecutorSocket(paths.socketPath, { command: 'status' }, { testOnlyAllowUnsafePaths: true })
  assert.equal(result.outcome, 'STATUS')
  const raw = await new Promise((resolve, reject) => {
    const connection = net.createConnection(paths.socketPath)
    let text = ''
    connection.setEncoding('utf8')
    connection.on('error', reject)
    connection.on('data', (chunk) => { text += chunk; if (text.includes('\n')) { connection.destroy(); resolve(JSON.parse(text.trim())) } })
    connection.once('connect', () => connection.write('{"command":"status","path":"/not-accepted"}\n'))
  })
  assert.equal(raw.ok, false)
  assert.equal(raw.code, 'EXECUTOR_ROUTE_FIELD_FORBIDDEN')
  await running.close()
  assert.equal(fs.existsSync(paths.socketPath), false)
})

test('concurrent starts have one ownership winner and cannot unlink the active socket', async () => {
  const paths = tempPaths('tyche-executor-concurrent-socket-')
  const first = createTestnetExecutorServer({ executor: createTestnetExecutor(executorOptions(paths)), socketPath: paths.socketPath })
  const second = createTestnetExecutorServer({ executor: createTestnetExecutor(executorOptions(paths)), socketPath: paths.socketPath })
  const settled = await Promise.allSettled([first.start(), second.start()])
  assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1)
  assert.equal(settled.filter((entry) => entry.status === 'rejected').length, 1)
  const winner = settled.find((entry) => entry.status === 'fulfilled')?.value
  assert.ok(winner)
  assert.equal(fs.existsSync(paths.socketPath), true)
  await winner.close()
})

test('socket client has a bounded timeout and rejects oversized or multi-frame responses', async () => {
  const cases = [
    ['timeout', (connection) => connection.on('data', () => {}), 'EXECUTOR_SOCKET_TIMEOUT', { timeoutMs: 25 }],
    ['oversized', (connection) => connection.once('data', () => connection.write(`${'x'.repeat(EXECUTOR_MAX_FRAME_BYTES + 1)}\n`)), 'EXECUTOR_SOCKET_FRAME_TOO_LARGE'],
    ['multiple', (connection) => connection.once('data', () => connection.write('{"ok":true}\n{"ok":true}\n')), 'EXECUTOR_SOCKET_MULTIPLE_FRAMES']
  ]
  for (const [label, respond, expected, options = {}] of cases) {
    const paths = tempPaths(`tyche-executor-client-${label}-`)
    const fake = net.createServer((connection) => respond(connection))
    await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(paths.socketPath, resolve) })
    try {
      const result = await requestExecutorSocket(paths.socketPath, { command: 'status' }, { testOnlyAllowUnsafePaths: true, ...options })
      assert.equal(result.code, expected)
      assert.equal(result.ok, false)
    } finally {
      await new Promise((resolve) => fake.close(resolve))
    }
  }
  await assert.rejects(
    () => requestExecutorSocket(tempPaths('tyche-executor-client-cap-').socketPath, { command: 'status' }, { testOnlyAllowUnsafePaths: true, timeoutMs: EXECUTOR_SOCKET_TIMEOUT_MS + 1 }),
    { code: 'EXECUTOR_SOCKET_TIMEOUT_INVALID' }
  )
})
