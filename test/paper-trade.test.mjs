import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../scripts/config.mjs'
import {
  appendPaperEventsValue,
  appendPaperEvents,
  applyPaperPlan,
  createPaperLedger,
  createPaperPlan,
  derivePaperState,
  evaluateProtectionBars,
  fetchMinuteBars,
  paperEntryBlocker,
  settlePaper,
  simulateBookFill,
  validatePaperLedger,
  writePaperReport
} from '../scripts/paper-trade.mjs'
import { sha256Hex } from '../scripts/gate-trade.mjs'
import { dailySource, marketSnapshot, weeklyAnchor, DATE, NOW, WEEK } from './helpers.mjs'

function paperConfig() {
  const config = structuredClone(loadConfig())
  Object.assign(config.gate.usdm, {
    configured_leverage: 2,
    risk_per_trade_bps: 25,
    max_order_notional_usdt: 100,
    daily_new_notional_cap_usdt: 200,
    max_managed_notional_usdt: 300
  })
  return config
}

function ledger(config = paperConfig()) {
  return createPaperLedger({ config, initialUsdt: '1000', dailyLossBps: '100', maxDrawdownBps: '200', maxSpreadBps: '100', maxEntryDistanceBps: '1000', triggerSlippageBps: '10', now: NOW })
}

function paperMarket() {
  const market = marketSnapshot()
  for (const asset of ['BTC', 'ETH']) {
    const pair = `${asset}_USDT`
    market.assets[asset].usdm.rule = {
      name: pair,
      order_price_round: '0.1',
      quanto_multiplier: '0.001',
      order_size_min: '1',
      order_size_max: '100000',
      leverage_max: '3',
      maintenance_rate: '0.005',
      maker_fee_rate: '-0.0001',
      taker_fee_rate: '0.0005',
      funding_interval: 28800,
      funding_next_apply: 1893484800,
      status: 'trading',
      in_delisting: false,
      enable_circuit_breaker: false
    }
    market.assets[asset].usdm.order_book = { id: 1, current: NOW / 1000, update: NOW / 1000, bids: [{ price: '99.9', quantity: '1000' }], asks: [{ price: '100', quantity: '1000' }] }
    market.assets[asset].usdm.risk_limit_tiers = [{ tier: 1, risk_limit: '100000', maintenance_rate: '0.005', deduction: '0', leverage_max: '3' }]
  }
  return market
}

function readyPaperPlan(config = paperConfig(), account = ledger(config), source = dailySource()) {
  const plan = createPaperPlan(source, { config, ledger: account, marketSnapshot: paperMarket(), weeklyAnchor: weeklyAnchor(), date: DATE, isoWeek: WEEK, now: NOW })
  assert.equal(plan.status, 'READY', JSON.stringify({ blockers: plan.blockers, skipped: plan.skipped }))
  return { config, account, plan }
}

