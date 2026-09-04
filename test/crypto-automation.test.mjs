import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../scripts/config.mjs'
import { appendPaperEventsValue, createPaperLedger } from '../scripts/paper-trade.mjs'
import { sha256Hex } from '../scripts/gate-trade.mjs'
import {
  automationDoctor,
  prepareAutomation,
  runAutomationPlanning,
  validateAutomationHandoff
} from '../scripts/crypto-automation.mjs'
import { DATE, NOW, WEEK } from './helpers.mjs'

function config() {
  const value = structuredClone(loadConfig())
  Object.assign(value.gate.usdm, {
    configured_leverage: 2,
    risk_per_trade_bps: 25,
    max_order_notional_usdt: 100,
    daily_new_notional_cap_usdt: 200,
    max_managed_notional_usdt: 300
  })
  return value
}

function paperLedger(value = config()) {
  return createPaperLedger({ config: value, initialUsdt: '1000', dailyLossBps: '100', maxDrawdownBps: '200', maxSpreadBps: '100', maxEntryDistanceBps: '1000', triggerSlippageBps: '10', now: NOW })
}

function assetResult(asset) {
  return {
    asset,
    symbol: `${asset}_USDT`,
    summary: `${asset} fixture has no deterministic setup`,
    spot_bias: 'neutral',
    usdm_bias: 'neutral',
    invalidation: null,
    anchor_week: WEEK,
    anchor_fresh: true,
    evidence_refs: [`assets.${asset}`],
    execution_candidates: [],
    risks: []
  }
}

function daily() {
  return {
    schema: 'tyche_crypto_daily/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: new Date(NOW).toISOString(),
    anchored_week: WEEK,
    anchor_fresh: true,
    regime: { label: 'fixture' },
    assets: { BTC: assetResult('BTC'), ETH: assetResult('ETH') },
    execution_candidates: [],
    blockers: [],
    risks: []
  }
}

function weekly() {
  return {
    schema: 'tyche_weekly_strategy/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: new Date(NOW).toISOString(),
    status: 'active',
    regime: { label: 'fixture' },
    assets: { BTC: assetResult('BTC'), ETH: assetResult('ETH') },
    execution_candidates: [],
    blockers: [],
    risks: []
  }
}

function market(overrides = {}) {
  return {
    schema: 'tyche_crypto_market/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: new Date(NOW).toISOString(),
    source: 'fixture',
    assets: {
      BTC: { symbol: 'BTC_USDT', spot: {}, usdm: {} },
      ETH: { symbol: 'ETH_USDT', spot: {}, usdm: {} }
    },
    ...overrides
  }
}

function multiExchange() {
  const body = {
    schema: 'tyche_multi_exchange_market/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: new Date(NOW).toISOString(),
    adapter: { name: 'ccxt', dependency_pin: '4.5.77', runtime_version: 'fixture', public_only: true },
    request: { scope: 'BTC_ETH_PUBLIC_MARKET_DATA', exchange_count: 1, channels: ['ticker'] },
    status: 'COMPLETE',
    counts: { requested: 1, successful: 1, complete: 1, partial: 0, unavailable: 0, no_relevant_markets: 0 },
    aggregates: { BTC: { spot: { source_count: 1 } }, ETH: { spot: { source_count: 1 } } },
    exchanges: []
  }
  return { ...body, snapshot_hash: sha256Hex(body) }
}

function multiSummary(snapshot) {
  return { schema: 'tyche_multi_exchange_summary/v1', generated_at: snapshot.generated_at, status: snapshot.status, adapter: snapshot.adapter, counts: snapshot.counts, aggregates: snapshot.aggregates, snapshot_hash: snapshot.snapshot_hash, source_path: 'data/crypto_multi_exchange.json' }
}

function planResult(product, outcome = 'NO_ACTION', index = 1) {
  const suffix = String(index).repeat(12).slice(0, 12)
  const planId = `tp-20300107-${suffix}`
  return {
    outcome,
    product,
    environment: 'dry-run',
    plan_id: planId,
    plan_hash: 'a'.repeat(64),
    intents: outcome === 'READY' ? 1 : 0,
    blockers: outcome === 'BLOCKED' ? [{ code: 'FIXTURE_BLOCK' }] : [],
    skipped: [],
    plan_path: `outputs/plans/gate-plan-${planId}.json`,
    report_path: `outputs/reports/gate-plan-${planId}.md`,
    submitted: 0,
    filled: 0
  }
}

function paperReceipt(plan, account, ledgerDigest, simulated = '3') {
  const receipt = {
    schema: 'tyche_paper_apply_receipt/v1',
    account_id: account.account_id,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    generated_at: new Date(NOW).toISOString(),
    outcomes: [],
    simulated_filled_contracts: simulated,
    paper_ledger_digest: ledgerDigest,
    submitted: 0,
    filled: 0
  }
  receipt.receipt_id = `par_${sha256Hex(receipt).slice(0, 24)}`
  receipt.receipt_hash = sha256Hex(receipt)
  return receipt
}

