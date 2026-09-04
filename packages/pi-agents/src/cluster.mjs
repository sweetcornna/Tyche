import { randomUUID } from 'node:crypto'
import { validateCanonicalDocument as validateAgentWriteCanonicalDocument } from '../../../scripts/agent-write.mjs'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_TIMEOUT_MS,
  PROVENANCE_SCHEMA,
  ROLES,
  assertResultMatchesJob,
  errorCode,
  errorMessage,
  makeJob,
  makeResult,
  validateJob,
  validateResult,
  validateSemanticOutput
} from './protocol.mjs'
import { runWorkerProcess } from './worker-client.mjs'

const ANALYST_ROLES = Object.freeze(['btc-analyst', 'eth-analyst'])
const PREFLIGHT_KEYS = new Set(['status', 'evidence_refs', 'blockers'])
const MAX_PREFLIGHT_ITEMS = 32
const MAX_PREFLIGHT_STRING = 256

function requiredString(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`PI_${name.toUpperCase()}_REQUIRED`)
  return value
}

function validateClusterOptions(options) {
  requiredString(options.date, 'date', 32)
  requiredString(options.isoWeek, 'isoWeek', 32)
  requiredString(options.provider, 'provider', 128)
  requiredString(options.model, 'model', 256)
  if (!['weekly', 'daily'].includes(options.tier || options.mode)) throw new Error('PI_TIER_REQUIRED')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`PI_TIMEOUT_RANGE:${MAX_TIMEOUT_MS}`)
  if (options.evidence === undefined || options.evidence === null || typeof options.evidence !== 'object' || Array.isArray(options.evidence)) throw new Error('PI_EVIDENCE_REQUIRED')
  if (!options.evidence.assets || typeof options.evidence.assets !== 'object' || Array.isArray(options.evidence.assets) || !Object.prototype.hasOwnProperty.call(options.evidence.assets, 'BTC') || !Object.prototype.hasOwnProperty.call(options.evidence.assets, 'ETH')) throw new Error('PI_ASSET_EVIDENCE_REQUIRED')
  if (options.runJob !== undefined && typeof options.runJob !== 'function') throw new Error('PI_RUNNER_REQUIRED')
  const runId = options.runId || randomUUID()
  requiredString(runId, 'runId', 256)
  return { ...options, tier: options.tier || options.mode, timeoutMs, runId }
}

function emitEvent(options, role, asset, attempt, status) {
  if (typeof options.onEvent !== 'function') return
  const event = Object.freeze({
    runId: options.runId,
    tier: options.tier,
    role,
    asset: asset ?? null,
    attempt,
    status
  })
  try {
    const pending = options.onEvent(event)
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
  } catch {}
}

function withTimeout(runJob, job, timeoutMs) {
  const controller = new AbortController()
  let timer
  let timedOut = false
  const operation = Promise.resolve().then(() => runJob(job, { signal: controller.signal }))
  // A runner may ignore the signal. Its late settlement is deliberately
  // observed only to avoid an unhandled rejection and is never returned.
  operation.catch(() => {})
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error(`PI_WORKER_TIMEOUT:${timeoutMs}`))
    }, timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => {
    clearTimeout(timer)
    if (timedOut) controller.abort()
  })
}

function jobInput(role, options, inputs) {
  if (role === 'orchestrator') return { evidence: options.evidence }
  if (role === 'preflight') return { coordination: inputs.orchestrator, evidence: options.evidence }
  if (role === 'btc-analyst' || role === 'eth-analyst') {
    const asset = role === 'btc-analyst' ? 'BTC' : 'ETH'
    const assets = options.evidence.assets
    if (!assets || typeof assets !== 'object' || Array.isArray(assets) || !Object.prototype.hasOwnProperty.call(assets, asset)) {
      throw new Error(`PI_ASSET_EVIDENCE_REQUIRED:${asset}`)
    }
    return { preflight: inputs.preflight, asset, assetEvidence: assets[asset] }
  }
  if (role === 'synthesizer') return { preflight: inputs.preflight, btc: inputs.btc, eth: inputs.eth }
  if (role === 'reviewer') return { preflight: inputs.preflight, synthesis: inputs.synthesis }
  return {}
}

function createRoleJob(options, role, asset, attempt, inputs) {
  return makeJob({
    jobId: `${options.runId}:${role}`,
    runId: options.runId,
    role,
    asset,
    tier: options.tier,
    date: options.date,
    isoWeek: options.isoWeek,
    provider: options.provider,
    model: options.model,
    attempt,
    timeoutMs: options.timeoutMs,
    input: jobInput(role, options, inputs)
  })
}

function validateCanonicalDocumentShape(value, tier, date, isoWeek) {
  try {
    validateAgentWriteCanonicalDocument(value, tier)
  } catch (error) {
    throw new Error(`PI_CANONICAL_DOCUMENT:${error?.message || 'invalid canonical document'}`)
  }
  if (value.date !== date || value.iso_week !== isoWeek) throw new Error('PI_CANONICAL_DOCUMENT_IDENTITY')
  return value
}

function boundedStringArray(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_PREFLIGHT_ITEMS || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > MAX_PREFLIGHT_STRING)) {
    throw new Error(`PI_PREFLIGHT_${label.toUpperCase()}_INVALID`)
  }
  return [...value]
}

