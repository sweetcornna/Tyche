import { createHash, createHmac } from 'node:crypto'

export const API_PREFIX = '/api/v4'
export const FIXED_HOSTS = Object.freeze({
  spot_public: 'https://api.gateio.ws',
  usdm_public: 'https://api.gateio.ws',
  usdm_testnet: 'https://api-testnet.gateapi.io'
})

const PAIRS = new Set(['BTC_USDT', 'ETH_USDT'])
const ORDER_TEXT = /^t-TY[EP][0-9a-f]{20,24}$/
const ORDER_ID = /^(?:\d{1,30}|t-TY[EP][0-9a-f]{20,24})$/
const NETWORK_CODE = /^(?:EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEDOUT|UND_ERR_[A-Z_]+)$/
const SENSITIVE_KEY = /^(?:key|sign|authorization|api.?key|secret(?:.?key)?|cookie)$/i

const OPERATIONS = Object.freeze({
  spotTime: { product: 'spot', environments: ['public', 'dry-run'], host: 'spot_public', method: 'GET', path: '/spot/time', auth: false, params: [] },
  spotPair: { product: 'spot', environments: ['public', 'dry-run'], host: 'spot_public', method: 'GET', path: '/spot/currency_pairs/{currency_pair}', auth: false, pathParams: ['currency_pair'], params: [] },
  spotTickers: { product: 'spot', environments: ['public', 'dry-run'], host: 'spot_public', method: 'GET', path: '/spot/tickers', auth: false, params: ['currency_pair'] },
  spotOrderBook: { product: 'spot', environments: ['public', 'dry-run'], host: 'spot_public', method: 'GET', path: '/spot/order_book', auth: false, required: ['currency_pair'], params: ['currency_pair', 'interval', 'limit', 'with_id'] },
  spotCandlesticks: { product: 'spot', environments: ['public', 'dry-run'], host: 'spot_public', method: 'GET', path: '/spot/candlesticks', auth: false, required: ['currency_pair', 'interval'], params: ['currency_pair', 'interval', 'limit', 'from', 'to'] },
  spotAccounts: { product: 'spot', environments: ['dry-run'], host: 'spot_public', method: 'GET', path: '/spot/accounts', auth: true, params: ['currency'] },

  usdmTime: { product: 'usdm', environments: ['public', 'dry-run', 'testnet'], hostByEnvironment: { public: 'usdm_public', 'dry-run': 'usdm_public', testnet: 'usdm_testnet' }, method: 'GET', path: '/spot/time', auth: false, params: [] },
  usdmContract: { product: 'usdm', environments: ['public', 'dry-run', 'testnet'], hostByEnvironment: { public: 'usdm_public', 'dry-run': 'usdm_public', testnet: 'usdm_testnet' }, method: 'GET', path: '/futures/usdt/contracts/{contract}', auth: false, pathParams: ['contract'], params: [] },
  usdmTickers: { product: 'usdm', environments: ['public', 'dry-run', 'testnet'], hostByEnvironment: { public: 'usdm_public', 'dry-run': 'usdm_public', testnet: 'usdm_testnet' }, method: 'GET', path: '/futures/usdt/tickers', auth: false, params: ['contract'] },
  usdmOrderBook: { product: 'usdm', environments: ['public', 'dry-run', 'testnet'], hostByEnvironment: { public: 'usdm_public', 'dry-run': 'usdm_public', testnet: 'usdm_testnet' }, method: 'GET', path: '/futures/usdt/order_book', auth: false, required: ['contract'], params: ['contract', 'interval', 'limit', 'with_id'] },
  usdmFundingRate: { product: 'usdm', environments: ['public', 'dry-run', 'testnet'], hostByEnvironment: { public: 'usdm_public', 'dry-run': 'usdm_public', testnet: 'usdm_testnet' }, method: 'GET', path: '/futures/usdt/funding_rate', auth: false, required: ['contract'], params: ['contract', 'limit'] },
  usdmCandlesticks: { product: 'usdm', environments: ['public', 'dry-run', 'testnet'], hostByEnvironment: { public: 'usdm_public', 'dry-run': 'usdm_public', testnet: 'usdm_testnet' }, method: 'GET', path: '/futures/usdt/candlesticks', auth: false, required: ['contract', 'interval'], params: ['contract', 'interval', 'limit', 'from', 'to'] },
  usdmAccount: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'GET', path: '/futures/usdt/accounts', auth: true, params: [] },
  usdmPositions: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'GET', path: '/futures/usdt/positions', auth: true, params: [] },
  usdmPosition: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'GET', path: '/futures/usdt/positions/{contract}', auth: true, pathParams: ['contract'], params: [] },
  usdmOrders: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'GET', path: '/futures/usdt/orders', auth: true, required: ['status'], params: ['status', 'contract', 'limit', 'offset'] },
  usdmOrder: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'GET', path: '/futures/usdt/orders/{order_id}', auth: true, pathParams: ['order_id'], params: [] },
  usdmTrades: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'GET', path: '/futures/usdt/my_trades', auth: true, required: ['contract'], params: ['contract', 'order', 'limit', 'offset'] },
  usdmPriceOrders: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'GET', path: '/futures/usdt/price_orders', auth: true, required: ['status'], params: ['status', 'contract', 'limit', 'offset'] },
  usdmPriceOrder: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'GET', path: '/futures/usdt/price_orders/{order_id}', auth: true, pathParams: ['order_id'], params: [] },
  usdmPlaceOrder: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'POST', path: '/futures/usdt/orders', auth: true, mutation: true, body: 'order' },
  usdmCancelOrder: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'DELETE', path: '/futures/usdt/orders/{order_id}', auth: true, mutation: true, pathParams: ['order_id'], params: [] },
  usdmPlacePriceOrder: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'POST', path: '/futures/usdt/price_orders', auth: true, mutation: true, body: 'priceOrder' },
  usdmCancelPriceOrder: { product: 'usdm', environments: ['testnet'], host: 'usdm_testnet', method: 'DELETE', path: '/futures/usdt/price_orders/{order_id}', auth: true, mutation: true, pathParams: ['order_id'], params: [] }
})

