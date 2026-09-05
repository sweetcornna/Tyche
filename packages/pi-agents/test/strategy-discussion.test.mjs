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
