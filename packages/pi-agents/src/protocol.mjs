export const JOB_SCHEMA = 'tyche_pi_job/v1'
export const RESULT_SCHEMA = 'tyche_pi_result/v1'
export const CLUSTER_SCHEMA = 'tyche_pi_cluster/v1'
export const PROVENANCE_SCHEMA = 'tyche_pi_provenance/v1'

export const ROLES = Object.freeze([
  'orchestrator',
  'preflight',
  'btc-analyst',
  'eth-analyst',
  'synthesizer',
  'reviewer'
])

export const ASSETS = Object.freeze(['BTC', 'ETH'])
export const TIERS = Object.freeze(['weekly', 'daily'])
export const MAX_ATTEMPTS = 2
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 120_000
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

const JOB_KEYS = new Set([
  'schema', 'jobId', 'runId', 'role', 'asset', 'tier', 'date', 'isoWeek',
  'provider', 'model', 'attempt', 'timeoutMs', 'input'
])
const RESULT_KEYS = new Set([
  'schema', 'jobId', 'runId', 'role', 'asset', 'tier', 'date', 'isoWeek',
  'provider', 'model', 'attempt', 'status', 'startedAt', 'finishedAt',
  'output', 'error', 'provenance'
])
const ERROR_KEYS = new Set(['code', 'message'])
const PROVENANCE_KEYS = new Set([
  'schema', 'adapter', 'piAgentCore', 'piAi', 'provider', 'model', 'role', 'attempt'
])

// These are deliberately transport-boundary fields, not generic market terms.
// Public evidence can contain contracts, trades, order books, and positioning;
// semantic candidates can contain action/entry/stop/target fields. The fields
// below are either private state, credentials, sealed execution state, or
// execution-owned controls and must not cross into or out of a worker.
const FORBIDDEN_INPUT_KEYS = new Set([
  'account', 'accounts', 'accountcontext', 'accountpayload', 'accountepochid',
  'accountid', 'availablequote', 'effectiveriskcapital', 'managedquantity', 'managednotional',
  'dailynewnotionalused', 'dailyordercount', 'wallet', 'fundingsource', 'balance',
  'balances', 'equity', 'margin', 'freemargin', 'usedmargin', 'privatehistory',
  'credential', 'credentials',
  'apikey', 'apikeys', 'secret', 'secrets', 'password', 'authorization', 'authtoken',
  'accesstoken', 'refreshtoken', 'privatekey', 'signingkey', 'signature', 'signatures',
  'plan', 'plans', 'sealedplan', 'ledger', 'ledgers', 'fill', 'fills', 'receipt',
  'receipts', 'order', 'orders', 'position', 'positions', 'leverage', 'quantity',
  'quantities', 'notional', 'contractcount', 'clientid', 'reduceonly', 'execution',
  'executions', 'submission', 'submissions', 'endpoint', 'host', 'httpmethod',
  'requestpath', 'url', 'urls', 'riskpertradebps', 'maxordernotionalusdt',
  'dailynotationalcapusdt', 'managednotional'
])

const FORBIDDEN_OUTPUT_KEYS = new Set(FORBIDDEN_INPUT_KEYS)

export class PiProtocolError extends Error {
  constructor(code, message, path = '') {
    super(message || code)
    this.name = 'PiProtocolError'
    this.code = code
    this.path = path
  }
}

function fail(code, message, path = '') {
  throw new PiProtocolError(code, message, path)
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, required, allowed, path) {
  if (!isObject(value)) fail('PI_SCHEMA_OBJECT_REQUIRED', `${path} must be an object`, path)
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  const extra = Object.keys(value).filter((key) => !allowed.has(key))
  if (missing.length) fail('PI_SCHEMA_REQUIRED_FIELD', `${path} missing ${missing.join(', ')}`, path)
  if (extra.length) fail('PI_SCHEMA_UNKNOWN_FIELD', `${path} has unsupported field(s): ${extra.join(', ')}`, path)
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isForbiddenKey(key, forbiddenKeys) {
  const normalized = normalizedKey(key)
  if (forbiddenKeys.has(normalized)) return true
  return normalized.includes('apikey') || normalized.includes('secretkey') ||
    normalized.includes('privatekey') || normalized.includes('authorization') ||
    normalized.includes('credential') || normalized.includes('accountpayload')
}

function validateJsonValue(value, path, forbiddenKeys, depth = 0) {
  if (depth > 32) fail('PI_SCHEMA_DEPTH', `${path} is too deeply nested`, path)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PI_SCHEMA_NUMBER', `${path} must contain finite numbers`, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, forbiddenKeys, depth + 1))
    return
  }
  if (!isObject(value)) fail('PI_SCHEMA_JSON_VALUE', `${path} must be JSON-compatible`, path)
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenKey(key, forbiddenKeys)) fail('PI_FORBIDDEN_FIELD', `${path}.${key} is not allowed across the Tyche worker boundary`, `${path}.${key}`)
    validateJsonValue(child, `${path}.${key}`, forbiddenKeys, depth + 1)
  }
}

