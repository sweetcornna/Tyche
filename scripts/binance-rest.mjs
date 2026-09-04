import { createHmac } from 'node:crypto'
import {
  decimalAbs,
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  decimalPositive,
  decimalSubtract,
  divideToStep
} from './gate-account-context.mjs'

export const BINANCE_FIXED_HOSTS = Object.freeze({
  usdm_public: 'https://fapi.binance.com',
  usdm_testnet: 'https://testnet.binancefuture.com'
})

const PAIRS = Object.freeze(['BTC_USDT', 'ETH_USDT'])
const PAIR_TO_SYMBOL = Object.freeze({ BTC_USDT: 'BTCUSDT', ETH_USDT: 'ETHUSDT' })
const SYMBOL_TO_PAIR = Object.freeze({ BTCUSDT: 'BTC_USDT', ETHUSDT: 'ETH_USDT' })
const CLIENT_ID = /^t-TY[EP][0-9a-f]{20,24}$/
const ORDER_ID = /^(?:\d{1,30}|t-TY[EP][0-9a-f]{20,24})$/
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const NETWORK_CODE = /^(?:EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEDOUT|UND_ERR_[A-Z_]+)$/
const SENSITIVE_KEY = /^(?:key|signature|authorization|api.?key|secret(?:.?key)?|cookie)$/i

const OPERATIONS = Object.freeze({
  time: { environments: ['public', 'testnet'], method: 'GET', path: '/fapi/v1/time', auth: false, params: [] },
  exchangeInfo: { environments: ['public', 'testnet'], method: 'GET', path: '/fapi/v1/exchangeInfo', auth: false, params: [] },
  premiumIndex: { environments: ['public', 'testnet'], method: 'GET', path: '/fapi/v1/premiumIndex', auth: false, params: ['symbol'] },
  bookTicker: { environments: ['public', 'testnet'], method: 'GET', path: '/fapi/v1/ticker/bookTicker', auth: false, params: ['symbol'] },
  depth: { environments: ['public', 'testnet'], method: 'GET', path: '/fapi/v1/depth', auth: false, params: ['symbol', 'limit'], required: ['symbol'] },
  klines: { environments: ['public', 'testnet'], method: 'GET', path: '/fapi/v1/klines', auth: false, params: ['symbol', 'interval', 'limit', 'startTime', 'endTime'], required: ['symbol', 'interval'] },
  markPriceKlines: { environments: ['public', 'testnet'], method: 'GET', path: '/fapi/v1/markPriceKlines', auth: false, params: ['symbol', 'interval', 'limit', 'startTime', 'endTime'], required: ['symbol', 'interval'] },
  account: { environments: ['testnet'], method: 'GET', path: '/fapi/v3/account', auth: true, params: [] },
  positionRisk: { environments: ['testnet'], method: 'GET', path: '/fapi/v2/positionRisk', auth: true, params: ['symbol'] },
  positionMode: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/positionSide/dual', auth: true, params: [] },
  commissionRate: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/commissionRate', auth: true, params: ['symbol'], required: ['symbol'] },
  leverageBracket: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/leverageBracket', auth: true, params: ['symbol'], required: ['symbol'] },
  openOrders: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/openOrders', auth: true, params: ['symbol'] },
  allOrders: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/allOrders', auth: true, params: ['symbol', 'limit'], required: ['symbol'] },
  queryOrder: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/order', auth: true, params: ['symbol', 'orderId', 'origClientOrderId'], required: ['symbol'] },
  userTrades: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/userTrades', auth: true, params: ['symbol', 'orderId', 'limit'], required: ['symbol'] },
  openAlgoOrders: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/openAlgoOrders', auth: true, params: ['symbol', 'algoType', 'algoId'] },
  allAlgoOrders: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/allAlgoOrders', auth: true, params: ['symbol', 'algoId', 'limit'], required: ['symbol'] },
  queryAlgoOrder: { environments: ['testnet'], method: 'GET', path: '/fapi/v1/algoOrder', auth: true, params: ['algoId', 'clientAlgoId'] },
  placeOrder: { environments: ['testnet'], method: 'POST', path: '/fapi/v1/order', auth: true, mutation: true, params: ['symbol', 'side', 'positionSide', 'type', 'timeInForce', 'quantity', 'price', 'newClientOrderId', 'newOrderRespType', 'reduceOnly'] },
  cancelOrder: { environments: ['testnet'], method: 'DELETE', path: '/fapi/v1/order', auth: true, mutation: true, params: ['symbol', 'orderId', 'origClientOrderId'], required: ['symbol'] },
  placeAlgoOrder: { environments: ['testnet'], method: 'POST', path: '/fapi/v1/algoOrder', auth: true, mutation: true, params: ['algoType', 'symbol', 'side', 'positionSide', 'type', 'quantity', 'triggerPrice', 'workingType', 'reduceOnly', 'clientAlgoId', 'newOrderRespType'] },
  cancelAlgoOrder: { environments: ['testnet'], method: 'DELETE', path: '/fapi/v1/algoOrder', auth: true, mutation: true, params: ['algoId', 'clientAlgoId'] }
})

for (const definition of Object.values(OPERATIONS)) {
  Object.freeze(definition.environments)
  Object.freeze(definition.params)
  if (definition.required) Object.freeze(definition.required)
}

export const binanceOperationDefinitions = Object.freeze(Object.fromEntries(
  Object.entries(OPERATIONS).map(([name, definition]) => [name, Object.freeze({ ...definition })])
))

export class BinanceRestError extends Error {
  constructor(code, message, details = {}) {
    super(message || code)
    this.name = 'BinanceRestError'
    this.code = code
    Object.assign(this, { ambiguous: false, ...details })
  }
}

function reject(code, message, details) {
  throw new BinanceRestError(code, message, details)
}

function safeDecimal(value, label, { zero = false } = {}) {
  const text = String(value ?? '').trim()
  if (!DECIMAL.test(text) || (!zero && !decimalPositive(text))) reject('BINANCE_DECIMAL_INVALID', `${label} must be a plain ${zero ? 'non-negative' : 'positive'} decimal`)
  return text
}

