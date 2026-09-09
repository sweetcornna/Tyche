import { isPublicSessionAddress } from './session-address.mjs'
export { isPublicSessionAddress } from './session-address.mjs'
import { sessionLookup, fetchPinnedSession } from './session-network.mjs'
import { normalizeConnectionEndpoint } from './connection-endpoint.mjs'
import net from 'node:net'
import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  envApiKeyAuth
} from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { validateModelPool } from './model-pool.mjs'
import { ROLES, EFFORTS, DEFAULT_ROLE_EFFORTS, DEFAULT_SESSION_PROTOCOL, validateSessionProtocol } from './protocol.mjs'

export const SESSION_PROVIDER_ID = 'openai-responses-compatible'
export const SESSION_API_KEY_ENV = 'TYCHE_PI_SESSION_API_KEY'
export const SESSION_ENDPOINT_ENV = 'TYCHE_PI_SESSION_ENDPOINT'
export const SESSION_MODEL_IDS = Object.freeze(['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4-mini'])
export const SESSION_OUTPUT_BUDGET = 16384
export const MAX_SESSION_ENDPOINT_BYTES = 2048

export const DEFAULT_SESSION_POOL = Object.freeze([Object.freeze({ id: SESSION_MODEL_IDS[0], efforts: EFFORTS })])
const SESSION_MODEL_SET = new Set(SESSION_MODEL_IDS)
const REDACTED = '[session-secret-redacted]'

export function sessionProtocolModels() {
  return builtinModels().getModels('anthropic').filter((model) => model.api === 'anthropic-messages' && model.compat?.forceAdaptiveThinking === true)
    .map((model) => ({ id: model.id, protocol: 'anthropic-messages', efforts: EFFORTS.filter((effort) => { try { assertModelEffort(model, effort); return true } catch { return false } }) }))
}

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

export function validateSessionRoleModels(value, pool) {
  const allowed = pool ? new Set(validateSessionPool(pool).map(({ id }) => id)) : SESSION_MODEL_SET
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([role, model]) => !ROLES.includes(role) || typeof model !== 'string' || !allowed.has(model))) fail('PI_SESSION_ROLE_MODELS_INVALID')
  return Object.freeze(Object.fromEntries(ROLES.filter((role) => Object.hasOwn(value, role)).map((role) => [role, value[role]])))
}

export function effectiveSessionRoleModels(defaultModel, overrides = {}, pool) {
  if (!(pool ? validateSessionPool(pool).some(({ id }) => id === defaultModel) : SESSION_MODEL_SET.has(defaultModel))) fail('PI_SESSION_MODEL_NOT_ALLOWED')
  const configured = validateSessionRoleModels(overrides, pool)
  return Object.freeze(Object.fromEntries(ROLES.map((role) => [role, configured[role] || defaultModel])))
}

export function validateSessionRoleEfforts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([role, effort]) => !ROLES.includes(role) || !EFFORTS.includes(effort))) fail('PI_SESSION_ROLE_EFFORTS_INVALID')
  return Object.freeze(Object.fromEntries(ROLES.filter((role) => Object.hasOwn(value, role)).map((role) => [role, value[role]])))
}

export function effectiveSessionRoleEfforts(overrides = {}) {
  return Object.freeze({ ...DEFAULT_ROLE_EFFORTS, ...validateSessionRoleEfforts(overrides) })
}

export function assertSessionModelEffort(modelId, effort, pool, protocol = DEFAULT_SESSION_PROTOCOL) {
  const declaration = pool ? validateSessionPool(pool).find(({ id }) => id === modelId) : null
  if (pool && !declaration?.efforts.includes(effort)) fail('PI_SESSION_MODEL_EFFORT_UNSUPPORTED')
  const model = protocolModel(modelId, '', builtinModels(), declaration, validateSessionProtocol(protocol))
  assertModelEffort(model, effort)
}

export function assertModelEffort(model, effort) {
  if (!EFFORTS.includes(effort) || !getSupportedThinkingLevels(model).includes(effort) || (model.thinkingLevelMap?.[effort] ?? effort) !== effort) fail('PI_SESSION_MODEL_EFFORT_UNSUPPORTED')
}

export function validateSessionPool(value) {
  const pool = validateModelPool(value)
  for (const entry of pool) if (SESSION_MODEL_SET.has(entry.id)) for (const effort of entry.efforts) assertModelEffort(cloneSessionModel(entry.id, '', builtinModels()), effort)
  return pool
}

