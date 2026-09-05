import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { URL } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { containsSessionSecret } from '../../../packages/pi-agents/src/session-provider.mjs'

export const LOOPBACK_HOST = '127.0.0.1'
export const SESSION_TTL_MS = 15 * 60 * 1000
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_SOCKET_FRAME_BYTES = 1024 * 1024
export const MAX_WS_EVENT_BYTES = 32 * 1024
export const MAX_WS_BUFFER_BYTES = 256 * 1024
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024
export const PROVIDER = 'openai-responses-compatible'
export const PAPER_SETUP_FIELDS = Object.freeze(['configured_leverage', 'risk_per_trade_bps', 'max_order_notional_usdt', 'daily_new_notional_cap_usdt', 'max_managed_notional_usdt', 'initial_usdt', 'daily_loss_bps', 'max_drawdown_bps', 'max_spread_bps', 'max_entry_distance_bps', 'trigger_slippage_bps'])
const STRATEGY_LIMIT = 8000
const PROVIDER_MODEL_PREFIX = ['g', 'p', 't', '-', '5', '.', '6', '-'].join('')
export const PROVIDER_MODELS = Object.freeze([`${PROVIDER_MODEL_PREFIX}luna`, `${PROVIDER_MODEL_PREFIX}sol`])
export const MAX_PROVIDER_ENDPOINT_BYTES = 2048
export const MAX_PROVIDER_API_KEY_BYTES = 8192
export const ARM_CONFIRMATIONS = Object.freeze({
  gate: 'ARM TESTNET GATE 24H',
  binance: 'ARM TESTNET BINANCE 24H'
})
export const VENUES = Object.freeze(['gate', 'binance'])

const VENUE_SET = new Set(VENUES)
const PROVIDER_MODEL_SET = new Set(PROVIDER_MODELS)
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']
const DIGEST = /^[A-Za-z0-9._:-]{1,256}$/
const SESSION_COOKIE = 'tyche_control_session'
const STATIC_MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
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

