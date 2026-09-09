import { discussSessionStrategy, createSessionProviderRuntime } from '../../../packages/pi-agents/src/index.mjs'
import { assertSessionModelEffort } from '../../../packages/pi-agents/src/session-provider.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import WebSocket from 'ws'
import { createPaperSetupAdapter } from '../../../scripts/control-paper-setup.mjs'
import { projectPaperScene } from '../../../scripts/control-paper-scene.mjs'
import { sceneFixture } from '../../../test/paper-scene-fixtures.mjs'
import { startControlPlaneChild } from '../../../scripts/tyche-control-plane.mjs'
import { loadConfig } from '../../../scripts/config.mjs'
import { writeJsonAtomic } from '../../../scripts/lib-iolock.mjs'
import { providerRequest, saveConnection } from '../../web/src/workflow-entry.js'
import {
  ARM_CONFIRMATIONS,
  LOOPBACK_HOST,
  SESSION_TTL_MS,
  MAX_WS_EVENT_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  PROVIDER,
  PROVIDER_MODELS,
  providerValidationError,
  projectSafe,
  createControlPlane
} from '../src/control-plane.mjs'

const DATE = '2030-01-07'
const WEEK = '2030-W02'
const PROVIDER_KEY = 'sk-session-provider-secret-value'
const PROVIDER_ENDPOINT = 'https://models.example.test/v1'
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