export function sessionPoolMetadata(pool, protocol = DEFAULT_SESSION_PROTOCOL) {
  return validateSessionPool(pool).map((entry) => {
    const anthropic = protocol === 'anthropic-messages' ? builtinModels().getModel('anthropic', entry.id) : null
    const known = anthropic || (SESSION_MODEL_SET.has(entry.id) && entry.id !== SESSION_MODEL_IDS[0] ? builtinModels().getModel('openai', entry.id) : null)
    return { ...entry, source: entry.id === SESSION_MODEL_IDS[0] ? 'host_catalog' : known ? 'pinned_sdk' : 'user_declared', gateway_verified: false, context_window: entry.id === SESSION_MODEL_IDS[0] ? 272000 : known?.contextWindow ?? null }
  })
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
  } catch (error) {
    if (error?.code === 'PI_SESSION_ENDPOINT_PROXY_DNS_FAILED') fail(error.code)
    fail('PI_SESSION_ENDPOINT_DNS_FAILED')
  }
  if (!Array.isArray(records) || records.length === 0) fail('PI_SESSION_ENDPOINT_DNS_FAILED')
  for (const record of records) {
    if (!record || typeof record.address !== 'string' || !isPublicSessionAddress(record.address)) {
      fail('PI_SESSION_ENDPOINT_NOT_PUBLIC')
    }
  }
  return records
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
    return [{ address: hostname, family: net.isIP(hostname) }]
  }
  if (url.protocol !== 'https:') fail('PI_SESSION_ENDPOINT_PROTOCOL_FORBIDDEN')

  const kind = net.isIP(hostname)
  if (kind) {
    if (!isPublicSessionAddress(hostname)) fail('PI_SESSION_ENDPOINT_NOT_PUBLIC')
    return [{ address: hostname, family: kind }]
  }
  return resolveAll(hostname, lookup)
}

