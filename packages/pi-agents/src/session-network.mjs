import dns from 'node:dns/promises'
import net from 'node:net'
import { Agent } from 'undici'
import { isPublicSessionAddress, isSyntheticSessionAddress } from './session-address.mjs'

function failure(code) { return Object.assign(new Error(code), { code }) }

// Resolve only a hostname through this fixed, certificate-verified resolver.
// API credentials and provider request headers never enter DNS requests.
export async function resolvePublicSessionAddresses(hostname, { fetchImpl = globalThis.fetch } = {}) {
  const records = await Promise.all([1, 28].map(async (type) => {
    const response = await fetchImpl(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: 'application/dns-json' }, redirect: 'manual', signal: AbortSignal.timeout(5000)
    })
    if (response.status !== 200 || !/^application\/(?:dns-)?json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel().catch(() => {})
      throw failure('PI_SESSION_ENDPOINT_PROXY_DNS_FAILED')
    }
    const reader = response.body?.getReader()
    if (!reader) throw failure('PI_SESSION_ENDPOINT_PROXY_DNS_FAILED')
    const chunks = []; let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 32768) throw failure('PI_SESSION_ENDPOINT_PROXY_DNS_FAILED')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    if (value.Status !== 0 || !Array.isArray(value.Question) || !value.Question.some((q) => q.type === type && q.name?.toLowerCase().replace(/\.$/, '') === hostname.toLowerCase()) || (value.Answer !== undefined && (!Array.isArray(value.Answer) || value.Answer.length > 64))) throw failure('PI_SESSION_ENDPOINT_PROXY_DNS_FAILED')
    return (value.Answer || []).filter((row) => row.type === 1 || row.type === 28).map((row) => {
      const family = row.type === 1 ? 4 : 6
      if (typeof row.data !== 'string' || net.isIP(row.data) !== family || !isPublicSessionAddress(row.data)) throw failure('PI_SESSION_ENDPOINT_PROXY_DNS_FAILED')
      return { address: row.data, family }
    })
  }))
  const unique = [...new Map(records.flat().map((row) => [row.address, row])).values()]
  if (!unique.length) throw failure('PI_SESSION_ENDPOINT_PROXY_DNS_FAILED')
  return unique
}

export function createSessionLookup({ lookup = dns.lookup, resolvePublic = resolvePublicSessionAddresses, now = () => performance.now(), cacheMs = 30_000 } = {}) {
  const cache = new Map(), pending = new Map()
  return async (hostname, options) => {
    const records = await lookup(hostname, options)
    // Never treat private, mixed, malformed, or literal benchmark addresses as
    // an exception. Only a DNS answer consisting entirely of Fake-IP triggers
    // an independent lookup, and its result must still be public.
    if (net.isIP(hostname) || !Array.isArray(records) || !records.length || !records.every((row) => row?.family === 4 && isSyntheticSessionAddress(row.address))) return records
    const key = hostname.toLowerCase()
    const stored = cache.get(key)
    if (stored && now() < stored.expiresAt) return stored.records.map((row) => ({ ...row }))
    let operation = pending.get(key)
    if (!operation) {
      if (pending.size >= 64) throw failure('PI_SESSION_ENDPOINT_PROXY_DNS_FAILED')
      operation = (async () => {
        try {
          const answers = await resolvePublic(hostname)
          if (!Array.isArray(answers) || !answers.length || answers.length > 128 || !answers.every((row) => row && net.isIP(row.address) === row.family && isPublicSessionAddress(row.address))) throw failure('PI_SESSION_ENDPOINT_PROXY_DNS_FAILED')
          const accepted = answers.map(({ address, family }) => ({ address, family }))
          if (cache.size >= 64) cache.delete(cache.keys().next().value)
          cache.set(key, { records: accepted, expiresAt: now() + cacheMs })
          return accepted
        } catch { throw failure('PI_SESSION_ENDPOINT_PROXY_DNS_FAILED') }
      })()
      pending.set(key, operation)
    }
    try { return (await operation).map((row) => ({ ...row })) } finally { if (pending.get(key) === operation) pending.delete(key) }
  }
}

export const sessionLookup = createSessionLookup()

export function pinnedSessionLookup(hostname, records) {
  const addresses = records.map(({ address, family }) => ({ address, family }))
  return (name, options, callback) => {
    if (name.toLowerCase() !== hostname.toLowerCase()) return callback(failure('PI_SESSION_REQUEST_ORIGIN_FORBIDDEN'))
    const family = typeof options === 'number' ? options : options?.family
    const matching = addresses.filter((row) => !family || row.family === family)
    if (!matching.length) return callback(failure('PI_SESSION_ENDPOINT_DNS_FAILED'))
    if (options?.all) callback(null, matching.map((row) => ({ ...row })))
    else callback(null, matching[0].address, matching[0].family)
  }
}

export async function fetchPinnedSession(input, init, records) {
  const target = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  init.signal?.throwIfAborted()
  // Keep the original URL, Host and TLS server name. Only socket resolution is
  // pinned, closing the DNS check/use gap without accepting Fake-IP as public.
  const dispatcher = new Agent({ connections: 1, connect: { timeout: 10_000, lookup: pinnedSessionLookup(hostname, records) } })
  try {
    return await globalThis.fetch(input, { ...init, dispatcher })
  } catch (error) {
    if (init.signal?.aborted) throw error
    const code = error?.cause?.code || error?.code || ''
    throw failure(/CERT|TLS|SSL|SELF_SIGNED/.test(code) ? 'PI_SESSION_TLS_FAILED' : 'PI_SESSION_NETWORK_FAILED')
  } finally {
    // close() drains the response body (including SSE) before releasing sockets.
    dispatcher.close().catch(() => dispatcher.destroy().catch(() => {}))
  }
}
