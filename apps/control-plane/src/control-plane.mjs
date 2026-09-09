import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { URL } from 'node:url'
import { createConversationStore, containsCredentialPattern } from './conversations.mjs'
import { paperSceneDto } from './paper-scene.mjs'
import { WebSocketServer, WebSocket } from 'ws'
import { containsSessionSecret, SESSION_MODEL_IDS, DEFAULT_SESSION_POOL, validateSessionPool, sessionPoolMetadata, sessionProtocolModels, validateSessionRoleModels, effectiveSessionRoleModels, validateSessionRoleEfforts, effectiveSessionRoleEfforts, assertSessionModelEffort } from '../../../packages/pi-agents/src/session-provider.mjs'
import { normalizeConnectionEndpoint } from '../../../packages/pi-agents/src/connection-endpoint.mjs'
import { discoverSessionModels, catalogCandidates, knownProtocolCapabilities, CATALOG_TTL_MS } from '../../../packages/pi-agents/src/model-discovery.mjs'
import { modelPoolDigest } from '../../../packages/pi-agents/src/model-pool.mjs'
import { EFFORTS, ROLES, DEFAULT_SESSION_PROTOCOL, validateSessionProtocol } from '../../../packages/pi-agents/src/protocol.mjs'

export const LOOPBACK_HOST = '127.0.0.1'
export const SESSION_TTL_MS = 15 * 60 * 1000
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_SOCKET_FRAME_BYTES = 1024 * 1024
export const MAX_WS_EVENT_BYTES = 32 * 1024
export const MAX_WS_BUFFER_BYTES = 256 * 1024
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024
export const PROVIDER = 'openai-responses-compatible'
export { PAPER_SETUP_FIELDS } from '../../../packages/pi-agents/src/conversation-settings.mjs'
import { PAPER_SETUP_FIELDS, CONVERSATION_SETTING_FIELDS, validateConversationOutput, validatePaperSettings, comparePaperDecimal } from '../../../packages/pi-agents/src/conversation-settings.mjs'
const STRATEGY_LIMIT = 8000
export const PROVIDER_MODELS = SESSION_MODEL_IDS
export const MAX_PROVIDER_ENDPOINT_BYTES = 2048
export const MAX_PROVIDER_API_KEY_BYTES = 8192
export const ARM_CONFIRMATIONS = Object.freeze({
  gate: 'ARM TESTNET GATE 24H',
  binance: 'ARM TESTNET BINANCE 24H'
})
export const VENUES = Object.freeze(['gate', 'binance'])

const VENUE_SET = new Set(VENUES)
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']
const DIGEST = /^[A-Za-z0-9._:-]{1,256}$/
const SESSION_COOKIE = 'tyche_control_session'
const STATIC_MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
})

export class ControlPlaneError extends Error {
  constructor(code, message, status = 400) {
    super(message || code)
    this.name = 'ControlPlaneError'
    this.code = code
    this.status = status
  }
}

function fail(code, message, status = 400) {
  throw new ControlPlaneError(code, message, status)
}

const PROVIDER_VALIDATION_MESSAGES = Object.freeze({
  PI_MODEL_CATALOG_SCHEMA_INVALID: '模型目录格式无效；可重新检测或在模型面板手动配置。',
  PI_MODEL_CATALOG_TOO_LARGE: '模型目录超过安全大小限制；请手动配置模型池。',
  PI_MODEL_CATALOG_TIMEOUT: '模型目录检测超时；可重试或手动配置。',
  PI_MODEL_CATALOG_AUTH_FAILED: '模型目录鉴权失败，请检查此连接的 API Key。',
  PI_MODEL_CATALOG_UNAVAILABLE: '服务商未提供标准模型目录；可在模型面板手动配置。',
  PI_MODEL_CATALOG_REQUEST_FAILED: '模型目录请求失败；可重试或手动配置。',
  PI_SESSION_REDIRECT_FORBIDDEN: '模型服务返回重定向，已阻止转发凭据；请检查基础地址。',
  PI_SESSION_PROTOCOL_UNSUPPORTED: '请选择 OpenAI Responses、OpenAI Chat Completions 或 Anthropic Messages 协议。',
  PI_SESSION_PROTOCOL_MODEL_UNSUPPORTED: 'Anthropic Messages 仅支持模型面板列出的原生 adaptive Claude 模型，请更换模型池或选择适合当前模型的协议。',
  PI_SESSION_OAUTH_UNSUPPORTED: '当前模型连接仅支持 API Key，请勿填写 OAuth 令牌。',
  PI_SESSION_ENDPOINT_OPERATION_FORBIDDEN: '请填写 API 基础地址，不要填写 responses、chat/completions 或 messages 操作路径。Anthropic Messages 的基础地址还需去掉末尾的 /v1。',
  PI_SESSION_ENDPOINT_REQUIRED: '请填写模型服务的 API 基础地址。',
  PI_SESSION_ENDPOINT_TOO_LONG: 'API 基础地址过长，请检查地址。',
  PI_SESSION_ENDPOINT_INVALID: 'API 基础地址格式无效，请检查地址。',
  PI_SESSION_ENDPOINT_ENCODING_FORBIDDEN: 'API 基础地址不能包含百分号编码，请使用未编码的基础地址。',
  PI_SESSION_ENDPOINT_PATH_INVALID: 'API 基础地址路径无效，请移除重复斜杠和相对路径段。',
  PI_SESSION_ENDPOINT_USERINFO_FORBIDDEN: 'API 基础地址不能包含用户名或密码，请在 API Key 字段填写凭据。',
  PI_SESSION_ENDPOINT_QUERY_FORBIDDEN: 'API 基础地址不能包含查询参数，请移除问号及其后内容。',
  PI_SESSION_ENDPOINT_FRAGMENT_FORBIDDEN: 'API 基础地址不能包含片段，请移除井号及其后内容。',
  PI_SESSION_ENDPOINT_HOST_FORBIDDEN: 'API 基础地址的主机不受支持。本机服务请使用明确的回环 IP 地址。',
  PI_SESSION_ENDPOINT_HTTP_FORBIDDEN: '远程模型服务必须使用 HTTPS；HTTP 仅允许明确的本机回环 IP 地址。',
  PI_SESSION_ENDPOINT_PROTOCOL_FORBIDDEN: 'API 基础地址协议不受支持，请使用 HTTPS；本机回环服务可使用 HTTP。',
  PI_SESSION_ENDPOINT_PROXY_DNS_FAILED: '检测到本机代理的虚拟 DNS，但公网解析未完成。请检查代理网络后重试；尚未发送 API Key。',
  PI_SESSION_NETWORK_FAILED: '无法连接模型服务，请检查网络或代理后重试。',
  PI_SESSION_TLS_FAILED: '模型服务的 HTTPS 证书验证失败，请检查服务地址或代理证书。',
  PI_MODEL_CATALOG_RATE_LIMITED: '服务商暂时限流，请稍后重试。',
  PI_SESSION_ENDPOINT_DNS_FAILED: '无法解析模型服务域名，请检查 API 基础地址及运行 Tyche 的本机 DNS 设置。',
  PI_SESSION_ENDPOINT_NOT_PUBLIC: '模型服务地址未通过公网地址校验。远程服务须使用仅解析到公网地址的 HTTPS 地址；本机服务可使用明确的 HTTP 回环地址。',
  PI_SESSION_MODEL_NOT_ALLOWED: '所选模型不在当前模型池中，请检查模型配置。',
  PI_SESSION_MODEL_SOURCE_INVALID: '本机 SDK 缺少所选模型的 Responses 元数据，请检查模型配置与 SDK 安装。',
  PI_SESSION_MODEL_EFFORT_UNSUPPORTED: '所选模型不支持当前推理强度，请检查模型池与推理强度配置。',
  PI_MODEL_POOL_INVALID: '模型池配置无效，请检查模型名称与支持的推理强度。',
  PI_SESSION_FETCH_REQUIRED: '本机缺少模型请求所需的 Fetch 支持，请检查 Node.js 运行环境。'
})

// Never forward adapter text or arbitrary codes across the public error boundary.
export function providerValidationError(error) {
  const code = error?.code
  return typeof code === 'string' && Object.hasOwn(PROVIDER_VALIDATION_MESSAGES, code)
    ? { code, message: PROVIDER_VALIDATION_MESSAGES[code] }
    : { code: 'CONTROL_PROVIDER_VALIDATION_FAILED', message: 'Provider validation failed' }
}

function safeText(value, limit = 240) {
  return String(value ?? '')
    .replace(/(?:GATE|BINANCE)_[A-Z0-9_]*(?:API_KEY|SECRET_KEY)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, limit)
}

function safeError(error, fallback = 'Control-plane request failed') {
  if (!(error instanceof ControlPlaneError)) return { code: 'CONTROL_INTERNAL_ERROR', message: fallback }
  return {
    code: String(error?.code || 'CONTROL_PLANE_ERROR').slice(0, 100),
    message: safeText(error?.message || fallback)
  }
}

function normalizedKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function shouldDropKey(key) {
  const normalized = normalizedKey(key)
  if (!normalized || ['planhash', 'planid', 'plansummary'].includes(normalized)) return false
  if (normalized.includes('plan')) return true
  return [
    'credential', 'apikey', 'secret', 'password', 'authorization', 'cookie', 'token', 'privatekey', 'signature',
    'account', 'accountpayload', 'privatehistory', 'ledger', 'fill', 'proof', 'transcript', 'order', 'position',
    'quantity', 'leverage', 'clientid', 'reduceonly', 'path', 'host', 'method', 'url', 'endpoint', 'header', 'socket'
  ].some((part) => normalized.includes(part))
}

function cloneProjection(value, seen = new WeakSet(), depth = 0) {
  if (depth > 12) return '[truncated]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return safeText(value, 2000)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return undefined
  if (Buffer.isBuffer(value)) return '[REDACTED]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    const output = value.slice(0, 100).map((child) => cloneProjection(child, seen, depth + 1)).filter((child) => child !== undefined)
    seen.delete(value)
    return output
  }
  const output = {}
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    const normalized = normalizedKey(key)
    if (shouldDropKey(key) || normalized === 'stack' || normalized === 'cause') continue
    const projected = cloneProjection(child, seen, depth + 1)
    if (projected !== undefined) output[key] = projected
  }
  seen.delete(value)
  return output
}

export function projectSafe(value) {
  return cloneProjection(value)
}

function redactExact(value, secrets, seen = new WeakMap()) {
  if (typeof value === 'string') {
    let output = value
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret) output = output.replaceAll(secret, '[REDACTED]')
    }
    return output
  }
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (Buffer.isBuffer(value)) return '[REDACTED]'
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return seen.get(value)
  const output = Array.isArray(value) ? [] : {}
  seen.set(value, output)
  if (Array.isArray(value)) {
    for (const child of value) output.push(redactExact(child, secrets, seen))
  } else {
    for (const [key, child] of Object.entries(value)) output[key] = redactExact(child, secrets, seen)
  }
  return output
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactBody(value, allowed, required = []) {
  if (!isObject(value)) fail('CONTROL_BODY_OBJECT_REQUIRED', 'Request body must be a JSON object')
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) fail('CONTROL_BODY_FIELD_UNKNOWN', `Unsupported body field: ${unknown.join(', ')}`)
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (missing.length) fail('CONTROL_BODY_FIELD_REQUIRED', `Missing body field: ${missing.join(', ')}`)
  return value
}

