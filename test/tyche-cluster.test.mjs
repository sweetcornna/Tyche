import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../scripts/config.mjs'
import {
  SESSION_API_KEY_ENV,
  SESSION_ENDPOINT_ENV,
  SESSION_PROVIDER_ID
} from '../packages/pi-agents/src/index.mjs'
import {
  CLUSTER_SCHEMA,
  LOOPBACK_HOST,
  STATIC_ROOT,
  createClusterStateStoreForTest,
  createTycheClusterService,
  hasSingleTestnetVenue,
  projectClusterEvent,
  resolveClusterConfigPath
} from '../scripts/tyche-cluster.mjs'
import { parseControlPlaneArgs, startControlPlaneChild } from '../scripts/tyche-control-plane.mjs'

const DATE = '2030-01-07'
const WEEK = '2030-W02'
const PLAN_HASH = 'a'.repeat(64)
const CYCLE_HASH = 'b'.repeat(64)
const CONFIG = loadConfig()
const SESSION_MODEL = ['gpt', '5', '6', 'luna'].join('-').replace('-5-6-', '-5.6-')

function slot(kind = 'daily', key = `${kind}:${DATE}T04:10:00.000Z`) {
  return { kind, key, date: DATE, iso_week: WEEK, start_at: `${DATE}T04:10:00.000Z`, end_at: `${DATE}T04:25:00.000Z` }
}

function memoryStateStore() {
  let value = null
  return {
    read: async () => value ? structuredClone(value) : null,
    write: async (next) => { value = structuredClone(next); return value },
    get value() { return value }
  }
}

function fakeSchedulerFactory(calls, { invokeOnTick = false } = {}) {
  return (options) => {
    const scheduler = {
      starts: 0,
      ticks: 0,
      stops: 0,
      running: false,
      start(interval) { this.starts += 1; this.interval = interval; this.running = true; return { ok: true, running: true } },
      stop() { this.stops += 1; this.running = false; return { ok: true, running: false } },
      async tick() {
        this.ticks += 1
        if (invokeOnTick && this.ticks === 1) await options.onSlot(slot('daily'), { settlement_required: true, new_entries_allowed: true })
        return { ok: true, triggered: [] }
      },
      async readState() { return { slots: {} } }
    }
    calls.push({ options, scheduler })
    return scheduler
  }
}

function fakeCycle(date = DATE, isoWeek = WEEK, outcome = 'PAPER_APPLIED') {
  return {
    schema: 'tyche_pi_automation_cycle/v1',
    date,
    iso_week: isoWeek,
    outcome,
    phase: outcome === 'BLOCKED' ? 'BLOCKED' : 'COMPLETE',
    automation_cycle: {
      schema: 'tyche_automation_cycle/v2',
      cycle_hash: CYCLE_HASH,
      date,
      iso_week: isoWeek,
      outcome,
      phase: outcome === 'BLOCKED' ? 'BLOCKED' : 'COMPLETE',
      products: [{ product: 'usdm', plan_hash: PLAN_HASH }],
      simulated_filled_contracts: '0',
      reused: false,
      submitted: 0,
      filled: 0
    },
    pi_provenance: {
      schema: 'tyche_pi_provenance/v1',
      runs: [{
        tier: 'daily',
        action: 'refreshed',
        provenance: { attempts: [{ role: 'orchestrator', status: 'ok' }, { role: 'reviewer', status: 'ok' }] }
      }],
      errors: []
    },
    submitted: 0,
    filled: 0
  }
}

function fakeWeekly(outcome = 'WEEKLY_REFRESHED') {
  return {
    schema: 'tyche_pi_weekly_refresh/v1',
    date: DATE,
    iso_week: WEEK,
    outcome,
    phase: outcome === 'BLOCKED' ? 'BLOCKED' : 'COMPLETE',
    weekly: { action: outcome === 'BLOCKED' ? 'failed' : 'refreshed', document_hash: PLAN_HASH },
    pi_provenance: {
      runs: [{
        tier: 'weekly',
        action: outcome === 'BLOCKED' ? 'refresh_failed' : 'refreshed',
        provenance: { attempts: [{ role: 'orchestrator', status: 'ok' }, { role: 'reviewer', status: 'ok' }] }
      }]
    },
    submitted: 0,
    filled: 0
  }
}

