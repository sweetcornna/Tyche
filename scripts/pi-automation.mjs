#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  fixtureWorker,
  runCluster as runPiCluster,
  validateResult,
  validateSemanticOutput,
  SESSION_PROVIDER_ID,
  validateSessionProtocol
} from '../packages/pi-agents/src/index.mjs'
import {
  createAutomationApplicator,
  createAutomationPlanner,
  prepareAutomation,
  runAutomationPlanning
} from './crypto-automation.mjs'
import { loadConfig } from './config.mjs'
import { collectMarketSnapshot } from './crypto-market.mjs'
import { collectAllExchangeSnapshot } from './multi-exchange-market.mjs'
import {
  persistCanonicalDocument,
  validateCanonicalDocument
} from './agent-write.mjs'
import { settlePaper } from './paper-trade.mjs'
import { readJsonStrict, withFileLock, withFileLockAsync, writeJsonAtomic } from './lib-iolock.mjs'
import { sha256Hex } from './gate-trade.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_ROOT = path.join(ROOT, 'data')
const OUTPUT_ROOT = path.join(ROOT, 'outputs')
const DAILY_PATH = path.join(DATA_ROOT, 'crypto_daily.json')
const WEEKLY_PATH = path.join(DATA_ROOT, 'crypto_strategy.json')
const MARKET_PATH = path.join(DATA_ROOT, 'crypto_market.json')
const MULTI_MARKET_PATH = path.join(DATA_ROOT, 'crypto_multi_exchange.json')
const PAPER_PATH = path.join(DATA_ROOT, 'paper', 'active.json')
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config', 'tyche.json')
const PI_SHADOW_ROOT = path.join(OUTPUT_ROOT, 'pi-shadow')
const PI_AUTOMATION_SCHEMA = 'tyche_pi_automation_cycle/v1'
const PI_PROVENANCE_SCHEMA = 'tyche_pi_provenance/v1'
const MUTATION_CREDENTIALS = Object.freeze([
  'GATE_USDM_TESTNET_API_KEY',
  'GATE_USDM_TESTNET_SECRET_KEY',
  'BINANCE_USDM_TESTNET_API_KEY',
  'BINANCE_USDM_TESTNET_SECRET_KEY'
])
const MUTATION_CREDENTIAL_KEY = /^(?:GATE|BINANCE)_(?:USDM|FUTURES)(?:_TESTNET)?_(?:API|SECRET|ACCESS|PRIVATE|SIGNING)_?KEY$/i
const ASSETS = Object.freeze(['BTC', 'ETH'])
const PI_CYCLE_QUEUES = new Map()

export class PiAutomationError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'PiAutomationError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new PiAutomationError(code, message, details)
}

