import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import WebSocket from 'ws'
import { createPaperSetupAdapter } from '../../../scripts/control-paper-setup.mjs'
import { loadConfig } from '../../../scripts/config.mjs'
import { writeJsonAtomic } from '../../../scripts/lib-iolock.mjs'
import {
  ARM_CONFIRMATIONS,
  LOOPBACK_HOST,
  SESSION_TTL_MS,
  MAX_WS_EVENT_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  PROVIDER,
  PROVIDER_MODELS,
  projectSafe,
  createControlPlane
} from '../src/control-plane.mjs'

const DATE = '2030-01-07'
const WEEK = '2030-W02'
const PROVIDER_KEY = 'sk-session-provider-secret-value'
const PROVIDER_ENDPOINT = 'https://models.example.test/v1/'
const PROVIDER_BODY = Object.freeze({
  provider: PROVIDER,
  model: PROVIDER_MODELS[0],
  endpoint: PROVIDER_ENDPOINT,
  api_key: PROVIDER_KEY
})

function httpRequest(info, requestPath, options = {}) {
  const method = options.method || 'GET'
  const body = options.body === undefined ? null : JSON.stringify(options.body)
  const headers = {
    Host: `${info.host}:${info.port}`,
    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
    ...(body === null ? {} : { 'Content-Length': Buffer.byteLength(body) }),
    ...(options.origin === undefined ? { Origin: info.origin } : { Origin: options.origin }),
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}),
    ...(options.headers || {})
  }
  return new Promise((resolve, reject) => {
    const request = http.request({ host: info.host, port: info.port, path: requestPath, method, headers }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => {
        let json = null
        try { json = text ? JSON.parse(text) : null } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, json })
      })
    })
    request.on('error', reject)
    if (body !== null) request.write(body)
    request.end()
  })
}