function noChild() {
  return async () => ({ child: { async stop() {} }, info: { host: LOOPBACK_HOST, port: 9911 } })
}

test('cluster validates fixed paths, required model/provider, and one explicit venue', () => {
  assert.throws(() => createTycheClusterService({ provider: 'fixture', model: '' }), { code: 'CLUSTER_MODEL_REQUIRED' })
  assert.throws(() => createTycheClusterService({ provider: 'fixture', model: 'fixture', host: LOOPBACK_HOST }), { code: 'CLUSTER_PATH_OVERRIDE_FORBIDDEN' })
  assert.throws(() => resolveClusterConfigPath('/tmp/tyche.json'), { code: 'CLUSTER_CONFIG_PATH_INVALID' })
  assert.equal(hasSingleTestnetVenue(CONFIG, 'gate'), true)
  assert.equal(hasSingleTestnetVenue(CONFIG, null), false)
  const both = structuredClone(CONFIG)
  both.binance.enabled = true
  both.binance.submission_mode = 'automatic_testnet'
  both.binance.usdm.enabled = true
  both.binance.usdm.environment = 'testnet'
  assert.equal(hasSingleTestnetVenue(both, 'gate'), false)
})

test('control-plane child may start before provider setup but rejects an incomplete startup pair', async () => {
  const parsed = parseControlPlaneArgs(['node', 'tyche-control-plane.mjs', '--port', '0'])
  assert.equal(parsed.provider, null)
  assert.equal(parsed.model, null)
  assert.throws(
    () => parseControlPlaneArgs(['node', 'tyche-control-plane.mjs', '--provider', 'fixture']),
    { code: 'CONTROL_CHILD_PROVIDER_PAIR_REQUIRED' }
  )
  await assert.rejects(
    startControlPlaneChild({ model: 'fixture', port: 0, controlPlaneFactory() {} }),
    { code: 'CONTROL_CHILD_PROVIDER_PAIR_REQUIRED' }
  )
})