function payloadBytes(value, path) {
  let text
  try {
    text = JSON.stringify(value)
  } catch (error) {
    fail('PI_SCHEMA_JSON_VALUE', `${path} cannot be serialized`, path)
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_PAYLOAD_BYTES) fail('PI_SCHEMA_TOO_LARGE', `${path} exceeds ${MAX_PAYLOAD_BYTES} bytes`, path)
}

function requiredString(value, path, max = 512) {
  if (typeof value !== 'string' || !value.trim()) fail('PI_SCHEMA_STRING_REQUIRED', `${path} must be a non-empty string`, path)
  if (value.length > max) fail('PI_SCHEMA_STRING_TOO_LONG', `${path} is too long`, path)
}

function requiredDate(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('PI_SCHEMA_DATE', `${path} must be YYYY-MM-DD`, path)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('PI_SCHEMA_DATE', `${path} is not a valid date`, path)
}

function requiredWeek(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(value)) fail('PI_SCHEMA_WEEK', `${path} must be ISO YYYY-Www`, path)
}

function requiredTimestamp(value, path) {
  requiredString(value, path, 80)
  if (!Number.isFinite(Date.parse(value))) fail('PI_SCHEMA_TIMESTAMP', `${path} must be an ISO timestamp`, path)
}

function validateCommon(value, path) {
  requiredString(value.jobId, `${path}.jobId`)
  requiredString(value.runId, `${path}.runId`)
  if (!ROLES.includes(value.role)) fail('PI_SCHEMA_ROLE', `${path}.role is not an allowed role`, `${path}.role`)
  if (value.asset !== null && !ASSETS.includes(value.asset)) fail('PI_SCHEMA_ASSET', `${path}.asset must be null, BTC, or ETH`, `${path}.asset`)
  if (!TIERS.includes(value.tier)) fail('PI_SCHEMA_TIER', `${path}.tier must be weekly or daily`, `${path}.tier`)
  requiredDate(value.date, `${path}.date`)
  requiredWeek(value.isoWeek, `${path}.isoWeek`)
  requiredString(value.provider, `${path}.provider`, 128)
  requiredString(value.model, `${path}.model`, 256)
  if (!Number.isInteger(value.attempt) || value.attempt < 0 || value.attempt >= MAX_ATTEMPTS) fail('PI_SCHEMA_ATTEMPT', `${path}.attempt must be 0 or 1`, `${path}.attempt`)
  if (value.role === 'btc-analyst' && value.asset !== 'BTC') fail('PI_SCHEMA_ROLE_ASSET', 'btc-analyst jobs must target BTC', `${path}.asset`)
  if (value.role === 'eth-analyst' && value.asset !== 'ETH') fail('PI_SCHEMA_ROLE_ASSET', 'eth-analyst jobs must target ETH', `${path}.asset`)
  if (!['btc-analyst', 'eth-analyst'].includes(value.role) && value.asset !== null) fail('PI_SCHEMA_ROLE_ASSET', `${value.role} jobs must not target an asset`, `${path}.asset`)
}

export function validateJob(value) {
  exactKeys(value, [...JOB_KEYS], JOB_KEYS, 'job')
  if (value.schema !== JOB_SCHEMA) fail('PI_SCHEMA_NAME', `job.schema must be ${JOB_SCHEMA}`, 'job.schema')
  validateCommon(value, 'job')
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > MAX_TIMEOUT_MS) fail('PI_SCHEMA_TIMEOUT', `job.timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`, 'job.timeoutMs')
  if (!isObject(value.input)) fail('PI_SCHEMA_INPUT', 'job.input must be an object', 'job.input')
  validateJsonValue(value.input, 'job.input', FORBIDDEN_INPUT_KEYS)
  payloadBytes(value.input, 'job.input')
  return value
}

function validateProvenance(value, path) {
  exactKeys(value, [...PROVENANCE_KEYS], PROVENANCE_KEYS, path)
  if (value.schema !== PROVENANCE_SCHEMA) fail('PI_SCHEMA_PROVENANCE', `${path}.schema is invalid`, `${path}.schema`)
  requiredString(value.adapter, `${path}.adapter`, 128)
  requiredString(value.piAgentCore, `${path}.piAgentCore`, 32)
  requiredString(value.piAi, `${path}.piAi`, 32)
  requiredString(value.provider, `${path}.provider`, 128)
  requiredString(value.model, `${path}.model`, 256)
  if (!ROLES.includes(value.role)) fail('PI_SCHEMA_ROLE', `${path}.role is invalid`, `${path}.role`)
  if (!Number.isInteger(value.attempt) || value.attempt < 0 || value.attempt >= MAX_ATTEMPTS) fail('PI_SCHEMA_ATTEMPT', `${path}.attempt is invalid`, `${path}.attempt`)
}

