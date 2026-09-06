import test from 'node:test'
import assert from 'node:assert/strict'
import { discussSessionStrategy, createSessionProviderRuntime, SESSION_MODEL_IDS } from '../src/index.mjs'

const connection = { endpoint: 'https://models.example.test/v1', apiKey: 'discussion-fixture-key', modelId: SESSION_MODEL_IDS[0] }
const publicLookup = async () => [{ address: [93, 184, 216, 34].join('.'), family: 4 }]
function sse(output) {
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }
  const events = [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 } } }]
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('discussion uses the real restricted SDK transport without tools or credentials in its prompt', async () => {
  let request
  const output = { reply: '可讨论趋势与波动。', suggested_prompt: 'Prioritize dated BTC/ETH volatility evidence.' }
  const result = await discussSessionStrategy({ message: '分析重点如何调整？', prompt: 'Compare BTC and ETH.', history: [{ role: 'user', content: 'Review trend.' }, { role: 'assistant', content: 'Use dated evidence.' }] }, { ...connection, lookup: publicLookup, fetchImpl: async (url, init) => { request = { url, init }; return sse(output) } })
  assert.deepEqual(result, output)
  assert.equal(String(request.url), `${connection.endpoint}/responses`)
  assert.equal(request.init.redirect, 'manual')
  assert.equal(request.init.headers.get('authorization'), `Bearer ${connection.apiKey}`)
  const body = JSON.parse(request.init.body)
  assert.equal(body.model, connection.modelId)
  assert.ok(!body.tools || body.tools.length === 0)
  assert.doesNotMatch(request.init.body, new RegExp(connection.apiKey))
  assert.match(request.init.body, /no tools/)
  assert.match(request.init.body, /cannot override fixed roles/)
  assert.match(request.init.body, /Compare BTC and ETH/)
})

test('discussion rejects invalid inputs before connecting and discards unsafe outputs', async () => {
  let connected = 0
  const runtimeFactory = async () => { connected++; return {} }
  for (const input of [{ message: connection.apiKey }, { message: 'x'.repeat(8001) }, { message: 'valid', history: Array(9).fill({ role: 'user', content: 'x' }) }]) await assert.rejects(discussSessionStrategy(input, connection, { runtimeFactory }))
  assert.equal(connected, 0)
  for (const output of [{ reply: connection.apiKey }, { reply: 'x'.repeat(8001) }, { reply: 'okay', execute: true }]) {
    await assert.rejects(discussSessionStrategy({ message: 'valid' }, { ...connection, lookup: publicLookup, fetchImpl: async () => sse(output) }), (error) => error.message === 'PI_STRATEGY_DISCUSSION_FAILED' && !error.message.includes(connection.apiKey))
  }
})

test('discussion aborts a bounded timeout and never accepts a tool response', async () => {
  let signal
  await assert.rejects(discussSessionStrategy({ message: 'valid' }, connection, { timeoutMs: 10, runtimeFactory: async () => ({ model: {}, streamFn: (_, __, options) => { signal = options.signal; return { result: () => new Promise(() => {}) } } }) }), /PI_STRATEGY_DISCUSSION_FAILED/)
  assert.equal(signal.aborted, true)
  await assert.rejects(discussSessionStrategy({ message: 'valid' }, connection, { runtimeFactory: async () => ({ model: {}, streamFn: () => ({ result: async () => ({ stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'execute' }] }) }) }) }), /PI_STRATEGY_DISCUSSION_FAILED/)
  assert.equal(typeof createSessionProviderRuntime, 'function')
})