test('session provider validates without inference and powers only a primary manual paper cycle', async () => {
  const apiKey = 'sk-session-control-fixture'
  const endpoint = 'https://provider.example.invalid/v1'
  const endpointUrl = new URL(endpoint)
  const published = []
  const stateWrites = []
  const validationCalls = []
  const cycleSnapshots = []
  let controlOptions
  let ready = ''
  const originalWrite = process.stdout.write
  process.stdout.write = (chunk) => { ready += String(chunk); return true }
  let child
  try {
    child = await startControlPlaneChild({
      bootstrapToken: 'bootstrap-child-fixture',
      port: 0,
      env: { PATH: '/safe/bin', LANG: 'C', FINANCE_API_KEY: 'must-not-cross' },
      configPath: path.join(process.cwd(), 'config', 'tyche.json'),
      stateReader: () => ({ recent_cycle: null, dag: {}, paper: {} }),
      stateWriter: (patch) => { stateWrites.push(structuredClone(patch)); return patch },
      providerRuntimeFactory: async (input) => {
        validationCalls.push(input)
        assert.equal(input.apiKey, apiKey)
        assert.equal(input.endpoint, endpoint)
        assert.equal(input.modelId, SESSION_MODEL)
        return { model: {} }
      },
      runPiAutomation: async (input) => {
        cycleSnapshots.push({
          provider: input.provider,
          model: input.model,
          mode: input.mode,
          configPath: input.configPath,
          env: { ...input.env },
          sameEnv: input.env === input.workerEnv
        })
        input.onEvent({ role: 'btc-analyst', asset: 'BTC', attempt: 0, status: 'completed', secret: apiKey, endpoint })
        return {
          outcome: 'BLOCKED',
          phase: 'BLOCKED',
          date: DATE,
          iso_week: WEEK,
          blocked_stage: 'settlement',
          code: 'PAPER_LEDGER_MISSING',
          message: `Paper ledger is not initialized: key=${apiKey}; endpoint=${endpoint}; origin=${endpointUrl.origin}; host=${endpointUrl.hostname}`,
          submitted: 0,
          filled: 0
        }
      },
      controlPlaneFactory: (options) => {
        controlOptions = options
        return {
          async start() {
            options.onBootstrapToken('bootstrap-session-fixture')
            return { host: LOOPBACK_HOST, port: 9922 }
          },
          async stop() {},
          publish(event) { published.push(structuredClone(event)) }
        }
      }
    })
  } finally {
    process.stdout.write = originalWrite
  }
  assert.match(ready, /bootstrap-session-fixture/)
  assert.equal(controlOptions.staticRoot, STATIC_ROOT)

  const validationBuffer = Buffer.from(apiKey)
  const validation = await controlOptions.adapters.validateProviderConfig(Object.freeze({
    provider: SESSION_PROVIDER_ID,
    model: SESSION_MODEL,
    endpoint,
    apiKey: validationBuffer
  }))
  assert.deepEqual(validation, { ok: true })
  assert.equal(validationBuffer.toString('utf8'), apiKey)
  assert.equal(Object.hasOwn(validationCalls[0], 'apiKey'), false)
  assert.equal(Object.hasOwn(validationCalls[0], 'endpoint'), false)

  const runtimeBuffer = Buffer.from(apiKey)
  const result = await controlOptions.adapters.runCycle({ date: DATE, isoWeek: WEEK }, Object.freeze({
    provider: SESSION_PROVIDER_ID,
    model: SESSION_MODEL,
    endpoint,
    apiKey: runtimeBuffer
  }))
  assert.equal(cycleSnapshots.length, 1)
  assert.deepEqual(cycleSnapshots[0], {
    provider: SESSION_PROVIDER_ID,
    model: SESSION_MODEL,
    mode: 'primary',
    configPath: path.join(process.cwd(), 'config', 'tyche.json'),
    env: {
      PATH: '/safe/bin',
      LANG: 'C',
      [SESSION_API_KEY_ENV]: apiKey,
      [SESSION_ENDPOINT_ENV]: endpoint
    },
    sameEnv: true
  })
  assert.equal(result.blocked_stage, 'settlement')
  assert.equal(result.code, 'PAPER_LEDGER_MISSING')
  assert.match(result.message, /Paper ledger is not initialized/)
  assert.match(result.message, /session-secret-redacted/)
  assert.equal(result.submitted, 0)
  assert.equal(result.filled, 0)
  assert.equal(runtimeBuffer.toString('utf8'), apiKey)
  assert.equal(stateWrites.length, 1)
  assert.equal(published.some((event) => event.type === 'dag_role'), true)
  assert.equal(published.some((event) => event.type === 'cycle'), true)
  const serialized = JSON.stringify({ stateWrites, published, result })
  for (const secret of [apiKey, endpoint, endpointUrl.origin, endpointUrl.hostname]) assert.equal(serialized.includes(secret), false, secret)
  assert.doesNotMatch(serialized, /FINANCE_API_KEY|must-not-cross/)
  await child.plane.stop()
})

test('start performs immediate tick once, is idempotent, and stops gracefully', async () => {
  const state = memoryStateStore()
  const schedulers = []
  let children = 0
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    mode: 'primary',
    testnetVenue: 'gate',
    env: {},
    stateStore: state,
    createScheduler: fakeSchedulerFactory(schedulers),
    spawnControlPlane: async () => { children += 1; return { child: { async stop() {} }, info: { host: LOOPBACK_HOST, port: 9912 } } },
    runPiAutomation: async () => fakeCycle(),
    runPiWeeklyRefresh: async () => fakeWeekly()
  })
  const first = await service.start()
  const second = await service.start()
  assert.equal(first.running, true)
  assert.equal(second.already_running, true)
  assert.equal(children, 1)
  assert.equal(schedulers.length, 1)
  assert.equal(schedulers[0].scheduler.starts, 1)
  assert.equal(schedulers[0].scheduler.ticks, 1)
  await service.stop()
  assert.equal(service.running, false)
  assert.equal(schedulers[0].scheduler.stops, 1)
  assert.equal(state.value.schema, CLUSTER_SCHEMA)
  assert.equal(state.value.control_plane.status, 'stopped')
})