function makeService(overrides = {}) {
  const calls = []
  const service = createControlPlane({
    port: 0,
    executorSockets: { gate: '/tmp/tyche-control-gate.sock', binance: '/tmp/tyche-control-binance.sock' },
    adapters: {
      status: async () => ({
        ready: true,
        credentials: 'drop',
        plan_id: 'safe-plan-id',
        plan_hash: 'safe-plan-hash',
        plan_summary: { plan_id: 'safe-plan-id', plan_hash: 'safe-plan-hash', sealed: true },
        plan: { intents: [{ symbol: 'BTC_USDT' }], proofs: { sealed: true }, risk_policy: { max: 'private' } }
      }),
      cycle: async () => ({ status: 'idle' }),
      dag: async () => ({ roles: ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer'] }),
      paper: async () => ({ status: 'paper-only', ledger: { fills: ['drop'] }, summary: { simulated: 0 } }),
      paperSetupStatus: async () => ({ ready: true, status: 'ready', values: {}, missing: [] }),
      validateProviderConfig: async () => ({ ok: true }),
      runCycle: async (input) => ({ status: 'accepted', input }),
      ...(overrides.adapters || {})
    },
    executorRequest: async (venue, request) => {
      calls.push({ venue, request })
      if (request.command === 'plan') return {
        ok: true,
        venue,
        outcome: 'PLAN_READY',
        plan_summary: {
          plan_id: 'safe-plan-id', plan_hash: 'safe-plan-hash', venue, product: 'usdm', environment: 'testnet',
          created_at: '2030-01-07T12:00:00.000Z', expires_at: '2030-01-08T12:00:00.000Z', sealed: true,
          intents: [
            { symbol: 'BTC_USDT', side: 'long', action: 'ENTER_LONG', size: 'semantic-size', notional: 'semantic-notional', protection: { stop: 'present', target: 'present' } },
            { symbol: 'ETH_USDT', side: 'short', action: 'ENTER_SHORT', size: 'semantic-size-2', notional: 'semantic-notional-2', protection: { stop: 'present-2', target: 'present-2' } }
          ],
          risk_policy: { label: 'bounded' }, risk_policy_digest: 'risk-digest', blockers: []
        },
        account: { balance: 'drop' }, headers: { authorization: 'drop' }
      }
      return { ok: true, venue, outcome: request.command, plan_hash: 'safe-plan-hash', account: { balance: 'drop' }, headers: { authorization: 'drop' } }
    },
    ...overrides,
    ...(overrides.adapters ? { adapters: { paperSetupStatus: async () => ({ ready: true, status: 'ready', values: {}, missing: [] }), ...overrides.adapters } } : {})
  })
  return { service, calls }
}

async function openSession(info) {
  const response = await httpRequest(info, '/api/session', { method: 'POST', body: { bootstrap_token: info.bootstrapToken } })
  assert.equal(response.status, 200)
  assert.match(response.headers['set-cookie'][0], /HttpOnly/)
  assert.match(response.headers['set-cookie'][0], /SameSite=Strict/)
  assert.doesNotMatch(response.headers['set-cookie'][0], /Secure/)
  return { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.json.csrf_token }
}

async function configureProvider(info, session, body = PROVIDER_BODY) {
  return httpRequest(info, '/api/provider', { method: 'POST', body, ...session })
}

async function startService(overrides = {}) {
  const created = makeService(overrides)
  const info = await created.service.start()
  return { ...created, info }
}

test('control plane only binds the exact loopback host', () => {
  assert.throws(() => createControlPlane({ host: '0.0.0.0' }), (error) => error.code === 'CONTROL_BIND_FORBIDDEN')
  assert.throws(() => createControlPlane({ host: 'localhost' }), (error) => error.code === 'CONTROL_BIND_FORBIDDEN')
})

test('control-plane CLI rejects unknown, duplicate, and missing flags', () => {
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/cli.mjs')
  for (const args of [['--unknown', 'x'], ['--port', '8788', '--port', '8789'], ['--port']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /CONTROL_CLI_(?:UNKNOWN_ARGUMENT|DUPLICATE_ARGUMENT|ARGUMENT_VALUE_REQUIRED)/)
  }
})

test('Host, Origin, and forwarded headers are strict', async () => {
  const { service, info } = await startService()
  try {
    const badHost = await httpRequest(info, '/api/health', { headers: { Host: 'localhost' }, origin: info.origin })
    assert.equal(badHost.status, 403)
    const forwarded = await httpRequest(info, '/api/health', { headers: { 'X-Forwarded-Host': 'evil' }, origin: info.origin })
    assert.equal(forwarded.status, 403)
    const badOrigin = await httpRequest(info, '/api/session', { method: 'POST', body: { bootstrap_token: info.bootstrapToken }, origin: 'https://evil.example' })
    assert.equal(badOrigin.status, 403)
  } finally {
    await service.stop()
  }
})

test('bootstrap is one-use and session cookie/CSRF expire', async () => {
  let clock = Date.parse('2030-01-07T00:00:00.000Z')
  const { service, info } = await startService({ now: () => clock })
  try {
    const first = await openSession(info)
    const second = await httpRequest(info, '/api/session', { method: 'POST', body: { bootstrap_token: info.bootstrapToken } })
    assert.equal(second.status, 401)
    const noSession = await httpRequest(info, '/api/status')
    assert.equal(noSession.status, 401)
    const live = await httpRequest(info, '/api/status', { cookie: first.cookie })
    assert.equal(live.status, 200)
    clock += SESSION_TTL_MS
    const expired = await httpRequest(info, '/api/status', { cookie: first.cookie })
    assert.equal(expired.status, 401)
  } finally {
    await service.stop()
  }
})

test('mutations require exact Origin, cookie, and CSRF; logout revokes session', async () => {
  const { service, info } = await startService()
  try {
    const session = await openSession(info)
    const noCsrf = await httpRequest(info, '/api/executor/arm', { method: 'POST', body: { venue: 'gate', confirmation: ARM_CONFIRMATIONS.gate }, cookie: session.cookie })
    assert.equal(noCsrf.status, 403)
    const wrongOrigin = await httpRequest(info, '/api/executor/arm', { method: 'POST', body: { venue: 'gate', confirmation: ARM_CONFIRMATIONS.gate }, cookie: session.cookie, csrf: session.csrf, origin: 'http://127.0.0.1:1' })
    assert.equal(wrongOrigin.status, 403)
    const logout = await httpRequest(info, '/api/logout', { method: 'POST', body: {}, cookie: session.cookie, csrf: session.csrf })
    assert.equal(logout.status, 200)
    const revoked = await httpRequest(info, '/api/status', { cookie: session.cookie })
    assert.equal(revoked.status, 401)
  } finally {
    await service.stop()
  }
})

test('fixed API bodies enforce arm confirmation, plan hash confirmation, and socket ownership', async () => {
  const { service, info, calls } = await startService()
  try {
    const session = await openSession(info)
    const extra = await httpRequest(info, '/api/executor/arm', { method: 'POST', body: { venue: 'gate', confirmation: ARM_CONFIRMATIONS.gate, path: '/tmp/evil' }, ...session })
    assert.equal(extra.status, 400)
    const wrongArm = await httpRequest(info, '/api/executor/arm', { method: 'POST', body: { venue: 'gate', confirmation: 'ARM TESTNET GATE' }, ...session })
    assert.equal(wrongArm.status, 403)
    const armed = await httpRequest(info, '/api/executor/arm', { method: 'POST', body: { venue: 'gate', confirmation: ARM_CONFIRMATIONS.gate }, ...session })
    assert.equal(armed.status, 200)
    const plan = await httpRequest(info, '/api/executor/plan', { method: 'POST', body: { venue: 'gate', date: DATE, iso_week: WEEK }, ...session })
    assert.equal(plan.status, 200)
    assert.equal(plan.json.plan_summary.intents.length, 2)
    assert.equal(plan.json.plan_summary.intents[0].symbol, 'BTC_USDT')
    assert.equal(plan.json.plan_summary.intents[1].protection.target, 'present-2')
    assert.equal(plan.json.plan_summary.risk_policy_digest, 'risk-digest')
    assert.deepEqual(Object.keys(plan.json.plan_summary).sort(), ['blockers', 'created_at', 'environment', 'expires_at', 'intents', 'plan_hash', 'plan_id', 'product', 'risk_policy', 'risk_policy_digest', 'sealed', 'venue'].sort())
    const wrongHash = await httpRequest(info, '/api/executor/execute', { method: 'POST', body: { venue: 'gate', plan_hash: 'safe-plan-hash', confirmation: 'different' }, ...session })
    assert.equal(wrongHash.status, 403)
    const executed = await httpRequest(info, '/api/executor/execute', { method: 'POST', body: { venue: 'gate', plan_hash: 'safe-plan-hash', confirmation: 'safe-plan-hash' }, ...session })
    assert.equal(executed.status, 200)
    const scheduled = await httpRequest(info, '/api/executor/execute', { method: 'POST', body: { venue: 'gate', plan_hash: 'safe-plan-hash', confirmation: 'safe-plan-hash', mode: 'scheduled' }, ...session })
    assert.equal(scheduled.status, 400)
    const invalidVenue = await httpRequest(info, '/api/executor/status?venue=../../evil', { ...session })
    assert.equal(invalidVenue.status, 400)
    assert.deepEqual(calls.map((call) => call.request.command), ['arm', 'plan', 'execute'])
    assert.equal(Object.hasOwn(calls[1].request, 'path'), false)
    assert.equal(Object.hasOwn(calls[1].request, 'host'), false)
    assert.equal(Object.hasOwn(calls[1].request, 'method'), false)
  } finally {
    await service.stop()
  }
})

test('status and testnet normalize latest plan summaries into the safe DTO', async () => {
  const latest = (venue) => ({
    plan_id: `latest-${venue}-id`,
    plan_hash: `latest-${venue}-hash`,
    venue,
    product: 'usdm',
    environment: 'testnet',
    created_at: '2030-01-07T12:00:00.000Z',
    expires_at: '2030-01-08T12:00:00.000Z',
    sealed: true,
    blockers: ['none'],
    intents: [
      { symbol: 'BTC_USDT', side: 'long', action: 'ENTER_LONG', size: '1', notional: '100', quantity: 'drop', protection: { stop: '90', target: '120' } },
      { symbol: 'ETH_USDT', side: 'short', action: 'ENTER_SHORT', size: '2', notional: '200', protection: { stop: '210', target: '160' } }
    ],
    risk_policy: { label: 'bounded', proofs: { sealed: true } },
    risk_policy_digest: `digest-${venue}`
  })
  const { service, info } = await startService({
    executorRequest: async (venue, request) => request.command === 'status'
      ? { ok: true, latest_plan_summary: latest(venue), plan: { proofs: { sealed: true }, account: { balance: 'drop' }, ledger: { fills: ['drop'] } } }
      : { ok: true }
  })
  try {
    const session = await openSession(info)
    const status = await httpRequest(info, '/api/executor/status?venue=gate', { cookie: session.cookie })
    assert.equal(status.status, 200)
    assert.equal(status.json.plan_summary.plan_id, 'latest-gate-id')
    assert.equal(status.json.plan_summary.intents.length, 2)
    assert.equal(status.json.plan_summary.risk_policy_digest, 'digest-gate')
    assert.equal(status.json.latest_plan_summary, undefined)
    assert.doesNotMatch(status.text, /proofs|account|ledger|fills|quantity/)

    const all = await httpRequest(info, '/api/testnet', { cookie: session.cookie })
    assert.equal(all.status, 200)
    assert.equal(all.json.gate.plan_summary.intents.length, 2)
    assert.equal(all.json.binance.plan_summary.intents[1].symbol, 'ETH_USDT')
    assert.equal(all.json.binance.plan_summary.risk_policy.label, 'bounded')
    assert.equal(all.json.gate.latest_plan_summary, undefined)
  } finally {
    await service.stop()
  }
})

test('safe projections remove nested credentials, private state, routes, and raw plans', async () => {
  const { service, info } = await startService()
  try {
    const session = await openSession(info)
    const response = await httpRequest(info, '/api/status', { cookie: session.cookie })
    const text = response.text
    assert.equal(response.status, 200)
    assert.match(text, /safe-plan-hash/)
    assert.match(text, /safe-plan-id/)
    assert.match(text, /plan_summary/)
    assert.doesNotMatch(text, /intents|proofs|risk_policy/)
    for (const secret of ['credentials', 'authorization', 'account', 'ledger', 'fills', 'headers', 'path']) assert.doesNotMatch(text, new RegExp(`"${secret}"`, 'i'), secret)
  } finally {
    await service.stop()
  }
})

test('safe projection rejects normalized sensitive and route fields while retaining safe plan hash', () => {
  const projected = projectSafe({
    plan_id: 'safe-plan-id',
    plan_hash: 'safe-plan-hash',
    plan_summary: { plan_id: 'safe-plan-id', plan_hash: 'safe-plan-hash' },
    plan: { intents: [{ symbol: 'BTC_USDT' }], proofs: { sealed: true }, risk_policy: { max: 'private' } },
    position_intent: 'drop',
    nested: {
      result_path: '/absolute/private/result.json',
      plan_path: '/absolute/private/plan.json',
      open_orders: [{ order_id: 'drop' }],
      account_epoch: 'drop',
      socket_path: '/absolute/private/executor.sock',
      authorization_header: 'drop',
      credential_token: 'drop',
      safe_status: 'ready'
    }
  })
  assert.deepEqual(projected, {
    plan_id: 'safe-plan-id',
    plan_hash: 'safe-plan-hash',
    plan_summary: { plan_id: 'safe-plan-id', plan_hash: 'safe-plan-hash' },
    nested: { safe_status: 'ready' }
  })
})

test('external adapter and socket errors use fixed messages without path disclosure', async () => {
  const privateRoot = ['', 'Users', 'private'].join('/')
  const adapter = await startService({ adapters: { status: async () => { throw new Error(`${privateRoot}/secret/model.json`) } } })
  try {
    const session = await openSession(adapter.info)
    const response = await httpRequest(adapter.info, '/api/status', { cookie: session.cookie })
    assert.equal(response.status, 200)
    assert.equal(response.json.code, 'CONTROL_INTERNAL_ERROR')
    assert.equal(response.json.message, 'status unavailable')
    assert.doesNotMatch(response.text, /secret\/model\.json/)
  } finally {
    await adapter.service.stop()
  }

  const socket = await startService({
    executorRequest: null,
    executorSockets: { gate: `${privateRoot}/gate-executor.sock`, binance: `${privateRoot}/binance-executor.sock` }
  })
  try {
    const session = await openSession(socket.info)
    const response = await httpRequest(socket.info, '/api/testnet', { cookie: session.cookie })
    assert.equal(response.status, 200)
    assert.doesNotMatch(response.text, /(?:gate|binance)-executor\.sock/)
    assert.equal(response.json.gate.message, 'Executor socket is unavailable')
    assert.equal(response.json.binance.message, 'Executor socket is unavailable')
  } finally {
    await socket.service.stop()
  }
})

test('provider routes require a session and CSRF and return only the explicit safe DTO', async () => {
  let validationRuntime
  const { service, info } = await startService({
    adapters: {
      validateProviderConfig: async (runtime) => {
        validationRuntime = runtime
        assert.equal(runtime.provider, PROVIDER)
        assert.equal(runtime.model, PROVIDER_MODELS[0])
        assert.equal(runtime.endpoint, PROVIDER_ENDPOINT)
        assert.equal(runtime.apiKey.toString('utf8'), PROVIDER_KEY)
        return { ok: true, api_key: PROVIDER_KEY }
      }
    }
  })
  try {
    const unauthenticated = await httpRequest(info, '/api/provider')
    assert.equal(unauthenticated.status, 401)
    const session = await openSession(info)
    const noCsrf = await httpRequest(info, '/api/provider', { method: 'POST', body: PROVIDER_BODY, cookie: session.cookie })
    assert.equal(noCsrf.status, 403)
    for (const [field, value] of [['gate_api_key', 'forbidden'], ['route', '/v1/orders'], ['method', 'POST'], ['socket_path', '/tmp/forbidden.sock'], ['path', '/private']]) {
      assert.equal((await configureProvider(info, session, { ...PROVIDER_BODY, [field]: value })).status, 400)
    }
    const nested = await configureProvider(info, session, { ...PROVIDER_BODY, endpoint: { url: PROVIDER_ENDPOINT, method: 'POST' } })
    assert.equal(nested.status, 400)

    const configured = await configureProvider(info, session)
    assert.equal(configured.status, 200)
    assert.deepEqual(configured.json, {
      configured: true,
      provider: PROVIDER,
      model: PROVIDER_MODELS[0],
      endpoint: PROVIDER_ENDPOINT,
      scope: 'session',
      manual_cycle_only: true
    })
    assert.deepEqual([...validationRuntime.apiKey], Array(validationRuntime.apiKey.length).fill(0))
    assert.doesNotMatch(configured.text, new RegExp(PROVIDER_KEY))

    const fetched = await httpRequest(info, '/api/provider', { cookie: session.cookie })
    assert.deepEqual(fetched.json, configured.json)
    assert.doesNotMatch(fetched.text, /api_key|apiKey|secret/i)
    const unsafeClear = await httpRequest(info, '/api/provider/clear', { method: 'POST', body: { path: '/tmp/forbidden' }, ...session })
    assert.equal(unsafeClear.status, 400)
    assert.equal((await httpRequest(info, '/api/provider', { cookie: session.cookie })).json.configured, true)
  } finally {
    await service.stop()
  }
})

test('provider validation rejects unsupported values, unsafe URLs, and failed or absent validation adapters', async () => {
  const { service, info } = await startService()
  try {
    const session = await openSession(info)
    const cases = [
      { ...PROVIDER_BODY, provider: 'openai' },
      { ...PROVIDER_BODY, model: 'not-allowed-model' },
      { ...PROVIDER_BODY, endpoint: 'ftp://models.example.test/v1' },
      { ...PROVIDER_BODY, endpoint: 'https://user:pass@models.example.test/v1' },
      { ...PROVIDER_BODY, endpoint: 'https://models.example.test/v1?key=value' },
      { ...PROVIDER_BODY, endpoint: 'https://models.example.test/v1#fragment' },
      { ...PROVIDER_BODY, endpoint: `https://models.example.test/${'a'.repeat(2048)}` },
      { ...PROVIDER_BODY, api_key: '' },
      { ...PROVIDER_BODY, api_key: 'a'.repeat(8193) }
    ]
    for (const body of cases) assert.equal((await configureProvider(info, session, body)).status, 400)
    assert.deepEqual((await httpRequest(info, '/api/provider', { cookie: session.cookie })).json, {
      configured: false, provider: null, model: null, endpoint: null, scope: 'session', manual_cycle_only: true
    })
  } finally {
    await service.stop()
  }

  for (const validateProviderConfig of [undefined, async () => ({ ok: false })]) {
    const rejected = await startService({ adapters: { validateProviderConfig } })
    try {
      const session = await openSession(rejected.info)
      const response = await configureProvider(rejected.info, session)
      assert.equal(response.status, validateProviderConfig ? 400 : 503)
      assert.doesNotMatch(response.text, new RegExp(PROVIDER_KEY))
    } finally {
      await rejected.service.stop()
    }
  }
})

test('provider key buffers are zeroed on replace, clear, logout, expiry, and server stop', async () => {
  const cleared = []
  const validationBuffers = []
  const makeOverrides = (extra = {}) => ({
    sessionSweepMs: 10,
    onProviderCleared: (event) => cleared.push(event),
    adapters: {
      validateProviderConfig: async (runtime) => {
        validationBuffers.push(runtime.apiKey)
        return true
      }
    },
    ...extra
  })
  const allZero = (buffer) => buffer.every((byte) => byte === 0)

  const first = await startService(makeOverrides())
  try {
    const session = await openSession(first.info)
    assert.equal((await configureProvider(first.info, session)).status, 200)
    assert.equal((await configureProvider(first.info, session, { ...PROVIDER_BODY, model: PROVIDER_MODELS[1], api_key: 'replacement-provider-key' })).status, 200)
    assert.equal(cleared.at(-1).reason, 'replaced')
    assert.equal(allZero(cleared.at(-1).keyBuffer), true)
    const clear = await httpRequest(first.info, '/api/provider/clear', { method: 'POST', body: {}, ...session })
    assert.equal(clear.status, 200)
    assert.equal(clear.json.configured, false)
    assert.equal(cleared.at(-1).reason, 'cleared')
    assert.equal(allZero(cleared.at(-1).keyBuffer), true)
    assert.equal((await configureProvider(first.info, session)).status, 200)
    assert.equal((await httpRequest(first.info, '/api/logout', { method: 'POST', body: {}, ...session })).status, 200)
    assert.equal(cleared.at(-1).reason, 'logout')
    assert.equal(allZero(cleared.at(-1).keyBuffer), true)
  } finally {
    await first.service.stop()
  }

  let clock = Date.parse('2030-01-07T00:00:00.000Z')
  const expiring = await startService(makeOverrides({ now: () => clock }))
  try {
    const session = await openSession(expiring.info)
    assert.equal((await configureProvider(expiring.info, session)).status, 200)
    clock += SESSION_TTL_MS
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(cleared.at(-1).reason, 'expired')
    assert.equal(allZero(cleared.at(-1).keyBuffer), true)
  } finally {
    await expiring.service.stop()
  }

  const stopping = await startService(makeOverrides())
  const stopSession = await openSession(stopping.info)
  assert.equal((await configureProvider(stopping.info, stopSession)).status, 200)
  await stopping.service.stop()
  assert.equal(cleared.at(-1).reason, 'server_stop')
  assert.equal(allZero(cleared.at(-1).keyBuffer), true)
  assert.equal(validationBuffers.every(allZero), true)
})

test('manual cycle receives a one-use provider snapshot, blocks provider mutation while busy, and redacts secrets', async () => {
  let releaseCycle
  let runtime
  let startedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  const { service, info } = await startService({
    adapters: {
      validateProviderConfig: async () => true,
      runCycle: async (input, receivedRuntime) => {
        runtime = receivedRuntime
        startedResolve()
        await new Promise((resolve) => { releaseCycle = resolve })
        return {
          status: 'accepted',
          input,
          message: `used ${receivedRuntime.apiKey.toString('utf8')} at ${receivedRuntime.endpoint}`,
          opaque: Buffer.from(receivedRuntime.apiKey)
        }
      }
    }
  })
  try {
    const session = await openSession(info)
    assert.equal((await configureProvider(info, session)).status, 200)
    const runPromise = httpRequest(info, '/api/cycle', { method: 'POST', body: { date: DATE, iso_week: WEEK }, ...session })
    await started
    assert.equal(runtime.provider, PROVIDER)
    assert.equal(runtime.model, PROVIDER_MODELS[0])
    assert.equal(runtime.endpoint, PROVIDER_ENDPOINT)
    assert.equal(runtime.apiKey.toString('utf8'), PROVIDER_KEY)

    const clear = await httpRequest(info, '/api/provider/clear', { method: 'POST', body: {}, ...session })
    assert.equal(clear.status, 409)
    const replace = await configureProvider(info, session, { ...PROVIDER_BODY, api_key: 'another-provider-key' })
    assert.equal(replace.status, 409)

    releaseCycle()
    const run = await runPromise
    assert.equal(run.status, 200)
    assert.deepEqual(run.json.input, { date: DATE, isoWeek: WEEK })
    assert.doesNotMatch(run.text, new RegExp(PROVIDER_KEY))
    assert.doesNotMatch(run.text, /models\.example\.test/)
    assert.match(run.text, /\[REDACTED\]/)
    assert.equal(runtime.apiKey.every((byte) => byte === 0), true)
  } finally {
    await service.stop()
  }
})

test('logout revokes a busy provider session while the one-use cycle key is zeroed in finally', async () => {
  let releaseCycle
  let runtime
  let startedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  const cleared = []
  const { service, info } = await startService({
    onProviderCleared: (event) => cleared.push(event),
    adapters: {
      validateProviderConfig: async () => true,
      runCycle: async (_input, receivedRuntime) => {
        runtime = receivedRuntime
        startedResolve()
        await new Promise((resolve) => { releaseCycle = resolve })
        return { status: 'accepted' }
      }
    }
  })
  try {
    const session = await openSession(info)
    assert.equal((await configureProvider(info, session)).status, 200)
    const runPromise = httpRequest(info, '/api/cycle', { method: 'POST', body: { date: DATE, iso_week: WEEK }, ...session })
    await started
    const logout = await httpRequest(info, '/api/logout', { method: 'POST', body: {}, ...session })
    assert.equal(logout.status, 200)
    assert.equal(cleared.at(-1).reason, 'logout')
    assert.equal(cleared.at(-1).keyBuffer.every((byte) => byte === 0), true)
    assert.equal((await httpRequest(info, '/api/provider', { cookie: session.cookie })).status, 401)
    releaseCycle()
    assert.equal((await runPromise).status, 200)
    assert.equal(runtime.apiKey.every((byte) => byte === 0), true)
  } finally {
    await service.stop()
  }
})

test('provider secrets are absent from adapter status, errors, and WebSocket projections', async () => {
  const { service, info } = await startService({
    adapters: {
      validateProviderConfig: async () => true,
      status: async () => ({ status: 'ready', message: `${PROVIDER_KEY} ${PROVIDER_ENDPOINT}` }),
      runCycle: async () => { throw new Error(`failed ${PROVIDER_KEY} ${PROVIDER_ENDPOINT}`) }
    }
  })
  try {
    const session = await openSession(info)
    assert.equal((await configureProvider(info, session)).status, 200)
    const status = await httpRequest(info, '/api/status', { cookie: session.cookie })
    assert.equal(status.status, 200)
    assert.doesNotMatch(status.text, new RegExp(PROVIDER_KEY))
    assert.doesNotMatch(status.text, /models\.example\.test/)

    const failed = await httpRequest(info, '/api/cycle', { method: 'POST', body: { date: DATE, iso_week: WEEK }, ...session })
    assert.equal(failed.status, 502)
    assert.equal(failed.json.message, 'Manual cycle failed')
    assert.doesNotMatch(failed.text, new RegExp(PROVIDER_KEY))
    assert.doesNotMatch(failed.text, /models\.example\.test/)

    const ws = await new Promise((resolve, reject) => {
      const client = new WebSocket(`${info.origin}/api/events`, { headers: { Host: `${info.host}:${info.port}`, Origin: info.origin, Cookie: session.cookie } })
      client.once('message', () => resolve(client))
      client.once('error', reject)
    })
    const eventPromise = new Promise((resolve, reject) => {
      ws.once('message', (payload) => resolve(payload.toString()))
      ws.once('error', reject)
    })
    service.publish({ type: 'provider-test', data: { message: `${PROVIDER_KEY} ${PROVIDER_ENDPOINT}` } })
    const event = await eventPromise
    assert.doesNotMatch(event, new RegExp(PROVIDER_KEY))
    assert.doesNotMatch(event, /models\.example\.test/)
    ws.close()
  } finally {
    await service.stop()
  }
})

test('cycle route has an exact body and runs only through the injected adapter', async () => {
  const { service, info } = await startService()
  try {
    const session = await openSession(info)
    const missingProvider = await httpRequest(info, '/api/cycle', { method: 'POST', body: { date: DATE, iso_week: WEEK }, ...session })
    assert.equal(missingProvider.status, 409)
    assert.equal((await configureProvider(info, session)).status, 200)
    const extra = await httpRequest(info, '/api/cycle', { method: 'POST', body: { date: DATE, iso_week: WEEK, prompt: 'no' }, ...session })
    assert.equal(extra.status, 400)
    const run = await httpRequest(info, '/api/cycle', { method: 'POST', body: { date: DATE, iso_week: WEEK }, ...session })
    assert.equal(run.status, 200)
    assert.deepEqual(run.json.input, { date: DATE, isoWeek: WEEK })
  } finally {
    await service.stop()
  }
})

test('read-only WebSocket sends bounded sanitized projections and rejects client commands', async () => {
  const { service, info } = await startService()
  try {
    const session = await openSession(info)
    const ws = await new Promise((resolve, reject) => {
      const client = new WebSocket(`${info.origin}/api/events`, { headers: { Host: `${info.host}:${info.port}`, Origin: info.origin, Cookie: session.cookie } })
      const firstMessage = new Promise((messageResolve) => client.once('message', (payload) => messageResolve(payload)))
      client.once('open', async () => { await firstMessage; resolve(client) })
      client.once('error', reject)
    })
    const eventPromise = new Promise((resolve, reject) => {
      ws.once('message', (payload) => resolve(JSON.parse(payload.toString())))
      ws.once('error', reject)
    })
    assert.deepEqual(service.publish({ type: 'dag', data: {
      plan_hash: 'safe',
      plan_id: 'safe-plan-id',
      plan_summary: { plan_id: 'safe-plan-id', plan_hash: 'safe' },
      plan: { intents: [{ symbol: 'BTC_USDT' }], proofs: { sealed: true }, risk_policy: { max: 'private' } },
      token: 'drop',
      private_history: 'drop',
      nested: { fills: ['drop'] }
    } }), { sent: 1, dropped: false })
    const event = await eventPromise
    const eventText = JSON.stringify(event)
    assert.match(eventText, /safe/)
    assert.match(eventText, /safe-plan-id|plan_summary/)
    assert.doesNotMatch(eventText, /intents|proofs|risk_policy/)
    assert.doesNotMatch(eventText, /token|private_history|fills/)
    assert.equal(service.publish({ type: 'large', data: Array.from({ length: 100 }, () => 'x'.repeat(2000)) }).dropped, true)
    const oversizedClose = new Promise((resolve) => ws.once('close', (code) => resolve(code)))
    ws.once('error', () => {})
    ws.send('x'.repeat(MAX_WS_PAYLOAD_BYTES + 1))
    assert.equal(await oversizedClose, 1009)
    const stillAvailable = await httpRequest(info, '/api/status', { cookie: session.cookie })
    assert.equal(stillAvailable.status, 200)
    ws.close()
  } finally {
    await service.stop()
  }
})

test('static root is same-origin, hardened, and rejects traversal or symlinks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-control-static-'))
  const outside = path.join(path.dirname(directory), 'tyche-control-outside.txt')
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>tyche</title>')
  fs.mkdirSync(path.join(directory, 'assets'))
  fs.writeFileSync(path.join(directory, 'assets', 'app.js'), 'console.log("safe")')
  fs.writeFileSync(outside, 'outside')
  fs.symlinkSync(outside, path.join(directory, 'assets', 'link.js'))
  const { service, info } = await startService({ staticRoot: directory })
  try {
    const page = await httpRequest(info, '/', { origin: info.origin })
    assert.equal(page.status, 200)
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
    assert.equal(page.headers['x-content-type-options'], 'nosniff')
    assert.equal(page.headers['x-frame-options'], 'DENY')
    const asset = await httpRequest(info, '/assets/app.js', { origin: info.origin })
    assert.equal(asset.status, 200)
    const traversal = await httpRequest(info, '/%2e%2e/%2e%2e/etc/passwd', { origin: info.origin })
    assert.equal(traversal.status, 404)
    const symlink = await httpRequest(info, '/assets/link.js', { origin: info.origin })
    assert.equal(symlink.status, 404)
  } finally {
    await service.stop()
    fs.rmSync(directory, { recursive: true, force: true })
    fs.rmSync(outside, { force: true })
  }
})

