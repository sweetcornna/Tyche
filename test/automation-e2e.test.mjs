import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../scripts/config.mjs'
import { prepareAutomation, runAutomationPlanning } from '../scripts/crypto-automation.mjs'
import { compactMultiExchangeSnapshot } from '../scripts/crypto-market.mjs'
import { sha256Hex } from '../scripts/gate-trade.mjs'
import { applyPaperPlan, createPaperLedger, createPaperPlan, derivePaperState, settlePaper } from '../scripts/paper-trade.mjs'
import { dailySource, marketSnapshot, DATE, NOW, WEEK } from './helpers.mjs'

function config() {
  const value = structuredClone(loadConfig())
  Object.assign(value.gate.usdm, { configured_leverage: 2, risk_per_trade_bps: 25, max_order_notional_usdt: 100, daily_new_notional_cap_usdt: 200, max_managed_notional_usdt: 300 })
  return value
}

function assetResult(asset, candidates = []) {
  return {
    asset,
    symbol: `${asset}_USDT`,
    summary: `${asset} deterministic end-to-end fixture`,
    spot_bias: 'neutral',
    usdm_bias: asset === 'BTC' ? 'long' : 'neutral',
    invalidation: null,
    anchor_week: WEEK,
    anchor_fresh: true,
    evidence_refs: [`assets.${asset}`],
    execution_candidates: candidates,
    risks: []
  }
}

function canonicalDocuments() {
  const candidate = dailySource().execution_candidates[0]
  const weekly = {
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
  const daily = {
    schema: 'tyche_crypto_daily/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: new Date(NOW).toISOString(),
    anchored_week: WEEK,
    anchor_fresh: true,
    regime: { label: 'fixture' },
    assets: { BTC: assetResult('BTC', [candidate]), ETH: assetResult('ETH') },
    execution_candidates: [candidate],
    blockers: [],
    risks: []
  }
  return { weekly, daily }
}

function multiExchange() {
  const body = {
    schema: 'tyche_multi_exchange_market/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: new Date(NOW).toISOString(),
    adapter: { name: 'ccxt', dependency_pin: '4.5.77', runtime_version: 'fixture', public_only: true },
    request: { scope: 'BTC_ETH_PUBLIC_MARKET_DATA', exchange_count: 2, channels: ['ticker', 'order_book'] },
    status: 'PARTIAL',
    counts: { requested: 2, successful: 1, complete: 1, partial: 0, unavailable: 1, no_relevant_markets: 0 },
    aggregates: { BTC: { spot: { source_count: 1, consensus_price: '100' }, usdm: { source_count: 1, consensus_price: '100' } }, ETH: { spot: { source_count: 1, consensus_price: '100' }, usdm: { source_count: 1, consensus_price: '100' } } },
    exchanges: []
  }
  return { ...body, snapshot_hash: sha256Hex(body) }
}

function executionMarket(multi) {
  const market = marketSnapshot({ multi_exchange: compactMultiExchangeSnapshot(multi, { date: DATE, isoWeek: WEEK, now: NOW }) })
  for (const asset of ['BTC', 'ETH']) {
    const pair = `${asset}_USDT`
    market.assets[asset].usdm.rule = { name: pair, order_price_round: '0.1', quanto_multiplier: '0.001', order_size_min: '1', order_size_max: '100000', leverage_max: '3', maintenance_rate: '0.005', maker_fee_rate: '-0.0001', taker_fee_rate: '0.0005', funding_interval: 28800, funding_next_apply: Math.floor(NOW / 1000) + 28800, status: 'trading', in_delisting: false, enable_circuit_breaker: false }
    market.assets[asset].usdm.order_book = { id: 1, current: NOW / 1000, update: NOW / 1000, bids: [{ price: '99.9', quantity: '1000' }], asks: [{ price: '100', quantity: '1000' }] }
    market.assets[asset].usdm.risk_limit_tiers = [{ tier: 1, risk_limit: '100000', maintenance_rate: '0.005', deduction: '0', leverage_max: '3' }]
  }
  return market
}

test('complete deterministic pipeline settles, embeds cross-venue data, applies paper, and reuses the cycle', async () => {
  const localConfig = config()
  const initial = createPaperLedger({ config: localConfig, initialUsdt: '1000', dailyLossBps: '100', maxDrawdownBps: '200', maxSpreadBps: '100', maxEntryDistanceBps: '1000', triggerSlippageBps: '10', now: NOW })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-e2e-'))
  const ledgerPath = path.join(directory, 'active.json')
  fs.writeFileSync(ledgerPath, `${JSON.stringify(initial)}\n`)
  const multi = multiExchange()
  const market = executionMarket(multi)
  const order = []
  let persistedMulti = null
  let persistedMarket = null
  const prepared = await prepareAutomation({
    date: DATE,
    isoWeek: WEEK,
    config: localConfig,
    env: {},
    now: NOW,
    settleExisting: async () => { order.push('settle'); return settlePaper({ filePath: ledgerPath, now: NOW, client: {}, skipWriteEvidence: true }) },
    collectMultiSnapshot: async () => { order.push('multi'); return multi },
    writeMultiSnapshot: async (snapshot) => { persistedMulti = snapshot },
    collectSnapshot: async () => { order.push('gate'); return market },
    writeSnapshot: async (snapshot) => { persistedMarket = snapshot }
  })
  assert.deepEqual(order, ['settle', 'multi', 'gate'])
  assert.equal(prepared.multi_exchange.status, 'PARTIAL')
  assert.equal(persistedMulti.snapshot_hash, multi.snapshot_hash)
  assert.equal(persistedMarket.multi_exchange.snapshot_hash, multi.snapshot_hash)

  const { weekly, daily } = canonicalDocuments()
  let plan
  const run = async (paperLedger, previous = null) => runAutomationPlanning({
    date: DATE,
    isoWeek: WEEK,
    config: localConfig,
    daily,
    weekly,
    market,
    paperLedger,
    env: {},
    now: NOW,
    previous,
    planProduct: async () => {
      plan = createPaperPlan(daily, { config: localConfig, ledger: paperLedger, marketSnapshot: market, weeklyAnchor: weekly, date: DATE, isoWeek: WEEK, now: NOW })
      return { outcome: plan.status, product: 'usdm', environment: 'dry-run', plan_id: plan.plan_id, plan_hash: plan.plan_hash, intents: plan.intents.length, blockers: plan.blockers, skipped: plan.skipped, plan_path: `outputs/plans/gate-plan-${plan.plan_id}.json`, report_path: `outputs/reports/gate-plan-${plan.plan_id}.md`, submitted: 0, filled: 0 }
    },
    applyPlan: async () => applyPaperPlan(plan, { filePath: ledgerPath, config: localConfig, now: () => NOW, bookProvider: async () => ({ id: 2, current: NOW / 1000, update: NOW / 1000, asks: [{ p: '100', s: '1000' }], bids: [] }), killPath: path.join(directory, 'kill') })
  })
  const beforeApply = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  const first = await run(beforeApply)
  assert.equal(first.outcome, 'PAPER_APPLIED')
  assert.equal(first.submitted, 0)
  assert.equal(first.filled, 0)
  assert.ok(Number(first.simulated_filled_contracts) > 0)
  const afterApply = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  assert.ok(derivePaperState(afterApply).positions.BTC_USDT)
  const reused = await run(afterApply, first)
  assert.equal(reused.reused, true)
  assert.equal(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).events.length, afterApply.events.length)
})
