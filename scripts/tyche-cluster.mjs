#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildWorkerEnv } from '../packages/pi-agents/src/env.mjs'
import { requestExecutorSocket } from './testnet-executor.mjs'
import { createUtcScheduler } from './utc-scheduler.mjs'
import {
  rejectPiMutationCredentials,
  runPiAutomation,
  runPiWeeklyRefresh
} from './pi-automation.mjs'
import { loadConfig } from './config.mjs'
import { readJsonStrict, withFileLock, writeJsonAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_ROOT = path.join(ROOT, 'config')
const RUNTIME_ROOT = path.join(ROOT, 'data', 'runtime')
const STATE_PATH = path.join(RUNTIME_ROOT, 'tyche-cluster.json')
const SCHEDULER_STATE_PATH = path.join(RUNTIME_ROOT, 'utc_scheduler.json')
const CONTROL_PLANE_SCRIPT = path.join(ROOT, 'scripts', 'tyche-control-plane.mjs')
const STATIC_ROOT = path.join(ROOT, 'apps', 'web', 'dist')
const EXECUTOR_SOCKET_PATHS = Object.freeze({
  gate: path.join(RUNTIME_ROOT, 'gate.sock'),
  binance: path.join(RUNTIME_ROOT, 'binance.sock')
})
const LOOPBACK_HOST = ['127', '0', '0', '1'].join('.')
const DEFAULT_PORT = 8788
const CLUSTER_SCHEMA = 'tyche_cluster_service/v1'
const SAFE_ROLES = Object.freeze(['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer'])
const VENUES = Object.freeze(['gate', 'binance'])

export {
  CLUSTER_SCHEMA,
  CONTROL_PLANE_SCRIPT,
  DEFAULT_PORT,
  EXECUTOR_SOCKET_PATHS,
  LOOPBACK_HOST,
  RUNTIME_ROOT,
  SCHEDULER_STATE_PATH,
  STATE_PATH,
  STATIC_ROOT
}

export class TycheClusterError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'TycheClusterError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new TycheClusterError(code, message, details)
}

