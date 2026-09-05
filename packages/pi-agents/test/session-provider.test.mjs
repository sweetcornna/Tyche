import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SESSION_ENDPOINT_BYTES,
  SESSION_API_KEY_ENV,
  SESSION_ENDPOINT_ENV,
  SESSION_MODEL_IDS,
  SESSION_PROVIDER_ID,
  buildWorkerEnv,
  containsSessionSecret,
  createRestrictedSessionFetch,
  createSessionProviderRuntime,
  isPublicSessionAddress,
  makeJob,
  redactSessionSecrets,
  runPiAgentJob,
  validateSessionEndpoint
} from '../src/index.mjs'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'

const PUBLIC_V4 = '93.184.216.34'
const ENDPOINT = 'https://models.example.test/v1'
const API_KEY = 'tyche-session-test-key'

function publicLookup(records = [{ address: PUBLIC_V4, family: 4 }]) {
  return async (hostname, options) => {
    assert.equal(hostname, 'models.example.test')
    assert.deepEqual(options, { all: true })
    return records
  }
}

function sessionJob(overrides = {}) {
  return makeJob({
    jobId: 'session:preflight',
    runId: 'session',
    role: 'preflight',
    asset: null,
    tier: 'daily',
    date: '2030-01-07',
    isoWeek: '2030-W02',
    provider: SESSION_PROVIDER_ID,
    model: 'gpt-5.6-luna',
    attempt: 0,
    timeoutMs: 200,
    input: { evidence: { source: 'fixture' } },
    ...overrides
  })
}

test('session provider and model allowlists are fixed', async () => {
  assert.equal(SESSION_PROVIDER_ID, 'openai-responses-compatible')
  assert.deepEqual(SESSION_MODEL_IDS, ['gpt-5.6-luna', 'gpt-5.6-sol'])
  await assert.rejects(
    createSessionProviderRuntime({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      modelId: 'gpt-5.6-terra',
      lookup: publicLookup(),
      fetchImpl: async () => { throw new Error('must not fetch') }
    }),
    /PI_SESSION_MODEL_NOT_ALLOWED/
  )
})

test('session models safely clone builtin metadata and only replace identity routing fields', async () => {
  const runtime = await createSessionProviderRuntime({
    endpoint: `${ENDPOINT}/`,
    apiKey: API_KEY,
    modelId: 'gpt-5.6-sol',
    lookup: publicLookup(),
    fetchImpl: async () => { throw new Error('injected fetch') }
  })
  const builtin = builtinModels().getModel('openai', 'gpt-5.6-sol')
  const model = runtime.model
  assert.equal(model.id, builtin.id)
  assert.equal(model.api, 'openai-responses')
  assert.equal(model.provider, SESSION_PROVIDER_ID)
  assert.equal(model.baseUrl, ENDPOINT)
  assert.equal(model.name, `${builtin.name} (Tyche session)`)
  assert.deepEqual(model.cost, builtin.cost)
  assert.equal(model.contextWindow, builtin.contextWindow)
  assert.equal(model.maxTokens, builtin.maxTokens)
  assert.equal(Object.isFrozen(model), true)
  assert.equal(Object.isFrozen(model.cost), true)
  assert.deepEqual(runtime.models.getModels(SESSION_PROVIDER_ID).map(({ id }) => id), SESSION_MODEL_IDS)
  assert.equal(runtime.provider.id, SESSION_PROVIDER_ID)
  assert.equal(runtime.provider.baseUrl, ENDPOINT)
})

test('endpoint validator permits HTTPS public hosts and exact HTTP loopback only', async () => {
  assert.equal(await validateSessionEndpoint(ENDPOINT, { lookup: publicLookup() }), ENDPOINT)
  assert.equal(await validateSessionEndpoint('https://8.8.8.8/v1', { lookup: async () => { throw new Error('numeric must not resolve') } }), 'https://8.8.8.8/v1')
  assert.equal(await validateSessionEndpoint('https://[2606:4700:4700::1111]/v1', { lookup: async () => { throw new Error('numeric must not resolve') } }), 'https://[2606:4700:4700::1111]/v1')
  assert.equal(await validateSessionEndpoint('http://127.0.0.1:8787/v1', { lookup: async () => { throw new Error('loopback must not resolve') } }), 'http://127.0.0.1:8787/v1')
  assert.equal(await validateSessionEndpoint('http://[::1]:8787/v1', { lookup: async () => { throw new Error('loopback must not resolve') } }), 'http://[::1]:8787/v1')
})

