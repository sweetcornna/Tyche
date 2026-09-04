import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, createHash } from 'node:crypto'
import {
  API_PREFIX,
  FIXED_HOSTS,
  canonicalQuery,
  createGateClient,
  credentialNames,
  isDefinitiveOrderNotFound,
  operationDefinitions,
  signingPayload
} from '../scripts/gate-rest.mjs'
import { jsonResponse, NOW } from './helpers.mjs'

const fake = (kind) => ['unit', 'test', kind].join('-')

async function withProcessEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  try { return await callback() } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('Spot transport has no mutation definition and USDT-M mutations are testnet-only', () => {
  const definitions = Object.values(operationDefinitions)
  assert.ok(definitions.filter((row) => row.product === 'spot').every((row) => row.method === 'GET' && row.mutation !== true))
  const mutations = definitions.filter((row) => row.mutation === true)
  assert.ok(mutations.length > 0)
  assert.ok(mutations.every((row) => row.product === 'usdm' && row.environments.length === 1 && row.environments[0] === 'testnet'))
  assert.ok(definitions.every((row) => !String(row.path).includes(['trans', 'fer'].join(''))))
  assert.ok(definitions.every((row) => !/cancel.?all/i.test(String(row.path))))
  assert.deepEqual(Object.keys(FIXED_HOSTS).sort(), ['spot_public', 'usdm_public', 'usdm_testnet'])
})

test('credential names are product-scoped and contain no production USDT-M namespace', () => {
  assert.deepEqual(credentialNames('spot', 'dry-run'), { apiKey: 'GATE_SPOT_READONLY_API_KEY', secretKey: 'GATE_SPOT_READONLY_SECRET_KEY' })
  const usdm = credentialNames('usdm', 'testnet')
  assert.deepEqual(usdm, { apiKey: 'GATE_USDM_TESTNET_API_KEY', secretKey: 'GATE_USDM_TESTNET_SECRET_KEY' })
  const forbiddenWord = ['L', 'I', 'V', 'E'].join('')
  assert.ok(Object.values(usdm).every((name) => !name.includes(forbiddenWord)))
  assert.equal(credentialNames('usdm', 'public'), null)
})

test('query and HMAC-SHA512 wire payload are deterministic', async () => {
  assert.equal(canonicalQuery({ z: 2, a: 'x y', empty: null }), 'a=x+y&z=2')
  const names = credentialNames('spot', 'dry-run')
  const env = { [names.apiKey]: fake('key'), [names.secretKey]: fake('secret') }
  await withProcessEnv(env, async () => {
    const calls = []
    const client = createGateClient({
      product: 'spot',
      environment: 'dry-run',
      readOnly: true,
      now: () => NOW,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse([{ currency: 'USDT', available: '0', locked: '0' }])
      }
    })
    await client.spotAccounts({ currency: 'USDT' })
    assert.equal(calls.length, 1)
    const expectedPath = `${API_PREFIX}/spot/accounts`
    const expectedQuery = 'currency=USDT'
    const timestamp = String(Math.floor(NOW / 1000))
    const bodyHash = createHash('sha512').update('').digest('hex')
    const wire = `GET\n${expectedPath}\n${expectedQuery}\n${bodyHash}\n${timestamp}`
    const expectedSign = createHmac('sha512', env[names.secretKey]).update(wire).digest('hex')
    assert.equal(calls[0].url, `${FIXED_HOSTS.spot_public}${expectedPath}?${expectedQuery}`)
    assert.equal(calls[0].init.headers.KEY, env[names.apiKey])
    assert.equal(calls[0].init.headers.SIGN, expectedSign)
    assert.equal(signingPayload({ method: 'GET', path: expectedPath, query: expectedQuery, body: '', timestamp }), wire)
  })
})

test('unsupported production environment and direct credential maps are rejected before network activity', () => {
  let calls = 0
  assert.throws(() => createGateClient({ product: 'usdm', environment: 'live', fetchImpl: async () => { calls += 1 } }), { code: 'GATE_ENVIRONMENT_UNSUPPORTED' })
  assert.throws(() => createGateClient({ product: 'usdm', environment: 'testnet', env: {}, fetchImpl: async () => { calls += 1 } }), { code: 'GATE_CLIENT_OVERRIDE_FORBIDDEN' })
  assert.equal(calls, 0)
})

test('exact client-text lookup never falls back to bounded order lists', async () => {
  const names = credentialNames('usdm', 'testnet')
  await withProcessEnv({ [names.apiKey]: fake('key'), [names.secretKey]: fake('secret') }, async () => {
    const identity = `t-TYE${'c'.repeat(22)}`
    const calls = []
    const client = createGateClient({
      product: 'usdm',
      environment: 'testnet',
      readOnly: true,
      now: () => NOW,
      fetchImpl: async (url) => {
        calls.push(url)
        return jsonResponse({ label: 'ORDER_NOT_FOUND', message: 'fixture' }, 404)
      }
    })
    await assert.rejects(client.findUsdmOrderByText(identity), (error) => isDefinitiveOrderNotFound(error, identity))
    assert.equal(calls.length, 1)
    assert.match(calls[0], new RegExp(`/futures/usdt/orders/${identity}$`))
    assert.equal(calls.some((url) => url.includes('status=open') || url.includes('status=finished')), false)
  })
})

test('mutating server failure is ambiguous and never retried', async () => {
  const names = credentialNames('usdm', 'testnet')
  await withProcessEnv({ [names.apiKey]: fake('key'), [names.secretKey]: fake('secret') }, async () => {
    let calls = 0
    const client = createGateClient({
      product: 'usdm',
      environment: 'testnet',
      now: () => NOW,
      fetchImpl: async () => {
        calls += 1
        return jsonResponse({ label: 'SERVER_ERROR', message: 'fixture' }, 503)
      }
    })
    await assert.rejects(client.usdmPlaceOrder({ contract: 'BTC_USDT', size: 1, price: '100', tif: 'gtc', text: `t-TYE${'a'.repeat(22)}` }), (error) => error.ambiguous === true && error.status === 503)
    assert.equal(calls, 1)
  })
})

test('protection body requires reduce-only exact-size semantics before fetch', async () => {
  const names = credentialNames('usdm', 'testnet')
  await withProcessEnv({ [names.apiKey]: fake('key'), [names.secretKey]: fake('secret') }, async () => {
    let calls = 0
    const client = createGateClient({
      product: 'usdm',
      environment: 'testnet',
      fetchImpl: async () => { calls += 1; return jsonResponse({}) }
    })
    await assert.rejects(client.usdmPlacePriceOrder({
      initial: { contract: 'BTC_USDT', size: -2, price: '0', tif: 'ioc', text: `t-TYP${'b'.repeat(22)}`, reduce_only: false },
      trigger: { strategy_type: 0, price_type: 1, price: '90', rule: 2, expiration: 86400 }
    }), { code: 'GATE_PROTECTION_REDUCE_ONLY_REQUIRED' })
    assert.equal(calls, 0)
  })
})