export function validateResult(value) {
  exactKeys(value, [...RESULT_KEYS], RESULT_KEYS, 'result')
  if (value.schema !== RESULT_SCHEMA) fail('PI_SCHEMA_NAME', `result.schema must be ${RESULT_SCHEMA}`, 'result.schema')
  validateCommon(value, 'result')
  if (!['ok', 'error'].includes(value.status)) fail('PI_SCHEMA_STATUS', 'result.status must be ok or error', 'result.status')
  requiredTimestamp(value.startedAt, 'result.startedAt')
  requiredTimestamp(value.finishedAt, 'result.finishedAt')
  validateProvenance(value.provenance, 'result.provenance')
  if (value.provenance.provider !== value.provider || value.provenance.model !== value.model || value.provenance.role !== value.role || value.provenance.attempt !== value.attempt) {
    fail('PI_SCHEMA_PROVENANCE_MISMATCH', 'result provenance does not match result identity', 'result.provenance')
  }
  if (value.status === 'ok') {
    if (!isObject(value.output)) fail('PI_SCHEMA_OUTPUT', 'successful result.output must be an object', 'result.output')
    validateJsonValue(value.output, 'result.output', FORBIDDEN_OUTPUT_KEYS)
    payloadBytes(value.output, 'result.output')
    if (value.error !== null) fail('PI_SCHEMA_ERROR_SHAPE', 'successful result.error must be null', 'result.error')
  } else {
    if (value.output !== null) fail('PI_SCHEMA_OUTPUT', 'failed result.output must be null', 'result.output')
    exactKeys(value.error, ['code', 'message'], ERROR_KEYS, 'result.error')
    requiredString(value.error.code, 'result.error.code', 128)
    requiredString(value.error.message, 'result.error.message', 512)
  }
  return value
}

export function validateSemanticOutput(value) {
  if (!isObject(value)) fail('PI_SCHEMA_OUTPUT', 'semantic output must be an object', 'output')
  validateJsonValue(value, 'output', FORBIDDEN_OUTPUT_KEYS)
  payloadBytes(value, 'output')
  return value
}

export function assertResultMatchesJob(result, job) {
  validateResult(result)
  const fields = ['jobId', 'runId', 'role', 'asset', 'tier', 'date', 'isoWeek', 'provider', 'model', 'attempt']
  for (const field of fields) {
    if (result[field] !== job[field]) fail('PI_RESULT_IDENTITY_MISMATCH', `result.${field} does not match job.${field}`, `result.${field}`)
  }
  return result
}

function redactedErrorMessage(error) {
  const raw = typeof error === 'string' ? error : error?.message
  const message = String(raw || 'worker failure')
    .replace(/(?:api[_-]?key|secret|token|password|authorization)\s*[=:]\s*[^\s,;]+/ig, '$1=[redacted]')
    .replace(/\b(?:GATE|BINANCE)_[A-Z0-9_]+\b/gi, '[credential-redacted]')
    .slice(0, 512)
  return message || 'worker failure'
}

export function makeResult(job, fields = {}) {
  const startedAt = fields.startedAt || new Date().toISOString()
  const finishedAt = fields.finishedAt || new Date().toISOString()
  const result = {
    schema: RESULT_SCHEMA,
    jobId: job.jobId,
    runId: job.runId,
    role: job.role,
    asset: job.asset,
    tier: job.tier,
    date: job.date,
    isoWeek: job.isoWeek,
    provider: job.provider,
    model: job.model,
    attempt: job.attempt,
    status: fields.status || 'error',
    startedAt,
    finishedAt,
    output: fields.status === 'ok' ? fields.output : null,
    error: fields.status === 'ok' ? null : {
      code: String(fields.code || 'PI_WORKER_FAILED'),
      message: redactedErrorMessage(fields.message || fields.error)
    },
    provenance: {
      schema: PROVENANCE_SCHEMA,
      adapter: '@tyche/pi-agents',
      piAgentCore: '0.84.4',
      piAi: '0.84.4',
      provider: job.provider,
      model: job.model,
      role: job.role,
      attempt: job.attempt
    }
  }
  return validateResult(result)
}

export function makeJob(fields) {
  const job = {
    schema: JOB_SCHEMA,
    jobId: fields.jobId,
    runId: fields.runId,
    role: fields.role,
    asset: fields.asset ?? null,
    tier: fields.tier,
    date: fields.date,
    isoWeek: fields.isoWeek,
    provider: fields.provider,
    model: fields.model,
    attempt: fields.attempt ?? 0,
    timeoutMs: fields.timeoutMs,
    input: fields.input
  }
  return validateJob(job)
}

export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('PI_')) return error.code
  const match = String(error?.message || '').match(/^(PI_[A-Z0-9_]+)/)
  return match ? match[1] : 'PI_WORKER_FAILED'
}

export function errorMessage(error) {
  return redactedErrorMessage(error)
}
