import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixtureWorker, runCluster } from '../packages/pi-agents/src/index.mjs'
import { loadConfig } from '../scripts/config.mjs'
import { persistCanonicalDocument } from '../scripts/agent-write.mjs'
import { runPiAutomation, runPiWeeklyRefresh, piShadowPaths, piWeeklyShadowPaths } from '../scripts/pi-automation.mjs'
import { sha256Hex } from '../scripts/gate-trade.mjs'
import { createPaperLedger } from '../scripts/paper-trade.mjs'

const DATE = '2030-01-07'
const WEEK = '2030-W02'
const AT = `${DATE}T12:00:00.000Z`

function multiSnapshot() {
  const body = {
    schema: 'tyche_multi_exchange_market/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: AT,
    adapter: { name: 'ccxt', dependency_pin: '4.5.77', runtime_version: 'fixture', public_only: true },
    request: { scope: 'BTC_ETH_PUBLIC_MARKET_DATA', exchange_count: 1, channels: ['ticker'] },
    status: 'PARTIAL',
    counts: { requested: 1, successful: 1, complete: 1, partial: 0, unavailable: 0, no_relevant_markets: 0 },
    aggregates: { BTC: {}, ETH: {} },
    exchanges: []
  }
  return { ...body, snapshot_hash: sha256Hex(body) }
}

function marketSnapshot(multi) {
  return {
    schema: 'tyche_crypto_market/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: AT,
    assets: {
      BTC: { symbol: 'BTC_USDT', spot: { ticker: { last: '100' } }, usdm: { ticker: { last: '100' } } },
      ETH: { symbol: 'ETH_USDT', spot: { ticker: { last: '100' } }, usdm: { ticker: { last: '100' } } }
    },
    multi_exchange: {
      schema: 'tyche_multi_exchange_summary/v1',
      generated_at: AT,
      status: 'PARTIAL',
      adapter: multi.adapter,
      counts: multi.counts,
      aggregates: multi.aggregates,
      snapshot_hash: multi.snapshot_hash,
      source_path: 'data/crypto_multi_exchange.json'
    }
  }
}

function config() {
  return loadConfig()
}

async function fixtureCluster(input) {
  return runCluster({ ...input, runJob: fixtureWorker })
}

function writers() {
  return { writeMultiSnapshot: async () => {}, writeSnapshot: async () => {} }
}

test('settlement is first and survives Pi failure', async () => {
  const order = []
  const multi = multiSnapshot()
  const market = marketSnapshot(multi)
  const result = await runPiAutomation({
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    config: config(),
    now: Date.parse(AT),
    env: {},
    settleExisting: async () => { order.push('settle'); return { outcome: 'SETTLED', receipt_id: 'settle-fixture', events: 1 } },
    collectMultiSnapshot: async () => { order.push('multi'); return multi },
    collectSnapshot: async () => { order.push('market'); return market },
    runCluster: async () => { order.push('pi'); throw new Error('model unavailable') }
  })
  assert.equal(result.outcome, 'BLOCKED')
  assert.equal(result.blocked_stage, 'weekly')
  assert.deepEqual(order, ['settle', 'multi', 'market', 'pi', 'pi'])
  assert.equal(result.settlement.outcome, 'SETTLED')
  assert.equal(result.submitted, 0)
  assert.equal(result.filled, 0)
})

test('inherited mutation credentials still settle exactly once and block before collectors', async () => {
  let settled = 0
  let collected = 0
  const result = await runPiAutomation({
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    env: { GATE_USDM_TESTNET_API_KEY: 'present' },
    settleExisting: async () => { settled += 1; return { outcome: 'SETTLED', receipt_id: 'credential-fixture' } },
    collectMultiSnapshot: async () => { collected += 1; return multiSnapshot() },
    collectSnapshot: async () => { collected += 1; return marketSnapshot(multiSnapshot()) }
  })
  assert.equal(result.blocked_stage, 'credential_guard')
  assert.equal(result.settlement.outcome, 'SETTLED')
  assert.equal(settled, 1)
  assert.equal(collected, 0)
})

