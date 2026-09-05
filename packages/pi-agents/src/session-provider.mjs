import dns from 'node:dns/promises'
import net from 'node:net'
import {
  createModels,
  createProvider,
  envApiKeyAuth
} from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'

export const SESSION_PROVIDER_ID = 'openai-responses-compatible'
export const SESSION_API_KEY_ENV = 'TYCHE_PI_SESSION_API_KEY'
export const SESSION_ENDPOINT_ENV = 'TYCHE_PI_SESSION_ENDPOINT'
export const SESSION_MODEL_IDS = Object.freeze(['gpt-5.6-luna', 'gpt-5.6-sol'])
export const MAX_SESSION_ENDPOINT_BYTES = 2048

const SESSION_MODEL_SET = new Set(SESSION_MODEL_IDS)
const REDACTED = '[session-secret-redacted]'

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function ipv4Number(address) {
  if (net.isIP(address) !== 4) return null
  const octets = address.split('.').map(Number)
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0
}

function inV4Cidr(value, base, prefix) {
  const address = ipv4Number(value)
  const network = ipv4Number(base)
  if (address === null || network === null) return false
  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (address & mask) === (network & mask)
}

const BLOCKED_V4 = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['168.63.129.16', 32],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
])

function parseIpv6(address) {
  let value = String(address).toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value.includes('%')) return null

  const mapped = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) {
    const v4 = ipv4Number(mapped[2])
    if (v4 === null) return null
    value = `${mapped[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }

  const halves = value.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && left.length !== 8) return null
  const omitted = 8 - left.length - right.length
  if (omitted < (halves.length === 2 ? 1 : 0)) return null
  const groups = [...left, ...Array(omitted).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  return groups.map((part) => Number.parseInt(part, 16))
}

function isPublicIpv4(address) {
  return net.isIP(address) === 4 && !BLOCKED_V4.some(([base, prefix]) => inV4Cidr(address, base, prefix))
}

function isPublicIpv6(address) {
  const groups = parseIpv6(address)
  if (!groups) return false

  // IPv4-mapped IPv6 must inherit the IPv4 classification.
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6] >>> 8}.${groups[6] & 255}.${groups[7] >>> 8}.${groups[7] & 255}`
    return isPublicIpv4(mapped)
  }

  // Conservatively permit global unicast only. Exclude documentation,
  // benchmarking, ORCHID, Teredo, and 6to4 ranges from that space.
  if ((groups[0] & 0xe000) !== 0x2000) return false
  if (groups[0] === 0x2001 && groups[1] <= 0x01ff) return false
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false
  if (groups[0] === 0x2002) return false
  if (groups[0] === 0x3fff && groups[1] <= 0x0fff) return false
  return true
}

export function isPublicSessionAddress(address) {
  const kind = net.isIP(address)
  if (kind === 4) return isPublicIpv4(address)
  if (kind === 6) return isPublicIpv6(address)
  return false
}

function normalizedHostname(url) {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
}

function rawAuthorityHostname(endpoint) {
  const authority = endpoint.slice(endpoint.indexOf('://') + 3).split('/')[0]
  if (authority.startsWith('[')) return authority.slice(0, authority.indexOf(']') + 1).toLowerCase()
  return authority.split(':')[0].toLowerCase()
}

function assertCleanUrlText(value) {
  if (typeof value !== 'string' || !value.trim()) fail('PI_SESSION_ENDPOINT_REQUIRED')
  if (Buffer.byteLength(value, 'utf8') > MAX_SESSION_ENDPOINT_BYTES) fail('PI_SESSION_ENDPOINT_TOO_LONG')
  if (value !== value.trim()) fail('PI_SESSION_ENDPOINT_INVALID')
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) fail('PI_SESSION_ENDPOINT_INVALID')
  if (/%/u.test(value)) fail('PI_SESSION_ENDPOINT_ENCODING_FORBIDDEN')
  const rawPath = value.slice(value.indexOf('://') + 3).replace(/^[^/]*/u, '').split(/[?#]/u)[0]
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath) || rawPath.includes('//')) fail('PI_SESSION_ENDPOINT_PATH_INVALID')
}