function safeText(value, limit = 320) {
  return String(value ?? '')
    .replace(/(?:api[_-]?key|secret|token|password|authorization)\s*[=:]\s*[^\s,;]+/ig, '$1=[redacted]')
    .replace(/\b(?:GATE|BINANCE)_[A-Z0-9_]+\b/gi, '[credential-redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, limit)
}

function errorDetails(error, fallback = 'Pi automation failed') {
  return {
    code: String(error?.code || 'PI_AUTOMATION_FAILED').slice(0, 100),
    message: safeText(error?.message || error || fallback)
  }
}

function validDate(value) {
  const text = String(value || '')
  const parsed = new Date(`${text}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    fail('PI_AUTOMATION_DATE_INVALID', 'date must be a real YYYY-MM-DD value')
  }
  return text
}

function validWeek(value) {
  const text = String(value || '')
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(text)) fail('PI_AUTOMATION_WEEK_INVALID', 'iso-week must use YYYY-Www')
  return text
}

function nonEmpty(value, code, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(code, `${label} is required`)
  return value.trim()
}

export function rejectPiMutationCredentials(environment = (typeof process === 'object' && process?.env ? process.env : {})) {
  const present = Object.keys(environment || {}).filter((key) => MUTATION_CREDENTIALS.includes(key) || MUTATION_CREDENTIAL_KEY.test(key))
  if (present.length) fail('PI_AUTOMATION_MUTATION_CREDENTIAL_PRESENT', `Mutation credentials are forbidden: ${present.join(', ')}`)
}

function nowMs(value) {
  const raw = typeof value === 'function' ? value() : (value ?? Date.now())
  const current = raw instanceof Date ? raw.getTime() : Number(raw)
  if (!Number.isFinite(current) || !Number.isSafeInteger(current) || current < 0) fail('PI_AUTOMATION_CLOCK_INVALID', 'Automation clock must be a finite non-negative safe integer')
  return current
}

function validatePiAutomationBaseOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('PI_AUTOMATION_OPTIONS_INVALID', 'Pi automation options must be an object')
  const result = {
    date: validDate(options.date),
    isoWeek: validWeek(options.isoWeek ?? options.iso_week),
    mode: options.mode === undefined ? 'shadow' : String(options.mode).trim().toLowerCase(),
    now: options.now ?? Date.now
  }
  if (!['shadow', 'primary'].includes(result.mode)) fail('PI_AUTOMATION_MODE_INVALID', 'mode must be shadow or primary')
  result.current = nowMs(result.now)
  return { ...options, ...result }
}

function validatePiAnalysisOptions(options) {
  const result = {
    provider: nonEmpty(options.provider, 'PI_AUTOMATION_PROVIDER_REQUIRED', 'provider', 128),
    model: nonEmpty(options.model, 'PI_AUTOMATION_MODEL_REQUIRED', 'model', 256)
  }
  if (options.timeoutMs !== undefined) {
    const timeoutMs = Number(options.timeoutMs)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('PI_AUTOMATION_TIMEOUT_INVALID', 'timeout-ms must be between 1 and 120000')
    result.timeoutMs = timeoutMs
  } else {
    result.timeoutMs = 30000
  }
  if (result.provider === SESSION_PROVIDER_ID) result.protocol = validateSessionProtocol(options.protocol)
  return { ...options, ...result }
}

export function validatePiAutomationOptions(options = {}) {
  return validatePiAnalysisOptions(validatePiAutomationBaseOptions(options))
}

function fixedOutput(target, value) {
  withFileLock(target, () => {
    writeJsonAtomic(target, value, { mode: 0o600 })
    try { fs.chmodSync(target, 0o600) } catch {}
  })
}

export function piShadowPaths(date, isoWeek) {
  const day = validDate(date)
  const week = validWeek(isoWeek)
  const stem = `pi-${day}-${week}`
  return Object.freeze({
    validation: path.join(PI_SHADOW_ROOT, `${stem}.json`),
    provenance: path.join(PI_SHADOW_ROOT, `${stem}.provenance.json`)
  })
}

/**
 * Weekly scheduler runs have a separate fixed receipt namespace.  Keeping
 * this distinct from a daily automation receipt means a weekly refresh can
 * be retried or inspected without overwriting a complete daily cycle.
 */
export function piWeeklyShadowPaths(date, isoWeek) {
  const day = validDate(date)
  const week = validWeek(isoWeek)
  const stem = `pi-weekly-${day}-${week}`
  return Object.freeze({
    validation: path.join(PI_SHADOW_ROOT, `${stem}.json`),
    provenance: path.join(PI_SHADOW_ROOT, `${stem}.provenance.json`)
  })
}

function safeSettlement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { outcome: 'SETTLED', submitted: 0, filled: 0 }
  return {
    outcome: String(value.outcome || 'SETTLED').slice(0, 80),
    ...(value.receipt_id ? { receipt_id: String(value.receipt_id).slice(0, 128) } : {}),
    ...(Number.isFinite(Number(value.events)) ? { events: Number(value.events) } : {}),
    submitted: 0,
    filled: 0
  }
}

// The public collectors call order-book depth `quantity`. At the Pi boundary
// that name is reserved for execution-owned sizing, so keep the public fact
// under an unambiguous market-data name before handing it to a worker.
function publicEvidenceValue(value) {
  if (Array.isArray(value)) return value.map(publicEvidenceValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key === 'quantity' ? 'level_size' : key === 'quantities' ? 'level_sizes' : key,
    publicEvidenceValue(child)
  ]))
}

function safeMarketSummary(snapshot) {
  const multi = snapshot.multi_exchange
  return {
    schema: snapshot.schema,
    generated_at: snapshot.generated_at,
    source: 'gate_public',
    ...(multi ? {
      multi_exchange: {
        schema: multi.schema,
        status: multi.status,
        adapter: publicEvidenceValue(multi.adapter),
        counts: publicEvidenceValue(multi.counts),
        aggregates: publicEvidenceValue(multi.aggregates),
        snapshot_hash: multi.snapshot_hash,
        source_path: multi.source_path
      }
    } : {})
  }
}

/** Build the only evidence shape allowed to cross into the Pi cluster. */
export function buildPiEvidence(snapshot, weekly, { date, isoWeek, iso_week } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.assets) fail('PI_AUTOMATION_MARKET_REQUIRED', 'A validated Gate public market snapshot is required')
  const evidence = {
    date: validDate(date || snapshot.date),
    iso_week: validWeek(isoWeek || iso_week || snapshot.iso_week),
    market: safeMarketSummary(snapshot),
    assets: {}
  }
  for (const asset of ASSETS) {
    if (!snapshot.assets[asset]) fail('PI_AUTOMATION_MARKET_ASSET_REQUIRED', `Market evidence is missing ${asset}`)
    evidence.assets[asset] = {
      market: publicEvidenceValue(snapshot.assets[asset]),
      weekly: weekly?.assets?.[asset] ? publicEvidenceValue(weekly.assets[asset]) : null
    }
  }
  try { validateSemanticOutput(evidence) } catch (error) {
    fail('PI_AUTOMATION_EVIDENCE_INVALID', safeText(error.message || error))
  }
  return evidence
}

function weeklyAnchorFromDisk(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'weekly')) return structuredClone(options.weekly)
  if (Object.prototype.hasOwnProperty.call(options, 'weeklyAnchor')) return structuredClone(options.weeklyAnchor)
  try {
    return readJsonStrict(WEEKLY_PATH, { missingDefault: null })
  } catch {
    return null
  }
}

function weeklyState(options, config) {
  const candidate = weeklyAnchorFromDisk(options)
  if (!candidate) return { document: null, refresh: true, reason: 'missing_or_corrupt' }
  try {
    validateCanonicalDocument(candidate, 'weekly')
    if (candidate.iso_week !== options.isoWeek || candidate.status !== 'active') return { document: null, refresh: true, reason: 'identity_or_status_mismatch' }
    const generated = Date.parse(candidate.generated_at)
    const current = options.current
    const maxAge = Number(config.analysis.weekly_anchor_max_age_days) * 86400000
    if (!Number.isFinite(generated) || new Date(generated).toISOString() !== candidate.generated_at || generated > current || !Number.isFinite(maxAge) || current - generated > maxAge) {
      return { document: null, refresh: true, reason: 'expired_or_invalid_time' }
    }
  } catch {
    return { document: null, refresh: true, reason: 'missing_or_corrupt' }
  }
  return { document: candidate, refresh: false, reason: 'reused' }
}

function clusterSummary(cluster, tier) {
  return {
    tier,
    run_id: cluster.runId,
    status: cluster.status,
    document_hash: sha256Hex(cluster.output),
    provenance: cluster.provenance ? structuredClone(cluster.provenance) : null
  }
}

function piProvenance(options, records, errors = []) {
  return {
    schema: PI_PROVENANCE_SCHEMA,
    adapter: '@tyche/pi-agents',
    provider: options.provider,
    ...(options.protocol ? { protocol: options.protocol } : {}),
    model: options.model,
    date: options.date,
    iso_week: options.isoWeek,
    runs: records,
    errors: errors.map((error) => ({ stage: error.stage, ...errorDetails(error.error || error) }))
  }
}

async function runTierCluster(options, tier, evidence) {
  const runner = options.runCluster || options.cluster || runPiCluster
  const input = {
    runId: `${options.runId || `pi-${options.date}-${options.isoWeek}`}:${tier}`,
    tier,
    date: options.date,
    isoWeek: options.isoWeek,
    provider: options.provider,
    ...(options.protocol ? { protocol: options.protocol } : {}),
    model: options.model,
    timeoutMs: options.timeoutMs,
    strategyPrompt: options.strategyPrompt || '',
    roleModels: options.roleModels,
    roleEfforts: options.roleEfforts,
    modelPool: options.modelPool,
    modelMode: options.modelMode,
    evidence
  }
  for (const key of ['providerEnv', 'workerEnv', 'baseEnv', 'workerPath', 'execPath', 'cwd']) {
    if (options[key] !== undefined) input[key] = options[key]
  }
  if (typeof options.onEvent === 'function') input.onEvent = options.onEvent
  if (typeof options.runJob === 'function') input.runJob = options.runJob
  else if (runner === runPiCluster && options.provider === 'fixture') input.runJob = fixtureWorker
  const cluster = await runner(input)
  if (!cluster || typeof cluster !== 'object' || cluster.schema !== 'tyche_pi_cluster/v1' || cluster.status !== 'ok' || !cluster.output) {
    fail(`PI_AUTOMATION_${tier.toUpperCase()}_BLOCKED`, `${tier} Pi cluster did not produce a successful canonical document`)
  }
  try {
    if (Array.isArray(cluster.results)) {
      for (const result of cluster.results) validateResult(result)
    }
    validateSemanticOutput(cluster.output)
    if (cluster.output.date !== options.date || cluster.output.iso_week !== options.isoWeek) fail('PI_CANONICAL_IDENTITY_MISMATCH', `${tier} cluster output does not match requested anchors`)
    validateCanonicalDocument(cluster.output, tier)
  } catch (error) {
    if (error instanceof PiAutomationError) throw error
    fail(`PI_AUTOMATION_${tier.toUpperCase()}_CANONICAL_INVALID`, safeText(error.message || error))
  }
  return structuredClone(cluster)
}

function blockedReceipt(options, settlement, details, provenance = null) {
  const reason = errorDetails(details.error || details, `Pi ${details.stage || 'automation'} failed`)
  return {
    schema: PI_AUTOMATION_SCHEMA,
    date: options.date,
    iso_week: options.isoWeek,
    provider: options.provider,
    ...(options.protocol ? { protocol: options.protocol } : {}),
    model: options.model,
    mode: options.mode,
    outcome: 'BLOCKED',
    phase: 'BLOCKED',
    blocked_stage: details.stage || 'automation',
    code: reason.code,
    message: reason.message,
    settlement: safeSettlement(settlement),
    automation_cycle: null,
    pi_provenance: provenance,
    submitted: 0,
    filled: 0
  }
}

function shadowReceipt(options, settlement, weeklyRecord, dailyRecord, provenance) {
  return {
    schema: PI_AUTOMATION_SCHEMA,
    date: options.date,
    iso_week: options.isoWeek,
    provider: options.provider,
    ...(options.protocol ? { protocol: options.protocol } : {}),
    model: options.model,
    mode: 'shadow',
    outcome: 'SHADOW_VALIDATED',
    phase: 'COMPLETE',
    settlement: safeSettlement(settlement),
    weekly: weeklyRecord,
    daily: dailyRecord,
    automation_cycle: null,
    pi_provenance: provenance,
    submitted: 0,
    filled: 0
  }
}

function validateAutomationCycle(cycle, options) {
  if (!cycle || typeof cycle !== 'object' || cycle.schema !== 'tyche_automation_cycle/v2') fail('PI_AUTOMATION_CYCLE_INVALID', 'Deterministic planner did not return a v2 automation cycle')
  if (cycle.date !== options.date || cycle.iso_week !== options.isoWeek || cycle.submitted !== 0 || cycle.filled !== 0) fail('PI_AUTOMATION_CYCLE_INVALID', 'Deterministic cycle identity or lifecycle counts are invalid')
  return cycle
}

function validateDailyHandoff(document, market, options) {
  if (document.generated_at !== market.generated_at || document.anchored_week !== options.isoWeek) {
    fail('PI_AUTOMATION_DAILY_ANCHOR_MISMATCH', 'Daily Pi output is not anchored to the collected market and ISO week')
  }
  if (document.execution_candidates.some((candidate) => candidate.data_as_of !== market.generated_at)) {
    fail('PI_AUTOMATION_DAILY_MARKET_DRIFT', 'Daily Pi candidates are not derived from the collected market timestamp')
  }
}

function defaultMarketWriter(snapshot) {
  writeJsonAtomic(MARKET_PATH, snapshot, { mode: 0o600 })
  try { fs.chmodSync(MARKET_PATH, 0o600) } catch {}
  const digest = sha256Hex(snapshot)
  const evidencePath = path.join(DATA_ROOT, 'paper', 'market', `${snapshot.date}-${digest.slice(0, 16)}.json`)
  writeJsonAtomic(evidencePath, { ...snapshot, snapshot_hash: digest }, { mode: 0o600 })
}

function defaultMultiWriter(snapshot) {
  writeJsonAtomic(MULTI_MARKET_PATH, snapshot, { mode: 0o600 })
  try { fs.chmodSync(MULTI_MARKET_PATH, 0o600) } catch {}
}

function previousCycle(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'previous')) return options.previous
  const piTarget = outputPath(options)
  if (fs.existsSync(piTarget)) {
    const previous = readJsonStrict(piTarget)
    if (previous?.automation_cycle) return previous.automation_cycle
  }
  const target = path.join(OUTPUT_ROOT, `automation-${options.date}.json`)
  if (fs.existsSync(target)) return readJsonStrict(target)
  return null
}

function outputPath(options) {
  return path.join(OUTPUT_ROOT, `pi-automation-${options.date}.json`)
}

function cycleGuardPath(options) {
  return path.join(OUTPUT_ROOT, `pi-automation-${options.date}-${options.isoWeek}.cycle`)
}

function serializePiCycle(key, task) {
  const previous = PI_CYCLE_QUEUES.get(key) || Promise.resolve()
  const current = previous.then(task, task)
  let tail
  tail = current.then(() => undefined, () => undefined).then(() => {
    if (PI_CYCLE_QUEUES.get(key) === tail) PI_CYCLE_QUEUES.delete(key)
  })
  PI_CYCLE_QUEUES.set(key, tail)
  return current
}

function weeklyOutputPath(options) {
  return path.join(OUTPUT_ROOT, `pi-weekly-${options.date}.json`)
}

function emitBlocked(options, receipt) {
  if (options.mode === 'shadow') {
    const paths = piShadowPaths(options.date, options.isoWeek)
    const provenance = receipt.pi_provenance || piProvenance(options, [], [{ stage: receipt.blocked_stage, error: receipt }])
    fixedOutput(paths.validation, receipt)
    fixedOutput(paths.provenance, provenance)
    return { ...receipt, result_path: path.relative(ROOT, paths.validation).split(path.sep).join('/'), provenance_path: path.relative(ROOT, paths.provenance).split(path.sep).join('/') }
  }
  const target = outputPath(options)
  fixedOutput(target, receipt)
  return { ...receipt, result_path: path.relative(ROOT, target).split(path.sep).join('/') }
}

/**
 * Run one Pi analysis cycle.  Settlement is deliberately performed before
 * any market collection or Pi invocation.  Pi only supplies semantic
 * documents; Node validates and persists them before deterministic paper
 * planning is allowed to run.
 */
async function runPiAutomationUnlocked(baseOptions) {
  const receiptOptions = { ...baseOptions, provider: null, model: null }
  let settlement = null
  let config = null
  try {
    const settleExisting = baseOptions.settleExisting || (() => settlePaper({ filePath: PAPER_PATH, now: baseOptions.now }))
    settlement = await settleExisting({ date: baseOptions.date, isoWeek: baseOptions.isoWeek, now: baseOptions.now })
  } catch (error) {
    return emitBlocked(receiptOptions, blockedReceipt(receiptOptions, settlement, { stage: 'settlement', error }))
  }
  if (['BLOCKED', 'FAILED'].includes(String(settlement?.outcome || '').toUpperCase())) {
    return emitBlocked(receiptOptions, blockedReceipt(receiptOptions, settlement, { stage: 'settlement', error: new Error('Paper settlement did not complete') }))
  }

  let options
  try {
    options = validatePiAnalysisOptions(baseOptions)
  } catch (error) {
    return emitBlocked(receiptOptions, blockedReceipt(receiptOptions, settlement, { stage: 'agent_config', error }))
  }

  // Settlement is the first side effect of a valid run.  The credential guard
  // follows it and runs before any market collector or Pi worker is launched.
  try {
    rejectPiMutationCredentials(options.env)
  } catch (error) {
    return emitBlocked(options, blockedReceipt(options, settlement, { stage: 'credential_guard', error }))
  }

  let weeklyInfo
  let prepared
  let marketSnapshot = null
  let multiSnapshot = null
  try {
    config = options.config || loadConfig({ filePath: options.configPath || DEFAULT_CONFIG_PATH })
    weeklyInfo = weeklyState(options, config)
    const collectMulti = options.collectMultiSnapshot || (options.multiExchangeSnapshot !== undefined
      ? async () => options.multiExchangeSnapshot
      : (anchors) => collectAllExchangeSnapshot({ ...anchors, exchanges: options.exchanges, channels: options.channels, concurrency: options.concurrency, timeoutMs: options.marketTimeoutMs }))
    const collectMarket = options.collectSnapshot || (options.marketSnapshot !== undefined
      ? async () => options.marketSnapshot
      : collectMarketSnapshot)
    prepared = await prepareAutomation({
      date: options.date,
      isoWeek: options.isoWeek,
      config,
      env: options.env,
      now: options.now,
      anchorRequired: weeklyInfo.refresh,
      settleExisting: async () => settlement,
      collectMultiSnapshot: async (anchors) => {
        multiSnapshot = await collectMulti(anchors)
        return multiSnapshot
      },
      collectSnapshot: async (anchors) => {
        marketSnapshot = await collectMarket(anchors)
        return marketSnapshot
      }
    })
    if (!prepared.multi_exchange || !multiSnapshot || !marketSnapshot) fail('PI_AUTOMATION_MARKET_REQUIRED', 'Both multi-exchange and Gate public snapshots are required')
  } catch (error) {
    return emitBlocked(options, blockedReceipt(options, settlement, { stage: 'market_preparation', error }))
  }

  const records = []
  const errors = []
  let weekly = weeklyInfo.document
  if (weeklyInfo.refresh) {
    try {
      const cluster = await runTierCluster(options, 'weekly', buildPiEvidence(marketSnapshot, null, options))
      weekly = cluster.output
      records.push({ ...clusterSummary(cluster, 'weekly'), action: 'refreshed' })
    } catch (error) {
      errors.push({ stage: 'weekly', error })
      records.push({ tier: 'weekly', action: 'refresh_failed', ...errorDetails(error) })
    }
  } else {
    records.push({ tier: 'weekly', action: 'reused', document_hash: sha256Hex(weekly) })
  }

  let daily = null
  try {
    const cluster = await runTierCluster(options, 'daily', buildPiEvidence(marketSnapshot, weekly, options))
    daily = cluster.output
    records.push({ ...clusterSummary(cluster, 'daily'), action: 'refreshed' })
  } catch (error) {
    errors.push({ stage: 'daily', error })
    records.push({ tier: 'daily', action: 'refresh_failed', ...errorDetails(error) })
  }

  if (daily) {
    try { validateDailyHandoff(daily, marketSnapshot, options) } catch (error) {
      errors.push({ stage: 'daily', error })
      daily = null
      records.push({ tier: 'daily', action: 'handoff_failed', ...errorDetails(error) })
    }
  }

  const provenance = piProvenance(options, records, errors)
  if (errors.length || !weekly || !daily) {
    const receipt = blockedReceipt(options, settlement, { stage: errors[0]?.stage || 'canonical', error: errors[0]?.error || new Error('Canonical documents were not produced') }, provenance)
    return emitBlocked(options, receipt)
  }

  // The scheduler may have observed a failed weekly claim for this ISO week.
  // Keep settlement and analysis available, but never allow that state to
  // reach deterministic paper planning or a later testnet handoff.
  if (options.weeklyBlocked === true) {
    const receipt = blockedReceipt(options, settlement, {
      stage: 'weekly_dependency',
      error: new Error('Weekly refresh failed; new entries are blocked for this cycle')
    }, provenance)
    return emitBlocked(options, receipt)
  }

  if (options.mode === 'shadow') {
    const receipt = shadowReceipt(options, settlement, { ...records.find((row) => row.tier === 'weekly'), document_hash: sha256Hex(weekly) }, { ...records.find((row) => row.tier === 'daily'), document_hash: sha256Hex(daily) }, provenance)
    const paths = piShadowPaths(options.date, options.isoWeek)
    fixedOutput(paths.validation, receipt)
    fixedOutput(paths.provenance, provenance)
    return { ...receipt, result_path: path.relative(ROOT, paths.validation).split(path.sep).join('/'), provenance_path: path.relative(ROOT, paths.provenance).split(path.sep).join('/') }
  }

  try {
    // Validate both documents before the first canonical write so a malformed
    // daily result can never replace an older weekly/daily pair.
    validateCanonicalDocument(weekly, 'weekly')
    validateCanonicalDocument(daily, 'daily')
    // Keep the collected market artifacts in memory until both Pi documents
    // have passed validation. A failed Pi run therefore cannot replace the
    // prior canonical market/analysis set.
    await (options.writeMultiSnapshot || defaultMultiWriter)(multiSnapshot)
    await (options.writeSnapshot || defaultMarketWriter)(marketSnapshot)
    const persist = options.persistCanonical || persistCanonicalDocument
    await persist(weekly, 'weekly')
    await persist(daily, 'daily')

    const paperLedger = options.paperLedger || readJsonStrict(PAPER_PATH)
    const configPath = options.configPath || DEFAULT_CONFIG_PATH
    const cycle = validateAutomationCycle(await (options.runPlanning || runAutomationPlanning)({
      date: options.date,
      isoWeek: options.isoWeek,
      config,
      daily,
      weekly,
      market: marketSnapshot,
      paperLedger,
      env: options.env,
      previous: previousCycle(options),
      now: options.now,
      planProduct: options.planProduct || createAutomationPlanner(configPath),
      applyPlan: options.applyPlan || createAutomationApplicator(configPath)
    }), options)
    const receipt = {
      schema: PI_AUTOMATION_SCHEMA,
      date: options.date,
      iso_week: options.isoWeek,
      provider: options.provider,
      ...(options.protocol ? { protocol: options.protocol } : {}),
      model: options.model,
      mode: 'primary',
      outcome: cycle.outcome,
      phase: cycle.phase,
      settlement: safeSettlement(settlement),
      automation_cycle: cycle,
      pi_provenance: provenance,
      submitted: 0,
      filled: 0
    }
    const target = outputPath(options)
    fixedOutput(target, receipt)
    return { ...receipt, result_path: path.relative(ROOT, target).split(path.sep).join('/') }
  } catch (error) {
    const receipt = blockedReceipt(options, settlement, { stage: 'primary', error }, provenance)
    return emitBlocked(options, receipt)
  }
}

/**
 * Serialize a date/week cycle across both processes and same-process callers.
 * The Promise queue is important: withFileLockAsync must never be reached
 * while another caller is synchronously waiting in the same event loop.
 */
export async function runPiAutomation(rawOptions = {}) {
  const options = validatePiAutomationBaseOptions(rawOptions)
  const key = `${options.date}:${options.isoWeek}`
  return serializePiCycle(key, () => withFileLockAsync(cycleGuardPath(options), () => runPiAutomationUnlocked(options)))
}

export const runPiAutomationCycle = runPiAutomation

/**
 * Run only the weekly Pi DAG.  This is intentionally separate from the full
 * daily automation path: it never settles paper state, never invokes the
 * daily DAG, and never invokes a planner, applier, or testnet module.
 */
export async function runPiWeeklyRefresh(rawOptions = {}) {
  const options = validatePiAutomationOptions(rawOptions)
  let config = null
  let marketSnapshot = null
  let multiSnapshot = null

  try {
    // The credential guard is the first action in this no-settlement path.
    rejectPiMutationCredentials(options.env)
    config = options.config || loadConfig({ filePath: options.configPath || DEFAULT_CONFIG_PATH })
    const collectMulti = options.collectMultiSnapshot || (options.multiExchangeSnapshot !== undefined
      ? async () => options.multiExchangeSnapshot
      : (anchors) => collectAllExchangeSnapshot({ ...anchors, exchanges: options.exchanges, channels: options.channels, concurrency: options.concurrency, timeoutMs: options.marketTimeoutMs }))
    const collectMarket = options.collectSnapshot || (options.marketSnapshot !== undefined
      ? async () => options.marketSnapshot
      : collectMarketSnapshot)
    const prepared = await prepareAutomation({
      date: options.date,
      isoWeek: options.isoWeek,
      config,
      env: options.env,
      now: options.now,
      anchorRequired: true,
      collectMultiSnapshot: async (anchors) => {
        multiSnapshot = await collectMulti(anchors)
        return multiSnapshot
      },
      collectSnapshot: async (anchors) => {
        marketSnapshot = await collectMarket(anchors)
        return marketSnapshot
      }
    })
    if (!prepared.multi_exchange || !multiSnapshot || !marketSnapshot) fail('PI_AUTOMATION_MARKET_REQUIRED', 'Both multi-exchange and Gate public snapshots are required')
  } catch (error) {
    const receipt = {
      schema: 'tyche_pi_weekly_refresh/v1',
      date: options.date,
      iso_week: options.isoWeek,
      provider: options.provider,
      ...(options.protocol ? { protocol: options.protocol } : {}),
      model: options.model,
      mode: options.mode,
      outcome: 'BLOCKED',
      phase: 'BLOCKED',
      blocked_stage: error?.code === 'PI_AUTOMATION_MUTATION_CREDENTIAL_PRESENT' ? 'credential_guard' : 'market_preparation',
      code: errorDetails(error).code,
      message: errorDetails(error).message,
      weekly: null,
      pi_provenance: piProvenance(options, [{ tier: 'weekly', action: 'not_run' }], [{ stage: 'weekly', error }]),
      submitted: 0,
      filled: 0
    }
    if (options.mode === 'shadow') {
      const paths = piWeeklyShadowPaths(options.date, options.isoWeek)
      fixedOutput(paths.validation, receipt)
      fixedOutput(paths.provenance, receipt.pi_provenance)
      return { ...receipt, result_path: path.relative(ROOT, paths.validation).split(path.sep).join('/'), provenance_path: path.relative(ROOT, paths.provenance).split(path.sep).join('/') }
    }
    const target = weeklyOutputPath(options)
    fixedOutput(target, receipt)
    return { ...receipt, result_path: path.relative(ROOT, target).split(path.sep).join('/') }
  }

  const records = []
  let weekly
  try {
    const cluster = await runTierCluster(options, 'weekly', buildPiEvidence(marketSnapshot, null, options))
    weekly = cluster.output
    records.push({ ...clusterSummary(cluster, 'weekly'), action: 'refreshed' })
  } catch (error) {
    records.push({ tier: 'weekly', action: 'refresh_failed', ...errorDetails(error) })
    const provenance = piProvenance(options, records, [{ stage: 'weekly', error }])
    const receipt = {
      schema: 'tyche_pi_weekly_refresh/v1',
      date: options.date,
      iso_week: options.isoWeek,
      provider: options.provider,
      ...(options.protocol ? { protocol: options.protocol } : {}),
      model: options.model,
      mode: options.mode,
      outcome: 'BLOCKED',
      phase: 'BLOCKED',
      blocked_stage: 'weekly',
      code: errorDetails(error).code,
      message: errorDetails(error).message,
      weekly: null,
      pi_provenance: provenance,
      submitted: 0,
      filled: 0
    }
    if (options.mode === 'shadow') {
      const paths = piWeeklyShadowPaths(options.date, options.isoWeek)
      fixedOutput(paths.validation, receipt)
      fixedOutput(paths.provenance, provenance)
      return { ...receipt, result_path: path.relative(ROOT, paths.validation).split(path.sep).join('/'), provenance_path: path.relative(ROOT, paths.provenance).split(path.sep).join('/') }
    }
    const target = weeklyOutputPath(options)
    fixedOutput(target, receipt)
    return { ...receipt, result_path: path.relative(ROOT, target).split(path.sep).join('/') }
  }

  const provenance = piProvenance(options, records)
  const record = { tier: 'weekly', action: 'refreshed', document_hash: sha256Hex(weekly) }
  const receipt = {
    schema: 'tyche_pi_weekly_refresh/v1',
    date: options.date,
    iso_week: options.isoWeek,
    provider: options.provider,
    ...(options.protocol ? { protocol: options.protocol } : {}),
    model: options.model,
    mode: options.mode,
    outcome: options.mode === 'shadow' ? 'SHADOW_VALIDATED' : 'WEEKLY_REFRESHED',
    phase: 'COMPLETE',
    weekly: record,
    pi_provenance: provenance,
    submitted: 0,
    filled: 0
  }
  if (options.mode === 'shadow') {
    const paths = piWeeklyShadowPaths(options.date, options.isoWeek)
    fixedOutput(paths.validation, receipt)
    fixedOutput(paths.provenance, provenance)
    return { ...receipt, result_path: path.relative(ROOT, paths.validation).split(path.sep).join('/'), provenance_path: path.relative(ROOT, paths.provenance).split(path.sep).join('/') }
  }

  try {
    validateCanonicalDocument(weekly, 'weekly')
    const persist = options.persistCanonical || persistCanonicalDocument
    await persist(weekly, 'weekly')
    const target = weeklyOutputPath(options)
    fixedOutput(target, receipt)
    return { ...receipt, result_path: path.relative(ROOT, target).split(path.sep).join('/') }
  } catch (error) {
    const blocked = {
      schema: 'tyche_pi_weekly_refresh/v1',
      date: options.date,
      iso_week: options.isoWeek,
      provider: options.provider,
      ...(options.protocol ? { protocol: options.protocol } : {}),
      model: options.model,
      mode: options.mode,
      outcome: 'BLOCKED',
      phase: 'BLOCKED',
      blocked_stage: 'weekly_persist',
      code: errorDetails(error).code,
      message: errorDetails(error).message,
      weekly: null,
      pi_provenance: provenance,
      submitted: 0,
      filled: 0
    }
    const target = weeklyOutputPath(options)
    fixedOutput(target, blocked)
    return { ...blocked, result_path: path.relative(ROOT, target).split(path.sep).join('/') }
  }
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const allowed = new Set(['--date', '--iso-week', '--provider', '--model', '--mode', '--config', '--timeout-ms'])
  const unknown = values.filter((value) => value.startsWith('--') && !allowed.has(value))
  if (unknown.length) fail('PI_AUTOMATION_ARGUMENT_FORBIDDEN', `Unsupported arguments: ${[...new Set(unknown)].join(', ')}`)
  const consumed = new Set()
  const get = (flag, fallback = null) => {
    const indexes = values.map((value, index) => value === flag ? index : -1).filter((index) => index >= 0)
    if (indexes.length > 1) fail('PI_AUTOMATION_ARGUMENT_DUPLICATE', `${flag} may be supplied only once`)
    if (!indexes.length) return fallback
    consumed.add(indexes[0])
    const value = values[indexes[0] + 1]
    if (!value || value.startsWith('--')) fail('PI_AUTOMATION_ARGUMENT_INVALID', `${flag} requires a value`)
    consumed.add(indexes[0] + 1)
    return value
  }
  const parsed = {
    date: get('--date'),
    isoWeek: get('--iso-week'),
    provider: get('--provider'),
    model: get('--model'),
    mode: get('--mode', 'shadow'),
    configPath: get('--config', DEFAULT_CONFIG_PATH),
    timeoutMs: Number(get('--timeout-ms', '30000'))
  }
  const positional = values.filter((value, index) => !consumed.has(index) && !value.startsWith('--'))
  if (positional.length) fail('PI_AUTOMATION_ARGUMENT_INVALID', `Unexpected positional argument: ${positional[0]}`)
  return parsed
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const args = parseArgs(process.argv)
    runPiAutomation({ ...args, env: process.env }).then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (result.outcome === 'BLOCKED') process.exitCode = 2
    }).catch((error) => {
      process.stdout.write(`${JSON.stringify({ outcome: 'BLOCKED', code: error.code || 'PI_AUTOMATION_ERROR', message: safeText(error.message || error), submitted: 0, filled: 0 }, null, 2)}\n`)
      process.exitCode = 1
    })
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: 'BLOCKED', code: error.code || 'PI_AUTOMATION_ERROR', message: safeText(error.message || error), submitted: 0, filled: 0 }, null, 2)}\n`)
    process.exitCode = 1
  }
}
