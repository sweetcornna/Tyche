#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateCanonicalDocument } from './agent-write.mjs'
import { loadConfig, validateConfig } from './config.mjs'
import { renderConciseReport } from './concise-report.mjs'
import { collectMarketSnapshot } from './crypto-market.mjs'
import { collectAllExchangeSnapshot, exchangeCatalog, validateMultiExchangeSnapshot } from './multi-exchange-market.mjs'
import { sha256Hex, verifyPlan } from './gate-trade.mjs'
import { validatePaperLedger } from './paper-trade.mjs'
import { readJsonStrict, withFileLockAsync, writeJsonAtomic, writeTextAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAILY_PATH = path.join(ROOT, 'data', 'crypto_daily.json')
const MARKET_PATH = path.join(ROOT, 'data', 'crypto_market.json')
const WEEKLY_PATH = path.join(ROOT, 'data', 'crypto_strategy.json')
const PAPER_PATH = path.join(ROOT, 'data', 'paper', 'active.json')
const MULTI_MARKET_PATH = path.join(ROOT, 'data', 'crypto_multi_exchange.json')
const MUTATION_CREDENTIALS = Object.freeze([
  'GATE_USDM_TESTNET_API_KEY',
  'GATE_USDM_TESTNET_SECRET_KEY',
  'BINANCE_USDM_TESTNET_API_KEY',
  'BINANCE_USDM_TESTNET_SECRET_KEY'
])
const PRODUCTS = Object.freeze(['usdm'])
const PLAN_OUTCOMES = new Set(['READY', 'NO_ACTION', 'BLOCKED'])

export class AutomationError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'AutomationError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new AutomationError(code, message, details)
}