function assertCleanPath(pathname) {
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('%')) fail('PI_SESSION_ENDPOINT_PATH_INVALID')
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(pathname)) fail('PI_SESSION_ENDPOINT_PATH_INVALID')
  if (pathname.includes('//')) fail('PI_SESSION_ENDPOINT_PATH_INVALID')
}

async function resolveAll(hostname, lookup) {
  let records
  try {
    records = await lookup(hostname, { all: true })
  } catch {
    fail('PI_SESSION_ENDPOINT_DNS_FAILED')
  }
  if (!Array.isArray(records) || records.length === 0) fail('PI_SESSION_ENDPOINT_DNS_FAILED')
  for (const record of records) {
    if (!record || typeof record.address !== 'string' || !isPublicSessionAddress(record.address)) {
      fail('PI_SESSION_ENDPOINT_NOT_PUBLIC')
    }
  }
}

async function validateParsedUrl(url, rawValue, lookup) {
  if (url.username || url.password) fail('PI_SESSION_ENDPOINT_USERINFO_FORBIDDEN')
  if (url.search) fail('PI_SESSION_ENDPOINT_QUERY_FORBIDDEN')
  if (url.hash) fail('PI_SESSION_ENDPOINT_FRAGMENT_FORBIDDEN')
  assertCleanPath(url.pathname)

  const hostname = normalizedHostname(url).toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) fail('PI_SESSION_ENDPOINT_HOST_FORBIDDEN')

  if (url.protocol === 'http:') {
    const rawHost = rawAuthorityHostname(rawValue)
    if (!((hostname === '127.0.0.1' && rawHost === '127.0.0.1') || (hostname === '::1' && rawHost === '[::1]'))) {
      fail('PI_SESSION_ENDPOINT_HTTP_FORBIDDEN')
    }
    return
  }
  if (url.protocol !== 'https:') fail('PI_SESSION_ENDPOINT_PROTOCOL_FORBIDDEN')

  const kind = net.isIP(hostname)
  if (kind) {
    if (!isPublicSessionAddress(hostname)) fail('PI_SESSION_ENDPOINT_NOT_PUBLIC')
    return
  }
  await resolveAll(hostname, lookup)
}