function safeText(value, limit = 240) {
  return String(value ?? '')
    .replace(/(?:api[_-]?key|secret|token|password|authorization)\s*[=:]\s*[^\s,;]+/ig, '$1=[redacted]')
    .replace(/\b(?:GATE|BINANCE)_[A-Z0-9_]+\b/gi, '[credential-redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, limit)
}

function errorCode(error, fallback = 'TYCHE_CLUSTER_FAILED') {
  return String(error?.code || fallback).slice(0, 100)
}

function errorSummary(error, fallback = 'Cluster operation failed') {
  return { code: errorCode(error), message: safeText(error?.message || error || fallback) }
}

function requiredString(value, code, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(code, `${label} is required`)
  return value.trim()
}

function isWithin(target, root) {
  const relative = path.relative(root, target)
  return relative === '' || (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertNoSymlink(target) {
  let cursor = target
  while (true) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) fail('CLUSTER_RUNTIME_PATH_SYMLINK', 'fixed cluster runtime paths may not traverse symlinks')
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

function ensureStateDirectory(statePath, fixed = false) {
  const directory = fixed ? RUNTIME_ROOT : path.dirname(statePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertNoSymlink(directory)
  assertNoSymlink(statePath)
}

/** Config paths are user-selectable only inside the repository config directory. */
export function resolveClusterConfigPath(value = path.join(CONFIG_ROOT, 'tyche.json')) {
  const raw = String(value || '').trim()
  if (!raw || raw.includes('\u0000')) fail('CLUSTER_CONFIG_PATH_INVALID', 'config path is invalid')
  const target = path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw))
  if (!isWithin(target, CONFIG_ROOT)) fail('CLUSTER_CONFIG_PATH_INVALID', 'config path must remain inside config/')
  assertNoSymlink(target)
  return target
}

function validPort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('CLUSTER_PORT_INVALID', 'port must be an integer from 0 through 65535')
  return port
}

function venueName(value) {
  if (value === undefined || value === null || value === '') return null
  const result = String(value).trim().toLowerCase()
  if (!VENUES.includes(result)) fail('CLUSTER_VENUE_INVALID', 'testnet-venue must be gate or binance')
  return result
}

function forbiddenPathOption(options) {
  for (const key of ['host', 'runtimeRoot', 'statePath', 'schedulerStatePath', 'serviceStatePath', 'executorSocket', 'executorSockets', 'staticRoot']) {
    if (Object.prototype.hasOwnProperty.call(options, key)) fail('CLUSTER_PATH_OVERRIDE_FORBIDDEN', `${key} is fixed cluster configuration`)
  }
}

export function validateClusterOptions(options = {}, { requireProvider = true } = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('CLUSTER_OPTIONS_INVALID', 'cluster options must be an object')
  forbiddenPathOption(options)
  const provider = requireProvider || options.provider !== undefined
    ? requiredString(options.provider, 'CLUSTER_PROVIDER_REQUIRED', 'provider', 128)
    : undefined
  const model = requireProvider || options.model !== undefined
    ? requiredString(options.model, 'CLUSTER_MODEL_REQUIRED', 'model', 256)
    : undefined
  const mode = options.mode === undefined ? 'shadow' : String(options.mode).trim().toLowerCase()
  if (!['shadow', 'primary'].includes(mode)) fail('CLUSTER_MODE_INVALID', 'mode must be shadow or primary')
  const configPath = resolveClusterConfigPath(options.configPath || path.join(CONFIG_ROOT, 'tyche.json'))
  const port = validPort(options.port === undefined ? DEFAULT_PORT : options.port)
  const testnetVenue = venueName(options.testnetVenue ?? options.testnet_venue)
  return {
    ...options,
    provider,
    model,
    mode,
    configPath,
    port,
    testnetVenue,
    now: options.now ?? Date.now
  }
}

function defaultState(options = {}) {
  return {
    schema: CLUSTER_SCHEMA,
    status: 'stopped',
    host: LOOPBACK_HOST,
    port: options.port ?? null,
    mode: options.mode ?? 'shadow',
    provider: options.provider === undefined || options.provider === null ? null : safeText(options.provider, 128),
    model: options.model === undefined || options.model === null ? null : safeText(options.model, 256),
    current_slot: null,
    recent_cycle: null,
    weekly: null,
    dag: Object.fromEntries(['weekly', 'daily'].map((tier) => [tier, Object.fromEntries(SAFE_ROLES.map((role) => [role, 'unknown']))])),
    paper: { outcome: 'unknown', simulated_filled_contracts: '0', submitted: 0, filled: 0 },
    testnet: { configured: false, venue: null, mode: options.mode ?? 'shadow', plan_outcome: null, plan_hash: null, armed: false, executed: false, blocked: 'not_configured', code: null },
    control_plane: { status: 'stopped', host: LOOPBACK_HOST, port: null },
    updated_at: null
  }
}

function safeDigest(value) {
  const text = String(value || '')
  return /^[a-f0-9]{64}$/i.test(text) ? text.toLowerCase() : null
}

function safeSlot(slot) {
  if (!slot || typeof slot !== 'object') return null
  return {
    kind: String(slot.kind || '').slice(0, 20),
    key: String(slot.key || '').slice(0, 160),
    date: String(slot.date || '').slice(0, 32),
    iso_week: String(slot.iso_week || '').slice(0, 32),
    start_at: String(slot.start_at || '').slice(0, 80),
    end_at: String(slot.end_at || '').slice(0, 80)
  }
}

function cycleObject(result) {
  return result?.automation_cycle && typeof result.automation_cycle === 'object'
    ? result.automation_cycle
    : result?.cycle && typeof result.cycle === 'object' ? result.cycle : null
}

export function summarizeCycle(result) {
  const cycle = cycleObject(result)
  const product = Array.isArray(cycle?.products) ? cycle.products[0] : null
  return {
    date: safeText(result?.date || cycle?.date || '', 32),
    iso_week: safeText(result?.iso_week || cycle?.iso_week || '', 32),
    outcome: safeText(result?.outcome || cycle?.outcome || 'BLOCKED', 80),
    phase: safeText(result?.phase || cycle?.phase || 'BLOCKED', 80),
    ...(result?.blocked_stage ? { blocked_stage: safeText(result.blocked_stage, 80) } : {}),
    cycle_hash: safeDigest(cycle?.cycle_hash ?? result?.cycle_hash),
    plan_hash: safeDigest(product?.plan_hash ?? result?.plan_hash),
    reused: cycle?.reused === true || result?.reused === true,
    simulated_filled_contracts: String(cycle?.simulated_filled_contracts ?? result?.simulated_filled_contracts ?? '0').slice(0, 80),
    submitted: 0,
    filled: 0
  }
}

function weeklySummary(result) {
  const record = result?.weekly && typeof result.weekly === 'object' ? result.weekly : {}
  return {
    outcome: String(result?.outcome || 'BLOCKED').slice(0, 80),
    phase: String(result?.phase || 'BLOCKED').slice(0, 80),
    ...(result?.blocked_stage ? { blocked_stage: String(result.blocked_stage).slice(0, 80) } : {}),
    action: safeText(record.action || (result?.outcome === 'BLOCKED' ? 'failed' : 'refreshed'), 40),
    document_hash: safeDigest(record.document_hash ?? result?.document_hash),
    submitted: 0,
    filled: 0
  }
}

export function summarizeDag(result, fallback = 'unknown') {
  const output = Object.fromEntries(SAFE_ROLES.map((role) => [role, fallback]))
  const runs = result?.pi_provenance?.runs
  if (!Array.isArray(runs)) return output
  for (const record of runs) {
    const tier = record?.tier
    if (!['weekly', 'daily'].includes(tier)) continue
    const roles = record?.provenance?.attempts
    const roleState = Object.fromEntries(SAFE_ROLES.map((role) => [role, fallback]))
    if (record.action === 'reused') {
      for (const role of SAFE_ROLES) roleState[role] = 'reused'
    } else if (Array.isArray(roles)) {
      for (const item of roles) {
        if (SAFE_ROLES.includes(item?.role)) roleState[item.role] = String(item.status || 'unknown').slice(0, 32)
      }
    }
    output[tier] = roleState
  }
  return output
}

function safeDagTier(value) {
  return Object.fromEntries(SAFE_ROLES.map((role) => [role, typeof value?.[role] === 'string' ? safeText(value[role], 32) : 'unknown']))
}

function paperSummary(result) {
  const cycle = cycleObject(result)
  return {
    outcome: safeText(cycle?.outcome || result?.outcome || 'unknown', 80),
    phase: safeText(cycle?.phase || result?.phase || 'unknown', 80),
    simulated_filled_contracts: String(cycle?.simulated_filled_contracts || '0').slice(0, 80),
    submitted: 0,
    filled: 0
  }
}

function safeTestnet(value, defaults = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    configured: source.configured === true,
    venue: VENUES.includes(source.venue) ? source.venue : (defaults.venue || null),
    mode: source.mode === 'primary' ? 'primary' : (defaults.mode || 'shadow'),
    plan_outcome: source.plan_outcome === undefined || source.plan_outcome === null ? null : safeText(source.plan_outcome, 80),
    plan_hash: safeDigest(source.plan_hash),
    armed: source.armed === true,
    executed: source.executed === true,
    blocked: source.blocked === undefined || source.blocked === null ? null : safeText(source.blocked, 120),
    code: source.code === undefined || source.code === null ? null : safeText(source.code, 100)
  }
}