async function openSession(info, { knownPool = false } = {}) {
  const response = await httpRequest(info, '/api/session', { method: 'POST', body: { bootstrap_token: info.bootstrapToken } })
  assert.equal(response.status, 200)
  assert.match(response.headers['set-cookie'][0], /HttpOnly/)
  assert.match(response.headers['set-cookie'][0], /SameSite=Strict/)
  assert.doesNotMatch(response.headers['set-cookie'][0], /Secure/)
  const session = { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.json.csrf_token }
  if (knownPool) {
    const pool = PROVIDER_MODELS.map((id) => ({ id, efforts: ['medium', 'high', 'xhigh'].filter((effort) => { try { assertSessionModelEffort(id, effort); return true } catch { return false } }) }))
    assert.equal((await httpRequest(info, '/api/models', { method: 'POST', body: { pool, mode: 'manual' }, ...session })).status, 200)
    assert.equal((await httpRequest(info, '/api/models', { method: 'POST', body: { mode: 'auto' }, ...session })).status, 200)
  }
  return session
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

test('explicit bootstrap tokens reject invalid values', () => {
  for (const bootstrapToken of [undefined, null, 654321, '', 'short', ' ', 'token with spaces', 'token\n', 'é', 'x'.repeat(257)]) {
    assert.throws(() => createControlPlane({ port: 0, bootstrapToken }), { code: 'CONTROL_BOOTSTRAP_TOKEN_INVALID' })
  }
})

test('reusable bootstrap requires strict boolean selection and an explicit valid token', () => {
  for (const reusableBootstrapToken of [undefined, null, 'true', 'false', 0, 1, {}, []]) {
    assert.throws(() => createControlPlane({ bootstrapToken: 'reusable-fixture', reusableBootstrapToken }), { code: 'CONTROL_BOOTSTRAP_REUSE_INVALID' })
  }
  assert.throws(() => createControlPlane({ reusableBootstrapToken: true }), { code: 'CONTROL_BOOTSTRAP_REUSE_INVALID' })
  assert.throws(() => createControlPlane({ bootstrapToken: '', reusableBootstrapToken: true }), { code: 'CONTROL_BOOTSTRAP_TOKEN_INVALID' })
})

test('reusable login preserves gates, rotates credentials, and clears replaced, logged-out and expired sessions', async () => {
  let clock = Date.parse('2030-01-07T00:00:00.000Z')
  const cleared = []
  const { service, info, calls } = await startService({
    bootstrapToken: 'reusable-fixture', reusableBootstrapToken: true,
    now: () => clock, onProviderCleared: (event) => cleared.push(event)
  })
  const credentials = []
  const streams = []
  async function stream(session) {
    const client = new WebSocket(`${info.origin}/api/events`, { headers: { Origin: info.origin, Cookie: session.cookie } })
    streams.push(client)
    await new Promise((resolve, reject) => { client.once('message', resolve); client.once('error', reject) })
    return { closed: new Promise((resolve) => client.once('close', resolve)) }
  }
  async function login(cookie) {
    const response = await httpRequest(info, '/api/session', { method: 'POST', body: { bootstrap_token: info.bootstrapToken }, cookie })
    assert.equal(response.status, 200)
    const session = { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.json.csrf_token }
    assert.match(session.cookie.split('=')[1], /^[A-Za-z0-9_-]{43}$/)
    assert.match(session.csrf, /^[A-Za-z0-9_-]{43}$/)
    credentials.push(session.cookie.split('=')[1], session.csrf)
    return session
  }
  try {
    const first = await login()
    assert.equal((await configureProvider(info, first)).status, 200)
    assert.equal((await httpRequest(info, '/api/strategy', { method: 'POST', body: { prompt: 'fixture strategy' }, ...first })).status, 200)
    const firstStream = await stream(first)
    for (const override of [
      { body: { bootstrap_token: 'wrong-fixture' } },
      { origin: 'http://127.0.0.1:1' },
      { origin: '' },
      { headers: { Host: 'localhost' } },
      { headers: { 'X-Forwarded-Host': 'evil.example' } }
    ]) {
      const rejected = await httpRequest(info, '/api/session', { method: 'POST', body: { bootstrap_token: info.bootstrapToken }, cookie: first.cookie, ...override })
      assert.equal(rejected.status, override.body ? 401 : 403)
      assert.equal((await httpRequest(info, '/api/provider', first)).json.configured, true)
    }
    const second = await login(first.cookie)
    await firstStream.closed
    assert.equal(cleared.at(-1).reason, 'relogin')
    assert.ok(cleared.at(-1).keyBuffer.every((byte) => byte === 0))
    assert.equal((await httpRequest(info, '/api/status', first)).status, 401)
    assert.equal((await httpRequest(info, '/api/provider', second)).json.configured, false)
    assert.equal((await httpRequest(info, '/api/strategy', second)).json.prompt, '')
    for (const csrf of [first.csrf, 'wrong-csrf', undefined]) {
      assert.equal((await httpRequest(info, '/api/logout', { method: 'POST', body: {}, cookie: second.cookie, csrf })).status, 403)
    }
    assert.equal((await httpRequest(info, '/api/executor/arm', { method: 'POST', body: { venue: 'gate', confirmation: 'wrong' }, ...second })).status, 403)
    assert.equal((await httpRequest(info, '/api/executor/execute', { method: 'POST', body: { venue: 'gate', plan_hash: 'fixture-hash', confirmation: 'wrong' }, ...second })).status, 403)
    assert.equal(calls.length, 0)
    assert.equal((await configureProvider(info, second)).status, 200)
    const secondStream = await stream(second)
    const logout = await httpRequest(info, '/api/logout', { method: 'POST', body: {}, ...second })
    assert.equal(logout.status, 200)
    assert.match(logout.headers['set-cookie'][0], new RegExp(`tyche_control_session_${info.port}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`))
    await secondStream.closed
    assert.equal(cleared.at(-1).reason, 'logout')
    assert.ok(cleared.at(-1).keyBuffer.every((byte) => byte === 0))
    const third = await login(second.cookie)
    assert.equal((await configureProvider(info, third)).status, 200)
    const thirdStream = await stream(third)
    clock += SESSION_TTL_MS
    assert.equal(service.publish({ type: 'status', data: { ready: true } }).sent, 0)
    await thirdStream.closed
    assert.equal(cleared.at(-1).reason, 'expired')
    assert.ok(cleared.at(-1).keyBuffer.every((byte) => byte === 0))
    assert.equal((await httpRequest(info, '/api/status', third)).status, 401)
    assert.equal((await httpRequest(info, '/api/logout', { method: 'POST', body: {}, ...third })).status, 401)
    const fourth = await login(third.cookie)
    assert.equal((await httpRequest(info, '/api/status', fourth)).status, 200)
    assert.equal(new Set(credentials).size, credentials.length)
    assert.ok(!credentials.includes(info.bootstrapToken))
  } finally {
    for (const client of streams) client.terminate()
    await service.stop()
  }
})

test('ports have separate cookies and same-origin session recovery never extends TTL or replays a mutation', async () => {
  let clock = Date.parse('2030-01-07T00:00:00.000Z')
  const first = await startService({ bootstrapToken: 'csrf-port-fixture', reusableBootstrapToken: true, now: () => clock })
  const second = await startService()
  const resume = (info, cookie, options = {}) => httpRequest(info, '/api/session', { cookie, headers: { 'X-Tyche-Session': 'resume' }, ...options })
  try {
    const a = await openSession(first.info)
    const b = await openSession(second.info)
    assert.notEqual(a.cookie.split('=')[0], b.cookie.split('=')[0])
    const browserCookies = `${a.cookie}; ${b.cookie}`
    assert.equal((await httpRequest(first.info, '/api/status', { cookie: browserCookies, csrf: a.csrf })).status, 200)
    assert.equal((await httpRequest(second.info, '/api/status', { cookie: browserCookies, csrf: b.csrf })).status, 200)
    const recovery = await resume(second.info, browserCookies)
    assert.equal(recovery.json.csrf_token, b.csrf)
    assert.equal(recovery.headers['set-cookie'], undefined)
    assert.match(recovery.headers['cache-control'], /no-store/)
    assert.equal(recovery.headers['access-control-allow-origin'], undefined)
    assert.equal((await httpRequest(second.info, '/api/session', { method: 'POST', body: { bootstrap_token: second.info.bootstrapToken }, cookie: browserCookies })).status, 401)
    for (const options of [{ headers: {} }, { headers: { 'X-Tyche-Session': 'wrong' } }, { origin: 'https://evil.example' }, { headers: { 'X-Tyche-Session': 'resume', Host: 'localhost' } }]) assert.equal((await resume(first.info, browserCookies, options)).status, 403)
    assert.equal((await resume(first.info, undefined)).status, 401)
    const relogin = await httpRequest(first.info, '/api/session', { method: 'POST', body: { bootstrap_token: first.info.bootstrapToken }, cookie: browserCookies })
    const replacementCookies = `${relogin.headers['set-cookie'][0].split(';')[0]}; ${b.cookie}`
    assert.equal((await httpRequest(first.info, '/api/strategy', { method: 'POST', body: { prompt: 'must-not-apply' }, cookie: replacementCookies, csrf: a.csrf })).status, 403)
    assert.equal((await httpRequest(first.info, '/api/strategy', { cookie: replacementCookies, csrf: a.csrf })).status, 403)
    const current = await resume(first.info, replacementCookies)
    assert.equal(current.json.csrf_token, relogin.json.csrf_token)
    assert.equal((await httpRequest(first.info, '/api/strategy', { cookie: replacementCookies, csrf: current.json.csrf_token })).json.prompt, '')
    clock += SESSION_TTL_MS / 2
    assert.equal((await resume(first.info, replacementCookies)).json.expires_at, current.json.expires_at)
    const logout = await httpRequest(first.info, '/api/logout', { method: 'POST', body: {}, cookie: replacementCookies, csrf: current.json.csrf_token })
    assert.match(logout.headers['set-cookie'][0], new RegExp(`^tyche_control_session_${first.info.port}=`))
    assert.equal((await resume(first.info, replacementCookies)).status, 401)
    assert.equal((await resume(second.info, replacementCookies)).json.csrf_token, b.csrf)
    const expiring = await openSession(first.info)
    clock += SESSION_TTL_MS
    assert.equal((await resume(first.info, expiring.cookie)).status, 401)
    assert.equal((await httpRequest(first.info, '/api/logout', { method: 'POST', body: {}, ...expiring })).status, 401)
    assert.equal(first.calls.length, 0)
  } finally { await first.service.stop(); await second.service.stop() }
})

test('temporary bootstrap stays one-use while session and CSRF tokens stay random', async () => {
  const bootstrapToken = '654321'
  const sessions = []
  for (let index = 0; index < 2; index += 1) {
    const { service, info } = await startService({ bootstrapToken })
    try {
      assert.equal(info.bootstrapToken, bootstrapToken)
      const wrong = await httpRequest(info, '/api/session', { method: 'POST', body: { bootstrap_token: 'wrong-fixture' } })
      assert.equal(wrong.status, 401)
      const session = await openSession(info)
      const sessionId = session.cookie.split('=')[1]
      assert.match(sessionId, /^[A-Za-z0-9_-]{43}$/)
      assert.match(session.csrf, /^[A-Za-z0-9_-]{43}$/)
      assert.notEqual(sessionId, bootstrapToken)
      assert.notEqual(session.csrf, bootstrapToken)
      assert.notEqual(sessionId, session.csrf)
      sessions.push({ sessionId, csrf: session.csrf })
      const second = await httpRequest(info, '/api/session', { method: 'POST', body: { bootstrap_token: bootstrapToken } })
      assert.equal(second.status, 401)
    } finally {
      await service.stop()
    }
  }
  assert.notEqual(sessions[0].sessionId, sessions[1].sessionId)
  assert.notEqual(sessions[0].csrf, sessions[1].csrf)
})

test('omitting bootstrap token generates a fresh random token', async () => {
  const tokens = []
  for (let index = 0; index < 2; index += 1) {
    const { service, info } = await startService()
    try {
      assert.match(info.bootstrapToken, /^[A-Za-z0-9_-]{43}$/)
      tokens.push(info.bootstrapToken)
    } finally {
      await service.stop()
    }
  }
  assert.notEqual(tokens[0], tokens[1])
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
      protocol: 'openai-responses',
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

test('restored sessions never pair an old endpoint draft with the current session key', async () => {
  const alpha = 'https://alpha.example.test/v1'
  const beta = 'https://beta.example.test/v1'
  const alphaKey = 'alpha-key-fixture'
  const betaKey = 'beta-key-fixture'
  const validated = []
  const { service, info } = await startService({
    bootstrapToken: 'endpoint-recovery-fixture', reusableBootstrapToken: true,
    adapters: { validateProviderConfig: async (runtime) => { validated.push({ endpoint: runtime.endpoint, key: runtime.apiKey.toString('utf8') }); return { ok: true } } }
  })
  try {
    const first = await openSession(info)
    assert.equal((await configureProvider(info, first, { ...PROVIDER_BODY, endpoint: alpha, api_key: alphaKey })).status, 200)
    const oldDraft = { endpoint: alpha, apiKey: '', model: PROVIDER_MODELS[0] }
    const login = await httpRequest(info, '/api/session', { method: 'POST', body: { bootstrap_token: info.bootstrapToken }, cookie: first.cookie })
    assert.equal(login.status, 200)
    const second = { cookie: login.headers['set-cookie'][0].split(';')[0], csrf: login.json.csrf_token }
    assert.equal((await configureProvider(info, second, { ...PROVIDER_BODY, endpoint: beta, api_key: betaKey })).status, 200)
    const restored = await httpRequest(info, '/api/session', { cookie: second.cookie, headers: { 'X-Tyche-Session': 'resume' } })
    assert.equal(restored.json.csrf_token, second.csrf)
    const current = (await httpRequest(info, '/api/provider', second)).json
    assert.throws(() => providerRequest(current, oldDraft), /对应的 API key/)
    let sent = 0
    const api = { configureProvider: async (value, csrf) => { sent++; const { apiKey, ...body } = value; return configureProvider(info, { cookie: second.cookie, csrf }, { ...body, ...(apiKey === undefined ? {} : { api_key: apiKey }) }) } }
    await assert.rejects(saveConnection(api, restored.json.csrf_token, current, oldDraft), /对应的 API key/)
    assert.equal(sent, 0)
    const before = validated.length
    for (const endpoint of [alpha, 'https://beta.example.test/v2']) {
      const rejected = await configureProvider(info, second, { provider: PROVIDER, model: PROVIDER_MODELS[0], endpoint })
      assert.equal(rejected.status, 400)
      assert.equal(rejected.json.code, 'CONTROL_PROVIDER_API_KEY_REQUIRED')
    }
    assert.equal(validated.length, before)
    assert.deepEqual((await httpRequest(info, '/api/provider', second)).json, current)
    assert.equal((await configureProvider(info, second, { provider: PROVIDER, model: PROVIDER_MODELS[0], endpoint: 'https://BETA.example.test:443/v1/' })).status, 200)
    assert.deepEqual(validated.at(-1), { endpoint: beta, key: betaKey })
    assert.equal((await saveConnection(api, second.csrf, current, { ...oldDraft, apiKey: alphaKey })).status, 200)
    assert.equal(sent, 1)
    assert.deepEqual(validated.at(-1), { endpoint: alpha, key: alphaKey })
    assert.equal((await httpRequest(info, '/api/provider', second)).json.endpoint, alpha)
    assert.equal(validated.some(({ endpoint, key }) => endpoint === alpha && key === betaKey), false)
  } finally { await service.stop() }
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
      configured: false, provider: null, protocol: null, model: null, endpoint: null, scope: 'session', manual_cycle_only: true
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

test('provider diagnostics expose only fixed codes and messages, including at the controller boundary', async () => {
  const secretText = `${PROVIDER_KEY} ${PROVIDER_ENDPOINT} ${[10, 0, 0, 7].join('.')} private-dns-stack`
  const known = providerValidationError({ code: 'PI_SESSION_ENDPOINT_DNS_FAILED', message: secretText })
  assert.deepEqual(known, { code: 'PI_SESSION_ENDPOINT_DNS_FAILED', message: '无法解析模型服务域名，请检查 API 基础地址及运行 Tyche 的本机 DNS 设置。' })
  for (const code of [undefined, null, '__proto__', 'constructor', `PI_${secretText}`, 'PI_SESSION_ENDPOINT_DNS_FAILED extra', new String('PI_SESSION_ENDPOINT_DNS_FAILED')]) {
    assert.deepEqual(providerValidationError({ code, message: secretText }), { code: 'CONTROL_PROVIDER_VALIDATION_FAILED', message: 'Provider validation failed' })
  }
  let error = Object.assign(new Error(secretText), { code: known.code, status: 503 })
  const { service, info } = await startService({ adapters: { validateProviderConfig: async () => { throw error } } })
  try {
    const session = await openSession(info)
    const knownResponse = await configureProvider(info, session)
    assert.equal(knownResponse.status, 400)
    assert.deepEqual(knownResponse.json, { ok: false, ...known })
    error = Object.assign(new Error(secretText), { code: `PI_${secretText}` })
    const unknownResponse = await configureProvider(info, session)
    assert.equal(unknownResponse.status, 400)
    assert.deepEqual(unknownResponse.json, { ok: false, code: 'CONTROL_PROVIDER_VALIDATION_FAILED', message: 'Provider validation failed' })
  } finally { await service.stop() }
})

test('real child provider validation preserves safe runtime diagnostics without inference or partial saves', async () => {
  const bootstrapToken = 'provider-diagnostics-bootstrap-fixture'
  const captures = []
  const buffers = []
  const cleared = []
  let behavior = 'dns-failed'
  let fetches = 0
  let lookups = 0
  const secretText = `${PROVIDER_KEY} ${PROVIDER_ENDPOINT} ${[10, 0, 0, 7].join('.')} private-dns-stack`
  const listeners = Object.fromEntries(['message', 'SIGINT', 'SIGTERM'].map((event) => [event, process.listeners(event)]))
  const originalWrite = process.stdout.write
  let child
  let childAdapter
  try {
    process.stdout.write = () => true
    child = await startControlPlaneChild({
      port: 0, bootstrapToken, env: {},
      stateReader: () => ({ recent_cycle: null, dag: {}, paper: {} }),
      stateWriter: () => assert.fail('validation must not persist state'),
      lookup: async () => {
        lookups++
        if (behavior === 'dns-failed') throw new Error(secretText)
        return behavior === 'not-public' ? [{ address: [10, 0, 0, 7].join('.'), family: 4 }] : [{ address: [93, 184, 216, 34].join('.'), family: 4 }]
      },
      fetchImpl: async () => { fetches++; assert.fail('validation must not send model requests') },
      providerRuntimeFactory: async (input) => {
        captures.push(input)
        if (behavior === 'unknown') throw Object.assign(new Error(secretText), { code: `PI_${secretText}` })
        if (behavior === 'known-secret') throw Object.assign(new Error(secretText), { code: 'PI_SESSION_MODEL_SOURCE_INVALID' })
        if (behavior === 'model-invalid') return createSessionProviderRuntime({ ...input, modelId: 'absent-model' })
        if (behavior === 'fetch-missing') return createSessionProviderRuntime({ ...input, fetchImpl: null })
        return createSessionProviderRuntime(input)
      },
      controlPlaneFactory: (options) => {
        childAdapter = options.adapters.validateProviderConfig
        return createControlPlane({ ...options, staticRoot: undefined, onProviderCleared: (event) => cleared.push(event), adapters: { ...options.adapters,
          validateProviderConfig: (runtime) => { buffers.push(runtime.apiKey); return childAdapter(runtime) }
        } })
      }
    })
  } finally { process.stdout.write = originalWrite }
  try {
    const info = { ...child.info, origin: `http://${child.info.host}:${child.info.port}`, bootstrapToken }
    const session = await openSession(info)
    const failed = await configureProvider(info, session)
    assert.equal(failed.status, 400)
    assert.equal(failed.json.code, 'PI_SESSION_ENDPOINT_DNS_FAILED')
    assert.equal((await httpRequest(info, '/api/provider', session)).json.configured, false)

    behavior = 'public'
    const configured = await configureProvider(info, session)
    assert.equal(configured.status, 200)
    const cases = [
      ['dns-failed', PROVIDER_ENDPOINT, 'PI_SESSION_ENDPOINT_DNS_FAILED', /DNS/],
      ['not-public', PROVIDER_ENDPOINT, 'PI_SESSION_ENDPOINT_NOT_PUBLIC', /公网/],
      ['public', 'http://models.example.test/v1', 'PI_SESSION_ENDPOINT_HTTP_FORBIDDEN', /HTTPS/],
      ['public', 'https://models.example.test/v%31', 'PI_SESSION_ENDPOINT_ENCODING_FORBIDDEN', /百分号编码/],
      ['model-invalid', PROVIDER_ENDPOINT, 'PI_SESSION_MODEL_NOT_ALLOWED', /模型池/],
      ['fetch-missing', PROVIDER_ENDPOINT, 'PI_SESSION_FETCH_REQUIRED', /Node.js/],
      ['known-secret', PROVIDER_ENDPOINT, 'PI_SESSION_MODEL_SOURCE_INVALID', /SDK/],
      ['unknown', PROVIDER_ENDPOINT, 'CONTROL_PROVIDER_VALIDATION_FAILED', /^Provider validation failed$/]
    ]
    for (const [nextBehavior, endpoint, code, message] of cases) {
      behavior = nextBehavior
      const response = await configureProvider(info, session, { ...PROVIDER_BODY, endpoint, api_key: 'replacement-key-fixture' })
      assert.equal(response.status, 400)
      assert.equal(response.json.code, code)
      assert.match(response.json.message, message)
      for (const value of [PROVIDER_KEY, PROVIDER_ENDPOINT, 'replacement-key-fixture', 'models.example.test', [10, 0, 0, 7].join('.'), 'private-dns-stack']) assert.equal(response.text.includes(value), false)
      assert.deepEqual((await httpRequest(info, '/api/provider', session)).json, configured.json)
      assert.equal(cleared.length, 0)
      assert.equal(buffers.at(-1).every((byte) => byte === 0), true)
      assert.equal(Object.hasOwn(captures.at(-1), 'apiKey'), false)
      assert.equal(Object.hasOwn(captures.at(-1), 'endpoint'), false)
    }
    // The child itself must not propagate unknown PI-prefixed codes or text.
    const directKey = Buffer.from(PROVIDER_KEY)
    try {
      await assert.rejects(childAdapter({ provider: PROVIDER, model: PROVIDER_MODELS[0], apiKey: directKey, endpoint: PROVIDER_ENDPOINT }),
        { code: 'CONTROL_PROVIDER_VALIDATION_FAILED', message: 'Provider validation failed' })
    } finally { directKey.fill(0) }
    behavior = 'public'
    const { api_key, ...withoutKey } = PROVIDER_BODY
    assert.equal((await configureProvider(info, session, withoutKey)).status, 200)
    assert.equal(cleared.length, 1)
    assert.equal(cleared[0].keyBuffer.every((byte) => byte === 0), true)
    assert.ok(lookups > 0)
    assert.equal(fetches, 0)
    assert.equal(buffers.every((buffer) => buffer.every((byte) => byte === 0)), true)
    assert.equal(captures.every((input) => !Object.hasOwn(input, 'apiKey') && !Object.hasOwn(input, 'endpoint')), true)
    const beforeSwitch = captures.length
    const missingKey = await configureProvider(info, session, { ...withoutKey, protocol: 'openai-completions' })
    assert.equal(missingKey.status, 400)
    assert.equal(missingKey.json.code, 'CONTROL_PROVIDER_API_KEY_REQUIRED')
    assert.equal(captures.length, beforeSwitch)
    const switched = await configureProvider(info, session, { ...PROVIDER_BODY, protocol: 'openai-completions' })
    assert.equal(switched.status, 200)
    assert.equal(switched.json.protocol, 'openai-completions')
    assert.equal(captures.at(-1).protocol, 'openai-completions')
    behavior = 'dns-failed'
    assert.equal((await configureProvider(info, session, PROVIDER_BODY)).status, 400)
    assert.deepEqual((await httpRequest(info, '/api/provider', session)).json, switched.json)
    behavior = 'public'
    const catalog = (await httpRequest(info, '/api/models', session)).json
    assert.ok(catalog.known_models.includes('claude-opus-4-7'))
    assert.deepEqual(catalog.protocol_models.find(({ id }) => id === 'claude-sonnet-4-6').efforts, ['medium', 'high'])
    const claudePool = [{ id: 'claude-opus-4-7', efforts: ['medium', 'high', 'xhigh'] }]
    assert.equal((await httpRequest(info, '/api/models', { ...session, method: 'POST', body: { pool: claudePool, mode: 'auto', bootstrap: { model: claudePool[0].id, effort: 'high' } } })).status, 200)
    const anthropic = await configureProvider(info, session, { ...PROVIDER_BODY, protocol: 'anthropic-messages', model: claudePool[0].id, endpoint: 'https://models.example.test' })
    assert.equal(anthropic.status, 200, anthropic.text)
    assert.equal(anthropic.json.protocol, 'anthropic-messages')
    assert.equal(captures.at(-1).protocol, 'anthropic-messages')
    assert.equal(fetches, 0)
    assert.equal(buffers.every((buffer) => buffer.every((byte) => byte === 0)), true)
  } finally {
    await child.plane.stop()
    for (const [event, original] of Object.entries(listeners)) for (const listener of process.listeners(event)) if (!original.includes(listener)) process.removeListener(event, listener)
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
    const session = await openSession(first.info, { knownPool: true })
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
    for (const [extension, mime] of [['glb', 'model/gltf-binary'], ['png', 'image/png'], ['webp', 'image/webp']]) {
      fs.writeFileSync(path.join(directory, 'assets', `scene.${extension}`), Buffer.from([1, 2, 3]))
      const resource = await httpRequest(info, `/assets/scene.${extension}`, { origin: info.origin })
      assert.equal(resource.status, 200); assert.equal(resource.headers['content-type'], mime)
      assert.equal(resource.headers['x-content-type-options'], 'nosniff')
    }
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
    assert.equal((await post('/api/strategy', { prompt: `do not send ${PROVIDER_KEY}` })).status, 400)
    assert.equal((await post('/api/strategy', { prompt: 'do not send future-opaque-credential' })).status, 200)
    assert.equal((await configureProvider(info, session, { ...PROVIDER_BODY, api_key: 'future-opaque-credential' })).status, 400)
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
    assert.equal((await post('/api/strategy/discuss', { message: 'valid' })).status, 502)
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

test('model configuration is exact, session-local, and rejects invalid mappings atomically', async () => {
  const { service, info } = await startService()
  const other = await startService()
  try {
    assert.equal((await httpRequest(info, '/api/models')).status, 401)
    const session = await openSession(info, { knownPool: true })
    const post = (body, extras = {}) => httpRequest(info, '/api/models', { method: 'POST', body, ...session, ...extras })
    const initial = (await httpRequest(info, '/api/models', session)).json
    assert.equal(initial.allowed_models.length, 6)
    assert.equal(Object.keys(initial.effective_models).length, 6)
    assert.ok(Object.values(initial.effective_models).every((model) => model === PROVIDER_MODELS[0]))
    assert.equal((await post({ role_models: {} }, { csrf: '' })).status, 403)
    assert.equal((await post({ role_models: {} }, { origin: 'https://evil.invalid' })).status, 403)
    assert.equal((await post({ role_models: {} }, { headers: { Host: 'localhost' } })).status, 403)
    assert.equal((await httpRequest(info, '/api/models?role=admin', session)).status, 400)
    for (const body of [{ role_models: { reviewer: PROVIDER_MODELS[2], admin: PROVIDER_MODELS[0] } }, { role_models: { reviewer: 'unsupported-model' } }, { role_models: { reviewer: PROVIDER_KEY } }, { role_models: { [PROVIDER_KEY]: PROVIDER_MODELS[0] } }, { role_models: [], endpoint: PROVIDER_ENDPOINT }, { role_models: { reviewer: { model: PROVIDER_MODELS[0] } } }]) {
      const result = await post(body)
      assert.equal(result.status, 400)
      assert.equal(result.text.includes(PROVIDER_KEY), false)
      assert.deepEqual((await httpRequest(info, '/api/models', session)).json, initial)
    }
    const changed = await post({ role_models: { reviewer: PROVIDER_MODELS[4] } })
    assert.equal(changed.json.effective_models.reviewer, PROVIDER_MODELS[4])
    assert.equal(changed.json.effective_models.orchestrator, PROVIDER_MODELS[0])
    const otherSession = await openSession(other.info)
    assert.equal((await httpRequest(other.info, '/api/models', session)).status, 401)
    assert.deepEqual((await httpRequest(other.info, '/api/models', otherSession)).json.role_models, {})
    await httpRequest(info, '/api/logout', { method: 'POST', body: {}, ...session })
    assert.equal((await httpRequest(info, '/api/models', session)).status, 401)
  } finally { await service.stop(); await other.service.stop() }
})

test('model suggestions remain unapplied until confirmed, then select the main Agent and freeze every cycle role', async () => {
  const snapshots = []
  const discussions = []
  const suggested = { orchestrator: PROVIDER_MODELS[1], 'btc-analyst': PROVIDER_MODELS[2], reviewer: PROVIDER_MODELS[4] }
  let release
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  const { service, info } = await startService({ adapters: { validateProviderConfig: async () => ({ ok: true }), discussStrategy: async (input, runtime) => { discussions.push({ input, model: runtime.model }); return { reply: '可分别调整这些模型；尚未应用。', suggested_role_models: suggested } }, runCycle: async (_, runtime) => { snapshots.push(runtime); if (snapshots.length === 2) { entered(); await new Promise((resolve) => { release = resolve }) } return { outcome: 'NO_ACTION', reused: snapshots.length > 1 } } } })
  try {
    const session = await openSession(info, { knownPool: true }); await configureProvider(info, session)
    const post = (route, body) => httpRequest(info, route, { method: 'POST', body, ...session })
    const firstDiscussion = await post('/api/strategy/discuss', { message: '调整主 Agent、BTC 分析和复核模型。' })
    assert.deepEqual(firstDiscussion.json.suggested_role_models, suggested)
    assert.equal(discussions[0].model, PROVIDER_MODELS[0])
    assert.equal(Object.keys(discussions[0].input.roleModels).length, 6)
    await post('/api/cycle', { date: DATE, iso_week: WEEK })
    assert.ok(Object.values(snapshots[0].roleModels).every((model) => model === PROVIDER_MODELS[0]))
    assert.deepEqual((await httpRequest(info, '/api/models', session)).json.role_models, {})
    assert.equal((await post('/api/models', { role_models: suggested })).status, 200)
    await post('/api/strategy/discuss', { message: '核查当前模型。' })
    assert.equal(discussions[1].model, PROVIDER_MODELS[1])
    assert.equal(discussions[1].input.roleModels['btc-analyst'], PROVIDER_MODELS[2])
    assert.equal(discussions[1].input.roleModels.preflight, PROVIDER_MODELS[0])
    const pending = post('/api/cycle', { date: DATE, iso_week: WEEK }); await started
    assert.equal(Object.isFrozen(snapshots[1].roleModels), true)
    for (const [role, model] of Object.entries(suggested)) assert.equal(snapshots[1].roleModels[role], model)
    assert.equal((await post('/api/models', { role_models: { reviewer: PROVIDER_MODELS[0] } })).status, 409)
    assert.equal((await configureProvider(info, session)).status, 409)
    assert.equal((await post('/api/strategy/discuss', { message: 'switch now' })).status, 409)
    release(); assert.equal((await pending).json.reused, true)
  } finally { await service.stop() }
})

test('invalid model suggestions and expired discussions do not mutate model settings', async () => {
  let clock = Date.now()
  let output = { reply: 'safe', suggested_role_models: { admin: PROVIDER_MODELS[0] } }
  let expire = false
  const { service, info } = await startService({ now: () => clock, adapters: { validateProviderConfig: async () => ({ ok: true }), discussStrategy: async () => { if (expire) clock += SESSION_TTL_MS; return output } } })
  try {
    const session = await openSession(info); await configureProvider(info, session)
    const post = (body) => httpRequest(info, '/api/strategy/discuss', { method: 'POST', body, ...session })
    for (const suggestion of [{ admin: PROVIDER_MODELS[0] }, { reviewer: 'unknown-model' }, { reviewer: PROVIDER_KEY }]) {
      output = { reply: 'safe', suggested_role_models: suggestion }
      const result = await post({ message: 'review models' })
      assert.equal(result.status, 502)
      assert.equal(result.text.includes(PROVIDER_KEY), false)
      assert.deepEqual((await httpRequest(info, '/api/models', session)).json.role_models, {})
      assert.deepEqual((await httpRequest(info, '/api/strategy', session)).json.discussion, [])
    }
    expire = true; output = { reply: 'safe', suggested_role_models: { reviewer: PROVIDER_MODELS[1] } }
    assert.equal((await post({ message: 'review models' })).status, 401)
    assert.equal((await httpRequest(info, '/api/models', session)).status, 401)
  } finally { await service.stop() }
})

test('clearing a connection preserves the declared bootstrap model and applied role overrides', async () => {
  const { service, info } = await startService()
  try {
    const session = await openSession(info, { knownPool: true })
    await configureProvider(info, session, { ...PROVIDER_BODY, model: PROVIDER_MODELS[1] })
    await httpRequest(info, '/api/models', { method: 'POST', body: { role_models: { reviewer: PROVIDER_MODELS[3] } }, ...session })
    assert.equal((await httpRequest(info, '/api/models', session)).json.effective_models.orchestrator, PROVIDER_MODELS[1])
    await httpRequest(info, '/api/provider/clear', { method: 'POST', body: {}, ...session })
    const models = (await httpRequest(info, '/api/models', session)).json
    assert.equal(models.default_model, PROVIDER_MODELS[1])
    assert.equal(models.effective_models.orchestrator, PROVIDER_MODELS[1])
    assert.equal(models.effective_models.reviewer, PROVIDER_MODELS[3])
  } finally { await service.stop() }
})

test('Astra defaults and explicit effort suggestions remain atomic, frozen, and session-local', async () => {
  const defaults = { orchestrator: 'high', preflight: 'medium', 'btc-analyst': 'high', 'eth-analyst': 'high', synthesizer: 'high', reviewer: 'xhigh' }
  const suggested = { orchestrator: 'medium', reviewer: 'high' }
  const discussionEfforts = []
  let release
  let entered
  let snapshot
  const started = new Promise((resolve) => { entered = resolve })
  const { service, info } = await startService({ adapters: { validateProviderConfig: async () => ({ ok: true }), discussStrategy: async (input, runtime) => { discussionEfforts.push(runtime.effort); assert.equal(runtime.model, PROVIDER_MODELS[0]); assert.equal(input.roleEfforts.orchestrator, runtime.effort); return { reply: '仅为 fixture 建议，尚未应用。', suggested_role_efforts: suggested } }, runCycle: async (_, runtime) => { snapshot = runtime; entered(); await new Promise((resolve) => { release = resolve }); return { outcome: 'NO_ACTION' } } } })
  try {
    const session = await openSession(info); await configureProvider(info, session)
    const post = (route, body) => httpRequest(info, route, { method: 'POST', body, ...session })
    const initial = (await httpRequest(info, '/api/models', session)).json
    assert.equal(initial.default_model, PROVIDER_MODELS[0])
    assert.ok(Object.values(initial.effective_models).every((model) => model === PROVIDER_MODELS[0]))
    assert.deepEqual(initial.effective_efforts, defaults)
    assert.deepEqual(initial.allowed_efforts, ['medium', 'high', 'xhigh'])
    const discussion = await post('/api/strategy/discuss', { message: '调整主 Agent 和复核 effort。' })
    assert.deepEqual(discussion.json.suggested_role_efforts, suggested)
    assert.deepEqual((await httpRequest(info, '/api/models', session)).json.role_efforts, {})
    for (const body of [{ role_efforts: { reviewer: 'invalid' } }, { role_efforts: { reviewer: null } }, { role_efforts: { admin: 'high' } }, { role_models: { reviewer: PROVIDER_MODELS[0] }, role_efforts: { reviewer: 1 } }, { role_efforts: suggested, permissions: ['execute'] }, { role_efforts: { reviewer: PROVIDER_KEY } }]) {
      const rejected = await post('/api/models', body)
      assert.equal(rejected.status, 400)
      assert.equal(rejected.text.includes(PROVIDER_KEY), false)
      assert.deepEqual((await httpRequest(info, '/api/models', session)).json, initial)
    }
    assert.equal((await post('/api/models', { role_efforts: suggested })).status, 200)
    await post('/api/strategy/discuss', { message: '确认主 Agent effort。' })
    assert.deepEqual(discussionEfforts, ['high', 'medium'])
    const pending = post('/api/cycle', { date: DATE, iso_week: WEEK }); await started
    assert.deepEqual(snapshot.roleEfforts, { ...defaults, ...suggested })
    assert.equal(Object.isFrozen(snapshot.roleEfforts), true)
    assert.ok(Object.values(snapshot.roleModels).every((model) => model === PROVIDER_MODELS[0]))
    assert.equal((await post('/api/models', { role_efforts: { reviewer: 'xhigh' } })).status, 409)
    release(); assert.equal((await pending).status, 200)
    await post('/api/logout', {})
    assert.equal((await httpRequest(info, '/api/models', session)).status, 401)
  } finally { await service.stop() }
})

test('invalid or late effort suggestions cannot apply configuration or revive an expired session', async () => {
  let clock = Date.now()
  let output = { reply: 'safe', suggested_role_efforts: { reviewer: 'invalid' } }
  let expire = false
  const { service, info } = await startService({ now: () => clock, adapters: { validateProviderConfig: async () => ({ ok: true }), discussStrategy: async () => { if (expire) clock += SESSION_TTL_MS; return output } } })
  try {
    const session = await openSession(info); await configureProvider(info, session)
    const post = () => httpRequest(info, '/api/strategy/discuss', { method: 'POST', body: { message: '修改 effort。' }, ...session })
    assert.equal((await post()).status, 502)
    assert.deepEqual((await httpRequest(info, '/api/models', session)).json.role_efforts, {})
    assert.deepEqual((await httpRequest(info, '/api/strategy', session)).json.discussion, [])
    output = { reply: 'safe', suggested_role_efforts: { reviewer: 'high' } }; expire = true
    assert.equal((await post()).status, 401)
    assert.equal((await httpRequest(info, '/api/models', session)).status, 401)
  } finally { await service.stop() }
})

const CONVERSATION_PAPER = Object.freeze({ configured_leverage: '2', risk_per_trade_bps: '25.125', max_order_notional_usdt: '100', daily_new_notional_cap_usdt: '250', max_managed_notional_usdt: '500', initial_usdt: '1000.123456789012345678', daily_loss_bps: '100', max_drawdown_bps: '300', max_spread_bps: '12.5', max_entry_distance_bps: '40', trigger_slippage_bps: '5.125' })
async function conversationService(t, { reply, writeJson, now } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-conversation-')))
  const active = path.join(root, 'data/paper/active.json'); const local = path.join(root, 'config/tyche.local.json')
  writeJsonAtomic(path.join(root, 'config/tyche.json'), loadConfig())
  const setup = createPaperSetupAdapter({ root, ...(writeJson ? { writeJson: (file, value, options) => writeJson(file, value, options, { active, local }) } : {}) })
  const inputs = []; const runtimes = []
  const created = await startService({ ...(now ? { now } : {}), adapters: { validateProviderConfig: async () => ({ ok: true }), paperSetupStatus: setup.status, setupPaper: setup.setup, discussStrategy: async (input, runtime) => { inputs.push(structuredClone(input)); return reply(input, runtime) }, runCycle: async (_, runtime) => { runtimes.push({ strategy: runtime.strategyPrompt, models: runtime.roleModels, efforts: runtime.roleEfforts }); return { outcome: 'NO_ACTION' } } } })
  t.after(async () => { await created.service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  const session = await openSession(created.info, { knownPool: true })
  const post = (route, body) => httpRequest(created.info, route, { method: 'POST', body, ...session })
  const get = (route) => httpRequest(created.info, route, session)
  assert.equal((await configureProvider(created.info, session)).status, 200)
  return { ...created, session, post, get, root, local, active, inputs, runtimes, setup, discuss: (message) => post('/api/strategy/discuss', { message }) }
}

test('conversation retains partial preferences across history truncation and atomically applies the selected previous draft', async (t) => {
  let output = { intent: 'clarify', reply: '已记住虚拟资金。', questions: ['更偏好谨慎还是趋势观察？'], preferences: '虚拟资金，观察 BTC/ETH 趋势。', paper_settings: { initial_usdt: CONVERSATION_PAPER.initial_usdt }, suggested_prompt: 'BTC/ETH compare dated trends.' }
  const f = await conversationService(t, { reply: () => output })
  let response = await f.discuss('用这些虚拟资金了解 BTC 和 ETH。')
  assert.equal(response.json.application.status, 'pending'); assert.equal(fs.existsSync(f.active), false)
  output = { intent: 'configure', apply_fields: ['theme'], reply: '请求切换深色。', theme: 'night' }
  response = await f.discuss('先把界面改深色。')
  assert.equal(response.json.settings.theme, 'night'); assert.equal(response.json.settings.draft.paper_settings.initial_usdt, CONVERSATION_PAPER.initial_usdt); assert.equal(fs.existsSync(f.active), false)
  output = { intent: 'explain', reply: '这是模拟，不是实际账户。' }
  for (let index = 0; index < 4; index++) await f.discuss('解释模拟的含义。')
  const { initial_usdt, ...remaining } = CONVERSATION_PAPER
  output = { intent: 'configure', apply_fields: ['paper_settings', 'suggested_prompt', 'suggested_role_models', 'suggested_role_efforts'], reply: '按先前目标安排模拟起点。', assumptions: ['风险限额仅为可观察的模拟起点，不代表真实风险偏好。'], paper_settings: remaining, suggested_role_models: { 'btc-analyst': PROVIDER_MODELS[2] }, suggested_role_efforts: { orchestrator: 'medium' } }
  response = await f.discuss('我不确定，就按前面的设置，其余由你安排。')
  assert.equal(response.status, 200); assert.equal(response.json.application.status, 'applied', response.text)
  const last = f.inputs.at(-1)
  assert.equal(last.history.length, 8); assert.equal(last.history.some((item) => item.content.includes('用这些虚拟资金')), false)
  assert.equal(last.settingsDraft.paper_settings.initial_usdt, initial_usdt); assert.equal(last.preferences, '虚拟资金，观察 BTC/ETH 趋势。')
  assert.deepEqual(response.json.settings.paper.values, CONVERSATION_PAPER); assert.deepEqual(response.json.settings.draft, {})
  const ledger = JSON.parse(fs.readFileSync(f.active)); const config = JSON.parse(fs.readFileSync(f.local))
  for (const [key, value] of Object.entries(CONVERSATION_PAPER)) assert.equal(String(key in ledger.policy ? ledger.policy[key] : config.gate.usdm[key]), value)
  assert.equal(config.gate.submission_mode, 'locked'); assert.equal(config.gate.usdm.environment, 'dry-run')
  await f.post('/api/cycle', { date: DATE, iso_week: WEEK })
  assert.equal(f.runtimes[0].strategy, 'BTC/ETH compare dated trends.'); assert.equal(f.runtimes[0].models['btc-analyst'], PROVIDER_MODELS[2]); assert.equal(f.runtimes[0].efforts.orchestrator, 'medium')
  const bytes = fs.readFileSync(f.active, 'utf8')
  output = { intent: 'explain', reply: '当前设置如下。', suggested_prompt: 'must not apply', paper_settings: { initial_usdt: '5000' }, theme: 'light' }
  response = await f.discuss('只解释现有参数。')
  assert.equal(response.json.application.status, 'unchanged'); assert.equal(response.json.settings.prompt, 'BTC/ETH compare dated trends.'); assert.equal(response.json.settings.theme, 'night'); assert.equal(fs.readFileSync(f.active, 'utf8'), bytes)
})

test('invalid conversational candidates never partially apply and existing Paper conflicts preserve every setting', async (t) => {
  let output
  const f = await conversationService(t, { reply: () => output })
  for (const invalid of [{ configured_leverage: '1.0000000000000000001' }, { risk_per_trade_bps: '10000.000000000000000001' }, { max_order_notional_usdt: '500.000000000000000001' }, { initial_usdt: '0' }, { execute: true }]) {
    output = { intent: 'configure', apply_fields: ['paper_settings', 'theme'], reply: 'proposal', theme: 'light', paper_settings: { ...CONVERSATION_PAPER, ...invalid } }
    assert.equal((await f.discuss('安排模拟。')).status, 502)
    assert.equal((await f.get('/api/strategy')).json.theme, 'night'); assert.equal(fs.existsSync(f.active), false); assert.equal(fs.existsSync(f.local), false)
  }
  for (const invalid of [{ intent: 'configure', reply: '没有设置' }, { intent: 'configure', reply: '未知范围', apply_fields: ['execute'] }, { intent: 'configure', reply: '未知字段', apply_fields: ['theme'], theme: 'light', credentials: 'bad' }]) { output = invalid; assert.equal((await f.discuss('调整。')).status, 502) }
  f.setup.setup(CONVERSATION_PAPER); const before = fs.readFileSync(f.active, 'utf8')
  output = { intent: 'configure', apply_fields: ['paper_settings', 'theme', 'suggested_prompt'], reply: 'requested', theme: 'light', suggested_prompt: 'must not apply', paper_settings: { initial_usdt: '2000' } }
  const conflict = await f.discuss('提高虚拟资金并改主题策略。')
  assert.equal(conflict.json.application.status, 'failed'); assert.equal(conflict.json.application.code, 'CONTROL_PAPER_SETTING_CONFLICT'); assert.equal(conflict.json.questions.length, 1)
  assert.equal(conflict.json.settings.theme, 'night'); assert.equal(conflict.json.settings.prompt, ''); assert.equal(fs.readFileSync(f.active, 'utf8'), before)
  const changed = JSON.parse(fs.readFileSync(f.local)); changed.analysis.minimum_rr = 2; writeJsonAtomic(f.local, changed)
  output = { intent: 'configure', apply_fields: ['theme'], reply: '只调整主题。', theme: 'light' }
  const independent = await f.discuss('只改浅色。')
  assert.equal(independent.json.application.status, 'applied'); assert.equal(independent.json.settings.theme, 'light'); assert.equal(independent.json.settings.paper.status, 'blocked'); assert.equal(fs.readFileSync(f.active, 'utf8'), before)
})

test('Paper IO failure and TTL expiry at the synchronous commit point roll back files and session settings', async (t) => {
  for (const failure of ['io', 'expiry']) {
    let clock = Date.now()
    const output = { intent: 'configure', apply_fields: ['paper_settings', 'theme', 'suggested_prompt', 'suggested_role_efforts'], reply: 'proposed', theme: 'light', suggested_prompt: 'BTC/ETH dated trends.', suggested_role_efforts: { orchestrator: 'medium' }, paper_settings: CONVERSATION_PAPER }
    const f = await conversationService(t, { now: () => clock, reply: () => output, writeJson(file, value, options, { active }) { if (file === active && failure === 'io') throw new Error(PROVIDER_KEY); writeJsonAtomic(file, value, options); if (file === active && failure === 'expiry') clock += SESSION_TTL_MS } })
    const response = await f.discuss('由你安排模拟起点。')
    assert.equal(fs.existsSync(f.active), false); assert.equal(fs.existsSync(f.local), false); assert.equal(response.text.includes(PROVIDER_KEY), false)
    if (failure === 'expiry') { assert.equal(response.status, 401); assert.equal((await f.get('/api/strategy')).status, 401) }
    else { assert.equal(response.json.application.status, 'failed'); assert.equal(response.json.settings.prompt, ''); assert.equal(response.json.settings.theme, 'night'); assert.equal(response.json.settings.models.effective_efforts.orchestrator, 'high') }
  }
})

test('busy or expired discussions cannot write conversational Paper settings or revive session memory', async (t) => {
  for (const expiry of [false, true]) {
    let release; let entered; let clock = Date.now()
    const started = new Promise((resolve) => { entered = resolve })
    const f = await conversationService(t, { now: () => clock, reply: async () => { entered(); return new Promise((resolve) => { release = resolve }) } })
    const pending = f.discuss('由你安排。'); await started
    for (const [route, body] of [['/api/provider/clear', {}], ['/api/models', { role_efforts: { orchestrator: 'medium' } }], ['/api/paper/setup', CONVERSATION_PAPER], ['/api/cycle', { date: DATE, iso_week: WEEK }]]) assert.equal((await f.post(route, body)).status, 409)
    if (expiry) clock += SESSION_TTL_MS
    else assert.equal((await f.post('/api/logout', {})).status, 200)
    release({ intent: 'configure', apply_fields: ['paper_settings', 'theme'], reply: 'proposed', paper_settings: CONVERSATION_PAPER, theme: 'night' })
    assert.equal((await pending).status, 401); assert.equal(fs.existsSync(f.active), false); assert.equal(fs.existsSync(f.local), false)
  }
})

test('new durable conversation fields reject secrets and maximal replies leave valid bounded history', async (t) => {
  let output
  const f = await conversationService(t, { reply(input) { assert.ok(input.history.every((item) => item.content.length <= 8000)); return output } })
  for (const where of ['preferences', 'assumptions', 'questions', 'paper_settings']) {
    output = { reply: 'safe', intent: 'clarify', [where]: ['assumptions', 'questions'].includes(where) ? [PROVIDER_KEY] : where === 'paper_settings' ? { [PROVIDER_KEY]: '1' } : PROVIDER_KEY }
    const response = await f.discuss('讨论。'); assert.equal(response.status, 502); assert.equal(response.text.includes(PROVIDER_KEY), false)
    assert.deepEqual((await f.get('/api/strategy')).json.draft, {})
  }
  output = { reply: 'r'.repeat(8000), intent: 'clarify', questions: ['q'.repeat(240), 'q'.repeat(240)], assumptions: Array(6).fill('a'.repeat(400)), preferences: 'lasting goal' }
  assert.equal((await f.discuss('保留这些目标。')).status, 200)
  output = { reply: 'next turn', intent: 'explain' }
  assert.equal((await f.discuss('继续。')).status, 200)
  assert.equal(f.inputs.at(-1).preferences, 'lasting goal')
  for (const apiKey of ['future\"draft-key', 'future\\draft-key']) {
    output = { intent: 'clarify', reply: 'recorded', preferences: apiKey, suggested_prompt: `BTC/ETH context ${apiKey}` }
    assert.equal((await f.discuss('记住偏好。')).status, 200)
    const replacement = await f.post('/api/provider', { ...PROVIDER_BODY, api_key: apiKey })
    assert.equal(replacement.status, 400); assert.equal(replacement.text.includes(apiKey), false)
    assert.equal((await f.get('/api/provider')).json.configured, true)
  }
})

test('sparse role changes consume only named roles and explicit reuse applies the retained model and effort draft', async (t) => {
  let output = { intent: 'clarify', reply: '先保留 BTC 草稿。', suggested_role_models: { 'btc-analyst': PROVIDER_MODELS[2] }, suggested_role_efforts: { 'btc-analyst': 'medium' } }
  const f = await conversationService(t, { reply: () => output })
  await f.discuss('先讨论 BTC 模型和 effort，暂不应用。')
  output = { intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts'], reply: '本轮只改复核。', suggested_role_models: { reviewer: PROVIDER_MODELS[2] }, suggested_role_efforts: { reviewer: 'high' } }
  const response = await f.discuss('仅修改 reviewer。')
  assert.equal(response.json.application.status, 'applied')
  const state = response.json.settings
  assert.equal(state.models.effective_models.reviewer, PROVIDER_MODELS[2]); assert.equal(state.models.effective_efforts.reviewer, 'high')
  assert.equal(state.models.effective_models['btc-analyst'], PROVIDER_MODELS[0]); assert.equal(state.models.effective_efforts['btc-analyst'], 'high')
  assert.deepEqual(state.draft.suggested_role_models, { 'btc-analyst': PROVIDER_MODELS[2] }); assert.deepEqual(state.draft.suggested_role_efforts, { 'btc-analyst': 'medium' })
  f.setup.setup(CONVERSATION_PAPER)
  await f.post('/api/cycle', { date: DATE, iso_week: WEEK })
  assert.equal(f.runtimes[0].models['btc-analyst'], PROVIDER_MODELS[0]); assert.equal(f.runtimes[0].efforts['btc-analyst'], 'high')
  output = { intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts'], reply: '现在使用保留的 BTC 草稿。' }
  const reused = await f.discuss('现在应用前面的 BTC 模型和 effort 草稿。')
  assert.equal(reused.json.application.status, 'applied'); assert.deepEqual(reused.json.settings.draft, {})
  assert.equal(reused.json.settings.models.effective_models['btc-analyst'], PROVIDER_MODELS[2]); assert.equal(reused.json.settings.models.effective_efforts['btc-analyst'], 'medium')
  assert.equal(reused.json.settings.models.effective_models.reviewer, PROVIDER_MODELS[2]); assert.equal(reused.json.settings.models.effective_efforts.reviewer, 'high')
})

test('incomplete Paper updates preserve out-of-scope strategy drafts until the complete candidate explicitly consumes them', async (t) => {
  let output = { intent: 'clarify', reply: '记住策略和资金。', suggested_prompt: 'BTC/ETH preserve this dated strategy.', paper_settings: { initial_usdt: CONVERSATION_PAPER.initial_usdt } }
  const f = await conversationService(t, { reply: () => output })
  await f.discuss('先记住这些设想。')
  output = { intent: 'configure', apply_fields: ['paper_settings'], reply: '只补充杠杆。', paper_settings: { configured_leverage: CONVERSATION_PAPER.configured_leverage } }
  const incomplete = await f.discuss('模拟杠杆用两倍，其他还没想好。')
  assert.equal(incomplete.json.application.status, 'pending'); assert.equal(fs.existsSync(f.active), false)
  assert.equal(incomplete.json.settings.draft.suggested_prompt, 'BTC/ETH preserve this dated strategy.')
  assert.deepEqual(incomplete.json.settings.draft.paper_settings, { initial_usdt: CONVERSATION_PAPER.initial_usdt, configured_leverage: CONVERSATION_PAPER.configured_leverage })
  const { initial_usdt, configured_leverage, ...missing } = CONVERSATION_PAPER
  output = { intent: 'configure', apply_fields: ['paper_settings', 'suggested_prompt'], reply: '补齐并使用原策略。', paper_settings: missing }
  const ready = await f.discuss('就按前面的设置，补齐其余模拟参数。')
  assert.equal(ready.json.application.status, 'applied'); assert.deepEqual(ready.json.settings.paper.values, CONVERSATION_PAPER)
  assert.equal(ready.json.settings.prompt, 'BTC/ETH preserve this dated strategy.'); assert.deepEqual(ready.json.settings.draft, {})
})

test('empty role maps never consume drafts and unchanged effective settings are reported without a new modification', async (t) => {
  let output
  const f = await conversationService(t, { reply: () => output })
  for (const hasDraft of [false, true]) {
    if (hasDraft) { output = { intent: 'clarify', reply: '待讨论。', suggested_role_models: { 'btc-analyst': PROVIDER_MODELS[2] }, suggested_role_efforts: { 'btc-analyst': 'medium' } }; await f.discuss('记住 BTC 草稿。') }
    for (const field of ['suggested_role_models', 'suggested_role_efforts']) {
      const before = (await f.get('/api/strategy')).json; const models = (await f.get('/api/models')).json
      output = { intent: 'configure', apply_fields: [field], reply: 'empty', [field]: {} }
      assert.equal((await f.discuss('调整配置。')).status, 502)
      assert.deepEqual((await f.get('/api/strategy')).json, before); assert.deepEqual((await f.get('/api/models')).json, models)
    }
  }
  f.setup.setup(CONVERSATION_PAPER); const bytes = fs.readFileSync(f.active, 'utf8'); const previousModels = (await f.get('/api/models')).json
  output = { intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts', 'suggested_prompt', 'theme', 'paper_settings'], reply: '保持当前实际配置。', suggested_role_models: { reviewer: PROVIDER_MODELS[0] }, suggested_role_efforts: { reviewer: 'xhigh' }, suggested_prompt: '', theme: 'night', paper_settings: { initial_usdt: CONVERSATION_PAPER.initial_usdt } }
  const same = await f.discuss('仍使用当前配置。')
  assert.equal(same.json.application.status, 'unchanged'); assert.deepEqual(same.json.settings.models, previousModels); assert.equal(fs.readFileSync(f.active, 'utf8'), bytes)
  assert.deepEqual(same.json.settings.draft, { suggested_role_models: { 'btc-analyst': PROVIDER_MODELS[2] }, suggested_role_efforts: { 'btc-analyst': 'medium' } })
})

const CUSTOM_POOL = Object.freeze([{ id: 'custom-fast', efforts: ['medium', 'high'] }, { id: 'custom-review', efforts: ['high', 'xhigh'] }])
const POOL_ROLES = ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer']
const fullChoices = (value) => Object.fromEntries(POOL_ROLES.map((role) => [role, value]))
function poolReply(output) {
  const item = { id: 'msg_pool', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }
  return new Response([{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_pool', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

test('custom-only first connection allocates through the declared main model and freezes the complete pool for cycles', async () => {
  const models = { ...fullChoices('custom-review'), preflight: 'custom-fast', 'btc-analyst': 'custom-fast' }
  const efforts = { ...fullChoices('high'), preflight: 'medium', reviewer: 'xhigh' }
  let output = { intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts'], reply: '依职责进行分配。', suggested_role_models: models, suggested_role_efforts: efforts, allocation_reasons: Object.fromEntries(POOL_ROLES.map((role) => [role, `${role} 使用声明池中的对应能力。`])) }
  const sent = []; let captured; let release; let entered
  const started = new Promise((resolve) => { entered = resolve })
  const lookup = async () => [{ address: [93, 184, 216, 34].join('.'), family: 4 }]
  const { service, info } = await startService({ adapters: {
    validateProviderConfig: async (runtime) => { await createSessionProviderRuntime({ endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), modelId: runtime.model, modelPool: runtime.modelPool, lookup }); return true },
    discussStrategy: (input, runtime) => discussSessionStrategy(input, { endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), modelId: runtime.model, effort: runtime.effort, modelPool: runtime.modelPool, lookup, fetchImpl: async (_, init) => { sent.push(JSON.parse(init.body)); return poolReply(output) } }),
    runCycle: async (_, runtime) => { captured = runtime; entered(); await new Promise((resolve) => { release = resolve }); return { outcome: 'NO_ACTION' } }
  } })
  try {
    const session = await openSession(info); const post = (route, body) => httpRequest(info, route, { method: 'POST', body, ...session }); const get = (route) => httpRequest(info, route, session)
    const initial = (await get('/api/models')).json; assert.deepEqual(initial.pool.map(({ id }) => id), [PROVIDER_MODELS[0]]); assert.equal(initial.allocation_source, 'default')
    let config = await post('/api/models', { pool: CUSTOM_POOL, mode: 'auto', bootstrap: { model: 'custom-fast', effort: 'medium' } })
    assert.equal(config.status, 200); assert.equal(config.json.allocation_state, 'pending'); assert.equal((await get('/api/provider')).json.configured, false)
    assert.equal((await configureProvider(info, session, { ...PROVIDER_BODY, model: 'custom-fast' })).status, 200)
    assert.equal((await post('/api/cycle', { date: DATE, iso_week: WEEK })).status, 409)
    const allocation = await post('/api/strategy/discuss', { message: '按任务职责分配。', allocate: true })
    assert.equal(allocation.status, 200, allocation.text); assert.equal(allocation.json.settings.models.allocation_source, 'agent'); assert.equal(allocation.json.settings.models.allocation_state, 'ready'); assert.deepEqual(allocation.json.settings.models.effective_models, models)
    assert.equal(sent[0].model, 'custom-fast'); assert.equal(sent[0].reasoning.effort, 'medium'); assert.equal(JSON.stringify(sent[0]).includes(PROVIDER_KEY), false)
    output = { intent: 'explain', reply: '分配保持不变。' }
    assert.equal((await post('/api/strategy/discuss', { message: '只解释。' })).status, 200)
    assert.equal(sent[1].model, 'custom-review'); assert.equal(sent[1].reasoning.effort, 'high')
    const pending = post('/api/cycle', { date: DATE, iso_week: WEEK }); await started
    assert.deepEqual(captured.modelPool, CUSTOM_POOL); assert.equal(Object.isFrozen(captured.modelPool[0].efforts), true); assert.equal(captured.modelMode, 'auto'); assert.deepEqual(captured.roleModels, models)
    assert.equal((await post('/api/models', { pool: [{ id: 'custom-review', efforts: ['high', 'xhigh'] }], bootstrap: { model: 'custom-review', effort: 'high' } })).status, 409)
    release(); assert.equal((await pending).status, 200); assert.ok(captured.apiKey.every((byte) => byte === 0))
    config = await post('/api/models', { mode: 'manual', role_models: fullChoices('custom-fast'), role_efforts: fullChoices('medium') })
    assert.equal(config.status, 200); assert.equal(config.json.mode, 'manual'); assert.equal(config.json.allocation_source, 'user')
    assert.equal((await post('/api/strategy/discuss', { message: '分配', allocate: true })).status, 409)
    output = { intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts'], reply: 'must not overwrite manual', suggested_role_models: { reviewer: 'custom-review' }, suggested_role_efforts: { reviewer: 'high' } }
    assert.equal((await post('/api/strategy/discuss', { message: '讨论其他目标。' })).status, 409)
    output = { intent: 'configure', apply_fields: ['theme'], reply: '只改深色。', theme: 'night' }
    assert.equal((await post('/api/strategy/discuss', { message: '深色。' })).json.settings.theme, 'night'); assert.deepEqual((await get('/api/models')).json.effective_models, fullChoices('custom-fast'))
    config = await post('/api/models', { pool: [{ id: 'custom-review', efforts: ['high', 'xhigh'] }], bootstrap: { model: 'custom-review', effort: 'high' } })
    assert.equal(config.json.allocation_state, 'blocked'); assert.equal((await post('/api/cycle', { date: DATE, iso_week: WEEK })).status, 409)
    output = { intent: 'explain', reply: '需要修正手动选择。' }; assert.equal((await post('/api/strategy/discuss', { message: '为什么阻断？' })).status, 200)
    assert.equal(sent.at(-1).model, 'custom-review'); assert.equal(sent.at(-1).reasoning.effort, 'high')
    await post('/api/logout', {}); assert.equal((await get('/api/models')).status, 401)
  } finally { await service.stop() }
})

test('pool updates invalidate only incompatible model drafts and reject invalid compound settings without partial updates', async (t) => {
  let output = { intent: 'clarify', reply: '保留草稿。', suggested_role_models: { 'btc-analyst': PROVIDER_MODELS[2] }, suggested_role_efforts: { 'btc-analyst': 'medium' }, suggested_prompt: 'BTC/ETH preserve strategy.', paper_settings: { initial_usdt: '1000' } }
  const f = await conversationService(t, { reply: () => output })
  await f.discuss('记住这些设置。')
  const before = (await f.get('/api/models')).json
  for (const input of [{ pool: [] }, { pool: [{ ...CUSTOM_POOL[0], headers: {} }] }, { pool: CUSTOM_POOL, mode: 'manual', bootstrap: { model: 'custom-fast', effort: 'medium' }, role_models: { reviewer: 'custom-review' }, role_efforts: { reviewer: 'xhigh' } }, { pool: CUSTOM_POOL, bootstrap: { model: 'custom-fast', effort: 'xhigh' } }, { pool: [{ id: PROVIDER_KEY, efforts: ['high'] }], bootstrap: { model: PROVIDER_KEY, effort: 'high' } }]) {
    assert.equal((await f.post('/api/models', input)).status, 400); assert.deepEqual((await f.get('/api/models')).json, before)
  }
  const changed = await f.post('/api/models', { pool: [{ id: PROVIDER_MODELS[0], efforts: ['medium', 'high', 'xhigh'] }], mode: 'manual' })
  assert.equal(changed.status, 200); assert.match(changed.json.draft_notice, /草稿已清除/)
  const draft = (await f.get('/api/strategy')).json.draft; assert.deepEqual(draft, { suggested_prompt: 'BTC/ETH preserve strategy.', paper_settings: { initial_usdt: '1000' } })
  output = { intent: 'explain', reply: '可以继续。' }; assert.equal((await f.discuss('解释。')).status, 200)
  output = { intent: 'configure', apply_fields: ['theme'], reply: '深色。', theme: 'night' }; assert.equal((await f.discuss('只改主题。')).status, 200)
  await f.post('/api/models', { mode: 'auto' }); assert.deepEqual((await f.get('/api/strategy')).json.draft, draft); assert.equal(fs.existsSync(f.active), false)
  const future = 'future-custom-secret'
  assert.equal((await f.post('/api/models', { pool: [{ id: future, efforts: ['medium'] }], bootstrap: { model: future, effort: 'medium' } })).status, 200)
  const replacement = await f.post('/api/provider', { ...PROVIDER_BODY, model: future, api_key: future }); assert.equal(replacement.status, 400); assert.equal(replacement.text.includes(future), false)
})

test('auto pool additions remain pending despite valid prior roles until the main Agent returns all six assignments', async (t) => {
  let output = { intent: 'explain', reply: '原映射仍可参考，但尚未完成新池分配。' }
  const f = await conversationService(t, { reply: () => output })
  f.setup.setup(CONVERSATION_PAPER)
  const previous = (await f.get('/api/models')).json
  const pool = [...previous.pool, { id: 'extra-declared-model', efforts: ['medium', 'high'] }]
  const changed = await f.post('/api/models', { pool })
  assert.equal(changed.status, 200); assert.equal(changed.json.mode, 'auto'); assert.equal(changed.json.allocation_state, 'pending'); assert.deepEqual(changed.json.effective_models, previous.effective_models)
  assert.equal((await f.post('/api/cycle', { date: DATE, iso_week: WEEK })).status, 409)
  await f.discuss('只解释新池。'); assert.equal((await f.get('/api/models')).json.allocation_state, 'pending')
  output = { intent: 'configure', apply_fields: ['suggested_role_models'], reply: '不完整的分配。', suggested_role_models: { reviewer: PROVIDER_MODELS[0] } }
  assert.equal((await f.post('/api/strategy/discuss', { message: '分配', allocate: true })).status, 502); assert.equal((await f.get('/api/models')).json.allocation_state, 'pending')
  output = { intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts'], reply: '分析职责仍适合原角色配置。', suggested_role_models: previous.effective_models, suggested_role_efforts: previous.effective_efforts, allocation_reasons: Object.fromEntries(POOL_ROLES.map((role) => [role, `${role} 按当前职责保留选择。`])) }
  const allocated = await f.post('/api/strategy/discuss', { message: '给出完整分配', allocate: true })
  assert.equal(allocated.status, 200); assert.equal(allocated.json.settings.models.allocation_state, 'ready'); assert.equal(allocated.json.settings.models.allocation_source, 'agent'); assert.equal(allocated.json.application.status, 'unchanged')
  assert.equal((await f.post('/api/cycle', { date: DATE, iso_week: WEEK })).status, 200)
})

test('real discussion and controller reuse only a selected candidate pool while preserving independent drafts', async (t) => {
  const pool = [{ id: 'draft-custom', efforts: ['medium', 'high', 'xhigh'] }]
  const modelSettings = { pool, mode: 'auto', bootstrap: { model: 'draft-custom', effort: 'high' } }
  let output = { intent: 'clarify', reply: '记住原有模拟与策略草稿。', suggested_prompt: 'BTC/ETH preserve independent strategy.', paper_settings: { initial_usdt: '1000' } }
  const f = await conversationService(t, { reply: (input, runtime) => discussSessionStrategy(input, { endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), modelId: runtime.model, effort: runtime.effort, modelPool: runtime.modelPool, lookup: async () => [{ address: [93, 184, 216, 34].join('.'), family: 4 }], fetchImpl: async () => poolReply(output) }) })
  await f.discuss('先保留模拟设想。')
  const originalPool = (await f.get('/api/models')).json.pool
  // Explicit panel declarations are trusted; an LLM suggestion is only a draft.
  const declared = [...originalPool, ...pool, { id: 'mixed-custom', efforts: ['high'] }, { id: 'next-custom', efforts: ['high'] }]
  assert.equal((await f.post('/api/models', { pool: declared })).status, 200)
  output = { intent: 'clarify', reply: '记录新模型池与完整角色草稿。', model_settings: modelSettings, suggested_role_models: fullChoices('draft-custom'), suggested_role_efforts: fullChoices('high') }
  const recorded = await f.discuss('先讨论这个新池。')
  assert.equal(recorded.status, 200, recorded.text); assert.equal(recorded.json.application.status, 'pending'); assert.deepEqual(recorded.json.settings.models.pool, declared)
  output = { intent: 'configure', apply_fields: ['theme'], reply: '只调整主题。', theme: 'night' }
  const theme = await f.discuss('暂不改池，只改深色。')
  assert.equal(theme.status, 200, theme.text); assert.equal(theme.json.settings.theme, 'night'); assert.deepEqual(theme.json.settings.models.pool, declared)
  assert.deepEqual(theme.json.settings.draft.model_settings, modelSettings)
  output = { intent: 'configure', apply_fields: ['model_settings', 'paper_settings'], reply: '不能把新池操作与模拟初始化混合。' }
  assert.equal((await f.discuss('混合范围必须拒绝。')).status, 502); assert.equal(fs.existsSync(f.active), false)
  output = { intent: 'configure', apply_fields: ['model_settings', 'suggested_role_models', 'suggested_role_efforts'], reply: '明确使用新池和六角色草稿。', allocation_reasons: Object.fromEntries(POOL_ROLES.map((role) => [role, `${role} 按当前草稿选择声明能力。`])) }
  const applied = await f.discuss('现在应用前面的模型池和全部角色草稿。')
  assert.equal(applied.status, 200, applied.text); assert.equal(applied.json.settings.models.allocation_state, 'ready'); assert.deepEqual(applied.json.settings.models.pool, pool); assert.deepEqual(applied.json.settings.models.effective_models, fullChoices('draft-custom'))
  assert.deepEqual(applied.json.settings.draft, { suggested_prompt: 'BTC/ETH preserve independent strategy.', paper_settings: { initial_usdt: '1000' } }); assert.equal(fs.existsSync(f.active), false)
  const mixedPool = [{ id: 'mixed-custom', efforts: ['high'] }]
  output = { intent: 'clarify', reply: '记录另一新池草稿。', model_settings: { pool: mixedPool, bootstrap: { model: 'mixed-custom', effort: 'high' } }, suggested_role_models: fullChoices('mixed-custom'), suggested_role_efforts: fullChoices('high') }
  assert.equal((await f.discuss('先保留第二个模型池。')).status, 200)
  output = { intent: 'configure', apply_fields: ['model_settings', 'suggested_role_models', 'suggested_role_efforts'], reply: '复用池，本轮显式提供角色映射。', suggested_role_models: fullChoices('mixed-custom'), suggested_role_efforts: fullChoices('high'), allocation_reasons: Object.fromEntries(POOL_ROLES.map((role) => [role, `${role} 使用已选草稿池。`])) }
  const mixed = await f.discuss('按前面的池，应用本轮角色选择。')
  assert.equal(mixed.status, 200, mixed.text); assert.deepEqual(mixed.json.settings.models.pool, mixedPool); assert.deepEqual(mixed.json.settings.models.effective_models, fullChoices('mixed-custom')); assert.equal(mixed.json.settings.models.allocation_state, 'ready')
  const nextPool = [{ id: 'next-custom', efforts: ['high'] }]
  output = { intent: 'configure', apply_fields: ['model_settings'], reply: '仅更新池，等待新的分配。', model_settings: { pool: nextPool, bootstrap: { model: 'next-custom', effort: 'high' } } }
  const pending = await f.discuss('只更新模型池。')
  assert.equal(pending.status, 200, pending.text); assert.equal(pending.json.settings.models.allocation_state, 'pending'); assert.deepEqual(pending.json.settings.models.pool, nextPool)
  assert.equal(pending.json.settings.models.effective_models.orchestrator, 'mixed-custom'); assert.equal(fs.existsSync(f.active), false)
})

async function anthropicSettingsFixture(t) {
  const opus = 'claude-opus-4-7'
  const sonnet = 'claude-sonnet-4-6'
  const pool = [{ id: opus, efforts: ['medium', 'high', 'xhigh'] }, { id: sonnet, efforts: ['medium', 'high'] }]
  let output = { intent: 'explain', reply: '原连接仍可讨论。' }
  const requests = []
  const connection = (runtime) => ({ protocol: runtime.protocol, modelId: runtime.model, modelPool: runtime.modelPool, effort: runtime.effort, endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), lookup: async () => [{ address: [93, 184, 216, 34].join('.'), family: 4 }], fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://models.example.test/v1/messages')
    assert.equal(new Headers(init.headers).get('x-api-key'), PROVIDER_KEY)
    const body = JSON.parse(init.body)
    requests.push({ model: body.model, effort: body.output_config.effort })
    const events = [{ type: 'message_start', message: { id: 'msg_settings', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(output) } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }, { type: 'message_stop' }]
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const { service, info } = await startService({ adapters: {
    validateProviderConfig: async (runtime) => { await createSessionProviderRuntime(connection(runtime)); return true },
    discussStrategy: (input, runtime) => discussSessionStrategy(input, connection(runtime)),
    paperSetupStatus: async () => ({ ready: false, status: 'required', values: {}, missing: ['initial_usdt'] }),
    setupPaper: () => assert.fail('model configuration must not initialize Paper')
  } })
  t.after(() => service.stop())
  const session = await openSession(info)
  const post = (route, body) => httpRequest(info, route, { ...session, method: 'POST', body })
  const get = (route) => httpRequest(info, route, session)
  assert.equal((await post('/api/models', { pool, mode: 'manual', bootstrap: { model: opus, effort: 'high' }, role_models: fullChoices(opus), role_efforts: fullChoices('high') })).status, 200)
  assert.equal((await post('/api/provider', { ...PROVIDER_BODY, protocol: 'anthropic-messages', model: opus, endpoint: 'https://models.example.test' })).status, 200)
  return { opus, sonnet, pool, requests, post, get, output(value) { output = value }, discuss: () => post('/api/strategy/discuss', { message: '验证明确的模型设置。' }), snapshot: async () => Promise.all(['/api/provider', '/api/models', '/api/strategy'].map(async (route) => (await get(route)).json)) }
}

test('connected Anthropic rejects incompatible whole pools, bootstrap and explicit roles atomically through API and chat', async (t) => {
  const f = await anthropicSettingsFixture(t)
  f.output({ intent: 'clarify', reply: '保留独立草稿。', paper_settings: { initial_usdt: '1000' }, suggested_prompt: 'BTC/ETH preserve independent strategy.' })
  assert.equal((await f.discuss()).status, 200)
  const before = await f.snapshot()
  const cases = [
    { pool: [...f.pool, { id: PROVIDER_MODELS[0], efforts: ['high'] }], mode: 'auto', bootstrap: { model: f.sonnet, effort: 'high' }, role_models: { reviewer: f.sonnet }, role_efforts: { reviewer: 'high' } },
    { pool: f.pool.map((entry) => entry.id === f.sonnet ? { ...entry, efforts: ['medium', 'high', 'xhigh'] } : entry) },
    { pool: [...f.pool, { id: 'claude-haiku-4-5', efforts: ['high'] }] },
    { bootstrap: { model: f.sonnet, effort: 'xhigh' } },
    { bootstrap: { model: PROVIDER_MODELS[0], effort: 'high' } },
    { role_models: { reviewer: f.sonnet }, role_efforts: { reviewer: 'xhigh' } },
    { role_models: { reviewer: PROVIDER_MODELS[0] } }
  ]
  for (const [index, candidate] of cases.entries()) {
    const direct = await f.post('/api/models', candidate)
    assert.equal(direct.status, 400)
    if (index < 3) assert.equal(direct.json.code, 'CONTROL_MODEL_POOL_PROTOCOL_INVALID')
    assert.deepEqual(await f.snapshot(), before)
    const { role_models, role_efforts, ...chatCandidate } = candidate
    f.output({ intent: 'configure', apply_fields: ['model_settings', 'theme', ...(role_models ? ['suggested_role_models'] : []), ...(role_efforts ? ['suggested_role_efforts'] : [])], reply: '整体候选必须拒绝。', theme: 'night', model_settings: chatCandidate, ...(role_models ? { suggested_role_models: role_models } : {}), ...(role_efforts ? { suggested_role_efforts: role_efforts } : {}) })
    const discussion = await f.discuss()
    assert.ok([400, 409, 502].includes(discussion.status), discussion.text)
    if (index < 3) assert.equal(discussion.json.code, 'CONTROL_MODEL_POOL_PROTOCOL_INVALID')
    assert.deepEqual(await f.snapshot(), before)
    assert.equal(discussion.text.includes(PROVIDER_KEY), false)
  }
  f.output({ intent: 'explain', reply: '原连接仍可讨论。' })
  const continued = await f.discuss()
  assert.equal(continued.status, 200, continued.text)
  assert.ok(f.requests.length > cases.length)
  assert.ok(f.requests.every(({ model, effort }) => model === f.opus && effort === 'high'))
  assert.deepEqual((await f.get('/api/provider')).json, before[0])
  assert.deepEqual((await f.get('/api/models')).json, before[1])
  assert.deepEqual(continued.json.settings.draft, before[2].draft)
})

test('connected protocol validation preserves legal pool transitions, pending/blocked roles, drafts and disconnected preparation', async (t) => {
  const f = await anthropicSettingsFixture(t)
  assert.equal((await f.post('/api/models', { mode: 'auto' })).status, 200)
  f.output({ intent: 'clarify', reply: '保留模型与独立草稿。', suggested_role_models: { 'btc-analyst': f.sonnet }, suggested_role_efforts: { 'btc-analyst': 'high' }, paper_settings: { initial_usdt: '1000' }, suggested_prompt: 'BTC/ETH keep strategy draft.' })
  assert.equal((await f.discuss()).status, 200)
  const originalDraft = (await f.get('/api/strategy')).json.draft
  const extra = { id: 'claude-opus-4-8', efforts: ['medium', 'high', 'xhigh'] }
  const added = await f.post('/api/models', { pool: [...f.pool, extra] })
  assert.equal(added.status, 200)
  assert.equal(added.json.allocation_state, 'pending')
  assert.deepEqual(added.json.effective_models, fullChoices(f.opus))
  assert.deepEqual((await f.get('/api/strategy')).json.draft, originalDraft)
  const removed = await f.post('/api/models', { pool: [f.pool[0], extra] })
  assert.equal(removed.status, 200)
  assert.match(removed.json.draft_notice, /草稿已清除/)
  const independentDraft = { paper_settings: originalDraft.paper_settings, suggested_prompt: originalDraft.suggested_prompt }
  assert.deepEqual((await f.get('/api/strategy')).json.draft, independentDraft)
  // A valid chat pool update can change bootstrap without forcing retained old roles valid.
  f.output({ intent: 'configure', apply_fields: ['model_settings'], reply: '更新原生模型池，等待重新分配。', model_settings: { pool: [extra], bootstrap: { model: extra.id, effort: 'high' } } })
  const changed = await f.discuss()
  assert.equal(changed.status, 200, changed.text)
  assert.equal(changed.json.settings.models.allocation_state, 'pending')
  assert.deepEqual(changed.json.settings.models.effective_models, fullChoices(f.opus))
  assert.deepEqual(changed.json.settings.draft, independentDraft)
  const sparse = await f.post('/api/models', { role_models: { reviewer: extra.id }, role_efforts: { reviewer: 'high' } })
  assert.equal(sparse.status, 200)
  assert.equal(sparse.json.allocation_state, 'pending')
  assert.equal((await f.post('/api/models', { mode: 'manual' })).json.allocation_state, 'blocked')
  const ready = await f.post('/api/models', { mode: 'manual', role_models: fullChoices(extra.id), role_efforts: fullChoices('high') })
  assert.equal(ready.status, 200)
  assert.equal(ready.json.allocation_state, 'ready')
  f.output({ intent: 'explain', reply: '合法变更后的连接仍可讨论。' })
  assert.equal((await f.discuss()).status, 200)
  assert.equal(f.requests.at(-1).model, extra.id)
  // Removing a referenced model in manual mode retains old roles and reports blocked.
  const blocked = await f.post('/api/models', { pool: [f.pool[0]], bootstrap: { model: f.opus, effort: 'high' } })
  assert.equal(blocked.status, 200)
  assert.equal(blocked.json.allocation_state, 'blocked')
  assert.deepEqual(blocked.json.effective_models, fullChoices(extra.id))
  assert.equal((await f.post('/api/provider/clear', {})).status, 200)
  const prepared = await f.post('/api/models', { pool: [{ id: PROVIDER_MODELS[0], efforts: ['medium', 'high', 'xhigh'] }], mode: 'auto', bootstrap: { model: PROVIDER_MODELS[0], effort: 'high' } })
  assert.equal(prepared.status, 200)
  assert.equal(prepared.json.allocation_state, 'pending')
  assert.equal((await f.get('/api/provider')).json.configured, false)
  assert.deepEqual((await f.get('/api/strategy')).json.draft, independentDraft)
})


test('Paper scene is authenticated, query-free, explicitly projected and secret-redacted', async () => {
  const f = sceneFixture(); f.fill(f.open()); f.mark()
  const value = projectPaperScene(f.ledger)
  const { service, info } = await startService({ adapters: { validateProviderConfig: async () => ({ ok: true }), paperScene: () => ({ ...value, credentials: PROVIDER_KEY, ledger: f.ledger, events: [{ ...value.events[0], id: PROVIDER_KEY }] }) } })
  try {
    assert.equal((await httpRequest(info, '/api/paper/scene')).status, 401)
    const session = await openSession(info)
    assert.equal((await configureProvider(info, session)).status, 200)
    const result = await httpRequest(info, '/api/paper/scene', session)
    assert.equal(result.status, 200); assert.equal(result.json.environment, 'paper')
    assert.equal(result.json.positions[0].contracts, '5'); assert.equal(result.json.positions[0].unrealized_pnl, '7.5')
    assert.equal(result.json.events[0].id, '[REDACTED]')
    assert.doesNotMatch(result.text, /account_id|credentials|ledger|private_key|source_id|event_hash/)
    assert.ok(!result.text.includes(PROVIDER_KEY))
    assert.equal((await httpRequest(info, '/api/paper/scene?path=anything', session)).status, 400)
    assert.equal((await httpRequest(info, '/api/paper/scene', { ...session, method: 'POST', body: {} })).status, 404)
    assert.equal((await httpRequest(info, '/api/strategy', session)).json.theme, 'night')
  } finally { await service.stop() }
})