function tempLedger(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-paper-'))
  const file = path.join(directory, 'active.json')
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`)
  return { directory, file }
}

function paperBook(value = {}, at = NOW) {
  return { id: value.id ?? 1, current: at / 1000, update: at / 1000, ...value }
}

test('paper account requires explicit policy and rejects configuration drift', () => {
  const config = paperConfig()
  const account = ledger(config)
  assert.equal(validatePaperLedger(account).schema, 'tyche_paper_ledger/v1')
  assert.match(account.account_id, /^pa_[a-f0-9]{24}$/)
  assert.equal(account.policy.max_positions, 2)
  assert.throws(() => createPaperLedger({ config, initialUsdt: '1000' }), { code: 'PAPER_POSITIVE_REQUIRED' })
  const changed = structuredClone(config)
  changed.gate.usdm.max_order_notional_usdt = 99
  assert.throws(() => createPaperPlan(dailySource(), { config: changed, ledger: account, marketSnapshot: paperMarket(), weeklyAnchor: weeklyAnchor(), date: DATE, isoWeek: WEEK, now: NOW }), { code: 'PAPER_CONFIG_DRIFT' })
})

test('paper performance report separates simulated contracts from venue lifecycle', () => {
  const account = ledger()
  const { directory } = tempLedger(account)
  const reportPath = path.join(directory, 'paper-report.md')
  const result = writePaperReport(account, { reportPath, now: NOW })
  const markdown = fs.readFileSync(reportPath, 'utf8')
  assert.equal(result.submitted, 0)
  assert.equal(result.filled, 0)
  assert.match(markdown, /Simulated filled contracts: 0/)
  assert.match(markdown, /Venue submitted: 0; venue filled: 0/)
})

test('paper ledger is append-only, idempotent, and detects tampering', () => {
  const account = ledger()
  const raw = { type: 'SIMULATED_EQUITY_MARK', at: new Date(NOW).toISOString(), source_id: 'fixture:equity', data: { equity: '1000', marks: {} } }
  const once = appendPaperEventsValue(account, [raw])
  const twice = appendPaperEventsValue(once, [raw])
  assert.equal(twice.events.length, 1)
  const changed = structuredClone(twice)
  changed.events[0].data.equity = '2000'
  assert.throws(() => validatePaperLedger(changed), { code: 'PAPER_EVENT_CHAIN_INVALID' })
})

test('paper ledger rejects empty and corrupt files and serializes concurrent appenders', async () => {
  const account = ledger()
  const { directory, file } = tempLedger(account)
  const empty = path.join(directory, 'empty.json')
  const corrupt = path.join(directory, 'corrupt.json')
  fs.writeFileSync(empty, '')
  fs.writeFileSync(corrupt, '{broken')
  await assert.rejects(settlePaper({ filePath: empty, now: NOW, skipWriteEvidence: true }), { code: 'STATE_ZERO_LENGTH' })
  await assert.rejects(settlePaper({ filePath: corrupt, now: NOW, skipWriteEvidence: true }), { code: 'STATE_JSON_CORRUPT' })

  const moduleUrl = pathToFileURL(path.resolve('scripts/paper-trade.mjs')).href
  const childCode = `import { appendPaperEvents } from ${JSON.stringify(moduleUrl)}; appendPaperEvents(process.argv[1], [{ type: 'SIMULATED_EQUITY_MARK', at: process.argv[2], source_id: process.argv[3], data: { equity: '1000', marks: {} } }])`
  const run = (sourceId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, file, new Date(NOW).toISOString(), sourceId], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`paper append child exited ${code}`)))
  })
  await Promise.all([run('fixture:concurrent:a'), run('fixture:concurrent:b')])
  const current = validatePaperLedger(JSON.parse(fs.readFileSync(file, 'utf8')))
  assert.equal(current.events.length, 2)
  appendPaperEvents(file, [])
})

test('book fill is conservative and bounded by visible opposing depth', () => {
  const intent = { side: 'BUY', price: '100', quantity: '10' }
  assert.deepEqual(simulateBookFill(intent, paperBook({ id: 7, asks: [{ p: '99', s: '12' }] })), { contracts: '10', price: '100', complete: true, book_id: '7', book_current: String(NOW / 1000), book_update: String(NOW / 1000), visible_contracts: '12' })
  assert.deepEqual(simulateBookFill(intent, paperBook({ id: 8, asks: [{ p: '99', s: '3' }] })), { contracts: '3', price: '100', complete: false, book_id: '8', book_current: String(NOW / 1000), book_update: String(NOW / 1000), visible_contracts: '3' })
  assert.equal(simulateBookFill(intent, paperBook({ asks: [{ p: '101', s: '12' }] })), null)
  assert.throws(() => simulateBookFill(intent, { id: 9, asks: [{ p: '99', s: '12' }] }), { code: 'PAPER_BOOK_EVIDENCE_INVALID' })
})

test('minute evidence paginates at the 2000-row Gate boundary without gaps', async () => {
  const calls = []
  const start = NOW
  const end = start + 2001 * 60000
  const rows = await fetchMinuteBars({
    usdmCandlesticks: async (input) => {
      calls.push(input)
      const data = []
      for (let t = input.from; t <= input.to; t += 60) data.push({ t, o: '100', h: '101', l: '99', c: '100' })
      return { data }
    }
  }, 'mark_BTC_USDT', start, end)
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.limit === 2000 && call.interval === '1m' && call.to - call.from <= 1999 * 60))
  assert.equal(rows.length, 2001)
  assert.equal(rows[0].t, start / 1000)
  assert.equal(rows.at(-1).t, start / 1000 + 2000 * 60)
})

test('paper plan uses deterministic selection and seals liquidation evidence', () => {
  const { plan } = readyPaperPlan()
  assert.equal(plan.product, 'usdm')
  assert.equal(plan.environment, 'dry-run')
  assert.equal(plan.selection_proof.policy, 'tyche_usdm_selection/v1')
  assert.equal(Object.keys(plan.paper_risk_proof).length, 1)
  assert.equal(plan.paper_risk_proof[plan.intents[0].intent_id].liquidation_price, '50.3')
  assert.equal(plan.paper_risk_proof[plan.intents[0].intent_id].tier_deduction, '0')
  assert.equal(plan.paper_risk_proof[plan.intents[0].intent_id].liquidation_estimated, true)
  assert.equal(plan.paper_policy_proof.policy_digest.length, 64)
})

test('paper plan supports short geometry and blocks new entries under kill switch', () => {
  const config = paperConfig()
  const account = ledger(config)
  const source = dailySource({ candidate: { position_intent: 'ENTER_SHORT', stop_price: 110, take_profit_price: 80, signal_id: 'fixture:btc:short' } })
  const market = paperMarket()
  market.assets.BTC.usdm.technical.daily.level_sets.short = { entry: 100, stop: 110, target: 80 }
  const anchor = weeklyAnchor()
  anchor.assets.BTC.usdm_bias = 'short'
  const plan = createPaperPlan(source, { config, ledger: account, marketSnapshot: market, weeklyAnchor: anchor, date: DATE, isoWeek: WEEK, now: NOW })
  assert.equal(plan.status, 'READY')
  assert.ok(Number(plan.paper_risk_proof[plan.intents[0].intent_id].liquidation_price) > 100)
  const killed = createPaperPlan(dailySource(), { config, ledger: account, marketSnapshot: paperMarket(), weeklyAnchor: weeklyAnchor(), date: DATE, isoWeek: WEEK, now: NOW, killActive: true })
  assert.equal(killed.status, 'BLOCKED')
  assert.ok(killed.skipped.some((row) => row.code === 'GATE_KILL_ACTIVE'))
  const restricted = paperMarket()
  restricted.assets.BTC.usdm.risk_limit_tiers[0].leverage_max = '1'
  const tierBlocked = createPaperPlan(dailySource(), { config, ledger: account, marketSnapshot: restricted, weeklyAnchor: weeklyAnchor(), date: DATE, isoWeek: WEEK, now: NOW })
  assert.equal(tierBlocked.status, 'BLOCKED')
  assert.ok(tierBlocked.blockers.some((row) => row.code === 'PAPER_RISK_TIER_LEVERAGE'))
})

test('paper apply records a simulated fill, estimated fee, isolated margin, and protection', async () => {
  const { config, account, plan } = readyPaperPlan()
  const { directory, file } = tempLedger(account)
  const receipt = await applyPaperPlan(plan, { filePath: file, config, now: () => NOW, bookProvider: async () => paperBook({ id: 1, asks: [{ p: '100', s: '1000' }], bids: [] }), killPath: path.join(directory, 'kill') })
  const state = derivePaperState(JSON.parse(fs.readFileSync(file, 'utf8')))
  assert.equal(receipt.submitted, 0)
  assert.equal(receipt.filled, 0)
  assert.equal(receipt.simulated_filled_contracts, plan.intents[0].quantity)
  assert.equal(state.positions.BTC_USDT.stop_price, '90')
  assert.equal(state.positions.BTC_USDT.target_price, '120')
  assert.ok(decimalLess(state.balance, '1000'))
})

test('paper apply resumes an open reservation inside its original watch deadline', async () => {
  const { config, account, plan } = readyPaperPlan()
  const { directory, file } = tempLedger(account)
  const intent = plan.intents[0]
  const paperOrderId = `po_${sha256Hex({ plan_id: plan.plan_id, intent_id: intent.intent_id }).slice(0, 24)}`
  const openedAt = new Date(NOW).toISOString()
  const interrupted = appendPaperEventsValue(account, [{ type: 'SIMULATED_ORDER_OPEN', at: openedAt, source_id: `${paperOrderId}:open`, data: { paper_order_id: paperOrderId, plan_id: plan.plan_id, intent_id: intent.intent_id, symbol: intent.symbol, role: intent.role, side: intent.side, quantity: intent.quantity, price: intent.price, signal_id: intent.signal_id } }])
  fs.writeFileSync(file, `${JSON.stringify(interrupted)}\n`)
  const receipt = await applyPaperPlan(plan, { filePath: file, config, now: () => NOW + 5000, bookProvider: async () => paperBook({ id: 1, asks: [{ p: '100', s: '1000' }] }, NOW + 5000), killPath: path.join(directory, 'kill') })
  const current = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(receipt.outcomes[0].outcome, 'SIMULATED_FILLED')
  assert.equal(current.events.filter((event) => event.type === 'SIMULATED_ORDER_OPEN').length, 1)
  assert.equal(derivePaperState(current).positions.BTC_USDT.contracts, intent.quantity)
})

test('a kill switch activated after planning blocks entries but still permits a managed exit', async () => {
  const { config, account, plan } = readyPaperPlan()
  const { directory, file } = tempLedger(account)
  const killPath = path.join(directory, 'gate_KILL')
  fs.writeFileSync(killPath, '')
  const blocked = await applyPaperPlan(plan, { filePath: file, config, now: () => NOW, bookProvider: async () => paperBook({ id: 1, asks: [{ p: '100', s: '1000' }] }), killPath })
  assert.equal(blocked.outcomes[0].code, 'GATE_KILL_ACTIVE')
  assert.equal(Object.keys(derivePaperState(JSON.parse(fs.readFileSync(file, 'utf8'))).positions).length, 0)

  fs.unlinkSync(killPath)
  await applyPaperPlan(plan, { filePath: file, config, now: () => NOW, bookProvider: async () => paperBook({ id: 2, asks: [{ p: '100', s: '1000' }] }), killPath })
  const managed = JSON.parse(fs.readFileSync(file, 'utf8'))
  const exitSource = dailySource({ candidate: { position_intent: 'EXIT_LONG', stop_price: null, take_profit_price: null, reduce_fraction_bps: 10000, signal_id: 'fixture:btc:paper-exit' } })
  const exitPlan = createPaperPlan(exitSource, { config, ledger: managed, marketSnapshot: paperMarket(), weeklyAnchor: weeklyAnchor(), date: DATE, isoWeek: WEEK, now: NOW + 1000 })
  assert.equal(exitPlan.status, 'READY')
  fs.writeFileSync(killPath, '')
  const exited = await applyPaperPlan(exitPlan, { filePath: file, config, now: () => NOW + 2000, bookProvider: async () => paperBook({ id: 3, bids: [{ p: '100', s: '1000' }] }, NOW + 2000), killPath })
  assert.equal(exited.outcomes[0].outcome, 'SIMULATED_FILLED')
  assert.equal(Object.keys(derivePaperState(JSON.parse(fs.readFileSync(file, 'utf8'))).positions).length, 0)
})

test('partial paper fill cancels the remainder and never reuses visible depth', async () => {
  const { config, account, plan } = readyPaperPlan()
  const { directory, file } = tempLedger(account)
  const receipt = await applyPaperPlan(plan, { filePath: file, config, now: () => NOW, bookProvider: async () => paperBook({ id: 2, asks: [{ p: '100', s: '3' }] }), killPath: path.join(directory, 'kill') })
  const state = derivePaperState(JSON.parse(fs.readFileSync(file, 'utf8')))
  assert.equal(receipt.outcomes[0].outcome, 'SIMULATED_PARTIAL_FILL')
  assert.equal(state.positions.BTC_USDT.contracts, '3')
  assert.equal(Object.values(state.orders)[0].status, 'CANCELLED')
})

test('unfilled paper order expires after the configured watch window', async () => {
  const { config, account, plan } = readyPaperPlan()
  const { directory, file } = tempLedger(account)
  let clock = NOW
  const receipt = await applyPaperPlan(plan, { filePath: file, config, now: () => clock, sleep: async (ms) => { clock += ms }, bookProvider: async () => paperBook({ id: clock, asks: [{ p: '101', s: '1000' }] }, clock), killPath: path.join(directory, 'kill') })
  const state = derivePaperState(JSON.parse(fs.readFileSync(file, 'utf8')))
  assert.equal(receipt.outcomes[0].outcome, 'SIMULATED_CANCELLED')
  assert.equal(Object.keys(state.positions).length, 0)
})

test('protection evaluation chooses liquidation first and stop over same-bar target', () => {
  const position = { side: 'long', stop_price: '90', target_price: '120', liquidation_price: '50', tick_size: '0.1' }
  const policy = { trigger_slippage_bps: '10' }
  assert.equal(evaluateProtectionBars(position, [{ t: 1, o: '100', h: '121', l: '89', c: '100' }], policy).kind, 'stop')
  assert.equal(evaluateProtectionBars(position, [{ t: 2, o: '100', h: '121', l: '49', c: '100' }], policy).kind, 'liquidation')
})

test('settlement closes protected positions and duplicate settlement is idempotent', async () => {
  const { config, account, plan } = readyPaperPlan()
  const { directory, file } = tempLedger(account)
  await applyPaperPlan(plan, { filePath: file, config, now: () => NOW, bookProvider: async () => paperBook({ id: 1, asks: [{ p: '100', s: '1000' }] }), killPath: path.join(directory, 'kill') })
  const bar = { t: Math.floor(NOW / 1000) + 60, o: '100', h: '121', l: '89', c: '100' }
  const first = await settlePaper({ filePath: file, now: NOW + 120000, bars: { BTC_USDT: [bar] }, funding: { BTC_USDT: [] }, skipWriteEvidence: true })
  const events = JSON.parse(fs.readFileSync(file, 'utf8')).events.length
  const second = await settlePaper({ filePath: file, now: NOW + 120000, bars: {}, funding: {}, skipWriteEvidence: true })
  assert.equal(first.state.positions.length, 0)
  assert.equal(second.state.positions.length, 0)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).events.length, events)
})

test('settlement applies signed funding once and equity loss trips the daily breaker', async () => {
  const { config, account, plan } = readyPaperPlan()
  const { directory, file } = tempLedger(account)
  await applyPaperPlan(plan, { filePath: file, config, now: () => NOW, bookProvider: async () => paperBook({ id: 1, asks: [{ p: '100', s: '1000' }] }), killPath: path.join(directory, 'kill') })
  const barTime = Math.floor(NOW / 1000) + 60
  await settlePaper({ filePath: file, now: NOW + 180000, bars: { BTC_USDT: [{ t: barTime, o: '100', h: '105', l: '95', c: '101' }, { t: barTime + 60, o: '101', h: '105', l: '95', c: '101' }] }, funding: { BTC_USDT: [{ t: barTime + 60, r: '0.001' }] }, skipWriteEvidence: true })
  let current = JSON.parse(fs.readFileSync(file, 'utf8'))
  let state = derivePaperState(current)
  assert.ok(Number(state.funding) < 0)
  const fundingEvents = current.events.filter((event) => event.type === 'SIMULATED_FUNDING_APPLIED').length
  await settlePaper({ filePath: file, now: NOW + 180000, bars: { BTC_USDT: [] }, funding: { BTC_USDT: [] }, skipWriteEvidence: true })
  current = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(current.events.filter((event) => event.type === 'SIMULATED_FUNDING_APPLIED').length, fundingEvents)
  current = appendPaperEventsValue(current, [{ type: 'SIMULATED_EQUITY_MARK', at: new Date(NOW + 240000).toISOString(), source_id: 'fixture:drawdown', data: { equity: '900', marks: { BTC_USDT: '100' } } }])
  state = derivePaperState(current)
  assert.equal(paperEntryBlocker(current, state, NOW + 240000), 'PAPER_DAILY_LOSS_BREAKER')
})

test('peak-to-current drawdown trips independently of the wider daily limit', async () => {
  const config = paperConfig()
  let account = createPaperLedger({ config, initialUsdt: '1000', dailyLossBps: '1000', maxDrawdownBps: '200', maxSpreadBps: '100', maxEntryDistanceBps: '1000', triggerSlippageBps: '10', now: NOW })
  const plan = createPaperPlan(dailySource(), { config, ledger: account, marketSnapshot: paperMarket(), weeklyAnchor: weeklyAnchor(), date: DATE, isoWeek: WEEK, now: NOW })
  const { directory, file } = tempLedger(account)
  await applyPaperPlan(plan, { filePath: file, config, now: () => NOW, bookProvider: async () => paperBook({ id: 1, asks: [{ p: '100', s: '1000' }] }), killPath: path.join(directory, 'kill') })
  account = appendPaperEventsValue(JSON.parse(fs.readFileSync(file, 'utf8')), [{ type: 'SIMULATED_EQUITY_MARK', at: new Date(NOW + 60000).toISOString(), source_id: 'fixture:drawdown-only', data: { equity: '970', marks: { BTC_USDT: '70' } } }])
  const state = derivePaperState(account)
  assert.equal(state.daily_equity_change[DATE], '-30')
  assert.equal(paperEntryBlocker(account, state, NOW + 60000), 'PAPER_DRAWDOWN_BREAKER')
})

test('evidence gaps become sticky entry blockers while protection settlement remains callable', async () => {
  const { config, account, plan } = readyPaperPlan()
  const { directory, file } = tempLedger(account)
  await applyPaperPlan(plan, { filePath: file, config, now: () => NOW, bookProvider: async () => paperBook({ id: 1, asks: [{ p: '100', s: '1000' }] }), killPath: path.join(directory, 'kill') })
  await settlePaper({ filePath: file, now: NOW + 120000, client: { usdmCandlesticks: async () => { throw Object.assign(new Error('gap'), { code: 'FIXTURE_GAP' }) }, usdmFundingRate: async () => ({ data: [] }) }, skipWriteEvidence: true })
  const current = JSON.parse(fs.readFileSync(file, 'utf8'))
  const state = derivePaperState(current)
  assert.equal(state.evidence_gap, true)
  assert.equal(paperEntryBlocker(current, state, NOW + 120000), 'SIMULATION_EVIDENCE_GAP')
})

function decimalLess(left, right) {
  return Number(left) < Number(right)
}