function exactInteger(value, label, { nonZero = false } = {}) {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'object' && value !== null)) reject('BINANCE_SIZE_INVALID', `${label} must be an exact integer unit count`)
  const text = String(value).trim()
  if (!/^-?\d+$/.test(text)) reject('BINANCE_SIZE_INVALID', `${label} must be an exact integer unit count`)
  const units = Number(text)
  if (!Number.isSafeInteger(units) || (nonZero && units === 0)) reject('BINANCE_SIZE_INVALID', `${label} must be a${nonZero ? ' non-zero' : 'n'} exact integer unit count`)
  return units
}

function exactSignedUnits(value, label) {
  return exactInteger(value, label, { nonZero: true })
}

function boundedLimit(value, label = 'limit') {
  if (value === undefined || value === null) return 100
  if (typeof value === 'boolean' || (typeof value === 'object' && value !== null)) reject('BINANCE_PARAMETER_INVALID', `${label} must be a positive integer`)
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) reject('BINANCE_PARAMETER_INVALID', `${label} must be a positive integer`)
  const limit = Number(text)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) reject('BINANCE_PARAMETER_INVALID', `${label} must be an integer from 1 through 1000`)
  return limit
}

function pair(value) {
  const normalized = String(value || '').trim().toUpperCase()
  if (!PAIR_TO_SYMBOL[normalized]) reject('BINANCE_SYMBOL_UNSUPPORTED', 'Symbol must be BTC_USDT or ETH_USDT')
  return normalized
}

function symbol(value) {
  const normalized = String(value || '').trim().toUpperCase()
  if (!SYMBOL_TO_PAIR[normalized]) reject('BINANCE_SYMBOL_UNSUPPORTED', 'Binance symbol must be BTCUSDT or ETHUSDT')
  return normalized
}

function environment(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!['public', 'testnet'].includes(normalized)) reject('BINANCE_ENVIRONMENT_UNSUPPORTED', 'Binance environment must be public or testnet')
  return normalized
}

export function binanceCredentialNames(value) {
  return environment(value) === 'testnet'
    ? Object.freeze({ apiKey: 'BINANCE_USDM_TESTNET_API_KEY', secretKey: 'BINANCE_USDM_TESTNET_SECRET_KEY' })
    : null
}

function scalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('BINANCE_PARAMETER_INVALID', 'Numeric parameters must be finite')
    return String(value)
  }
  if (value !== null && typeof value === 'object') reject('BINANCE_PARAMETER_INVALID', 'Nested parameters are forbidden')
  return String(value)
}

export function binanceCanonicalQuery(parameters = {}) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) reject('BINANCE_PARAMETER_INVALID', 'Parameters must be an object')
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters).filter(([, value]) => value !== null && value !== undefined).sort(([a], [b]) => a.localeCompare(b))) query.append(key, scalar(value))
  return query.toString()
}

export function hmacSha256(secret, payload) {
  return createHmac('sha256', String(secret)).update(String(payload), 'utf8').digest('hex')
}

function redactText(value) {
  return String(value ?? '')
    .replace(/([?&](?:api_?key|secret(?:_?key)?|signature)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\bBINANCE_[A-Z0-9_]*(?:API_KEY|SECRET_KEY)\s*[:=]\s*\S+/g, '[REDACTED]')
}

function responseHeaders(headers) {
  const output = {}
  if (!headers) return output
  const entries = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers)
  for (const [key, value] of entries) output[String(key).toLowerCase()] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactText(value)
  return output
}

async function responseBody(response) {
  const text = typeof response?.text === 'function' ? await response.text() : ''
  if (!text) return null
  try { return JSON.parse(text) } catch { return redactText(text).slice(0, 500) }
}

function classifyHttp(status, body) {
  const numeric = Number(status)
  const apiCode = body && typeof body === 'object' && !Array.isArray(body) && Number(body.code) < 0 ? Number(body.code) : null
  const ambiguous = numeric === 408 || numeric >= 500 || [-1000, -1001, -1006, -1007].includes(apiCode)
  const rateLimited = numeric === 429 || [-1003, -1015].includes(apiCode)
  const timestamp = apiCode === -1021
  return {
    ok: numeric >= 200 && numeric < 300 && apiCode === null,
    status: numeric,
    apiCode,
    ambiguous,
    rateLimited,
    timestamp
  }
}

function normalizeRawInput(name, definition, raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('BINANCE_PARAMETER_INVALID', `${name} parameters must be an object`)
  const extras = Object.keys(raw).filter((key) => !(definition.params || []).includes(key))
  if (extras.length) reject('BINANCE_PARAMETER_FORBIDDEN', `${name} contains unsupported parameters: ${extras.join(', ')}`)
  for (const key of definition.required || []) if (raw[key] === undefined || raw[key] === null || raw[key] === '') reject('BINANCE_PARAMETER_REQUIRED', `${name} requires ${key}`)
  return { ...raw }
}

function exactUnits(baseQuantity, step, label) {
  const quantity = safeDecimal(decimalAbs(baseQuantity), label, { zero: true })
  const unit = safeDecimal(step, 'quantity step')
  const units = divideToStep(quantity, unit, '1')
  if (!/^\d+$/.test(units) || decimalCompare(decimalMultiply(units, unit), quantity) !== 0) reject('BINANCE_QUANTITY_STEP_MISMATCH', `${label} is not aligned to the symbol quantity step`)
  if (!Number.isSafeInteger(Number(units))) reject('BINANCE_QUANTITY_UNSAFE', `${label} exceeds the exact integer unit range`)
  return units
}

function enforceQuantityBounds(units, meta, label) {
  const quantity = decimalMultiply(String(Math.abs(units)), meta.stepSize)
  if (decimalCompare(quantity, meta.minQty) < 0) reject('BINANCE_QUANTITY_BELOW_MIN', `${label} is below the symbol minimum quantity`)
  if (decimalCompare(quantity, meta.maxQty) > 0) reject('BINANCE_QUANTITY_ABOVE_MAX', `${label} exceeds the symbol maximum quantity`)
  return quantity
}