test('endpoint validator rejects protocol, authority, query, fragment, length, and path bypasses', async () => {
  const invalid = [
    'ftp://models.example.test/v1',
    'file:///tmp/provider',
    'http://models.example.test/v1',
    'http://localhost:8787/v1',
    'http://api.localhost:8787/v1',
    'http://127.1:8787/v1',
    'https://user:pass@models.example.test/v1',
    'https://models.example.test/v1?next=/evil',
    'https://models.example.test/v1#fragment',
    'https://models.example.test/v1\\responses',
    'https://models.example.test/v1/%2e%2e/private',
    'https://models.example.test/v1/../private',
    'https://models.example.test/v1//responses',
    'https://127.0.0.1/v1',
    'https://[::1]/v1',
    'https://10.0.0.1/v1',
    'https://168.63.129.16/metadata',
    'https://169.254.169.254/latest',
    'https://100.100.100.200/latest',
    'https://224.0.0.1/v1',
    'https://0.0.0.0/v1'
  ]
  for (const endpoint of invalid) {
    await assert.rejects(validateSessionEndpoint(endpoint, { lookup: publicLookup() }), /PI_SESSION_ENDPOINT_/)
  }
  const tooLong = `https://models.example.test/${'a'.repeat(MAX_SESSION_ENDPOINT_BYTES)}`
  await assert.rejects(validateSessionEndpoint(tooLong, { lookup: publicLookup() }), /PI_SESSION_ENDPOINT_TOO_LONG/)
})

test('endpoint validator rejects private, metadata, mixed, empty, and invalid DNS answers', async () => {
  for (const records of [
    [{ address: '10.0.0.2', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: PUBLIC_V4, family: 4 }, { address: '192.168.1.2', family: 4 }],
    [{ address: 'fc00::1', family: 6 }],
    [{ address: 'fe80::1', family: 6 }],
    [{ address: '2001:db8::1', family: 6 }],
    []
  ]) {
    await assert.rejects(validateSessionEndpoint(ENDPOINT, { lookup: publicLookup(records) }), /PI_SESSION_ENDPOINT_(?:NOT_PUBLIC|DNS_FAILED)/)
  }
  await assert.rejects(validateSessionEndpoint(ENDPOINT, { lookup: async () => { throw new Error('dns detail') } }), /PI_SESSION_ENDPOINT_DNS_FAILED/)
})

test('public address classifier excludes non-routable and special-use ranges', () => {
  for (const address of [PUBLIC_V4, '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicSessionAddress(address), true, address)
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '168.63.129.16', '169.254.169.254',
    '172.16.0.1', '192.168.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1',
    'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1'
  ]) assert.equal(isPublicSessionAddress(address), false, address)
})

test('restricted fetch pins origin and path prefix, rechecks DNS, and disables redirects', async () => {
  let lookups = 0
  const calls = []
  const restricted = createRestrictedSessionFetch({
    endpoint: ENDPOINT,
    lookup: async (hostname, options) => {
      lookups += 1
      return publicLookup()(hostname, options)
    },
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init })
      return new Response('{}', { status: 200 })
    }
  })
  const response = await restricted(`${ENDPOINT}/responses`, { method: 'POST', redirect: 'follow' })
  assert.equal(response.status, 200)
  assert.equal(lookups, 1)
  assert.equal(calls[0].init.redirect, 'manual')

  await assert.rejects(restricted('https://other.example.test/v1/responses'), /PI_SESSION_REQUEST_ORIGIN_FORBIDDEN|PI_SESSION_ENDPOINT_DNS_FAILED/)
  await assert.rejects(restricted('https://models.example.test/v10/responses'), /PI_SESSION_REQUEST_PATH_FORBIDDEN/)
  await assert.rejects(restricted('https://models.example.test/v1/%2e%2e/private'), /PI_SESSION_ENDPOINT_ENCODING_FORBIDDEN/)
})

test('restricted fetch fails closed on DNS rebinding and redirects', async () => {
  let called = false
  const rebound = createRestrictedSessionFetch({
    endpoint: ENDPOINT,
    lookup: publicLookup([{ address: '127.0.0.1', family: 4 }]),
    fetchImpl: async () => {
      called = true
      return new Response(null, { status: 200 })
    }
  })
  await assert.rejects(rebound(`${ENDPOINT}/responses`), /PI_SESSION_ENDPOINT_NOT_PUBLIC/)
  assert.equal(called, false)

  const redirect = createRestrictedSessionFetch({
    endpoint: ENDPOINT,
    lookup: publicLookup(),
    fetchImpl: async (_input, init) => {
      assert.equal(init.redirect, 'manual')
      return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1/private' } })
    }
  })
  await assert.rejects(redirect(`${ENDPOINT}/responses`), /PI_SESSION_REDIRECT_FORBIDDEN/)
})