test('bootstrap ready token is captured once for parent stderr and never enters public projections', async () => {
  const token = 'bootstrap-token-fixture'
  let childReady = ''
  let childOptions
  const originalStdoutWrite = process.stdout.write
  process.stdout.write = (chunk) => { childReady += String(chunk); return true }
  let childService
  try {
    childService = await startControlPlaneChild({
      provider: 'fixture',
      model: 'fixture',
      mode: 'shadow',
      port: 0,
      bootstrapToken: token,
      configPath: path.join(process.cwd(), 'config', 'tyche.json'),
      controlPlaneFactory: (options) => {
        childOptions = options
        return {
          async start() {
            options.onBootstrapToken(options.bootstrapToken)
            return { host: LOOPBACK_HOST, port: 9920 }
          },
          async stop() {},
          publish() {}
        }
      }
    })
  } finally {
    process.stdout.write = originalStdoutWrite
  }
  assert.match(childReady, /bootstrap-token-fixture/)
  assert.equal(Object.hasOwn(childService, 'workerEnv'), false)
  assert.equal(Object.hasOwn(childService, 'bootstrapToken'), false)
  assert.equal(childOptions.staticRoot, STATIC_ROOT)
  assert.equal(childOptions.bootstrapToken, token)
  await childService.plane.stop()

  const state = memoryStateStore()
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    env: {},
    stateStore: state,
    createScheduler: fakeSchedulerFactory([]),
    spawnControlPlane: async () => ({ child: { async stop() {} }, info: { host: LOOPBACK_HOST, port: 9921, bootstrapToken: token } }),
    runPiAutomation: async () => fakeCycle()
  })
  let stderr = ''
  const originalStderrWrite = process.stderr.write
  process.stderr.write = (chunk) => { stderr += String(chunk); return true }
  let startResult
  try {
    startResult = await service.start()
  } finally {
    process.stderr.write = originalStderrWrite
  }
  assert.equal((stderr.match(/bootstrap_token=/g) || []).length, 1)
  assert.match(stderr, /bootstrap_token=bootstrap-token-fixture/)
  assert.doesNotMatch(JSON.stringify(startResult), /bootstrap-token-fixture/)
  assert.doesNotMatch(JSON.stringify(state.value), /bootstrap-token-fixture/)
  const projected = projectClusterEvent({ type: 'ready', data: { token, status: 'running' } })
  assert.doesNotMatch(JSON.stringify(projected), /bootstrap-token-fixture/)
  const parentStdout = JSON.stringify({ ok: true, host: startResult.host, port: startResult.port })
  assert.doesNotMatch(parentStdout, /bootstrap-token-fixture/)
  await service.stop()
})

test('startup immediate tick routes the current slot instead of waiting for the interval', async () => {
  const state = memoryStateStore()
  const schedulers = []
  let daily = 0
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    env: {},
    stateStore: state,
    createScheduler: fakeSchedulerFactory(schedulers, { invokeOnTick: true }),
    spawnControlPlane: noChild(),
    runPiAutomation: async () => { daily += 1; return fakeCycle() }
  })
  await service.start()
  assert.equal(schedulers[0].scheduler.ticks, 1)
  assert.equal(daily, 1)
  await service.stop()
})