test('missing provider settles exactly once and blocks all analysis and planning', async () => {
  const date = '2030-01-08'
  let settled = 0
  let collected = 0
  let clusterCalls = 0
  let planningCalls = 0
  let applyCalls = 0
  const result = await runPiAutomation({
    date,
    isoWeek: WEEK,
    model: 'fixture-model',
    env: {},
    settleExisting: async () => { settled += 1; return { outcome: 'SETTLED', receipt_id: 'agent-config-fixture', events: 2 } },
    collectMultiSnapshot: async () => { collected += 1; return multiSnapshot() },
    collectSnapshot: async () => { collected += 1; return marketSnapshot(multiSnapshot()) },
    runCluster: async () => { clusterCalls += 1; throw new Error('must not run') },
    runPlanning: async () => { planningCalls += 1; throw new Error('must not run') },
    applyPlan: async () => { applyCalls += 1; throw new Error('must not run') }
  })
  assert.equal(result.outcome, 'BLOCKED')
  assert.equal(result.blocked_stage, 'agent_config')
  assert.equal(result.code, 'PI_AUTOMATION_PROVIDER_REQUIRED')
  assert.equal(result.provider, null)
  assert.equal(result.model, null)
  assert.equal(result.settlement.outcome, 'SETTLED')
  assert.equal(result.settlement.receipt_id, 'agent-config-fixture')
  assert.equal(result.submitted, 0)
  assert.equal(result.filled, 0)
  assert.equal(settled, 1)
  assert.equal(collected, 0)
  assert.equal(clusterCalls, 0)
  assert.equal(planningCalls, 0)
  assert.equal(applyCalls, 0)
  const sealed = JSON.parse(fs.readFileSync(path.resolve(result.result_path), 'utf8'))
  assert.equal(sealed.blocked_stage, 'agent_config')
  assert.equal(sealed.settlement.receipt_id, 'agent-config-fixture')
  const paths = piShadowPaths(date, WEEK)
  fs.rmSync(paths.validation, { force: true })
  fs.rmSync(paths.provenance, { force: true })
})

test('settlement failure wins over missing agent config and stops the cycle', async () => {
  const date = '2030-01-09'
  let settled = 0
  let collected = 0
  let clusterCalls = 0
  let planningCalls = 0
  const result = await runPiAutomation({
    date,
    isoWeek: WEEK,
    env: {},
    settleExisting: async () => { settled += 1; throw new Error('settlement fixture failed') },
    collectMultiSnapshot: async () => { collected += 1; return multiSnapshot() },
    collectSnapshot: async () => { collected += 1; return marketSnapshot(multiSnapshot()) },
    runCluster: async () => { clusterCalls += 1; throw new Error('must not run') },
    runPlanning: async () => { planningCalls += 1; throw new Error('must not run') }
  })
  assert.equal(result.outcome, 'BLOCKED')
  assert.equal(result.blocked_stage, 'settlement')
  assert.equal(result.provider, null)
  assert.equal(result.model, null)
  assert.equal(result.submitted, 0)
  assert.equal(result.filled, 0)
  assert.equal(settled, 1)
  assert.equal(collected, 0)
  assert.equal(clusterCalls, 0)
  assert.equal(planningCalls, 0)
  const paths = piShadowPaths(date, WEEK)
  fs.rmSync(paths.validation, { force: true })
  fs.rmSync(paths.provenance, { force: true })
})

