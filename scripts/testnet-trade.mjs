#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBinanceClient } from './binance-rest.mjs'
import { executionConfigForVenue, loadConfig, validateConfig } from './config.mjs'
import { createGateClient } from './gate-rest.mjs'
import {
  AUTOMATIC_TESTNET_AUTHORIZATION,
  acquirePlanningContext,
  createPlan,
  executePlan,
  readLedger,
  reduceLedger,
  verifyPlan
} from './gate-trade.mjs'
import { renderConciseReport, reportFromExecution } from './concise-report.mjs'
import { readJsonStrict, updateJsonLocked, writeJsonAtomic, writeTextAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EMPTY_LEDGER = Object.freeze({ schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] })
const VENUES = new Set(['gate', 'binance'])

export class TestnetTradeError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'TestnetTradeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new TestnetTradeError(code, message, details)
}

function venueName(value) {
  const venue = String(value || '').trim().toLowerCase()
  if (!VENUES.has(venue)) fail('TESTNET_VENUE_UNSUPPORTED', 'Venue must be gate or binance')
  return venue
}

function safeDate(value) {
  const text = String(value || '').trim()
  const parsed = new Date(`${text}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail('TESTNET_DATE_INVALID', 'date must be a real YYYY-MM-DD value')
  return text
}

function safeWeek(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(text)) fail('TESTNET_WEEK_INVALID', 'iso-week must use YYYY-Www')
  return text
}

function venueSettings(config, venue) {
  validateConfig(config)
  const settings = venue === 'gate' ? config.gate : config.binance
  if (settings.submission_mode !== 'automatic_testnet') fail('AUTOMATIC_TESTNET_LOCKED', `${venue} requires submission_mode=automatic_testnet in a local configuration`)
  if (settings.enabled !== true || settings.usdm.enabled !== true || settings.usdm.environment !== 'testnet') fail('AUTOMATIC_TESTNET_SCOPE_INVALID', `${venue} automatic execution requires enabled USDT-M testnet scope`)
  return settings
}

export function ledgerPathForVenue(venue, dataDirectory = path.join(ROOT, 'data', 'testnet')) {
  return path.join(dataDirectory, `${venueName(venue)}_order_ledger.json`)
}

function defaultPaths(venue) {
  return {
    ledgerPath: ledgerPathForVenue(venue),
    killPath: path.join(ROOT, venue === 'gate' ? 'data/gate_KILL' : 'data/binance_KILL'),
    weeklyPath: path.join(ROOT, 'data', 'crypto_strategy.json'),
    marketPath: path.join(ROOT, 'data', 'crypto_market.json'),
    dailyPath: path.join(ROOT, 'data', 'crypto_daily.json')
  }
}

function makeClient(venue, options = {}) {
  if (options.client) return options.client
  return venue === 'gate'
    ? createGateClient({ product: 'usdm', environment: 'testnet', readOnly: options.readOnly === true })
    : createBinanceClient({ environment: 'testnet', readOnly: options.readOnly === true })
}

function assertClientScope(client, venue) {
  const reportedVenue = String(client?.venue || '').trim().toLowerCase()
  const product = String(client?.product || '').trim().toLowerCase()
  const environment = String(client?.environment || '').trim().toLowerCase()
  if (reportedVenue && reportedVenue !== venue) fail('TESTNET_CLIENT_VENUE_MISMATCH', 'Injected client venue does not match the requested executor')
  if (product && product !== 'usdm') fail('TESTNET_CLIENT_PRODUCT_MISMATCH', 'Automatic testnet execution requires a USDT-M client')
  if (environment && environment !== 'testnet') fail('TESTNET_CLIENT_ENVIRONMENT_MISMATCH', 'Automatic testnet execution requires a testnet client')
  return client
}

function selectedSymbols(source) {
  const supported = new Set(['BTC_USDT', 'ETH_USDT'])
  return [...new Set((source?.execution_candidates || []).map((candidate) => String(candidate?.symbol || '').toUpperCase()).filter((symbol) => supported.has(symbol)))]
}

function persistPlan(ledgerPath, plan, reconciliation) {
  updateJsonLocked(ledgerPath, (current) => {
    let next = current || EMPTY_LEDGER
    if (reconciliation) next = reduceLedger(next, { kind: 'RECONCILIATION', reconciliation })
    return reduceLedger(next, { kind: 'PLAN', plan })
  }, { missingDefault: EMPTY_LEDGER })
}

function planReport(plan, planPath, ledgerPath) {
  return renderConciseReport({
    title: `${plan.venue} USDT-M testnet plan ${plan.status}`,
    as_of: plan.created_at,
    scope: { venue: plan.venue, product: plan.product, environment: plan.environment },
    conclusions: [plan.status === 'READY' ? 'A sealed automatic-testnet plan is ready.' : plan.status === 'NO_ACTION' ? 'No actionable candidate was present.' : 'The plan is blocked and cannot execute.'],
    execution: { mode: 'automatic_testnet_plan', planned_orders: plan.intents.map((intent) => ({ symbol: intent.symbol, product: intent.product, position_intent: intent.action, entry_price: intent.price })), events: [], submitted: 0, filled: 0, rejected: 0, cancelled: 0 },
    recommendations: [],
    blockers: plan.blockers,
    risks: ['Testnet orders exercise real exchange state but do not authorize production mutations.'],
    audit_artifacts: [{ label: 'Sealed plan', path: path.relative(ROOT, planPath).split(path.sep).join('/') }, { label: 'Venue ledger', path: path.relative(ROOT, ledgerPath).split(path.sep).join('/') }]
  })
}

export async function planAutomaticTestnet(options = {}) {
  const venue = venueName(options.venue)
  const config = options.config || loadConfig({ filePath: options.configPath })
  const settings = venueSettings(config, venue)
  const engineConfig = executionConfigForVenue(config, venue)
  const date = safeDate(options.date)
  const isoWeek = safeWeek(options.isoWeek)
  const defaults = defaultPaths(venue)
  const ledgerPath = options.ledgerPath || defaults.ledgerPath
  const killPath = options.killPath || path.join(ROOT, settings.kill_switch_path)
  if (fs.existsSync(killPath)) fail('TESTNET_KILL_ACTIVE', `${venue} kill switch blocks new plans`)
  const source = options.source || readJsonStrict(options.sourcePath || defaults.dailyPath)
  const weeklyAnchor = options.weeklyAnchor || readJsonStrict(options.weeklyPath || defaults.weeklyPath)
  const marketSnapshot = options.marketSnapshot || readJsonStrict(options.marketPath || defaults.marketPath)
  const ledger = readLedger(ledgerPath)
  const client = assertClientScope(makeClient(venue, { client: options.client, readOnly: true }), venue)
  const context = await acquirePlanningContext({
    product: 'usdm',
    environment: 'testnet',
    config: engineConfig,
    symbols: selectedSymbols(source),
    ledger,
    now: options.now,
    clientFactory: async () => client
  })
  const plan = createPlan(source, {
    venue,
    product: 'usdm',
    environment: 'testnet',
    config: engineConfig,
    context,
    ledger,
    date,
    isoWeek,
    weeklyAnchor,
    marketSnapshot,
    now: options.now
  })
  persistPlan(ledgerPath, plan, context.reconciliation)
  const planPath = options.planPath || path.join(ROOT, 'outputs', 'plans', `${venue}-testnet-plan-${plan.plan_id}.json`)
  const reportPath = options.reportPath || path.join(ROOT, 'outputs', 'reports', `${venue}-testnet-plan-${plan.plan_id}.md`)
  writeJsonAtomic(planPath, plan)
  writeTextAtomic(reportPath, planReport(plan, planPath, ledgerPath))
  return {
    outcome: plan.status,
    venue,
    product: 'usdm',
    environment: 'testnet',
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    intents: plan.intents.length,
    blockers: plan.blockers,
    skipped: plan.skipped,
    plan,
    plan_path: planPath,
    report_path: reportPath,
    ledger_path: ledgerPath,
    submitted: 0,
    filled: 0
  }
}

export async function executeAutomaticTestnetPlan(options = {}) {
  const venue = venueName(options.venue)
  const config = options.config || loadConfig({ filePath: options.configPath })
  const settings = venueSettings(config, venue)
  const engineConfig = executionConfigForVenue(config, venue)
  const defaults = defaultPaths(venue)
  const ledgerPath = options.ledgerPath || defaults.ledgerPath
  const killPath = options.killPath || path.join(ROOT, settings.kill_switch_path)
  const plan = options.plan || readJsonStrict(options.planPath)
  const verified = verifyPlan(plan, { planId: plan.plan_id, planHash: plan.plan_hash, planTtlSeconds: engineConfig.gate.plan_ttl_seconds, now: options.now })
  if (!verified.ok) return { outcome: 'BLOCKED', venue, product: 'usdm', environment: 'testnet', ...verified, submitted: 0, filled: 0 }
  if (String(plan.venue || '') !== venue) return { outcome: 'BLOCKED', venue, product: 'usdm', environment: 'testnet', code: 'PLAN_VENUE_MISMATCH', message: 'Sealed plan venue does not match the requested executor', submitted: 0, filled: 0 }
  const weeklyAnchor = options.weeklyAnchor || readJsonStrict(options.weeklyPath || defaults.weeklyPath)
  const marketSnapshot = options.marketSnapshot || readJsonStrict(options.marketPath || defaults.marketPath)
  const executionSource = options.executionSource || options.source || readJsonStrict(options.sourcePath || defaults.dailyPath)
  const client = assertClientScope(makeClient(venue, { client: options.client, readOnly: false }), venue)
  const result = await executePlan(plan, {
    config: engineConfig,
    client,
    planId: plan.plan_id,
    planHash: plan.plan_hash,
    executionMode: 'automatic_testnet',
    automaticAuthorization: AUTOMATIC_TESTNET_AUTHORIZATION,
    venue,
    ledgerPath,
    killPath,
    marketSnapshot,
    weeklyAnchor,
    executionSource,
    now: options.now,
    sleep: options.sleep
  })
  const execution = { ...result, execution_mode: 'automatic_testnet' }
  const reportPath = options.reportPath || path.join(ROOT, 'outputs', 'reports', `${venue}-testnet-execution-${plan.plan_id}.md`)
  writeTextAtomic(reportPath, renderConciseReport(reportFromExecution(execution)))
  return { ...execution, venue, report_path: reportPath, ledger_path: ledgerPath, submitted: result.counts?.submitted || 0, filled: result.counts?.filled || 0 }
}

export async function runAutomaticTestnetCycle(options = {}) {
  const planned = await planAutomaticTestnet(options)
  if (planned.outcome !== 'READY') return { ...planned, phase: planned.outcome === 'BLOCKED' ? 'BLOCKED' : 'COMPLETE' }
  const execution = await executeAutomaticTestnetPlan({
    ...options,
    venue: planned.venue,
    plan: planned.plan,
    planPath: planned.plan_path,
    ledgerPath: planned.ledger_path,
    executionSource: options.executionSource || options.source
  })
  return { schema: 'tyche_testnet_cycle/v1', phase: ['BLOCKED', 'RECONCILE_RED'].includes(execution.outcome) ? 'BLOCKED' : 'COMPLETE', venue: planned.venue, plan: { plan_id: planned.plan_id, plan_hash: planned.plan_hash, plan_path: planned.plan_path }, execution }
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const command = values[0]
  if (!['plan', 'execute', 'cycle', 'status'].includes(command)) fail('TESTNET_COMMAND_UNSUPPORTED', 'Commands: plan, execute, cycle, status')
  if (values.includes('--live') || values.includes('--production') || values.includes('--prod')) fail('PRODUCTION_EXECUTION_UNSUPPORTED', 'Production mutations are not implemented')
  const allowed = new Set(['--venue', '--config', '--source', '--date', '--iso-week', '--plan'])
  const unknown = values.filter((value) => value.startsWith('--') && !allowed.has(value))
  if (unknown.length) fail('TESTNET_ARGUMENT_FORBIDDEN', `Unsupported arguments: ${[...new Set(unknown)].join(', ')}`)
  const get = (flag, fallback = null) => {
    const indexes = values.map((value, index) => value === flag ? index : -1).filter((index) => index >= 0)
    if (indexes.length > 1) fail('TESTNET_DUPLICATE_FLAG', `${flag} may be supplied only once`)
    if (!indexes.length) return fallback
    const value = values[indexes[0] + 1]
    if (!value || value.startsWith('--')) fail('TESTNET_ARGUMENT_INVALID', `${flag} requires a value`)
    return value
  }
  return { command, venue: get('--venue'), configPath: get('--config', path.join(ROOT, 'config', 'tyche.json')), sourcePath: get('--source'), date: get('--date'), isoWeek: get('--iso-week'), planPath: get('--plan') }
}

function printable(result) {
  const copy = structuredClone(result)
  delete copy.plan
  for (const key of ['plan_path', 'report_path', 'ledger_path']) if (copy[key]) copy[key] = path.relative(ROOT, copy[key]).split(path.sep).join('/')
  return copy
}

async function cli(argv) {
  const args = parseArgs(argv)
  const venue = venueName(args.venue)
  const config = loadConfig({ filePath: args.configPath })
  if (args.command === 'status') {
    const settings = venue === 'gate' ? config.gate : config.binance
    const ledgerPath = ledgerPathForVenue(venue)
    const ledger = readLedger(ledgerPath)
    return { outcome: 'STATUS', venue, environment: settings.usdm.environment, submission_mode: settings.submission_mode, plans: ledger.plans.length, events: ledger.events.length, fills: ledger.fills.length, ledger_path: ledgerPath }
  }
  if (args.command === 'execute') {
    if (!args.planPath) fail('TESTNET_PLAN_REQUIRED', 'execute requires --plan')
    return executeAutomaticTestnetPlan({ venue, config, planPath: args.planPath, sourcePath: args.sourcePath || undefined })
  }
  if (!args.sourcePath || !args.date || !args.isoWeek) fail('TESTNET_PLAN_INPUT_REQUIRED', `${args.command} requires --source, --date, and --iso-week`)
  return args.command === 'plan'
    ? planAutomaticTestnet({ venue, config, sourcePath: args.sourcePath, date: args.date, isoWeek: args.isoWeek })
    : runAutomaticTestnetCycle({ venue, config, sourcePath: args.sourcePath, date: args.date, isoWeek: args.isoWeek })
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = await cli(process.argv)
    process.stdout.write(`${JSON.stringify(printable(result), null, 2)}\n`)
    if (['BLOCKED', 'RECONCILE_RED'].includes(result.outcome) || result.phase === 'BLOCKED') process.exitCode = 2
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: 'BLOCKED', code: error.code || 'TESTNET_TRADE_ERROR', message: String(error.message || error), submitted: 0, filled: 0 }, null, 2)}\n`)
    process.exitCode = 2
  }
}