test('configured static root must contain index.html before startup', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-control-empty-'))
  const service = createControlPlane({ port: 0, staticRoot: directory })
  await assert.rejects(service.start(), (error) => error.code === 'CONTROL_STATIC_ROOT_INVALID')
  fs.rmSync(directory, { recursive: true, force: true })
})

test('authenticated page setup writes a locked Paper pair and runs repeatedly without resetting it', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-http-paper-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeJsonAtomic(path.join(root, 'config/tyche.json'), loadConfig())
  const paper = createPaperSetupAdapter({ root })
  let cycles = 0
  const { service, info } = await startService({ adapters: { paperSetupStatus: paper.status, setupPaper: paper.setup, validateProviderConfig: async () => ({ ok: true }), runCycle: async () => { cycles++; return { outcome: 'PAPER_APPLIED', submitted: 0, filled: 0 } } } })
  t.after(() => service.stop())
  assert.equal((await httpRequest(info, '/api/paper/setup')).status, 401)
  const session = await openSession(info)
  const post = (body, extras = {}) => httpRequest(info, '/api/paper/setup', { method: 'POST', body, ...session, ...extras })
  assert.equal((await post({}, { csrf: '' })).status, 403)
  assert.equal((await post({}, { origin: 'https://evil.invalid' })).status, 403)
  assert.equal((await post({}, { headers: { Host: 'localhost' } })).status, 403)
  assert.equal((await post({ configPath: '/private' })).status, 400)
  assert.equal((await httpRequest(info, '/api/paper/setup?mode=execute', session)).status, 400)
  await configureProvider(info, session)
  assert.equal((await httpRequest(info, '/api/cycle', { method: 'POST', body: { date: DATE, iso_week: WEEK }, ...session })).status, 409)
  assert.equal(cycles, 0)
  assert.equal((await post({ initial_usdt: '0' })).status, 400)
  assert.equal(fs.existsSync(path.join(root, 'config/tyche.local.json')), false)
  const input = { configured_leverage: '2', risk_per_trade_bps: '25', max_order_notional_usdt: '100', daily_new_notional_cap_usdt: '250', max_managed_notional_usdt: '500', initial_usdt: '1000', daily_loss_bps: '100', max_drawdown_bps: '300', max_spread_bps: '12.5', max_entry_distance_bps: '40', trigger_slippage_bps: '5.125' }
  const saved = await post(input)
  assert.equal(saved.status, 200)
  assert.equal(saved.json.ready, true)
  assert.equal(saved.json.values.configured_leverage, '2')
  assert.doesNotMatch(saved.text, /account_id|events|config_digest|pa_|active.json|sk-session/)
  const active = path.join(root, 'data/paper/active.json')
  const initial = fs.readFileSync(active, 'utf8')
  for (let index = 0; index < 2; index++) {
    assert.equal((await post({})).json.ready, true)
    assert.equal((await httpRequest(info, '/api/cycle', { method: 'POST', body: { date: DATE, iso_week: WEEK }, ...session })).status, 200)
  }
  assert.equal(cycles, 2)
  assert.equal(fs.readFileSync(active, 'utf8'), initial)
  assert.equal((await post({ initial_usdt: '2000' })).status, 409)
  assert.equal(fs.readFileSync(active, 'utf8'), initial)
  let limited
  for (let index = 0; index < 12; index++) limited = await post({})
  assert.equal(limited.status, 429)
  for (const file of [active, path.join(root, 'config/tyche.local.json')]) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(PROVIDER_KEY))
})

