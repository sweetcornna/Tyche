import test from 'node:test'
import assert from 'node:assert/strict'
import { controlApi, isSessionFailure } from '../src/api.js'

test('connection writes protocol, endpoint and explicit key together through the fixed route', async () => {
  const original = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (path, options) => { calls.push({ path, options }); return { ok: true, status: 200, json: async () => ({ configured: true }) } }
    await controlApi.configureProvider({ provider: 'openai-responses-compatible', protocol: 'anthropic-messages', model: 'claude-opus-4-7', endpoint: 'https://models.example.test', apiKey: 'paired-fixture' }, 'csrf-fixture')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, '/api/provider')
    assert.deepEqual(JSON.parse(calls[0].options.body), { provider: 'openai-responses-compatible', protocol: 'anthropic-messages', model: 'claude-opus-4-7', endpoint: 'https://models.example.test', api_key: 'paired-fixture' })
  } finally { globalThis.fetch = original }
})

test('API preserves authentication error identity and never recovers or replays a rejected write', async () => {
  const original = globalThis.fetch
  try {
    for (const [status, code, expected] of [[403, 'CONTROL_CSRF_REJECTED', true], [401, 'CONTROL_SESSION_REQUIRED', true], [403, 'CONTROL_ORIGIN_REJECTED', false], [401, 'CONTROL_BOOTSTRAP_REJECTED', false]]) {
      const calls = []
      globalThis.fetch = async (path, options) => { calls.push({ path, options }); return { ok: false, status, json: async () => ({ code, message: 'fixture rejection' }) } }
      await assert.rejects(controlApi.discussStrategy('unsubmitted-fixture', 'old-fixture'), (error) => error.status === status && error.code === code && isSessionFailure(error) === expected)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].path, '/api/strategy/discuss')
      assert.equal(calls[0].options.headers['X-CSRF-Token'], 'old-fixture')
    }
  } finally { globalThis.fetch = original }
})

test('session recovery is a single header-protected read and authenticated reads remain bound to the page CSRF', async () => {
  const original = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (path, options) => { calls.push({ path, options }); return { ok: true, status: 200, json: async () => ({ csrf_token: 'restored-fixture', expires_at: '2030-01-07T00:15:00Z' }) } }
    assert.equal((await controlApi.resumeSession()).csrf_token, 'restored-fixture')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, '/api/session')
    assert.equal(calls[0].options.body, undefined)
    assert.equal(calls[0].options.cache, 'no-store')
    assert.equal(calls[0].options.headers['X-Tyche-Session'], 'resume')
    for (const method of ['status', 'providerStatus', 'cycle', 'dag', 'paper', 'paperSetup', 'models', 'strategy', 'testnet']) await controlApi[method]('page-fixture')
    assert.ok(calls.slice(1).every(({ options }) => options.headers['X-CSRF-Token'] === 'page-fixture' && options.body === undefined))
  } finally { globalThis.fetch = original }
})
