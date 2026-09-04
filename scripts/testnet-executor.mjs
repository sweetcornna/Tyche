#!/usr/bin/env node

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBinanceClient } from './binance-rest.mjs'
import { executionConfigForVenue, loadConfig, validateConfig } from './config.mjs'
import {
  reconcileSnapshot,
  readLedger,
  reduceLedger,
  sha256Hex,
  stableStringify,
  unresolvedRedCauses,
  verifyReconciliationReceipt,
  verifyPlan
} from './gate-trade.mjs'
import { createGateClient } from './gate-rest.mjs'
import {
  planAutomaticTestnet,
  executeAutomaticTestnetPlan,
  ledgerPathForVenue
} from './testnet-trade.mjs'
import {
  currentUtcSlots
} from './utc-scheduler.mjs'
import {
  readJsonStrict,
  updateJsonLocked,
  withFileLockAsync,
  writeJsonAtomic
} from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENUES = new Set(['gate', 'binance'])
const COMMANDS = new Set(['status', 'arm', 'disarm', 'plan', 'execute', 'reconcile'])
const ARM_TTL_MS = 24 * 60 * 60 * 1000
const SAFE_DIGEST = /^[A-Za-z0-9._:-]{1,256}$/
const MAX_FRAME_BYTES = 1024 * 1024
const SOCKET_CLIENT_TIMEOUT_MS = 2000
const SENSITIVE_KEY = /(?:api.?key|secret|token|password|credential|authorization|cookie|private.?key|signature)/i
const FORBIDDEN_ROUTE_KEY = /^(?:path|host|method|url|endpoint|base.?url|headers)$/i
const MUTATION_METHODS = new Set(['usdmPlaceOrder', 'usdmPlacePriceOrder', 'usdmCancelOrder', 'usdmCancelPriceOrder'])
const DEFAULT_STATE_SCHEMA = 'tyche_testnet_executor/v1'
const DATA_RUNTIME_ROOT = path.join(ROOT, 'data', 'runtime')
const DATA_TESTNET_ROOT = path.join(ROOT, 'data', 'testnet')
// The existing testnet-trade/control-plane contract owns these exact kill
// files.  State, cycle, and sockets use data/runtime; the kill files remain
// at their established data/ locations and are the only root-level data
// exceptions in the executor path policy.
const DEFAULT_KILL_SWITCH = Object.freeze({ gate: path.join(ROOT, 'data', 'gate_KILL'), binance: path.join(ROOT, 'data', 'binance_KILL') })
const IN_PROCESS_STATE_QUEUES = new Map()
const IN_PROCESS_SOCKET_QUEUES = new Map()
const IN_PROCESS_PLAN_QUEUES = new Map()
const EXECUTOR_PATH_POLICIES = new WeakMap()
const CYCLE_SCHEMA = 'tyche_testnet_active_cycle/v1'
const EMPTY_LEDGER = Object.freeze({ schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] })

export const EXECUTOR_SCHEMA = DEFAULT_STATE_SCHEMA
export const ARM_WINDOW_MS = ARM_TTL_MS
export const EXECUTOR_COMMANDS = Object.freeze([...COMMANDS])
export const DEFAULT_KILL_SWITCH_PATHS = Object.freeze({ ...DEFAULT_KILL_SWITCH })
export const EXECUTOR_MAX_FRAME_BYTES = MAX_FRAME_BYTES
export const EXECUTOR_SOCKET_TIMEOUT_MS = SOCKET_CLIENT_TIMEOUT_MS

const REQUEST_FIELDS = Object.freeze({
  status: new Set(['command']),
  arm: new Set(['command', 'risk_digest', 'config_digest', 'policy_digest']),
  disarm: new Set(['command', 'reason']),
  plan: new Set(['command', 'date', 'iso_week']),
  execute: new Set(['command', 'plan', 'plan_ref', 'plan_id', 'plan_hash', 'mode', 'slot_key', 'confirm_hash', 'confirm_plan_hash', 'confirmation']),
  reconcile: new Set(['command', 'plan_ref', 'plan_id', 'plan_hash', 'cause_ids', 'claim_token'])
})

export class ExecutorError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'ExecutorError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new ExecutorError(code, message, details)
}

function venueName(value) {
  const venue = String(value || '').trim().toLowerCase()
  if (!VENUES.has(venue)) fail('EXECUTOR_VENUE_UNSUPPORTED', 'Executor venue must be gate or binance')
  return venue
}

function finiteNow(value) {
  const raw = typeof value === 'function' ? value() : value
  const result = raw instanceof Date ? raw.getTime() : Number(raw)
  if (!Number.isFinite(result) || !Number.isSafeInteger(result) || result < 0) fail('EXECUTOR_CLOCK_INVALID', 'Executor clock must be a finite non-negative safe integer')
  return result
}

function iso(ms) {
  const date = new Date(ms)
  if (!Number.isFinite(date.getTime())) fail('EXECUTOR_CLOCK_INVALID', 'Executor clock does not encode a valid UTC date')
  return date.toISOString()
}

function safeText(value, limit = 240) {
  return String(value ?? '')
    .replace(/(?:GATE|BINANCE)_[A-Z0-9_]*(?:API_KEY|SECRET_KEY)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|secret(?:[_-]?key)?|password|token|authorization|cookie|private[_-]?key|signature)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, limit)
}

function safeError(error, fallback = 'Executor request failed') {
  return { code: String(error?.code || 'EXECUTOR_ERROR').slice(0, 100), message: safeText(error?.message || error || fallback) }
}

function inspectValue(value, location = '$', depth = 0, seen = new WeakSet(), allowReconcileClaimToken = false) {
  if (depth > 20) fail('EXECUTOR_PAYLOAD_TOO_DEEP', 'Executor payload is too deeply nested')
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) fail('EXECUTOR_PAYLOAD_CYCLE', 'Executor payload cannot contain cycles')
  seen.add(value)
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) inspectValue(child, `${location}[${index}]`, depth + 1, seen, allowReconcileClaimToken)
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_ROUTE_KEY.test(key)) fail('EXECUTOR_ROUTE_FIELD_FORBIDDEN', `${location}.${key} is not accepted`)
      if (SENSITIVE_KEY.test(key) && !(allowReconcileClaimToken && location === '$' && key === 'claim_token')) fail('EXECUTOR_CREDENTIAL_FIELD_FORBIDDEN', `${location}.${key} is not accepted`)
      inspectValue(child, `${location}.${key}`, depth + 1, seen, allowReconcileClaimToken)
    }
  }
  seen.delete(value)
}

function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('EXECUTOR_REQUEST_INVALID', 'Executor request must be an object')
  const command = String(value.command || '')
  if (!COMMANDS.has(command)) fail('EXECUTOR_COMMAND_UNSUPPORTED', 'Commands: status, arm, disarm, plan, execute, reconcile')
  inspectValue(value, '$', 0, new WeakSet(), command === 'reconcile')
  const allowed = REQUEST_FIELDS[command]
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) fail('EXECUTOR_FIELD_UNKNOWN', `Unsupported fields: ${unknown.join(', ')}`)
  return command
}

function safeOutput(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return typeof value === 'string' ? safeText(value, 2000) : value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    const output = value.map((child) => safeOutput(child, seen))
    seen.delete(value)
    return output
  }
  const output = {}
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || FORBIDDEN_ROUTE_KEY.test(key) || ['stack', 'cause', 'headers'].includes(key.toLowerCase())) continue
    output[key] = safeOutput(child, seen)
  }
  seen.delete(value)
  return output
}

function serializeStatePath(targetPath, task) {
  const previous = IN_PROCESS_STATE_QUEUES.get(targetPath) || Promise.resolve()
  const current = previous.then(task, task)
  const cleanup = () => {
    if (IN_PROCESS_STATE_QUEUES.get(targetPath) === tail) IN_PROCESS_STATE_QUEUES.delete(targetPath)
  }
  // Keep the queue tail settled even when the caller intentionally handles a
  // rejected operation; a rejected `.finally()` tail would become an
  // unhandled rejection in Node while still serving no scheduling purpose.
  const tail = current.then(cleanup, cleanup)
  IN_PROCESS_STATE_QUEUES.set(targetPath, tail)
  return current
}

function serializeSocketPath(targetPath, task) {
  const previous = IN_PROCESS_SOCKET_QUEUES.get(targetPath) || Promise.resolve()
  const current = previous.then(task, task)
  const cleanup = () => {
    if (IN_PROCESS_SOCKET_QUEUES.get(targetPath) === tail) IN_PROCESS_SOCKET_QUEUES.delete(targetPath)
  }
  const tail = current.then(cleanup, cleanup)
  IN_PROCESS_SOCKET_QUEUES.set(targetPath, tail)
  return current
}

function serializePlanPath(targetPath, task) {
  const previous = IN_PROCESS_PLAN_QUEUES.get(targetPath) || Promise.resolve()
  const current = previous.then(task, task)
  const cleanup = () => {
    if (IN_PROCESS_PLAN_QUEUES.get(targetPath) === tail) IN_PROCESS_PLAN_QUEUES.delete(targetPath)
  }
  const tail = current.then(cleanup, cleanup)
  IN_PROCESS_PLAN_QUEUES.set(targetPath, tail)
  return current
}

function defaultState(venue) {
  return {
    schema: DEFAULT_STATE_SCHEMA,
    venue,
    arm: null,
    plans: {},
    plan_runs: {},
    latest_plan_summary: null,
    executions: {},
    ambiguous_lock: null,
    reconcile: null,
    last_clock_ms: null,
    clock_fault: null,
    disarm_reason: null
  }
}

function defaultCycleState() {
  return { schema: CYCLE_SCHEMA, active: null }
}

function cloneState(value, venue) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== DEFAULT_STATE_SCHEMA || value.venue !== venue) {
    fail('EXECUTOR_STATE_INVALID', 'Executor state schema or venue is invalid')
  }
  if (!value.plans || typeof value.plans !== 'object' || Array.isArray(value.plans)) fail('EXECUTOR_STATE_INVALID', 'Executor plans must be an object')
  if (value.plan_runs !== undefined && (!value.plan_runs || typeof value.plan_runs !== 'object' || Array.isArray(value.plan_runs))) fail('EXECUTOR_STATE_INVALID', 'Executor plan runs must be an object')
  if (!value.executions || typeof value.executions !== 'object' || Array.isArray(value.executions)) fail('EXECUTOR_STATE_INVALID', 'Executor executions must be an object')
  const state = {
    ...defaultState(venue),
    ...structuredClone(value),
    venue,
    plans: structuredClone(value.plans),
    executions: structuredClone(value.executions)
  }
  if (state.last_clock_ms !== null && (!Number.isSafeInteger(Number(state.last_clock_ms)) || Number(state.last_clock_ms) < 0)) fail('EXECUTOR_STATE_INVALID', 'Executor state clock is invalid')
  if (state.arm !== null && (typeof state.arm !== 'object' || Array.isArray(state.arm))) fail('EXECUTOR_STATE_INVALID', 'Executor arm receipt is invalid')
  if (state.latest_plan_summary !== null && (typeof state.latest_plan_summary !== 'object' || Array.isArray(state.latest_plan_summary))) fail('EXECUTOR_STATE_INVALID', 'Executor latest plan summary is invalid')
  if (state.ambiguous_lock !== null && (typeof state.ambiguous_lock !== 'object' || Array.isArray(state.ambiguous_lock))) fail('EXECUTOR_STATE_INVALID', 'Executor ambiguous lock is invalid')
  if (state.reconcile !== null && (typeof state.reconcile !== 'object' || Array.isArray(state.reconcile))) fail('EXECUTOR_STATE_INVALID', 'Executor reconcile claim is invalid')
  return state
}

function writeState(statePath, state) {
  writeJsonAtomic(statePath, state, { mode: 0o600 })
  try { fs.chmodSync(statePath, 0o600) } catch {}
}

function armCore(receipt) {
  return {
    schema: receipt.schema,
    nonce: receipt.nonce,
    venue: receipt.venue,
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
    risk_digest: receipt.risk_digest,
    config_digest: receipt.config_digest,
    policy_digest: receipt.policy_digest
  }
}

function sealArm(receipt) {
  return sha256Hex(armCore(receipt))
}

function verifyArm(receipt, venue) {
  if (!receipt || receipt.schema !== 'tyche_testnet_arm/v1' || receipt.venue !== venue || !receipt.nonce || !receipt.issued_at || !receipt.expires_at || !receipt.hash_seal) return false
  if (sealArm(receipt) !== receipt.hash_seal) return false
  const issued = Date.parse(receipt.issued_at)
  const expires = Date.parse(receipt.expires_at)
  return Number.isSafeInteger(issued) && Number.isSafeInteger(expires) && expires - issued === ARM_TTL_MS
}

function normalizeDigest(value, field) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value)
  if (!SAFE_DIGEST.test(text)) fail('EXECUTOR_DIGEST_INVALID', `${field} must be a bounded digest value`)
  return text
}

