import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import WebSocket from 'ws'
import {
  ARM_CONFIRMATIONS,
  LOOPBACK_HOST,
  SESSION_TTL_MS,
  MAX_WS_EVENT_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  projectSafe,
  createControlPlane
} from '../src/control-plane.mjs'

const DATE = '2030-01-07'
const WEEK = '2030-W02'

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
    ...overrides
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

test('cycle route has an exact body and runs only through the injected adapter', async () => {
  const { service, info } = await startService()
  try {
    const session = await openSession(info)
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