function handoff(value = config(), account = paperLedger(value)) {
  return { date: DATE, isoWeek: WEEK, config: value, daily: daily(), weekly: weekly(), market: market(), paperLedger: account, env: {}, now: NOW }
}

test('automation preparation rejects mutation credentials before collecting public data', async () => {
  let collected = false
  await assert.rejects(
    prepareAutomation({
      date: DATE,
      isoWeek: WEEK,
      config: config(),
      env: { GATE_USDM_TESTNET_API_KEY: 'present' },
      collectSnapshot: async () => { collected = true; return market() }
    }),
    { code: 'AUTOMATION_MUTATION_CREDENTIAL_PRESENT' }
  )
  assert.equal(collected, false)

  let planned = false
  await assert.rejects(
    runAutomationPlanning({
      date: DATE,
      isoWeek: WEEK,
      config: config(),
      daily: daily(),
      weekly: weekly(),
      market: market(),
      paperLedger: paperLedger(),
      env: { GATE_USDM_TESTNET_SECRET_KEY: 'present' },
      now: NOW,
      planProduct: async () => { planned = true }
    }),
    { code: 'AUTOMATION_MUTATION_CREDENTIAL_PRESENT' }
  )
  assert.equal(planned, false)

  const script = fileURLToPath(new URL('../scripts/crypto-automation.mjs', import.meta.url))
  const cli = spawnSync(process.execPath, [script, 'plan', '--date', DATE, '--iso-week', WEEK], {
    encoding: 'utf8',
    env: { ...process.env, GATE_USDM_TESTNET_API_KEY: 'present' }
  })
  assert.equal(cli.status, 1)
  assert.match(cli.stdout, /AUTOMATION_MUTATION_CREDENTIAL_PRESENT/)
  assert.doesNotMatch(cli.stdout, /STATE_READ_FAILED/)
})

test('paper automation also rejects inherited Binance testnet mutation credentials', async () => {
  let calls = 0
  await assert.rejects(
    prepareAutomation({
      date: DATE,
      isoWeek: WEEK,
      config: config(),
      env: { BINANCE_USDM_TESTNET_API_KEY: 'present' },
      collectSnapshot: async () => { calls += 1 }
    }),
    { code: 'AUTOMATION_MUTATION_CREDENTIAL_PRESENT' }
  )
  assert.equal(calls, 0)
})