function digestInput(options, venue) {
  let custom = {}
  if (typeof options.getDigests === 'function') custom = options.getDigests() || {}
  else if (options.digests && typeof options.digests === 'object') custom = options.digests
  const config = options.config
  let mapped = config
  if (config && venue === 'binance') {
    try { mapped = executionConfigForVenue(config, venue) } catch { mapped = config }
  }
  const risk = custom.risk_digest ?? custom.riskDigest ?? options.riskDigest ?? (mapped ? sha256Hex(mapped.gate?.usdm || mapped.binance?.usdm || {}) : null)
  const configDigest = custom.config_digest ?? custom.configDigest ?? options.configDigest ?? (mapped ? sha256Hex(mapped) : null)
  const policy = custom.policy_digest ?? custom.policyDigest ?? options.policyDigest ?? (mapped ? sha256Hex({ venue, submission_mode: mapped.gate?.submission_mode, usdm: mapped.gate?.usdm, analysis: mapped.analysis }) : null)
  return {
    risk_digest: normalizeDigest(risk, 'risk_digest'),
    config_digest: normalizeDigest(configDigest, 'config_digest'),
    policy_digest: normalizeDigest(policy, 'policy_digest')
  }
}

function digestDifference(receipt, current) {
  return ['risk_digest', 'config_digest', 'policy_digest'].some((key) => !current[key] || current[key] !== receipt[key])
}

function configScope(config, venue) {
  if (!config) return { ok: true }
  try { validateConfig(config) } catch (error) { return { ok: false, code: error.code || 'CONFIG_INVALID', message: safeText(error.message) } }
  const block = venue === 'gate' ? config.gate : config.binance
  if (!block || block.enabled !== true || block.submission_mode !== 'automatic_testnet' || block.usdm?.enabled !== true || block.usdm?.environment !== 'testnet') {
    return { ok: false, code: 'EXECUTOR_TESTNET_SCOPE_INVALID', message: 'Executor accepts only enabled automatic USDT-M testnet configuration' }
  }
  return { ok: true }
}

function isWithin(target, root) {
  const relative = path.relative(root, target)
  return relative === '' || (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertNoSymlink(target) {
  let cursor = target
  while (true) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) fail('EXECUTOR_PATH_SYMLINK', 'Executor paths may not be symbolic links')
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return target
}

function createPathPolicy(options = {}) {
  const allowUnsafe = options.testOnlyAllowUnsafePaths === true || Boolean(options.runtimeRoot)
  const explicitRoot = options.runtimeRoot ? path.resolve(String(options.runtimeRoot)) : null
  if (explicitRoot && !allowUnsafe) assertNoSymlink(explicitRoot)
  const roots = explicitRoot ? [explicitRoot] : [DATA_RUNTIME_ROOT, DATA_TESTNET_ROOT]
  const defaultRuntimeRoot = explicitRoot || DATA_RUNTIME_ROOT
  for (const root of roots) {
    try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }) } catch {}
    if (!allowUnsafe) assertNoSymlink(root)
  }
  function resolve(value, fallback, label, extraRoots = []) {
    const raw = String(value || fallback || '').trim()
    if (!raw || raw.includes('\u0000')) fail('EXECUTOR_PATH_INVALID', `${label} path is invalid`)
    const target = path.resolve(raw)
    if (!allowUnsafe) assertNoSymlink(target)
    if (!allowUnsafe && !explicitRoot && ![...roots, ...extraRoots].some((root) => isWithin(target, root))) fail('EXECUTOR_PATH_OUTSIDE_RUNTIME', `${label} path must stay inside the repository runtime data roots`)
    if (explicitRoot && !isWithin(target, explicitRoot)) fail('EXECUTOR_PATH_OUTSIDE_RUNTIME', `${label} path must stay inside runtimeRoot`)
    return target
  }
  function resolveKill(value, venue) {
    const fallback = explicitRoot ? path.join(defaultRuntimeRoot, `${venue}_KILL`) : DEFAULT_KILL_SWITCH[venue]
    const fixed = [DEFAULT_KILL_SWITCH[venue]]
    return resolve(value, fallback, 'kill switch', fixed)
  }
  function resolveLedger(value, venue) {
    return resolve(value, explicitRoot ? path.join(defaultRuntimeRoot, `${venue}_order_ledger.json`) : ledgerPathForVenue(venue), 'ledger')
  }
  return Object.freeze({
    allowUnsafe,
    explicitRoot,
    roots: Object.freeze([...roots]),
    resolve,
    resolveKill,
    resolveLedger,
    resolveSocket(value) { return resolve(value, path.join(defaultRuntimeRoot, `${options.venue || 'gate'}.sock`), 'socket') }
  })
}

async function readSafety(options, venue) {
  let custom = {}
  try {
    if (typeof options.getSafetyState === 'function') custom = await options.getSafetyState() || {}
    else if (options.safetyState && typeof options.safetyState === 'object') custom = options.safetyState
  } catch (error) {
    return { error: safeError(error, 'Safety state unavailable') }
  }
  let killSwitch = custom.kill_switch === true || custom.killSwitch === true || options.killSwitch === true
  let stickyRed = custom.sticky_red === true || custom.stickyRed === true || options.stickyRed === true
  const killSwitchPath = options.killSwitchPath
  try { killSwitch ||= fs.existsSync(killSwitchPath) } catch { killSwitch = true }
  if (options.ledgerPath) {
    try {
      const ledger = readLedger(options.ledgerPath)
      stickyRed ||= unresolvedRedCauses(ledger).length > 0
    } catch (error) {
      return { error: safeError(error, 'Ledger safety state unavailable') }
    }
  }
  return { kill_switch: killSwitch, sticky_red: stickyRed, kill_switch_path: killSwitchPath }
}

function resultOutcomes(result) {
  if (typeof result === 'string') return [result.trim().toUpperCase()].filter(Boolean)
  if (!result || typeof result !== 'object') return []
  return ['outcome', 'phase', 'status']
    .map((key) => String(result[key] || '').trim().toUpperCase())
    .filter(Boolean)
}

function resultOutcome(result) {
  return resultOutcomes(result)[0] || ''
}

function hasAmbiguousMarker(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return /AMBIGUOUS(?:[_\s-]|\b)|UNKNOWN(?:[_\s-]?(?:STATE|SUBMISSION))|SUBMISSION_UNKNOWN|STICKY(?:[_\s-]|\b)/i.test(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  return Object.entries(value).some(([key, child]) => {
    if (/^(?:ambiguous|sticky|unknown[_\s-]?(?:state|submission))$/i.test(key) && child === true) return true
    return hasAmbiguousMarker(child, seen)
  })
}

function wrapClient(client, marker) {
  if (!client || typeof client !== 'object') fail('EXECUTOR_CLIENT_INVALID', 'A testnet client is required for execution')
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || !MUTATION_METHODS.has(String(property))) return value
      return (...args) => Promise.resolve().then(() => value.apply(target, args)).catch((error) => {
        if (error?.ambiguous === true || /ambiguous|unknown(?:[_\s-]?(?:state|submission))|timeout|network|socket|reset/i.test(String(error?.code || error?.message || ''))) marker.ambiguous = true
        throw error
      })
    }
  })
}

function planRecord(plan) {
  return {
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    venue: plan.venue,
    product: plan.product,
    environment: plan.environment,
    created_at: plan.created_at,
    expires_at: plan.expires_at,
    sealed: plan.sealed === true,
    plan
  }
}

function lookupPlan(state, request) {
  const ref = request.plan_ref ? String(request.plan_ref) : null
  const planHash = request.plan_hash ? String(request.plan_hash) : null
  const planId = request.plan_id ? String(request.plan_id) : null
  const keys = [ref, planHash].filter(Boolean)
  for (const key of keys) {
    if (state.plans[key]?.plan) return state.plans[key].plan
  }
  const records = Object.values(state.plans)
  const found = records.find((record) => record?.plan && (!planId || record.plan.plan_id === planId) && (!planHash || record.plan.plan_hash === planHash) && (!ref || record.plan.plan_hash === ref || record.plan.plan_id === ref))
  return found?.plan || null
}

function planSummary(plan) {
  return {
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    venue: plan.venue,
    product: plan.product,
    environment: plan.environment,
    created_at: plan.created_at,
    expires_at: plan.expires_at,
    sealed: plan.sealed === true
  }
}

function strictPlanDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('EXECUTOR_PLAN_DATE_INVALID', 'plan date must be YYYY-MM-DD')
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) fail('EXECUTOR_PLAN_DATE_INVALID', 'plan date must be a real UTC calendar date')
  return value
}

function strictPlanIsoWeek(value) {
  if (typeof value !== 'string' || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(value)) fail('EXECUTOR_PLAN_WEEK_INVALID', 'plan iso_week must be YYYY-Www')
  return value
}

function boundedSummaryValue(value, limit = 256) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  return safeText(value, limit)
}

function summaryBlockers(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 32).map((item) => {
    if (typeof item === 'string') return safeText(item, 256)
    if (!item || typeof item !== 'object' || Array.isArray(item)) return safeText(item, 256)
    return {
      code: boundedSummaryValue(item.code, 120),
      message: boundedSummaryValue(item.message, 256),
      symbol: boundedSummaryValue(item.symbol, 40)
    }
  })
}

const RISK_PRODUCT_FIELDS = Object.freeze([
  'enabled', 'environment', 'risk_per_trade_bps', 'max_order_notional_usdt',
  'daily_new_notional_cap_usdt', 'max_managed_notional_usdt', 'configured_leverage',
  'max_leverage', 'position_mode', 'margin_type', 'risk_capital_fraction_bps', 'balance_buffer_bps'
])
const RISK_CONTROL_FIELDS = Object.freeze([
  'gate_enabled', 'submission_mode', 'plan_ttl_seconds', 'quote_max_age_seconds',
  'account_max_age_seconds', 'rules_max_age_seconds', 'reconciliation_max_age_seconds',
  'entry_watch_seconds', 'poll_interval_ms', 'weekly_anchor_max_age_days',
  'candidate_max_age_seconds', 'minimum_rr'
])

function projectRiskPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null
  const project = (source, fields) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
    return Object.fromEntries(fields
      .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
      .map((key) => [key, boundedSummaryValue(source[key], 120)]))
  }
  const product = project(policy.product, RISK_PRODUCT_FIELDS)
  const controls = project(policy.controls, RISK_CONTROL_FIELDS)
  if (!Object.keys(product).length && !Object.keys(controls).length) return null
  return { product, controls }
}

function configRiskPolicy(config, venue) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  try {
    const mapped = venue === 'binance' ? executionConfigForVenue(config, venue) : config
    const product = mapped.gate?.usdm
    const gate = mapped.gate
    const analysis = mapped.analysis || {}
    if (!product || !gate) return null
    return projectRiskPolicy({
      product,
      controls: {
        gate_enabled: gate.enabled,
        submission_mode: gate.submission_mode,
        plan_ttl_seconds: gate.plan_ttl_seconds,
        quote_max_age_seconds: gate.quote_max_age_seconds,
        account_max_age_seconds: gate.account_max_age_seconds,
        rules_max_age_seconds: gate.rules_max_age_seconds,
        reconciliation_max_age_seconds: gate.reconciliation_max_age_seconds,
        entry_watch_seconds: gate.entry_watch_seconds,
        poll_interval_ms: gate.poll_interval_ms,
        weekly_anchor_max_age_days: analysis.weekly_anchor_max_age_days,
        candidate_max_age_seconds: analysis.candidate_max_age_seconds,
        minimum_rr: analysis.minimum_rr
      }
    })
  } catch {
    return null
  }
}

function projectIntentSummary(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null
  const protection = intent.protection && typeof intent.protection === 'object' && !Array.isArray(intent.protection)
    ? {
        required: intent.protection.required === true,
        stop_price: boundedSummaryValue(intent.protection.stop_price, 80),
        target_price: boundedSummaryValue(intent.protection.target_price, 80),
        direction: boundedSummaryValue(intent.protection.direction, 32)
      }
    : { required: false, stop_price: null, target_price: null, direction: null }
  return {
    symbol: boundedSummaryValue(intent.symbol, 40),
    side: boundedSummaryValue(intent.side, 16),
    action: boundedSummaryValue(intent.action, 32),
    size: boundedSummaryValue(intent.size ?? intent.quantity ?? intent.contracts, 80),
    notional: boundedSummaryValue(intent.estimated_notional ?? intent.notional, 80),
    protection
  }
}

function detailedPlanSummary(plan, result = {}, outcome = undefined) {
  const source = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : result
  const intents = Array.isArray(plan?.intents) ? plan.intents.slice(0, 2).map(projectIntentSummary).filter(Boolean) : []
  const blockers = summaryBlockers(result.blockers ?? plan?.blockers)
  return {
    plan_id: boundedSummaryValue(source?.plan_id, 160),
    plan_hash: boundedSummaryValue(source?.plan_hash, 160),
    venue: boundedSummaryValue(source?.venue ?? result.venue, 32),
    product: boundedSummaryValue(source?.product ?? result.product, 32),
    environment: boundedSummaryValue(source?.environment ?? result.environment, 32),
    created_at: boundedSummaryValue(source?.created_at, 64),
    expires_at: boundedSummaryValue(source?.expires_at, 64),
    sealed: source?.sealed === true,
    blockers,
    intents,
    risk_policy: projectRiskPolicy(source?.risk_policy ?? result.risk_policy),
    risk_policy_digest: boundedSummaryValue(source?.risk_policy_digest ?? result.risk_policy_digest, 160),
    ...(outcome ? { outcome } : {})
  }
}

function storedPlanSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return detailedPlanSummary(value, value, value.outcome)
}

function storedPlanResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const summary = storedPlanSummary(value.plan_summary)
  if (!summary || !['READY', 'NO_ACTION', 'BLOCKED'].includes(String(value.outcome || '').toUpperCase())) return null
  const outcome = String(value.outcome).toUpperCase()
  return {
    ok: value.ok === true && outcome !== 'BLOCKED',
    outcome,
    venue: boundedSummaryValue(value.venue, 32),
    product: boundedSummaryValue(value.product, 32),
    environment: boundedSummaryValue(value.environment, 32),
    plan_summary: summary,
    blockers: summary.blockers,
    submitted: 0,
    filled: 0,
    ...(value.ok === false && value.code ? { code: boundedSummaryValue(value.code, 120), message: boundedSummaryValue(value.message, 256) } : {})
  }
}

function validateCachedReady(state, cached, venue, current, sourceDigest, date, isoWeek) {
  const summary = cached?.plan_summary
  const planHash = summary?.plan_hash
  const planId = summary?.plan_id
  const record = planHash && state?.plans?.[planHash]
  const plan = record?.plan
  if (!record || !plan || record.plan_hash !== planHash || record.plan_id !== planId || plan.plan_hash !== planHash || plan.plan_id !== planId) return { kind: 'invalid' }
  if (plan.venue !== venue || plan.product !== 'usdm' || plan.environment !== 'testnet' || plan.source?.date !== date || plan.source?.iso_week !== isoWeek || plan.daily_source_proof?.digest !== sourceDigest) return { kind: 'invalid' }
  let verified
  try {
    verified = verifyPlan(plan, { planId, planHash, now: () => current })
  } catch {
    return { kind: 'invalid' }
  }
  if (!verified.ok) return { kind: verified.code === 'PLAN_EXPIRED' ? 'expired' : 'invalid' }
  const refreshedSummary = detailedPlanSummary(plan, { blockers: plan.blockers }, 'READY')
  return {
    kind: 'valid',
    response: {
      ...cached,
      plan_summary: refreshedSummary,
      blockers: refreshedSummary.blockers
    }
  }
}

function validatePlanGenerationResult(result, venue, current, sourceDigest, date, isoWeek) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return blocked('EXECUTOR_PLAN_RESULT_INVALID', 'Planner must return one structured result', { venue })
  const outcomes = resultOutcomes(result)
  const outcome = outcomes[0] || ''
  if (!['READY', 'NO_ACTION', 'BLOCKED'].includes(outcome)) return blocked('EXECUTOR_PLAN_OUTCOME_INVALID', 'Planner outcome must be READY, NO_ACTION, or BLOCKED', { venue })
  const declaredStates = outcomes.filter((value) => ['READY', 'NO_ACTION', 'BLOCKED'].includes(value))
  if (new Set(declaredStates).size > 1) return blocked('EXECUTOR_PLAN_OUTCOME_INVALID', 'Planner result contains conflicting plan outcomes', { venue })
  if (outcomes.some((value) => ['COMPLETE', 'FAILED', 'RECONCILE_RED'].includes(value))) return blocked('EXECUTOR_PLAN_OUTCOME_INVALID', 'Planner result contains a conflicting lifecycle outcome', { venue })
  if (result.venue !== venue || result.product !== 'usdm' || result.environment !== 'testnet') return blocked('EXECUTOR_PLAN_SCOPE_INVALID', 'Planner result scope must be this USDT-M testnet venue', { venue })
  const isZero = (value) => value === 0 || value === '0'
  if (!Object.prototype.hasOwnProperty.call(result, 'submitted') || !Object.prototype.hasOwnProperty.call(result, 'filled') || !isZero(result.submitted) || !isZero(result.filled)) return blocked('EXECUTOR_PLAN_MUTATION_REPORTED', 'Planning must report submitted=0 and filled=0', { venue })
  const plan = result.plan
  if (plan !== undefined && (plan === null || typeof plan !== 'object' || Array.isArray(plan))) return blocked('EXECUTOR_PLAN_RESULT_INVALID', 'Planner plan must be an object when present', { venue })
  if (plan) {
    try { inspectValue(plan, '$.plan') } catch (error) { return blocked(error.code || 'EXECUTOR_PLAN_RESULT_INVALID', error.message, { venue }) }
    if (plan.venue !== venue || plan.product !== 'usdm' || plan.environment !== 'testnet') return blocked('EXECUTOR_PLAN_SCOPE_INVALID', 'Sealed planner plan scope is invalid', { venue })
    if (plan.sealed !== true) return blocked('EXECUTOR_PLAN_UNSEALED', 'Planner returned an unsealed plan', { venue })
    if (plan.source?.date !== date || plan.source?.iso_week !== isoWeek) return blocked('EXECUTOR_PLAN_SOURCE_MISMATCH', 'Planner plan date/week does not match the requested canonical daily source', { venue })
    if (!plan.daily_source_proof || plan.daily_source_proof.digest !== sourceDigest) return blocked('EXECUTOR_PLAN_SOURCE_MISMATCH', 'Planner plan must bind the exact canonical daily source digest', { venue })
    const verified = verifyPlan(plan, {
      planId: plan.plan_id,
      planHash: plan.plan_hash,
      allowExpired: outcome !== 'READY',
      skipCurrentTime: outcome !== 'READY',
      now: () => current
    })
    if (!verified.ok) return blocked(`EXECUTOR_${verified.code}`, verified.message, { venue })
    if (outcome === 'READY' && (plan.status !== 'READY' || !Array.isArray(plan.intents) || plan.intents.length === 0 || (plan.blockers || []).length)) return blocked('EXECUTOR_PLAN_NOT_READY', 'READY planner output must contain a blocker-free executable plan', { venue })
  } else if (outcome === 'READY') {
    return blocked('EXECUTOR_PLAN_REQUIRED', 'READY planner output must include a sealed plan', { venue })
  }
  const summary = detailedPlanSummary(plan, result, outcome)
  if (outcome === 'READY' && (!summary.plan_id || !summary.plan_hash || summary.sealed !== true)) return blocked('EXECUTOR_PLAN_SUMMARY_INVALID', 'READY planner output lacks sealed plan identity', { venue })
  return { ok: true, outcome, plan: outcome === 'READY' ? plan : null, summary }
}

function publicArm(receipt) {
  if (!receipt) return null
  return {
    schema: receipt.schema,
    nonce: receipt.nonce,
    venue: receipt.venue,
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
    risk_digest: receipt.risk_digest,
    config_digest: receipt.config_digest,
    policy_digest: receipt.policy_digest,
    hash_seal: receipt.hash_seal
  }
}

function publicAmbiguousLock(lock) {
  if (!lock) return null
  const { claim_token: _claimToken, ...publicLock } = lock
  return publicLock
}

function greenReconciliationReceipt(result, venue) {
  const receipt = sealedReconciliationReceipt(result, venue)
  if (!receipt || receipt.status !== 'ok' || receipt.issues.length !== 0) return null
  return receipt
}

async function defaultReconcile(options, venue, current, causeIds) {
  const adapter = options.adapter || options.fakeAdapter
  const injected = options.client || adapter?.client || (adapter && typeof adapter.usdmAccount === 'function' ? adapter : null)
  const client = injected || (venue === 'gate'
    ? createGateClient({ product: 'usdm', environment: 'testnet', readOnly: true })
    : createBinanceClient({ environment: 'testnet', readOnly: true }))
  const result = await Promise.all([
    client.usdmAccount(),
    client.usdmPositions(),
    client.usdmOrders({ status: 'open', limit: 100 }),
    client.usdmPriceOrders({ status: 'open', limit: 100 }),
    client.usdmTrades({ contract: 'BTC_USDT', limit: 100 }),
    client.usdmTrades({ contract: 'ETH_USDT', limit: 100 })
  ])
  const [account, positions, orders, protections, btcTrades, ethTrades] = result
  const ledger = readLedger(options.ledgerPath || ledgerPathForVenue(venue))
  const receipt = reconcileSnapshot({
    generated_at: iso(current),
    account: account?.data,
    positions: Array.isArray(positions?.data) ? positions.data : [],
    open_orders: Array.isArray(orders?.data) ? orders.data : [],
    protections: Array.isArray(protections?.data) ? protections.data : [],
    trades: [
      ...(Array.isArray(btcTrades?.data) ? btcTrades.data : []),
      ...(Array.isArray(ethTrades?.data) ? ethTrades.data : [])
    ]
  }, ledger, { now: () => current, requestedCauseIds: causeIds })
  return { venue, receipt }
}

function planningClientView(client) {
  if (!client || typeof client !== 'object') fail('EXECUTOR_PLANNING_CLIENT_INVALID', 'A planning client is required')
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || !MUTATION_METHODS.has(String(property))) return value
      return () => { throw new ExecutorError('EXECUTOR_PLANNING_MUTATION_FORBIDDEN', 'Planning clients cannot submit or cancel orders') }
    },
    set() { throw new ExecutorError('EXECUTOR_PLANNING_MUTATION_FORBIDDEN', 'Planning clients are read-only') },
    deleteProperty() { throw new ExecutorError('EXECUTOR_PLANNING_MUTATION_FORBIDDEN', 'Planning clients are read-only') },
    defineProperty() { throw new ExecutorError('EXECUTOR_PLANNING_MUTATION_FORBIDDEN', 'Planning clients are read-only') }
  })
}

function sealedReconciliationReceipt(result, venue) {
  const receipt = result?.receipt || result?.reconciliation || result
  if (!receipt || receipt.product !== 'usdm' || receipt.environment !== 'testnet' || receipt.sealed !== true || !Array.isArray(receipt.issues)) return null
  try {
    const verified = verifyReconciliationReceipt(receipt)
    if (!verified.ok) return null
  } catch {
    return null
  }
  if (result?.venue && result.venue !== venue) return null
  return receipt
}

function persistReconciliation(options, venue, receipt) {
  const ledgerPath = options.ledgerPath || ledgerPathForVenue(venue)
  const ledger = updateJsonLocked(ledgerPath, (current) => reduceLedger(current || EMPTY_LEDGER, { kind: 'RECONCILIATION', reconciliation: receipt }), { missingDefault: EMPTY_LEDGER })
  return { ledger, ledger_path: ledgerPath, unresolved_red_causes: unresolvedRedCauses(ledger) }
}

function blocked(code, message, extra = {}) {
  return { ok: false, code, message: safeText(message || code), ...extra }
}