function orderIdentity(value) {
  const normalized = String(value || '').trim()
  if (!ORDER_ID.test(normalized)) reject('BINANCE_ORDER_ID_INVALID', 'Order identity must be a Binance order ID or Tyche client identity')
  return normalized
}

function statusForOrder(status) {
  const value = String(status || '').toUpperCase()
  if (['NEW', 'PARTIALLY_FILLED', 'PENDING_NEW', 'PENDING_CANCEL', 'ACCEPTED'].includes(value)) return { status: 'open', finish_as: '' }
  if (value === 'FILLED') return { status: 'finished', finish_as: 'filled' }
  if (['CANCELED', 'CANCELLED'].includes(value)) return { status: 'finished', finish_as: 'cancelled' }
  if (['EXPIRED', 'EXPIRED_IN_MATCH'].includes(value)) return { status: 'finished', finish_as: 'expired' }
  if (value === 'REJECTED') return { status: 'finished', finish_as: 'rejected' }
  return { status: 'unknown', finish_as: value.toLowerCase() }
}

function statusForAlgo(status) {
  const value = String(status || '').toUpperCase()
  if (['NEW', 'PENDING', 'WORKING', 'ACCEPTED', 'TRIGGERING'].includes(value)) return { status: 'open', finish_as: '' }
  if (['CANCELED', 'CANCELLED'].includes(value)) return { status: 'finished', finish_as: 'cancelled' }
  if (['EXPIRED', 'REJECTED'].includes(value)) return { status: 'finished', finish_as: value.toLowerCase() }
  if (['TRIGGERED', 'FINISHED'].includes(value)) return { status: 'finished', finish_as: 'filled' }
  return { status: 'unknown', finish_as: value.toLowerCase() }
}