function canonicalEndpoint(url) {
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${pathname}`
}

export async function validateSessionEndpoint(value, { lookup = sessionLookup } = {}) {
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

export function createRestrictedSessionFetch({ endpoint, lookup = sessionLookup, fetchImpl }) {
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') fail('PI_SESSION_FETCH_REQUIRED')
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
    const records = await validateParsedUrl(target, raw, lookup)
    if (target.origin !== endpointUrl.origin) fail('PI_SESSION_REQUEST_ORIGIN_FORBIDDEN')
    if (!withinPathPrefix(target.pathname, endpointPrefix)) fail('PI_SESSION_REQUEST_PATH_FORBIDDEN')

    const response = fetchImpl
      ? await fetchImpl(input, { ...init, redirect: 'manual' })
      : await fetchPinnedSession(input, { ...init, redirect: 'manual' }, records)
    if (!response || !Number.isInteger(response.status)) fail('PI_SESSION_RESPONSE_INVALID')
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); fail('PI_SESSION_REDIRECT_FORBIDDEN') }
    return response
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function cloneSessionModel(id, endpoint, sourceModels, declaration) {
  if (!SESSION_MODEL_SET.has(id)) {
    if (!declaration || declaration.id !== id) fail('PI_SESSION_MODEL_NOT_ALLOWED')
    return deepFreeze({ id, name: id, api: 'openai-responses', provider: SESSION_PROVIDER_ID, baseUrl: endpoint, reasoning: true,
      thinkingLevelMap: Object.fromEntries(['off', 'minimal', 'low', ...EFFORTS, 'max'].map((effort) => [effort, declaration.efforts.includes(effort) ? effort : null])),
      // Zero is the SDK's unknown-context sentinel, not a model capacity.
      // Text-only is this application's input restriction; cost is unpriced.
      input: ['text'], contextWindow: 0, maxTokens: SESSION_OUTPUT_BUDGET, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  }
  if (id === SESSION_MODEL_IDS[0]) return deepFreeze({
    id, name: 'Astra (Tyche session)', api: 'openai-responses', provider: SESSION_PROVIDER_ID, baseUrl: endpoint,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: 'medium', high: 'high', xhigh: 'xhigh', max: null },
    // Context and modalities were verified from the local host catalog. This
    // request budget is an application ceiling, not a claimed model maximum.
    input: ['text', 'image'], contextWindow: 272000, maxTokens: SESSION_OUTPUT_BUDGET,
    // The SDK requires numeric rates. These are unpriced placeholders only;
    // Tyche does not expose usage costs or claim a known/free Astra price.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  })
  const source = sourceModels.getModel('openai', id)
  if (!source || source.api !== 'openai-responses') fail('PI_SESSION_MODEL_SOURCE_INVALID')
  const model = structuredClone(source)
  model.provider = SESSION_PROVIDER_ID
  model.baseUrl = endpoint
  model.name = `${source.name} (Tyche session)`
  return deepFreeze(model)
}

function protocolModel(id, endpoint, sourceModels, declaration, protocol) {
  if (protocol === 'anthropic-messages') {
    const source = sourceModels.getModel('anthropic', id)
    if (!source || source.api !== protocol || source.compat?.forceAdaptiveThinking !== true) fail('PI_SESSION_PROTOCOL_MODEL_UNSUPPORTED')
    for (const effort of declaration?.efforts || []) assertModelEffort(source, effort)
    const model = structuredClone(source)
    model.provider = SESSION_PROVIDER_ID
    model.baseUrl = endpoint
    model.name = `${source.name} (Tyche session)`
    // Only native effort values are accepted; no budget translation or fallback model.
    model.thinkingLevelMap = { ...model.thinkingLevelMap, medium: 'medium', high: 'high' }
    delete model.compat.allowedFallbackModels
    for (const effort of declaration?.efforts || []) assertModelEffort(model, effort)
    return deepFreeze(model)
  }
  const model = cloneSessionModel(id, endpoint, sourceModels, declaration)
  if (protocol === 'openai-responses') return model
  // The user selected the OpenAI wire format; endpoint names cannot switch it.
  return deepFreeze({ ...structuredClone(model), api: protocol, compat: { supportsReasoningEffort: true, thinkingFormat: 'openai', maxTokensField: 'max_completion_tokens' } })
}

function assertProtocolEndpoint(endpoint, protocol) {
  const pathname = new URL(endpoint).pathname.replace(/\/+$/u, '')
  if (/(?:\/responses|\/chat\/completions|\/messages)$/u.test(pathname) || (protocol === 'anthropic-messages' && /\/v1$/u.test(pathname))) fail('PI_SESSION_ENDPOINT_OPERATION_FORBIDDEN')
}

export async function createSessionProviderRuntime({
  endpoint,
  apiKey,
  modelId,
  modelPool,
  protocol = DEFAULT_SESSION_PROTOCOL,
  lookup = sessionLookup,
  fetchImpl
} = {}) {
  protocol = validateSessionProtocol(protocol)
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('PI_SESSION_API_KEY_REQUIRED')
  if (protocol === 'anthropic-messages' && apiKey.includes('sk-ant-oat')) fail('PI_SESSION_OAUTH_UNSUPPORTED')
  const pool = modelPool ? validateSessionPool(modelPool) : validateSessionPool(SESSION_MODEL_IDS.map((id) => ({ id, efforts: EFFORTS.filter((effort) => { try { assertSessionModelEffort(id, effort); return true } catch { return false } }) })))
  if (containsSessionSecret({ pool, protocol }, { apiKey, endpoint })) fail('PI_SESSION_SECRET_IN_MODEL_POOL')
  if (!pool.some(({ id }) => id === modelId)) fail('PI_SESSION_MODEL_NOT_ALLOWED')
  const normalizedEndpoint = await validateSessionEndpoint(normalizeConnectionEndpoint(endpoint, protocol), { lookup })
  assertProtocolEndpoint(normalizedEndpoint, protocol)
  const restrictedFetch = createRestrictedSessionFetch({ endpoint: normalizedEndpoint, lookup, fetchImpl })
  const sourceModels = builtinModels()
  const modelsForProvider = pool.map((entry) => protocolModel(entry.id, normalizedEndpoint, sourceModels, entry, protocol))
  const trustedModels = new Map(modelsForProvider.map((model) => [model.id, model]))
  const selectedApi = protocol === 'openai-responses' ? openAIResponsesApi() : protocol === 'openai-completions' ? openAICompletionsApi() : anthropicMessagesApi()
  const trustedModel = (candidate) => {
    const model = trustedModels.get(candidate?.id)
    if (!model || candidate?.provider !== SESSION_PROVIDER_ID || candidate?.api !== protocol) {
      fail('PI_SESSION_MODEL_NOT_ALLOWED')
    }
    return model
  }
  const api = {
    stream(model, context, options) {
      assertSessionModelEffort(model?.id, protocol === 'anthropic-messages' ? options?.effort : options?.reasoningEffort, pool, protocol)
      return selectedApi.stream(trustedModel(model), context, { ...options, maxTokens: outputBudget(options), fetch: restrictedFetch })
    },
    streamSimple(model, context, options) {
      assertSessionModelEffort(model?.id, options?.reasoning, pool, protocol)
      return selectedApi.streamSimple(trustedModel(model), context, { ...options, maxTokens: outputBudget(options), fetch: restrictedFetch })
    }
  }
  const provider = createProvider({
    id: SESSION_PROVIDER_ID,
    name: 'Tyche session API connection',
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
    protocol,
    provider,
    models,
    model,
    pricing: modelId === SESSION_MODEL_IDS[0] || !SESSION_MODEL_SET.has(modelId) ? 'unavailable' : 'catalog',
    streamFn: models.streamSimple.bind(models)
  })
}

function outputBudget(options) {
  const requested = options?.maxTokens ?? SESSION_OUTPUT_BUDGET
  if (!Number.isInteger(requested) || requested < 1) fail('PI_SESSION_OUTPUT_BUDGET_INVALID')
  return Math.min(requested, SESSION_OUTPUT_BUDGET)
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