test('cycle mutual exclusion covers delayed setup, and logout/expiry prevents later inference', async () => {
  for (const invalidate of ['logout', 'expire']) {
    let clock = Date.now()
    let release
    let entered
    let cycles = 0
    const started = new Promise((resolve) => { entered = resolve })
    const { service, info } = await startService({ now: () => clock, adapters: { validateProviderConfig: async () => ({ ok: true }), paperSetupStatus: async () => { entered(); return new Promise((resolve) => { release = resolve }) }, runCycle: async () => { cycles++; return {} } } })
    try {
      const session = await openSession(info); await configureProvider(info, session)
      const cycle = () => httpRequest(info, '/api/cycle', { method: 'POST', body: { date: DATE, iso_week: WEEK }, ...session })
      const first = cycle(); await started
      assert.equal((await cycle()).status, 409)
      assert.equal((await configureProvider(info, session)).status, 409)
      assert.equal((await httpRequest(info, '/api/strategy', { method: 'POST', body: { prompt: 'BTC trend' }, ...session })).status, 409)
      if (invalidate === 'logout') await httpRequest(info, '/api/logout', { method: 'POST', body: {}, ...session })
      else clock += SESSION_TTL_MS
      release({ ready: true, status: 'ready', values: {}, missing: [] })
      assert.equal((await first).status, 401)
      assert.equal(cycles, 0)
    } finally { await service.stop() }
  }
})