export function createTestnetExecutor(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('EXECUTOR_OPTIONS_INVALID', 'Executor options must be an object')
  const venue = venueName(options.venue)
  const pathPolicy = createPathPolicy({ ...options, venue })
  const runtimeRoot = pathPolicy.explicitRoot || DATA_RUNTIME_ROOT
  const statePath = pathPolicy.resolve(options.statePath, path.join(runtimeRoot, `${venue}_testnet_executor.json`), 'state')
  const cycleStatePath = pathPolicy.resolve(options.cycleStatePath, path.join(path.dirname(statePath), 'testnet_active_cycle.json'), 'cycle')
  const ledgerPath = pathPolicy.resolveLedger(options.ledgerPath, venue)
  const killSwitchPath = pathPolicy.resolveKill(options.killSwitchPath, venue)
  options = { ...options, ledgerPath, killSwitchPath }
  const clock = options.now || Date.now
  const lockOptions = options.lockOptions || {}
  let cachedClient = null
  let cachedPlanningClient = null

  function loadState() {
    return cloneState(readJsonStrict(statePath, { missingDefault: defaultState(venue) }), venue)
  }

  function clientForExecution() {
    if (cachedClient) return cachedClient
    if (options.client) {
      cachedClient = options.client
      return cachedClient
    }
    const adapter = options.adapter || options.fakeAdapter
    if (adapter?.client && typeof adapter.client === 'object') {
      cachedClient = adapter.client
      return cachedClient
    }
    if (adapter && typeof adapter === 'object' && (typeof adapter.usdmPlaceOrder === 'function' || typeof adapter.usdmContract === 'function')) {
      cachedClient = adapter
      return cachedClient
    }
    // Client construction and therefore credential lookup stay inside this
    // executor process. No browser/API request can supply routing or secrets.
    cachedClient = venue === 'gate'
      ? createGateClient({ product: 'usdm', environment: 'testnet', readOnly: false })
      : createBinanceClient({ environment: 'testnet', readOnly: false })
    return cachedClient
  }

  function clientForPlanning() {
    if (cachedPlanningClient) return cachedPlanningClient
    const adapter = options.adapter || options.fakeAdapter
    const injected = options.planningClient || options.planClient || adapter?.planningClient || adapter?.client || options.client
    const client = injected || (venue === 'gate'
      ? createGateClient({ product: 'usdm', environment: 'testnet', readOnly: true })
      : createBinanceClient({ environment: 'testnet', readOnly: true }))
    cachedPlanningClient = planningClientView(client)
    return cachedPlanningClient
  }

  async function withState(mutator, optionsForState = {}) {
    return serializeStatePath(statePath, () => withFileLockAsync(statePath, async () => {
      const state = loadState()
      let current
      try { current = finiteNow(clock) } catch (error) {
        if (optionsForState.allowClockFault) {
          const result = await mutator(state, null, { clockError: safeError(error) })
          writeState(statePath, state)
          return result
        }
        state.arm = null
        state.clock_fault = safeError(error, 'Executor clock became invalid')
        writeState(statePath, state)
        return blocked(state.clock_fault.code, state.clock_fault.message, { venue })
      }
      if (state.clock_fault && !optionsForState.allowClockFault) return blocked(state.clock_fault.code, state.clock_fault.message, { venue })
      if (state.last_clock_ms !== null && current < Number(state.last_clock_ms)) {
        state.arm = null
        state.clock_fault = { code: 'EXECUTOR_CLOCK_ROLLBACK', message: 'Executor clock moved backwards', at: iso(current), previous_at: iso(Number(state.last_clock_ms)) }
        writeState(statePath, state)
        if (optionsForState.allowClockFault) {
          const result = await mutator(state, current, { clockError: state.clock_fault })
          writeState(statePath, state)
          return result
        }
        return blocked(state.clock_fault.code, state.clock_fault.message, { venue })
      }
      state.last_clock_ms = current
      const result = await mutator(state, current, {})
      writeState(statePath, state)
      return result
    }, lockOptions))
  }

  async function claimCycle(plan, cycleKey, claimToken, current) {
    const key = String(cycleKey).slice(0, 240)
    return serializeStatePath(cycleStatePath, () => withFileLockAsync(cycleStatePath, async () => {
      const cycleState = readJsonStrict(cycleStatePath, { missingDefault: defaultCycleState() })
      if (!cycleState || cycleState.schema !== CYCLE_SCHEMA || (cycleState.active !== null && (typeof cycleState.active !== 'object' || Array.isArray(cycleState.active)))) return blocked('EXECUTOR_CYCLE_STATE_INVALID', 'Active venue cycle state is invalid', { venue })
      const active = cycleState.active
      if (active && !['running', 'reconcile_required', 'completed', 'reconciled', 'blocked'].includes(active.lifecycle)) return blocked('EXECUTOR_CYCLE_STATE_INVALID', 'Active cycle lifecycle is invalid', { venue })
      const exact = active && active.cycle_key === key && active.venue === venue && active.plan_id === plan.plan_id && active.plan_hash === plan.plan_hash
      if (active && active.cycle_key === key && active.venue !== venue) return blocked('EXECUTOR_CYCLE_VENUE_CONFLICT', 'A different venue is already active for this cycle; automatic failover is forbidden', { venue, active_venue: active.venue })
      if (active && active.lifecycle === 'running') {
        if (active.cycle_key === key && active.venue !== venue) return blocked('EXECUTOR_CYCLE_VENUE_CONFLICT', 'A different venue is already active for this cycle; automatic failover is forbidden', { venue, active_venue: active.venue })
        return blocked(exact ? 'EXECUTOR_CYCLE_RUNNING' : 'EXECUTOR_CYCLE_ORPHANED', 'A running cycle claim cannot be replayed or replaced until it is reconciled', { venue, active_venue: active.venue, active_cycle_key: active.cycle_key })
      }
      if (active && active.lifecycle === 'reconcile_required') return blocked('EXECUTOR_CYCLE_RECONCILE_REQUIRED', 'The active cycle requires GREEN reconciliation before rotation', { venue, active_venue: active.venue, active_cycle_key: active.cycle_key })
      if (active && active.cycle_key === key && !exact) return blocked('EXECUTOR_CYCLE_IDENTITY_MISMATCH', 'Cycle key must match the exact active venue, plan ID, and plan hash', { venue })
      if (active && active.cycle_key === key && exact) return blocked('EXECUTOR_CYCLE_TERMINAL', 'The active cycle is already terminal and cannot be replayed', { venue })
      if (!active || active.cycle_key !== key) {
        cycleState.active = { lifecycle: 'running', cycle_key: key, venue, plan_id: plan.plan_id, plan_hash: plan.plan_hash, claim_token: claimToken, claimed_at: iso(current) }
        writeJsonAtomic(cycleStatePath, cycleState, { mode: 0o600 })
        try { fs.chmodSync(cycleStatePath, 0o600) } catch {}
      }
      return { ok: true, cycle_key: key, venue }
    }, lockOptions))
  }

  async function commitCycle(cycleKey, claimToken, lifecycle, current) {
    return serializeStatePath(cycleStatePath, () => withFileLockAsync(cycleStatePath, async () => {
      const cycleState = readJsonStrict(cycleStatePath, { missingDefault: defaultCycleState() })
      const active = cycleState?.active
      if (!active || active.lifecycle !== 'running' || active.cycle_key !== String(cycleKey) || active.claim_token !== claimToken) return { ok: false, code: 'EXECUTOR_CYCLE_CLAIM_LOST', message: 'Cycle claim changed before terminal commit' }
      cycleState.active = { ...active, lifecycle, completed_at: iso(current) }
      writeJsonAtomic(cycleStatePath, cycleState, { mode: 0o600 })
      try { fs.chmodSync(cycleStatePath, 0o600) } catch {}
      return { ok: true, cycle_key: active.cycle_key, lifecycle }
    }, lockOptions))
  }

  async function reconcileCycle(cycleKey, claimToken, current) {
    return serializeStatePath(cycleStatePath, () => withFileLockAsync(cycleStatePath, async () => {
      const cycleState = readJsonStrict(cycleStatePath, { missingDefault: defaultCycleState() })
      const active = cycleState?.active
      if (!active || active.cycle_key !== String(cycleKey) || active.claim_token !== claimToken) return { ok: false, code: 'EXECUTOR_CYCLE_CLAIM_LOST', message: 'Reconciliation cycle claim changed before terminal commit' }
      // A state commit can fail after this terminal cycle commit.  Treat an
      // exact already-reconciled claim as idempotent so recovery can finish
      // the executor state without ever reopening or replaying the cycle.
      if (active.lifecycle === 'reconciled') return { ok: true, cycle_key: active.cycle_key, lifecycle: 'reconciled' }
      if (!['running', 'reconcile_required'].includes(active.lifecycle)) return { ok: false, code: 'EXECUTOR_CYCLE_CLAIM_LOST', message: 'Reconciliation cycle claim changed before terminal commit' }
      cycleState.active = { ...active, lifecycle: 'reconciled', completed_at: iso(current) }
      writeJsonAtomic(cycleStatePath, cycleState, { mode: 0o600 })
      try { fs.chmodSync(cycleStatePath, 0o600) } catch {}
      return { ok: true, cycle_key: active.cycle_key, lifecycle: 'reconciled' }
    }, lockOptions))
  }

  async function safetyGate(state, current, { requireArm = false, allowSafety = false } = {}) {
    const safety = await readSafety(options, venue)
    if (safety.error) {
      state.arm = null
      return blocked(safety.error.code, safety.error.message, { venue })
    }
    const scope = configScope(options.config, venue)
    if (!scope.ok && !allowSafety) {
      state.arm = null
      return blocked(scope.code, scope.message, { venue })
    }
    if (safety.kill_switch || safety.sticky_red) {
      state.arm = null
      state.disarm_reason = safety.kill_switch ? 'KILL_SWITCH' : 'STICKY_RECONCILE_RED'
      return blocked(safety.kill_switch ? 'EXECUTOR_KILL_SWITCH' : 'EXECUTOR_STICKY_RED', safety.kill_switch ? 'Kill switch blocks executor mutations' : 'Sticky reconciliation red blocks executor mutations', { venue, kill_switch: safety.kill_switch, sticky_red: safety.sticky_red })
    }
    if (requireArm) {
      if (!state.arm) return blocked('EXECUTOR_NOT_ARMED', 'Executor requires an active 24-hour arm receipt', { venue })
      if (!verifyArm(state.arm, venue)) {
        state.arm = null
        state.disarm_reason = 'ARM_SEAL_INVALID'
        return blocked('EXECUTOR_ARM_INVALID', 'Arm receipt seal or exact lifetime is invalid', { venue })
      }
      if (current >= Date.parse(state.arm.expires_at)) {
        state.arm = null
        state.disarm_reason = 'ARM_EXPIRED'
        return blocked('EXECUTOR_ARM_EXPIRED', 'Arm receipt has expired', { venue })
      }
      const digests = digestInput(options, venue)
      if (digestDifference(state.arm, digests)) {
        state.arm = null
        state.disarm_reason = 'DIGEST_DRIFT'
        return blocked('EXECUTOR_DIGEST_DRIFT', 'Venue, risk, configuration, or policy digest changed after arming', { venue })
      }
    }
    return { ok: true, safety }
  }

  async function status() {
    return withState(async (state, current, fault) => {
      if (fault?.clockError) return blocked(fault.clockError.code, fault.clockError.message, { venue })
      const safety = await readSafety(options, venue)
      if (safety.error) {
        state.arm = null
        state.disarm_reason = safety.error.code
        return blocked(safety.error.code, safety.error.message, { venue })
      }
      if (state.arm && (!verifyArm(state.arm, venue) || current >= Date.parse(state.arm.expires_at))) {
        const expired = verifyArm(state.arm, venue) && current >= Date.parse(state.arm.expires_at)
        state.arm = null
        state.disarm_reason = expired ? 'ARM_EXPIRED' : 'ARM_SEAL_INVALID'
      }
      if (state.arm && digestDifference(state.arm, digestInput(options, venue))) {
        state.arm = null
        state.disarm_reason = 'DIGEST_DRIFT'
      }
      if (safety.kill_switch || safety.sticky_red) {
        state.arm = null
        state.disarm_reason = safety.kill_switch ? 'KILL_SWITCH' : 'STICKY_RECONCILE_RED'
      }
      return {
        ok: true,
        outcome: 'STATUS',
        venue,
        environment: 'testnet',
        armed: state.arm !== null,
        arm: publicArm(state.arm),
        disarm_reason: state.disarm_reason,
        clock_fault: state.clock_fault,
        locked: state.ambiguous_lock !== null,
        ambiguous_lock: publicAmbiguousLock(state.ambiguous_lock),
        // The recovery token is intentionally available only in the 0600
        // state file to an operator.  It must never cross the executor API,
        // including the otherwise harmless status projection.
        reconcile_claim: state.reconcile ? { lifecycle: state.reconcile.lifecycle, plan_id: state.reconcile.plan_id || null, plan_hash: state.reconcile.plan_hash || null, started_at: state.reconcile.started_at || null } : null,
        latest_plan_summary: storedPlanSummary(state.latest_plan_summary),
        plans: Object.keys(state.plans).length,
        executions: Object.keys(state.executions).length,
        kill_switch: safety.kill_switch,
        sticky_red: safety.sticky_red
      }
    })
  }

  async function arm(request) {
    const fields = digestInput(options, venue)
    for (const [key, value] of Object.entries({
      risk_digest: request.risk_digest ?? fields.risk_digest,
      config_digest: request.config_digest ?? fields.config_digest,
      policy_digest: request.policy_digest ?? fields.policy_digest
    })) {
      if (!value) return blocked('EXECUTOR_DIGESTS_REQUIRED', 'Arming requires risk, configuration, and policy digests', { venue })
      normalizeDigest(value, key)
    }
    return withState(async (state, current, fault) => {
      if (fault?.clockError) return blocked(fault.clockError.code, fault.clockError.message, { venue })
      const safety = await safetyGate(state, current)
      if (!safety.ok) return safety
      const currentDigests = digestInput(options, venue)
      const requested = {
        risk_digest: normalizeDigest(request.risk_digest ?? currentDigests.risk_digest, 'risk_digest'),
        config_digest: normalizeDigest(request.config_digest ?? currentDigests.config_digest, 'config_digest'),
        policy_digest: normalizeDigest(request.policy_digest ?? currentDigests.policy_digest, 'policy_digest')
      }
      if (Object.values(requested).some((value) => !value)) return blocked('EXECUTOR_DIGESTS_REQUIRED', 'Arming requires risk, configuration, and policy digests', { venue })
      if (Object.values(currentDigests).some((value) => value === null) || digestDifference(requested, currentDigests)) return blocked('EXECUTOR_DIGEST_MISMATCH', 'Requested arm digests do not match current executor configuration', { venue })
      if (state.arm) {
        if (!verifyArm(state.arm, venue)) {
          state.arm = null
          state.disarm_reason = 'ARM_SEAL_INVALID'
        } else if (digestDifference(state.arm, currentDigests)) {
          state.arm = null
          state.disarm_reason = 'DIGEST_DRIFT'
          return blocked('EXECUTOR_DIGEST_DRIFT', 'Venue, risk, configuration, or policy digest changed after arming', { venue })
        } else if (current < Date.parse(state.arm.expires_at)) {
          if (stableStringify(armCore(state.arm)) !== stableStringify({ ...armCore(state.arm), ...requested })) return blocked('EXECUTOR_ALREADY_ARMED', 'Active arm receipt cannot be renewed or changed', { venue })
          return { ok: true, outcome: 'ARMED', venue, receipt: publicArm(state.arm), renewed: false }
        } else {
          state.arm = null
          state.disarm_reason = 'ARM_EXPIRED'
        }
      }
      const issued = iso(current)
      const receipt = {
        schema: 'tyche_testnet_arm/v1',
        nonce: randomUUID(),
        venue,
        issued_at: issued,
        expires_at: iso(current + ARM_TTL_MS),
        ...requested
      }
      receipt.hash_seal = sealArm(receipt)
      state.arm = receipt
      state.disarm_reason = null
      return { ok: true, outcome: 'ARMED', venue, receipt: publicArm(receipt), renewed: true }
    })
  }

  async function disarm(request) {
    return withState(async (state) => {
      state.arm = null
      state.disarm_reason = request.reason ? safeText(request.reason, 100) : 'MANUAL_DISARM'
      return { ok: true, outcome: 'DISARMED', venue, arm: null, reason: state.disarm_reason }
    }, { allowClockFault: true })
  }

  async function registerPlan(request) {
    return withState(async (state, current, fault) => {
      if (fault?.clockError) return blocked(fault.clockError.code, fault.clockError.message, { venue })
      const safety = await safetyGate(state, current)
      if (!safety.ok) return safety
      let plan = request.plan
      if (!plan && request.plan_ref) plan = lookupPlan(state, request)
      if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return blocked('EXECUTOR_PLAN_REQUIRED', 'plan accepts only sealed plan content or a previously registered plan reference', { venue })
      inspectValue(plan, '$.plan')
      const verified = verifyPlan(plan, { planId: plan.plan_id, planHash: plan.plan_hash, now: () => current })
      if (!verified.ok) return blocked(verified.code, verified.message, { venue })
      if (plan.venue !== venue) return blocked('EXECUTOR_PLAN_VENUE_MISMATCH', 'Sealed plan venue does not match this executor', { venue })
      if (plan.product !== 'usdm' || plan.environment !== 'testnet') return blocked('EXECUTOR_TESTNET_SCOPE_INVALID', 'Executor accepts only USDT-M testnet plans', { venue })
      if (plan.status !== 'READY' || !Array.isArray(plan.intents) || plan.intents.length === 0 || (plan.blockers || []).length) return blocked('EXECUTOR_PLAN_BLOCKED', 'Only a blocker-free READY sealed plan may be registered', { venue })
      const summary = detailedPlanSummary(plan, { blockers: plan.blockers }, plan.status)
      const existing = state.plans[plan.plan_hash]
      if (existing) {
        state.latest_plan_summary = summary
        return { ok: true, outcome: 'PLAN_REGISTERED', duplicate: true, venue, plan_ref: plan.plan_hash, plan: planSummary(plan), plan_summary: summary }
      }
      const conflicting = Object.values(state.plans).find((record) => record?.plan_id === plan.plan_id && record?.plan_hash !== plan.plan_hash)
      if (conflicting) return blocked('EXECUTOR_PLAN_ID_CONFLICT', 'Plan ID is already registered with another hash', { venue })
      state.plans[plan.plan_hash] = planRecord(plan)
      state.latest_plan_summary = summary
      return { ok: true, outcome: 'PLAN_REGISTERED', duplicate: false, venue, plan_ref: plan.plan_hash, plan: planSummary(plan), plan_summary: summary }
    })
  }

  function planningPaths() {
    const canonicalDataRoot = pathPolicy.explicitRoot || path.join(ROOT, 'data')
    const paths = {
      sourcePath: path.join(canonicalDataRoot, 'crypto_daily.json'),
      weeklyPath: path.join(canonicalDataRoot, 'crypto_strategy.json'),
      marketPath: path.join(canonicalDataRoot, 'crypto_market.json'),
      ledgerPath: options.ledgerPath,
      killPath: options.killSwitchPath
    }
    if (!pathPolicy.allowUnsafe) for (const target of Object.values(paths)) assertNoSymlink(target)
    return paths
  }

  function readCanonicalDailySource(paths, date, isoWeek) {
    const injected = options.testDailySource
    const source = pathPolicy.allowUnsafe && injected !== undefined
      ? structuredClone(injected)
      : readJsonStrict(paths.sourcePath)
    if (!source || typeof source !== 'object' || Array.isArray(source) || source.schema !== 'tyche_crypto_daily/v1' || source.date !== date || source.iso_week !== isoWeek) fail('EXECUTOR_PLAN_SOURCE_MISMATCH', 'Canonical daily source schema/date/week does not match the request')
    return { source, digest: sha256Hex(source) }
  }

  function planningResponse(validation, fallbackResult = {}) {
    const summary = validation.summary || detailedPlanSummary(null, {
      venue,
      product: 'usdm',
      environment: 'testnet',
      blockers: [{ code: validation.code || 'EXECUTOR_PLAN_FAILED', message: validation.message || 'Planner failed' }],
      ...fallbackResult
    }, 'BLOCKED')
    if (!summary.risk_policy) {
      const policy = configRiskPolicy(options.config, venue)
      if (policy) {
        summary.risk_policy = policy
        if (!summary.risk_policy_digest) summary.risk_policy_digest = sha256Hex(policy)
      }
    }
    const outcome = validation.ok ? validation.outcome : 'BLOCKED'
    return {
      ok: validation.ok && outcome !== 'BLOCKED',
      outcome,
      venue,
      product: 'usdm',
      environment: 'testnet',
      plan_summary: summary,
      blockers: summary.blockers,
      submitted: 0,
      filled: 0,
      ...(validation.ok ? {} : { code: validation.code || 'EXECUTOR_PLAN_FAILED', message: validation.message || 'Planner failed' })
    }
  }

  async function generatePlan(request) {
    const date = strictPlanDate(request.date)
    const isoWeek = strictPlanIsoWeek(request.iso_week)
    const paths = planningPaths()
    return serializePlanPath(`${statePath}:${date}:${isoWeek}`, async () => {
      const preflight = await withState(async (state, current, fault) => {
        if (fault?.clockError) return blocked(fault.clockError.code, fault.clockError.message, { venue })
        if (!options.config) return blocked('EXECUTOR_CONFIG_REQUIRED', 'Internal planning requires the executor configuration', { venue })
        return safetyGate(state, current)
      })
      if (!preflight.ok) return preflight
      let initialSource
      try {
        initialSource = readCanonicalDailySource(paths, date, isoWeek)
      } catch (error) {
        return planningResponse(blocked(error?.code || 'EXECUTOR_PLAN_SOURCE_UNAVAILABLE', safeText(error?.message || error), { venue }))
      }
      const requestKey = `${date}:${isoWeek}:${initialSource.digest}`
      const prepared = await withState(async (state, current, fault) => {
        if (fault?.clockError) return blocked(fault.clockError.code, fault.clockError.message, { venue })
        if (!options.config) return blocked('EXECUTOR_CONFIG_REQUIRED', 'Internal planning requires the executor configuration', { venue })
        const safety = await safetyGate(state, current)
        if (!safety.ok) return safety
        const existing = state.plan_runs?.[requestKey]
        if (existing !== undefined) {
          const cached = storedPlanResponse(existing.response)
          if (!cached) return blocked('EXECUTOR_PLAN_STATE_INVALID', 'Persisted plan result is invalid', { venue })
          if (cached.outcome === 'NO_ACTION') return { ok: true, cached }
          if (cached.outcome === 'READY') {
            const ready = validateCachedReady(state, cached, venue, current, initialSource.digest, date, isoWeek)
            if (ready.kind === 'valid') return { ok: true, cached: ready.response }
            if (ready.kind === 'invalid') return blocked('EXECUTOR_PLAN_STATE_INVALID', 'Persisted READY plan evidence is invalid', { venue })
            // A valid sealed plan may expire without invalidating the source
            // cache key.  Drop only that expired cache so a fresh read-only
            // planner call can create a new sealed plan for the same source.
            delete state.plan_runs[requestKey]
            if (state.latest_plan_summary?.plan_hash === cached.plan_summary.plan_hash) state.latest_plan_summary = null
          }
          // BLOCKED and transient failures are deliberately not day-wide
          // cache entries.  Drop an older incompatible entry before retrying.
          delete state.plan_runs[requestKey]
        }
        return { ok: true, current, date, isoWeek, requestKey }
      })
      if (!prepared.ok) return prepared
      if (prepared.cached) return { ...prepared.cached, duplicate: true }

      let validation
      let rawResult = {}
      try {
        const planningInput = {
          venue,
          config: structuredClone(options.config),
          date: prepared.date,
          isoWeek: prepared.isoWeek,
          client: clientForPlanning(),
          ...paths,
          daily_source_digest: initialSource.digest,
          now: () => prepared.current
        }
        rawResult = typeof options.planFn === 'function'
          ? await options.planFn(planningInput)
          : await planAutomaticTestnet(planningInput)
        let finalSource
        try {
          finalSource = readCanonicalDailySource(paths, prepared.date, prepared.isoWeek)
        } catch (error) {
          validation = blocked(error?.code || 'EXECUTOR_PLAN_SOURCE_UNAVAILABLE', safeText(error?.message || error), { venue })
          finalSource = null
        }
        if (!validation) {
          if (finalSource.digest !== initialSource.digest) validation = blocked('EXECUTOR_PLAN_SOURCE_CHANGED', 'Canonical daily source changed while planning', { venue })
          else validation = validatePlanGenerationResult(rawResult, venue, prepared.current, initialSource.digest, prepared.date, prepared.isoWeek)
        }
      } catch (error) {
        validation = blocked(error?.code || 'EXECUTOR_PLAN_FAILED', 'Planner failed before producing a trusted plan result', { venue })
      }
      const response = planningResponse(validation, rawResult)
      return withState(async (state, current, fault) => {
        if (fault?.clockError) return blocked(fault.clockError.code, fault.clockError.message, { venue })
        const safety = await safetyGate(state, current)
        if (!safety.ok) return safety
        const existing = state.plan_runs?.[requestKey]
        if (existing !== undefined) {
          const cached = storedPlanResponse(existing.response)
          if (!cached) return blocked('EXECUTOR_PLAN_STATE_INVALID', 'Persisted plan result is invalid', { venue })
          if (cached.outcome === 'NO_ACTION') return { ...cached, duplicate: true }
          if (cached.outcome === 'READY') {
            const ready = validateCachedReady(state, cached, venue, current, initialSource.digest, prepared.date, prepared.isoWeek)
            if (ready.kind === 'valid') return { ...ready.response, duplicate: true }
            if (ready.kind === 'invalid') return blocked('EXECUTOR_PLAN_STATE_INVALID', 'Persisted READY plan evidence is invalid', { venue })
            delete state.plan_runs[requestKey]
            if (state.latest_plan_summary?.plan_hash === cached.plan_summary.plan_hash) state.latest_plan_summary = null
          }
        }
        if (validation.ok && validation.outcome === 'READY') {
          const registered = state.plans[validation.plan.plan_hash]
          if (registered?.plan && stableStringify(registered.plan) !== stableStringify(validation.plan)) return blocked('EXECUTOR_PLAN_STATE_CONFLICT', 'Persisted plan hash is bound to different sealed content', { venue })
          if (!registered) state.plans[validation.plan.plan_hash] = planRecord(validation.plan)
        }
        state.latest_plan_summary = structuredClone(response.plan_summary)
        if (validation.ok && ['READY', 'NO_ACTION'].includes(validation.outcome)) {
          state.plan_runs[requestKey] = {
            lifecycle: 'terminal',
            date: prepared.date,
            iso_week: prepared.isoWeek,
            daily_source_digest: initialSource.digest,
            outcome: response.outcome,
            response: structuredClone(response)
          }
        }
        return response
      })
    })
  }

  function confirmationHash(request) {
    const values = [request.confirm_hash, request.confirm_plan_hash, request.confirmation].filter((value) => value !== undefined)
    if (new Set(values.map(String)).size > 1) fail('EXECUTOR_CONFIRMATION_CONFLICT', 'Manual hash confirmation fields must agree')
    return values.length ? String(values[0]) : null
  }

  async function prepareExecution(request) {
    return withState(async (state, current, fault) => {
      if (fault?.clockError) return blocked(fault.clockError.code, fault.clockError.message, { venue })
      const safety = await safetyGate(state, current, { requireArm: true })
      if (!safety.ok) return safety
      if (state.reconcile?.lifecycle === 'running') return blocked('EXECUTOR_RECONCILE_ORPHANED', 'A prior reconcile claim is still running; reconcile with its exact claim token before executing', { venue, locked: true })
      if (state.ambiguous_lock) return blocked('EXECUTOR_VENUE_LOCKED', 'Ambiguous submission locked this venue until reconciliation', { venue, locked: true })
      let plan = request.plan || lookupPlan(state, request)
      if (!plan) return blocked('EXECUTOR_PLAN_REFERENCE_UNKNOWN', 'Execute requires a previously registered sealed plan reference', { venue })
      if (request.plan) {
        inspectValue(plan, '$.plan')
        const registered = state.plans[plan.plan_hash]
        if (registered?.plan && stableStringify(registered.plan) !== stableStringify(plan)) return blocked('EXECUTOR_PLAN_HASH_MISMATCH', 'Registered plan content differs from the supplied sealed plan', { venue })
      }
      const suppliedHash = request.plan_hash ? String(request.plan_hash) : plan.plan_hash
      if (suppliedHash !== plan.plan_hash) return blocked('EXECUTOR_PLAN_HASH_MISMATCH', 'Supplied plan hash does not match the sealed plan', { venue })
      if (request.plan_id && String(request.plan_id) !== plan.plan_id) return blocked('EXECUTOR_PLAN_ID_MISMATCH', 'Supplied plan ID does not match the sealed plan', { venue })
      const verified = verifyPlan(plan, { planId: plan.plan_id, planHash: plan.plan_hash, now: () => current })
      if (!verified.ok) return blocked(verified.code, verified.message, { venue })
      const mode = request.mode === undefined ? 'manual' : String(request.mode)
      if (!['manual', 'scheduled'].includes(mode)) return blocked('EXECUTOR_MODE_INVALID', 'execute mode must be manual or scheduled', { venue })
      let cycleKey = null
      if (mode === 'manual') {
        const confirmation = confirmationHash(request)
        if (confirmation !== plan.plan_hash) return blocked('EXECUTOR_PLAN_HASH_CONFIRMATION_REQUIRED', 'Manual execute requires exact sealed plan hash confirmation', { venue })
        cycleKey = String(plan.daily_source_proof?.digest || '')
        if (!/^[0-9a-f]{64}$/.test(cycleKey)) return blocked('EXECUTOR_CYCLE_IDENTITY_MISSING', 'Manual execute requires the sealed daily source digest', { venue })
      } else {
        if (!request.slot_key) return blocked('EXECUTOR_SLOT_REQUIRED', 'Scheduled execute requires the current slot key', { venue })
        const slot = currentUtcSlots(current).find((candidate) => candidate.key === String(request.slot_key))
        if (!slot) return blocked('EXECUTOR_SLOT_NOT_CURRENT', 'Scheduled execute is limited to the current UTC slot window', { venue })
        if (slot.kind !== 'daily') return blocked('EXECUTOR_DAILY_SLOT_REQUIRED', 'Scheduled execute is allowed only from a current daily slot', { venue })
        cycleKey = slot.key
        const created = Date.parse(plan.created_at)
        const issued = Date.parse(state.arm.issued_at)
        if (!Number.isFinite(created) || !Number.isFinite(issued) || created < issued || created < slot.start_ms || created > current) return blocked('EXECUTOR_PLAN_OUTSIDE_ARM_WINDOW', 'Scheduled plan was not created inside the active arm and daily-slot window', { venue })
      }
      if (request.plan && !state.plans[plan.plan_hash]) state.plans[plan.plan_hash] = planRecord(plan)
      const previous = state.executions[plan.plan_hash]
      if (previous?.lifecycle === 'running') return blocked('EXECUTOR_EXECUTION_ORPHANED', 'A prior execution claim is still running; reconcile is required before any replay', { venue, locked: true })
      if (previous?.lifecycle === 'reconcile_required') return blocked('EXECUTOR_VENUE_LOCKED', 'Execution requires GREEN reconciliation before another submission', { venue, locked: true })
      if (previous?.lifecycle === 'reconciled' || previous?.lifecycle === 'completed') return { ok: true, duplicate: true, outcome: 'DUPLICATE_SUPPRESSED', venue, cycle_key: cycleKey, plan: planSummary(plan), execution: previous.result || previous }
      if (previous && !previous.lifecycle) return blocked('EXECUTOR_EXECUTION_ORPHANED', 'Legacy execution state cannot be replayed without reconciliation', { venue, locked: true })
      if (typeof options.executeFn !== 'function' && !(options.adapter || options.fakeAdapter)?.execute) {
        const configCheck = configScope(options.config, venue)
        if (!configCheck.ok) return blocked(configCheck.code, configCheck.message, { venue })
      }
      const claimToken = randomUUID()
      state.executions[plan.plan_hash] = {
        lifecycle: 'running',
        claim_token: claimToken,
        venue,
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        mode,
        cycle_key: cycleKey,
        claimed_at: iso(current)
      }
      return { ok: true, claim_token: claimToken, current, plan, mode, cycle_key: cycleKey }
    })
  }

  async function commitExecution(prepared, lifecycle, result, current, needsReconcile) {
    return withState(async (state) => {
      const row = state.executions[prepared.plan.plan_hash]
      if (!row || row.lifecycle !== 'running' || row.claim_token !== prepared.claim_token) return blocked('EXECUTOR_EXECUTION_CLAIM_LOST', 'Execution claim changed before terminal commit', { venue })
      const clean = safeOutput(result || {})
      state.executions[prepared.plan.plan_hash] = { ...row, lifecycle, terminal_at: iso(current), outcome: resultOutcome(clean) || (lifecycle === 'reconcile_required' ? 'RECONCILE_RED' : 'BLOCKED'), result: clean }
      if (needsReconcile) state.ambiguous_lock = { venue, plan_id: prepared.plan.plan_id, plan_hash: prepared.plan.plan_hash, cycle_key: prepared.cycle_key, claim_token: prepared.claim_token, locked_at: iso(current), reason: 'AMBIGUOUS_SUBMISSION' }
      return { ok: true, clean }
    })
  }

  async function execute(request) {
    const prepared = await prepareExecution(request)
    if (!prepared.ok || prepared.duplicate) return prepared
    const cycle = await claimCycle(prepared.plan, prepared.cycle_key, prepared.claim_token, prepared.current)
    if (!cycle.ok) {
      await commitExecution(prepared, 'blocked', { outcome: 'BLOCKED', code: cycle.code }, prepared.current, false)
      return cycle
    }
    const marker = { ambiguous: false }
    let result
    let directError = null
    try {
      const adapter = options.adapter || options.fakeAdapter
      if (typeof options.executeFn === 'function') {
        const injected = options.client || adapter?.client || (adapter && typeof adapter.usdmPlaceOrder === 'function' ? adapter : {})
        result = await options.executeFn({ venue, plan: prepared.plan, mode: prepared.mode, client: wrapClient(injected, marker), now: () => prepared.current })
      } else if (typeof adapter?.execute === 'function') {
        const injected = options.client || adapter?.client || (typeof adapter.usdmPlaceOrder === 'function' ? adapter : {})
        result = await adapter.execute({ venue, plan: prepared.plan, mode: prepared.mode, client: wrapClient(injected, marker), now: () => prepared.current })
      } else {
        result = await executeAutomaticTestnetPlan({
          venue,
          config: options.config,
          plan: prepared.plan,
          planId: prepared.plan.plan_id,
          planHash: prepared.plan.plan_hash,
          client: wrapClient(clientForExecution(), marker),
          ledgerPath: options.ledgerPath,
          killPath: options.killSwitchPath,
          weeklyAnchor: options.weeklyAnchor,
          marketSnapshot: options.marketSnapshot,
          executionSource: options.executionSource,
          source: options.executionSource,
          now: () => prepared.current,
          sleep: options.sleep
        })
      }
    } catch (error) {
      directError = error
    }
    const directAmbiguous = directError && (directError.ambiguous === true || /ambiguous|unknown(?:[_\s-]?(?:state|submission))|timeout|network|socket|reset/i.test(String(directError.code || directError.message || '')))
    const ambiguous = Boolean(marker.ambiguous || directAmbiguous)
    if (directError) {
      const terminal = blocked(directError.code || 'EXECUTOR_EXECUTION_FAILED', safeText(directError.message || directError), { venue })
      const committed = await commitExecution(prepared, ambiguous ? 'reconcile_required' : 'blocked', terminal, prepared.current, ambiguous)
      if (ambiguous) await commitCycle(prepared.cycle_key, prepared.claim_token, 'reconcile_required', prepared.current)
      else await commitCycle(prepared.cycle_key, prepared.claim_token, 'blocked', prepared.current)
      return committed.ok && ambiguous ? blocked('EXECUTOR_AMBIGUOUS_SUBMISSION', 'Ambiguous submission locked this venue; no retry or failover is permitted', { venue, locked: true, plan: planSummary(prepared.plan) }) : terminal
    }
    const clean = safeOutput(result || { outcome: 'COMPLETE' })
    const outcome = resultOutcome(clean) || 'COMPLETE'
    const outcomes = resultOutcomes(clean)
    const needsReconcile = ambiguous || outcomes.includes('RECONCILE_RED') || (outcomes.includes('BLOCKED') && hasAmbiguousMarker(clean))
    const lifecycle = needsReconcile ? 'reconcile_required' : 'completed'
    const committed = await commitExecution(prepared, lifecycle, clean, prepared.current, needsReconcile)
    const cycleCommitted = await commitCycle(prepared.cycle_key, prepared.claim_token, needsReconcile ? 'reconcile_required' : 'completed', prepared.current)
    if (!committed.ok || !cycleCommitted.ok) return blocked('EXECUTOR_EXECUTION_CLAIM_LOST', 'Execution terminal state could not be committed safely', { venue, locked: true })
    if (needsReconcile) return blocked('EXECUTOR_AMBIGUOUS_SUBMISSION', 'Ambiguous submission locked this venue; no retry or failover is permitted', { venue, locked: true, plan: planSummary(prepared.plan) })
    return { ok: true, outcome, venue, cycle_key: prepared.cycle_key, plan: planSummary(prepared.plan), execution: clean }
  }

  function verifyReconcilePlanBinding(plan, request) {
    if (!plan) return { ok: true }
    const verified = verifyPlan(plan, {
      planId: plan.plan_id,
      planHash: plan.plan_hash,
      allowExpired: true,
      skipCurrentTime: true
    })
    if (!verified.ok) return blocked(`EXECUTOR_RECONCILE_${verified.code}`, verified.message, { venue, locked: true })
    if (request.plan_id && String(request.plan_id) !== plan.plan_id) return blocked('EXECUTOR_RECONCILE_PLAN_ID_MISMATCH', 'Reconcile plan ID does not match the sealed plan', { venue, locked: true })
    if (request.plan_hash && String(request.plan_hash) !== plan.plan_hash) return blocked('EXECUTOR_RECONCILE_PLAN_HASH_MISMATCH', 'Reconcile plan hash does not match the sealed plan', { venue, locked: true })
    if (plan.venue !== venue || plan.product !== 'usdm' || plan.environment !== 'testnet') return blocked('EXECUTOR_RECONCILE_SCOPE_INVALID', 'Reconcile accepts only a sealed USDT-M testnet plan for this venue', { venue, locked: true })
    return { ok: true }
  }

  async function prepareReconcile(request) {
    return withState(async (state, current, fault) => {
      if (fault?.clockError) return blocked(fault.clockError.code, fault.clockError.message, { venue })
      let activeCycle = null
      try {
        const cycleState = readJsonStrict(cycleStatePath, { missingDefault: defaultCycleState() })
        if (!cycleState || cycleState.schema !== CYCLE_SCHEMA || (cycleState.active !== null && (typeof cycleState.active !== 'object' || Array.isArray(cycleState.active)))) return blocked('EXECUTOR_CYCLE_STATE_INVALID', 'Active venue cycle state is invalid', { venue, locked: true })
        activeCycle = cycleState.active
        if (activeCycle && !['running', 'reconcile_required', 'completed', 'reconciled', 'blocked'].includes(activeCycle.lifecycle)) return blocked('EXECUTOR_CYCLE_STATE_INVALID', 'Active cycle lifecycle is invalid', { venue, locked: true })
      } catch (error) {
        return blocked(error?.code || 'EXECUTOR_CYCLE_STATE_INVALID', safeText(error?.message || error), { venue, locked: true })
      }
      if (state.reconcile?.lifecycle === 'running') {
        if (String(request.claim_token || '') !== state.reconcile.claim_token) return blocked('EXECUTOR_RECONCILE_ORPHANED', 'A prior reconcile claim is still running; exact claim token is required for recovery', { venue, locked: true })
        const resumedPlan = lookupPlan(state, request) || (state.reconcile.plan_hash ? state.plans[state.reconcile.plan_hash]?.plan : null)
        if (state.reconcile.plan_hash && request.plan_hash && String(request.plan_hash) !== state.reconcile.plan_hash) return blocked('EXECUTOR_RECONCILE_PLAN_MISMATCH', 'Recovery must keep the exact persisted reconcile plan', { venue, locked: true })
        if (state.reconcile.plan_hash && resumedPlan && resumedPlan.plan_hash !== state.reconcile.plan_hash) return blocked('EXECUTOR_RECONCILE_PLAN_MISMATCH', 'Recovery must keep the exact persisted reconcile plan', { venue, locked: true })
        const planCheck = verifyReconcilePlanBinding(resumedPlan, request)
        if (!planCheck.ok) return planCheck
        return { ok: true, claim_token: state.reconcile.claim_token, current, plan: resumedPlan, cause_ids: request.cause_ids ?? state.reconcile.cause_ids ?? [], bound_execution_hash: state.reconcile.bound_execution_hash || null, bound_execution_token: state.reconcile.bound_execution_token || null, cycle_key: state.reconcile.cycle_key || null, cycle_token: state.reconcile.cycle_token || null }
      }
      let plan = lookupPlan(state, request) || (state.ambiguous_lock?.plan_hash ? state.plans[state.ambiguous_lock.plan_hash]?.plan : null)
      const planCheck = verifyReconcilePlanBinding(plan, request)
      if (!planCheck.ok) return planCheck
      if (state.ambiguous_lock?.plan_hash && plan && plan.plan_hash !== state.ambiguous_lock.plan_hash) return blocked('EXECUTOR_RECONCILE_PLAN_MISMATCH', 'Reconcile must keep the exact locked plan', { venue, locked: true })
      if (state.ambiguous_lock?.plan_hash && request.plan_hash && String(request.plan_hash) !== state.ambiguous_lock.plan_hash) return blocked('EXECUTOR_RECONCILE_PLAN_MISMATCH', 'Reconcile must keep the exact locked plan', { venue, locked: true })
      let targetHash = request.plan_hash || plan?.plan_hash || state.ambiguous_lock?.plan_hash || null
      let execution = targetHash ? state.executions[targetHash] : null
      if (activeCycle && ['running', 'reconcile_required'].includes(activeCycle.lifecycle)) {
        if (!activeCycle.claim_token) return blocked('EXECUTOR_CYCLE_STATE_INVALID', 'Running cycle claim has no recovery token', { venue, locked: true })
        if (!execution && String(request.claim_token || '') !== activeCycle.claim_token) return blocked('EXECUTOR_RECONCILE_ORPHANED', 'A running cycle claim has no matching execution state; exact cycle claim token is required for recovery', { venue, locked: true })
        if (targetHash && activeCycle.plan_hash && targetHash !== activeCycle.plan_hash) return blocked('EXECUTOR_CYCLE_IDENTITY_MISMATCH', 'Reconcile must bind the exact active cycle plan', { venue, locked: true })
        if (request.plan_id && activeCycle.plan_id && String(request.plan_id) !== activeCycle.plan_id) return blocked('EXECUTOR_CYCLE_IDENTITY_MISMATCH', 'Reconcile must bind the exact active cycle plan ID', { venue, locked: true })
        if (request.plan_hash && activeCycle.plan_hash && String(request.plan_hash) !== activeCycle.plan_hash) return blocked('EXECUTOR_CYCLE_IDENTITY_MISMATCH', 'Reconcile must bind the exact active cycle plan hash', { venue, locked: true })
        if (!targetHash) targetHash = activeCycle.plan_hash || null
        if (!plan && targetHash) plan = state.plans[targetHash]?.plan || null
        const activePlanCheck = verifyReconcilePlanBinding(plan, request)
        if (!activePlanCheck.ok) return activePlanCheck
        execution = targetHash ? state.executions[targetHash] : null
        if (execution && (execution.claim_token !== activeCycle.claim_token || execution.plan_hash !== activeCycle.plan_hash || execution.plan_id !== activeCycle.plan_id || execution.cycle_key !== activeCycle.cycle_key || execution.venue !== activeCycle.venue)) return blocked('EXECUTOR_CYCLE_CLAIM_LOST', 'Cycle and execution orphan claims do not match exactly', { venue, locked: true })
        if (!execution && activeCycle.venue !== venue) return blocked('EXECUTOR_CYCLE_VENUE_CONFLICT', 'A different venue owns the active cycle claim', { venue, locked: true, active_venue: activeCycle.venue })
      }
      if (execution?.lifecycle === 'running' && !plan) return blocked('EXECUTOR_RECONCILE_PLAN_REQUIRED', 'Reconcile must bind the exact sealed plan for an orphan execution claim', { venue, locked: true })
      if (execution && !['running', 'reconcile_required', 'completed', 'reconciled', 'blocked'].includes(execution.lifecycle)) return blocked('EXECUTOR_EXECUTION_STATE_INVALID', 'Execution lifecycle is invalid', { venue, locked: true })
      const claimToken = randomUUID()
      state.reconcile = {
        lifecycle: 'running',
        claim_token: claimToken,
        plan_id: request.plan_id || plan?.plan_id || activeCycle?.plan_id || null,
        plan_hash: request.plan_hash || plan?.plan_hash || activeCycle?.plan_hash || null,
        bound_execution_hash: execution?.lifecycle === 'running' || execution?.lifecycle === 'reconcile_required' ? targetHash : null,
        bound_execution_token: execution?.lifecycle === 'running' || execution?.lifecycle === 'reconcile_required' ? execution.claim_token : null,
        cycle_key: execution?.cycle_key || state.ambiguous_lock?.cycle_key || activeCycle?.cycle_key || null,
        cycle_token: execution?.claim_token || state.ambiguous_lock?.claim_token || activeCycle?.claim_token || null,
        cause_ids: request.cause_ids || [],
        started_at: iso(current)
      }
      return { ok: true, claim_token: claimToken, current, plan, cause_ids: request.cause_ids || [], bound_execution_hash: state.reconcile.bound_execution_hash, bound_execution_token: state.reconcile.bound_execution_token, cycle_key: state.reconcile.cycle_key, cycle_token: state.reconcile.cycle_token }
    }, { allowClockFault: true })
  }

  async function commitReconcile(prepared, lifecycle, current, green, clean) {
    return withState(async (state) => {
      const claim = state.reconcile
      if (!claim || claim.lifecycle !== 'running' || claim.claim_token !== prepared.claim_token) return blocked('EXECUTOR_RECONCILE_CLAIM_LOST', 'Reconcile claim changed before terminal commit', { venue, locked: state.ambiguous_lock !== null })
      let cycleKey = null
      let cycleToken = null
      let locked = null
      let boundExecution = null
      if (green && state.ambiguous_lock) {
        if (!prepared.plan || (state.ambiguous_lock.plan_hash && prepared.plan.plan_hash !== state.ambiguous_lock.plan_hash)) return blocked('EXECUTOR_RECONCILE_PLAN_MISMATCH', 'GREEN reconciliation does not match the locked plan', { venue, locked: true })
        locked = state.ambiguous_lock
        if (!locked.cycle_key || !locked.claim_token || prepared.cycle_key !== locked.cycle_key || prepared.cycle_token !== locked.claim_token) return blocked('EXECUTOR_RECONCILE_CYCLE_MISMATCH', 'GREEN reconciliation must bind the exact locked cycle claim', { venue, locked: true })
        cycleKey = locked.cycle_key
        cycleToken = locked.claim_token
      }
      if (green && claim.bound_execution_hash) {
        const execution = state.executions[claim.bound_execution_hash]
        if (!execution || !['running', 'reconcile_required', 'reconciled'].includes(execution.lifecycle) || execution.claim_token !== claim.bound_execution_token) return blocked('EXECUTOR_RECONCILE_EXECUTION_MISMATCH', 'GREEN reconciliation does not match the bound execution claim', { venue, locked: true })
        boundExecution = execution
        cycleKey = execution.cycle_key || cycleKey
        cycleToken = execution.claim_token || cycleToken
      }
      if (green && !cycleKey && claim.cycle_key && claim.cycle_token) {
        cycleKey = claim.cycle_key
        cycleToken = claim.cycle_token
      }
      state.reconcile = { ...claim, lifecycle, completed_at: iso(current), ...(clean ? { result: safeOutput(clean) } : {}) }
      if (green && locked) {
        state.ambiguous_lock = null
        state.executions[locked.plan_hash] = { ...(state.executions[locked.plan_hash] || {}), lifecycle: 'reconciled', reconciled_at: iso(current) }
      }
      if (green && boundExecution && boundExecution.lifecycle !== 'reconciled') state.executions[claim.bound_execution_hash] = { ...boundExecution, lifecycle: 'reconciled', reconciled_at: iso(current) }
      return { ok: true, locked: state.ambiguous_lock !== null, cycle_key: cycleKey, cycle_token: cycleToken }
    })
  }

  async function reconcile(request) {
    const prepared = await prepareReconcile(request)
    if (!prepared.ok) return prepared
    let result
    try {
      if (typeof options.reconcileFn === 'function') result = await options.reconcileFn({ venue, plan: prepared.plan, plan_id: request.plan_id || prepared.plan?.plan_id || null, plan_hash: request.plan_hash || prepared.plan?.plan_hash || null, cause_ids: prepared.cause_ids })
      else if (typeof options.reconcile === 'function') result = await options.reconcile({ venue, plan: prepared.plan, cause_ids: prepared.cause_ids })
      else if (options.client && typeof options.client.reconcile === 'function') result = await options.client.reconcile({ venue, plan: prepared.plan, cause_ids: prepared.cause_ids })
      else if ((options.adapter || options.fakeAdapter) && typeof (options.adapter || options.fakeAdapter).reconcile === 'function') result = await (options.adapter || options.fakeAdapter).reconcile({ venue, plan: prepared.plan, cause_ids: prepared.cause_ids })
      else result = await defaultReconcile(options, venue, prepared.current, prepared.cause_ids)
    } catch (error) {
      await commitReconcile(prepared, 'failed', prepared.current, false, { outcome: 'RECONCILE_RED', code: error?.code || 'EXECUTOR_RECONCILE_FAILED' })
      return blocked(error?.code || 'EXECUTOR_RECONCILE_FAILED', safeText(error?.message || error), { venue, locked: true })
    }
    const clean = safeOutput(result || {})
    const receipt = sealedReconciliationReceipt(result, venue)
    if (!receipt) {
      await commitReconcile(prepared, 'failed', prepared.current, false, { outcome: 'RECONCILE_RED', code: 'EXECUTOR_RECONCILE_EVIDENCE_INVALID' })
      return blocked('EXECUTOR_RECONCILE_EVIDENCE_INVALID', 'Reconciliation must return a sealed USDT-M testnet receipt', { venue, locked: true, reconciliation: clean })
    }
    let persisted
    try { persisted = persistReconciliation(options, venue, receipt) } catch (error) {
      await commitReconcile(prepared, 'failed', prepared.current, false, { outcome: 'RECONCILE_RED', code: error?.code || 'EXECUTOR_RECONCILE_PERSIST_FAILED' })
      return blocked(error?.code || 'EXECUTOR_RECONCILE_PERSIST_FAILED', safeText(error?.message || error), { venue, locked: true })
    }
    const green = greenReconciliationReceipt(result, venue) !== null && persisted.unresolved_red_causes.length === 0
    if (green && prepared.cycle_key && prepared.cycle_token) {
      const cycleCommitted = await reconcileCycle(prepared.cycle_key, prepared.cycle_token, prepared.current)
      if (!cycleCommitted.ok) {
        await commitReconcile(prepared, 'failed', prepared.current, false, { outcome: 'RECONCILE_RED', code: cycleCommitted.code })
        return blocked('EXECUTOR_CYCLE_CLAIM_LOST', 'GREEN evidence could not commit the exact cycle reconciliation claim', { venue, locked: true })
      }
    }
    const committed = await commitReconcile(prepared, green ? 'completed' : 'failed', prepared.current, green, clean)
    if (!committed.ok) return committed
    return green
      ? { ok: true, outcome: 'RECONCILED', venue, locked: false, reconciliation: clean, remaining_red_causes: 0 }
      : blocked('EXECUTOR_RECONCILE_NOT_GREEN', 'Only a sealed complete GREEN receipt persisted with no unresolved red causes can unlock this venue', { venue, locked: true, reconciliation: clean, remaining_red_causes: persisted.unresolved_red_causes.length })
  }

  async function dispatch(request) {
    const command = validateRequest(request)
    if (command === 'status') return status()
    if (command === 'arm') return arm(request)
    if (command === 'disarm') return disarm(request)
    if (command === 'plan') return generatePlan(request)
    if (command === 'execute') return execute(request)
    return reconcile(request)
  }

  async function handleRequest(request) {
    try {
      const result = await dispatch(request)
      return safeOutput(result)
    } catch (error) {
      const failure = safeError(error)
      return { ok: false, code: failure.code, message: failure.message, error: failure }
    }
  }

  const executor = Object.freeze({
    venue,
    statePath,
    handleRequest,
    request: handleRequest,
    status,
    arm,
    disarm,
    plan: registerPlan,
    registerPlan,
    generatePlan,
    execute,
    reconcile
  })
  EXECUTOR_PATH_POLICIES.set(executor, pathPolicy)
  return executor
}