test('weekly refresh then reuse, with BTC/ETH evidence isolated', async () => {
  const multi = multiSnapshot()
  const market = marketSnapshot(multi)
  const evidenceSeen = []
  let clusterCalls = 0
  const common = {
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    config: config(),
    now: Date.parse(AT),
    env: {},
    settleExisting: async () => ({ outcome: 'SETTLED' }),
    collectMultiSnapshot: async () => multi,
    collectSnapshot: async () => market,
    runCluster: async (input) => {
      clusterCalls += 1
      evidenceSeen.push({ tier: input.tier, evidence: input.evidence })
      return fixtureCluster(input)
    }
  }
  const first = await runPiAutomation({ ...common, ...writers() })
  assert.equal(first.outcome, 'SHADOW_VALIDATED')
  assert.equal(first.weekly.action, 'refreshed')
  assert.equal(first.daily.action, 'refreshed')
  assert.equal(clusterCalls, 2)
  assert.deepEqual(Object.keys(evidenceSeen[0].evidence).sort(), ['assets', 'date', 'iso_week', 'market'])
  assert.deepEqual(Object.keys(evidenceSeen[0].evidence.assets.BTC).sort(), ['market', 'weekly'])
  assert.deepEqual(Object.keys(evidenceSeen[0].evidence.assets.ETH).sort(), ['market', 'weekly'])
  assert.equal(evidenceSeen[0].evidence.assets.BTC.market.symbol, 'BTC_USDT')
  assert.equal(evidenceSeen[0].evidence.assets.ETH.market.symbol, 'ETH_USDT')
  assert.equal(evidenceSeen[0].evidence.assets.BTC.weekly, null)
  const weekly = first // read the persisted shadow only for path cleanup; canonical weekly is reconstructed below
  void weekly

  const validWeekly = (await fixtureCluster({
    runId: 'fixture-weekly', tier: 'weekly', date: DATE, isoWeek: WEEK,
    provider: 'fixture', model: 'fixture-model', timeoutMs: 30000,
    evidence: { date: DATE, iso_week: WEEK, market: {}, assets: { BTC: { market: {}, weekly: null }, ETH: { market: {}, weekly: null } } }
  })).output
  const before = clusterCalls
  const second = await runPiAutomation({ ...common, weekly: validWeekly, ...writers() })
  assert.equal(second.outcome, 'SHADOW_VALIDATED')
  assert.equal(clusterCalls, before + 1)
  assert.equal(evidenceSeen.at(-1).tier, 'daily')
  assert.deepEqual(evidenceSeen.at(-1).evidence.assets.BTC.weekly, validWeekly.assets.BTC)
  assert.deepEqual(evidenceSeen.at(-1).evidence.assets.ETH.weekly, validWeekly.assets.ETH)
})

test('shadow stores only fixed validation/provenance summaries and leaves canonical files untouched', async () => {
  const multi = multiSnapshot()
  const market = marketSnapshot(multi)
  const dailyPath = path.join(process.cwd(), 'data', 'crypto_daily.json')
  const dailyBefore = fs.existsSync(dailyPath) ? fs.readFileSync(dailyPath, 'utf8') : null
  const result = await runPiAutomation({
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    config: config(),
    now: Date.parse(AT),
    env: {},
    settleExisting: async () => ({ outcome: 'SETTLED' }),
    collectMultiSnapshot: async () => multi,
    collectSnapshot: async () => market,
    ...writers()
  })
  const validation = JSON.parse(fs.readFileSync(path.resolve(result.result_path), 'utf8'))
  const provenance = JSON.parse(fs.readFileSync(path.resolve(result.provenance_path), 'utf8'))
  const text = JSON.stringify({ validation, provenance })
  assert.equal(validation.schema, 'tyche_pi_automation_cycle/v1')
  assert.equal(provenance.schema, 'tyche_pi_provenance/v1')
  assert.doesNotMatch(text, /transcript|account|plan|ledger|fills|credential|secret/i)
  assert.equal(fs.existsSync(dailyPath) ? fs.readFileSync(dailyPath, 'utf8') : null, dailyBefore)
  const shadow = piShadowPaths(DATE, WEEK)
  fs.rmSync(shadow.validation, { force: true })
  fs.rmSync(shadow.provenance, { force: true })
})