test('weekly and daily routing preserves settlement-first dependency blocking', async () => {
  const state = memoryStateStore()
  const schedulerCalls = []
  const dailyCalls = []
  const weeklyCalls = []
  let executorCalls = 0
  const singleVenueConfig = structuredClone(CONFIG)
  singleVenueConfig.gate.submission_mode = 'automatic_testnet'
  singleVenueConfig.gate.usdm.environment = 'testnet'
  singleVenueConfig.gate.usdm.configured_leverage = 2
  singleVenueConfig.gate.usdm.risk_per_trade_bps = 25
  singleVenueConfig.gate.usdm.max_order_notional_usdt = 100
  singleVenueConfig.gate.usdm.daily_new_notional_cap_usdt = 200
  singleVenueConfig.gate.usdm.max_managed_notional_usdt = 300
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    mode: 'primary',
    testnetVenue: 'gate',
    env: {},
    config: singleVenueConfig,
    stateStore: state,
    createScheduler: fakeSchedulerFactory(schedulerCalls),
    spawnControlPlane: noChild(),
    runPiWeeklyRefresh: async (input) => { weeklyCalls.push(input); return fakeWeekly() },
    runPiAutomation: async (input) => { dailyCalls.push(input); return fakeCycle() },
    executorRequest: async () => { executorCalls += 1; return { outcome: 'READY', plan_hash: PLAN_HASH, plan_summary: { plan_hash: PLAN_HASH } } }
  })
  await service.runSlot(slot('weekly', `weekly:${DATE}T00:05:00.000Z`), { settlement_required: true })
  await service.runSlot(slot('daily'), { settlement_required: true, new_entries_allowed: false })
  assert.equal(weeklyCalls.length, 1)
  assert.equal(dailyCalls.length, 1)
  assert.equal(dailyCalls[0].weeklyBlocked, true)
  assert.equal(executorCalls, 0)
  assert.equal(state.value.testnet.executed, false)
  assert.equal(state.value.recent_cycle.outcome, 'PAPER_APPLIED')
})

test('shadow never requests executor and manual runCycle never schedules execute', async () => {
  const state = memoryStateStore()
  const requests = []
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    mode: 'shadow',
    env: {},
    stateStore: state,
    createScheduler: fakeSchedulerFactory([]),
    spawnControlPlane: noChild(),
    runPiAutomation: async () => fakeCycle(),
    executorRequest: async (...args) => { requests.push(args); return { outcome: 'READY' } }
  })
  await service.runSlot(slot(), { new_entries_allowed: true })
  await service.runCycle({ date: DATE, isoWeek: WEEK })
  assert.equal(requests.length, 0)
  assert.equal(state.value.testnet.blocked, 'shadow_mode')
})

test('primary sends exactly plan then status then scheduled execute only when armed', async () => {
  const state = memoryStateStore()
  const requests = []
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    mode: 'primary',
    testnetVenue: 'gate',
    env: {},
    stateStore: state,
    createScheduler: fakeSchedulerFactory([]),
    spawnControlPlane: noChild(),
    runPiAutomation: async () => fakeCycle(),
    executorRequest: async (venue, request) => {
      requests.push({ venue, request })
      if (request.command === 'plan') return { ok: true, outcome: 'READY', plan_hash: PLAN_HASH, plan_summary: { plan_hash: PLAN_HASH } }
      if (request.command === 'status') return { ok: true, armed: true }
      return { ok: true, outcome: 'EXECUTED' }
    }
  })
  await service.runSlot(slot(), { new_entries_allowed: true })
  assert.deepEqual(requests.map((entry) => entry.request.command), ['plan', 'status', 'execute'])
  assert.equal(requests.every((entry) => entry.venue === 'gate'), true)
  assert.deepEqual(requests[0].request, { command: 'plan', date: DATE, iso_week: WEEK })
  assert.equal(requests[2].request.mode, 'scheduled')
  assert.equal(requests[2].request.slot_key, slot().key)
  assert.equal(state.value.testnet.executed, true)
  assert.equal(state.value.testnet.plan_hash, PLAN_HASH)
})

test('unarmed and RED executor outcomes stop without retry or venue failover', async () => {
  const state = memoryStateStore()
  const requests = []
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    mode: 'primary',
    testnetVenue: 'gate',
    env: {},
    stateStore: state,
    createScheduler: fakeSchedulerFactory([]),
    spawnControlPlane: noChild(),
    runPiAutomation: async () => fakeCycle(),
    executorRequest: async (venue, request) => {
      requests.push({ venue, request })
      if (request.command === 'plan') return { ok: true, outcome: 'RED', code: 'RED_STICKY' }
      return { ok: true, armed: true }
    }
  })
  await service.runSlot(slot(), { new_entries_allowed: true })
  assert.deepEqual(requests.map((entry) => entry.request.command), ['plan'])
  assert.equal(requests.every((entry) => entry.venue === 'gate'), true)
  assert.equal(state.value.testnet.executed, false)
  assert.equal(state.value.testnet.blocked, 'ambiguous_or_red')
})

