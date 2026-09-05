#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import {
  SESSION_API_KEY_ENV,
  SESSION_ENDPOINT_ENV,
  SESSION_MODEL_IDS,
  SESSION_PROVIDER_ID,
  buildWorkerEnv,
  createSessionProviderRuntime,
  discussSessionStrategy
} from '../packages/pi-agents/src/index.mjs'
import { createControlPlane, LOOPBACK_HOST } from '../apps/control-plane/src/control-plane.mjs'
import {
  EXECUTOR_SOCKET_PATHS,
  readTycheClusterState,
  projectClusterEvent,
  resolveClusterConfigPath,
  STATIC_ROOT,
  summarizeDag,
  summarizeCycle,
  writeTycheClusterState
} from './tyche-cluster.mjs'
import { rejectPiMutationCredentials, runPiAutomation } from './pi-automation.mjs'
import { createPaperSetupAdapter } from './control-paper-setup.mjs'

const FLAGS = new Set(['--port', '--provider', '--model', '--mode', '--config', '--testnet-venue'])
const VENUES = new Set(['gate', 'binance'])

class ControlChildError extends Error {
  constructor(code, message) {
    super(message || code)
    this.code = code
  }
}

function fail(code, message) {
  throw new ControlChildError(code, message)
}

function required(value, flag, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('CONTROL_CHILD_ARGUMENT_REQUIRED', `${flag} requires a non-empty value`)
  return value.trim()
}

function startupProviderPair(providerValue, modelValue) {
  const hasProvider = providerValue !== undefined && providerValue !== null && String(providerValue).trim() !== ''
  const hasModel = modelValue !== undefined && modelValue !== null && String(modelValue).trim() !== ''
  if (hasProvider !== hasModel) fail('CONTROL_CHILD_PROVIDER_PAIR_REQUIRED', '--provider and --model must be supplied together')
  if (!hasProvider) return { provider: null, model: null }
  return {
    provider: required(providerValue, '--provider', 128),
    model: required(modelValue, '--model')
  }
}

export function parseControlPlaneArgs(argv) {
  const values = argv.slice(2)
  const output = {}
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index]
    if (!FLAGS.has(flag)) fail('CONTROL_CHILD_ARGUMENT_UNKNOWN', `unsupported argument: ${flag}`)
    if (Object.prototype.hasOwnProperty.call(output, flag)) fail('CONTROL_CHILD_ARGUMENT_DUPLICATE', `${flag} may be supplied only once`)
    const value = values[++index]
    if (!value || value.startsWith('--')) fail('CONTROL_CHILD_ARGUMENT_VALUE_REQUIRED', `${flag} requires a value`)
    output[flag] = value
  }
  const { provider, model } = startupProviderPair(output['--provider'], output['--model'])
  const mode = String(output['--mode'] || 'shadow').trim().toLowerCase()
  if (!['shadow', 'primary'].includes(mode)) fail('CONTROL_CHILD_MODE_INVALID', 'mode must be shadow or primary')
  const port = Number(output['--port'] || 8788)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('CONTROL_CHILD_PORT_INVALID', 'port is invalid')
  const configPath = resolveClusterConfigPath(output['--config'])
  const testnetVenue = output['--testnet-venue'] ? String(output['--testnet-venue']).trim().toLowerCase() : null
  if (testnetVenue !== null && !VENUES.has(testnetVenue)) fail('CONTROL_CHILD_VENUE_INVALID', 'testnet venue must be gate or binance')
  return { provider, model, mode, port, configPath, testnetVenue }
}

function manualCycleProjection(result) {
  const summary = summarizeCycle(result)
  return {
    ok: String(result?.outcome || '').toUpperCase() !== 'BLOCKED',
    date: summary.date,
    iso_week: summary.iso_week,
    outcome: summary.outcome,
    phase: summary.phase,
    ...(summary.blocked_stage ? { blocked_stage: summary.blocked_stage } : {}),
    ...(result?.code ? { code: String(result.code).slice(0, 100) } : {}),
    ...(result?.message ? { message: String(result.message).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 320) } : {}),
    cycle_hash: summary.cycle_hash,
    plan_hash: summary.plan_hash,
    reused: summary.reused,
    submitted: 0,
    filled: 0
  }
}

function redactSessionValue(value, secrets, seen = new WeakMap()) {
  if (typeof value === 'string') {
    let output = value
    for (const secret of secrets) if (secret) output = output.split(secret).join('[session-secret-redacted]')
    return output
  }
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (Buffer.isBuffer(value)) return '[session-secret-redacted]'
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return seen.get(value)
  const output = Array.isArray(value) ? [] : {}
  seen.set(value, output)
  if (Array.isArray(value)) {
    for (const child of value) output.push(redactSessionValue(child, secrets, seen))
  } else {
    for (const [key, child] of Object.entries(value)) output[key] = redactSessionValue(child, secrets, seen)
  }
  return output
}