test('discussion is separate from applied strategy and cycle gets an immutable session snapshot', async () => {
  let release
  let entered
  let captured
  const started = new Promise((resolve) => { entered = resolve })
  const { service, info } = await startService({ adapters: { validateProviderConfig: async () => ({ ok: true }), discussStrategy: async (input) => { assert.equal(input.prompt, ''); return { reply: '可以先比较趋势与波动。', suggested_prompt: 'BTC/ETH prioritize dated volatility evidence.' } }, runCycle: async (_, runtime) => { captured = runtime; entered(); await new Promise((resolve) => { release = resolve }); return { outcome: 'PAPER_APPLIED' } } } })
  try {
    const session = await openSession(info)
    const post = (route, body) => httpRequest(info, route, { method: 'POST', body, ...session })
    assert.equal((await post('/api/strategy/discuss', { message: '讨论趋势' })).status, 409)
    await configureProvider(info, session)
    assert.equal((await post('/api/strategy/discuss', { message: '讨论趋势' })).status, 200)
    const unchanged = await httpRequest(info, '/api/strategy', session)
    assert.equal(unchanged.json.prompt, '')
    assert.equal(unchanged.json.discussion.length, 2)
    assert.equal((await post('/api/strategy', { prompt: 'BTC/ETH prioritize dated volatility evidence.' })).status, 200)
    const pending = post('/api/cycle', { date: DATE, iso_week: WEEK }); await started
    assert.equal(captured.strategyPrompt, 'BTC/ETH prioritize dated volatility evidence.')
    assert.equal(Object.isFrozen(captured), true)
    assert.equal((await post('/api/strategy', { prompt: 'changed' })).status, 409)
    assert.equal((await post('/api/strategy/discuss', { message: 'change' })).status, 409)
    release(); assert.equal((await pending).status, 200)
    assert.ok(captured.apiKey.every((byte) => byte === 0))
    await post('/api/logout', {})
    assert.equal((await httpRequest(info, '/api/strategy', session)).status, 401)
  } finally { await service.stop() }
})

