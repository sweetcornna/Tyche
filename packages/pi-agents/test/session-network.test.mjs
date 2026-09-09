import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createSessionLookup, resolvePublicSessionAddresses, pinnedSessionLookup, fetchPinnedSession } from '../src/session-network.mjs'
import { validateSessionEndpoint, createRestrictedSessionFetch } from '../src/session-provider.mjs'

const HOST = 'gateway.example.test'
const PUBLIC = [{ address: '8.8.8.8', family: 4 }]
const FAKE = [{ address: '198.18.0.37', family: 4 }]

test('Fake-IP DNS is independently resolved, bounded, cached and never treated as public', async () => {
  let time = 0, calls = 0
  const lookup = createSessionLookup({ lookup: async () => FAKE, now: () => time, cacheMs: 100, resolvePublic: async (host) => { assert.equal(host, HOST); calls++; return PUBLIC } })
  assert.equal(await validateSessionEndpoint(`https://${HOST}/v1`, { lookup }), `https://${HOST}/v1`)
  const answers = await lookup(HOST, { all: true }); answers[0].address = '127.0.0.1'
  assert.deepEqual(await lookup(HOST, { all: true }), PUBLIC)
  assert.equal(calls, 1)
  time = 101
  assert.deepEqual(await lookup(HOST, { all: true }), PUBLIC)
  assert.equal(calls, 2)
  await assert.rejects(validateSessionEndpoint('https://198.18.0.37/v1', { lookup }), { code: 'PI_SESSION_ENDPOINT_NOT_PUBLIC' })
})

test('private and mixed DNS answers cannot opt into the Fake-IP fallback', async () => {
  for (const records of [[{ address: '127.0.0.1', family: 4 }], [...FAKE, { address: '10.0.0.2', family: 4 }], [...PUBLIC, ...FAKE]]) {
    let calls = 0
    const lookup = createSessionLookup({ lookup: async () => records, resolvePublic: async () => { calls++; return PUBLIC } })
    await assert.rejects(validateSessionEndpoint(`https://${HOST}`, { lookup }), { code: 'PI_SESSION_ENDPOINT_NOT_PUBLIC' })
    assert.equal(calls, 0)
  }
})

test('failed or private independent answers fail before any credential-bearing request', async () => {
  for (const resolvePublic of [async () => [], async () => [{ address: '10.0.0.1', family: 4 }], async () => [...PUBLIC, { address: '::1', family: 6 }], async () => { throw new Error('sensitive resolver detail') }]) {
    const lookup = createSessionLookup({ lookup: async () => FAKE, resolvePublic })
    let fetched = false
    const request = createRestrictedSessionFetch({ endpoint: `https://${HOST}/v1`, lookup, fetchImpl: async () => { fetched = true } })
    await assert.rejects(request(`https://${HOST}/v1/models`, { headers: { authorization: 'Bearer test-only' } }), { code: 'PI_SESSION_ENDPOINT_PROXY_DNS_FAILED', message: 'PI_SESSION_ENDPOINT_PROXY_DNS_FAILED' })
    assert.equal(fetched, false)
  }
})

test('DNS over HTTPS requests are fixed, credential-free, bounded and validate A plus AAAA', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const parsed = new URL(url); const type = Number(parsed.searchParams.get('type'))
    assert.equal(parsed.origin, 'https://1.1.1.1')
    assert.equal(parsed.pathname, '/dns-query')
    assert.equal(parsed.searchParams.get('name'), HOST)
    assert.deepEqual(init.headers, { accept: 'application/dns-json' })
    assert.equal(init.redirect, 'manual')
    return Response.json({ Status: 0, Question: [{ name: HOST, type }], Answer: type === 1 ? [{ type: 1, data: PUBLIC[0].address }] : [] })
  }
  assert.deepEqual(await resolvePublicSessionAddresses(HOST, { fetchImpl }), PUBLIC)
  assert.equal(calls.length, 2)
  const invalid = [
    () => new Response('', { status: 302, headers: { location: 'https://another.example/dns' } }),
    () => Response.json({ Status: 0, Question: [{ name: HOST, type: 1 }], Answer: [{ type: 1, data: '192.168.1.1' }] }),
    () => Response.json({ Status: 0, Question: [{ name: 'other.example', type: 1 }], Answer: [{ type: 1, data: '8.8.8.8' }] }),
    () => Response.json({ padding: 'x'.repeat(33000) })
  ]
  for (const fetchImpl of invalid) await assert.rejects(resolvePublicSessionAddresses(HOST, { fetchImpl }))
})

test('parallel Fake-IP checks share a lookup and expire without caching failures', async () => {
  let calls = 0
  const lookup = createSessionLookup({ lookup: async () => FAKE, resolvePublic: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return PUBLIC } })
  assert.deepEqual(await Promise.all([lookup(HOST), lookup(HOST)]), [PUBLIC, PUBLIC])
  assert.equal(calls, 1)
  const bad = createSessionLookup({ lookup: async () => FAKE, resolvePublic: async () => { calls++; throw new Error('unavailable') } })
  await assert.rejects(bad(HOST)); await assert.rejects(bad(HOST))
  assert.equal(calls, 3)
})

test('pinned lookup preserves hostname binding and Node family/all contracts', async () => {
  const source = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]
  const lookup = pinnedSessionLookup(HOST, source)
  source[0].address = '127.0.0.1'
  const run = (host, options) => new Promise((resolve, reject) => lookup(host, options, (error, address, family) => error ? reject(error) : resolve({ address, family })))
  assert.deepEqual(await run(HOST, { family: 4 }), { address: '8.8.8.8', family: 4 })
  assert.equal((await run(HOST, { all: true })).address.length, 2)
  await assert.rejects(run('other.example.test', {}), { code: 'PI_SESSION_REQUEST_ORIGIN_FORBIDDEN' })
})

test('pinned transport keeps Host and drains a streaming response before closing', async () => {
  let seenHost
  const server = http.createServer((request, response) => {
    seenHost = request.headers.host
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: one\n\n')
    setTimeout(() => response.end('data: two\n\n'), 10)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    // Exercise the transport in isolation; production calls first apply the
    // endpoint validator, whose private-host rejection is tested above.
    const response = await fetchPinnedSession(`http://${HOST}:${port}/stream`, { signal: AbortSignal.timeout(3000), redirect: 'manual' }, [{ address: '127.0.0.1', family: 4 }])
    assert.equal(await response.text(), 'data: one\n\ndata: two\n\n')
    assert.equal(seenHost, `${HOST}:${port}`)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