export const operationDefinitions = Object.freeze(Object.fromEntries(
  Object.entries(OPERATIONS).map(([name, definition]) => [name, Object.freeze({ ...definition })])
))

export class GateRestError extends Error {
  constructor(code, message, details = {}) {
    super(message || code)
    this.name = 'GateRestError'
    this.code = code
    Object.assign(this, details)
  }
}

function reject(code, message, details) {
  throw new GateRestError(code, message, { ambiguous: false, ...details })
}

function normalizeProduct(value) {
  const product = String(value || '').trim().toLowerCase()
  if (!['spot', 'usdm'].includes(product)) reject('GATE_PRODUCT_UNSUPPORTED', 'Gate product must be spot or usdm')
  return product
}

function normalizeEnvironment(value, product) {
  const environment = String(value || '').trim().toLowerCase()
  const allowed = product === 'spot' ? ['public', 'dry-run'] : ['public', 'dry-run', 'testnet']
  if (!allowed.includes(environment)) reject('GATE_ENVIRONMENT_UNSUPPORTED', `Unsupported ${product} environment: ${environment || '(missing)'}`)
  return environment
}

export function credentialNames(product, environment) {
  const p = normalizeProduct(product)
  const e = normalizeEnvironment(environment, p)
  if (p === 'spot' && e === 'dry-run') {
    return Object.freeze({ apiKey: 'GATE_SPOT_READONLY_API_KEY', secretKey: 'GATE_SPOT_READONLY_SECRET_KEY' })
  }
  if (p === 'usdm' && e === 'testnet') {
    return Object.freeze({ apiKey: 'GATE_USDM_TESTNET_API_KEY', secretKey: 'GATE_USDM_TESTNET_SECRET_KEY' })
  }
  return null
}

export function sha512Hex(text) {
  return createHash('sha512').update(String(text ?? ''), 'utf8').digest('hex')
}

export function hmacSha512(secret, text) {
  return createHmac('sha512', String(secret)).update(String(text)).digest('hex')
}

export function signingPayload({ method, path, query = '', body = '', timestamp }) {
  return [String(method).toUpperCase(), String(path), String(query), sha512Hex(body), String(timestamp)].join('\n')
}

function scalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('GATE_PARAMETER_INVALID', 'Numeric request parameters must be finite')
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (value !== null && typeof value === 'object') reject('GATE_PARAMETER_INVALID', 'Nested query parameters are forbidden')
  return String(value)
}

export function canonicalQuery(parameters = {}) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) reject('GATE_PARAMETER_INVALID', 'Query parameters must be an object')
  const entries = Object.entries(parameters)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, scalar(value)])
    .sort(([a], [b]) => a.localeCompare(b))
  const query = new URLSearchParams()
  for (const [key, value] of entries) query.append(key, value)
  return query.toString()
}

function redactText(value) {
  return String(value ?? '')
    .replace(/([?&](?:api_?key|secret(?:_?key)?|sign(?:ature)?)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\b(?:KEY|SIGN|Authorization)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .replace(/\bGATE_[A-Z0-9_]*(?:API_KEY|SECRET_KEY)\s*[:=]\s*\S+/g, '[REDACTED]')
}

export function redactSensitive(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  const result = Array.isArray(value) ? [] : {}
  for (const [key, child] of Object.entries(value)) result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitive(child, seen)
  return result
}

function pair(value, label) {
  const normalized = String(value || '').trim().toUpperCase()
  if (!PAIRS.has(normalized)) reject('GATE_SYMBOL_UNSUPPORTED', `${label} must be BTC_USDT or ETH_USDT`)
  return normalized
}

function orderId(value) {
  const normalized = String(value || '').trim()
  if (!ORDER_ID.test(normalized)) reject('GATE_ORDER_ID_INVALID', 'Order identity must be a numeric Gate ID or Tyche order text')
  return normalized
}

function decimal(value, label, { zero = false } = {}) {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) reject('GATE_DECIMAL_INVALID', `${label} must be a plain non-negative decimal`)
  if (!zero && Number(text) <= 0) reject('GATE_DECIMAL_INVALID', `${label} must be positive`)
  return text
}

function exactFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('GATE_BODY_INVALID', `${label} must be an object`)
  const extras = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extras.length) reject('GATE_BODY_FIELD_FORBIDDEN', `${label} contains unsupported fields: ${extras.join(', ')}`)
}

function validateOrderBody(input) {
  exactFields(input, ['contract', 'size', 'price', 'tif', 'text', 'reduce_only'], 'USDT-M order')
  const contract = pair(input.contract, 'contract')
  const size = Number(input.size)
  if (!Number.isSafeInteger(size) || size === 0) reject('GATE_USDM_SIZE_INVALID', 'USDT-M size must be a non-zero safe integer contract count')
  const price = decimal(input.price, 'price', { zero: true })
  const tif = String(input.tif || '').toLowerCase()
  if (!['gtc', 'ioc'].includes(tif)) reject('GATE_TIF_INVALID', 'USDT-M tif must be gtc or ioc')
  const text = String(input.text || '')
  if (!ORDER_TEXT.test(text)) reject('GATE_ORDER_TEXT_INVALID', 'USDT-M text must be a deterministic Tyche identifier')
  if (input.reduce_only !== undefined && input.reduce_only !== true) reject('GATE_REDUCE_ONLY_INVALID', 'reduce_only may be omitted or true')
  return { contract, size, price, tif, text, ...(input.reduce_only === true ? { reduce_only: true } : {}) }
}

function validatePriceOrderBody(input) {
  exactFields(input, ['initial', 'trigger'], 'USDT-M price order')
  exactFields(input.initial, ['contract', 'size', 'price', 'tif', 'text', 'reduce_only'], 'USDT-M price order initial')
  exactFields(input.trigger, ['strategy_type', 'price_type', 'price', 'rule', 'expiration'], 'USDT-M price order trigger')
  if (input.initial.reduce_only !== true) reject('GATE_PROTECTION_REDUCE_ONLY_REQUIRED', 'Protection must be reduce-only')
  const initial = validateOrderBody(input.initial)
  const strategyType = Number(input.trigger.strategy_type)
  const priceType = Number(input.trigger.price_type)
  const rule = Number(input.trigger.rule)
  const expiration = Number(input.trigger.expiration ?? 86400)
  if (strategyType !== 0 || ![0, 1, 2].includes(priceType) || ![1, 2].includes(rule) || !Number.isSafeInteger(expiration) || expiration <= 0) {
    reject('GATE_TRIGGER_INVALID', 'Protection trigger fields are invalid')
  }
  return {
    initial,
    trigger: { strategy_type: strategyType, price_type: priceType, price: decimal(input.trigger.price, 'trigger.price'), rule, expiration }
  }
}