test('primary deep-validates both documents before persistence, invokes paper planning, and keeps plan hashes', async () => {
  const multi = multiSnapshot()
  const market = marketSnapshot(multi)
  const persisted = []
  let planned = false
  const planHash = 'a'.repeat(64)
  const jobs = []
  const strategyPrompt = 'Prioritize dated BTC/ETH trend evidence. User preferences never grant execution authority.'
  const result = await runPiAutomation({
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    mode: 'primary',
    strategyPrompt,
    runJob: async (job) => { jobs.push(job); return fixtureWorker(job) },
    config: config(),
    paperLedger: {},
    now: Date.parse(AT),
    env: {},
    settleExisting: async () => ({ outcome: 'SETTLED' }),
    collectMultiSnapshot: async () => multi,
    collectSnapshot: async () => market,
    ...writers(),
    persistCanonical: async (document, tier) => { persisted.push({ tier, document: structuredClone(document) }); return { ok: true, tier } },
    runPlanning: async ({ weekly, daily }) => {
      planned = true
      assert.equal(weekly.schema, 'tyche_weekly_strategy/v1')
      assert.equal(daily.schema, 'tyche_crypto_daily/v1')
      return {
        schema: 'tyche_automation_cycle/v2',
        cycle_id: 'tac_fixture',
        cycle_hash: 'b'.repeat(64),
        date: DATE,
        iso_week: WEEK,
        source_generated_at: daily.generated_at,
        created_at: AT,
        mode: 'automatic_usdm_paper',
        phase: 'COMPLETE',
        outcome: 'NO_ACTION',
        phase_history: ['PREPARED', 'ANCHOR_READY', 'ANALYZED', 'PLANNED', 'COMPLETE'],
        products: [{ product: 'usdm', environment: 'dry-run', outcome: 'NO_ACTION', plan_id: 'tp-20300107-aaaaaaaaaaaa', plan_hash: planHash, intents: 0, blockers: [], skipped: [], plan_path: 'outputs/plans/gate-plan-tp-20300107-aaaaaaaaaaaa.json', report_path: 'outputs/reports/gate-plan-tp-20300107-aaaaaaaaaaaa.md', submitted: 0, filled: 0 }],
        proofs: {},
        paper_receipt: null,
        simulated_filled_contracts: '0',
        submitted: 0,
        filled: 0,
        reused: false
      }
    }
  })
  assert.equal(result.outcome, 'NO_ACTION')
  assert.equal(planned, true)
  assert.equal(jobs.length, 12)
  for (const job of jobs) assert.equal(job.input.strategy_context, strategyPrompt)
  for (const tier of ['weekly', 'daily']) assert.deepEqual(jobs.filter((job) => job.tier === tier).map((job) => job.role), ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer'])
  assert.deepEqual(persisted.map((row) => row.tier), ['weekly', 'daily'])
  assert.equal(result.automation_cycle.products[0].plan_hash, planHash)
  fs.rmSync(path.resolve(result.result_path), { force: true })
})

test('primary reuses the same v2 source cycle without re-planning or changing sealed hashes', async () => {
  const multi = multiSnapshot()
  const market = marketSnapshot(multi)
  const localConfig = config()
  Object.assign(localConfig.gate.usdm, {
    configured_leverage: 2,
    risk_per_trade_bps: 25,
    max_order_notional_usdt: 100,
    daily_new_notional_cap_usdt: 200,
    max_managed_notional_usdt: 300
  })
  const paperLedger = createPaperLedger({
    config: localConfig,
    initialUsdt: '1000',
    dailyLossBps: '100',
    maxDrawdownBps: '200',
    maxSpreadBps: '100',
    maxEntryDistanceBps: '1000',
    triggerSlippageBps: '10',
    now: Date.parse(AT)
  })
  const persisted = []
  let planCalls = 0
  let applyCalls = 0
  const planHash = 'c'.repeat(64)
  const common = {
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    mode: 'primary',
    config: localConfig,
    paperLedger,
    weekly: null,
    previous: null,
    now: Date.parse(AT),
    env: {},
    settleExisting: async () => ({ outcome: 'SETTLED' }),
    collectMultiSnapshot: async () => multi,
    collectSnapshot: async () => market,
    ...writers(),
    persistCanonical: async (document, tier) => { persisted.push({ tier, document: structuredClone(document) }) },
    planProduct: async () => {
      planCalls += 1
      return {
        product: 'usdm',
        environment: 'dry-run',
        outcome: 'BLOCKED',
        plan_id: 'tp-20300107-cccccccccccc',
        plan_hash: planHash,
        intents: 0,
        blockers: [{ code: 'FIXTURE_BLOCKED' }],
        skipped: [],
        plan_path: 'outputs/plans/gate-plan-tp-20300107-cccccccccccc.json',
        report_path: 'outputs/reports/gate-plan-tp-20300107-cccccccccccc.md',
        submitted: 0,
        filled: 0
      }
    },
    applyPlan: async () => { applyCalls += 1; throw new Error('blocked cycle must not apply') }
  }
  const first = await runPiAutomation(common)
  assert.equal(first.outcome, 'BLOCKED')
  assert.equal(first.automation_cycle.reused, false)
  const firstCycleHash = first.automation_cycle.cycle_hash
  const firstPlanHash = first.automation_cycle.products[0].plan_hash
  const weekly = persisted.find((row) => row.tier === 'weekly').document
  const { previous: _previous, ...withoutPrevious } = common
  const second = await runPiAutomation({
    ...withoutPrevious,
    strategyPrompt: 'Use a different semantic analysis emphasis; do not duplicate a completed paper cycle.',
    weekly,
  })
  assert.equal(second.outcome, 'BLOCKED')
  assert.equal(second.automation_cycle.reused, true)
  assert.equal(second.automation_cycle.cycle_hash, firstCycleHash)
  assert.equal(second.automation_cycle.products[0].plan_hash, firstPlanHash)
  assert.equal(planCalls, 1)
  assert.equal(applyCalls, 0)
  assert.equal(second.pi_provenance.schema, 'tyche_pi_provenance/v1')
  fs.rmSync(path.resolve(first.result_path), { force: true })
  fs.rmSync(path.resolve(second.result_path), { force: true })
})

test('concurrent same-anchor primary calls serialize without deadlock and reuse the first v2 cycle', async () => {
  const multi = multiSnapshot()
  const market = marketSnapshot(multi)
  const output = path.join(process.cwd(), 'outputs', `pi-automation-${DATE}.json`)
  const guard = path.join(process.cwd(), 'outputs', `pi-automation-${DATE}-${WEEK}.cycle`)
  fs.rmSync(output, { force: true })
  fs.rmSync(`${guard}.lock`, { recursive: true, force: true })
  let settlements = 0
  let plannerCalls = 0
  let planCalls = 0
  let applyCalls = 0
  let reusedCalls = 0
  const common = {
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    mode: 'primary',
    config: config(),
    paperLedger: {},
    weekly: null,
    now: Date.parse(AT),
    env: {},
    settleExisting: async () => { settlements += 1; await new Promise((resolve) => setTimeout(resolve, 2)); return { outcome: 'SETTLED' } },
    collectMultiSnapshot: async () => multi,
    collectSnapshot: async () => market,
    ...writers(),
    runCluster: fixtureCluster,
    persistCanonical: async () => {},
    runPlanning: async ({ previous }) => {
      plannerCalls += 1
      if (previous) {
        reusedCalls += 1
        return { ...previous, reused: true }
      }
      planCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 8))
      applyCalls += 1
      return {
        schema: 'tyche_automation_cycle/v2',
        cycle_id: 'tac_concurrent_fixture',
        cycle_hash: 'd'.repeat(64),
        date: DATE,
        iso_week: WEEK,
        source_generated_at: AT,
        created_at: AT,
        mode: 'automatic_usdm_paper',
        phase: 'COMPLETE',
        phase_history: ['PREPARED', 'ANCHOR_READY', 'ANALYZED', 'PLANNED', 'COMPLETE'],
        outcome: 'NO_ACTION',
        products: [{ product: 'usdm', environment: 'dry-run', outcome: 'NO_ACTION', plan_id: 'tp-20300107-dddddddddddd', plan_hash: 'e'.repeat(64), intents: 0, blockers: [], skipped: [], plan_path: 'outputs/plans/gate-plan-tp-20300107-dddddddddddd.json', report_path: 'outputs/reports/gate-plan-tp-20300107-dddddddddddd.md', submitted: 0, filled: 0 }],
        proofs: {},
        paper_receipt: null,
        simulated_filled_contracts: '0',
        submitted: 0,
        filled: 0,
        reused: false
      }
    }
  }
  const [first, second] = await Promise.all([runPiAutomation(common), runPiAutomation(common)])
  assert.equal(first.outcome, 'NO_ACTION')
  assert.equal(second.outcome, 'NO_ACTION')
  assert.equal(settlements, 2)
  assert.equal(plannerCalls, 2)
  assert.equal(planCalls, 1)
  assert.equal(applyCalls, 1)
  assert.equal(reusedCalls, 1)
  assert.equal(first.automation_cycle.cycle_hash, second.automation_cycle.cycle_hash)
  assert.equal(first.automation_cycle.products[0].plan_hash, second.automation_cycle.products[0].plan_hash)
  fs.rmSync(output, { force: true })
  fs.rmSync(`${guard}.lock`, { recursive: true, force: true })
})