test('escaped credentials in raw discussion input or parsed JSON output never cross the boundary', async () => {
  for (const apiKey of ['fixture"quoted-key', 'fixture\\backslash-key']) {
    const secrets = { ...connection, apiKey }
    let connections = 0
    const runtimeFactory = async () => { connections++; throw new Error('must not connect') }
    for (const input of [{ message: apiKey }, { message: 'valid', prompt: `before ${apiKey} after` }, { message: 'valid', history: [{ role: 'user', content: apiKey }] }, { message: 'valid', history: [{ role: 'assistant', content: apiKey }] }]) {
      await assert.rejects(discussSessionStrategy(input, secrets, { runtimeFactory }), (error) => error.code === 'PI_STRATEGY_SECRET_IN_INPUT' && !error.message.includes(apiKey))
    }
    assert.equal(connections, 0)
    let requests = 0
    for (const output of [{ reply: apiKey }, { reply: 'safe', suggested_prompt: `before ${apiKey} after` }, { reply: 'safe', [apiKey]: 'unexpected field' }]) {
      await assert.rejects(discussSessionStrategy({ message: 'valid' }, { ...secrets, lookup: publicLookup, fetchImpl: async () => { requests++; return sse(output) } }), (error) => error.code === 'PI_STRATEGY_DISCUSSION_FAILED' && !error.message.includes(apiKey))
    }
    assert.equal(requests, 3)
  }
})

test('discussion sends effective model choices and returns only supported role-model suggestions', async () => {
  const roleModels = Object.fromEntries(['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer'].map((role) => [role, role === 'orchestrator' ? SESSION_MODEL_IDS[1] : SESSION_MODEL_IDS[0]]))
  let request
  const suggested = { 'btc-analyst': SESSION_MODEL_IDS[2], reviewer: SESSION_MODEL_IDS[4] }
  const settings = { ...connection, modelId: roleModels.orchestrator, lookup: publicLookup, fetchImpl: async (_, init) => { request = JSON.parse(init.body); return sse({ reply: 'Models are suggestions until applied.', suggested_role_models: suggested }) } }
  const result = await discussSessionStrategy({ message: 'Change BTC and reviewer models.', roleModels }, settings)
  assert.deepEqual(result.suggested_role_models, suggested)
  assert.equal(request.model, roleModels.orchestrator)
  const userText = JSON.stringify(request.input)
  for (const model of SESSION_MODEL_IDS) assert.ok(userText.includes(model))
  assert.ok(userText.includes('Current effective role models'))
  assert.ok(userText.includes('orchestrator'))
  assert.ok(!request.tools || request.tools.length === 0)
  for (const value of [{ admin: SESSION_MODEL_IDS[0] }, { reviewer: 'unsupported-model' }, { reviewer: SESSION_MODEL_IDS[0], endpoint: 'bad' }]) {
    await assert.rejects(discussSessionStrategy({ message: 'Change models.', roleModels }, { ...settings, fetchImpl: async () => sse({ reply: 'safe', suggested_role_models: value }) }), { code: 'PI_STRATEGY_MODELS_INVALID' })
  }
})

test('conversational setup sends only the bounded safe context and preserves configure scope through the real SDK', async () => {
  let sent
  const output = { intent: 'configure', apply_fields: ['paper_settings', 'suggested_prompt'], reply: '按已知虚拟资金安排模拟。', assumptions: ['仅为模拟起点。'], paper_settings: { configured_leverage: '2' } }
  const setupContext = { ready: false, status: 'required', values: {}, missing: ['initial_usdt', 'configured_leverage'] }
  const settingsDraft = { paper_settings: { initial_usdt: '1000.123456789012345678' }, suggested_prompt: 'BTC/ETH dated trends.' }
  const input = { message: '前面的设置保留，其余由你安排。', setupContext, settingsDraft, preferences: '不确定；虚拟资金练习。', theme: 'night', history: [{ role: 'assistant', content: 'x'.repeat(8000) }] }
  const result = await discussSessionStrategy(input, { ...connection, lookup: publicLookup, fetchImpl: async (_, init) => { sent = JSON.parse(init.body); return sse(output) } })
  assert.deepEqual(result, output)
  assert.ok(!sent.tools || sent.tools.length === 0)
  assert.match(JSON.stringify(sent.input), /1000\.123456789012345678/)
  assert.match(JSON.stringify(sent.input), /不确定；虚拟资金练习/)
  assert.match(JSON.stringify(sent), /apply_fields/)
  assert.match(JSON.stringify(sent), /No hardcoded defaults/)
  let calls = 0
  for (const change of [{ setupContext: { ...setupContext, ledger: {} } }, { settingsDraft: { endpoint: 'forbidden' } }, { preferences: 'p'.repeat(2001) }]) await assert.rejects(discussSessionStrategy({ ...input, ...change }, connection, { runtimeFactory: async () => { calls++; return {} } }))
  assert.equal(calls, 0)
})