test('automation API defaults its credential guard to the process environment', async () => {
  const name = 'BINANCE_USDM_TESTNET_API_KEY'
  const previous = process.env[name]
  process.env[name] = 'present'
  try {
    await assert.rejects(
      prepareAutomation({
        date: DATE,
        isoWeek: WEEK,
        config: config(),
        collectSnapshot: async () => { throw new Error('collection must not start') }
      }),
      { code: 'AUTOMATION_MUTATION_CREDENTIAL_PRESENT' }
    )
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

test('automation doctor reports exact setup blockers without network activity', () => {
  const value = config()
  const account = paperLedger(value)
  const catalog = { exchange_count: 104, dependency_pin: '4.5.77' }
  const ready = automationDoctor({ config: value, paperLedger: account, catalog, nodeVersion: '22.19.0', env: {} })
  assert.equal(ready.outcome, 'READY')
  assert.ok(ready.checks.every((check) => check.ok))
  const missing = automationDoctor({ config: loadConfig(), paperLedger: null, catalog, nodeVersion: '22.18.0', env: {} })
  assert.equal(missing.outcome, 'SETUP_REQUIRED')
  assert.deepEqual(missing.checks.filter((check) => !check.ok).map((check) => check.name), ['node_runtime', 'paper_configuration', 'paper_ledger'])
})

test('automation preparation writes only the exact validated public snapshot', async () => {
  const snapshot = market()
  let written = null
  const result = await prepareAutomation({
    date: DATE,
    isoWeek: WEEK,
    config: config(),
    env: {},
    now: NOW,
    collectSnapshot: async () => snapshot,
    writeSnapshot: async (value) => { written = value }
  })
  assert.equal(written, snapshot)
  assert.equal(result.snapshot_path, 'data/crypto_market.json')
  assert.equal(result.submitted, 0)
})

test('automation preparation settles before collecting and sealing multi-exchange evidence', async () => {
  const sequence = []
  const multi = multiExchange()
  const snapshot = market({ multi_exchange: multiSummary(multi) })
  let writtenMulti = null
  const result = await prepareAutomation({
    date: DATE,
    isoWeek: WEEK,
    config: config(),
    env: {},
    now: NOW,
    settleExisting: async () => { sequence.push('settle'); return { outcome: 'SETTLED', submitted: 0, filled: 0 } },
    collectMultiSnapshot: async () => { sequence.push('multi'); return multi },
    writeMultiSnapshot: async (value) => { sequence.push('write-multi'); writtenMulti = value },
    collectSnapshot: async (options) => { sequence.push('gate'); assert.equal(options.multiExchangeSnapshot, multi); return snapshot },
    writeSnapshot: async () => { sequence.push('write-gate') }
  })
  assert.deepEqual(sequence, ['settle', 'multi', 'write-multi', 'gate', 'write-gate'])
  assert.equal(writtenMulti, multi)
  assert.equal(result.multi_exchange.snapshot_hash, multi.snapshot_hash)
})

test('automation handoff requires canonical daily output from the current snapshot', () => {
  assert.throws(
    () => validateAutomationHandoff({ ...handoff(), market: market({ generated_at: '2030-01-07T12:00:01.000Z' }) }),
    { code: 'AUTOMATION_SNAPSHOT_DRIFT' }
  )
  const malformed = daily()
  delete malformed.assets.ETH.summary
  assert.throws(
    () => validateAutomationHandoff({ ...handoff(), daily: malformed }),
    { code: 'AGENT_WRITE_CANONICAL_INVALID' }
  )
  assert.throws(
    () => validateAutomationHandoff({ ...handoff(), now: NOW + 901000 }),
    { code: 'AUTOMATION_DAILY_STALE' }
  )
})

test('one automatic cycle plans USDT-M, applies paper, and never submits', async () => {
  const calls = []
  const value = config()
  const account = paperLedger(value)
  const after = appendPaperEventsValue(account, [{ type: 'SIMULATED_EQUITY_MARK', at: new Date(NOW).toISOString(), source_id: 'fixture:after', data: { equity: '1000', marks: {} } }])
  const result = await runAutomationPlanning({
    ...handoff(value, account),
    planProduct: async (product, anchors) => {
      calls.push({ product, anchors })
      return planResult(product, 'READY', 2)
    },
    applyPlan: async (plan) => paperReceipt(plan, account, sha256Hex(after))
  })
  assert.deepEqual(calls.map((call) => call.product), ['usdm'])
  assert.ok(calls.every((call) => call.anchors.environment === 'dry-run'))
  assert.equal(result.outcome, 'PAPER_APPLIED')
  assert.equal(result.phase, 'COMPLETE')
  assert.deepEqual(result.phase_history, ['PREPARED', 'ANCHOR_READY', 'ANALYZED', 'PLANNED', 'PAPER_APPLIED', 'COMPLETE'])
  assert.equal(result.proofs.paper_state_after_digest, result.paper_receipt.paper_ledger_digest)
  assert.equal(result.simulated_filled_contracts, '3')
  assert.equal(result.submitted, 0)
  assert.equal(result.filled, 0)
  assert.match(result.cycle_id, /^tac_[a-f0-9]{32}$/)
})

test('a completed source cycle is idempotent and tampered lifecycle claims fail closed', async () => {
  const base = handoff()
  const first = await runAutomationPlanning({
    ...base,
    planProduct: async (product) => planResult(product, 'NO_ACTION', 2)
  })
  let calls = 0
  const reused = await runAutomationPlanning({ ...base, previous: first, planProduct: async () => { calls += 1 } })
  assert.equal(reused.reused, true)
  assert.equal(calls, 0)

  await assert.rejects(
    runAutomationPlanning({ ...base, previous: { ...first, submitted: 1 }, planProduct: async () => null }),
    { code: 'AUTOMATION_PREVIOUS_CYCLE_INVALID' }
  )
})

test('an applied cycle is reused when the active ledger matches its sealed post-state', async () => {
  const value = config()
  const account = paperLedger(value)
  const after = appendPaperEventsValue(account, [{ type: 'SIMULATED_EQUITY_MARK', at: new Date(NOW).toISOString(), source_id: 'fixture:applied-after', data: { equity: '1000', marks: {} } }])
  const base = handoff(value, account)
  const first = await runAutomationPlanning({
    ...base,
    planProduct: async (product) => planResult(product, 'READY', 4),
    applyPlan: async (plan) => paperReceipt(plan, account, sha256Hex(after))
  })
  let calls = 0
  const reused = await runAutomationPlanning({ ...base, paperLedger: after, previous: first, planProduct: async () => { calls += 1 } })
  assert.equal(reused.reused, true)
  assert.equal(reused.cycle_id, first.cycle_id)
  assert.equal(calls, 0)
})

test('automatic planning rejects testnet mode and false lifecycle results before continuing', async () => {
  const base = handoff()
  const testnet = config()
  testnet.gate.submission_mode = 'manual_testnet'
  testnet.gate.usdm.environment = 'testnet'
  testnet.gate.usdm.configured_leverage = 2
  testnet.gate.usdm.risk_per_trade_bps = 25
  testnet.gate.usdm.max_order_notional_usdt = 100
  testnet.gate.usdm.daily_new_notional_cap_usdt = 200
  testnet.gate.usdm.max_managed_notional_usdt = 300
  await assert.rejects(
    runAutomationPlanning({ ...base, config: testnet, planProduct: async () => null }),
    { code: 'AUTOMATION_DRY_RUN_REQUIRED' }
  )

  let calls = 0
  await assert.rejects(
    runAutomationPlanning({
      ...base,
      planProduct: async (product) => {
        calls += 1
        return { ...planResult(product, 'NO_ACTION', calls), submitted: 1 }
      }
    }),
    { code: 'AUTOMATION_LIFECYCLE_CONFLICT' }
  )
  assert.equal(calls, 1)
})