function projectState(previous, patch = {}) {
  const base = previous && previous.schema === CLUSTER_SCHEMA ? previous : defaultState(patch)
  const next = defaultState({ mode: patch.mode ?? base.mode, provider: patch.provider ?? base.provider, model: patch.model ?? base.model, port: patch.port ?? base.port })
  next.status = ['starting', 'running', 'stopped', 'blocked', 'error', 'ticking'].includes(patch.status ?? base.status) ? (patch.status ?? base.status) : 'error'
  next.host = LOOPBACK_HOST
  next.port = Number.isInteger(patch.port ?? base.port) ? patch.port ?? base.port : null
  next.mode = patch.mode === undefined ? (base.mode === 'primary' ? 'primary' : 'shadow') : patch.mode === 'primary' ? 'primary' : 'shadow'
  next.provider = patch.provider === null || patch.provider === undefined ? (base.provider === null || base.provider === undefined ? null : safeText(base.provider, 128)) : safeText(patch.provider, 128)
  next.model = patch.model === null || patch.model === undefined ? (base.model === null || base.model === undefined ? null : safeText(base.model, 256)) : safeText(patch.model, 256)
  next.current_slot = patch.current_slot === undefined ? safeSlot(base.current_slot) : safeSlot(patch.current_slot)
  next.recent_cycle = patch.recent_cycle === undefined ? (base.recent_cycle ? summarizeCycle(base.recent_cycle) : null) : summarizeCycle(patch.recent_cycle)
  next.weekly = patch.weekly === undefined ? (base.weekly ? weeklySummary(base.weekly) : null) : weeklySummary(patch.weekly)
  const dag = patch.dag || base.dag || {}
  next.dag = { weekly: safeDagTier(dag.weekly), daily: safeDagTier(dag.daily) }
  next.paper = patch.paper === undefined ? paperSummary(base.paper) : paperSummary(patch.paper)
  next.testnet = safeTestnet(patch.testnet === undefined ? base.testnet : patch.testnet, { venue: patch.testnetVenue || base.testnet?.venue || null, mode: next.mode })
  const control = patch.control_plane === undefined ? base.control_plane : patch.control_plane
  next.control_plane = {
    status: ['starting', 'running', 'stopped', 'error'].includes(control?.status) ? control.status : 'error',
    host: LOOPBACK_HOST,
    port: Number.isInteger(control?.port) ? control.port : null
  }
  next.updated_at = new Date(Date.now()).toISOString()
  return next
}

function readClusterStateAt(statePath, fixed = false) {
  ensureStateDirectory(statePath, fixed)
  const value = readJsonStrict(statePath, { missingDefault: null })
  if (value === null) return defaultState()
  if (!value || typeof value !== 'object' || value.schema !== CLUSTER_SCHEMA) fail('CLUSTER_STATE_INVALID', 'cluster state schema is invalid')
  const projected = projectState(value, value)
  if (typeof value.updated_at === 'string') projected.updated_at = value.updated_at
  return projected
}