function projectPreflight(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PI_PREFLIGHT_OUTPUT_REQUIRED')
  if (typeof value.status !== 'string' || !value.status.trim() || value.status.length > MAX_PREFLIGHT_STRING) throw new Error('PI_PREFLIGHT_STATUS_INVALID')
  const projection = {
    status: value.status,
    evidence_refs: boundedStringArray(value.evidence_refs, 'evidence_refs'),
    blockers: boundedStringArray(value.blockers, 'blockers')
  }
  // Explicitly construct the projection so unknown preflight output cannot
  // become analyst input, even when it is otherwise schema-valid JSON.
  for (const key of Object.keys(projection)) if (!PREFLIGHT_KEYS.has(key)) delete projection[key]
  return projection
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function validateRoleOutput(role, options, output) {
  if (role === 'preflight') return projectPreflight(output)
  if (role === 'synthesizer' || role === 'reviewer') return validateCanonicalDocumentShape(output, options.tier, options.date, options.isoWeek)
  if (role === 'btc-analyst' || role === 'eth-analyst') {
    const expectedAsset = role === 'btc-analyst' ? 'BTC' : 'ETH'
    if (output.asset !== undefined && output.asset !== expectedAsset) throw new Error(`PI_ANALYST_ASSET_MISMATCH:${expectedAsset}`)
    if (options.tier === 'weekly' && output.execution_candidates !== undefined && (!Array.isArray(output.execution_candidates) || output.execution_candidates.length !== 0)) throw new Error('PI_WEEKLY_CANDIDATES_FORBIDDEN')
  }
  return output
}

async function runRole(options, role, asset, inputs, runJob) {
  let finalResult
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const job = createRoleJob(options, role, asset, attempt, inputs)
    emitEvent(options, role, asset, attempt, 'started')
    try {
      const raw = await withTimeout(runJob, job, options.timeoutMs)
      if (Array.isArray(raw)) throw new Error('PI_DUPLICATE_RESULT')
      const result = assertResultMatchesJob(validateResult(raw), job)
      finalResult = result
      if (result.status === 'ok') {
        validateSemanticOutput(result.output)
        const output = validateRoleOutput(role, options, result.output)
        if (output !== result.output) {
          result.output = output
          validateResult(result)
        }
        emitEvent(options, role, asset, attempt, 'completed')
        return result
      }
      emitEvent(options, role, asset, attempt, 'failed')
    } catch (error) {
      finalResult = makeResult(job, {
        status: 'error',
        code: errorCode(error),
        message: errorMessage(error)
      })
      emitEvent(options, role, asset, attempt, 'failed')
    }
  }
  return finalResult
}

function resultOutput(result) {
  return result?.status === 'ok' ? result.output : null
}

function blockedResult(options, results, reason) {
  const ordered = ROLES.map((role) => results[role]).filter(Boolean)
  return {
    schema: 'tyche_pi_cluster/v1',
    runId: options.runId,
    tier: options.tier,
    date: options.date,
    isoWeek: options.isoWeek,
    status: 'blocked',
    output: null,
    blockers: [reason],
    results: ordered,
    provenance: provenance(options, ordered)
  }
}

function provenance(options, results) {
  return {
    schema: PROVENANCE_SCHEMA,
    adapter: '@tyche/pi-agents',
    piAgentCore: '0.84.4',
    piAi: '0.84.4',
    provider: options.provider,
    model: options.model,
    roles: [...ROLES],
    attempts: results.map((result) => ({ role: result.role, attempt: result.attempt, status: result.status }))
  }
}

export async function runCluster(inputOptions) {
  const options = validateClusterOptions(inputOptions || {})
  const results = {}
  const runner = options.runJob || ((job, context = {}) => runWorkerProcess(job, {
    providerEnv: options.providerEnv,
    baseEnv: options.workerEnv || options.baseEnv,
    timeoutMs: options.timeoutMs,
    workerPath: options.workerPath,
    execPath: options.execPath,
    cwd: options.cwd,
    signal: context.signal
  }))
  const inputs = {}

  const orchestrator = await runRole(options, 'orchestrator', null, inputs, runner)
  results.orchestrator = orchestrator
  if (orchestrator.status !== 'ok') return blockedResult(options, results, 'orchestrator_failed')
  inputs.orchestrator = resultOutput(orchestrator)

  const preflight = await runRole(options, 'preflight', null, inputs, runner)
  results.preflight = preflight
  if (preflight.status !== 'ok') return blockedResult(options, results, 'preflight_failed')
  inputs.preflight = resultOutput(preflight)
  if (inputs.preflight.status === 'blocked' || inputs.preflight.blockers.length > 0) return blockedResult(options, results, 'preflight_failed')

  const [btc, eth] = await Promise.all([
    runRole(options, 'btc-analyst', 'BTC', inputs, runner),
    runRole(options, 'eth-analyst', 'ETH', inputs, runner)
  ])
  results['btc-analyst'] = btc
  results['eth-analyst'] = eth
  if (btc.status !== 'ok' || eth.status !== 'ok') return blockedResult(options, results, 'asset_analysis_failed')
  inputs.btc = resultOutput(btc)
  inputs.eth = resultOutput(eth)

  const synthesis = await runRole(options, 'synthesizer', null, inputs, runner)
  results.synthesizer = synthesis
  if (synthesis.status !== 'ok') return blockedResult(options, results, 'synthesis_failed')
  inputs.synthesis = resultOutput(synthesis)

  const reviewer = await runRole(options, 'reviewer', null, inputs, runner)
  results.reviewer = reviewer
  if (reviewer.status !== 'ok') return blockedResult(options, results, 'review_failed')
  if (stableSerialize(reviewer.output) !== stableSerialize(synthesis.output)) return blockedResult(options, results, 'review_output_mismatch')

  const ordered = ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer'].map((role) => results[role])
  return {
    schema: 'tyche_pi_cluster/v1',
    runId: options.runId,
    tier: options.tier,
    date: options.date,
    isoWeek: options.isoWeek,
    status: 'ok',
    output: reviewer.output,
    blockers: [],
    results: ordered,
    provenance: provenance(options, ordered)
  }
}

export { ANALYST_ROLES, MAX_TIMEOUT_MS }