function canonicalEndpoint(url) {
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${pathname}`
}

export async function validateSessionEndpoint(value, { lookup = dns.lookup } = {}) {
  assertCleanUrlText(value)
  let url
  try {
    url = new URL(value)
  } catch {
    fail('PI_SESSION_ENDPOINT_INVALID')
  }
  await validateParsedUrl(url, value, lookup)
  return canonicalEndpoint(url)
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input)
  if (typeof input?.url === 'string') return input.url
  fail('PI_SESSION_REQUEST_URL_INVALID')
}

function withinPathPrefix(pathname, prefix) {
  if (!prefix) return pathname.startsWith('/')
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function createRestrictedSessionFetch({ endpoint, lookup = dns.lookup, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') fail('PI_SESSION_FETCH_REQUIRED')
  const endpointUrl = new URL(endpoint)
  const endpointPrefix = endpointUrl.pathname === '/' ? '' : endpointUrl.pathname.replace(/\/+$/u, '')

  return async function restrictedSessionFetch(input, init = {}) {
    const raw = requestUrl(input)
    assertCleanUrlText(raw)
    let target
    try {
      target = new URL(raw)
    } catch {
      fail('PI_SESSION_REQUEST_URL_INVALID')
    }
    await validateParsedUrl(target, raw, lookup)
    if (target.origin !== endpointUrl.origin) fail('PI_SESSION_REQUEST_ORIGIN_FORBIDDEN')
    if (!withinPathPrefix(target.pathname, endpointPrefix)) fail('PI_SESSION_REQUEST_PATH_FORBIDDEN')

    const response = await fetchImpl(input, { ...init, redirect: 'manual' })
    if (!response || !Number.isInteger(response.status)) fail('PI_SESSION_RESPONSE_INVALID')
    if (response.status >= 300 && response.status < 400) fail('PI_SESSION_REDIRECT_FORBIDDEN')
    return response
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function cloneSessionModel(id, endpoint, sourceModels) {
  if (!SESSION_MODEL_SET.has(id)) fail('PI_SESSION_MODEL_NOT_ALLOWED')
  const source = sourceModels.getModel('openai', id)
  if (!source || source.api !== 'openai-responses') fail('PI_SESSION_MODEL_SOURCE_INVALID')
  const model = structuredClone(source)
  model.provider = SESSION_PROVIDER_ID
  model.baseUrl = endpoint
  model.name = `${source.name} (Tyche session)`
  return deepFreeze(model)
}

export async function createSessionProviderRuntime({
  endpoint,
  apiKey,
  modelId,
  lookup = dns.lookup,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('PI_SESSION_API_KEY_REQUIRED')
  if (!SESSION_MODEL_SET.has(modelId)) fail('PI_SESSION_MODEL_NOT_ALLOWED')
  const normalizedEndpoint = await validateSessionEndpoint(endpoint, { lookup })
  const restrictedFetch = createRestrictedSessionFetch({ endpoint: normalizedEndpoint, lookup, fetchImpl })
  const sourceModels = builtinModels()
  const modelsForProvider = SESSION_MODEL_IDS.map((id) => cloneSessionModel(id, normalizedEndpoint, sourceModels))
  const trustedModels = new Map(modelsForProvider.map((model) => [model.id, model]))
  const responses = openAIResponsesApi()
  const trustedModel = (candidate) => {
    const model = trustedModels.get(candidate?.id)
    if (!model || candidate?.provider !== SESSION_PROVIDER_ID || candidate?.api !== 'openai-responses') {
      fail('PI_SESSION_MODEL_NOT_ALLOWED')
    }
    return model
  }
  const api = {
    stream(model, context, options) {
      return responses.stream(trustedModel(model), context, { ...options, fetch: restrictedFetch })
    },
    streamSimple(model, context, options) {
      return responses.streamSimple(trustedModel(model), context, { ...options, fetch: restrictedFetch })
    }
  }
  const provider = createProvider({
    id: SESSION_PROVIDER_ID,
    name: 'Tyche OpenAI Responses compatible session',
    baseUrl: normalizedEndpoint,
    auth: { apiKey: envApiKeyAuth('Tyche Pi session API key', [SESSION_API_KEY_ENV]) },
    models: modelsForProvider,
    api
  })
  const models = createModels({
    authContext: {
      async env(name) {
        return name === SESSION_API_KEY_ENV ? apiKey : undefined
      },
      async fileExists() {
        return false
      }
    }
  })
  models.setProvider(provider)
  const model = models.getModel(SESSION_PROVIDER_ID, modelId)
  if (!model) fail('PI_SESSION_MODEL_NOT_ALLOWED')
  return Object.freeze({
    provider,
    models,
    model,
    streamFn: models.streamSimple.bind(models)
  })
}

export function redactSessionSecrets(error, { apiKey, endpoint } = {}) {
  let message = String(error?.message || error || 'session provider failure')
  const secrets = sessionSecretValues({ apiKey, endpoint })
  for (const secret of secrets) message = message.split(secret).join(REDACTED)
  const safe = new Error(message)
  safe.code = typeof error?.code === 'string' && error.code.startsWith('PI_') ? error.code : 'PI_SESSION_PROVIDER_FAILED'
  return safe
}

function sessionSecretValues({ apiKey, endpoint } = {}) {
  const values = [apiKey, endpoint]
  if (typeof endpoint === 'string' && endpoint) {
    try {
      const parsed = new URL(endpoint)
      values.push(canonicalEndpoint(parsed), parsed.origin, normalizedHostname(parsed))
    } catch {}
  }
  return [...new Set(values
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length))]
}

export function containsSessionSecret(value, { apiKey, endpoint } = {}) {
  const secrets = sessionSecretValues({ apiKey, endpoint })
  const seen = new WeakSet()
  const visit = (current) => {
    if (typeof current === 'string') return secrets.some((secret) => current.includes(secret))
    if (!current || typeof current !== 'object' || seen.has(current)) return false
    seen.add(current)
    return Object.entries(current).some(([key, child]) => visit(key) || visit(child))
  }
  return visit(value)
}