function writeClusterStateAt(statePath, patch, fixed = false) {
  ensureStateDirectory(statePath, fixed)
  let result
  withFileLock(statePath, () => {
    const previous = readJsonStrict(statePath, { missingDefault: null })
    if (previous !== null && (!previous || typeof previous !== 'object' || previous.schema !== CLUSTER_SCHEMA)) fail('CLUSTER_STATE_INVALID', 'cluster state schema is invalid')
    result = projectState(previous, patch)
    writeJsonAtomic(statePath, result, { mode: 0o600 })
    try { fs.chmodSync(statePath, 0o600) } catch {}
  })
  return result
}

export function readTycheClusterState() {
  return readClusterStateAt(STATE_PATH, true)
}

export function writeTycheClusterState(patch) {
  return writeClusterStateAt(STATE_PATH, patch, true)
}

/** Test-only state adapter; production service paths remain fixed constants. */
export function createClusterStateStoreForTest(statePath) {
  const raw = String(statePath || '').trim()
  const target = path.resolve(raw)
  if (!raw || !path.isAbsolute(raw) || target === path.parse(target).root) fail('CLUSTER_TEST_STATE_PATH_INVALID', 'test state path must be an absolute file path')
  return Object.freeze({
    read: () => readClusterStateAt(target),
    write: (patch) => writeClusterStateAt(target, patch)
  })
}

function configFor(options) {
  if (options.config && typeof options.config === 'object' && !Array.isArray(options.config)) return options.config
  try { return loadConfig({ filePath: options.configPath }) } catch { return null }
}

/**
 * An explicit service venue is the only possible target. If a config happens
 * to declare two automatic testnet venues, refuse both; otherwise the
 * independently started executor remains the final venue-bound safety gate.
 */
export function hasSingleTestnetVenue(config, selected) {
  if (!selected || !VENUES.includes(selected)) return false
  const blocks = VENUES.map((name) => ({ name, block: config?.[name] })).filter((row) => row.block && typeof row.block === 'object')
  const automatic = blocks.filter(({ block }) => block.submission_mode === 'automatic_testnet' && block.enabled === true && block.usdm?.enabled === true && block.usdm?.environment === 'testnet').map(({ name }) => name)
  if (automatic.length > 1) return false
  if (automatic.length === 1 && automatic[0] !== selected) return false
  const selectedBlock = config?.[selected]
  if (selectedBlock?.enabled === false || selectedBlock?.usdm?.enabled === false) return false
  return true
}

function defaultExecutorRequest(venue, request) {
  if (!VENUES.includes(venue)) return Promise.reject(new TycheClusterError('CLUSTER_VENUE_INVALID', 'executor venue is invalid'))
  return requestExecutorSocket(EXECUTOR_SOCKET_PATHS[venue], request, { venue })
}

function blockedResult(date, isoWeek, error, stage = 'cluster') {
  return {
    schema: 'tyche_pi_automation_cycle/v1',
    date,
    iso_week: isoWeek,
    outcome: 'BLOCKED',
    phase: 'BLOCKED',
    blocked_stage: stage,
    code: errorCode(error),
    message: safeText(error?.message || error),
    submitted: 0,
    filled: 0
  }
}

function planHashFrom(result) {
  const candidate = result?.plan_summary || result?.plan || result
  return safeDigest(result?.plan_hash || candidate?.plan_hash)
}

function isReadyPlan(result) {
  const outcome = String(result?.outcome || result?.status || '').toUpperCase()
  const summary = result?.plan_summary || result?.plan
  return outcome === 'READY' && summary && typeof summary === 'object' && Boolean(planHashFrom(result))
}

function isArmed(result) {
  if (!result || typeof result !== 'object') return false
  return result.armed === true || result.arm?.armed === true || String(result.status || result.outcome || '').toUpperCase() === 'ARMED' || String(result.arm?.status || '').toUpperCase() === 'ARMED'
}

function executorCode(result) {
  if (!result || typeof result !== 'object') return null
  return result.code === undefined || result.code === null ? null : String(result.code).slice(0, 100)
}