function date(value) {
  const text = String(value || '')
  const parsed = new Date(`${text}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    fail('AUTOMATION_DATE_INVALID', 'date must be a real YYYY-MM-DD value')
  }
  return text
}

function week(value) {
  const text = String(value || '')
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(text)) fail('AUTOMATION_WEEK_INVALID', 'iso-week must use YYYY-Www')
  return text
}

function rejectMutationCredentials(environment = (typeof process === 'object' && process?.env ? process.env : {})) {
  const present = MUTATION_CREDENTIALS.filter((name) => String(environment?.[name] || '').trim())
  if (present.length) fail('AUTOMATION_MUTATION_CREDENTIAL_PRESENT', `Automated planning refuses mutation credentials: ${present.join(',')}`)
}

function validateMarketSnapshot(snapshot, anchors) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.schema !== 'tyche_crypto_market/v1') {
    fail('AUTOMATION_MARKET_INVALID', 'Canonical public market snapshot is missing or invalid')
  }
  if (snapshot.date !== anchors.date || snapshot.iso_week !== anchors.isoWeek) {
    fail('AUTOMATION_MARKET_ANCHOR_MISMATCH', 'Market snapshot does not match the requested date and ISO week')
  }
  if (!Number.isFinite(Date.parse(snapshot.generated_at))) fail('AUTOMATION_MARKET_TIME_INVALID', 'Market snapshot generated_at is invalid')
  const assetKeys = snapshot.assets && typeof snapshot.assets === 'object' && !Array.isArray(snapshot.assets)
    ? Object.keys(snapshot.assets)
    : []
  if (assetKeys.length !== 2 || !assetKeys.includes('BTC') || !assetKeys.includes('ETH')) {
    fail('AUTOMATION_MARKET_SCOPE_INVALID', 'Market snapshot assets must be exactly BTC and ETH')
  }
  if (snapshot.assets.BTC?.symbol !== 'BTC_USDT' || snapshot.assets.ETH?.symbol !== 'ETH_USDT') {
    fail('AUTOMATION_MARKET_SYMBOL_INVALID', 'Market snapshot symbol identity is invalid')
  }
  for (const asset of ['BTC', 'ETH']) {
    if (!snapshot.assets[asset]?.spot || typeof snapshot.assets[asset].spot !== 'object' || !snapshot.assets[asset]?.usdm || typeof snapshot.assets[asset].usdm !== 'object') {
      fail('AUTOMATION_MARKET_PRODUCT_INVALID', `Market snapshot ${asset} block must contain Spot and USDT-M public data`)
    }
  }
  if (snapshot.multi_exchange !== undefined) {
    const multi = snapshot.multi_exchange
    if (!multi || multi.schema !== 'tyche_multi_exchange_summary/v1' || !['COMPLETE', 'PARTIAL'].includes(multi.status) || !/^[a-f0-9]{64}$/.test(String(multi.snapshot_hash || '')) || !multi.counts || !multi.aggregates || multi.source_path !== 'data/crypto_multi_exchange.json') fail('AUTOMATION_MULTI_MARKET_INVALID', 'Multi-exchange market summary is invalid')
  }
  return snapshot
}

function enabledProducts(config) {
  if (config.gate.enabled !== true) fail('AUTOMATION_GATE_DISABLED', 'Gate integration is disabled')
  const products = PRODUCTS.filter((product) => config.gate[product].enabled === true)
  if (!products.length) fail('AUTOMATION_PRODUCTS_DISABLED', 'No automated planning product is enabled')
  const unsafe = products.filter((product) => config.gate[product].environment !== 'dry-run')
  if (unsafe.length) fail('AUTOMATION_DRY_RUN_REQUIRED', `Automated planning requires dry-run configuration for: ${unsafe.join(',')}`)
  return products
}

export function automationDoctor(options = {}) {
  rejectMutationCredentials(options.env)
  const config = options.config
  validateConfig(config)
  const usdm = config.gate.usdm
  const caps = ['configured_leverage', 'risk_per_trade_bps', 'max_order_notional_usdt', 'daily_new_notional_cap_usdt', 'max_managed_notional_usdt']
  const paperConfigReady = config.gate.submission_mode === 'locked' && usdm.enabled === true && usdm.environment === 'dry-run' && caps.every((key) => Number(usdm[key]) > 0)
  const nodeParts = String(options.nodeVersion || process.versions.node).split('.').map(Number)
  const nodeReady = nodeParts[0] > 22 || (nodeParts[0] === 22 && nodeParts[1] >= 19)
  const catalog = options.catalog || exchangeCatalog()
  let paperReady = false
  let paperCode = options.paperReadCode || null
  if (options.paperLedger) {
    try {
      const ledger = validatePaperLedger(options.paperLedger)
      paperReady = ledger.config_digest === sha256Hex(config)
      if (!paperReady) paperCode = 'PAPER_CONFIG_DRIFT'
    } catch (error) {
      paperCode = error.code || 'PAPER_LEDGER_INVALID'
    }
  } else if (!paperCode) paperCode = 'PAPER_NOT_INITIALIZED'
  const checks = [
    { name: 'node_runtime', ok: nodeReady, detail: nodeReady ? `Node ${options.nodeVersion || process.versions.node}` : 'Node 22.19 or newer is required' },
    { name: 'ccxt_registry', ok: Number(catalog.exchange_count) > 0, detail: `${catalog.exchange_count || 0} registered exchanges; dependency ${catalog.dependency_pin || 'unknown'}` },
    { name: 'paper_configuration', ok: paperConfigReady, detail: paperConfigReady ? 'locked dry-run limits are explicit' : 'set positive leverage and all USDT-M risk/notional limits in a local locked dry-run config' },
    { name: 'paper_ledger', ok: paperReady, detail: paperReady ? 'active ledger matches configuration' : paperCode }
  ]
  const ready = checks.every((check) => check.ok)
  return {
    schema: 'tyche_automation_doctor/v1',
    outcome: ready ? 'READY' : 'SETUP_REQUIRED',
    checks,
    next_steps: ready ? ['Run automation prepare for the required date and ISO week.'] : [
      ...(!paperConfigReady ? ['Create config/tyche.local.json with explicit positive USDT-M paper limits.'] : []),
      ...(!paperReady ? ['Initialize data/paper/active.json with npm run paper -- init and explicit user values.'] : []),
      ...(!nodeReady ? ['Upgrade Node.js to 22.19 or newer.'] : [])
    ],
    submitted: 0,
    filled: 0
  }
}

function normalizePlanResult(product, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('AUTOMATION_PLAN_RESULT_INVALID', `${product} planner did not return an object`)
  if (result.product !== product || result.environment !== 'dry-run') fail('AUTOMATION_PLAN_SCOPE_INVALID', `${product} planner returned the wrong product or environment`)
  if (!PLAN_OUTCOMES.has(result.outcome)) fail('AUTOMATION_PLAN_OUTCOME_INVALID', `${product} planner returned unsupported outcome ${String(result.outcome || '')}`)
  if (result.submitted !== 0 || result.filled !== 0) {
    fail('AUTOMATION_LIFECYCLE_CONFLICT', `${product} dry-run planner claimed venue lifecycle activity`)
  }
  if (!/^tp-\d{8}-[a-f0-9]{12}$/.test(String(result.plan_id || '')) || !/^[a-f0-9]{64}$/.test(String(result.plan_hash || ''))) {
    fail('AUTOMATION_PLAN_IDENTITY_INVALID', `${product} planner did not return a sealed plan identity`)
  }
  if (result.plan_path !== `outputs/plans/gate-plan-${result.plan_id}.json`) {
    fail('AUTOMATION_PLAN_PATH_INVALID', `${product} planner returned an invalid plan path`)
  }
  if (result.report_path !== `outputs/reports/gate-plan-${result.plan_id}.md`) {
    fail('AUTOMATION_REPORT_PATH_INVALID', `${product} planner returned an invalid report path`)
  }
  if (!Number.isInteger(result.intents) || result.intents < 0 || !Array.isArray(result.blockers) || !Array.isArray(result.skipped)) {
    fail('AUTOMATION_PLAN_RESULT_INVALID', `${product} planner returned invalid intent, blocker, or skip data`)
  }
  return {
    product,
    environment: 'dry-run',
    outcome: result.outcome,
    plan_id: result.plan_id,
    plan_hash: result.plan_hash,
    intents: result.intents,
    blockers: result.blockers,
    skipped: result.skipped,
    plan_path: result.plan_path,
    report_path: result.report_path,
    submitted: 0,
    filled: 0
  }
}

function cycleOutcome(plans) {
  if (plans.some((plan) => plan.outcome === 'BLOCKED')) return 'BLOCKED'
  if (plans.some((plan) => plan.outcome === 'READY')) return 'READY'
  return 'NO_ACTION'
}

function cycleIdentity(validated, paperStateDigest) {
  return `tac_${sha256Hex({ date: validated.date, iso_week: validated.isoWeek, weekly: validated.proofs.weekly, daily: validated.proofs.daily, market: validated.proofs.market, paper_policy: validated.proofs.paper_policy, paper_state_digest: paperStateDigest }).slice(0, 32)}`
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validatePaperReceipt(receipt, plan, paperPolicy) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('AUTOMATION_PAPER_RECEIPT_INVALID', 'Paper apply returned an invalid receipt')
  const withoutHash = { ...receipt }
  delete withoutHash.receipt_hash
  const withoutIdentity = { ...withoutHash }
  delete withoutIdentity.receipt_id
  if (receipt.schema !== 'tyche_paper_apply_receipt/v1' || receipt.account_id !== paperPolicy.account_id || receipt.plan_id !== plan.plan_id || receipt.plan_hash !== plan.plan_hash || receipt.submitted !== 0 || receipt.filled !== 0 || !/^par_[a-f0-9]{24}$/.test(String(receipt.receipt_id || '')) || !/^[a-f0-9]{64}$/.test(String(receipt.receipt_hash || '')) || !/^[a-f0-9]{64}$/.test(String(receipt.paper_ledger_digest || '')) || receipt.receipt_id !== `par_${sha256Hex(withoutIdentity).slice(0, 24)}` || receipt.receipt_hash !== sha256Hex(withoutHash)) {
    fail('AUTOMATION_PAPER_RECEIPT_INVALID', 'Paper apply receipt identity, scope, or digest is invalid')
  }
  return receipt
}

function expectedPhaseHistory(planningOutcome) {
  return ['PREPARED', 'ANCHOR_READY', 'ANALYZED', 'PLANNED', ...(planningOutcome === 'READY' ? ['PAPER_APPLIED'] : []), ...(planningOutcome === 'BLOCKED' ? ['BLOCKED'] : ['COMPLETE'])]
}

function cycleSeal(cycle) {
  const body = { ...cycle, reused: false }
  delete body.cycle_hash
  return sha256Hex(body)
}

function reusableCycle(previous, validated) {
  if (!previous || previous.schema !== 'tyche_automation_cycle/v2') return null
  const allowed = new Set(['schema', 'cycle_id', 'cycle_hash', 'date', 'iso_week', 'source_generated_at', 'created_at', 'mode', 'phase', 'phase_history', 'outcome', 'products', 'proofs', 'paper_receipt', 'simulated_filled_contracts', 'submitted', 'filled', 'reused'])
  const missing = [...allowed].filter((key) => !Object.prototype.hasOwnProperty.call(previous, key))
  const extra = Object.keys(previous).filter((key) => !allowed.has(key))
  if (missing.length || extra.length) fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', `Existing automation cycle shape is invalid: missing=${missing.join(',')}; extra=${extra.join(',')}`)
  if (previous.date !== validated.date || previous.iso_week !== validated.isoWeek || previous.source_generated_at !== validated.daily.generated_at) {
    return null
  }
  if (previous.mode !== 'automatic_usdm_paper' || !['COMPLETE', 'BLOCKED'].includes(previous.phase) || previous.submitted !== 0 || previous.filled !== 0 || typeof previous.reused !== 'boolean' || !Array.isArray(previous.phase_history) || previous.cycle_hash !== cycleSeal(previous)) {
    fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Existing automation cycle violates the dry-run lifecycle boundary')
  }
  const proofKeys = ['weekly', 'daily', 'market', 'paper_policy', 'paper_state_before_digest', 'paper_state_after_digest', 'plans', 'paper_receipt']
  if (!previous.proofs || typeof previous.proofs !== 'object' || Array.isArray(previous.proofs) || Object.keys(previous.proofs).some((key) => !proofKeys.includes(key)) || proofKeys.some((key) => !Object.prototype.hasOwnProperty.call(previous.proofs, key))) fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Existing automation cycle proof shape is invalid')
  if (!sameValue(previous.proofs.weekly, validated.proofs.weekly) || !sameValue(previous.proofs.daily, validated.proofs.daily) || !sameValue(previous.proofs.market, validated.proofs.market) || !sameValue(previous.proofs.paper_policy, validated.proofs.paper_policy)) return null
  if (![previous.proofs.paper_state_before_digest, previous.proofs.paper_state_after_digest].includes(validated.paperStateDigest)) return null
  if (previous.cycle_id !== cycleIdentity(validated, previous.proofs.paper_state_before_digest)) fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Existing automation cycle identity does not match its sealed pre-cycle state')
  if (!Array.isArray(previous.products) || previous.products.length !== validated.products.length) {
    fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Existing automation cycle has invalid product coverage')
  }
  const productKeys = new Set(['product', 'environment', 'outcome', 'plan_id', 'plan_hash', 'intents', 'blockers', 'skipped', 'plan_path', 'report_path', 'submitted', 'filled'])
  const products = previous.products.map((result, index) => {
    const keys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : []
    const missingProductKeys = [...productKeys].filter((key) => !Object.prototype.hasOwnProperty.call(result || {}, key))
    const extraProductKeys = keys.filter((key) => !productKeys.has(key))
    if (missingProductKeys.length || extraProductKeys.length) fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', `Existing ${validated.products[index]} plan result shape is invalid`)
    return normalizePlanResult(validated.products[index], result)
  })
  const expectedOutcome = cycleOutcome(products) === 'READY' ? 'PAPER_APPLIED' : cycleOutcome(products)
  if (expectedOutcome !== previous.outcome) fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Existing automation cycle outcome is inconsistent')
  const planningOutcome = cycleOutcome(products)
  if (previous.phase !== (planningOutcome === 'BLOCKED' ? 'BLOCKED' : 'COMPLETE') || !sameValue(previous.phase_history, expectedPhaseHistory(planningOutcome))) fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Existing automation cycle phase history is inconsistent')
  if (!sameValue(previous.proofs.plans, products.map((plan) => ({ product: plan.product, plan_id: plan.plan_id, plan_hash: plan.plan_hash })))) fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Existing plan proof does not match the product results')
  if (expectedOutcome === 'PAPER_APPLIED') {
    validatePaperReceipt(previous.paper_receipt, products[0], validated.proofs.paper_policy)
    if (!sameValue(previous.proofs.paper_receipt, { receipt_id: previous.paper_receipt.receipt_id, receipt_hash: previous.paper_receipt.receipt_hash }) || previous.proofs.paper_state_after_digest !== previous.paper_receipt.paper_ledger_digest || previous.simulated_filled_contracts !== previous.paper_receipt.simulated_filled_contracts) fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Existing paper receipt proof is inconsistent')
  } else if (previous.paper_receipt !== null || previous.proofs.paper_receipt !== null || previous.proofs.paper_state_after_digest !== previous.proofs.paper_state_before_digest) {
    fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Non-applied cycle contains paper lifecycle claims')
  } else if (previous.simulated_filled_contracts !== '0') fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Non-applied cycle claims simulated fills')
  const created = Date.parse(previous.created_at)
  if (!Number.isFinite(created) || new Date(created).toISOString() !== previous.created_at) fail('AUTOMATION_PREVIOUS_CYCLE_INVALID', 'Existing automation cycle time is invalid')
  return {
    schema: previous.schema,
    cycle_id: previous.cycle_id,
    cycle_hash: previous.cycle_hash,
    date: previous.date,
    iso_week: previous.iso_week,
    source_generated_at: previous.source_generated_at,
    created_at: previous.created_at,
    mode: previous.mode,
    phase: previous.phase,
    phase_history: previous.phase_history,
    outcome: previous.outcome,
    products,
    proofs: previous.proofs,
    paper_receipt: previous.paper_receipt,
    simulated_filled_contracts: previous.simulated_filled_contracts,
    submitted: 0,
    filled: 0,
    reused: true
  }
}

export async function prepareAutomation(options = {}) {
  rejectMutationCredentials(options.env)
  const requestedDate = date(options.date)
  const requestedWeek = week(options.isoWeek)
  const config = options.config || loadConfig({ filePath: options.configPath })
  validateConfig(config)
  enabledProducts(config)
  const settlement = options.settleExisting ? await options.settleExisting() : null
  const multiExchange = options.collectMultiSnapshot ? await options.collectMultiSnapshot({ date: requestedDate, isoWeek: requestedWeek, now: options.now }) : null
  if (multiExchange) {
    validateMultiExchangeSnapshot(multiExchange, { date: requestedDate, isoWeek: requestedWeek })
    if (multiExchange.status === 'BLOCKED') fail('AUTOMATION_MULTI_MARKET_BLOCKED', 'No requested multi-exchange source produced usable BTC/ETH public data')
    if (options.writeMultiSnapshot) await options.writeMultiSnapshot(multiExchange)
  }
  const collect = options.collectSnapshot || collectMarketSnapshot
  const snapshot = await collect({ date: requestedDate, isoWeek: requestedWeek, now: options.now, multiExchangeSnapshot: multiExchange })
  validateMarketSnapshot(snapshot, { date: requestedDate, isoWeek: requestedWeek })
  if (multiExchange && snapshot.multi_exchange?.snapshot_hash !== multiExchange.snapshot_hash) fail('AUTOMATION_MULTI_MARKET_HANDOFF', 'Gate market snapshot did not embed the exact multi-exchange summary')
  if (options.writeSnapshot) await options.writeSnapshot(snapshot)
  return {
    schema: 'tyche_automation_preparation/v1',
    date: requestedDate,
    iso_week: requestedWeek,
    snapshot_generated_at: snapshot.generated_at,
    snapshot_path: 'data/crypto_market.json',
    multi_exchange: multiExchange ? { status: multiExchange.status, path: 'data/crypto_multi_exchange.json', snapshot_hash: multiExchange.snapshot_hash, counts: multiExchange.counts } : null,
    phase: 'PREPARED',
    anchor_action: options.anchorRequired === true ? 'REFRESH_WEEKLY' : 'USE_CURRENT_WEEKLY',
    settlement,
    next_step: 'Run the daily-crypto analysis and persist its exact canonical document before planning.',
    submitted: 0,
    filled: 0
  }
}

export function validateAutomationHandoff(options = {}) {
  rejectMutationCredentials(options.env)
  const requestedDate = date(options.date)
  const requestedWeek = week(options.isoWeek)
  const config = options.config
  validateConfig(config)
  const products = enabledProducts(config)
  const daily = validateCanonicalDocument(options.daily, 'daily')
  const weekly = validateCanonicalDocument(options.weekly, 'weekly')
  const market = validateMarketSnapshot(options.market, { date: requestedDate, isoWeek: requestedWeek })
  if (daily.date !== requestedDate || daily.iso_week !== requestedWeek) {
    fail('AUTOMATION_DAILY_ANCHOR_MISMATCH', 'Canonical daily analysis does not match the requested date and ISO week')
  }
  if (daily.generated_at !== market.generated_at) {
    fail('AUTOMATION_SNAPSHOT_DRIFT', 'Daily analysis was not produced from the current canonical market snapshot')
  }
  if (weekly.iso_week !== requestedWeek || weekly.status !== 'active') fail('AUTOMATION_WEEKLY_ANCHOR_MISMATCH', 'Canonical weekly anchor does not match the requested active ISO week')
  const paperLedger = validatePaperLedger(options.paperLedger)
  if (paperLedger.config_digest !== sha256Hex(config)) fail('AUTOMATION_PAPER_CONFIG_DRIFT', 'Active paper account was initialized with a different configuration')
  const current = typeof options.now === 'function' ? options.now() : (options.now ?? Date.now())
  const generated = Date.parse(daily.generated_at)
  const maxAgeMs = Number(config.analysis.candidate_max_age_seconds) * 1000
  if (!Number.isFinite(current) || !Number.isFinite(generated) || generated > current || current - generated > maxAgeMs || new Date(generated).toISOString() !== daily.generated_at || new Date(current).toISOString().slice(0, 10) !== daily.date) {
    fail('AUTOMATION_DAILY_STALE', 'Canonical daily analysis is invalid, future-dated, or outside its configured freshness window')
  }
  const mismatched = daily.execution_candidates.filter((candidate) => candidate.data_as_of !== market.generated_at)
  if (mismatched.length) fail('AUTOMATION_CANDIDATE_TIME_MISMATCH', 'Every candidate must reference the canonical market snapshot time')
  const paperStateDigest = sha256Hex(paperLedger)
  const proofs = {
    weekly: { iso_week: weekly.iso_week, generated_at: weekly.generated_at, digest: sha256Hex(weekly) },
    daily: { date: daily.date, generated_at: daily.generated_at, digest: sha256Hex(daily) },
    market: { date: market.date, generated_at: market.generated_at, digest: sha256Hex(market) },
    paper_policy: { account_id: paperLedger.account_id, policy_digest: paperLedger.policy_digest, config_digest: paperLedger.config_digest }
  }
  const validated = { date: requestedDate, isoWeek: requestedWeek, config, products, daily, weekly, market, paperLedger, paperStateDigest, proofs }
  validated.cycleId = cycleIdentity(validated, paperStateDigest)
  return validated
}

export async function runAutomationPlanning(options = {}) {
  const validated = validateAutomationHandoff(options)
  const previous = reusableCycle(options.previous, validated)
  if (previous) return previous
  if (typeof options.planProduct !== 'function') fail('AUTOMATION_PLANNER_REQUIRED', 'A deterministic dry-run planner is required')
  const plans = []
  for (const product of validated.products) {
    const result = await options.planProduct(product, {
      date: validated.date,
      isoWeek: validated.isoWeek,
      environment: 'dry-run'
    })
    plans.push(normalizePlanResult(product, result))
  }
  const planningOutcome = cycleOutcome(plans)
  let paperReceipt = null
  if (planningOutcome === 'READY') {
    if (typeof options.applyPlan !== 'function') fail('AUTOMATION_PAPER_APPLIER_REQUIRED', 'A deterministic paper plan applier is required')
    paperReceipt = validatePaperReceipt(await options.applyPlan(plans[0]), plans[0], validated.proofs.paper_policy)
  }
  const phaseHistory = expectedPhaseHistory(planningOutcome)
  const proofs = {
    ...validated.proofs,
    paper_state_before_digest: validated.paperStateDigest,
    paper_state_after_digest: paperReceipt?.paper_ledger_digest || validated.paperStateDigest,
    plans: plans.map((plan) => ({ product: plan.product, plan_id: plan.plan_id, plan_hash: plan.plan_hash })),
    paper_receipt: paperReceipt ? { receipt_id: paperReceipt.receipt_id, receipt_hash: paperReceipt.receipt_hash } : null
  }
  const cycle = {
    schema: 'tyche_automation_cycle/v2',
    cycle_id: validated.cycleId,
    date: validated.date,
    iso_week: validated.isoWeek,
    source_generated_at: validated.daily.generated_at,
    created_at: new Date(typeof options.now === 'function' ? options.now() : (options.now ?? Date.now())).toISOString(),
    mode: 'automatic_usdm_paper',
    phase: planningOutcome === 'BLOCKED' ? 'BLOCKED' : 'COMPLETE',
    phase_history: phaseHistory,
    outcome: planningOutcome === 'READY' ? 'PAPER_APPLIED' : planningOutcome,
    products: plans,
    proofs,
    paper_receipt: paperReceipt,
    simulated_filled_contracts: paperReceipt?.simulated_filled_contracts || '0',
    submitted: 0,
    filled: 0,
    reused: false
  }
  cycle.cycle_hash = cycleSeal(cycle)
  return cycle
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const command = values[0]
  if (!['doctor', 'prepare', 'plan'].includes(command)) fail('AUTOMATION_COMMAND_UNSUPPORTED', 'Commands: doctor, prepare, plan')
  const allowedFlags = new Set(command === 'doctor' ? ['--config'] : command === 'plan' ? ['--date', '--iso-week', '--config'] : ['--date', '--iso-week', '--config', '--exchanges', '--channels', '--concurrency', '--timeout-ms'])
  const unknownFlags = values.filter((value) => value.startsWith('--') && !allowedFlags.has(value))
  if (unknownFlags.length) fail('AUTOMATION_ARGUMENT_FORBIDDEN', `Unsupported arguments: ${[...new Set(unknownFlags)].join(',')}`)
  const get = (flag, fallback = null) => {
    const indexes = values.map((value, index) => value === flag ? index : -1).filter((index) => index >= 0)
    if (indexes.length > 1) fail('AUTOMATION_DUPLICATE_FLAG', `${flag} may be supplied only once`)
    if (!indexes.length) return fallback
    const value = values[indexes[0] + 1]
    if (!value || value.startsWith('--')) fail('AUTOMATION_ARGUMENT_INVALID', `${flag} requires a value`)
    return value
  }
  const parsed = {
    command,
    date: get('--date'),
    isoWeek: get('--iso-week'),
    configPath: get('--config', path.join(ROOT, 'config', 'tyche.json')),
    exchanges: get('--exchanges', 'all'),
    channels: get('--channels', 'core'),
    concurrency: Number(get('--concurrency', '8')),
    timeoutMs: Number(get('--timeout-ms', '15000'))
  }
  if (command !== 'prepare' && values.some((value) => ['--exchanges', '--channels', '--concurrency', '--timeout-ms'].includes(value))) fail('AUTOMATION_MULTI_ARGUMENT_SCOPE', 'Multi-exchange collection flags are valid only for prepare')
  return parsed
}

function planner(configPath) {
  return async (product, anchors) => {
    if (product !== 'usdm') fail('AUTOMATION_PRODUCT_UNSUPPORTED', 'Automatic paper planning is USDT-M only')
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'paper-trade.mjs'),
      'plan',
      '--source', DAILY_PATH,
      '--date', anchors.date,
      '--iso-week', anchors.isoWeek,
      '--config', configPath
    ], { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    let payload = null
    try { payload = JSON.parse(String(result.stdout || '')) } catch {}
    if (result.error) fail('AUTOMATION_PLAN_PROCESS_FAILED', `${product} planner process failed: ${result.error.code || result.error.message}`)
    if (result.status !== 0) fail(payload?.code || 'AUTOMATION_PLAN_FAILED', payload?.message || `${product} planner exited with status ${result.status}`)
    return payload
  }
}

function applicator(configPath) {
  return async (planResult) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'paper-trade.mjs'), 'apply', '--plan', path.join(ROOT, planResult.plan_path), '--config', configPath], { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    let payload = null
    try { payload = JSON.parse(String(result.stdout || '')) } catch {}
    if (result.error) fail('AUTOMATION_PAPER_PROCESS_FAILED', result.error.code || result.error.message)
    if (result.status !== 0) fail(payload?.code || 'AUTOMATION_PAPER_APPLY_FAILED', payload?.message || `Paper apply exited with status ${result.status}`)
    return payload
  }
}

// Small injection seam for other controllers.  The deterministic paper
// planner and applier remain the existing CLI implementations; callers do
// not need to duplicate sizing, risk, ledger, or apply logic.
export function createAutomationPlanner(configPath) {
  return planner(configPath)
}

export function createAutomationApplicator(configPath) {
  return applicator(configPath)
}

function reportForCycle(cycle) {
  const canonicalMarket = readJsonStrict(MARKET_PATH)
  const plannedOrders = cycle.products.flatMap((result) => {
    if (!result.plan_path) return []
    const plan = readJsonStrict(path.resolve(ROOT, result.plan_path))
    const proof = verifyPlan(plan, { planId: result.plan_id, planHash: result.plan_hash, skipCurrentTime: true })
    if (!proof.ok || plan.product !== result.product || plan.environment !== 'dry-run' || plan.status !== result.outcome || plan.intents?.length !== result.intents || plan.source?.date !== cycle.date || plan.source?.iso_week !== cycle.iso_week || plan.daily_source_proof?.generated_at !== cycle.source_generated_at) {
      fail('AUTOMATION_PLAN_ARTIFACT_INVALID', `${result.product} plan artifact no longer matches the cycle receipt`)
    }
    return (plan.intents || []).map((intent) => ({
      asset: intent.symbol,
      product: intent.product,
      position_intent: intent.action,
      entry_price: intent.price,
      stop_price: intent.protection?.stop_price ?? null,
      take_profit_price: intent.protection?.target_price ?? null
    }))
  })
  return renderConciseReport({
    title: `Tyche automatic USDT-M paper ${cycle.date}`,
    as_of: cycle.created_at,
    scope: { assets: ['BTC', 'ETH'], products: cycle.products.map((row) => row.product), environment: 'dry-run' },
    conclusions: [...cycle.products.map((row) => `${row.product}: ${row.outcome}; ${row.intents} deterministic intent(s).`), `Paper: ${cycle.outcome}; simulated contracts ${cycle.simulated_filled_contracts}.`],
    execution: { mode: cycle.mode, planned_orders: plannedOrders, events: [], submitted: 0, filled: 0, rejected: 0, cancelled: 0 },
    recommendations: plannedOrders,
    blockers: cycle.products.flatMap((row) => row.blockers.map((blocker) => ({ ...blocker, label: row.product }))),
    risks: ['This cycle may create simulated paper fills only; no order was sent to a venue.'],
    audit_artifacts: [
      { label: 'Daily analysis', path: 'data/crypto_daily.json' },
      { label: 'Market snapshot', path: 'data/crypto_market.json' },
      ...(canonicalMarket.multi_exchange ? [{ label: 'Multi-exchange evidence', path: canonicalMarket.multi_exchange.source_path }] : []),
      { label: 'Paper performance', path: 'outputs/paper-report.md' },
      ...cycle.products.flatMap((row) => [row.plan_path, row.report_path].filter(Boolean).map((artifact) => ({ label: row.product, path: artifact })))
    ]
  })
}

function weeklyRefreshRequired(isoWeek, config, current = Date.now()) {
  const anchor = readJsonStrict(WEEKLY_PATH, { missingDefault: null })
  const generated = Date.parse(String(anchor?.generated_at || ''))
  return !anchor || anchor.schema !== 'tyche_weekly_strategy/v1' || anchor.status !== 'active' || anchor.iso_week !== isoWeek || !Array.isArray(anchor.execution_candidates) || anchor.execution_candidates.length !== 0 || !Number.isFinite(generated) || current - generated > Number(config.analysis.weekly_anchor_max_age_days) * 86400000
}

async function cli(argv) {
  rejectMutationCredentials(process.env)
  const args = parseArgs(argv)
  const config = loadConfig({ filePath: args.configPath })
  if (args.command === 'doctor') {
    let paperLedger = null
    let paperReadCode = null
    try { paperLedger = readJsonStrict(PAPER_PATH, { missingDefault: null }) } catch (error) { paperReadCode = error.code || 'PAPER_LEDGER_INVALID' }
    const result = automationDoctor({ config, env: process.env, paperLedger, paperReadCode })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.outcome !== 'READY') process.exitCode = 2
    return
  }
  if (args.command === 'prepare') {
    const paperAvailable = fs.existsSync(PAPER_PATH)
    if (!paperAvailable) fail('AUTOMATION_PAPER_NOT_INITIALIZED', 'Run automation doctor and initialize the explicit paper account before prepare')
    const result = await prepareAutomation({
      date: args.date,
      isoWeek: args.isoWeek,
      config,
      env: process.env,
      anchorRequired: weeklyRefreshRequired(args.isoWeek, config),
      collectMultiSnapshot: (anchors) => collectAllExchangeSnapshot({ ...anchors, exchanges: args.exchanges, channels: args.channels, concurrency: args.concurrency, timeoutMs: args.timeoutMs }),
      writeMultiSnapshot: (snapshot) => writeJsonAtomic(MULTI_MARKET_PATH, snapshot),
      settleExisting: () => {
        const settled = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'paper-trade.mjs'), 'settle', '--config', args.configPath], { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 1024 * 1024 })
        let payload = null
        try { payload = JSON.parse(String(settled.stdout || '')) } catch {}
        if (settled.status !== 0) fail(payload?.code || 'AUTOMATION_SETTLEMENT_FAILED', payload?.message || 'Paper settlement failed')
        return payload
      },
      writeSnapshot: (snapshot) => {
        writeJsonAtomic(MARKET_PATH, snapshot)
        const digest = sha256Hex(snapshot)
        writeJsonAtomic(path.join(ROOT, 'data', 'paper', 'market', `${snapshot.date}-${digest.slice(0, 16)}.json`), { ...snapshot, snapshot_hash: digest })
      }
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }

  const resultDate = date(args.date)
  const resultPath = path.join(ROOT, 'outputs', `automation-${resultDate}.json`)
  const reportPath = path.join(ROOT, 'outputs', `automation-${resultDate}.md`)
  const guardPath = path.join(ROOT, 'outputs', `automation-${resultDate}.cycle`)
  const result = await withFileLockAsync(guardPath, async () => {
    const previous = fs.existsSync(resultPath) ? readJsonStrict(resultPath) : null
    const planned = await runAutomationPlanning({
      date: args.date,
      isoWeek: args.isoWeek,
      config,
      daily: readJsonStrict(DAILY_PATH),
      weekly: readJsonStrict(WEEKLY_PATH),
      market: readJsonStrict(MARKET_PATH),
      paperLedger: readJsonStrict(PAPER_PATH),
      env: process.env,
      previous,
      planProduct: createAutomationPlanner(args.configPath),
      applyPlan: createAutomationApplicator(args.configPath)
    })
    const report = reportForCycle(planned)
    if (!planned.reused) writeJsonAtomic(resultPath, planned)
    if (!planned.reused || !fs.existsSync(reportPath)) writeTextAtomic(reportPath, report)
    return planned
  })
  process.stdout.write(`${JSON.stringify({ ...result, result_path: path.relative(ROOT, resultPath).split(path.sep).join('/'), report_path: path.relative(ROOT, reportPath).split(path.sep).join('/'), paper_report_path: 'outputs/paper-report.md' }, null, 2)}\n`)
  if (result.outcome === 'BLOCKED') process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  cli(process.argv).catch((error) => {
    process.stdout.write(`${JSON.stringify({ outcome: 'BLOCKED', code: error.code || 'AUTOMATION_ERROR', message: String(error.message || error), submitted: 0, filled: 0 }, null, 2)}\n`)
    process.exitCode = 1
  })
}