test('conversation configuration rejects unknown fields, unsupported settings and unsafe assumptions before returning', async () => {
  const invalid = [
    { intent: 'configure', apply_fields: ['theme'], theme: 'other' },
    { intent: 'configure', apply_fields: ['paper_settings'], paper_settings: { configured_leverage: '1.00000000000000001' } },
    { intent: 'configure', apply_fields: ['paper_settings'], paper_settings: { max_spread_bps: '10000.00000000000001' } },
    { intent: 'configure', apply_fields: ['theme'], theme: 'night', execute: true },
    { intent: 'configure' },
    { intent: 'clarify', assumptions: [connection.apiKey] },
    { intent: 'clarify', questions: ['one', 'two', 'three'] }
  ]
  for (const candidate of invalid) await assert.rejects(discussSessionStrategy({ message: 'configure' }, { ...connection, lookup: publicLookup, fetchImpl: async () => sse({ reply: 'candidate', ...candidate }) }), { code: 'PI_STRATEGY_DISCUSSION_FAILED' })
})

test('real discussion validates pool-only updates and explicitly selected pool drafts without changing the request model', async () => {
  const pool = [{ id: 'draft-custom', efforts: ['medium', 'high', 'xhigh'] }]
  const roles = ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer']
  const modelSettings = { pool, mode: 'auto', bootstrap: { model: 'draft-custom', effort: 'high' } }
  const draft = { model_settings: modelSettings, suggested_role_models: Object.fromEntries(roles.map((role) => [role, 'draft-custom'])), suggested_role_efforts: Object.fromEntries(roles.map((role) => [role, 'high'])) }
  const activePool = [{ id: connection.modelId, efforts: ['medium', 'high', 'xhigh'] }]
  const scenarios = [
    { settingsDraft: {}, output: { intent: 'configure', apply_fields: ['model_settings'], reply: '只更新模型池，等待分配。', model_settings: modelSettings } },
    { settingsDraft: draft, output: { intent: 'configure', apply_fields: ['model_settings', 'suggested_role_models', 'suggested_role_efforts'], reply: '明确复用新池与六角色草稿。' } },
    { settingsDraft: draft, output: { intent: 'configure', apply_fields: ['model_settings', 'suggested_role_models', 'suggested_role_efforts'], reply: '复用新池，本轮显式给出角色映射。', suggested_role_models: draft.suggested_role_models } },
    { settingsDraft: draft, output: { intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts'], reply: '只调整当前池的 reviewer。', suggested_role_models: { reviewer: connection.modelId }, suggested_role_efforts: { reviewer: 'xhigh' } } },
    { settingsDraft: draft, output: { intent: 'configure', apply_fields: ['theme', 'suggested_prompt'], reply: '不应用旧模型池。', theme: 'night', suggested_prompt: 'BTC/ETH dated evidence.' } }
  ]
  for (const { settingsDraft, output } of scenarios) {
    let sent
    const before = structuredClone(settingsDraft)
    const result = await discussSessionStrategy({ message: '按明确范围配置。', settingsDraft, modelPool: activePool }, { ...connection, lookup: publicLookup, fetchImpl: async (_, init) => { sent = JSON.parse(init.body); return sse(output) } })
    assert.deepEqual(result, output); assert.deepEqual(settingsDraft, before)
    assert.equal(sent.model, connection.modelId); assert.equal(sent.reasoning.effort, 'high')
    assert.ok(!sent.tools || sent.tools.length === 0)
  }
  await assert.rejects(discussSessionStrategy({ message: '未选择旧模型池。', settingsDraft: draft, modelPool: activePool }, { ...connection, lookup: publicLookup, fetchImpl: async () => sse({ intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts'], reply: '不能在当前池应用旧 custom 角色。' }) }), { code: 'PI_STRATEGY_MODELS_INVALID' })
})