async function runScheduledExecutor(options, slot, cycle, config) {
  const base = {
    configured: Boolean(options.testnetVenue),
    venue: options.testnetVenue,
    mode: options.mode,
    plan_outcome: null,
    plan_hash: null,
    armed: false,
    executed: false,
    blocked: null,
    code: null
  }
  if (options.mode !== 'primary') return { ...base, blocked: 'shadow_mode', code: 'CLUSTER_SHADOW_NO_EXECUTE' }
  if (['BLOCKED', 'FAILED', 'ERROR'].includes(String(cycle?.outcome || '').toUpperCase()) || ['BLOCKED', 'FAILED', 'ERROR'].includes(String(cycle?.phase || '').toUpperCase())) return { ...base, blocked: 'paper_blocked', code: 'CLUSTER_PAPER_BLOCKED' }
  if (!hasSingleTestnetVenue(config, options.testnetVenue)) return { ...base, configured: false, blocked: 'single_testnet_venue_required', code: 'CLUSTER_SINGLE_VENUE_REQUIRED' }

  const request = options.executorRequest || defaultExecutorRequest
  let planned
  try {
    // Exactly one plan request is sent to the explicitly selected venue.
    planned = await request(options.testnetVenue, { command: 'plan', date: slot.date, iso_week: slot.iso_week })
  } catch (error) {
    return { ...base, blocked: 'plan_request_failed', code: errorCode(error, 'CLUSTER_EXECUTOR_PLAN_FAILED') }
  }
  const hash = planHashFrom(planned)
  base.plan_outcome = String(planned?.outcome || planned?.status || 'UNKNOWN').slice(0, 80)
  base.plan_hash = hash
  base.code = executorCode(planned)
  if (/RED|AMBIGUOUS|UNKNOWN|STICKY/.test(JSON.stringify(planned || {}).toUpperCase())) {
    return { ...base, blocked: 'ambiguous_or_red', code: base.code || 'CLUSTER_EXECUTOR_RED' }
  }
  if (!isReadyPlan(planned)) {
    return { ...base, blocked: /AMBIGUOUS|UNKNOWN|STICKY|RED/i.test(JSON.stringify(planned || {})) ? 'ambiguous_or_red' : 'plan_not_ready', code: base.code || 'CLUSTER_PLAN_NOT_READY' }
  }

  let status
  try {
    status = await request(options.testnetVenue, { command: 'status' })
  } catch (error) {
    return { ...base, blocked: 'status_request_failed', code: errorCode(error, 'CLUSTER_EXECUTOR_STATUS_FAILED') }
  }
  if (/RED|AMBIGUOUS|UNKNOWN|STICKY/.test(JSON.stringify(status || {}).toUpperCase())) {
    return { ...base, blocked: 'ambiguous_or_red', code: executorCode(status) || 'CLUSTER_EXECUTOR_RED' }
  }
  base.armed = isArmed(status)
  base.code = executorCode(status) || base.code
  if (!base.armed) return { ...base, blocked: 'unarmed', code: base.code || 'CLUSTER_EXECUTOR_UNARMED' }

  let executed
  try {
    executed = await request(options.testnetVenue, {
      command: 'execute',
      plan_ref: hash,
      plan_hash: hash,
      mode: 'scheduled',
      slot_key: slot.key
    })
  } catch (error) {
    return { ...base, blocked: 'scheduled_execute_failed', code: errorCode(error, 'CLUSTER_EXECUTOR_EXECUTE_FAILED') }
  }
  const executeOutcome = String(executed?.outcome || executed?.status || '').toUpperCase()
  if (/RED|AMBIGUOUS|UNKNOWN|STICKY/.test(JSON.stringify(executed || {}).toUpperCase())) {
    return { ...base, blocked: 'ambiguous_or_red', code: executorCode(executed) || 'CLUSTER_EXECUTOR_RED' }
  }
  const executedOk = executed?.ok === true && !['BLOCKED', 'FAILED', 'ERROR'].includes(executeOutcome)
  return { ...base, executed: executedOk, blocked: executedOk ? null : 'scheduled_execute_blocked', code: executorCode(executed) || base.code || 'CLUSTER_EXECUTOR_EXECUTE_BLOCKED' }
}

export function projectClusterEvent(event) {
  if (!event || typeof event !== 'object') return { type: 'cluster' }
  return {
    type: String(event.type || 'cluster').slice(0, 80),
    data: event.data && typeof event.data === 'object' ? {
      status: String(event.data.status || '').slice(0, 40),
      outcome: String(event.data.outcome || '').slice(0, 80),
      date: String(event.data.date || '').slice(0, 32),
      iso_week: String(event.data.iso_week || '').slice(0, 32),
      blocked: String(event.data.blocked || '').slice(0, 100),
      ...(SAFE_ROLES.includes(event.data.role) ? { role: event.data.role } : {}),
      ...(event.data.asset === 'BTC' || event.data.asset === 'ETH' ? { asset: event.data.asset } : {}),
      ...(Number.isInteger(event.data.attempt) && event.data.attempt >= 0 && event.data.attempt <= 1 ? { attempt: event.data.attempt } : {})
    } : undefined
  }
}

