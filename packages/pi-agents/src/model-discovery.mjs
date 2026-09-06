import { normalizeConnectionEndpoint } from './connection-endpoint.mjs'
import { validateSessionEndpoint, createRestrictedSessionFetch, containsSessionSecret, SESSION_MODEL_IDS, sessionProtocolModels, assertSessionModelEffort } from './session-provider.mjs'
import { EFFORTS } from './protocol.mjs'

export const CATALOG_TTL_MS = 5 * 60_000
export const MAX_CATALOG_MODELS = 200
const MAX_BYTES = 256 * 1024
const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u.test(id) && !id.includes('://')
function fail(code) { const error = new Error(code); error.code = code; throw error }
export function knownProtocolCapabilities(protocol) {
  if (protocol === 'anthropic-messages') return sessionProtocolModels().map(({ id, efforts }) => ({ id, efforts, source: 'pinned_sdk' }))
  return SESSION_MODEL_IDS.map((id, index) => ({ id, efforts: EFFORTS.filter((effort) => { try { assertSessionModelEffort(id, effort, undefined, protocol); return true } catch { return false } }), source: index === 0 ? 'host_catalog' : 'pinned_sdk' }))
}

// Project IDs only. Names, descriptions, URLs and instructions are never retained.
export function projectModelCatalog(value, { protocol, apiKey, endpoint, otherSecrets = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.data) || value.data.length > MAX_CATALOG_MODELS) fail('PI_MODEL_CATALOG_SCHEMA_INVALID')
  if (protocol === 'anthropic-messages' ? typeof value.has_more !== 'boolean' : value.object !== 'list') fail('PI_MODEL_CATALOG_SCHEMA_INVALID')
  if (protocol !== 'anthropic-messages' && ['has_more', 'next', 'next_page', 'next_url'].some((key) => Object.hasOwn(value, key))) fail('PI_MODEL_CATALOG_SCHEMA_INVALID')
  const known = new Map(knownProtocolCapabilities(protocol).map((entry) => [entry.id, entry]))
  const entries = []; const ids = new Set(); let filtered = 0
  for (const entry of value.data) {
    if (!entry || typeof entry !== 'object' || !safeId(entry.id)) fail('PI_MODEL_CATALOG_SCHEMA_INVALID')
    if ([{ apiKey, endpoint }, ...otherSecrets].some((secrets) => containsSessionSecret(entry.id, secrets) || secrets.endpoint && entry.id.toLowerCase().includes(new URL(secrets.endpoint).hostname.toLowerCase()))) { filtered++; continue }
    if (ids.has(entry.id)) fail('PI_MODEL_CATALOG_SCHEMA_INVALID')
    ids.add(entry.id)
    const capability = known.get(entry.id)
    let efforts = capability?.efforts || []
    if (protocol === 'anthropic-messages') {
      const caps = entry.capabilities
      if (caps?.effort?.supported === false || caps?.thinking?.types?.adaptive?.supported === false) efforts = []
      efforts = efforts.filter((effort) => caps?.effort?.[effort]?.supported !== false)
    }
    entries.push({ id: entry.id, efforts, capability_source: capability?.source || 'unknown', listed_by_provider: true, inference_verified: false })
  }
  return { entries, partial: protocol === 'anthropic-messages' && value.has_more, filtered_count: filtered }
}

export async function discoverSessionModels({ endpoint, protocol, apiKey, lookup, fetchImpl, timeoutMs = 10_000, otherSecrets = [] }) {
  if (typeof apiKey !== 'string' || !apiKey || Buffer.byteLength(apiKey, 'utf8') > 8192 || apiKey !== apiKey.trim() || /[\u0000-\u001f\u007f]/u.test(apiKey)) fail('PI_SESSION_API_KEY_REQUIRED')
  if (protocol === 'anthropic-messages' && apiKey.includes('sk-ant-oat')) fail('PI_SESSION_OAUTH_UNSUPPORTED')
  const controller = new AbortController()
  let timer
  const operation = (async () => {
    const normalized = await validateSessionEndpoint(normalizeConnectionEndpoint(endpoint, protocol), { lookup })
    if (controller.signal.aborted) fail('PI_MODEL_CATALOG_TIMEOUT')
    const request = createRestrictedSessionFetch({ endpoint: normalized, lookup, fetchImpl })
    const response = await request(`${normalized}${protocol === 'anthropic-messages' ? '/v1/models' : '/models'}`, { method: 'GET', headers: protocol === 'anthropic-messages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' } : { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) { await response.body?.cancel().catch(() => {}); fail(response.status === 401 || response.status === 403 ? 'PI_MODEL_CATALOG_AUTH_FAILED' : response.status === 404 ? 'PI_MODEL_CATALOG_UNAVAILABLE' : 'PI_MODEL_CATALOG_REQUEST_FAILED') }
    if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/iu.test(response.headers.get('content-type') || '')) { await response.body?.cancel().catch(() => {}); fail('PI_MODEL_CATALOG_SCHEMA_INVALID') }
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) { await response.body?.cancel().catch(() => {}); fail('PI_MODEL_CATALOG_TOO_LARGE') }
    if (!response.body?.getReader) fail('PI_MODEL_CATALOG_SCHEMA_INVALID')
    const reader = response.body.getReader(); const chunks = []; let bytes = 0
    const cancel = () => { reader.cancel().catch(() => {}) }
    controller.signal.addEventListener('abort', cancel, { once: true })
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > MAX_BYTES) fail('PI_MODEL_CATALOG_TOO_LARGE')
        chunks.push(part.value)
      }
    } finally { controller.signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (controller.signal.aborted) fail('PI_MODEL_CATALOG_TIMEOUT')
    let value
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { fail('PI_MODEL_CATALOG_SCHEMA_INVALID') }
    return { endpoint: normalized, ...projectModelCatalog(value, { protocol, apiKey, endpoint: normalized, otherSecrets }) }
  })()
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); const error = new Error('PI_MODEL_CATALOG_TIMEOUT'); error.code = error.message; reject(error) }, timeoutMs) })])
  } finally { clearTimeout(timer); controller.abort() }
}

export function catalogCandidates(catalog, declaredPool, protocol, preferredPool = declaredPool) {
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]))
  const entries = catalog.entries.map((entry) => {
    const declared = declaredPool.find(({ id }) => id === entry.id)
    if (entry.capability_source !== 'unknown') return declared ? { ...entry, efforts: entry.efforts.filter((effort) => declared.efforts.includes(effort)) } : entry
    if (protocol === 'anthropic-messages') return entry
    return declared ? { ...entry, efforts: declared.efforts, capability_source: 'user_declared' } : entry
  })
  const usable = new Map(entries.filter(({ efforts }) => efforts.length).map((entry) => [entry.id, entry]))
  const priority = [...preferredPool.map(({ id }) => id), ...declaredPool.map(({ id }) => id), ...knownProtocolCapabilities(protocol).map(({ id }) => id)]
  const selected = [...new Set(priority)].filter((id) => byId.has(id) && usable.has(id)).slice(0, 12)
  return { entries, pool: selected.map((id) => {
    const confirmed = usable.get(id).efforts
    const preferred = preferredPool.find((entry) => entry.id === id)?.efforts.filter((effort) => confirmed.includes(effort))
    return { id, efforts: preferred?.length ? preferred : confirmed }
  }), eligible_count: usable.size, omitted_eligible_count: usable.size - selected.length,
    selection_rule: '先保留当前模型池中被服务商列出的可用声明，再按本机能力目录固定顺序补充，最多 12 项；其余模型可与主 Agent 讨论后选入。' }
}