function validateProviderBody(value, existing) {
  exactBody(value, ['provider', 'model', 'endpoint', 'api_key'], ['provider', 'model', 'endpoint', ...(existing ? [] : ['api_key'])])
  if (value.provider !== PROVIDER) fail('CONTROL_PROVIDER_UNSUPPORTED', `provider must be ${PROVIDER}`)
  if (typeof value.model !== 'string' || !PROVIDER_MODEL_SET.has(value.model)) fail('CONTROL_PROVIDER_MODEL_UNSUPPORTED', 'model is not allowed')
  if (typeof value.endpoint !== 'string' || !value.endpoint.trim() || Buffer.byteLength(value.endpoint, 'utf8') > MAX_PROVIDER_ENDPOINT_BYTES) {
    fail('CONTROL_PROVIDER_ENDPOINT_INVALID', 'endpoint must be a bounded HTTP(S) base URL')
  }
  if (value.endpoint !== value.endpoint.trim() || /[\u0000-\u001f\u007f]/.test(value.endpoint)) {
    fail('CONTROL_PROVIDER_ENDPOINT_INVALID', 'endpoint must be a bounded HTTP(S) base URL')
  }
  let parsed
  try {
    parsed = new URL(value.endpoint)
  } catch {
    fail('CONTROL_PROVIDER_ENDPOINT_INVALID', 'endpoint must be a bounded HTTP(S) base URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('CONTROL_PROVIDER_ENDPOINT_INVALID', 'endpoint must be a bounded HTTP(S) base URL')
  }
  const apiKey = value.api_key === undefined ? existing?.apiKey.toString('utf8') : value.api_key
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey !== apiKey.trim() || /[\u0000-\u001f\u007f]/.test(apiKey) || Buffer.byteLength(apiKey, 'utf8') > MAX_PROVIDER_API_KEY_BYTES) {
    fail('CONTROL_PROVIDER_API_KEY_INVALID', 'api_key must be a bounded non-empty string')
  }
  return { provider: PROVIDER, model: value.model, endpoint: parsed.href, apiKey: Buffer.from(apiKey, 'utf8') }
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
  const configuredSockets = options.executorSockets || {}
  if (!isObject(configuredSockets)) fail('CONTROL_SOCKET_CONFIG_INVALID', 'Executor sockets must be server configuration')
  for (const key of Object.keys(configuredSockets)) {
    if (!VENUE_SET.has(key)) fail('CONTROL_SOCKET_CONFIG_INVALID', 'Only gate and binance socket paths are supported')
    validSocketPath(configuredSockets[key])
  }

  const bootstrapToken = token()
  let bootstrapUsed = false
  let listening = false
  let boundPort = null
  let sessionSweepTimer = null
  const sessions = new Map()
  const clients = new Set()

  function providerDto(session) {
    const config = session?.providerConfig
    return {
      configured: Boolean(config),
      provider: config?.provider || null,
      model: config?.model || null,
      endpoint: config?.endpoint || null,
      scope: 'session',
      manual_cycle_only: true
    }
  }

  function clearProvider(session, reason) {
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
    clearProvider(session, reason)
    session.strategy = ''
    session.discussion = []
    sessions.delete(sessionId)
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
      const session = requireSession(request, request.method !== 'GET')
      const body = request.method === 'POST' ? await readJsonBody(request) : null
      const result = await dispatchHttp(url, request.method || 'GET', body, session)
      const explicitDto = ['/api/provider', '/api/provider/clear', '/api/paper/setup', '/api/strategy', '/api/strategy/discuss'].includes(url.pathname)
      sendJson(response, 200, explicitDto ? result : safeOutput(result), {}, { sensitive: explicitDto })
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
  wsServer.on('connection', (client) => {
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

  function validateEnvelope(request, url, { mutation }) {
    if (!listening && url.pathname !== '/api/health') fail('CONTROL_NOT_STARTED', 'Control plane is not started', 503)
    if (request.headers.host !== expectedHost()) fail('CONTROL_HOST_REJECTED', 'Host must be the loopback control-plane origin', 403)
    for (const header of FORWARDED_HEADERS) if (request.headers[header] !== undefined) fail('CONTROL_FORWARDED_HEADER_REJECTED', 'Forwarded headers are not accepted', 403)
    const origin = request.headers.origin
    if (origin !== undefined && origin !== expectedOrigin()) fail('CONTROL_ORIGIN_REJECTED', 'Origin must be the loopback control-plane origin', 403)
    if (mutation && origin !== expectedOrigin()) fail('CONTROL_ORIGIN_REQUIRED', 'Mutations require the exact loopback Origin', 403)
  }

  function requireSession(request, mutation) {
    const sessionId = cookieValue(request.headers.cookie, SESSION_COOKIE)
    const entry = sessions.get(sessionId)
    const current = Number(now())
    if (!entry || !Number.isFinite(current) || current >= entry.expiresAt) {
      if (sessionId) deleteSession(sessionId, 'expired')
      fail('CONTROL_SESSION_REQUIRED', 'A live control-plane session is required', 401)
    }
    if (mutation) {
      const csrf = request.headers['x-csrf-token']
      if (!tokenEqual(csrf, entry.csrf)) fail('CONTROL_CSRF_REJECTED', 'CSRF token is missing or invalid', 403)
      if (request.headers.origin !== expectedOrigin()) fail('CONTROL_ORIGIN_REQUIRED', 'Mutations require the exact loopback Origin', 403)
    }
    return entry
  }

  async function handleSession(request, response) {
    const body = await readJsonBody(request)
    exactBody(body, ['bootstrap_token'], ['bootstrap_token'])
    if (bootstrapUsed || !tokenEqual(body.bootstrap_token, bootstrapToken)) fail('CONTROL_BOOTSTRAP_REJECTED', 'Bootstrap token is invalid or already used', 401)
    bootstrapUsed = true
    const sessionId = token()
    const csrf = token()
    const expiresAt = Number(now()) + SESSION_TTL_MS
    sessions.set(sessionId, { id: sessionId, csrf, expiresAt })
    const secure = request.socket.encrypted ? '; Secure' : ''
    sendJson(response, 200, { ok: true, csrf_token: csrf, expires_at: new Date(expiresAt).toISOString() }, {
      'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`
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

  async function configureProvider(session, body) {
    if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', 'Provider configuration is busy', 409)
    const candidate = validateProviderBody(body, session.providerConfig)
    if (containsSessionSecret([session.strategy || '', session.discussion || []], { apiKey: candidate.apiKey.toString('utf8'), endpoint: candidate.endpoint })) {
      candidate.apiKey.fill(0)
      fail('CONTROL_STRATEGY_SECRET', '连接凭据与策略文本冲突，请先清除相关策略内容。', 400)
    }
    const validationKey = Buffer.from(candidate.apiKey)
    const validationRuntime = Object.freeze({
      provider: candidate.provider,
      model: candidate.model,
      endpoint: candidate.endpoint,
      apiKey: validationKey
    })
    let committed = false
    session.providerBusy = true
    try {
      if (typeof adapter.validateProviderConfig !== 'function') fail('CONTROL_PROVIDER_VALIDATOR_UNAVAILABLE', 'Provider validation is unavailable', 503)
      let validation
      try {
        validation = await adapter.validateProviderConfig(validationRuntime)
      } catch {
        fail('CONTROL_PROVIDER_VALIDATION_FAILED', 'Provider validation failed', 400)
      }
      if (!(validation === true || validation?.ok === true)) fail('CONTROL_PROVIDER_VALIDATION_FAILED', 'Provider validation failed', 400)
      const current = Number(now())
      if (sessions.get(session.id) !== session || !Number.isFinite(current) || current >= session.expiresAt) {
        fail('CONTROL_SESSION_REQUIRED', 'A live control-plane session is required', 401)
      }
      clearProvider(session, 'replaced')
      session.providerConfig = candidate
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
    const source = session.providerConfig
    boundedStrategy(session.strategy || '', session, { empty: true })
    const runtimeKey = Buffer.from(source.apiKey)
    const runtime = Object.freeze({
      provider: source.provider,
      model: source.model,
      endpoint: source.endpoint,
      apiKey: runtimeKey,
      strategyPrompt: session.strategy || ''
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
    const value = await adapter[name](input)
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
    if (secrets.some((secret) => value.includes(secret))) fail('CONTROL_STRATEGY_SECRET', '策略和讨论不能包含连接凭据。', 400)
    return value
  }

  function strategyDto(session) {
    return { prompt: session.strategy || '', scope: 'session', discussion: (session.discussion || []).map(({ role, content }) => ({ role, content })) }
  }

  async function discussStrategy(session, body) {
    exactBody(body, ['message'], ['message'])
    const message = boundedStrategy(body.message, session)
    if (!session.providerConfig) fail('CONTROL_PROVIDER_REQUIRED', '请先填写模型连接。', 409)
    if (session.providerBusy) fail('CONTROL_PROVIDER_BUSY', '模型正在运行，请等待完成后再讨论或修改。', 409)
    if (typeof adapter.discussStrategy !== 'function') fail('CONTROL_STRATEGY_UNAVAILABLE', '策略讨论暂不可用。', 503)
    const current = Number(now())
    session.discussionRequests = (session.discussionRequests || []).filter((at) => current - at < 60_000)
    if (session.discussionRequests.length >= 12) fail('CONTROL_STRATEGY_RATE_LIMIT', '讨论请求过于频繁，请稍后重试。', 429)
    session.discussionRequests.push(current)
    const source = session.providerConfig
    if (containsSessionSecret({ message, prompt: session.strategy || '', history: session.discussion || [] }, { apiKey: source.apiKey.toString('utf8'), endpoint: source.endpoint })) fail('CONTROL_STRATEGY_SECRET', '策略和讨论不能包含连接凭据。', 400)
    const key = Buffer.from(source.apiKey)
    const runtime = Object.freeze({ provider: source.provider, model: source.model, endpoint: source.endpoint, apiKey: key })
    const history = (session.discussion || []).slice(-8).map(({ role, content }) => ({ role, content }))
    session.providerBusy = true
    try {
      let result
      try { result = await adapter.discussStrategy({ message, prompt: session.strategy || '', history }, runtime) } catch { fail('CONTROL_STRATEGY_FAILED', '策略讨论未完成，请检查模型连接后重试。', 502) }
      if (sessions.get(session.id) !== session || Number(now()) >= session.expiresAt) fail('CONTROL_SESSION_REQUIRED', '会话已失效，请重新登录。', 401)
      // Exact DTO and secret checks run before any chat state is retained.
      if (containsSessionSecret(result, { apiKey: key.toString('utf8'), endpoint: source.endpoint })) fail('CONTROL_STRATEGY_SECRET', '模型返回了连接凭据，结果已丢弃。', 502)
      exactBody(result, ['reply', 'suggested_prompt'], ['reply'])
      const reply = boundedStrategy(result.reply, session)
      const suggested = result.suggested_prompt === undefined ? '' : boundedStrategy(result.suggested_prompt, session, { empty: true })
      session.discussion = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }]
      return { reply, suggested_prompt: suggested }
    } finally { key.fill(0); if (sessions.get(session.id) === session) session.providerBusy = false }
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
    if (['/api/paper/setup', '/api/strategy', '/api/strategy/discuss'].includes(url.pathname) && url.search) fail('CONTROL_QUERY_UNKNOWN', 'This route does not accept a query', 400)
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
