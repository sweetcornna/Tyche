import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionProviderRuntime, sessionProtocolModels, SESSION_MODEL_IDS, SESSION_PROVIDER_ID, SESSION_PROTOCOLS, SESSION_API_KEY_ENV, SESSION_ENDPOINT_ENV, SESSION_OUTPUT_BUDGET, EFFORTS, runPiAgentJob, runCluster, fixtureWorker, makeJob, makeResult, validateResult, assertResultMatchesJob } from '../src/index.mjs'

const key = 'session-protocol-fixture-key'
const lookup = async () => [{ address: [93, 184, 216, 34].join('.'), family: 4 }]
const claude = 'claude-opus-4-7'
const modelFor = (protocol) => protocol === 'anthropic-messages' ? claude : SESSION_MODEL_IDS[0]
const endpointFor = (protocol) => protocol === 'anthropic-messages' ? 'https://models.example.test/gateway' : 'https://models.example.test/gateway/v1'
const pathFor = (protocol) => ({ 'openai-responses': '/responses', 'openai-completions': '/chat/completions', 'anthropic-messages': '/v1/messages' })[protocol]
function response(protocol, model, analysis) {
  let events
  if (protocol === 'openai-responses') {
    const item = analysis ? { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'submit_analysis', arguments: JSON.stringify({ analysis }) }
      : { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture', annotations: [] }] }
    events = [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } }]
  } else if (protocol === 'openai-completions') {
    events = [{ id: 'chat_fixture', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: analysis ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'submit_analysis', arguments: JSON.stringify({ analysis }) } }] } : { role: 'assistant', content: 'fixture' }, finish_reason: null }] },
      { id: 'chat_fixture', choices: [{ index: 0, delta: {}, finish_reason: analysis ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }]
  } else {
    events = [{ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: analysis ? { type: 'tool_use', id: 'tool_fixture', name: 'submit_analysis', input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: analysis ? { type: 'input_json_delta', partial_json: JSON.stringify({ analysis }) } : { type: 'text_delta', text: 'fixture' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: analysis ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: 'message_stop' }]
  }
  return new Response(events.map((event) => `${protocol === 'anthropic-messages' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (protocol === 'openai-completions' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}

function assertRequest(protocol, model, effort, input, init) {
  assert.equal(String(input), `${endpointFor(protocol)}${pathFor(protocol)}`)
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'manual')
  const headers = new Headers(init.headers)
  const body = JSON.parse(init.body)
  assert.equal(body.model, model)
  assert.equal(body.stream, true)
  assert.equal(init.body.includes(key), false)
  if (protocol === 'anthropic-messages') {
    assert.equal(headers.get('x-api-key'), key)
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('anthropic-version'), '2023-06-01')
    assert.equal(body.thinking.type, 'adaptive')
    assert.equal(body.output_config.effort, effort)
    assert.equal(body.max_tokens, SESSION_OUTPUT_BUDGET)
    assert.equal(Object.hasOwn(body.thinking, 'budget_tokens'), false)
    assert.equal(Object.hasOwn(body, 'fallback_models'), false)
  } else {
    assert.equal(headers.get('authorization'), `Bearer ${key}`)
    assert.equal(headers.get('x-api-key'), null)
    assert.equal(headers.get('anthropic-version'), null)
    assert.equal(protocol === 'openai-responses' ? body.reasoning.effort : body.reasoning_effort, effort)
    assert.equal(protocol === 'openai-responses' ? body.max_output_tokens : body.max_completion_tokens, SESSION_OUTPUT_BUDGET)
    assert.ok(Array.isArray(protocol === 'openai-responses' ? body.input : body.messages))
  }
}

test('three protocols use their real SDK path, auth, exact effort and SSE parser without inference during validation', async () => {
  for (const protocol of SESSION_PROTOCOLS) for (const effort of EFFORTS) {
    let calls = 0
    const model = modelFor(protocol)
    const runtime = await createSessionProviderRuntime({ protocol, endpoint: endpointFor(protocol), apiKey: key, modelId: model, modelPool: [{ id: model, efforts: EFFORTS }], lookup,
      fetchImpl: async (input, init) => { calls++; assertRequest(protocol, model, effort, input, init); return response(protocol, model) }
    })
    assert.equal(calls, 0)
    assert.equal(runtime.protocol, protocol)
    assert.equal(runtime.model.api, protocol)
    const result = await runtime.streamFn(runtime.model, { systemPrompt: 'Fixture only.', messages: [{ role: 'user', content: 'fixture', timestamp: 0 }], tools: [] }, { reasoning: effort, maxTokens: SESSION_OUTPUT_BUDGET, maxRetries: 0 }).result()
    assert.equal(result.stopReason, 'stop', result.errorMessage)
    assert.equal(result.api, protocol)
    assert.equal(result.content.find(({ type }) => type === 'text').text, 'fixture')
    assert.equal(calls, 1)
  }
})

test('Anthropic capability validation rejects unknown, GPT, budget and unsupported effort combinations without fallback', async () => {
  const models = sessionProtocolModels()
  assert.deepEqual(models.find(({ id }) => id === claude).efforts, EFFORTS)
  assert.deepEqual(models.find(({ id }) => id === 'claude-sonnet-4-6').efforts, ['medium', 'high'])
  const input = { protocol: 'anthropic-messages', endpoint: endpointFor('anthropic-messages'), apiKey: key, lookup, fetchImpl: () => assert.fail('must not request') }
  for (const model of [SESSION_MODEL_IDS[0], 'unknown-alias', 'claude-haiku-4-5']) await assert.rejects(createSessionProviderRuntime({ ...input, modelId: model, modelPool: [{ id: model, efforts: EFFORTS }] }), { code: 'PI_SESSION_PROTOCOL_MODEL_UNSUPPORTED' })
  await assert.rejects(createSessionProviderRuntime({ ...input, modelId: 'claude-sonnet-4-6', modelPool: [{ id: 'claude-sonnet-4-6', efforts: EFFORTS }] }), { code: 'PI_SESSION_MODEL_EFFORT_UNSUPPORTED' })
  await assert.rejects(createSessionProviderRuntime({ ...input, apiKey: 'sk-ant-oat-fixture', modelId: claude, modelPool: [{ id: claude, efforts: EFFORTS }] }), { code: 'PI_SESSION_OAUTH_UNSUPPORTED' })
  const fallback = models.find(({ id }) => id === 'claude-fable-5')
  assert.ok(fallback)
  const runtime = await createSessionProviderRuntime({ ...input, modelId: fallback.id, modelPool: [{ id: fallback.id, efforts: fallback.efforts }] })
  assert.equal(Object.hasOwn(runtime.model.compat, 'allowedFallbackModels'), false)
})

test('selected protocol operation URLs normalize while other protocol paths and unsafe requests remain blocked', async () => {
  for (const protocol of SESSION_PROTOCOLS) {
    const input = { protocol, endpoint: endpointFor(protocol), apiKey: key, modelId: modelFor(protocol), modelPool: [{ id: modelFor(protocol), efforts: EFFORTS }], lookup, fetchImpl: () => assert.fail('must not request') }
    for (const suffix of ['/responses', '/chat/completions', '/v1/messages', ...(protocol === 'anthropic-messages' ? ['/v1'] : [])]) {
      if (suffix === pathFor(protocol) || protocol === 'anthropic-messages' && suffix === '/v1') assert.equal((await createSessionProviderRuntime({ ...input, endpoint: input.endpoint + suffix })).model.baseUrl, input.endpoint)
      else await assert.rejects(createSessionProviderRuntime({ ...input, endpoint: input.endpoint + suffix }), { code: 'PI_SESSION_ENDPOINT_OPERATION_FORBIDDEN' })
    }
    await assert.rejects(createSessionProviderRuntime({ ...input, protocol: 'automatic' }), { code: 'PI_SESSION_PROTOCOL_UNSUPPORTED' })
    for (const behavior of ['dns-rebinding', 'redirect']) {
      let dnsCalls = 0
      let fetches = 0
      const runtime = await createSessionProviderRuntime({ ...input, lookup: async () => ++dnsCalls > 1 && behavior === 'dns-rebinding' ? [{ address: [10, 0, 0, 1].join('.'), family: 4 }] : lookup(), fetchImpl: async () => { fetches++; return new Response(null, { status: 307, headers: { location: 'https://other.example.test' } }) } })
      const result = await runtime.streamFn(runtime.model, { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }], tools: [] }, { reasoning: 'high', maxRetries: 0 }).result()
      assert.equal(result.stopReason, 'error')
      assert.equal(fetches, behavior === 'redirect' ? 1 : 0)
    }
  }
})

test('all six roles and retry retain frozen protocol, model pool, effort and matching provenance through real SDK tool SSE', async () => {
  for (const protocol of SESSION_PROTOCOLS) {
    const model = modelFor(protocol)
    const calls = []
    const input = { runId: 'protocol-fixture', tier: 'daily', date: '2030-01-07', isoWeek: '2030-W02', provider: SESSION_PROVIDER_ID, protocol, model, modelPool: [{ id: model, efforts: EFFORTS }], modelMode: 'manual', evidence: { assets: { BTC: {}, ETH: {} } }, runJob: async (job) => {
      input.protocol = SESSION_PROTOCOLS.find((value) => value !== protocol)
      assert.equal(job.protocol, protocol)
      assert.equal(job.modelMode, 'manual')
      const result = await runPiAgentJob(job, { env: { [SESSION_API_KEY_ENV]: key, [SESSION_ENDPOINT_ENV]: endpointFor(protocol) }, lookup, fetchImpl: async (url, init) => { assertRequest(protocol, model, job.effort, url, init); calls.push({ role: job.role, attempt: job.attempt }); return response(protocol, model, fixtureWorker(job).output) } })
      assert.equal(result.protocol, protocol)
      assert.equal(result.provenance.protocol, protocol)
      if (job.role === 'reviewer' && job.attempt === 0) { result.protocol = input.protocol; result.provenance.protocol = input.protocol }
      return result
    } }
    const result = await runCluster(input)
    assert.equal(result.status, 'ok', JSON.stringify(result.blockers))
    assert.equal(result.provenance.protocol, protocol)
    assert.ok(result.provenance.attempts.every((entry) => entry.protocol === protocol))
    assert.equal(calls.length, 7)
    assert.deepEqual(calls.filter(({ role }) => role === 'reviewer').map(({ attempt }) => attempt), [0, 1])
    const job = makeJob({ jobId: 'identity', runId: 'identity', role: 'reviewer', tier: 'daily', date: '2030-01-07', isoWeek: '2030-W02', provider: SESSION_PROVIDER_ID, protocol, model, effort: 'xhigh', timeoutMs: 1000, input: {} })
    const valid = makeResult(job, { status: 'ok', output: {} })
    assert.throws(() => validateResult({ ...valid, protocol: 'unknown' }))
    assert.throws(() => validateResult({ ...valid, provenance: { ...valid.provenance, protocol: input.protocol } }))
    assert.throws(() => assertResultMatchesJob({ ...valid, protocol: input.protocol, provenance: { ...valid.provenance, protocol: input.protocol } }, job))
    assert.equal(JSON.stringify(result).includes(key), false)
  }
})
