import test from 'node:test'
import assert from 'node:assert/strict'
import { PAPER_FIELDS, createWorkflowRunner, currentCycleWindow, providerRequest } from '../src/workflow-entry.js'

const values = { configured_leverage: '2', risk_per_trade_bps: '25', max_order_notional_usdt: '100', daily_new_notional_cap_usdt: '250', max_managed_notional_usdt: '500', initial_usdt: '1000.123456789012345678', daily_loss_bps: '100', max_drawdown_bps: '300', max_spread_bps: '12.5', max_entry_distance_bps: '40', trigger_slippage_bps: '5.125' }
const ready = { ready: true, status: 'ready', values, missing: [] }
const required = { ready: false, status: 'required', values: {}, missing: PAPER_FIELDS.map(({ key }) => key) }
const provider = { configured: true, endpoint: 'https://example.test/v1', model: 'model' }
const connection = { endpoint: provider.endpoint, model: provider.model, apiKey: 'ephemeral-fixture' }
function input(overrides = {}) { return { csrf: 'csrf', provider: { configured: false }, connection, setup: ready, onPhase() {}, onProvider() {}, onSetup() {}, now: () => new Date('2030-01-07T00:00:00Z'), ...overrides } }

test('workflow requires conversational setup and cannot create an account from page input', async () => {
  const calls = []
  const api = { async configureProvider() { calls.push('provider'); return provider }, async paperSetup() { calls.push('setup'); return ready }, async setupPaper() { assert.fail('page must not initialize Paper') }, async runCycle(value) { calls.push('cycle'); assert.deepEqual(value, { date: '2030-01-07', iso_week: '2030-W02' }); return { outcome: 'PAPER_APPLIED' } } }
  const run = createWorkflowRunner(api)
  await assert.rejects(run(input({ setup: required })), /主 Agent/)
  await assert.rejects(run(input({ connection: { ...connection, apiKey: '' } })), /API key/)
  assert.deepEqual(calls, [])
  assert.equal((await run(input())).outcome, 'PAPER_APPLIED')
  assert.deepEqual(calls, ['provider', 'setup', 'cycle'])
})

test('connection failure stops setup and setup failure stops inference', async () => {
  for (const stage of ['provider', 'setup']) {
    const calls = []
    const api = { async configureProvider() { calls.push('provider'); if (stage === 'provider') throw new Error('connection failed'); return provider }, async paperSetup() { calls.push('setup'); throw new Error('setup failed') }, async runCycle() { calls.push('cycle') } }
    await assert.rejects(createWorkflowRunner(api)(input()), /failed/)
    assert.deepEqual(calls, stage === 'provider' ? ['provider'] : ['provider', 'setup'])
  }
})

test('repeated run and same-endpoint model edits reuse the key, while endpoint edits require an explicit key before any request', async () => {
  const calls = []
  const api = { async configureProvider(value) { calls.push(['provider', value]); return provider }, async paperSetup() { calls.push(['setup']); return ready }, async runCycle(value) { calls.push(['cycle', value]); return { reused: true } } }
  const run = createWorkflowRunner(api)
  const clean = { ...connection, apiKey: '' }
  await run(input({ provider, connection: clean, setup: ready, draft: {} }))
  assert.deepEqual(calls.map(([name]) => name), ['setup', 'cycle'])
  assert.equal(calls[0][1], undefined)
  calls.length = 0
  await assert.rejects(run(input({ provider, connection: { ...clean, endpoint: 'https://other.test/v1', model: 'other-model' }, setup: ready })), /对应的 API key/)
  assert.deepEqual(calls, [])
  await run(input({ provider, connection: { ...clean, endpoint: 'https://EXAMPLE.test:443/v1/', model: 'other-model' }, setup: ready }))
  assert.equal(calls[0][0], 'provider')
  assert.equal(calls[0][1].model, 'other-model')
  assert.equal(Object.hasOwn(calls[0][1], 'apiKey'), false)
  calls.length = 0
  await run(input({ provider, connection: { ...clean, endpoint: 'https://other.test/v1', apiKey: 'explicit-other-fixture' }, setup: ready }))
  assert.equal(calls[0][1].endpoint, 'https://other.test/v1')
  assert.equal(calls[0][1].apiKey, 'explicit-other-fixture')
  for (const endpoint of ['https://example.test/v2']) assert.throws(() => providerRequest(provider, { ...clean, endpoint }), /对应的 API key/)
  assert.equal(providerRequest(provider, clean), null)
})

