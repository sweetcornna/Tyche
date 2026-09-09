import test from 'node:test'
import assert from 'node:assert/strict'
import { getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai'
import { SESSION_MODEL_IDS, SESSION_PROVIDER_ID, SESSION_API_KEY_ENV, SESSION_ENDPOINT_ENV, SESSION_OUTPUT_BUDGET, DEFAULT_ROLE_EFFORTS, EFFORTS, ROLES, createSessionProviderRuntime, runPiAgentJob, runCluster, fixtureWorker, makeJob, makeResult, validateJob, validateResult, assertResultMatchesJob, discussSessionStrategy } from '../src/index.mjs'

const MODEL = SESSION_MODEL_IDS[0]
const ENDPOINT = 'https://models.example.test/v1'
const KEY = 'astra-effort-fixture-key'
const lookup = async () => [{ address: [93, 184, 216, 34].join('.'), family: 4 }]
const connection = { endpoint: ENDPOINT, apiKey: KEY, modelId: MODEL, lookup }
function streamResponse(item) {
  const events = [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 24, total_tokens: 36 } } }]
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
function textItem(value) { return { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] } }
function job(effort = 'high') { return makeJob({ jobId: 'astra:reviewer', runId: 'astra', role: 'reviewer', asset: null, tier: 'daily', date: '2030-01-07', isoWeek: '2030-W02', provider: SESSION_PROVIDER_ID, model: MODEL, effort, timeoutMs: 1000, input: {} }) }

test('Astra custom metadata preserves all three requested effort levels without claiming known prices or model output limits', async () => {
  const runtime = await createSessionProviderRuntime({ ...connection, fetchImpl: async () => { throw new Error('must not request') } })
  assert.equal(runtime.model.id, ['gpt', '6', 'astra'].join('-'))
  assert.equal(runtime.model.api, 'openai-responses')
  assert.equal(runtime.model.contextWindow, 272000)
  assert.deepEqual(runtime.model.input, ['text', 'image'])
  assert.equal(runtime.model.maxTokens, SESSION_OUTPUT_BUDGET)
  assert.equal(runtime.pricing, 'unavailable')
  assert.deepEqual(getSupportedThinkingLevels(runtime.model), EFFORTS)
  for (const effort of EFFORTS) assert.equal(clampThinkingLevel(runtime.model, effort), effort)
})

test('every Astra Agent uses its role effort in the real serialized Responses request and result', async () => {
  const requests = []
  const result = await runCluster({ runId: 'astra-http', tier: 'daily', date: '2030-01-07', isoWeek: '2030-W02', provider: SESSION_PROVIDER_ID, model: MODEL, timeoutMs: 2000, evidence: { assets: { BTC: {}, ETH: {} } }, runJob: (current) => runPiAgentJob(current, {
    env: { [SESSION_API_KEY_ENV]: KEY, [SESSION_ENDPOINT_ENV]: ENDPOINT }, lookup,
    fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body)
      assert.equal(body.model, MODEL)
      assert.equal(body.reasoning.effort, DEFAULT_ROLE_EFFORTS[current.role])
      assert.equal(body.max_output_tokens, SESSION_OUTPUT_BUDGET)
      assert.equal(init.body.includes(KEY), false)
      assert.deepEqual(body.tools.map((tool) => tool.name), ['submit_analysis'])
      requests.push({ role: current.role, model: body.model, effort: body.reasoning.effort })
      return streamResponse({ id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'submit_analysis', arguments: JSON.stringify({ analysis: fixtureWorker(current).output }) })
    }
  }) })
  assert.equal(result.status, 'ok', JSON.stringify(result.blockers))
  assert.equal(requests.length, 6)
  for (const role of ROLES) assert.equal(requests.find((row) => row.role === role).effort, DEFAULT_ROLE_EFFORTS[role])
  for (const row of result.results) { assert.equal(row.model, MODEL); assert.equal(row.effort, DEFAULT_ROLE_EFFORTS[row.role]); assert.equal(row.provenance.effort, row.effort) }
})

test('main discussion sends medium, high and xhigh unchanged through the actual SDK payload', async () => {
  for (const effort of EFFORTS) {
    let sent
    const result = await discussSessionStrategy({ message: '核对 effort。', roleEfforts: { orchestrator: effort } }, { ...connection, fetchImpl: async (_, init) => { sent = JSON.parse(init.body); return streamResponse(textItem({ reply: 'fixture reply', suggested_role_efforts: { reviewer: 'high' } })) } })
    assert.equal(sent.model, MODEL)
    assert.equal(sent.reasoning.effort, effort)
    assert.equal(sent.max_output_tokens, SESSION_OUTPUT_BUDGET)
    assert.deepEqual(result.suggested_role_efforts, { reviewer: 'high' })
  }
})

test('effort is required on wire identities and a retry never changes the selected model or effort', async () => {
  const valid = job('xhigh')
  for (const effort of [undefined, null, 'invalid', 1, {}]) assert.throws(() => validateJob({ ...valid, effort }), /effort/)
  const result = makeResult(valid, { status: 'ok', output: {} })
  assert.throws(() => validateResult({ ...result, effort: 'medium' }), /provenance/)
  assert.throws(() => assertResultMatchesJob(makeResult(job('medium'), { status: 'ok', output: {} }), valid), /effort/)
  const attempts = []
  const output = await runCluster({ runId: 'astra-retry', tier: 'daily', date: valid.date, isoWeek: valid.isoWeek, provider: SESSION_PROVIDER_ID, model: MODEL, evidence: { assets: { BTC: {}, ETH: {} } }, runJob: async (current) => {
    attempts.push({ role: current.role, attempt: current.attempt, model: current.model, effort: current.effort })
    if (current.role === 'reviewer' && current.attempt === 0) return fixtureWorker({ ...current, effort: 'medium' })
    return fixtureWorker(current)
  } })
  assert.equal(output.status, 'ok')
  assert.deepEqual(attempts.filter(({ role }) => role === 'reviewer').map(({ attempt, model, effort }) => ({ attempt, model, effort })), [{ attempt: 0, model: MODEL, effort: 'xhigh' }, { attempt: 1, model: MODEL, effort: 'xhigh' }])
})

test('a resolved non-session model cannot silently lower the requested effort', async () => {
  let sent = false
  const result = await runPiAgentJob(makeJob({ ...job('xhigh'), provider: 'fixture', protocol: undefined }), { model: { id: 'fixture', reasoning: true, thinkingLevelMap: { xhigh: 'high' } }, streamFn() { sent = true } })
  assert.equal(sent, false)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'PI_SESSION_MODEL_EFFORT_UNSUPPORTED')
})