test('strategy routes reject extra fields, secrets, overlong output, and cross-session reads', async () => {
  let discussions = 0
  let cycles = 0
  let result = { reply: 'safe' }
  const { service, info } = await startService({ adapters: { validateProviderConfig: async () => ({ ok: true }), discussStrategy: async () => { discussions++; return result }, runCycle: async () => { cycles++; return {} } } })
  const other = await startService()
  try {
    const session = await openSession(info)
    const post = (route, body) => httpRequest(info, route, { method: 'POST', body, ...session })
    assert.equal((await post('/api/strategy', { prompt: `do not send ${PROVIDER_KEY}` })).status, 200)
    assert.equal((await configureProvider(info, session)).status, 400)
    await post('/api/strategy', { prompt: 'Use models.example.test as analysis context' })
    assert.equal((await configureProvider(info, session)).status, 400)
    assert.equal((await post('/api/cycle', { date: DATE, iso_week: WEEK })).status, 409)
    assert.equal(cycles, 0)
    await post('/api/strategy', { prompt: 'BTC/ETH analysis' })
    assert.equal((await configureProvider(info, session)).status, 200)
    for (const body of [{ prompt: 'x'.repeat(8001) }, { prompt: 'valid', config: {} }, { prompt: PROVIDER_KEY }]) assert.equal((await post('/api/strategy', body)).status, 400)
    for (const body of [{ message: 'x'.repeat(8001) }, { message: 'valid', permissions: ['execute'] }, { message: PROVIDER_KEY }]) assert.equal((await post('/api/strategy/discuss', body)).status, 400)
    assert.equal(discussions, 0)
    result = { reply: PROVIDER_KEY }
    const secret = await post('/api/strategy/discuss', { message: 'valid' })
    assert.equal(secret.status, 502)
    assert.doesNotMatch(secret.text, new RegExp(PROVIDER_KEY))
    result = { reply: 'x'.repeat(8001) }
    assert.equal((await post('/api/strategy/discuss', { message: 'valid' })).status, 400)
    assert.equal((await httpRequest(info, '/api/strategy', session)).json.discussion.length, 0)
    const otherSession = await openSession(other.info)
    assert.equal((await httpRequest(other.info, '/api/strategy', session)).status, 401)
    assert.equal((await httpRequest(other.info, '/api/strategy', otherSession)).json.prompt, '')
  } finally { await service.stop(); await other.service.stop() }
})