function defaultSpawnControlPlane(options) {
  const child = spawn(process.execPath, [
    CONTROL_PLANE_SCRIPT,
    '--port', String(options.port),
    '--provider', options.provider,
    '--model', options.model,
    '--mode', options.mode,
    '--config', options.configPath,
    ...(options.testnetVenue ? ['--testnet-venue', options.testnetVenue] : [])
  ], {
    cwd: ROOT,
    env: options.workerEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })
  let stdout = ''
  let ready = false
  let timer
  const info = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (ready) return
      ready = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    timer = setTimeout(() => finish(new TycheClusterError('CLUSTER_CONTROL_PLANE_TIMEOUT', 'control plane did not become ready')), 10000)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      if (Buffer.byteLength(stdout, 'utf8') > 64 * 1024) {
        finish(new TycheClusterError('CLUSTER_CONTROL_PLANE_OUTPUT_TOO_LARGE', 'control-plane readiness output exceeded its bound'))
        try { child.kill('SIGTERM') } catch {}
        return
      }
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        try {
          const value = JSON.parse(line)
          if (value?.ok === true && Number.isInteger(value.port)) {
            finish(null, { host: LOOPBACK_HOST, port: value.port, ...(typeof value.bootstrap_token === 'string' && value.bootstrap_token ? { bootstrapToken: value.bootstrap_token } : {}) })
            break
          }
        } catch {}
      }
    })
    child.on('error', (error) => finish(new TycheClusterError('CLUSTER_CONTROL_PLANE_START_FAILED', safeText(error.message || error))))
    child.on('exit', (code, signal) => {
      if (!ready) finish(new TycheClusterError('CLUSTER_CONTROL_PLANE_EXITED', `control plane exited with ${signal || code}`))
    })
  })
  child.stderr?.resume()
  return { child, info }
}

async function stopChild(child) {
  if (!child) return
  if (typeof child.stop === 'function') {
    await child.stop()
    return
  }
  if (typeof child.kill !== 'function') return
  if (child.exitCode !== null && child.exitCode !== undefined) return
  try { child.kill('SIGTERM') } catch {}
  if (typeof child.once === 'function') {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.once('close', () => { clearTimeout(timer); resolve() })
    })
  }
}

function workerEnvironment(options) {
  return buildWorkerEnv({ provider: options.provider, baseEnv: options.env || process.env, providerEnv: options.providerEnv || {} })
}

/**
 * Construct the local coordinator. The coordinator owns no exchange client;
 * its only testnet operation is a request over one of the two fixed socket
 * paths. The control plane is deliberately spawned as another process.
 */
