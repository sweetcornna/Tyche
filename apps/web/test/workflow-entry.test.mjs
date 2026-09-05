import test from 'node:test'
import assert from 'node:assert/strict'
import { PAPER_FIELDS, createWorkflowRunner, currentCycleWindow, providerRequest, validatePaperDraft } from '../src/workflow-entry.js'

const values = { configured_leverage: '2', risk_per_trade_bps: '25', max_order_notional_usdt: '100', daily_new_notional_cap_usdt: '250', max_managed_notional_usdt: '500', initial_usdt: '1000.123456789012345678', daily_loss_bps: '100', max_drawdown_bps: '300', max_spread_bps: '12.5', max_entry_distance_bps: '40', trigger_slippage_bps: '5.125' }
const ready = { ready: true, status: 'ready', values, missing: [] }
const required = { ready: false, status: 'required', values: {}, missing: PAPER_FIELDS.map(({ key }) => key) }
const provider = { configured: true, endpoint: 'https://example.test/v1', model: 'model' }
const connection = { endpoint: provider.endpoint, model: provider.model, apiKey: 'ephemeral-fixture' }
function input(overrides = {}) { return { csrf: 'csrf', provider: { configured: false }, connection, setup: required, draft: values, onPhase() {}, onProvider() {}, onSetup() {}, now: () => new Date('2030-01-07T00:00:00Z'), ...overrides } }

test('single workflow action validates all input before saving, setting up or running', async () => {
  const calls = []
  const api = { async configureProvider() { calls.push('provider'); return provider }, async setupPaper(value) { calls.push('setup'); assert.deepEqual(value, values); return ready }, async runCycle(value) { calls.push('cycle'); assert.deepEqual(value, { date: '2030-01-07', iso_week: '2030-W02' }); return { outcome: 'PAPER_APPLIED' } } }
  const run = createWorkflowRunner(api)
  await assert.rejects(run(input({ draft: {} })), /初始模拟资金/)
  await assert.rejects(run(input({ connection: { ...connection, apiKey: '' } })), /API key/)
  assert.deepEqual(calls, [])
  assert.equal((await run(input())).outcome, 'PAPER_APPLIED')
  assert.deepEqual(calls, ['provider', 'setup', 'cycle'])
  assert.equal(validatePaperDraft(required, values).initial_usdt, values.initial_usdt)
})

test('connection failure stops setup and setup failure stops inference', async () => {
  for (const stage of ['provider', 'setup']) {
    const calls = []
    const api = { async configureProvider() { calls.push('provider'); if (stage === 'provider') throw new Error('connection failed'); return provider }, async setupPaper() { calls.push('setup'); throw new Error('setup failed') }, async runCycle() { calls.push('cycle') } }
    await assert.rejects(createWorkflowRunner(api)(input()), /failed/)
    assert.deepEqual(calls, stage === 'provider' ? ['provider'] : ['provider', 'setup'])
  }
})

test('repeated run reuses connection and settings, while endpoint/model edits are submitted', async () => {
  const calls = []
  const api = { async configureProvider(value) { calls.push(['provider', value]); return provider }, async setupPaper(value) { calls.push(['setup', value]); return ready }, async runCycle(value) { calls.push(['cycle', value]); return { reused: true } } }
  const run = createWorkflowRunner(api)
  const clean = { ...connection, apiKey: '' }
  await run(input({ provider, connection: clean, setup: ready, draft: {} }))
  assert.deepEqual(calls.map(([name]) => name), ['setup', 'cycle'])
  assert.deepEqual(calls[0][1], {})
  calls.length = 0
  await run(input({ provider, connection: { ...clean, endpoint: 'https://other.test/v1', model: 'other-model' }, setup: ready }))
  assert.equal(calls[0][0], 'provider')
  assert.equal(calls[0][1].endpoint, 'https://other.test/v1')
  assert.equal(calls[0][1].model, 'other-model')
  assert.equal(Object.hasOwn(calls[0][1], 'apiKey'), false)
  assert.equal(providerRequest(provider, clean), null)
})

test('double submission is excluded and UTC date is computed when the run starts', async () => {
  let release
  let cycles = 0
  let time = new Date('2030-01-06T23:59:59Z')
  const run = createWorkflowRunner({ async configureProvider() { await new Promise((resolve) => { release = resolve }); return provider }, async setupPaper() { return ready }, async runCycle(value) { cycles++; assert.deepEqual(value, { date: '2030-01-07', iso_week: '2030-W02' }); return {} } })
  const first = run(input({ now: () => time }))
  assert.equal(await run(input()), null)
  time = new Date('2030-01-07T00:00:01Z'); release(); await first
  assert.equal(cycles, 1)
  assert.deepEqual(currentCycleWindow(new Date('2021-01-01T00:01:00Z')), { date: '2021-01-01', isoWeek: '2020-W53' })
})