test('late discussion response cannot revive an expired session or its memory', async () => {
  let clock = Date.now()
  let release
  let entered
  let runtime
  const started = new Promise((resolve) => { entered = resolve })
  const { service, info } = await startService({ now: () => clock, adapters: { validateProviderConfig: async () => ({ ok: true }), discussStrategy: async (_, input) => { runtime = input; entered(); return new Promise((resolve) => { release = resolve }) } } })
  try {
    const session = await openSession(info); await configureProvider(info, session)
    const pending = httpRequest(info, '/api/strategy/discuss', { method: 'POST', body: { message: 'BTC trend' }, ...session }); await started
    clock += SESSION_TTL_MS
    release({ reply: 'safe' })
    assert.equal((await pending).status, 401)
    assert.ok(runtime.apiKey.every((byte) => byte === 0))
    assert.equal((await httpRequest(info, '/api/strategy', session)).status, 401)
  } finally { await service.stop() }
})

test('future escaped credentials in applied strategy or history block provider replacement before validation', async () => {
  for (const apiKey of ['fixture"quoted-key', 'fixture\\backslash-key']) {
    for (const where of ['strategy', 'history']) {
      let validations = 0
      let discussions = 0
      let cycles = 0
      const { service, info } = await startService({ adapters: { validateProviderConfig: async () => { validations++; return { ok: true } }, discussStrategy: async () => { discussions++; return { reply: 'Safe explanation.' } }, runCycle: async () => { cycles++; return {} } } })
      try {
        const session = await openSession(info)
        const post = (route, body) => httpRequest(info, route, { method: 'POST', body, ...session })
        if (where === 'strategy') {
          assert.equal((await post('/api/strategy', { prompt: `BTC context ${apiKey}` })).status, 200)
        } else {
          assert.equal((await configureProvider(info, session)).status, 200)
          assert.equal((await post('/api/strategy/discuss', { message: `BTC context ${apiKey}` })).status, 200)
        }
        const before = validations
        const response = await configureProvider(info, session, { ...PROVIDER_BODY, api_key: apiKey })
        assert.equal(response.status, 400)
        assert.equal(response.json.code, 'CONTROL_STRATEGY_SECRET')
        assert.equal(response.text.includes(apiKey), false)
        assert.equal(validations, before)
        assert.equal(discussions, where === 'history' ? 1 : 0)
        if (where === 'strategy') assert.equal((await post('/api/cycle', { date: DATE, iso_week: WEEK })).status, 409)
        assert.equal(cycles, 0)
        assert.equal((await httpRequest(info, '/api/provider', session)).json.configured, where === 'history')
      } finally { await service.stop() }
    }
  }
})