export function createBinanceClient(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) reject('BINANCE_OPTIONS_INVALID', 'Client options must be an object')
  const forbidden = ['url', 'baseUrl', 'baseURL', 'host', 'endpoint', 'apiKey', 'secret', 'headers', 'method', 'env']
  const present = forbidden.filter((key) => Object.prototype.hasOwnProperty.call(options, key))
  if (present.length) reject('BINANCE_CLIENT_OVERRIDE_FORBIDDEN', `Routing and credentials cannot be supplied as options: ${present.join(', ')}`)
  const selectedEnvironment = environment(options.environment)
  const readOnly = options.readOnly === true
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now
  const sleepImpl = options.sleepImpl ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const timeoutMs = Number(options.timeoutMs ?? 10000)
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleepImpl !== 'function') reject('BINANCE_CLIENT_DEPENDENCY_INVALID', 'fetch, now, and sleep are required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) reject('BINANCE_TIMEOUT_INVALID', 'timeoutMs must be in (0, 30000]')
  const host = selectedEnvironment === 'testnet' ? BINANCE_FIXED_HOSTS.usdm_testnet : BINANCE_FIXED_HOSTS.usdm_public
  let clockOffsetMs = 0
  const metadataCache = new Map()
  const orderSymbols = new Map()
  const clientSymbols = new Map()
  const algoSymbols = new Map()

  function ensureMutationScope() {
    if (readOnly || selectedEnvironment !== 'testnet') reject('BINANCE_MUTATION_FORBIDDEN', 'Mutations are limited to non-read-only USD-M testnet clients')
  }

  function credentials() {
    const names = binanceCredentialNames(selectedEnvironment)
    if (!names) reject('BINANCE_CREDENTIAL_SCOPE_UNAVAILABLE', 'Public Binance clients have no signed account scope')
    const apiKey = String(process.env[names.apiKey] || '')
    const secretKey = String(process.env[names.secretKey] || '')
    if (!apiKey) reject('BINANCE_API_KEY_MISSING', `Missing ${names.apiKey}`)
    if (!secretKey) reject('BINANCE_SECRET_KEY_MISSING', `Missing ${names.secretKey}`)
    return { apiKey, secretKey }
  }

  function retryDelay(headers, retryNumber) {
    const retryAfter = Number(headers?.['retry-after'])
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(5000, Math.ceil(retryAfter * 1000))
    return Math.min(1000, 250 * retryNumber)
  }

  async function invoke(name, raw = {}, attempts = { timestamp: 0, transient: 0 }) {
    const definition = OPERATIONS[name]
    if (!definition) reject('BINANCE_OPERATION_UNSUPPORTED', `Unsupported Binance operation: ${name}`)
    if (!definition.environments.includes(selectedEnvironment)) reject('BINANCE_OPERATION_ENVIRONMENT_MISMATCH', `${name} is unavailable in ${selectedEnvironment}`)
    if (definition.mutation && (readOnly || selectedEnvironment !== 'testnet')) reject('BINANCE_MUTATION_FORBIDDEN', 'Mutations are limited to non-read-only USD-M testnet clients')
    const input = normalizeRawInput(name, definition, raw)
    let parameters = input
    const headers = { Accept: 'application/json' }
    if (definition.auth) {
      const { apiKey, secretKey } = credentials()
      parameters = { ...parameters, recvWindow: 5000, timestamp: Math.floor(Number(now()) + clockOffsetMs) }
      if (!Number.isFinite(parameters.timestamp)) reject('BINANCE_CLOCK_INVALID', 'now() returned an invalid timestamp')
      const payload = binanceCanonicalQuery(parameters)
      parameters = { ...parameters, signature: hmacSha256(secretKey, payload) }
      headers['X-MBX-APIKEY'] = apiKey
    }
    const query = binanceCanonicalQuery(parameters)
    const hasBody = definition.method === 'POST'
    if (hasBody) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const url = `${host}${definition.path}${!hasBody && query ? `?${query}` : ''}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    let data
    try {
      response = await fetchImpl(url, { method: definition.method, headers, ...(hasBody ? { body: query } : {}), redirect: 'error', signal: controller.signal })
      data = await responseBody(response)
    } catch (cause) {
      const code = NETWORK_CODE.test(String(cause?.code || '')) ? cause.code : cause?.name === 'AbortError' ? 'ETIMEDOUT' : 'BINANCE_NETWORK_ERROR'
      if (definition.method === 'GET' && attempts.transient < 2) {
        await sleepImpl(retryDelay({}, attempts.transient + 1))
        return invoke(name, raw, { ...attempts, transient: attempts.transient + 1 })
      }
      throw new BinanceRestError(code, `Binance ${name} request failed`, { ambiguous: definition.mutation === true })
    } finally {
      clearTimeout(timer)
    }
    const outcome = classifyHttp(response?.status, data)
    const safeHeaders = responseHeaders(response?.headers)
    if (!outcome.ok) {
      const error = new BinanceRestError(outcome.apiCode === null ? `BINANCE_HTTP_${outcome.status}` : `BINANCE_API_${Math.abs(outcome.apiCode)}`, `Binance ${name} failed`, {
        status: outcome.status,
        apiCode: outcome.apiCode,
        detail: redactText(data?.msg || '').slice(0, 240),
        ambiguous: definition.mutation === true && outcome.ambiguous,
        rateLimited: outcome.rateLimited,
        operation: name
      })
      if (definition.auth && definition.method === 'GET' && outcome.timestamp && attempts.timestamp === 0) {
        await synchronizeTime()
        return invoke(name, raw, { ...attempts, timestamp: 1 })
      }
      if (definition.method === 'GET' && (outcome.rateLimited || outcome.ambiguous) && attempts.transient < 2) {
        await sleepImpl(retryDelay(safeHeaders, attempts.transient + 1))
        return invoke(name, raw, { ...attempts, transient: attempts.transient + 1 })
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
        const result = await invoke('time')
        const ended = Number(now())
        const server = Number(result.data?.serverTime)
        if (Number.isFinite(started) && Number.isFinite(ended) && Number.isFinite(server) && ended >= started) probes.push({ index, rtt: ended - started, offset: server - (started + (ended - started) / 2) })
      } catch {}
    }
    probes.sort((left, right) => left.rtt - right.rtt || left.index - right.index)
    if (!probes.length) reject('BINANCE_TIME_SYNC_FAILED', 'Could not establish Binance server time')
    clockOffsetMs = probes[0].offset
    return { ok: true, offset_ms: clockOffsetMs, probes: probes.length }
  }

  async function metadata(pairValue) {
    const contract = pair(pairValue)
    if (!metadataCache.has(contract)) {
      metadataCache.set(contract, (async () => {
        const result = await invoke('exchangeInfo')
        if (!Array.isArray(result.data?.symbols)) reject('BINANCE_RULE_PAYLOAD_INVALID', 'Binance exchangeInfo response is invalid')
        const row = result.data.symbols.find((candidate) => String(candidate?.symbol) === PAIR_TO_SYMBOL[contract])
        if (!row) reject('BINANCE_RULE_MISSING', `${contract} is absent from exchangeInfo`)
        if (!Array.isArray(row.filters)) reject('BINANCE_RULE_PAYLOAD_INVALID', `${contract} exchange filters are invalid`)
        const price = (row.filters || []).find((filter) => filter.filterType === 'PRICE_FILTER')
        const lot = (row.filters || []).find((filter) => filter.filterType === 'LOT_SIZE')
        const notional = (row.filters || []).find((filter) => ['MIN_NOTIONAL', 'NOTIONAL'].includes(filter.filterType))
        if (!price?.tickSize || !lot?.stepSize || !lot?.minQty || !lot?.maxQty || !notional) reject('BINANCE_RULE_INCOMPLETE', `${contract} price, lot-size, or minimum-notional filters are incomplete`)
        const minNotional = notional?.notional ?? notional?.minNotional ?? null
        if (minNotional === null || minNotional === undefined) reject('BINANCE_RULE_INCOMPLETE', `${contract} minimum-notional filter is incomplete`)
        return { contract, symbol: PAIR_TO_SYMBOL[contract], row, tickSize: safeDecimal(price.tickSize, 'tickSize'), stepSize: safeDecimal(lot.stepSize, 'stepSize'), minQty: safeDecimal(lot.minQty, 'minQty'), maxQty: safeDecimal(lot.maxQty, 'maxQty'), minNotional: safeDecimal(minNotional, 'minimum notional') }
      })())
    }
    return metadataCache.get(contract)
  }

  async function normalizeOrder(row) {
    if (!row || typeof row !== 'object') reject('BINANCE_ORDER_PAYLOAD_INVALID', 'Order response is invalid')
    const contract = SYMBOL_TO_PAIR[symbol(row.symbol)]
    const meta = await metadata(contract)
    const original = exactUnits(row.origQty ?? row.quantity, meta.stepSize, 'order quantity')
    const executed = exactUnits(row.executedQty ?? row.cumQty ?? '0', meta.stepSize, 'executed quantity')
    if (decimalCompare(executed, original) > 0) reject('BINANCE_ORDER_QUANTITY_INVALID', 'Executed quantity exceeds original quantity')
    const side = String(row.side || '').toUpperCase()
    if (!['BUY', 'SELL'].includes(side)) reject('BINANCE_ORDER_SIDE_INVALID', 'Order side is invalid')
    const identity = String(row.clientOrderId || row.origClientOrderId || '')
    const orderId = String(row.orderId ?? '')
    if (!/^\d{1,30}$/.test(orderId) || !identity) reject('BINANCE_ORDER_IDENTITY_MISSING', 'Order response lacks exchange or client identity')
    orderSymbols.set(orderId, contract)
    clientSymbols.set(identity, contract)
    const state = statusForOrder(row.status)
    const price = safeDecimal(row.price ?? row.avgPrice ?? '0', 'order price', { zero: true })
    return {
      id: orderId,
      order_id: orderId,
      contract,
      size: side === 'BUY' ? Number(original) : -Number(original),
      left: decimalSubtract(original, executed),
      price,
      text: identity,
      status: state.status,
      finish_as: state.finish_as,
      reduce_only: row.reduceOnly === true,
      raw_status: String(row.status || '')
    }
  }

  async function normalizeAlgo(row) {
    if (!row || typeof row !== 'object') reject('BINANCE_ALGO_PAYLOAD_INVALID', 'Algo-order response is invalid')
    const contract = SYMBOL_TO_PAIR[symbol(row.symbol)]
    const meta = await metadata(contract)
    const quantity = exactUnits(row.quantity ?? row.origQty, meta.stepSize, 'algo quantity')
    const side = String(row.side || '').toUpperCase()
    if (!['BUY', 'SELL'].includes(side)) reject('BINANCE_ORDER_SIDE_INVALID', 'Algo-order side is invalid')
    if (row.positionSide !== undefined && String(row.positionSide).toUpperCase() !== 'BOTH') reject('BINANCE_ONE_WAY_UNPROVEN', `${contract} algo order does not prove one-way mode`)
    const identity = String(row.clientAlgoId || '')
    const algoId = String(row.algoId ?? '')
    if (!identity || !/^\d{1,30}$/.test(algoId)) reject('BINANCE_ORDER_IDENTITY_MISSING', 'Algo order lacks exchange or client identity')
    const orderType = String(row.orderType ?? row.type ?? '').toUpperCase()
    let rule
    if (['STOP', 'STOP_MARKET'].includes(orderType)) rule = side === 'SELL' ? 2 : 1
    else if (['TAKE_PROFIT', 'TAKE_PROFIT_MARKET'].includes(orderType)) rule = side === 'SELL' ? 1 : 2
    else reject('BINANCE_ALGO_TYPE_INVALID', 'Algo order type is not a supported stop or take-profit order')
    const workingType = String(row.workingType || 'CONTRACT_PRICE').toUpperCase()
    if (!['MARK_PRICE', 'CONTRACT_PRICE'].includes(workingType)) reject('BINANCE_TRIGGER_INVALID', 'Algo working type is invalid')
    const triggerPrice = safeDecimal(row.triggerPrice ?? row.stopPrice, 'algo trigger price')
    const timeInForce = String(row.timeInForce || 'GTC').toLowerCase()
    if (!['gtc', 'ioc', 'fok', 'gtx', 'gtd', 'rpi'].includes(timeInForce)) reject('BINANCE_TIF_INVALID', 'Algo time in force is invalid')
    algoSymbols.set(algoId, contract)
    clientSymbols.set(identity, contract)
    const state = statusForAlgo(row.algoStatus)
    return {
      id: algoId,
      order_id: algoId,
      contract,
      status: state.status,
      finish_as: state.finish_as,
      initial: { contract, size: side === 'BUY' ? Number(quantity) : -Number(quantity), price: '0', tif: timeInForce, text: identity, reduce_only: row.reduceOnly === true },
      trigger: { strategy_type: 0, price_type: workingType === 'MARK_PRICE' ? 1 : 0, price: triggerPrice, rule, expiration: 86400 },
      text: identity,
      raw_status: String(row.algoStatus || '')
    }
  }

  async function findOrderAcross(identity) {
    const value = orderIdentity(identity)
    const hinted = clientSymbols.get(value) || orderSymbols.get(value)
    const contracts = hinted ? [hinted] : PAIRS
    const matches = []
    const misses = []
    for (const contract of contracts) {
      try {
        const query = { symbol: PAIR_TO_SYMBOL[contract], ...(CLIENT_ID.test(value) ? { origClientOrderId: value } : { orderId: value }) }
        const row = await normalizeOrder((await invoke('queryOrder', query)).data)
        if (row.contract !== contract || (CLIENT_ID.test(value) && row.text !== value) || (!CLIENT_ID.test(value) && row.id !== value)) reject('BINANCE_ORDER_IDENTITY_MISMATCH', 'Exact Binance order identity did not match')
        matches.push(row)
      } catch (error) {
        if (error?.apiCode === -2013) misses.push(contract)
        else throw error
      }
    }
    if (matches.length !== 1) {
      const error = new BinanceRestError(matches.length ? 'BINANCE_ORDER_IDENTITY_AMBIGUOUS' : 'BINANCE_ORDER_NOT_FOUND', matches.length ? 'Order identity matched multiple symbols' : 'Exact Binance order identity was not found', {
        operation: 'usdmOrder',
        lookupIdentity: value,
        definitiveNotFound: matches.length === 0 && misses.length === contracts.length,
        status: matches.length ? null : 404
      })
      throw error
    }
    return matches[0]
  }

  async function usdmContract({ contract }) {
    const meta = await metadata(contract)
    let commission = null
    let brackets = null
    if (selectedEnvironment === 'testnet') {
      ;[commission, brackets] = await Promise.all([
        invoke('commissionRate', { symbol: meta.symbol }),
        invoke('leverageBracket', { symbol: meta.symbol })
      ])
    }
    if (selectedEnvironment === 'testnet' && (!commission?.data || typeof commission.data !== 'object' || Array.isArray(commission.data) || commission.data.makerCommissionRate === undefined || commission.data.takerCommissionRate === undefined)) reject('BINANCE_FEE_RULE_MISSING', `${meta.contract} commission rates are missing`)
    const bracketRecord = Array.isArray(brackets?.data) ? brackets.data.find((row) => row.symbol === meta.symbol) : brackets?.data
    const firstBracket = Array.isArray(bracketRecord?.brackets) ? [...bracketRecord.brackets].sort((left, right) => Number(left.bracket) - Number(right.bracket))[0] : null
    if (selectedEnvironment === 'testnet' && !firstBracket) reject('BINANCE_RISK_BRACKET_MISSING', `${meta.contract} leverage bracket is missing`)
    const leverageMax = selectedEnvironment === 'testnet' ? safeDecimal(firstBracket.initialLeverage, 'maximum leverage') : ''
    if (selectedEnvironment === 'testnet' && !/^\d+$/.test(leverageMax)) reject('BINANCE_RISK_BRACKET_INVALID', `${meta.contract} maximum leverage is not an exact integer`)
    const maintenanceRate = selectedEnvironment === 'testnet' ? safeDecimal(firstBracket.maintMarginRatio, 'maintenance rate') : ''
    const makerFeeRate = selectedEnvironment === 'testnet' ? safeDecimal(commission.data.makerCommissionRate, 'maker fee rate', { zero: true }) : ''
    const takerFeeRate = selectedEnvironment === 'testnet' ? safeDecimal(commission.data.takerCommissionRate, 'taker fee rate', { zero: true }) : ''
    return {
      data: {
        name: meta.contract,
        order_price_round: meta.tickSize,
        quanto_multiplier: meta.stepSize,
        order_size_min: exactUnits(meta.minQty, meta.stepSize, 'minimum quantity'),
        order_size_max: exactUnits(meta.maxQty, meta.stepSize, 'maximum quantity'),
        min_notional: meta.minNotional,
        leverage_max: leverageMax,
        maintenance_rate: maintenanceRate,
        maker_fee_rate: makerFeeRate,
        taker_fee_rate: takerFeeRate,
        status: meta.row.status === 'TRADING' && meta.row.contractType === 'PERPETUAL' ? 'trading' : 'not_trading',
        in_delisting: meta.row.contractType !== 'PERPETUAL' || meta.row.status !== 'TRADING'
      }
    }
  }

  async function usdmTickers({ contract }) {
    const meta = await metadata(contract)
    const [premium, book] = await Promise.all([invoke('premiumIndex', { symbol: meta.symbol }), invoke('bookTicker', { symbol: meta.symbol })])
    const markPrice = safeDecimal(premium.data?.markPrice, 'mark price')
    const indexPrice = safeDecimal(premium.data?.indexPrice, 'index price')
    const bidPrice = safeDecimal(book.data?.bidPrice, 'best bid price')
    const askPrice = safeDecimal(book.data?.askPrice, 'best ask price')
    return { data: [{ contract: meta.contract, last: markPrice, mark_price: markPrice, index_price: indexPrice, highest_bid: bidPrice, lowest_ask: askPrice }] }
  }

  async function usdmAccount() {
    const [accountResult, modeResult] = await Promise.all([invoke('account'), invoke('positionMode')])
    const asset = (accountResult.data?.assets || []).find((row) => String(row.asset).toUpperCase() === 'USDT')
    if (!asset) reject('BINANCE_USDT_ACCOUNT_MISSING', 'Binance account response has no USDT asset row')
    if (modeResult.data?.dualSidePosition !== false) reject('BINANCE_ONE_WAY_UNPROVEN', 'Binance position mode is not proven to be one-way')
    const available = safeDecimal(asset.availableBalance, 'available USDT balance', { zero: true })
    return { data: { currency: 'USDT', available, in_dual_mode: false, _tyche_wallet: 'BINANCE_USDT_FUTURES_TESTNET', _tyche_funding_source: 'binance_usdm_testnet_available' } }
  }

  async function normalizedPositions(contract = null) {
    const modeResult = await invoke('positionMode')
    if (modeResult.data?.dualSidePosition !== false) reject('BINANCE_ONE_WAY_UNPROVEN', 'Binance position mode is not proven to be one-way')
    const result = await invoke('positionRisk', contract ? { symbol: PAIR_TO_SYMBOL[pair(contract)] } : {})
    const rows = Array.isArray(result.data) ? result.data : [result.data]
    const output = []
    for (const row of rows) {
      if (!SYMBOL_TO_PAIR[String(row?.symbol || '')]) continue
      const contractName = SYMBOL_TO_PAIR[row.symbol]
      const meta = await metadata(contractName)
      if (String(row.positionSide || '').toUpperCase() !== 'BOTH') reject('BINANCE_ONE_WAY_UNPROVEN', `${contractName} position does not prove one-way mode`)
      const marginType = String(row.marginType || '').trim().toLowerCase()
      if (marginType !== 'isolated') reject('BINANCE_ISOLATED_MARGIN_UNPROVEN', `${contractName} position does not prove isolated margin`)
      const leverage = safeDecimal(row.leverage, `${contractName} position leverage`)
      if (!/^\d+$/.test(leverage)) reject('BINANCE_LEVERAGE_UNPROVEN', `${contractName} position leverage is not an exact positive integer`)
      const amount = String(row.positionAmt ?? '0')
      const units = exactUnits(decimalAbs(amount), meta.stepSize, 'position quantity')
      output.push({ contract: contractName, symbol: contractName, mode: 'single', pos_margin_mode: marginType, lever: leverage, size: decimalCompare(amount, '0') < 0 ? `-${units}` : units })
    }
    return output
  }

  async function usdmPositions() {
    return { data: await normalizedPositions() }
  }

  async function usdmPosition({ contract }) {
    const wanted = pair(contract)
    const rows = await normalizedPositions(wanted)
    return { data: rows.find((row) => row.contract === wanted) || { contract: wanted, symbol: wanted, mode: 'single', pos_margin_mode: '', lever: '', size: '0' } }
  }

  async function usdmOrders({ status = 'open', contract = null, limit = 100 } = {}) {
    const normalizedStatus = String(status).toLowerCase()
    if (!['open', 'finished'].includes(normalizedStatus)) reject('BINANCE_STATUS_INVALID', 'Order status must be open or finished')
    const contracts = contract ? [pair(contract)] : PAIRS
    const requestLimit = boundedLimit(limit)
    const rows = []
    if (normalizedStatus === 'open') {
      for (const name of contracts) {
        const result = await invoke('openOrders', { symbol: PAIR_TO_SYMBOL[name] })
        if (result.data !== null && result.data !== undefined && !Array.isArray(result.data)) reject('BINANCE_ORDER_PAYLOAD_INVALID', 'Open orders response is invalid')
        rows.push(...(Array.isArray(result.data) ? result.data : []))
      }
    } else {
      for (const name of contracts) {
        const result = await invoke('allOrders', { symbol: PAIR_TO_SYMBOL[name], limit: requestLimit })
        if (!Array.isArray(result.data)) reject('BINANCE_ORDER_PAYLOAD_INVALID', 'All orders response is invalid')
        rows.push(...result.data)
      }
    }
    return { data: await Promise.all(rows.map(normalizeOrder)) }
  }

  async function usdmOrder({ order_id }) {
    return { data: await findOrderAcross(order_id) }
  }

  async function findUsdmOrderByText(text) {
    const identity = String(text || '')
    if (!CLIENT_ID.test(identity)) reject('BINANCE_CLIENT_ID_INVALID', 'Exact order lookup requires a Tyche client identity')
    return findOrderAcross(identity)
  }

  async function usdmTrades({ contract, order, limit = 100 }) {
    const contractName = pair(contract)
    const meta = await metadata(contractName)
    const requestLimit = boundedLimit(limit)
    let orderId = null
    if (order !== undefined && order !== null && order !== '') {
      orderId = String(order).trim()
      if (!/^\d{1,30}$/.test(orderId)) reject('BINANCE_ORDER_ID_INVALID', 'Trade lookup order must be a numeric Binance order ID')
    }
    const result = await invoke('userTrades', { symbol: meta.symbol, ...(orderId ? { orderId } : {}), limit: requestLimit })
    if (result.data !== null && result.data !== undefined && !Array.isArray(result.data)) reject('BINANCE_TRADE_PAYLOAD_INVALID', 'Trade response is invalid')
    const rows = Array.isArray(result.data) ? result.data : []
    return { data: rows.map((row) => {
      const id = String(row?.id ?? '')
      const relatedOrderId = String(row?.orderId ?? '')
      if (!/^\d{1,30}$/.test(id) || !/^\d{1,30}$/.test(relatedOrderId)) reject('BINANCE_TRADE_PAYLOAD_INVALID', 'Trade response lacks exact identities')
      const side = String(row?.side || '').toUpperCase()
      if (!['BUY', 'SELL'].includes(side)) reject('BINANCE_ORDER_SIDE_INVALID', 'Trade side is invalid')
      const quantity = exactUnits(row.qty, meta.stepSize, 'trade quantity')
      const price = safeDecimal(row.price, 'trade price')
      return { id, trade_id: id, order_id: relatedOrderId, contract: contractName, size: side === 'BUY' ? quantity : `-${quantity}`, price, text: '' }
    }) }
  }

  async function usdmPlaceOrder(input) {
    ensureMutationScope()
    if (!input || typeof input !== 'object' || Array.isArray(input)) reject('BINANCE_ORDER_PAYLOAD_INVALID', 'Order input must be an object')
    const allowed = new Set(['contract', 'size', 'price', 'tif', 'text', 'reduce_only'])
    const extras = Object.keys(input || {}).filter((key) => !allowed.has(key))
    if (extras.length) reject('BINANCE_ORDER_FIELD_FORBIDDEN', `Order contains unsupported fields: ${extras.join(', ')}`)
    const contractName = pair(input?.contract)
    const units = exactSignedUnits(input?.size, 'Order size')
    const price = safeDecimal(input.price, 'order price', { zero: true })
    const tif = String(input.tif || '').toLowerCase()
    if (!['gtc', 'ioc'].includes(tif)) reject('BINANCE_TIF_INVALID', 'Order tif must be gtc or ioc')
    if (!CLIENT_ID.test(String(input.text || ''))) reject('BINANCE_CLIENT_ID_INVALID', 'Order text must be a deterministic Tyche identity')
    if (input.reduce_only !== undefined && input.reduce_only !== true) reject('BINANCE_REDUCE_ONLY_INVALID', 'reduce_only may be omitted or true')
    const meta = await metadata(contractName)
    const quantity = enforceQuantityBounds(units, meta, 'Order quantity')
    const isMarket = decimalCompare(price, '0') === 0
    const parameters = {
      symbol: meta.symbol,
      side: units > 0 ? 'BUY' : 'SELL',
      positionSide: 'BOTH',
      type: isMarket ? 'MARKET' : 'LIMIT',
      quantity,
      newClientOrderId: input.text,
      newOrderRespType: 'RESULT',
      ...(isMarket ? {} : { timeInForce: tif.toUpperCase(), price }),
      ...(input.reduce_only === true ? { reduceOnly: true } : {})
    }
    const row = await normalizeOrder((await invoke('placeOrder', parameters)).data)
    if (row.text !== input.text || row.contract !== contractName) reject('BINANCE_ORDER_IDENTITY_MISMATCH', 'Placed order response does not match its sealed identity')
    return { data: row }
  }

  async function usdmCancelOrder({ order_id }) {
    ensureMutationScope()
    const current = await findOrderAcross(order_id)
    const result = await invoke('cancelOrder', { symbol: PAIR_TO_SYMBOL[current.contract], orderId: current.id })
    return { data: await normalizeOrder(result.data) }
  }

  async function usdmPriceOrders({ status = 'open', contract = null, limit = 100 } = {}) {
    const normalizedStatus = String(status).toLowerCase()
    if (!['open', 'finished'].includes(normalizedStatus)) reject('BINANCE_STATUS_INVALID', 'Algo order status must be open or finished')
    const contracts = contract ? [pair(contract)] : PAIRS
    const requestLimit = boundedLimit(limit)
    const rows = []
    if (normalizedStatus === 'open') {
      for (const name of contracts) {
        const result = await invoke('openAlgoOrders', { symbol: PAIR_TO_SYMBOL[name], algoType: 'CONDITIONAL' })
        if (result.data !== null && result.data !== undefined && !Array.isArray(result.data)) reject('BINANCE_ALGO_PAYLOAD_INVALID', 'Open algo orders response is invalid')
        rows.push(...(Array.isArray(result.data) ? result.data : []))
      }
    } else {
      for (const name of contracts) {
        const result = await invoke('allAlgoOrders', { symbol: PAIR_TO_SYMBOL[name], limit: requestLimit })
        if (!Array.isArray(result.data)) reject('BINANCE_ALGO_PAYLOAD_INVALID', 'All algo orders response is invalid')
        rows.push(...result.data)
      }
    }
    return { data: await Promise.all(rows.map(normalizeAlgo)) }
  }

  async function findAlgo(identity) {
    const value = orderIdentity(identity)
    let response
    try {
      response = await invoke('queryAlgoOrder', /^\d+$/.test(value) ? { algoId: value } : { clientAlgoId: value })
    } catch (error) {
      if (error?.apiCode === -2013) {
        throw new BinanceRestError('BINANCE_PRICE_ORDER_NOT_FOUND', 'Exact Binance algo identity was not found', {
          operation: 'usdmPriceOrder',
          lookupIdentity: value,
          definitiveNotFound: true,
          status: 404
        })
      }
      throw error
    }
    const row = await normalizeAlgo(response.data)
    if ((/^\d+$/.test(value) && row.id !== value) || (!/^\d+$/.test(value) && row.text !== value)) reject('BINANCE_ALGO_IDENTITY_MISMATCH', 'Exact Binance algo identity did not match')
    return row
  }

  async function findUsdmPriceOrderByText(text) {
    const identity = String(text || '')
    if (!CLIENT_ID.test(identity)) reject('BINANCE_CLIENT_ID_INVALID', 'Exact algo lookup requires a Tyche client identity')
    return findAlgo(identity)
  }

  async function usdmPriceOrder({ order_id }) {
    return { data: await findAlgo(order_id) }
  }

  async function usdmPlacePriceOrder(input) {
    ensureMutationScope()
    if (!input || typeof input !== 'object' || Array.isArray(input)) reject('BINANCE_ALGO_PAYLOAD_INVALID', 'Protection input must be an object')
    if (!input?.initial || !input?.trigger || input.initial.reduce_only !== true) reject('BINANCE_PROTECTION_REDUCE_ONLY_REQUIRED', 'Protection requires an exact reduce-only initial order')
    const initial = input.initial
    const trigger = input.trigger
    if (!initial || typeof initial !== 'object' || Array.isArray(initial) || !trigger || typeof trigger !== 'object' || Array.isArray(trigger)) reject('BINANCE_ALGO_PAYLOAD_INVALID', 'Protection initial and trigger must be objects')
    const initialAllowed = new Set(['contract', 'size', 'price', 'tif', 'text', 'reduce_only'])
    const initialExtras = Object.keys(initial).filter((key) => !initialAllowed.has(key))
    if (initialExtras.length) reject('BINANCE_ORDER_FIELD_FORBIDDEN', `Protection initial contains unsupported fields: ${initialExtras.join(', ')}`)
    const triggerAllowed = new Set(['strategy_type', 'price_type', 'price', 'rule', 'expiration'])
    const triggerExtras = Object.keys(trigger).filter((key) => !triggerAllowed.has(key))
    if (triggerExtras.length) reject('BINANCE_TRIGGER_INVALID', `Protection trigger contains unsupported fields: ${triggerExtras.join(', ')}`)
    const contractName = pair(initial.contract)
    const units = exactSignedUnits(initial.size, 'Protection size')
    if (!CLIENT_ID.test(String(initial.text || ''))) reject('BINANCE_CLIENT_ID_INVALID', 'Protection text must be a deterministic Tyche identity')
    const strategyType = exactInteger(trigger.strategy_type ?? 0, 'Protection strategy type')
    if (strategyType !== 0) reject('BINANCE_TRIGGER_INVALID', 'Protection strategy type is unsupported')
    const priceType = exactInteger(trigger.price_type, 'Protection price type')
    if (![0, 1].includes(priceType)) reject('BINANCE_TRIGGER_INVALID', 'Protection price type is unsupported by Binance')
    const rule = exactSignedUnits(trigger.rule, 'Protection trigger rule')
    if (![1, 2].includes(rule)) reject('BINANCE_TRIGGER_INVALID', 'Protection trigger rule is invalid')
    const meta = await metadata(contractName)
    const quantity = enforceQuantityBounds(units, meta, 'Protection quantity')
    const side = units > 0 ? 'BUY' : 'SELL'
    const isStop = (side === 'SELL' && rule === 2) || (side === 'BUY' && rule === 1)
    const parameters = {
      algoType: 'CONDITIONAL',
      symbol: meta.symbol,
      side,
      positionSide: 'BOTH',
      type: isStop ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
      quantity,
      triggerPrice: safeDecimal(trigger.price, 'trigger price'),
      workingType: priceType === 1 ? 'MARK_PRICE' : 'CONTRACT_PRICE',
      reduceOnly: true,
      clientAlgoId: initial.text,
      newOrderRespType: 'RESULT'
    }
    const row = await normalizeAlgo((await invoke('placeAlgoOrder', parameters)).data)
    if (row.text !== initial.text || row.contract !== contractName) reject('BINANCE_ORDER_IDENTITY_MISMATCH', 'Placed algo response does not match its sealed identity')
    return { data: row }
  }

  async function usdmCancelPriceOrder({ order_id }) {
    ensureMutationScope()
    const current = await findAlgo(order_id)
    const result = await invoke('cancelAlgoOrder', { algoId: current.id })
    const data = result.data && result.data.symbol ? await normalizeAlgo(result.data) : { ...current, status: 'finished', finish_as: 'cancelled' }
    return { data }
  }

  return Object.freeze({
    venue: 'binance',
    product: 'usdm',
    environment: selectedEnvironment,
    synchronizeTime,
    usdmContract,
    usdmTickers,
    usdmAccount,
    usdmPositions,
    usdmPosition,
    usdmOrders,
    usdmOrder,
    findUsdmOrderByText,
    usdmTrades,
    usdmPlaceOrder,
    usdmCancelOrder,
    usdmPriceOrders,
    usdmPriceOrder,
    findUsdmPriceOrderByText,
    usdmPlacePriceOrder,
    usdmCancelPriceOrder,
    usdmOrderBook: async ({ contract, limit = 20 }) => invoke('depth', { symbol: PAIR_TO_SYMBOL[pair(contract)], limit }),
    usdmCandlesticks: async ({ contract, interval, limit, from, to }) => invoke(String(contract).toLowerCase().startsWith('mark_') ? 'markPriceKlines' : 'klines', { symbol: PAIR_TO_SYMBOL[pair(String(contract).replace(/^mark_/i, ''))], interval, limit, startTime: from === undefined ? undefined : Number(from) * 1000, endTime: to === undefined ? undefined : Number(to) * 1000 })
  })
}