function normalizeInput(name, definition, input) {
  const value = input === undefined ? {} : input
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('GATE_PARAMETER_INVALID', `${name} input must be an object`)
  for (const key of Object.keys(value)) if (SENSITIVE_KEY.test(key)) reject('GATE_SENSITIVE_PARAMETER_FORBIDDEN', `${name} does not accept credential fields`)
  if (definition.body === 'order') return validateOrderBody(value)
  if (definition.body === 'priceOrder') return validatePriceOrderBody(value)

  const allowed = new Set([...(definition.pathParams || []), ...(definition.params || [])])
  const extras = Object.keys(value).filter((key) => !allowed.has(key))
  if (extras.length) reject('GATE_PARAMETER_FORBIDDEN', `${name} contains unsupported parameters: ${extras.join(', ')}`)
  for (const required of definition.required || []) {
    if (value[required] === undefined || value[required] === null || value[required] === '') reject('GATE_PARAMETER_REQUIRED', `${name} requires ${required}`)
  }
  const output = { ...value }
  for (const key of ['currency_pair', 'contract']) if (output[key] !== undefined) output[key] = pair(output[key], key)
  if (output.currency !== undefined && String(output.currency).toUpperCase() !== 'USDT') reject('GATE_ASSET_UNSUPPORTED', 'Signed Spot account read is limited to USDT')
  if (output.currency !== undefined) output.currency = 'USDT'
  if (output.order_id !== undefined) output.order_id = orderId(output.order_id)
  if (output.status !== undefined && !['open', 'finished'].includes(String(output.status).toLowerCase())) reject('GATE_STATUS_INVALID', 'Order status must be open or finished')
  if (output.status !== undefined) output.status = String(output.status).toLowerCase()
  for (const key of ['limit', 'offset', 'from', 'to']) {
    if (output[key] !== undefined && (!Number.isSafeInteger(Number(output[key])) || Number(output[key]) < 0)) reject('GATE_PARAMETER_INVALID', `${key} must be a non-negative integer`)
  }
  if (output.interval !== undefined && !new Set(['4h', '1d', '7d']).has(String(output.interval))) reject('GATE_INTERVAL_INVALID', 'Candlestick interval must be 4h, 1d, or 7d')
  return output
}

function safeMessage(body) {
  const message = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : ''
  return redactText(message).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240)
}

function responseHeaders(headers) {
  const result = {}
  if (!headers) return result
  if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) result[String(key).toLowerCase()] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactText(value)
  } else {
    for (const [key, value] of Object.entries(headers)) result[String(key).toLowerCase()] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactText(value)
  }
  return result
}

async function responseBody(response) {
  const text = typeof response?.text === 'function' ? await response.text() : ''
  if (!text) return null
  try { return JSON.parse(text) } catch { return redactText(text).slice(0, 500) }
}

export function classifyHttpOutcome(status, body) {
  const code = body && typeof body === 'object' && body.label ? String(body.label) : null
  const numeric = Number(status)
  const ambiguous = numeric === 408 || numeric >= 500
  const rateLimited = numeric === 429 || ['TOO_MANY_REQUESTS', 'TOO_BUSY'].includes(code)
  const timestamp = ['REQUEST_EXPIRED', 'INVALID_TIMESTAMP'].includes(code)
  return Object.freeze({
    ok: numeric >= 200 && numeric < 300 && !code,
    status: numeric,
    code,
    ambiguous,
    rateLimited,
    timestamp,
    kind: ambiguous ? 'AMBIGUOUS' : rateLimited ? 'RATE_LIMITED' : timestamp ? 'TIMESTAMP' : numeric >= 400 && numeric < 500 ? 'CLIENT_ERROR' : 'SUCCESS'
  })
}