test('active escaped credentials are rejected from applied text, discussion, and parsed response fields', async () => {
  for (const apiKey of ['fixture"quoted-key', 'fixture\\backslash-key']) {
    let discussions = 0
    let output = { reply: 'safe' }
    const { service, info } = await startService({ adapters: { validateProviderConfig: async () => ({ ok: true }), discussStrategy: async () => { discussions++; return output } } })
    try {
      const session = await openSession(info)
      const post = (route, body) => httpRequest(info, route, { method: 'POST', body, ...session })
      assert.equal((await configureProvider(info, session, { ...PROVIDER_BODY, api_key: apiKey })).status, 200)
      assert.equal((await post('/api/strategy', { prompt: apiKey })).status, 400)
      assert.equal((await post('/api/strategy/discuss', { message: apiKey })).status, 400)
      assert.equal(discussions, 0)
      for (const result of [{ reply: apiKey }, { reply: 'safe', suggested_prompt: apiKey }, { reply: 'safe', [apiKey]: 'value' }]) {
        output = result
        const response = await post('/api/strategy/discuss', { message: 'BTC/ETH review' })
        assert.equal(response.status, 502)
        assert.equal(response.json.code, 'CONTROL_STRATEGY_SECRET')
        assert.equal(response.text.includes(apiKey), false)
      }
      const saved = await httpRequest(info, '/api/strategy', session)
      assert.equal(saved.json.prompt, '')
      assert.deepEqual(saved.json.discussion, [])
    } finally { await service.stop() }
  }
})