function validateProviderBody(value, existing, pool = DEFAULT_SESSION_POOL, discovery = false) {
  exactBody(value, ['provider', 'protocol', ...(discovery ? [] : ['model']), 'endpoint', 'api_key'], ['provider', ...(discovery ? ['protocol'] : ['model']), 'endpoint', ...(existing ? [] : ['api_key'])])
  let protocol
  try { protocol = validateSessionProtocol(value.protocol) } catch (error) { const diagnostic = providerValidationError(error); fail(diagnostic.code, diagnostic.message) }
  if (value.provider !== PROVIDER) fail('CONTROL_PROVIDER_UNSUPPORTED', `provider must be ${PROVIDER}`)
  if (!discovery && (typeof value.model !== 'string' || !pool.some(({ id }) => id === value.model))) fail('CONTROL_PROVIDER_MODEL_UNSUPPORTED', 'model is not allowed')
  if (typeof value.endpoint !== 'string' || !value.endpoint.trim() || Buffer.byteLength(value.endpoint, 'utf8') > MAX_PROVIDER_ENDPOINT_BYTES) {
    fail('CONTROL_PROVIDER_ENDPOINT_INVALID', 'endpoint must be a bounded HTTP(S) base URL')
  }
  if (value.endpoint !== value.endpoint.trim() || /[\u0000-\u001f\u007f]/.test(value.endpoint)) {
    fail('CONTROL_PROVIDER_ENDPOINT_INVALID', 'endpoint must be a bounded HTTP(S) base URL')
  }
  let parsed
  try {
    parsed = new URL(normalizeConnectionEndpoint(value.endpoint, protocol))
  } catch (error) {
    const diagnostic = providerValidationError(error); fail(diagnostic.code, diagnostic.message)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('CONTROL_PROVIDER_ENDPOINT_INVALID', 'endpoint must be a bounded HTTP(S) base URL')
  }
  const endpoint = normalizeConnectionEndpoint(value.endpoint, protocol)
  if (value.api_key === undefined && existing && (endpoint !== existing.endpoint || protocol !== existing.protocol)) {
    fail('CONTROL_PROVIDER_API_KEY_REQUIRED', '更换 API 地址或协议时，请重新填写对应的 API Key。')
  }
  const apiKey = value.api_key === undefined ? existing?.apiKey.toString('utf8') : value.api_key
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey !== apiKey.trim() || /[\u0000-\u001f\u007f]/.test(apiKey) || Buffer.byteLength(apiKey, 'utf8') > MAX_PROVIDER_API_KEY_BYTES) {
    fail('CONTROL_PROVIDER_API_KEY_INVALID', 'api_key must be a bounded non-empty string')
  }
  return { provider: PROVIDER, protocol, model: value.model, endpoint, apiKey: Buffer.from(apiKey, 'utf8') }
}

function venue(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!VENUE_SET.has(normalized)) fail('CONTROL_VENUE_UNSUPPORTED', 'Venue must be gate or binance')
  return normalized
}

function digest(value, field) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('CONTROL_DIGEST_INVALID', `${field} must be a bounded digest`)
  return value
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('CONTROL_DATE_INVALID', 'date must be YYYY-MM-DD')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('CONTROL_DATE_INVALID', 'date is invalid')
  return value
}

function validateIsoWeek(value) {
  if (typeof value !== 'string' || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(value)) fail('CONTROL_WEEK_INVALID', 'iso_week must be YYYY-Www')
  return value
}

function token() {
  return randomBytes(32).toString('base64url')
}

function tokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookieValue(header, name) {
  const pair = String(header || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return pair ? pair.slice(name.length + 1) : null
}

async function readJsonBody(request) {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) fail('CONTROL_BODY_TOO_LARGE', 'Request body is too large', 413)
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) fail('CONTROL_BODY_TOO_LARGE', 'Request body is too large', 413)
  }
  if (!body.trim()) return {}
  try {
    return JSON.parse(body)
  } catch {
    fail('CONTROL_BODY_JSON_INVALID', 'Request body must be valid JSON')
  }
}

function validSocketPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000') || !value.startsWith('/')) fail('CONTROL_SOCKET_PATH_INVALID', 'Executor socket paths must be absolute server configuration')
  return value
}

function validStaticRoot(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || value.includes('\u0000')) fail('CONTROL_STATIC_ROOT_INVALID', 'Static root must be an absolute server path')
  return path.resolve(value)
}

function socketRequest(socketPath, request, timeoutMs = 2000) {
  validSocketPath(socketPath)
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath)
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => finish(new ControlPlaneError('CONTROL_EXECUTOR_TIMEOUT', 'Executor socket timed out', 504)), timeoutMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connection.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    connection.setEncoding('utf8')
    connection.on('error', () => finish(new ControlPlaneError('CONTROL_EXECUTOR_UNAVAILABLE', 'Executor socket is unavailable', 503)))
    connection.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SOCKET_FRAME_BYTES) {
        finish(new ControlPlaneError('CONTROL_EXECUTOR_FRAME_TOO_LARGE', 'Executor frame exceeded the limit', 502))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      try { finish(null, JSON.parse(line)) } catch { finish(new ControlPlaneError('CONTROL_EXECUTOR_JSON_INVALID', 'Executor returned invalid JSON', 502)) }
    })
    connection.on('connect', () => {
      const frame = `${JSON.stringify(request)}\n`
      if (Buffer.byteLength(frame, 'utf8') > MAX_SOCKET_FRAME_BYTES) {
        finish(new ControlPlaneError('CONTROL_EXECUTOR_FRAME_TOO_LARGE', 'Executor request exceeded the limit', 413))
        return
      }
      connection.write(frame)
    })
  })
}