export const createExecutor = createTestnetExecutor

function socketOwnerPath(socketPath) {
  return `${socketPath}.owner`
}

function processAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false
  try { process.kill(Number(pid), 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function probeSocket(socketPath) {
  try {
    const stat = fs.lstatSync(socketPath)
    if (!stat.isSocket()) fail('EXECUTOR_SOCKET_PATH_OCCUPIED', 'Socket path exists and is not a Unix socket')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  return new Promise((resolve) => {
    let settled = false
    const probe = net.createConnection(socketPath)
    const finish = (value) => {
      if (settled) return
      settled = true
      probe.destroy()
      resolve(value)
    }
    probe.once('connect', () => finish(true))
    probe.once('error', (error) => finish(!['ECONNREFUSED', 'ENOENT', 'ENOTSOCK'].includes(error?.code)))
    probe.setTimeout(150, () => finish(true))
  })
}

async function claimSocketOwnership(socketPath, allowUnsafe = false) {
  const ownerPath = socketOwnerPath(socketPath)
  const ownershipLockPath = `${ownerPath}.lock`
  if (!allowUnsafe) {
    assertNoSymlink(ownerPath)
    assertNoSymlink(ownershipLockPath)
  }
  // The fixed ownership lock closes the stale-owner TOCTOU window: only one
  // starter may inspect/remove an old claim and probe/unlink its socket at a
  // time.  The lock is released before the listener starts; the durable
  // owner file and listener probe then protect the running service.
  return serializeSocketPath(ownerPath, () => withFileLockAsync(ownerPath, async () => {
    let existing = null
    try {
      const stat = fs.lstatSync(ownerPath)
      if (!stat.isFile()) fail('EXECUTOR_SOCKET_OWNERSHIP_INVALID', 'Socket ownership claim is not a regular file')
      existing = JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new ExecutorError('EXECUTOR_SOCKET_OWNERSHIP_INVALID', 'Socket ownership claim is invalid')
    }
    if (existing && (processAlive(existing.pid) || await probeSocket(socketPath))) fail('EXECUTOR_SOCKET_ACTIVE', 'Another executor is already listening on this Unix socket')
    if (existing) {
      try { fs.unlinkSync(ownerPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    const token = randomUUID()
    let descriptor
    try {
      descriptor = fs.openSync(ownerPath, 'wx', 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify({ schema: 'tyche_testnet_socket_owner/v1', token, pid: process.pid, claimed_at: new Date().toISOString() })}\n`, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
    } catch (error) {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch {} }
      if (error?.code === 'EEXIST') fail('EXECUTOR_SOCKET_ACTIVE', 'Another executor owns this Unix socket')
      throw new ExecutorError('EXECUTOR_SOCKET_OWNERSHIP_FAILED', `Cannot claim Unix socket ownership: ${error.message}`)
    }
    try {
      if (await probeSocket(socketPath)) fail('EXECUTOR_SOCKET_ACTIVE', 'Another executor is already listening on this Unix socket')
      try {
        const stat = fs.lstatSync(socketPath)
        if (!stat.isSocket()) fail('EXECUTOR_SOCKET_PATH_OCCUPIED', 'Socket path exists and is not a Unix socket')
        if (await probeSocket(socketPath)) fail('EXECUTOR_SOCKET_ACTIVE', 'Another executor is already listening on this Unix socket')
        const unchanged = fs.lstatSync(socketPath)
        if (unchanged.ino !== stat.ino) fail('EXECUTOR_SOCKET_ACTIVE', 'Socket path changed while taking ownership')
        fs.unlinkSync(socketPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    } catch (error) {
      try {
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
        if (owner.token === token) fs.unlinkSync(ownerPath)
      } catch {}
      throw error
    }
    return { ownerPath, token, inode: null }
  }))
}

function ownerMatches(ownership) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownership.ownerPath, 'utf8'))
    return owner && owner.token === ownership.token && Number(owner.pid) === process.pid
  } catch {
    return false
  }
}

function recordSocketInode(ownership, socketPath) {
  const stat = fs.lstatSync(socketPath)
  if (!stat.isSocket()) fail('EXECUTOR_SOCKET_PATH_OCCUPIED', 'Started endpoint is not a Unix socket')
  ownership.inode = stat.ino
  const owner = JSON.parse(fs.readFileSync(ownership.ownerPath, 'utf8'))
  if (owner.token !== ownership.token) fail('EXECUTOR_SOCKET_OWNERSHIP_LOST', 'Socket ownership changed while starting')
  writeJsonAtomic(ownership.ownerPath, { ...owner, inode: stat.ino }, { mode: 0o600 })
  fs.chmodSync(ownership.ownerPath, 0o600)
}

function releaseSocketOwnership(ownership, socketPath) {
  if (!ownerMatches(ownership)) return false
  if (ownership.inode === null) {
    try { fs.lstatSync(socketPath); return false } catch (error) {
      if (error?.code !== 'ENOENT') return false
    }
    try { if (ownerMatches(ownership)) fs.unlinkSync(ownership.ownerPath) } catch (error) { if (error?.code !== 'ENOENT') return false }
    return true
  }
  try {
    const stat = fs.lstatSync(socketPath)
    if (stat.ino !== ownership.inode) return false
    if (!stat.isSocket()) return false
    fs.unlinkSync(socketPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') return false
  }
  try {
    if (ownerMatches(ownership)) fs.unlinkSync(ownership.ownerPath)
  } catch (error) { if (error?.code !== 'ENOENT') return false }
  return true
}

/** Start a newline-delimited JSON Unix socket for one fixed venue. */
export async function startTestnetExecutorServer(executorOrOptions, serverOptions = {}) {
  const executor = executorOrOptions && typeof executorOrOptions.handleRequest === 'function'
    ? executorOrOptions
    : createTestnetExecutor(executorOrOptions || {})
  const inheritedPolicy = EXECUTOR_PATH_POLICIES.get(executor)
  const pathPolicy = inheritedPolicy || createPathPolicy({ ...serverOptions, venue: executor.venue })
  const socketPath = pathPolicy.resolveSocket(serverOptions.socketPath || executorOrOptions?.socketPath)
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  const ownership = await claimSocketOwnership(socketPath, pathPolicy.allowUnsafe)
  const server = net.createServer((connection) => {
    let buffer = ''
    let chain = Promise.resolve()
    connection.setEncoding('utf8')
    connection.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        connection.destroy()
        return
      }
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        chain = chain.then(async () => {
          let request
          try { request = JSON.parse(line) } catch (error) { request = null }
          const response = request === null
            ? { ok: false, code: 'EXECUTOR_JSON_INVALID', message: 'Socket frame must be one JSON object per line' }
            : await executor.handleRequest(request)
          if (!connection.destroyed) connection.write(`${JSON.stringify(safeOutput(response))}\n`)
        }).catch(() => { if (!connection.destroyed) connection.write('{"ok":false,"code":"EXECUTOR_SOCKET_ERROR","message":"Socket request failed"}\n') })
      }
    })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    fs.chmodSync(socketPath, 0o600)
    recordSocketInode(ownership, socketPath)
  } catch (error) {
    try { await new Promise((resolve) => server.close(resolve)) } catch {}
    releaseSocketOwnership(ownership, socketPath)
    if (error instanceof ExecutorError) throw error
    throw new ExecutorError('EXECUTOR_SOCKET_START_FAILED', safeText(error?.message || error))
  }
  let closed = false
  async function close() {
    if (closed) return
    closed = true
    await new Promise((resolve) => server.close(resolve))
    if (!releaseSocketOwnership(ownership, socketPath)) throw new ExecutorError('EXECUTOR_SOCKET_OWNERSHIP_LOST', 'Socket was not removed because its ownership or inode changed')
  }
  return Object.freeze({ executor, server, socketPath, close, stop: close })
}

export const startExecutorServer = startTestnetExecutorServer

export async function stopTestnetExecutorServer(service) {
  if (!service || typeof service.close !== 'function') fail('EXECUTOR_SERVER_INVALID', 'A started executor server is required')
  return service.close()
}

export const stopExecutorServer = stopTestnetExecutorServer

export function createTestnetExecutorServer(options = {}) {
  const executor = options.executor || createTestnetExecutor(options)
  let running = null
  return Object.freeze({
    executor,
    start: async () => {
      if (!running) running = await startTestnetExecutorServer(executor, options)
      return running
    },
    stop: async () => {
      if (running) await running.close()
      running = null
    },
    get running() { return running !== null }
  })
}

export const createExecutorServer = createTestnetExecutorServer

function socketClientTimeout(options = {}) {
  const value = options.timeoutMs === undefined ? SOCKET_CLIENT_TIMEOUT_MS : Number(options.timeoutMs)
  if (!Number.isInteger(value) || value < 1 || value > SOCKET_CLIENT_TIMEOUT_MS) fail('EXECUTOR_SOCKET_TIMEOUT_INVALID', `Socket timeout must be an integer between 1 and ${SOCKET_CLIENT_TIMEOUT_MS}ms`)
  return value
}

function socketClientFailure(code, message) {
  return { ok: false, code, message }
}

export async function requestExecutorSocket(socketPath, request, options = {}) {
  const target = createPathPolicy({ ...options, venue: options.venue || 'gate' }).resolveSocket(socketPath)
  validateRequest(request)
  const timeoutMs = socketClientTimeout(options)
  const frame = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) return socketClientFailure('EXECUTOR_SOCKET_FRAME_TOO_LARGE', 'Socket request exceeded the fixed frame limit')
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(target)
    let buffer = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      connection.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    connection.setEncoding('utf8')
    connection.once('error', (error) => finish(error))
    connection.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        finish(null, socketClientFailure('EXECUTOR_SOCKET_FRAME_TOO_LARGE', 'Socket response exceeded the fixed frame limit'))
        return
      }
      const index = buffer.indexOf('\n')
      if (index < 0) return
      if (buffer.slice(index + 1).trim()) {
        finish(null, socketClientFailure('EXECUTOR_SOCKET_MULTIPLE_FRAMES', 'Socket response contained more than one frame'))
        return
      }
      try { finish(null, JSON.parse(buffer.slice(0, index))) } catch (error) { finish(error) }
    })
    connection.setTimeout(timeoutMs, () => finish(null, socketClientFailure('EXECUTOR_SOCKET_TIMEOUT', 'Executor socket response timed out')))
    connection.once('connect', () => connection.write(frame))
  })
}

export const connectExecutor = requestExecutorSocket

function cliArgs(argv) {
  const values = argv.slice(2)
  const command = values[0] || 'help'
  const allowedCommands = new Set([...COMMANDS, 'start', 'help'])
  if (!allowedCommands.has(command)) fail('EXECUTOR_COMMAND_UNSUPPORTED', 'Commands: start, status, arm, disarm, plan, execute, reconcile')
  const allowedFlags = command === 'start'
    ? new Set(['--venue', '--socket', '--state', '--cycle-state', '--kill-switch', '--config'])
    : command === 'help'
      ? new Set()
      : new Set(['--socket', '--request'])
  const suppliedFlags = values.slice(1).filter((value) => value.startsWith('--'))
  const unknownFlags = suppliedFlags.filter((flag) => !allowedFlags.has(flag))
  if (unknownFlags.length) fail('EXECUTOR_ARGUMENT_UNKNOWN', `Unsupported arguments: ${[...new Set(unknownFlags)].join(', ')}`)
  const positional = []
  for (let index = 1; index < values.length; index += 1) {
    if (values[index].startsWith('--')) { index += 1; continue }
    positional.push(values[index])
  }
  if (positional.length) fail('EXECUTOR_ARGUMENT_INVALID', `Unexpected positional arguments: ${positional.join(', ')}`)
  const get = (flag, fallback = null) => {
    const indexes = values.map((value, index) => value === flag ? index : -1).filter((index) => index >= 0)
    if (indexes.length > 1) fail('EXECUTOR_ARGUMENT_DUPLICATE', `${flag} may be supplied only once`)
    if (!indexes.length) return fallback
    const value = values[indexes[0] + 1]
    if (!value || value.startsWith('--')) fail('EXECUTOR_ARGUMENT_INVALID', `${flag} requires a value`)
    return value
  }
  return {
    command,
    venue: get('--venue'),
    socketPath: get('--socket'),
    statePath: get('--state'),
    cycleStatePath: get('--cycle-state'),
    killSwitchPath: get('--kill-switch'),
    configPath: get('--config'),
    requestPath: get('--request')
  }
}

function cliConfigPath(value) {
  if (!value) return undefined
  const target = path.resolve(String(value))
  assertNoSymlink(target)
  if (!isWithin(target, path.join(ROOT, 'config'))) fail('EXECUTOR_CONFIG_PATH_INVALID', 'CLI configuration must stay inside the repository config directory')
  return target
}

async function cli(argv) {
  const args = cliArgs(argv)
  if (args.command === 'help') {
    process.stdout.write('Usage: node scripts/testnet-executor.mjs start --venue gate|binance --socket PATH --state PATH [--config PATH]\n')
    return
  }
  if (args.command === 'start') {
    if (!args.venue) fail('EXECUTOR_START_ARGUMENTS_REQUIRED', 'start requires --venue')
    const venue = venueName(args.venue)
    const pathPolicy = createPathPolicy({ venue })
    const socketPath = pathPolicy.resolveSocket(args.socketPath || path.join(DATA_RUNTIME_ROOT, `${venue}.sock`))
    const configPath = cliConfigPath(args.configPath)
    const config = configPath ? loadConfig({ filePath: configPath }) : undefined
    const executor = createTestnetExecutor({ venue, statePath: args.statePath, cycleStatePath: args.cycleStatePath, killSwitchPath: args.killSwitchPath, config })
    const service = await startTestnetExecutorServer(executor, { socketPath })
    process.stdout.write(`${JSON.stringify({ ok: true, outcome: 'STARTED', venue: executor.venue, socket_path: service.socketPath, mode: '0600' })}\n`)
    const shutdown = async () => { await service.close(); process.exit(0) }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    await new Promise(() => {})
    return
  }
  if (!args.socketPath || !args.requestPath) fail('EXECUTOR_REQUEST_ARGUMENTS_REQUIRED', 'Command requires --socket and --request JSON path')
  const requestPath = createPathPolicy({ venue: 'gate' }).resolve(args.requestPath, null, 'CLI request')
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
  if (request.command !== args.command) fail('EXECUTOR_COMMAND_MISMATCH', 'Request command does not match CLI command')
  const response = await requestExecutorSocket(args.socketPath, request)
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
  if (response.ok === false) process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await cli(process.argv)
  } catch (error) {
    const failure = safeError(error)
    process.stdout.write(`${JSON.stringify({ ok: false, code: failure.code, message: failure.message }, null, 2)}\n`)
    process.exitCode = 1
  }
}