function sessionSecretValues(apiKey, endpoint) {
  const rawEndpoint = String(endpoint || '')
  let parsed
  try {
    parsed = new URL(rawEndpoint)
  } catch {
    fail('CONTROL_CHILD_SESSION_PROVIDER_INVALID', 'Session provider configuration is invalid')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    fail('CONTROL_CHILD_SESSION_PROVIDER_INVALID', 'Session provider configuration is invalid')
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/u, '')
  return [...new Set([
    String(apiKey || ''),
    rawEndpoint,
    parsed.href,
    `${parsed.origin}${pathname}`,
    parsed.origin,
    parsed.hostname
  ].filter(Boolean))].sort((left, right) => right.length - left.length)
}

export async function startControlPlaneChild(rawOptions = {}) {
  if (Object.hasOwn(rawOptions, 'staticRoot')) fail('CONTROL_CHILD_STATIC_ROOT_FORBIDDEN', 'static root is fixed to apps/web/dist')
  const { provider, model } = startupProviderPair(rawOptions.provider, rawOptions.model)
  const mode = String(rawOptions.mode || 'shadow').trim().toLowerCase()
  if (!['shadow', 'primary'].includes(mode)) fail('CONTROL_CHILD_MODE_INVALID', 'mode must be shadow or primary')
  const port = Number(rawOptions.port ?? 8788)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('CONTROL_CHILD_PORT_INVALID', 'port is invalid')
  const configPath = resolveClusterConfigPath(rawOptions.configPath)
  const testnetVenue = rawOptions.testnetVenue ? String(rawOptions.testnetVenue).trim().toLowerCase() : null
  if (testnetVenue !== null && !VENUES.has(testnetVenue)) fail('CONTROL_CHILD_VENUE_INVALID', 'testnet venue must be gate or binance')
  const options = { provider, model, mode, port, configPath, testnetVenue }
  const paperSetup = createPaperSetupAdapter({ configPath })
  const processEnvironment = rawOptions.env || process.env
  rejectPiMutationCredentials(processEnvironment)
  const stateReader = typeof rawOptions.stateReader === 'function' ? rawOptions.stateReader : readTycheClusterState
  const stateWriter = typeof rawOptions.stateWriter === 'function' ? rawOptions.stateWriter : writeTycheClusterState
  const runAutomation = typeof rawOptions.runPiAutomation === 'function' ? rawOptions.runPiAutomation : runPiAutomation
  const providerRuntimeFactory = typeof rawOptions.providerRuntimeFactory === 'function'
    ? rawOptions.providerRuntimeFactory
    : createSessionProviderRuntime
  const safeBaseEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ']
    .filter((key) => typeof processEnvironment[key] === 'string' && processEnvironment[key])
    .map((key) => [key, processEnvironment[key]]))
  let bootstrapToken = null
  let plane
  const controlPlaneFactory = typeof rawOptions.controlPlaneFactory === 'function' ? rawOptions.controlPlaneFactory : createControlPlane
  plane = controlPlaneFactory({
    host: LOOPBACK_HOST,
    port: options.port,
    // The web bundle is a fixed server asset. createControlPlane performs its
    // real-directory/index.html startup checks before binding.
    staticRoot: STATIC_ROOT,
    executorSockets: EXECUTOR_SOCKET_PATHS,
    onBootstrapToken: (token) => { bootstrapToken = token },
    adapters: {
      status: stateReader,
      cycle: () => stateReader().recent_cycle || { status: 'empty' },
      dag: () => stateReader().dag,
      paper: () => stateReader().paper,
      paperSetupStatus: paperSetup.status,
      setupPaper: paperSetup.setup,
      discussStrategy: async (input, runtime) => {
        const connection = { endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), modelId: runtime.model, ...(rawOptions.lookup ? { lookup: rawOptions.lookup } : {}), ...(rawOptions.fetchImpl ? { fetchImpl: rawOptions.fetchImpl } : {}) }
        try { return await discussSessionStrategy(input, connection, { runtimeFactory: providerRuntimeFactory }) } finally { connection.apiKey = ''; connection.endpoint = '' }
      },
      validateProviderConfig: async (runtime) => {
        if (!runtime || runtime.provider !== SESSION_PROVIDER_ID || !SESSION_MODEL_IDS.includes(runtime.model) || !Buffer.isBuffer(runtime.apiKey)) {
          fail('CONTROL_CHILD_SESSION_PROVIDER_INVALID', 'Session provider configuration is invalid')
        }
        const temporary = {
          endpoint: String(runtime.endpoint || ''),
          apiKey: runtime.apiKey.toString('utf8'),
          modelId: runtime.model,
          ...(rawOptions.lookup ? { lookup: rawOptions.lookup } : {}),
          ...(rawOptions.fetchImpl ? { fetchImpl: rawOptions.fetchImpl } : {})
        }
        try {
          await providerRuntimeFactory(temporary)
          return { ok: true }
        } catch (error) {
          const code = typeof error?.code === 'string' && error.code.startsWith('PI_')
            ? error.code
            : 'CONTROL_CHILD_SESSION_PROVIDER_INVALID'
          fail(code, 'Session provider configuration is invalid')
        } finally {
          temporary.apiKey = ''
          temporary.endpoint = ''
          delete temporary.apiKey
          delete temporary.endpoint
        }
      },
      runCycle: async ({ date, isoWeek }, runtime) => {
        // This adapter is intentionally one-shot analysis/paper only. It has
        // no path to the scheduled executor sequence in tyche-cluster.
        if (!runtime || runtime.provider !== SESSION_PROVIDER_ID || !SESSION_MODEL_IDS.includes(runtime.model) || !Buffer.isBuffer(runtime.apiKey)) {
          fail('CONTROL_CHILD_SESSION_PROVIDER_INVALID', 'Session provider configuration is invalid')
        }
        const temporary = {
          [SESSION_API_KEY_ENV]: runtime.apiKey.toString('utf8'),
          [SESSION_ENDPOINT_ENV]: String(runtime.endpoint || '')
        }
        const sessionSecrets = sessionSecretValues(temporary[SESSION_API_KEY_ENV], temporary[SESSION_ENDPOINT_ENV])
        const workerEnv = buildWorkerEnv({
          provider: SESSION_PROVIDER_ID,
          baseEnv: safeBaseEnv,
          providerEnv: temporary
        })
        let result
        try {
          try {
            result = await runAutomation({
              date,
              isoWeek,
              provider: runtime.provider,
              model: runtime.model,
              mode: 'primary',
              configPath: paperSetup.configPath(),
              strategyPrompt: runtime.strategyPrompt || '',
              roleModels: runtime.roleModels,
              env: workerEnv,
              workerEnv,
              onEvent: (event) => plane.publish(redactSessionValue(projectClusterEvent({ type: 'dag_role', data: event }), sessionSecrets))
            })
          } catch (error) {
            result = {
              outcome: 'BLOCKED',
              phase: 'BLOCKED',
              date,
              iso_week: isoWeek,
              blocked_stage: 'manual_cycle',
              code: typeof error?.code === 'string' ? error.code.slice(0, 100) : 'CONTROL_CHILD_CYCLE_FAILED',
              message: 'Manual paper cycle failed'
            }
          }
          // The state writer sits outside the HTTP response redaction layer.
          // Sanitize the complete result before any persistence or event path.
          result = redactSessionValue(result, sessionSecrets)
        } finally {
          temporary[SESSION_API_KEY_ENV] = ''
          temporary[SESSION_ENDPOINT_ENV] = ''
          workerEnv[SESSION_API_KEY_ENV] = ''
          workerEnv[SESSION_ENDPOINT_ENV] = ''
          delete temporary[SESSION_API_KEY_ENV]
          delete temporary[SESSION_ENDPOINT_ENV]
          delete workerEnv[SESSION_API_KEY_ENV]
          delete workerEnv[SESSION_ENDPOINT_ENV]
          sessionSecrets.fill('')
        }
        stateWriter({ recent_cycle: result, paper: result, dag: { daily: summarizeDag(result).daily } })
        plane.publish({ type: 'cycle', data: manualCycleProjection(result) })
        return manualCycleProjection(result)
      }
    }
  })
  const info = await plane.start()
  process.on('message', (message) => {
    if (!message || message.type !== 'publish' || !message.event || typeof message.event !== 'object') return
    const event = message.event
    plane.publish(projectClusterEvent(event))
  })
  process.stdout.write(`${JSON.stringify({ ok: true, host: info.host, port: info.port, bootstrap_token: bootstrapToken })}\n`)
  const stop = async () => {
    await plane.stop()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // The bootstrap token is delivered only in the controlled ready frame to
  // the parent process; never expose it through this helper's return value.
  return { plane, info: { host: info.host, port: info.port } }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const args = parseControlPlaneArgs(process.argv)
    await startControlPlaneChild(args)
  } catch (error) {
    process.stderr.write(`${error.code || 'CONTROL_CHILD_START_FAILED'}: ${String(error.message || error)}\n`)
    process.exitCode = 1
  }
}