test('invalid canonical output blocks without invoking persistence', async () => {
  const multi = multiSnapshot()
  const market = marketSnapshot(multi)
  let persisted = 0
  const result = await runPiAutomation({
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    mode: 'primary',
    config: config(),
    paperLedger: {},
    now: Date.parse(AT),
    env: {},
    settleExisting: async () => ({ outcome: 'SETTLED' }),
    collectMultiSnapshot: async () => multi,
    collectSnapshot: async () => market,
    ...writers(),
    persistCanonical: async () => { persisted += 1 },
    runCluster: async (input) => input.tier === 'weekly'
      ? fixtureCluster(input)
      : { schema: 'tyche_pi_cluster/v1', status: 'ok', output: { schema: 'wrong' } }
  })
  assert.equal(result.outcome, 'BLOCKED')
  assert.equal(persisted, 0)
  fs.rmSync(path.resolve(result.result_path), { force: true })
})

test('agent-write persistence accepts only the fixed canonical targets and rejects malformed documents first', () => {
  const original = { schema: 'wrong' }
  assert.throws(() => persistCanonicalDocument(original, '../outside'), { code: 'AGENT_WRITE_CANONICAL_INVALID' })
})

test('weekly refresh is settlement-free and never invokes daily or paper paths', async () => {
  const multi = multiSnapshot()
  const market = marketSnapshot(multi)
  let settlements = 0
  let dailyCalls = 0
  const persisted = []
  const result = await runPiWeeklyRefresh({
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    mode: 'primary',
    config: config(),
    now: Date.parse(AT),
    env: {},
    settleExisting: async () => { settlements += 1; return { outcome: 'SETTLED' } },
    collectMultiSnapshot: async () => multi,
    collectSnapshot: async () => market,
    runCluster: fixtureCluster,
    persistCanonical: async (document, tier) => persisted.push({ document, tier }),
    runPlanning: async () => { dailyCalls += 1; throw new Error('weekly refresh must not plan') }
  })
  assert.equal(result.outcome, 'WEEKLY_REFRESHED')
  assert.equal(settlements, 0)
  assert.equal(dailyCalls, 0)
  assert.deepEqual(persisted.map((row) => row.tier), ['weekly'])
  assert.equal(persisted[0].document.execution_candidates.length, 0)
  fs.rmSync(path.resolve(result.result_path), { force: true })

  const shadow = await runPiWeeklyRefresh({
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    config: config(),
    now: Date.parse(AT),
    env: {},
    collectMultiSnapshot: async () => multi,
    collectSnapshot: async () => market,
    runCluster: fixtureCluster
  })
  assert.equal(shadow.outcome, 'SHADOW_VALIDATED')
  const paths = piWeeklyShadowPaths(DATE, WEEK)
  assert.equal(JSON.parse(fs.readFileSync(paths.validation, 'utf8')).weekly.action, 'refreshed')
  fs.rmSync(paths.validation, { force: true })
  fs.rmSync(paths.provenance, { force: true })
})