test('double submission is excluded and UTC date is computed when the run starts', async () => {
  let release
  let cycles = 0
  let time = new Date('2030-01-06T23:59:59Z')
  const run = createWorkflowRunner({ async configureProvider() { await new Promise((resolve) => { release = resolve }); return provider }, async paperSetup() { return ready }, async runCycle(value) { cycles++; assert.deepEqual(value, { date: '2030-01-07', iso_week: '2030-W02' }); return {} } })
  const first = run(input({ now: () => time }))
  assert.equal(await run(input()), null)
  time = new Date('2030-01-07T00:00:01Z'); release(); await first
  assert.equal(cycles, 1)
  assert.deepEqual(currentCycleWindow(new Date('2021-01-01T00:01:00Z')), { date: '2021-01-01', isoWeek: '2020-W53' })
})

test('protocol changes require an explicit paired key and operation URLs fail before any request', async () => {
  const saved = { ...provider, protocol: 'openai-responses' }
  const clean = { ...connection, protocol: saved.protocol, apiKey: '' }
  assert.equal(providerRequest(saved, clean), null)
  const calls = []
  const api = { async configureProvider(value) { calls.push(value); return { ...provider, protocol: value.protocol } }, async paperSetup() { return ready }, async runCycle() { return {} } }
  await assert.rejects(createWorkflowRunner(api)(input({ provider: saved, connection: { ...clean, protocol: 'openai-completions' } })), /协议/)
  assert.equal(calls.length, 0)
  await createWorkflowRunner(api)(input({ provider: saved, connection: { ...clean, protocol: 'openai-completions', apiKey: 'chat-paired-fixture' } }))
  assert.equal(calls[0].protocol, 'openai-completions')
  assert.equal(calls[0].apiKey, 'chat-paired-fixture')
  for (const protocol of ['openai-responses', 'openai-completions', 'anthropic-messages']) {
    if (protocol === 'anthropic-messages') assert.equal(providerRequest(saved, { ...connection, protocol, endpoint: 'https://example.test/v1/messages' }).endpoint, 'https://example.test')
    else assert.throws(() => providerRequest(saved, { ...connection, protocol, endpoint: 'https://example.test/v1/messages' }), /基础地址/)
    assert.throws(() => providerRequest({ ...saved, protocol }, { ...clean, protocol, endpoint: 'https://different.test' }), /对应的 API key/)
  }
  assert.equal(providerRequest(saved, { ...connection, protocol: 'anthropic-messages' }).endpoint, 'https://example.test')
  assert.throws(() => providerRequest(saved, { ...connection, protocol: 'auto' }), /协议/)
})

test('a session invalidated during connection setup cannot continue into another workflow stage', async () => {
  const calls = []
  let release
  let active = true
  const run = createWorkflowRunner({
    async configureProvider() { calls.push('provider'); await new Promise((resolve) => { release = resolve }); return provider },
    async paperSetup() { calls.push('setup'); return ready },
    async runCycle() { calls.push('cycle'); return {} }
  })
  const requireActive = () => { if (!active) throw new Error('session changed') }
  const pending = run(input({ onProvider: requireActive, onPhase: requireActive, onSetup: requireActive }))
  active = false
  release()
  await assert.rejects(pending, /session changed/)
  assert.deepEqual(calls, ['provider'])
})