test('primary unarmed plans only and state is an allowlisted summary', async () => {
  const state = memoryStateStore()
  const requests = []
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    mode: 'primary',
    testnetVenue: 'gate',
    env: {},
    stateStore: state,
    createScheduler: fakeSchedulerFactory([]),
    spawnControlPlane: noChild(),
    runPiAutomation: async () => fakeCycle(),
    executorRequest: async (venue, request) => {
      requests.push({ venue, request })
      if (request.command === 'plan') return { ok: true, outcome: 'READY', plan_hash: PLAN_HASH, plan_summary: { plan_hash: PLAN_HASH } }
      return { ok: true, armed: false }
    }
  })
  await service.runSlot(slot(), { new_entries_allowed: true })
  assert.deepEqual(requests.map((entry) => entry.request.command), ['plan', 'status'])
  assert.equal(state.value.testnet.executed, false)
  assert.equal(state.value.testnet.blocked, 'unarmed')
  const text = JSON.stringify(state.value)
  assert.doesNotMatch(text, /account|ledger|fills|credential|transcript|socket|path/i)
  assert.match(text, /plan_hash/)
})

test('role lifecycle events cross the narrow child IPC projection without model output', async () => {
  const state = memoryStateStore()
  const messages = []
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    env: {},
    stateStore: state,
    createScheduler: fakeSchedulerFactory([]),
    spawnControlPlane: async () => ({
      child: { connected: true, send(message) { messages.push(message) }, async stop() {} },
      info: { host: LOOPBACK_HOST, port: 9913 }
    }),
    runPiAutomation: async (input) => {
      input.onEvent?.({ role: 'btc-analyst', asset: 'BTC', attempt: 0, status: 'started', secret: 'must-not-cross' })
      return fakeCycle()
    }
  })
  await service.start()
  await service.runSlot(slot(), { new_entries_allowed: true })
  const role = messages.find((message) => message.event?.type === 'dag_role')
  assert.equal(role.event.data.role, 'btc-analyst')
  assert.equal(role.event.data.asset, 'BTC')
  assert.equal(role.event.data.attempt, 0)
  assert.doesNotMatch(JSON.stringify(messages), /secret|must-not-cross/i)
  await service.stop()
})

test('manual runCycle publishes projected role and cycle events but never calls the executor', async () => {
  const state = memoryStateStore()
  const messages = []
  let executorCalls = 0
  const service = createTycheClusterService({
    provider: 'fixture',
    model: 'fixture',
    mode: 'shadow',
    env: {},
    stateStore: state,
    createScheduler: fakeSchedulerFactory([]),
    spawnControlPlane: async () => ({
      child: { connected: true, send(message) { messages.push(message) }, async stop() {} },
      info: { host: LOOPBACK_HOST, port: 9914 }
    }),
    runPiAutomation: async (input) => {
      input.onEvent?.({ role: 'reviewer', attempt: 0, status: 'completed', output: 'must-not-cross', secret: 'must-not-cross' })
      return fakeCycle()
    },
    executorRequest: async () => { executorCalls += 1; return { ok: true, outcome: 'EXECUTED' } }
  })
  await service.start()
  await service.runCycle({ date: DATE, isoWeek: WEEK })
  assert.deepEqual(messages.map((message) => message.event?.type), ['dag_role', 'cycle'])
  assert.equal(messages[0].event.data.role, 'reviewer')
  assert.equal(messages[1].event.data.outcome, 'PAPER_APPLIED')
  assert.equal(executorCalls, 0)
  assert.doesNotMatch(JSON.stringify(messages), /must-not-cross|secret/i)
  await service.stop()
})

test('missing cluster state may default, but corrupt state is fail-closed and never overwritten', async () => {
  const runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tyche-cluster-state-'))
  const statePath = path.join(runtime, 'tyche-cluster.json')
  const store = createClusterStateStoreForTest(statePath)
  try {
    fs.writeFileSync(statePath, '{not-json', { mode: 0o600 })
    assert.throws(() => store.read(), { code: 'STATE_JSON_CORRUPT' })
    assert.throws(() => store.write({ status: 'running' }), { code: 'STATE_JSON_CORRUPT' })
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{not-json')
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true })
  }
})