test('worker environment passes only safe base fields and the two session fields', () => {
  const env = buildWorkerEnv({
    provider: SESSION_PROVIDER_ID,
    baseEnv: {
      PATH: '/bin',
      LANG: 'C.UTF-8',
      HOME: '/private/home',
      OPENAI_BASE_URL: 'https://attacker.invalid',
      ANTHROPIC_BASE_URL: 'https://attacker.invalid',
      WORKBENCH_GATEWAY_KEY: 'workbench-secret',
      GATE_USDM_TESTNET_API_KEY: 'gate-secret',
      BINANCE_USDM_TESTNET_SECRET_KEY: 'binance-secret',
      [SESSION_API_KEY_ENV]: API_KEY,
      [SESSION_ENDPOINT_ENV]: ENDPOINT
    }
  })
  assert.deepEqual(env, {
    PATH: '/bin',
    LANG: 'C.UTF-8',
    [SESSION_API_KEY_ENV]: API_KEY,
    [SESSION_ENDPOINT_ENV]: ENDPOINT
  })
  assert.throws(() => buildWorkerEnv({ provider: SESSION_PROVIDER_ID, providerEnv: { OPENAI_BASE_URL: 'https://attacker.invalid' } }), /PI_PROVIDER_ENV_NOT_ALLOWLISTED/)
  assert.throws(() => buildWorkerEnv({ provider: SESSION_PROVIDER_ID, providerEnv: { GATE_API_KEY: 'secret' } }), /PI_CREDENTIAL_ENV_BLOCKED/)
})

test('custom runtime uses the fixed Responses model and injected fetch', async () => {
  let request
  const runtime = await createSessionProviderRuntime({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    modelId: 'gpt-5.6-luna',
    lookup: publicLookup(),
    fetchImpl: async (input, init) => {
      request = { url: String(input), init }
      throw new Error('injected transport stop')
    }
  })
  const stream = runtime.streamFn(runtime.model, {
    systemPrompt: 'test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }], timestamp: Date.now() }],
    tools: []
  }, { maxRetries: 0 })
  const result = await stream.result()
  assert.equal(result.api, 'openai-responses')
  assert.equal(result.provider, SESSION_PROVIDER_ID)
  assert.equal(result.errorMessage, 'Connection error.')
  assert.equal(request.url, `${ENDPOINT}/responses`)
  assert.equal(request.init.redirect, 'manual')
  assert.equal(request.init.headers.get('authorization'), `Bearer ${API_KEY}`)
})

test('adapter reads session settings only from env and redacts them from every result field', async () => {
  const result = await runPiAgentJob(sessionJob(), {
    env: {
      [SESSION_API_KEY_ENV]: API_KEY,
      [SESSION_ENDPOINT_ENV]: ENDPOINT
    },
    lookup: publicLookup(),
    fetchImpl: async () => { throw new Error(`transport ${API_KEY} ${ENDPOINT}`) }
  })
  assert.equal(result.status, 'error')
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(API_KEY), false)
  assert.equal(serialized.includes(ENDPOINT), false)
  assert.equal(Object.hasOwn(result.provenance, 'endpoint'), false)
  assert.equal(Object.hasOwn(result.provenance, 'apiKey'), false)
  assert.equal(JSON.stringify(sessionJob()).includes(API_KEY), false)
  assert.equal(JSON.stringify(sessionJob()).includes(ENDPOINT), false)
})

test('session secret helpers fail closed for semantic output and exact error values', () => {
  assert.equal(containsSessionSecret({ summary: `leak ${API_KEY}` }, { apiKey: API_KEY, endpoint: ENDPOINT }), true)
  assert.equal(containsSessionSecret({ summary: ENDPOINT }, { apiKey: API_KEY, endpoint: ENDPOINT }), true)
  assert.equal(containsSessionSecret({ summary: 'safe' }, { apiKey: API_KEY, endpoint: ENDPOINT }), false)
  const redacted = redactSessionSecrets(new Error(`failed Bearer ${API_KEY} at ${ENDPOINT}/responses`), { apiKey: API_KEY, endpoint: ENDPOINT })
  assert.equal(redacted.message.includes(API_KEY), false)
  assert.equal(redacted.message.includes('models.example.test'), false)
})

test('secret checks inspect raw nested strings and property names with JSON escaping', async () => {
  for (const apiKey of ['fixture"quoted-key', 'fixture\\backslash-key']) {
    const secrets = { apiKey, endpoint: ENDPOINT }
    for (const value of [apiKey, { prompt: `before ${apiKey} after` }, [{ history: [{ content: apiKey }] }], { [apiKey]: 'value' }]) assert.equal(containsSessionSecret(value, secrets), true)
    const circular = { safe: 'BTC/ETH strategy' }; circular.self = circular
    assert.equal(containsSessionSecret(circular, secrets), false)
    let requests = 0
    const result = await runPiAgentJob(sessionJob({ input: { strategy_context: `Review ${apiKey}` } }), { env: { [SESSION_API_KEY_ENV]: apiKey, [SESSION_ENDPOINT_ENV]: ENDPOINT }, fetchImpl: async () => { requests++; throw new Error('must not connect') } })
    assert.equal(requests, 0)
    assert.equal(result.status, 'error')
    assert.equal(result.error.code, 'PI_SESSION_PROVIDER_FAILED')
    assert.equal(result.error.message, 'PI_SESSION_SECRET_IN_INPUT')
    assert.equal(containsSessionSecret(result, secrets), false)
  }
})