export function createControlPlane(options = {}) {
  if (!isObject(options)) fail('CONTROL_OPTIONS_INVALID', 'Control-plane options must be an object')
  if (options.host !== undefined && options.host !== LOOPBACK_HOST) fail('CONTROL_BIND_FORBIDDEN', 'Control plane may bind only 127.0.0.1')
  const port = options.port === undefined ? 8788 : Number(options.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('CONTROL_PORT_INVALID', 'Control-plane port is invalid')
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const requestedSweepMs = options.sessionSweepMs === undefined ? 60_000 : Number(options.sessionSweepMs)
  if (!Number.isInteger(requestedSweepMs) || requestedSweepMs < 10 || requestedSweepMs > 60_000) fail('CONTROL_SESSION_SWEEP_INVALID', 'Session sweep interval must be between 10 and 60000 milliseconds')
  const staticRoot = options.staticRoot === undefined ? null : validStaticRoot(options.staticRoot)
  const adapter = isObject(options.adapters) ? options.adapters : {}
  const conversations = options.conversationStore || createConversationStore({ now })
  const configuredSockets = options.executorSockets || {}
  if (!isObject(configuredSockets)) fail('CONTROL_SOCKET_CONFIG_INVALID', 'Executor sockets must be server configuration')
  for (const key of Object.keys(configuredSockets)) {
    if (!VENUE_SET.has(key)) fail('CONTROL_SOCKET_CONFIG_INVALID', 'Only gate and binance socket paths are supported')
    validSocketPath(configuredSockets[key])
  }

  const hasBootstrapToken = Object.hasOwn(options, 'bootstrapToken')
  if (hasBootstrapToken && (typeof options.bootstrapToken !== 'string' || !/^[A-Za-z0-9_-]{6,256}$/.test(options.bootstrapToken))) {
    fail('CONTROL_BOOTSTRAP_TOKEN_INVALID', 'Bootstrap token must contain 6 to 256 URL-safe letters, digits, underscores, or hyphens')
  }
  if (Object.hasOwn(options, 'reusableBootstrapToken') && typeof options.reusableBootstrapToken !== 'boolean') {
    fail('CONTROL_BOOTSTRAP_REUSE_INVALID', 'Reusable bootstrap selection must be a boolean')
  }
  const reusableBootstrapToken = options.reusableBootstrapToken === true
  if (reusableBootstrapToken && !hasBootstrapToken) fail('CONTROL_BOOTSTRAP_REUSE_INVALID', 'Reusable bootstrap requires an explicit valid token')
  const bootstrapToken = hasBootstrapToken ? options.bootstrapToken : token()
  let bootstrapUsed = false
  let listening = false
  let boundPort = null
  let sessionSweepTimer = null
  const sessions = new Map()
  const clients = new Set()
  const clientSessions = new WeakMap()

  const credentialDigest = (config) => createHash('sha256').update(config.apiKey).digest('hex')
  const connectionBinding = (config) => ({ endpoint: config.endpoint, protocol: config.protocol, credentialDigest: config.credentialDigest || credentialDigest(config) })
  const sameConnection = (left, right) => Boolean(left && right && left.endpoint === right.endpoint && left.protocol === right.protocol && connectionBinding(left).credentialDigest === connectionBinding(right).credentialDigest)
  function liveCatalog(session) {
    if (session.modelCatalog && Number(now()) >= session.modelCatalog.expiresAt) delete session.modelCatalog
    return session.modelCatalog
  }
  function declarationContext(session) {
    const catalog = liveCatalog(session)
    if (catalog) return { id: catalog.declarationContextId, kind: sameConnection(session.providerConfig, catalog) ? 'current_catalog' : 'pending_catalog', protocol: catalog.protocol, endpoint: catalog.endpoint }
    if (session.providerConfig) return { id: session.providerConfig.declarationContextId, kind: 'current_connection', protocol: session.providerConfig.protocol, endpoint: session.providerConfig.endpoint }
    session.unboundDeclarationContextId ||= randomUUID()
    return { id: session.unboundDeclarationContextId, kind: 'unbound', protocol: null, endpoint: null }
  }
  function catalogDto(session, currentOnly = false) {
    const catalog = liveCatalog(session)
    if (!catalog) return null
    const source = session.providerConfig
    const active = sameConnection(source, catalog)
    const projected = catalogCandidates({ entries: catalog.rawEntries }, declarationPoolFor(session, catalog), catalog.protocol, poolFor(session))
    if (currentOnly && !active) return null
    const message = `${catalog.partial ? '仅当前页，目录不完整；未出现的模型不代表不受支持。' : '已读取服务商模型目录。'} ${active ? session.modelMode === 'manual' ? '手动模型配置保持原样。' : allocationState(session) === 'ready' ? '目录已接入当前连接，角色分配已就绪。' : '候选池用于开始对话；六角色仍须主 Agent 分配。' : projected.eligible_count > 0 ? '已确认可启动候选，请核对主模型后发送消息完成连接；原连接与配置保留。' : '尚无可启动的已知 effort 候选。请在模型面板明确声明自定义模型的 effort 或选择协议支持的已知模型；原连接与配置保留。'} 模型列表不等于推理验证。`
    return { protocol: catalog.protocol, entries: projected.entries, partial: catalog.partial, filtered_count: catalog.filtered_count, selection_rule: projected.selection_rule, eligible_count: projected.eligible_count, omitted_eligible_count: projected.omitted_eligible_count, active, detected_at: new Date(catalog.detectedAt).toISOString(), expires_at: new Date(catalog.expiresAt).toISOString(), message }
  }

  function providerDto(session) {
    const config = session?.providerConfig
    return {
      configured: Boolean(config),
      provider: config?.provider || null,
      protocol: config?.protocol || null,
      model: config?.model || null,
      endpoint: config?.endpoint || null,
      scope: 'session',
      manual_cycle_only: true
    }
  }

  const poolFor = (session) => session.modelPool || DEFAULT_SESSION_POOL
  const declarationPoolFor = (session, config = session.providerConfig) => {
    const binding = session.declarationConnection
    return !binding || sameConnection(config, binding) ? session.declaredModelPool || [] : []
  }
  const bindDeclarations = (session, config) => { if (session.declaredModelPool && !session.declarationConnection) session.declarationConnection = connectionBinding(config) }
  function requireDeclaredCustomPool(session, pool, config) {
    const known = new Set(knownProtocolCapabilities(config.protocol).map(({ id }) => id))
    const declarations = declarationPoolFor(session, config)
    if (pool.some((entry) => !known.has(entry.id) && entry.efforts.some((effort) => !declarations.find(({ id }) => id === entry.id)?.efforts.includes(effort)))) fail('CONTROL_MODEL_CAPABILITY_UNCONFIRMED', '此连接尚未确认自定义模型的 effort；请为当前连接明确保存能力声明。', 409)
  }

  const protocolFor = (session) => session.providerConfig?.protocol || DEFAULT_SESSION_PROTOCOL
  const bootstrapFor = (session) => session.modelBootstrap || { model: session.providerConfig?.model || PROVIDER_MODELS[0], effort: 'high' }
  function roleSelections(session, defaultModel = session.providerConfig?.model || bootstrapFor(session).model) {
    return Object.fromEntries(ROLES.map((role) => [role, session.roleModels?.[role] || defaultModel]))
  }
  function allocationState(session) {
    if ((session.modelMode || 'auto') === 'auto' && session.allocationPending) return 'pending'
    try { for (const [role, model] of Object.entries(roleSelections(session))) assertSessionModelEffort(model, effectiveSessionRoleEfforts(session.roleEfforts)[role], poolFor(session), protocolFor(session)); return 'ready' } catch { return session.modelMode === 'manual' ? 'blocked' : 'pending' }
  }
  function modelsDto(session) {
    const defaultModel = session.providerConfig?.model || bootstrapFor(session).model
    const state = allocationState(session)
    const chat = state === 'ready' ? { model: roleSelections(session).orchestrator, effort: effectiveSessionRoleEfforts(session.roleEfforts).orchestrator } : bootstrapFor(session)
    return { declaration_context: declarationContext(session), catalog: catalogDto(session), default_model: defaultModel, role_models: { ...session.roleModels }, role_efforts: { ...session.roleEfforts }, effective_models: roleSelections(session), effective_efforts: effectiveSessionRoleEfforts(session.roleEfforts), allowed_models: poolFor(session).map(({ id }) => id), known_models: [...PROVIDER_MODELS, ...sessionProtocolModels().map(({ id }) => id)], protocol_models: sessionProtocolModels(), allowed_efforts: [...EFFORTS], pool: poolFor(session), pool_metadata: sessionPoolMetadata(poolFor(session), protocolFor(session)), mode: session.modelMode || 'auto', bootstrap: bootstrapFor(session), chat, allocation_state: state, allocation_source: session.allocationSource || 'default', allocation_reasons: session.allocationReasons || {}, draft_notice: session.modelDraftNotice || '', scope: 'session' }
  }

  function modelSettingsCandidate(session, input) {
    exactBody(input, ['pool', 'mode', 'bootstrap', 'role_models', 'role_efforts'])
    let pool
    try { pool = validateSessionPool(input.pool === undefined ? poolFor(session) : input.pool) } catch { fail('CONTROL_MODEL_POOL_INVALID', '模型池最多 12 项；ID 和 effort 必须有效，已知模型不接受与 SDK 能力冲突的声明。', 400) }
    const protocol = protocolFor(session)
    if (session.providerConfig) {
      try { for (const { id, efforts } of pool) for (const effort of efforts) assertSessionModelEffort(id, effort, pool, protocol) } catch { fail('CONTROL_MODEL_POOL_PROTOCOL_INVALID', '当前连接协议不支持候选模型池中的模型或 effort；未保存修改。若要准备其他协议的模型池，请先清除模型连接。', 400) }
    }
    const mode = input.mode === undefined ? session.modelMode || 'auto' : input.mode
    if (!['auto', 'manual'].includes(mode)) fail('CONTROL_MODEL_MODE_INVALID', '请选择自动或手动模式。', 400)
    const bootstrap = input.bootstrap === undefined ? bootstrapFor(session) : input.bootstrap
    exactBody(bootstrap, ['model', 'effort'], ['model', 'effort'])
    try { assertSessionModelEffort(bootstrap.model, bootstrap.effort, pool, protocol) } catch { fail('CONTROL_MODEL_BOOTSTRAP_INVALID', '首次分配的主模型与 effort 必须在新模型池内并受当前协议支持，请明确选择。', 400) }
    const changedPool = modelPoolDigest(pool) !== modelPoolDigest(poolFor(session))
    const changes = input.role_models === undefined ? {} : checkedRoleModels(input.role_models, 400, pool)
    const effortChanges = input.role_efforts === undefined ? {} : checkedRoleEfforts(input.role_efforts)
    if (input.mode === 'manual' && (input.role_models !== undefined || input.role_efforts !== undefined) && (Object.keys(changes).length !== ROLES.length || Object.keys(effortChanges).length !== ROLES.length)) fail('CONTROL_MODEL_ASSIGNMENT_INCOMPLETE', '手动保存须为全部六个 Agent 选择模型和 effort。', 400)
    const models = { ...(bootstrap.model !== (session.providerConfig?.model || bootstrapFor(session).model) ? roleSelections(session) : session.roleModels), ...changes }
    const efforts = { ...session.roleEfforts, ...effortChanges }
    const submittedRoles = [...new Set([...Object.keys(changes), ...Object.keys(effortChanges)])]
    if (submittedRoles.length) checkedModelEfforts(Object.fromEntries(submittedRoles.map((role) => [role, models[role] || bootstrap.model])), effectiveSessionRoleEfforts(efforts), 400, pool, protocol)
    if (session.providerConfig && containsSessionSecret({ input, models, efforts }, { apiKey: session.providerConfig.apiKey.toString('utf8'), endpoint: session.providerConfig.endpoint })) fail('CONTROL_STRATEGY_SECRET', '模型池不能包含连接凭据。', 400)
    return { pool, mode, bootstrap: Object.freeze({ ...bootstrap }), models: Object.freeze(models), efforts: Object.freeze(efforts), changedPool, changes, effortChanges }
  }

  function commitModelSettings(session, candidate) {
    session.modelPool = candidate.pool
    session.modelMode = candidate.mode
    session.allocationPending = candidate.mode === 'auto' && (candidate.changedPool || session.allocationPending === true)
    session.modelBootstrap = candidate.bootstrap
    session.roleModels = candidate.models
    session.roleEfforts = candidate.efforts
    if (session.providerConfig) session.providerConfig = { ...session.providerConfig, model: candidate.bootstrap.model }
    if (Object.keys(candidate.changes).length || Object.keys(candidate.effortChanges).length) { session.allocationSource = 'user'; session.allocationReasons = {} }
    const draft = { ...session.settingsDraft }
    const invalidDraftRoles = ROLES.filter((role) => {
      if (!Object.hasOwn(draft.suggested_role_models || {}, role) && !Object.hasOwn(draft.suggested_role_efforts || {}, role)) return false
      try { assertSessionModelEffort(draft.suggested_role_models?.[role] || roleSelections(session)[role], draft.suggested_role_efforts?.[role] || effectiveSessionRoleEfforts(session.roleEfforts)[role], candidate.pool, protocolFor(session)); return false } catch { return true }
    })
    session.modelDraftNotice = invalidDraftRoles.length ? '新模型池不再支持的角色草稿已清除；Paper 和策略草稿保留。' : ''
    for (const [field, applied] of [['suggested_role_models', candidate.changes], ['suggested_role_efforts', candidate.effortChanges]]) {
      const retained = Object.fromEntries(Object.entries(draft[field] || {}).filter(([role, value]) => {
        if (Object.hasOwn(applied, role) || invalidDraftRoles.includes(role)) return false
        const model = field === 'suggested_role_models' ? value : draft.suggested_role_models?.[role] || roleSelections(session)[role]
        const effort = field === 'suggested_role_efforts' ? value : draft.suggested_role_efforts?.[role] || effectiveSessionRoleEfforts(session.roleEfforts)[role]
        try { assertSessionModelEffort(model, effort, candidate.pool, protocolFor(session)); return true } catch { return false }
      }))
      if (Object.keys(retained).length) draft[field] = retained
      else delete draft[field]
    }
    delete draft.model_settings
    session.settingsDraft = draft
  }

  function checkedRoleModels(value, status = 400, pool) {
    try { return validateSessionRoleModels(value, pool) } catch { fail('CONTROL_ROLE_MODELS_INVALID', '模型配置只能包含固定六个 Agent 和设置中列出的模型；未应用任何修改。', status) }
  }

  function checkedRoleEfforts(value, status = 400) {
    try { return validateSessionRoleEfforts(value) } catch { fail('CONTROL_ROLE_EFFORTS_INVALID', 'effort 只能为固定六个 Agent 选择 medium、high 或 xhigh；未应用任何修改。', status) }
  }

  function checkedModelEfforts(models, efforts, status = 400, pool, protocol = DEFAULT_SESSION_PROTOCOL) {
    try { for (const [role, model] of Object.entries(models)) assertSessionModelEffort(model, efforts[role], pool, protocol) } catch { fail('CONTROL_MODEL_EFFORT_UNSUPPORTED', '所选模型不支持请求的 effort；请明确选择支持的档位，系统不会自动降档。', status) }
  }

  function clearProvider(session, reason) {
    delete session.modelCatalog
    const config = session?.providerConfig
    if (!config) return false
    const keyBuffer = config.apiKey
    keyBuffer.fill(0)
    delete session.providerConfig
    if (typeof options.onProviderCleared === 'function') {
      try { options.onProviderCleared({ reason, keyBuffer }) } catch {}
    }
    return true
  }

  function deleteSession(sessionId, reason) {
    const session = sessions.get(sessionId)
    if (!session) return false
    session.discussionJob?.controller.abort()
    clearProvider(session, reason)
    session.strategy = ''
    session.discussion = []
    session.roleModels = {}
    session.roleEfforts = {}
    session.settingsDraft = {}
    session.preferences = ''
    session.theme = 'night'
    session.settingsResult = null
    delete session.modelPool
    delete session.modelMode
    delete session.modelBootstrap
    delete session.allocationSource
    delete session.allocationPending
    delete session.allocationReasons
    delete session.modelDraftNotice
    sessions.delete(sessionId)
    for (const client of clients) {
      if (clientSessions.get(client) === sessionId) {
        clients.delete(client)
        client.terminate()
      }
    }
    return true
  }

  function sweepExpiredSessions() {
    const current = Number(now())
    if (!Number.isFinite(current)) return
    for (const [sessionId, session] of sessions) {
      if (current >= session.expiresAt) deleteSession(sessionId, 'expired')
    }
  }

  function activeOutputSecrets(extra = []) {
    const secrets = [...extra]
    for (const session of sessions.values()) {
      const config = session.providerConfig
      if (!config) continue
      secrets.push(config.apiKey.toString('utf8'), config.endpoint)
      try { const parsed = new URL(config.endpoint); secrets.push(parsed.origin, parsed.hostname) } catch {}
    }
    return secrets.filter((value) => typeof value === 'string' && value)
  }

  function safeOutput(value, extra = []) {
    return projectSafe(redactExact(value, activeOutputSecrets(extra)))
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${LOOPBACK_HOST}`)
      validateEnvelope(request, url, { mutation: request.method !== 'GET' })
      if (url.pathname === '/api/health' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, service: 'tyche-control-plane' })
        return
      }
      if (request.method === 'GET' && staticRoot && !url.pathname.startsWith('/api/')) {
        if (await serveStatic(response, url)) return
      }
      if (url.pathname === '/api/session' && request.method === 'POST') {
        await handleSession(request, response)
        return
      }
      if (url.pathname === '/api/session' && request.method === 'GET') {
        if (url.search || request.headers['x-tyche-session'] !== 'resume') fail('CONTROL_SESSION_RESUME_REJECTED', 'Session recovery requires the fixed same-origin request header', 403)
        const session = requireSession(request, false)
        sendJson(response, 200, { ok: true, csrf_token: session.csrf, expires_at: new Date(session.expiresAt).toISOString() }, {}, { sensitive: true })
        return
      }
      const session = requireSession(request, request.method !== 'GET')
      const body = request.method === 'POST' ? await readJsonBody(request) : null
      const result = await dispatchHttp(url, request.method || 'GET', body, session)
      const explicitDto = ['/api/provider', '/api/provider/clear', '/api/provider/discover', '/api/paper/setup', '/api/paper/scene', '/api/strategy', '/api/strategy/discuss', '/api/strategy/cancel', '/api/conversations', '/api/chat/model', '/api/ui', '/api/models'].includes(url.pathname)
      const headers = url.pathname === '/api/logout' && request.method === 'POST'
        ? { 'Set-Cookie': `${sessionCookieName()}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${request.socket.encrypted ? '; Secure' : ''}` }
        : {}
      sendJson(response, 200, explicitDto ? (url.pathname === '/api/paper/scene' ? redactExact(result, activeOutputSecrets()) : result) : safeOutput(result), headers, { sensitive: explicitDto })
    } catch (error) {
      const failure = safeError(error)
      sendJson(response, error instanceof ControlPlaneError ? error.status : 500, safeOutput({ ok: false, code: failure.code, message: failure.message }))
    }
  })

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES })
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', `http://${LOOPBACK_HOST}`)
      validateEnvelope(request, url, { mutation: true })
      if (url.pathname !== '/api/events') fail('CONTROL_ROUTE_NOT_FOUND', 'WebSocket route not found', 404)
      requireSession(request, false)
      wsServer.handleUpgrade(request, socket, head, (client) => wsServer.emit('connection', client, request))
    } catch (error) {
      socket.write(`HTTP/1.1 ${error?.status || 403} Forbidden\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
  })
  wsServer.on('connection', (client, request) => {
    clientSessions.set(client, cookieValue(request.headers.cookie, sessionCookieName()))
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => clients.delete(client))
    client.on('message', () => client.close(1008, 'read-only projection stream'))
    sendEvent(client, { type: 'connected', data: { service: 'tyche-control-plane' } })
  })

  function expectedHost() {
    return `${LOOPBACK_HOST}:${boundPort}`
  }

  function expectedOrigin() {
    return `http://${expectedHost()}`
  }

  function sessionCookieName() {
    // Browser cookies are shared by host, even across different local ports.
    return `${SESSION_COOKIE}_${boundPort}`
  }

  function validateEnvelope(request, url, { mutation }) {
    if (!listening && url.pathname !== '/api/health') fail('CONTROL_NOT_STARTED', 'Control plane is not started', 503)
    if (request.headers.host !== expectedHost()) fail('CONTROL_HOST_REJECTED', 'Host must be the loopback control-plane origin', 403)
    for (const header of FORWARDED_HEADERS) if (request.headers[header] !== undefined) fail('CONTROL_FORWARDED_HEADER_REJECTED', 'Forwarded headers are not accepted', 403)
    const origin = request.headers.origin
    if (origin !== undefined && origin !== expectedOrigin()) fail('CONTROL_ORIGIN_REJECTED', 'Origin must be the loopback control-plane origin', 403)
    if (mutation && origin !== expectedOrigin()) fail('CONTROL_ORIGIN_REQUIRED', 'Mutations require the exact loopback Origin', 403)
  }

  function requireSession(request, mutation) {
    const sessionId = cookieValue(request.headers.cookie, sessionCookieName())
    const entry = sessions.get(sessionId)
    const current = Number(now())
    if (!entry || !Number.isFinite(current) || current >= entry.expiresAt) {
      if (sessionId) deleteSession(sessionId, 'expired')
      fail('CONTROL_SESSION_REQUIRED', 'A live control-plane session is required', 401)
    }
    if (mutation || request.headers['x-csrf-token'] !== undefined) {
      const csrf = request.headers['x-csrf-token']
      if (!tokenEqual(csrf, entry.csrf)) fail('CONTROL_CSRF_REJECTED', 'CSRF token is missing or invalid', 403)
    }
    if (mutation && request.headers.origin !== expectedOrigin()) fail('CONTROL_ORIGIN_REQUIRED', 'Mutations require the exact loopback Origin', 403)
    return entry
  }

  async function handleSession(request, response) {
    const body = await readJsonBody(request)
    exactBody(body, ['bootstrap_token'], ['bootstrap_token'])
    if ((!reusableBootstrapToken && bootstrapUsed) || !tokenEqual(body.bootstrap_token, bootstrapToken)) {
      fail('CONTROL_BOOTSTRAP_REJECTED', reusableBootstrapToken ? 'Bootstrap token is invalid' : 'Bootstrap token is invalid or already used', 401)
    }
    const sessionId = token()
    const csrf = token()
    const current = Number(now())
    if (!Number.isFinite(current)) fail('CONTROL_SESSION_REQUIRED', 'A live control-plane session is required', 401)
    const expiresAt = current + SESSION_TTL_MS
    if (!reusableBootstrapToken) bootstrapUsed = true
    // A new login replaces this browser's previous session and its credentials.
    deleteSession(cookieValue(request.headers.cookie, sessionCookieName()), 'relogin')
    sessions.set(sessionId, { id: sessionId, csrf, expiresAt })
    const secure = request.socket.encrypted ? '; Secure' : ''
    sendJson(response, 200, { ok: true, csrf_token: csrf, expires_at: new Date(expiresAt).toISOString() }, {
      'Set-Cookie': `${sessionCookieName()}=${sessionId}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`
    }, { sensitive: true })
  }

  async function serveStatic(response, url) {
    let relative
    try {
      relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    } catch {
      sendJson(response, 404, { ok: false, code: 'CONTROL_STATIC_NOT_FOUND', message: 'Static resource not found' })
      return true
    }
    if (!relative || relative.includes('\u0000') || relative.split('/').some((part) => part === '..' || part === '')) {
      sendJson(response, 404, { ok: false, code: 'CONTROL_STATIC_NOT_FOUND', message: 'Static resource not found' })
      return true
    }
    const extension = path.extname(relative).toLowerCase()
    if (!STATIC_MIME[extension]) {
      sendJson(response, 404, { ok: false, code: 'CONTROL_STATIC_NOT_FOUND', message: 'Static resource not found' })
      return true
    }
    const target = path.resolve(staticRoot, relative)
    const relativeCheck = path.relative(staticRoot, target)
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      sendJson(response, 404, { ok: false, code: 'CONTROL_STATIC_NOT_FOUND', message: 'Static resource not found' })
      return true
    }
    try {
      let cursor = staticRoot
      for (const part of relative.split('/')) {
        cursor = path.join(cursor, part)
        if ((await fs.promises.lstat(cursor)).isSymbolicLink()) throw new Error('symlink')
      }
      const stat = await fs.promises.stat(target)
      if (!stat.isFile()) throw new Error('not-file')
      const contents = await fs.promises.readFile(target)
      response.writeHead(200, {
        'Content-Type': STATIC_MIME[extension],
        'Content-Length': contents.byteLength,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer'
      })
      response.end(contents)
    } catch {
      sendJson(response, 404, { ok: false, code: 'CONTROL_STATIC_NOT_FOUND', message: 'Static resource not found' })
    }
    return true
  }

  async function adapterCall(name, input = undefined) {
    const fn = adapter[name]
    if (typeof fn !== 'function') return { status: 'unconfigured' }
    try {
      return projectSafe(await fn(input)) ?? { status: 'empty' }
    } catch (error) {
      return { status: 'error', ...safeError(error, `${name} unavailable`) }
    }
  }

  async function discoverProvider(session, body) {
    if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', '模型正在运行，请稍后检测。', 409)
    const candidate = validateProviderBody(body, session.providerConfig, poolFor(session), true)
    const source = session.providerConfig
    const current = Number(now())
    session.discoveryRequests = (session.discoveryRequests || []).filter((at) => current - at < 60_000)
    if (session.discoveryRequests.length >= 12) { candidate.apiKey.fill(0); fail('CONTROL_MODEL_CATALOG_RATE_LIMIT', '检测过于频繁，请稍后重试。', 429) }
    session.discoveryRequests.push(current)
    if (containsSessionSecret([candidate.protocol, historyCall(() => conversations.allText()), session.strategy || '', session.discussion || [], poolFor(session), session.declaredModelPool || [], session.settingsDraft || {}, session.preferences || '', session.roleModels || {}, session.roleEfforts || {}, session.allocationReasons || {}, session.settingsResult || {}], { apiKey: candidate.apiKey.toString('utf8'), endpoint: candidate.endpoint })) { candidate.apiKey.fill(0); fail('CONTROL_STRATEGY_SECRET', '连接凭据与会话内容冲突；未保存连接。', 400) }
    let committed = false
    session.providerBusy = true
    try {
      let discovered
      try { discovered = await discoverSessionModels({ endpoint: candidate.endpoint, protocol: candidate.protocol, apiKey: candidate.apiKey.toString('utf8'), lookup: options.discovery?.lookup, fetchImpl: options.discovery?.fetchImpl, otherSecrets: source ? [{ apiKey: source.apiKey.toString('utf8'), endpoint: source.endpoint }] : [] }) } catch (error) { const diagnostic = providerValidationError(error); fail(diagnostic.code, diagnostic.message, 400) }
      if (sessions.get(session.id) !== session || !Number.isFinite(Number(now())) || Number(now()) >= session.expiresAt || session.providerConfig !== source) fail('CONTROL_SESSION_REQUIRED', '会话已失效，请重新登录。', 401)
      const declarations = declarationPoolFor(session, candidate)
      const selection = catalogCandidates(discovered, declarations, candidate.protocol, poolFor(session))
      const catalog = { ...discovered, declarationContextId: randomUUID(), rawEntries: discovered.entries, ...selection, protocol: candidate.protocol, credentialDigest: credentialDigest(candidate), detectedAt: Number(now()), expiresAt: Number(now()) + CATALOG_TTL_MS }
      let canSave = selection.pool.length > 0
      const manual = session.modelMode === 'manual'
      if (manual) {
        try { for (const { id, efforts } of poolFor(session)) for (const effort of efforts) assertSessionModelEffort(id, effort, poolFor(session), candidate.protocol); assertSessionModelEffort(bootstrapFor(session).model, bootstrapFor(session).effort, poolFor(session), candidate.protocol) } catch { canSave = false }
        if (!discovered.partial && !selection.entries.some(({ id, efforts }) => id === bootstrapFor(session).model && efforts.includes(bootstrapFor(session).effort))) canSave = false
      }
      if (canSave) {
        const oldBootstrap = bootstrapFor(session)
        const pool = manual ? poolFor(session) : selection.pool
        const retained = pool.find(({ id, efforts }) => id === oldBootstrap.model && efforts.includes(oldBootstrap.effort))
        const bootstrap = manual || retained ? oldBootstrap : { model: pool[0].id, effort: pool[0].efforts.includes('high') ? 'high' : pool[0].efforts[0] }
        const changed = modelPoolDigest(pool) !== modelPoolDigest(poolFor(session)) || candidate.protocol !== source?.protocol || candidate.endpoint !== source?.endpoint || !source || credentialDigest(candidate) !== credentialDigest(source)
        const modelCandidate = { pool, mode: 'auto', bootstrap: Object.freeze({ ...bootstrap }), models: Object.freeze(roleSelections(session)), efforts: Object.freeze({ ...session.roleEfforts }), changedPool: changed, changes: {}, effortChanges: {} }
        candidate.model = manual ? source?.model || oldBootstrap.model : bootstrap.model
        candidate.declarationContextId = sameConnection(source, candidate) ? source.declarationContextId : randomUUID()
        clearProvider(session, 'replaced')
        session.providerConfig = candidate
        bindDeclarations(session, candidate)
        if (!manual) commitModelSettings(session, modelCandidate)
        committed = true
      }

      session.modelCatalog = catalog
      return { provider: providerDto(session), models: modelsDto(session), catalog: catalogDto(session), connection_saved: committed }
    } finally { if (!committed) candidate.apiKey.fill(0); if (sessions.get(session.id) === session) session.providerBusy = false }
  }

  async function configureProvider(session, body) {
    if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', 'Provider configuration is busy', 409)
    const candidate = validateProviderBody(body, session.providerConfig, poolFor(session))
    try { assertSessionModelEffort(candidate.model, bootstrapFor(session).effort, poolFor(session), candidate.protocol); if (allocationState(session) === 'ready') checkedModelEfforts(roleSelections(session, candidate.model), effectiveSessionRoleEfforts(session.roleEfforts), 400, poolFor(session), candidate.protocol) } catch (error) { candidate.apiKey.fill(0); if (error instanceof ControlPlaneError) throw error; const diagnostic = providerValidationError(error); fail(diagnostic.code, diagnostic.message) }
    if (containsSessionSecret([candidate.protocol, session.strategy || '', session.discussion || [], session.roleModels || {}, session.roleEfforts || {}, session.settingsDraft || {}, session.preferences || '', session.settingsResult || {}, poolFor(session), session.declaredModelPool || [], bootstrapFor(session), session.allocationReasons || {}], { apiKey: candidate.apiKey.toString('utf8'), endpoint: candidate.endpoint })) {
      candidate.apiKey.fill(0)
      fail('CONTROL_STRATEGY_SECRET', '连接凭据与策略文本冲突，请先清除相关策略内容。', 400)
    }
    try { requireDeclaredCustomPool(session, poolFor(session), candidate) } catch (error) { candidate.apiKey.fill(0); throw error }
    const validationKey = Buffer.from(candidate.apiKey)
    const validationRuntime = Object.freeze({
      provider: candidate.provider,
      protocol: candidate.protocol,
      model: candidate.model,
      endpoint: candidate.endpoint,
      apiKey: validationKey,
      modelPool: poolFor(session)
    })
    let committed = false
    session.providerBusy = true
    try {
      if (typeof adapter.validateProviderConfig !== 'function') fail('CONTROL_PROVIDER_VALIDATOR_UNAVAILABLE', 'Provider validation is unavailable', 503)
      let validation
      try {
        validation = await adapter.validateProviderConfig(validationRuntime)
      } catch (error) {
        const diagnostic = providerValidationError(error)
        fail(diagnostic.code, diagnostic.message, 400)
      }
      if (!(validation === true || validation?.ok === true)) fail('CONTROL_PROVIDER_VALIDATION_FAILED', 'Provider validation failed', 400)
      const current = Number(now())
      if (sessions.get(session.id) !== session || !Number.isFinite(current) || current >= session.expiresAt) {
        fail('CONTROL_SESSION_REQUIRED', 'A live control-plane session is required', 401)
      }
      const retainedCatalog = session.modelCatalog && session.modelCatalog.endpoint === candidate.endpoint && session.modelCatalog.protocol === candidate.protocol && session.modelCatalog.credentialDigest === credentialDigest(candidate) ? session.modelCatalog : null
      candidate.declarationContextId = sameConnection(session.providerConfig, candidate) ? session.providerConfig.declarationContextId : randomUUID()
      clearProvider(session, 'replaced')
      session.providerConfig = candidate
      bindDeclarations(session, candidate)
      if (retainedCatalog) session.modelCatalog = retainedCatalog
      session.modelBootstrap = Object.freeze({ model: candidate.model, effort: bootstrapFor(session).effort })
      committed = true
      return providerDto(session)
    } finally {
      validationKey.fill(0)
      if (!committed) candidate.apiKey.fill(0)
      if (sessions.get(session.id) === session) session.providerBusy = false
    }
  }

  async function runManualCycle(session, input) {
    if (!session.providerConfig) fail('CONTROL_PROVIDER_REQUIRED', 'A session provider configuration is required', 409)
    if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', 'Provider configuration is busy', 409)
    if (typeof adapter.runCycle !== 'function') fail('CONTROL_CYCLE_UNAVAILABLE', 'Manual cycle is unavailable', 503)
    if (allocationState(session) !== 'ready') fail('CONTROL_MODEL_ASSIGNMENT_REQUIRED', '模型池中的角色分配尚未就绪，请让主 Agent 分配或修正手动配置。', 409)
    const source = session.providerConfig
    requireDeclaredCustomPool(session, poolFor(session), source)
    boundedStrategy(session.strategy || '', session, { empty: true })
    const runtimeKey = Buffer.from(source.apiKey)
    const runtime = Object.freeze({
      provider: source.provider,
      protocol: source.protocol,
      model: source.model,
      endpoint: source.endpoint,
      apiKey: runtimeKey,
      strategyPrompt: session.strategy || '',
      roleModels: Object.freeze(roleSelections(session)),
      modelPool: poolFor(session),
      modelMode: session.modelMode || 'auto',
      roleEfforts: effectiveSessionRoleEfforts(session.roleEfforts)
    })
    const runtimeSecrets = [runtimeKey.toString('utf8'), source.endpoint]
    session.providerBusy = true
    try {
      const setup = await paperSetupCall('paperSetupStatus')
      if (sessions.get(session.id) !== session || Number(now()) >= session.expiresAt) fail('CONTROL_SESSION_REQUIRED', '会话已失效，请重新登录。', 401)
      if (!setup.ready) fail('CONTROL_PAPER_SETUP_REQUIRED', setup.message || '请先完成模拟资金和风险设置。', 409)
      let result
      try {
        result = await adapter.runCycle(input, runtime)
      } catch {
        fail('CONTROL_CYCLE_FAILED', 'Manual cycle failed', 502)
      }
      return projectSafe(redactExact(result, runtimeSecrets)) ?? { status: 'empty' }
    } finally {
      runtimeKey.fill(0)
      if (sessions.get(session.id) === session) session.providerBusy = false
    }
  }

  async function paperSetupCall(name, input) {
    if (typeof adapter[name] !== 'function') fail('CONTROL_PAPER_SETUP_UNAVAILABLE', '模拟设置暂不可用。', 503)
    return paperSetupDto(await adapter[name](input))
  }

  function paperSetupDto(value) {
    const values = {}
    for (const key of PAPER_SETUP_FIELDS) {
      const text = String(value?.values?.[key] ?? '')
      if (text.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) values[key] = text
    }
    return {
      ready: value?.ready === true,
      status: ['ready', 'required', 'blocked'].includes(value?.status) ? value.status : 'blocked',
      values,
      missing: PAPER_SETUP_FIELDS.filter((key) => value?.missing?.includes(key)),
      ...(value?.code ? { code: safeText(redactExact(value.code, activeOutputSecrets()), 100) } : {}),
      ...(value?.message ? { message: safeText(redactExact(value.message, activeOutputSecrets()), 240) } : {})
    }
  }

  function boundedStrategy(value, session, { empty = false } = {}) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > STRATEGY_LIMIT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('CONTROL_STRATEGY_INVALID', '策略文本须为 1–8000 字符。', 400)
    const secrets = activeOutputSecrets()
    if (containsCredentialPattern(value) || secrets.some((secret) => value.includes(secret))) fail('CONTROL_STRATEGY_SECRET', '策略和讨论不能包含连接凭据。', 400)
    return value
  }

  function historyCall(fn) {
    try { return fn() } catch (error) { const code = ['CONTROL_HISTORY_INVALID', 'CONTROL_HISTORY_LIMIT', 'CONTROL_HISTORY_NOT_FOUND', 'CONTROL_HISTORY_CONFLICT'].includes(error?.code) ? error.code : 'CONTROL_HISTORY_UNAVAILABLE'; fail(code, ({ CONTROL_HISTORY_INVALID: '本地对话历史损坏，原文件已保留。', CONTROL_HISTORY_LIMIT: '对话历史已达到容量限制。', CONTROL_HISTORY_NOT_FOUND: '对话不存在。', CONTROL_HISTORY_CONFLICT: '对话已在另一处更新，请刷新后重试。' })[code] || '对话历史暂时无法保存，请重试。', 409) }
  }
  function activeConversation(session) {
    if (session.unsavedHistory) return session.unsavedHistory.conversation
    if (!session.conversationId) session.conversationId = (conversations.persistent && historyCall(() => conversations.list()).filter((row) => !row.archived).sort((a, b) => b.updated_at - a.updated_at)[0]?.id) || historyCall(() => conversations.create()).id
    return historyCall(() => conversations.get(session.conversationId))
  }
  function strategyDto(session) {
    const conversation = activeConversation(session)
    return { prompt: session.strategy || '', scope: 'session', theme: session.theme || 'night', draft: structuredClone(session.settingsDraft || {}), preferences: session.preferences || '', settings_result: session.settingsResult || null, discussion: conversation.messages, conversation: { id: conversation.id, title: conversation.title, revision: conversation.revision, model: conversation.model || null, effort: conversation.effort || null }, conversations: session.unsavedHistory?.items || historyCall(() => conversations.list()), history_warning: session.unsavedHistory ? '回复已生成，本地历史尚未保存。请重试保存，避免退出后丢失。' : null }
  }
  function discussionProgress(session, phase) {
    const job = session.discussionJob
    if (!job) return
    const packet = JSON.stringify({ type: 'discussion_progress', data: { request_id: job.id, conversation_id: job.conversationId, phase } })
    for (const client of clients) if (clientSessions.get(client) === session.id && client.readyState === WebSocket.OPEN) client.send(packet)
  }

  async function discussStrategy(session, body) {
    exactBody(body, ['message', 'allocate', 'request_id'], ['message'])
    if (body.request_id !== undefined && (typeof body.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.request_id))) fail('CONTROL_BODY_FIELD_INVALID', '请求标识无效。', 400)
    if (body.request_id && session.cancelledDiscussions?.has(body.request_id)) fail('CONTROL_STRATEGY_CANCELLED', '已停止生成。', 409)
    if (session.unsavedHistory) fail('CONTROL_HISTORY_UNSAVED', '请先保存上一条回复。', 409)
    if (body.allocate !== undefined && body.allocate !== true) fail('CONTROL_BODY_FIELD_INVALID', 'allocate 只能为 true。', 400)
    if (body.allocate && session.modelMode === 'manual') fail('CONTROL_MODEL_MANUAL', '手动模式保留你的选择；请先切换自动模式。', 409)
    const message = boundedStrategy(body.message, session)
    if (!session.providerConfig) fail('CONTROL_PROVIDER_REQUIRED', '请先填写模型连接。', 409)
    if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', '模型正在运行，请等待完成后再讨论或修改。', 409)
    if (typeof adapter.discussStrategy !== 'function') fail('CONTROL_STRATEGY_UNAVAILABLE', '策略讨论暂不可用。', 503)
    const current = Number(now())
    session.discussionRequests = (session.discussionRequests || []).filter((at) => current - at < 60_000)
    if (session.discussionRequests.length >= 12) fail('CONTROL_STRATEGY_RATE_LIMIT', '讨论请求过于频繁，请稍后重试。', 429)
    session.discussionRequests.push(current)
    const source = session.providerConfig
    requireDeclaredCustomPool(session, poolFor(session), source)
    if (containsSessionSecret({ message, prompt: session.strategy || '', history: session.discussion || [], roleEfforts: session.roleEfforts || {}, settingsDraft: session.settingsDraft || {}, preferences: session.preferences || '', modelPool: poolFor(session), bootstrap: bootstrapFor(session), allocationReasons: session.allocationReasons || {} }, { apiKey: source.apiKey.toString('utf8'), endpoint: source.endpoint })) fail('CONTROL_STRATEGY_SECRET', '策略和讨论不能包含连接凭据。', 400)
    const conversation = activeConversation(session)
    const historyItems = historyCall(() => conversations.list())
    if (conversation.archived) fail('CONTROL_HISTORY_CONFLICT', '请先恢复归档的对话。', 409)
    const controller = new AbortController()
    session.discussionJob = { id: body.request_id || randomUUID(), conversationId: conversation.id, controller }
    const key = Buffer.from(source.apiKey)
    const effectiveModels = roleSelections(session)
    const effectiveEfforts = effectiveSessionRoleEfforts(session.roleEfforts)
    const chat = conversation.model ? { model: conversation.model, effort: conversation.effort } : modelsDto(session).chat
    try { assertSessionModelEffort(chat.model, chat.effort, poolFor(session), protocolFor(session)) } catch { key.fill(0); delete session.discussionJob; fail('CONTROL_MODEL_EFFORT_UNSUPPORTED', '请在输入框选择当前连接可用的模型与推理强度。', 400) }
    const runtime = Object.freeze({ provider: source.provider, protocol: source.protocol, model: chat.model, effort: chat.effort, endpoint: source.endpoint, apiKey: key, modelPool: poolFor(session), signal: controller.signal })
    const history = conversation.messages.slice(-8).map(({ role, content }) => ({ role, content }))
    session.providerBusy = true
    let expectedSource = source
    try {
      const ensureActive = () => { if (sessions.get(session.id) !== session || Number(now()) >= session.expiresAt) fail('CONTROL_SESSION_REQUIRED', '会话已失效，请重新登录。', 401); if (controller.signal.aborted) fail('CONTROL_STRATEGY_CANCELLED', '已停止生成。', 409); if (historyCall(() => conversations.get(conversation.id)).revision !== conversation.revision) fail('CONTROL_HISTORY_CONFLICT', '对话已更新，请重试。', 409); if (sessions.get(session.id) !== session || !Number.isFinite(Number(now())) || Number(now()) >= session.expiresAt || session.providerConfig !== expectedSource) fail('CONTROL_SESSION_REQUIRED', '会话已失效，请重新登录。', 401) }
      const setupContext = typeof adapter.paperSetupStatus === 'function' ? await paperSetupCall('paperSetupStatus') : { ready: false, status: 'blocked', values: {}, missing: [], message: '模拟设置暂不可用。' }
      ensureActive()
      discussionProgress(session, 'generating')
      let result
      const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new ControlPlaneError('CONTROL_STRATEGY_CANCELLED', '已停止生成。', 409)), { once: true }))
      try { result = await Promise.race([adapter.discussStrategy({ message, prompt: session.strategy || '', history, roleModels: effectiveModels, roleEfforts: effectiveEfforts, setupContext, settingsDraft: structuredClone(session.settingsDraft || {}), preferences: session.preferences || '', theme: session.theme || 'night', modelPool: poolFor(session), modelMode: session.modelMode || 'auto', allocationRequested: body.allocate === true, allocationState: allocationState(session), modelCatalog: catalogDto(session, true), modelDeclarations: declarationPoolFor(session) }, runtime), cancelled]) } catch (error) {
        if (sessions.get(session.id) !== session || Number(now()) >= session.expiresAt) fail('CONTROL_SESSION_REQUIRED', '会话已失效，请重新登录。', 401)
        if (controller.signal.aborted) fail('CONTROL_STRATEGY_CANCELLED', '已停止生成。', 409)
        if (error?.code === 'PI_STRATEGY_MODELS_INVALID') fail('CONTROL_ROLE_MODELS_INVALID', '模型建议含不支持的角色或模型，请使用设置中列出的模型。', 502)
        fail('CONTROL_STRATEGY_FAILED', '策略讨论未完成，请检查模型连接后重试。', 502)
      }
      if (sessions.get(session.id) !== session || Number(now()) >= session.expiresAt) fail('CONTROL_SESSION_REQUIRED', '会话已失效，请重新登录。', 401)
      ensureActive()
      discussionProgress(session, 'validating')
      // Exact DTO and secret checks run before any chat state is retained.
      if (containsCredentialPattern(JSON.stringify(result)) || containsSessionSecret(result, { apiKey: key.toString('utf8'), endpoint: source.endpoint })) fail('CONTROL_STRATEGY_SECRET', '模型返回了连接凭据，结果已丢弃。', 502)
      const selectedModelSettings = result?.model_settings ?? (result?.intent === 'configure' && result.apply_fields?.includes('model_settings') ? session.settingsDraft?.model_settings : undefined)
      const responsePool = selectedModelSettings?.pool || poolFor(session)
      try { validateConversationOutput(result, responsePool) } catch { fail('CONTROL_SETTINGS_INVALID', '模型返回的设置格式或数值无效；未应用修改，请重新描述目标。', 502) }
      const reply = boundedStrategy(result.reply, session)
      const suggested = result.suggested_prompt === undefined ? '' : boundedStrategy(result.suggested_prompt, session, { empty: true })
      const suggestedModels = result.suggested_role_models === undefined ? undefined : checkedRoleModels(result.suggested_role_models, 502, responsePool)
      const suggestedEfforts = result.suggested_role_efforts === undefined ? undefined : checkedRoleEfforts(result.suggested_role_efforts, 502)
      const intent = result.intent || 'explain'
      if (body.allocate && (intent !== 'configure' || !result.allocation_reasons)) fail('CONTROL_MODEL_ALLOCATION_INVALID', '主 Agent 未返回完整分配及依据；原设置保留。', 502)
      let application = { status: 'unchanged', message: '本轮仅讨论，设置未修改。' }
      let nextSetup = setupContext
      if (intent !== 'explain') {
        const changes = Object.fromEntries(CONVERSATION_SETTING_FIELDS.filter((field) => Object.hasOwn(result, field)).map((field) => [field, result[field]]))
        const scope = intent === 'configure' ? result.apply_fields : Object.keys(changes)
        if ((body.allocate || scope.includes('model_settings') || result.allocation_reasons) && scope.includes('paper_settings')) fail('CONTROL_MODEL_SCOPE_INVALID', '模型配置与自动分配不能提交 Paper 草稿。', 502)
        if (body.allocate && scope.some((field) => !['suggested_role_models', 'suggested_role_efforts', 'model_settings'].includes(field))) fail('CONTROL_MODEL_SCOPE_INVALID', '自动分配仅修改角色模型和 effort。', 502)
        const selectedDraft = Object.fromEntries(Object.entries(session.settingsDraft || {}).filter(([field]) => scope.includes(field)))
        const draft = intent === 'configure' ? { ...selectedDraft, ...changes } : { ...session.settingsDraft, ...changes }
        if (intent === 'configure' && scope.some((field) => !Object.hasOwn(draft, field))) fail('CONTROL_SETTINGS_SCOPE_INVALID', '本轮没有可应用的对应设置，请先描述希望调整的内容。', 502)
        for (const field of ['paper_settings', 'suggested_role_models', 'suggested_role_efforts']) if (changes[field] && (intent === 'clarify' || field === 'paper_settings')) draft[field] = { ...session.settingsDraft?.[field], ...changes[field] }
        if (intent === 'configure' && ['suggested_role_models', 'suggested_role_efforts'].some((field) => Object.hasOwn(draft, field) && Object.keys(draft[field]).length === 0)) fail('CONTROL_SETTINGS_SCOPE_INVALID', '没有指定要调整的 Agent；设置和草稿均未修改。', 502)
        try { validateConversationOutput({ reply: 'draft', ...draft }, poolFor(session)) } catch { fail('CONTROL_SETTINGS_INVALID', '设置草稿的参数组合无效；原设置保留。', 502) }
        const modelCandidate = draft.model_settings && scope.includes('model_settings') ? modelSettingsCandidate(session, draft.model_settings) : null
        if (intent === 'configure' && draft.model_settings && scope.includes('model_settings')) {
          if (session.modelMode === 'manual') fail('CONTROL_MODEL_MANUAL', '手动模型配置不会被聊天覆盖。', 409)
          const known = new Map(knownProtocolCapabilities(protocolFor(session)).map((entry) => [entry.id, entry]))
          const catalog = catalogDto(session, true)
          for (const entry of draft.model_settings.pool || []) {
            const local = known.get(entry.id)
            const declared = declarationPoolFor(session).find(({ id }) => id === entry.id)
            const capability = catalog ? catalog.entries.find(({ id }) => id === entry.id) : local && declared ? { efforts: local.efforts.filter((effort) => declared.efforts.includes(effort)) } : local || declared
            if (!capability || entry.efforts.some((effort) => !capability.efforts.includes(effort))) fail('CONTROL_MODEL_CAPABILITY_UNCONFIRMED', '主 Agent 只能选择已知能力或用户在模型面板明确声明的 effort；请先检测目录或补充能力声明。', 502)
          }
        }
        const candidatePool = modelCandidate?.pool || poolFor(session)
        const roleWrite = scope.some((field) => ['suggested_role_models', 'suggested_role_efforts'].includes(field))
        if (roleWrite && session.modelMode === 'manual') fail('CONTROL_MODEL_MANUAL', '当前为手动模式，聊天不会改动角色配置。请在模型面板保存选择或先切换自动模式。', 409)
        const models = Object.freeze({ ...(modelCandidate?.models || session.roleModels), ...draft.suggested_role_models })
        const efforts = Object.freeze({ ...(modelCandidate?.efforts || session.roleEfforts), ...draft.suggested_role_efforts })
        if (intent === 'configure' && (result.allocation_reasons || (roleWrite && allocationState(session) !== 'ready'))) {
          if (!scope.includes('suggested_role_models') || !scope.includes('suggested_role_efforts') || Object.keys(draft.suggested_role_models || {}).length !== ROLES.length || Object.keys(draft.suggested_role_efforts || {}).length !== ROLES.length || !result.allocation_reasons) fail('CONTROL_MODEL_ALLOCATION_INVALID', '请由主 Agent 返回全部六角色分配及每个角色的依据。', 502)
        }
        const candidateModels = Object.fromEntries(ROLES.map((role) => [role, models[role] || modelCandidate?.bootstrap.model || source.model]))
        const candidateEfforts = effectiveSessionRoleEfforts(efforts)
        if (roleWrite) checkedModelEfforts(candidateModels, candidateEfforts, 502, candidatePool, protocolFor(session))
        const preferences = result.preferences ?? session.preferences ?? ''
        const hasPaper = Object.hasOwn(draft, 'paper_settings')
        let paperValues
        if (hasPaper) {
          try { paperValues = validatePaperSettings({ ...setupContext.values, ...draft.paper_settings }) } catch { fail('CONTROL_SETTINGS_INVALID', '模拟参数或交易限额组合无效；原设置保留。', 502) }
        }
        const incomplete = hasPaper && setupContext.status !== 'blocked' && PAPER_SETUP_FIELDS.some((field) => !Object.hasOwn(paperValues, field))
        const configurationChanged = Boolean(modelCandidate && (modelCandidate.changedPool || modelCandidate.mode !== (session.modelMode || 'auto') || JSON.stringify(modelCandidate.bootstrap) !== JSON.stringify(bootstrapFor(session)))) || Object.keys(effectiveModels).some((role) => candidateModels[role] !== effectiveModels[role] || candidateEfforts[role] !== effectiveEfforts[role])
          || (draft.suggested_prompt !== undefined && draft.suggested_prompt !== (session.strategy || ''))
          || (draft.theme !== undefined && draft.theme !== (session.theme || 'night'))
          || (hasPaper && (!setupContext.ready || Object.entries(paperValues).some(([field, value]) => !Object.hasOwn(setupContext.values, field) || comparePaperDecimal(value, setupContext.values[field]) !== 0)))
        const commit = () => {
          ensureActive()
          if (modelCandidate) { commitModelSettings(session, modelCandidate); expectedSource = session.providerConfig }
          if (configurationChanged) {
            session.strategy = draft.suggested_prompt ?? session.strategy ?? ''
            session.roleModels = models
            session.roleEfforts = efforts
            session.theme = draft.theme || session.theme || 'night'
          }
          if (roleWrite && result.allocation_reasons) { session.allocationPending = false; session.allocationSource = 'agent'; session.allocationReasons = { ...result.allocation_reasons } }
          else if (roleWrite && configurationChanged) { session.allocationSource = 'conversation'; session.allocationReasons = {} }
          session.preferences = preferences
          const remaining = { ...session.settingsDraft }
          for (const field of scope) {
            if (['suggested_role_models', 'suggested_role_efforts'].includes(field) && Object.hasOwn(changes, field)) {
              const roles = Object.fromEntries(Object.entries(remaining[field] || {}).filter(([role]) => !Object.hasOwn(changes[field], role)))
              if (Object.keys(roles).length) { remaining[field] = roles; continue }
            }
            delete remaining[field]
          }
          session.settingsDraft = remaining
        }
        if (intent === 'clarify' || incomplete) {
          ensureActive()
          const pending = { ...session.settingsDraft, ...draft }
          for (const field of ['paper_settings', 'suggested_role_models', 'suggested_role_efforts']) if (draft[field]) pending[field] = { ...session.settingsDraft?.[field], ...draft[field] }
          session.settingsDraft = pending
          session.preferences = preferences
          application = { status: 'pending', message: '已记住已知偏好与草稿，尚未应用设置。' }
        } else {
          try {
            if (hasPaper) {
              if (typeof adapter.setupPaper !== 'function') fail('CONTROL_PAPER_SETUP_UNAVAILABLE', '模拟设置暂不可用。', 503)
              // The production adapter invokes commit synchronously under both
              // file locks, after validated writes and the final session check.
              let committed = false
              const value = adapter.setupPaper(paperValues, { assertActive: ensureActive, commit: () => { commit(); committed = true } })
              if (value?.then || !committed) fail('CONTROL_SETTINGS_COMMIT_UNAVAILABLE', '模拟设置未完成同步提交。', 503)
              nextSetup = paperSetupDto(value)
            } else commit()
            application = configurationChanged
              ? { status: 'applied', message: '服务端已校验并应用设置；下一未开始的有效周期使用新配置。' }
              : { status: 'unchanged', message: '请求的配置与当前设置一致，未作修改。' }
          } catch (error) {
            ensureActive()
            const safe = error instanceof ControlPlaneError ? error : new ControlPlaneError('CONTROL_SETTINGS_FAILED', '保存未完成，原设置保留。请检查模拟设置后重试。', 503)
            application = { status: 'failed', code: safeText(redactExact(safe.code, activeOutputSecrets()), 100), message: safeText(redactExact(safe.message, activeOutputSecrets()), 240) }
          }
        }
      }
      ensureActive()
      const questions = result.questions || []
      if (application.status === 'pending' && !questions.length) questions.push('你希望用多少虚拟资金开始、偏好怎样的风险程度？不确定时可以说“由你安排模拟起点”。')
      if (application.status === 'failed') { questions.length = 0; questions.push('现有模拟账户不能覆盖。要保留现有限制继续讨论，还是先处理上述问题？') }
      const assumptions = result.assumptions || []
      if (application.status === 'applied' && !nextSetup.ready) application.message += ' Paper 尚未就绪，可继续描述模拟目标。'
      const suffix = ['\n', ...assumptions.map((text) => `模拟假设：${text}`), ...(intent === 'explain' ? [] : [application.message]), ...questions].join('\n\n').trimEnd()
      const content = reply.slice(0, STRATEGY_LIMIT - suffix.length) + suffix
      session.settingsResult = { ...application, assumptions }
      const turns = [{ role: 'user', content: message }, { role: 'assistant', content }]
      try { session.discussion = historyCall(() => conversations.append(conversation.id, conversation.revision, turns)).messages }
      catch {
        // Settings may already be committed. Keep the validated reply and expose
        // a separate retryable history failure instead of claiming rollback.
        const pending = { ...conversation, messages: [...conversation.messages, ...turns.map((turn) => ({ id: randomUUID(), ...turn }))].slice(-100) }
        session.unsavedHistory = { conversation: pending, items: historyItems, turns }
        session.discussion = pending.messages
      }
      discussionProgress(session, 'complete')
      return { ...result, reply, suggested_prompt: suggested, questions, assumptions, application, settings: { ...strategyDto(session), models: modelsDto(session), paper: nextSetup } }

    } finally { key.fill(0); if (sessions.get(session.id) === session) { session.providerBusy = false; delete session.discussionJob } }
  }

  function boundedProjection(value, maxItems = 32, maxString = 256) {
    const projected = projectSafe(value)
    if (Array.isArray(projected)) return projected.slice(0, maxItems)
    if (typeof projected === 'string') return projected.slice(0, maxString)
    return projected
  }

  function blockerSummary(value) {
    const projected = boundedProjection(value, 32, 256)
    if (!Array.isArray(projected)) return []
    return projected.map((item) => {
      if (typeof item === 'string') return item.slice(0, 256)
      if (!item || typeof item !== 'object' || Array.isArray(item)) return compactProjection(item, 256)
      const output = {}
      for (const key of ['code', 'message', 'symbol']) {
        if (item[key] !== undefined) output[key] = compactProjection(item[key], key === 'message' ? 256 : 120)
      }
      return output
    })
  }

  function compactProjection(value, maxString = 256) {
    if (typeof value === 'string') return value.slice(0, maxString)
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
    return safeText(JSON.stringify(value), maxString)
  }

  function planSummary(value, fallbackVenue) {
    const source = value?.plan_summary || value?.latest_plan_summary
    const output = {}
    const scalarKeys = ['plan_id', 'plan_hash', 'venue', 'product', 'environment', 'created_at', 'expires_at', 'sealed', 'risk_policy_digest']
    for (const key of scalarKeys) {
      if (source?.[key] !== undefined) output[key] = boundedProjection(source[key], 1)
    }
    output.venue = output.venue || fallbackVenue
    output.risk_policy = boundedProjection(source?.risk_policy, 4) || {}
    output.blockers = blockerSummary(source?.blockers)
    output.intents = Array.isArray(source?.intents)
      ? source.intents.slice(0, 2).map((intent) => {
          const safeIntent = {}
          for (const key of ['symbol', 'side', 'action', 'size', 'notional', 'protection']) {
            if (intent?.[key] !== undefined) {
              if (key === 'protection' && intent[key] && typeof intent[key] === 'object' && !Array.isArray(intent[key])) {
                safeIntent[key] = {}
                for (const protectionKey of ['required', 'stop_price', 'target_price', 'direction', 'stop', 'target']) {
                  if (intent[key][protectionKey] !== undefined) safeIntent[key][protectionKey] = compactProjection(intent[key][protectionKey], 120)
                }
              } else safeIntent[key] = boundedProjection(intent[key], 4, 256)
            }
          }
          return safeIntent
        })
      : []
    return projectSafe(output)
  }

  async function executorCall(targetVenue, request, callOptions = {}) {
    const target = venue(targetVenue)
    const injected = options.executorRequest
    try {
      let raw
      if (typeof injected === 'function') raw = await injected(target, structuredClone(request))
      else {
        const socketPath = configuredSockets[target]
        if (!socketPath) return { ok: false, code: 'CONTROL_EXECUTOR_UNCONFIGURED', message: 'Executor socket is not configured' }
        raw = await socketRequest(socketPath, request)
      }
      const projected = projectSafe(raw) ?? { status: 'empty' }
      if (callOptions.planSummary) projected.plan_summary = planSummary(raw, target)
      return projected
    } catch (error) {
      return { ok: false, ...safeError(error, 'Executor unavailable') }
    }
  }

  async function dispatchHttp(url, method, body, session) {
    const route = `${method} ${url.pathname}`
    if (['/api/paper/setup', '/api/strategy', '/api/strategy/discuss', '/api/strategy/cancel', '/api/conversations', '/api/chat/model', '/api/ui', '/api/models'].includes(url.pathname) && url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
    if (route === 'POST /api/strategy/cancel') {
      exactBody(body, ['request_id'], ['request_id'])
      if (typeof body.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.request_id)) fail('CONTROL_BODY_FIELD_INVALID', '请求标识无效。', 400)
      session.cancelledDiscussions ||= new Set()
      if (session.cancelledDiscussions.size >= 64) session.cancelledDiscussions.delete(session.cancelledDiscussions.values().next().value)
      session.cancelledDiscussions.add(body.request_id)
      const stopped = Boolean(session.discussionJob && session.discussionJob.id === body.request_id)
      if (stopped) session.discussionJob.controller.abort()
      return { stopped }
    }
    if (route === 'GET /api/conversations') return { items: historyCall(() => conversations.list()), active_id: session.conversationId || null }
    if (route === 'POST /api/conversations') {
      exactBody(body, ['action', 'id', 'title', 'pinned', 'archived', 'query'], ['action'])
      if (body.action === 'search') { exactBody(body, ['action', 'query'], ['query']); if (typeof body.query !== 'string' || body.query.length > 200) fail('CONTROL_BODY_FIELD_INVALID', '搜索内容过长。', 400); return { items: historyCall(() => conversations.search(body.query)) } }
      if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', '请先停止当前请求。', 409)
      if (body.action === 'save') {
        exactBody(body, ['action'])
        if (session.unsavedHistory) { const pending = session.unsavedHistory; session.discussion = historyCall(() => conversations.append(pending.conversation.id, pending.conversation.revision, pending.turns)).messages; delete session.unsavedHistory }
        return strategyDto(session)
      }
      if (session.unsavedHistory) fail('CONTROL_HISTORY_UNSAVED', '请先保存上一条回复。', 409)
      if (body.action === 'create') { exactBody(body, ['action']); session.conversationId = historyCall(() => conversations.create()).id }
      else if (body.action === 'select') { exactBody(body, ['action', 'id'], ['id']); session.conversationId = historyCall(() => conversations.get(body.id)).id }
      else if (body.action === 'update') {
        exactBody(body, ['action', 'id', 'title', 'pinned', 'archived'], ['id'])
        const { action, id, ...patch } = body
        if (patch.title !== undefined) boundedStrategy(patch.title, session)
        historyCall(() => conversations.update(id, patch))
      } else fail('CONTROL_BODY_FIELD_INVALID', '对话操作无效。', 400)
      session.discussion = activeConversation(session).messages
      return strategyDto(session)
    }
    if (route === 'POST /api/chat/model') {
      exactBody(body, ['model', 'effort'], ['model', 'effort'])
      if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', '请先停止当前请求。', 409)
      if (session.unsavedHistory) fail('CONTROL_HISTORY_UNSAVED', '请先保存上一条回复。', 409)
      try { assertSessionModelEffort(body.model, body.effort, poolFor(session), protocolFor(session)) } catch { fail('CONTROL_MODEL_EFFORT_UNSUPPORTED', '模型或推理强度不可用。', 400) }
      historyCall(() => conversations.update(activeConversation(session).id, body))
      return strategyDto(session)
    }
    if (route === 'POST /api/ui') {
      exactBody(body, ['theme'], ['theme'])
      if (!['light', 'night'].includes(body.theme)) fail('CONTROL_BODY_FIELD_INVALID', '主题无效。', 400)
      if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', '请等待当前请求结束。', 409)
      session.theme = body.theme
      return { theme: session.theme }
    }
    if (route === 'GET /api/models') return modelsDto(session)
    if (route === 'POST /api/models') {
      if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', '模型正在运行，请等待完成后再保存配置。', 409)
      if (!isObject(body) || !Object.keys(body).length) fail('CONTROL_BODY_FIELD_REQUIRED', '请提供模型配置。', 400)
      const { declaration_context: contextId, ...settings } = body
      const context = declarationContext(session)
      if (contextId !== undefined && (typeof contextId !== 'string' || !/^[0-9a-f-]{36}$/u.test(contextId) || !body.pool || contextId !== context.id)) fail('CONTROL_MODEL_DECLARATION_CONTEXT_STALE', '能力声明对应的连接或目录已变化，请重新检测并确认声明目标；草稿未保存。', 409)
      if (body.pool !== undefined && context.kind === 'pending_catalog' && contextId === undefined) fail('CONTROL_MODEL_DECLARATION_CONTEXT_REQUIRED', '请明确确认当前显示的待连接目录，再保存能力声明。', 409)
      const target = contextId !== undefined && ['current_catalog', 'pending_catalog'].includes(context.kind) ? connectionBinding(liveCatalog(session)) : session.providerConfig ? connectionBinding(session.providerConfig) : null
      const candidate = modelSettingsCandidate(session, settings)
      if (body.pool !== undefined && target) {
        try { for (const { id, efforts } of candidate.pool) for (const effort of efforts) assertSessionModelEffort(id, effort, candidate.pool, target.protocol) } catch { fail('CONTROL_MODEL_POOL_PROTOCOL_INVALID', '声明的模型或 effort 不支持所确认连接的协议；未保存修改。', 400) }
      }
      if (sessions.get(session.id) !== session || !Number.isFinite(Number(now())) || Number(now()) >= session.expiresAt) fail('CONTROL_SESSION_REQUIRED', '会话已失效，请重新登录。', 401)
      commitModelSettings(session, candidate)
      if (body.pool !== undefined) { session.declaredModelPool = candidate.pool; if (target) session.declarationConnection = target; else delete session.declarationConnection }
      return modelsDto(session)
    }
    if (route === 'GET /api/paper/setup') return paperSetupCall('paperSetupStatus')
    if (route === 'POST /api/paper/setup') {
      exactBody(body, PAPER_SETUP_FIELDS)
      if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', '模型正在运行，请稍后设置。', 409)
      const current = Number(now())
      session.setupRequests = (session.setupRequests || []).filter((at) => current - at < 60_000)
      if (session.setupRequests.length >= 12) fail('CONTROL_PAPER_RATE_LIMIT', '设置请求过于频繁，请稍后重试。', 429)
      session.setupRequests.push(current)
      return paperSetupCall('setupPaper', body)
    }
    if (route === 'GET /api/strategy') return strategyDto(session)
    if (route === 'POST /api/strategy') {
      exactBody(body, ['prompt'], ['prompt'])
      if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', '模型正在运行，请等待完成后再应用策略。', 409)
      session.strategy = boundedStrategy(body.prompt, session, { empty: true })
      return strategyDto(session)
    }
    if (route === 'POST /api/strategy/discuss') return discussStrategy(session, body)
    if (route === 'POST /api/logout') {
      exactBody(body, [])
      deleteSession(session.id, 'logout')
      return { ok: true, logged_out: true }
    }
    if (route === 'GET /api/provider') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      return providerDto(session)
    }
    if (route === 'POST /api/provider/discover') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      return discoverProvider(session, body)
    }
    if (route === 'POST /api/provider') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      return configureProvider(session, body)
    }
    if (route === 'POST /api/provider/clear') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      exactBody(body, [])
      if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', 'Provider configuration is busy', 409)
      clearProvider(session, 'cleared')
      return providerDto(session)
    }
    if (route === 'GET /api/status') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      return adapterCall('status')
    }
    if (route === 'GET /api/cycle') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      return adapterCall('cycle')
    }
    if (route === 'GET /api/dag') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      return adapterCall('dag')
    }
    if (route === 'GET /api/paper') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      return adapterCall('paper')
    }
    if (route === 'GET /api/paper/scene') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      try { return paperSceneDto(typeof adapter.paperScene === 'function' ? await adapter.paperScene() : null) }
      catch { return paperSceneDto(null) }
    }
    if (route === 'GET /api/testnet') {
      if (url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
      return {
        gate: await executorCall('gate', { command: 'status' }, { planSummary: true }),
        binance: await executorCall('binance', { command: 'status' }, { planSummary: true })
      }
    }
    if (route === 'GET /api/executor/status') {
      if (url.searchParams.size !== 1 || !url.searchParams.has('venue')) fail('CONTROL_QUERY_UNKNOWN', 'Only venue is accepted in this query')
      const targetVenue = venue(url.searchParams.get('venue'))
      return executorCall(targetVenue, { command: 'status' }, { planSummary: true })
    }
    if (route === 'POST /api/cycle') {
      if (!session.providerConfig) fail('CONTROL_PROVIDER_REQUIRED', 'A session provider configuration is required', 409)
      exactBody(body, ['date', 'iso_week'], ['date', 'iso_week'])
      const input = { date: validateDate(body.date), isoWeek: validateIsoWeek(body.iso_week) }
      return runManualCycle(session, input)
    }
    if (route === 'POST /api/executor/arm') {
      exactBody(body, ['venue', 'confirmation'], ['venue', 'confirmation'])
      const targetVenue = venue(body.venue)
      if (body.confirmation !== ARM_CONFIRMATIONS[targetVenue]) fail('CONTROL_ARM_CONFIRMATION_REQUIRED', 'Arm confirmation is not exact', 403)
      return executorCall(targetVenue, { command: 'arm' })
    }
    if (route === 'POST /api/executor/disarm') {
      exactBody(body, ['venue', 'reason'], ['venue'], [])
      const targetVenue = venue(body.venue)
      if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 200)) fail('CONTROL_REASON_INVALID', 'Disarm reason is invalid')
      return executorCall(targetVenue, body.reason === undefined ? { command: 'disarm' } : { command: 'disarm', reason: body.reason })
    }
    if (route === 'POST /api/executor/plan') {
      exactBody(body, ['venue', 'date', 'iso_week'], ['venue', 'date', 'iso_week'])
      const targetVenue = venue(body.venue)
      return executorCall(targetVenue, { command: 'plan', date: validateDate(body.date), iso_week: validateIsoWeek(body.iso_week) }, { planSummary: true })
    }
    if (route === 'POST /api/executor/execute') {
      exactBody(body, ['venue', 'plan_hash', 'confirmation'], ['venue', 'plan_hash', 'confirmation'])
      const targetVenue = venue(body.venue)
      const planHash = digest(body.plan_hash, 'plan_hash')
      if (body.confirmation !== planHash) fail('CONTROL_PLAN_CONFIRMATION_REQUIRED', 'Manual execute confirmation must equal plan_hash', 403)
      return executorCall(targetVenue, { command: 'execute', plan_ref: planHash, plan_hash: planHash, confirm_hash: planHash })
    }
    if (route === 'POST /api/executor/reconcile') {
      exactBody(body, ['venue', 'plan_hash'], ['venue', 'plan_hash'], [])
      const targetVenue = venue(body.venue)
      return executorCall(targetVenue, body.plan_hash === undefined ? { command: 'reconcile' } : { command: 'reconcile', plan_hash: digest(body.plan_hash, 'plan_hash') })
    }
    fail('CONTROL_ROUTE_NOT_FOUND', 'Control-plane route not found', 404)
  }

  async function start() {
    if (listening) return { host: LOOPBACK_HOST, port: boundPort, origin: expectedOrigin(), bootstrapToken }
    if (staticRoot) {
      try {
        const rootStat = await fs.promises.lstat(staticRoot)
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('CONTROL_STATIC_ROOT_INVALID', 'Static root must be a real directory')
        const indexStat = await fs.promises.lstat(path.join(staticRoot, 'index.html'))
        if (indexStat.isSymbolicLink() || !indexStat.isFile()) fail('CONTROL_STATIC_ROOT_INVALID', 'Static root must contain a real index.html')
      } catch (error) {
        if (error instanceof ControlPlaneError) throw error
        fail('CONTROL_STATIC_ROOT_INVALID', 'Static root is unavailable; run npm run web:build before starting the control plane')
      }
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: LOOPBACK_HOST, port }, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    listening = true
    boundPort = server.address().port
    sessionSweepTimer = setInterval(sweepExpiredSessions, requestedSweepMs)
    sessionSweepTimer.unref?.()
    if (typeof options.onBootstrapToken === 'function') options.onBootstrapToken(bootstrapToken)
    return { host: LOOPBACK_HOST, port: boundPort, origin: expectedOrigin(), bootstrapToken }
  }

  async function stop() {
    if (sessionSweepTimer) {
      clearInterval(sessionSweepTimer)
      sessionSweepTimer = null
    }
    for (const client of clients) client.terminate()
    clients.clear()
    for (const sessionId of [...sessions.keys()]) deleteSession(sessionId, 'server_stop')
    if (!listening) return
    await new Promise((resolve) => server.close(resolve))
    listening = false
    boundPort = null
  }

  function publish(event) {
    sweepExpiredSessions()
    const projected = safeOutput(event)
    const payload = JSON.stringify(projected)
    if (Buffer.byteLength(payload, 'utf8') > MAX_WS_EVENT_BYTES) return { sent: 0, dropped: true, reason: 'event_too_large' }
    let sent = 0
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) continue
      if (client.bufferedAmount > MAX_WS_BUFFER_BYTES) {
        client.terminate()
        clients.delete(client)
        continue
      }
      try {
        client.send(payload)
        sent += 1
        if (client.bufferedAmount > MAX_WS_BUFFER_BYTES) {
          client.terminate()
          clients.delete(client)
        }
      } catch {
        client.terminate()
        clients.delete(client)
      }
    }
    return { sent, dropped: false }
  }

  return Object.freeze({ server, start, stop, publish, get listening() { return listening }, get port() { return boundPort } })
}

function sendEvent(client, event) {
  const payload = JSON.stringify(projectSafe(event))
  if (Buffer.byteLength(payload, 'utf8') <= MAX_WS_EVENT_BYTES && client.readyState === WebSocket.OPEN) client.send(payload)
}

function sendJson(response, status, value, headers = {}, options = {}) {
  const payload = options.sensitive ? value : projectSafe(value)
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text, 'utf8'),
    ...headers
  })
  response.end(text)
}