export function isAmbiguousSubmit(error) {
  if (!error) return false
  if (error.ambiguous === true) return true
  const status = Number(error.status ?? error.statusCode)
  if (status === 408 || status >= 500) return true
  const code = String(error.code || '')
  if (NETWORK_CODE.test(code)) return true
  return error.name === 'AbortError' || error.name === 'TimeoutError' || /timed? out|fetch failed|socket|connection reset|aborted/i.test(String(error.message || ''))
}

export function isDefinitiveOrderNotFound(error, identity) {
  return error?.definitiveNotFound === true
    && error?.operation === 'usdmOrder'
    && String(error?.lookupIdentity || '') === String(identity || '')
}

function hostFor(definition, environment) {
  const key = definition.hostByEnvironment?.[environment] || definition.host
  const host = FIXED_HOSTS[key]
  if (!host) reject('GATE_HOST_MAPPING_INVALID', 'Fixed host mapping is incomplete')
  return host
}

export function createGateClient(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) reject('GATE_OPTIONS_INVALID', 'Client options must be an object')
  const forbiddenOptions = ['url', 'baseUrl', 'baseURL', 'host', 'endpoint', 'apiKey', 'secret', 'headers', 'method', 'env']
  const present = forbiddenOptions.filter((key) => Object.prototype.hasOwnProperty.call(options, key))
  if (present.length) reject('GATE_CLIENT_OVERRIDE_FORBIDDEN', `Client routing and credentials cannot be supplied as options: ${present.join(', ')}`)
  const product = normalizeProduct(options.product)
  const environment = normalizeEnvironment(options.environment, product)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now
  const timeoutMs = Number(options.timeoutMs ?? 10000)
  const readOnly = options.readOnly === true
  const env = process.env
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') reject('GATE_CLIENT_DEPENDENCY_INVALID', 'fetch and now functions are required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) reject('GATE_TIMEOUT_INVALID', 'timeoutMs must be in (0, 30000]')
  let clockOffsetMs = 0

  function credentials() {
    const names = credentialNames(product, environment)
    if (!names) reject('GATE_CREDENTIAL_SCOPE_UNAVAILABLE', 'This client environment has no signed account scope')
    const apiKey = String(env[names.apiKey] || '')
    const secretKey = String(env[names.secretKey] || '')
    if (!apiKey) reject('GATE_API_KEY_MISSING', `Missing ${names.apiKey}`)
    if (!secretKey) reject('GATE_SECRET_KEY_MISSING', `Missing ${names.secretKey}`)
    return { apiKey, secretKey }
  }

  async function invoke(name, rawInput = {}, attempt = 0) {
    const definition = OPERATIONS[name]
    if (!definition) reject('GATE_OPERATION_UNSUPPORTED', `Unsupported Gate operation: ${name}`)
    if (definition.product !== product) reject('GATE_OPERATION_PRODUCT_MISMATCH', `${name} is not a ${product} operation`)
    if (!definition.environments.includes(environment)) reject('GATE_OPERATION_ENVIRONMENT_MISMATCH', `${name} is not available in ${environment}`)
    if (definition.mutation && (readOnly || environment !== 'testnet' || product !== 'usdm')) reject('GATE_MUTATION_FORBIDDEN', 'Mutations are limited to non-read-only USDT-M testnet clients')
    const input = normalizeInput(name, definition, rawInput)
    const lookupIdentity = name === 'usdmOrder' ? String(input.order_id || '') : null
    let relativePath = definition.path
    for (const field of definition.pathParams || []) {
      const raw = input[field]
      if (raw === undefined || raw === null || raw === '') reject('GATE_PARAMETER_REQUIRED', `${name} requires ${field}`)
      relativePath = relativePath.replace(`{${field}}`, encodeURIComponent(String(raw)))
      delete input[field]
    }
    const pathWithPrefix = `${API_PREFIX}${relativePath}`
    const hasBody = definition.method === 'POST'
    const body = hasBody ? JSON.stringify(input) : ''
    const query = hasBody ? '' : canonicalQuery(input)
    const headers = { Accept: 'application/json' }
    if (hasBody) headers['Content-Type'] = 'application/json'
    if (definition.auth) {
      const { apiKey, secretKey } = credentials()
      const time = Number(now()) + clockOffsetMs
      if (!Number.isFinite(time)) reject('GATE_CLOCK_INVALID', 'now() returned an invalid timestamp')
      const timestamp = String(Math.floor(time / 1000))
      headers.KEY = apiKey
      headers.Timestamp = timestamp
      headers.SIGN = hmacSha512(secretKey, signingPayload({ method: definition.method, path: pathWithPrefix, query, body, timestamp }))
    }
    const url = `${hostFor(definition, environment)}${pathWithPrefix}${query ? `?${query}` : ''}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    let data
    try {
      response = await fetchImpl(url, { method: definition.method, headers, ...(hasBody ? { body } : {}), redirect: 'error', signal: controller.signal })
      data = await responseBody(response)
    } catch (cause) {
      const code = NETWORK_CODE.test(String(cause?.code || '')) ? cause.code : cause?.name === 'AbortError' ? 'ETIMEDOUT' : 'GATE_NETWORK_ERROR'
      throw new GateRestError(code, `Gate ${name} request failed`, { ambiguous: definition.mutation === true, cause: undefined })
    } finally {
      clearTimeout(timer)
    }
    const outcome = classifyHttpOutcome(response?.status, data)
    const safeHeaders = responseHeaders(response?.headers)
    if (!outcome.ok) {
      const error = new GateRestError(outcome.code || `GATE_HTTP_${outcome.status}`, `Gate ${name} failed`, {
        status: outcome.status,
        label: outcome.code,
        detail: safeMessage(data),
        retryAfter: safeHeaders['retry-after'] ?? null,
        ambiguous: definition.mutation && outcome.ambiguous,
        rateLimited: outcome.rateLimited,
        operation: name,
        lookupIdentity,
        definitiveNotFound: name === 'usdmOrder' && outcome.status === 404
      })
      if (definition.auth && definition.method === 'GET' && outcome.timestamp && attempt === 0) {
        await synchronizeTime()
        return invoke(name, rawInput, 1)
      }
      throw error
    }
    return { ok: true, status: Number(response.status), data, headers: safeHeaders }
  }

  async function synchronizeTime() {
    const probes = []
    for (let index = 0; index < 3; index += 1) {
      const started = Number(now())
      try {
        const result = await invoke(product === 'spot' ? 'spotTime' : 'usdmTime', {})
        const ended = Number(now())
        const server = Number(result.data?.server_time ?? result.data?.serverTime)
        if (Number.isFinite(started) && Number.isFinite(ended) && Number.isFinite(server) && ended >= started) {
          const rtt = ended - started
          probes.push({ index, rtt, offset: server - (started + rtt / 2) })
        }
      } catch {
        // Three independent public probes are attempted before failing closed.
      }
    }
    probes.sort((a, b) => a.rtt - b.rtt || a.index - b.index)
    if (!probes.length) reject('GATE_TIME_SYNC_FAILED', 'Could not establish Gate server time')
    clockOffsetMs = probes[0].offset
    return { ok: true, offset_ms: clockOffsetMs, probes: probes.length }
  }

  async function findUsdmOrderByText(text) {
    if (product !== 'usdm' || environment !== 'testnet') reject('GATE_ORDER_LOOKUP_SCOPE', 'Exact order recovery is USDT-M testnet-only')
    const identity = orderId(text)
    const order = (await invoke('usdmOrder', { order_id: identity })).data
    if (!order || String(order.text || '') !== identity) reject('GATE_ORDER_IDENTITY_MISMATCH', 'Exact Gate client text was not returned')
    if (order.id === undefined && order.order_id === undefined) reject('GATE_ORDER_IDENTITY_MISSING', 'Exact Gate venue order identity was not returned')
    return order
  }

  const client = { product, environment, synchronizeTime, findUsdmOrderByText }
  for (const name of Object.keys(OPERATIONS)) client[name] = (input = {}) => invoke(name, input)
  return Object.freeze(client)
}