export function createTycheClusterService(rawOptions = {}) {
  const options = validateClusterOptions(rawOptions)
  const runDaily = options.runPiAutomation || runPiAutomation
  const runWeekly = options.runPiWeeklyRefresh || runPiWeeklyRefresh
  const executorRequest = options.executorRequest || defaultExecutorRequest
  const stateStore = options.stateStore || { read: readTycheClusterState, write: writeTycheClusterState }
  const spawnControlPlane = options.spawnControlPlane || defaultSpawnControlPlane
  const schedulerFactory = options.createScheduler || createUtcScheduler
  const events = typeof options.onEvent === 'function' ? options.onEvent : null
  const config = configFor(options)
  const weeklyFailures = new Set()
  let scheduler = null
  let child = null
  let controlInfo = null
  let workerEnv = null
  let startPromise = null
  let running = false

  async function readState() {
    const value = await stateStore.read()
    return value && typeof value === 'object' ? value : defaultState(options)
  }

  async function updateState(patch) {
    const current = await readState()
    const next = projectState(current, { ...patch, provider: options.provider, model: options.model, mode: options.mode, port: controlInfo?.port ?? options.port })
    await stateStore.write(next)
    return next
  }

  function emit(event) {
    const projected = projectClusterEvent(event)
    try { events?.(projected) } catch {}
    // The only parent→control-plane channel carries already projected event
    // metadata. It never transports Pi prompts, model output, or tool args.
    try {
      if (child?.connected === true && typeof child.send === 'function') child.send({ type: 'publish', event: projected }, () => {})
    } catch {}
    return projected
  }

  async function weeklyBlockedFor(isoWeek, context) {
    if (context?.new_entries_allowed === false || weeklyFailures.has(isoWeek)) return true
    if (!scheduler || typeof scheduler.readState !== 'function') return false
    try {
      const state = await scheduler.readState()
      return Object.values(state?.slots || {}).some((entry) => entry?.kind === 'weekly' && entry?.iso_week === isoWeek && entry.status === 'failed')
    } catch {
      return true
    }
  }

  async function handleSlot(slot, context = {}) {
    const base = { date: slot.date, isoWeek: slot.iso_week, provider: options.provider, model: options.model, mode: options.mode, configPath: options.configPath, config, env: workerEnv || options.env || process.env, workerEnv: workerEnv || undefined, now: options.now, onEvent: (event) => emit({ type: 'dag_role', data: event }) }
    await updateState({ status: 'running', current_slot: slot })
    emit({ type: 'slot_started', data: { status: slot.kind, date: slot.date, iso_week: slot.iso_week } })

    if (slot.kind === 'weekly') {
      let result
      try { result = await runWeekly(base) } catch (error) { result = blockedResult(slot.date, slot.iso_week, error, 'weekly') }
      if (String(result?.outcome || '').toUpperCase() === 'BLOCKED' || String(result?.phase || '').toUpperCase() === 'BLOCKED') weeklyFailures.add(slot.iso_week)
      else weeklyFailures.delete(slot.iso_week)
      const dag = summarizeDag(result)
      await updateState({ weekly: result, dag: { weekly: dag.weekly }, current_slot: slot })
      emit({ type: 'weekly', data: { status: result?.outcome, date: slot.date, iso_week: slot.iso_week, blocked: result?.blocked_stage } })
      return result
    }

    const blockedByWeekly = await weeklyBlockedFor(slot.iso_week, context)
    let result
    try { result = await runDaily({ ...base, weeklyBlocked: blockedByWeekly }) } catch (error) { result = blockedResult(slot.date, slot.iso_week, error, 'daily') }
    const dag = summarizeDag(result)
    const cycle = cycleObject(result)
    // Context, weekly failure, and shadow mode all independently prevent a
    // scheduled mutation. Short-circuit before the first socket call when
    // weekly is blocked; do not merely rewrite a post-hoc receipt.
    const testnet = blockedByWeekly
      ? { configured: false, venue: options.testnetVenue, mode: options.mode, plan_outcome: null, plan_hash: null, armed: false, executed: false, blocked: 'weekly_dependency', code: 'CLUSTER_WEEKLY_DEPENDENCY_BLOCKED' }
      : await runScheduledExecutor({ ...options, executorRequest }, slot, result, config)
    await updateState({ recent_cycle: result, dag: { daily: dag.daily }, paper: paperSummary(result), testnet, current_slot: slot })
    emit({ type: 'daily', data: { status: result?.outcome, date: slot.date, iso_week: slot.iso_week, blocked: result?.blocked_stage || testnet.blocked } })
    return result
  }

  function ensureScheduler() {
    if (scheduler) return scheduler
    scheduler = schedulerFactory({
      statePath: SCHEDULER_STATE_PATH,
      now: options.now,
      onSlot: handleSlot,
      lockOptions: options.lockOptions
    })
    return scheduler
  }

  async function start() {
    if (running) return { ok: true, running: true, already_running: true, host: LOOPBACK_HOST, port: controlInfo?.port ?? options.port }
    if (startPromise) return startPromise
    startPromise = (async () => {
      // This guard intentionally precedes state writes, child startup, timer
      // creation, market collection, and any Pi/model call.
      rejectPiMutationCredentials(options.env || process.env)
      workerEnv = workerEnvironment(options)
      await updateState({ status: 'starting', control_plane: { status: 'starting', host: LOOPBACK_HOST, port: options.port }, testnet: { configured: Boolean(options.testnetVenue), venue: options.testnetVenue, mode: options.mode, blocked: options.mode === 'shadow' ? 'shadow_mode' : null } })
      const spawned = await spawnControlPlane({ host: LOOPBACK_HOST, port: options.port, provider: options.provider, model: options.model, mode: options.mode, configPath: options.configPath, testnetVenue: options.testnetVenue, workerEnv })
      child = spawned?.child || spawned || null
      controlInfo = spawned?.info && typeof spawned.info.then === 'function' ? await spawned.info : spawned?.info || null
      if (controlInfo && controlInfo.port !== undefined) controlInfo = { host: LOOPBACK_HOST, port: validPort(controlInfo.port) }
      if (spawned?.info && typeof spawned.info.then === 'function') {
        const ready = await Promise.resolve(spawned.info)
        if (ready?.bootstrapToken) process.stderr.write(`bootstrap_token=${safeText(ready.bootstrapToken, 256)}\n`)
      } else if (spawned?.info?.bootstrapToken) {
        process.stderr.write(`bootstrap_token=${safeText(spawned.info.bootstrapToken, 256)}\n`)
      }
      const currentScheduler = ensureScheduler()
      currentScheduler.start(60 * 1000)
      running = true
      await updateState({ status: 'running', control_plane: { status: 'running', host: LOOPBACK_HOST, port: controlInfo?.port ?? options.port } })
      const tickResult = await currentScheduler.tick()
      if (tickResult?.ok === false) await updateState({ status: 'blocked' })
      return { ok: true, running: true, host: LOOPBACK_HOST, port: controlInfo?.port ?? options.port, tick: tickResult }
    })().catch(async (error) => {
      running = false
      await updateState({ status: 'blocked', control_plane: { status: 'error', host: LOOPBACK_HOST, port: null }, testnet: { configured: Boolean(options.testnetVenue), venue: options.testnetVenue, mode: options.mode, blocked: 'startup_failed', code: errorCode(error) } }).catch(() => {})
      try { scheduler?.stop() } catch {}
      await stopChild(child).catch(() => {})
      child = null
      throw error
    }).finally(() => { startPromise = null })
    return startPromise
  }

  async function tick() {
    rejectPiMutationCredentials(options.env || process.env)
    workerEnv ||= workerEnvironment(options)
    const currentScheduler = ensureScheduler()
    await updateState({ status: 'ticking' })
    const result = await currentScheduler.tick()
    await updateState({ status: result?.ok === false ? 'blocked' : (running ? 'running' : 'stopped') })
    return result
  }

  async function runCycle(input = {}) {
    const date = requiredString(input.date, 'CLUSTER_DATE_REQUIRED', 'date', 32)
    const isoWeek = requiredString(input.isoWeek ?? input.iso_week, 'CLUSTER_WEEK_REQUIRED', 'iso-week', 32)
    rejectPiMutationCredentials(options.env || process.env)
    workerEnv ||= workerEnvironment(options)
    let result
    try {
      result = await runDaily({ date, isoWeek, provider: options.provider, model: options.model, mode: options.mode, configPath: options.configPath, config, env: workerEnv, workerEnv, now: options.now, onEvent: (event) => emit({ type: 'dag_role', data: event }) })
    } catch (error) {
      result = blockedResult(date, isoWeek, error, 'manual_cycle')
    }
    await updateState({ recent_cycle: result, dag: { daily: summarizeDag(result).daily }, paper: paperSummary(result) })
    emit({ type: 'cycle', data: { status: result?.phase, outcome: result?.outcome, date, iso_week: isoWeek, blocked: result?.blocked_stage } })
    return result
  }

  async function stop() {
    if (startPromise) await startPromise.catch(() => {})
    if (scheduler) scheduler.stop()
    running = false
    await stopChild(child)
    child = null
    controlInfo = null
    await updateState({ status: 'stopped', control_plane: { status: 'stopped', host: LOOPBACK_HOST, port: null } })
    return { ok: true, running: false }
  }

  async function status() {
    return readState()
  }

  return Object.freeze({
    start,
    stop,
    tick,
    status,
    runCycle,
    runSlot: handleSlot,
    get running() { return running },
    get scheduler() { return scheduler },
    get child() { return child }
  })
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const command = values[0] || 'status'
  if (!['start', 'tick', 'status'].includes(command)) fail('CLUSTER_COMMAND_INVALID', 'commands are start, tick, and status')
  const allowed = new Set(command === 'status' ? ['--config'] : ['--provider', '--model', '--mode', '--config', '--testnet-venue', '--port'])
  const consumed = new Set([0])
  const get = (flag, fallback = null) => {
    const indexes = values.map((value, index) => value === flag ? index : -1).filter((index) => index >= 0)
    if (indexes.length > 1) fail('CLUSTER_ARGUMENT_DUPLICATE', `${flag} may be supplied only once`)
    if (!indexes.length) return fallback
    const index = indexes[0]
    const value = values[index + 1]
    if (!value || value.startsWith('--')) fail('CLUSTER_ARGUMENT_VALUE_REQUIRED', `${flag} requires a value`)
    consumed.add(index)
    consumed.add(index + 1)
    return value
  }
  const unknown = values.slice(1).filter((value) => value.startsWith('--') && !allowed.has(value))
  if (unknown.length) fail('CLUSTER_ARGUMENT_UNKNOWN', `unsupported argument: ${[...new Set(unknown)].join(', ')}`)
  const args = {
    command,
    provider: get('--provider'),
    model: get('--model'),
    mode: get('--mode', 'shadow'),
    configPath: get('--config', path.join(CONFIG_ROOT, 'tyche.json')),
    testnetVenue: get('--testnet-venue'),
    port: Number(get('--port', String(DEFAULT_PORT)))
  }
  const positional = values.filter((value, index) => !consumed.has(index) && !value.startsWith('--'))
  if (positional.length) fail('CLUSTER_ARGUMENT_INVALID', `unexpected positional argument: ${positional[0]}`)
  if (command !== 'status') validateClusterOptions(args)
  else resolveClusterConfigPath(args.configPath)
  return args
}

async function cli(argv) {
  const args = parseArgs(argv)
  if (args.command === 'status') {
    process.stdout.write(`${JSON.stringify(readTycheClusterState(), null, 2)}\n`)
    return
  }
  const service = createTycheClusterService(args)
  if (args.command === 'tick') {
    process.stdout.write(`${JSON.stringify(await service.tick(), null, 2)}\n`)
    return
  }
  const info = await service.start()
  process.stdout.write(`${JSON.stringify({ ok: true, host: info.host, port: info.port, running: info.running }, null, 2)}\n`)
  const shutdown = async () => { await service.stop(); process.exit(0) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await new Promise(() => {})
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await cli(process.argv)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: errorCode(error), message: safeText(error?.message || error) }, null, 2)}\n`)
    process.exitCode = 1
  }
}
