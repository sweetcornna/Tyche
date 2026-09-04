#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { buildWorkerEnv } from '../packages/pi-agents/src/env.mjs'
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

function parseArgs(argv) {
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
  const provider = required(output['--provider'], '--provider', 128)
  const model = required(output['--model'], '--model')
  const mode = String(output['--mode'] || 'shadow').trim().toLowerCase()
  if (!['shadow', 'primary'].includes(mode)) fail('CONTROL_CHILD_MODE_INVALID', 'mode must be shadow or primary')
  const port = Number(output['--port'] || 8788)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('CONTROL_CHILD_PORT_INVALID', 'port is invalid')
  const configPath = resolveClusterConfigPath(output['--config'])
  const testnetVenue = output['--testnet-venue'] ? String(output['--testnet-venue']).trim().toLowerCase() : null
  if (testnetVenue !== null && !VENUES.has(testnetVenue)) fail('CONTROL_CHILD_VENUE_INVALID', 'testnet venue must be gate or binance')
  return { provider, model, mode, port, configPath, testnetVenue }
}

function adapterState() {
  return readTycheClusterState()
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
    cycle_hash: summary.cycle_hash,
    plan_hash: summary.plan_hash,
    reused: summary.reused,
    submitted: 0,
    filled: 0
  }
}

export async function startControlPlaneChild(rawOptions = {}) {
  if (Object.hasOwn(rawOptions, 'staticRoot')) fail('CONTROL_CHILD_STATIC_ROOT_FORBIDDEN', 'static root is fixed to apps/web/dist')
  const provider = required(rawOptions.provider, '--provider', 128)
  const model = required(rawOptions.model, '--model')
  const mode = String(rawOptions.mode || 'shadow').trim().toLowerCase()
  if (!['shadow', 'primary'].includes(mode)) fail('CONTROL_CHILD_MODE_INVALID', 'mode must be shadow or primary')
  const port = Number(rawOptions.port ?? 8788)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('CONTROL_CHILD_PORT_INVALID', 'port is invalid')
  const configPath = resolveClusterConfigPath(rawOptions.configPath)
  const testnetVenue = rawOptions.testnetVenue ? String(rawOptions.testnetVenue).trim().toLowerCase() : null
  if (testnetVenue !== null && !VENUES.has(testnetVenue)) fail('CONTROL_CHILD_VENUE_INVALID', 'testnet venue must be gate or binance')
  const options = { provider, model, mode, port, configPath, testnetVenue }
  rejectPiMutationCredentials(process.env)
  const workerEnv = buildWorkerEnv({ provider: options.provider, baseEnv: process.env })
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
      status: adapterState,
      cycle: () => adapterState().recent_cycle || { status: 'empty' },
      dag: () => adapterState().dag,
      paper: () => adapterState().paper,
      runCycle: async ({ date, isoWeek }) => {
        // This adapter is intentionally one-shot analysis/paper only. It has
        // no path to the scheduled executor sequence in tyche-cluster.
        let result
        try {
          result = await runPiAutomation({
            date,
            isoWeek,
            provider: options.provider,
            model: options.model,
            mode: options.mode,
            configPath: options.configPath,
            env: workerEnv,
            workerEnv,
            onEvent: (event) => plane.publish(projectClusterEvent({ type: 'dag_role', data: event }))
          })
        } catch (error) {
          result = { outcome: 'BLOCKED', phase: 'BLOCKED', date, iso_week: isoWeek, blocked_stage: 'manual_cycle', code: error.code || 'CONTROL_CHILD_CYCLE_FAILED' }
        }
        writeTycheClusterState({ recent_cycle: result, paper: result, dag: { daily: summarizeDag(result).daily } })
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
    const args = parseArgs(process.argv)
    await startControlPlaneChild(args)
  } catch (error) {
    process.stderr.write(`${error.code || 'CONTROL_CHILD_START_FAILED'}: ${String(error.message || error)}\n`)
    process.exitCode = 1
  }
}
