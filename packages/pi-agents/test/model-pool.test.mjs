import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionProviderRuntime, validateSessionPool, sessionPoolMetadata, SESSION_MODEL_IDS, SESSION_PROVIDER_ID, SESSION_API_KEY_ENV, SESSION_ENDPOINT_ENV, SESSION_OUTPUT_BUDGET, runPiAgentJob, runCluster, fixtureWorker, makeJob, makeResult, validateResult, assertResultMatchesJob } from '../src/index.mjs'
import { modelPoolDigest } from '../src/model-pool.mjs'

const POOL = [{ id: 'custom-fast', efforts: ['medium', 'high'] }, { id: 'custom-review', efforts: ['high', 'xhigh'] }]
const lookup = async () => [{ address: [93, 184, 216, 34].join('.'), family: 4 }]
const key = 'pool-fixture-secret'
const endpoint = 'https://models.example.test/v1'
function stream(item) { return new Response([{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) }

test('custom pool metadata stays unknown and invalid declarations never create a runtime', async () => {
  assert.equal(sessionPoolMetadata(POOL)[0].source, 'user_declared'); assert.equal(sessionPoolMetadata(POOL)[0].context_window, null); assert.equal(sessionPoolMetadata(POOL)[0].gateway_verified, false)
  const runtime = await createSessionProviderRuntime({ endpoint, apiKey: key, modelId: POOL[0].id, modelPool: POOL, lookup })
  assert.equal(runtime.model.contextWindow, 0); assert.equal(runtime.pricing, 'unavailable'); assert.equal(runtime.model.maxTokens, SESSION_OUTPUT_BUDGET)
  for (const pool of [[], Array(13).fill(POOL[0]), [POOL[0], POOL[0]], [{ id: 'model', efforts: [] }], [{ id: 'model', efforts: ['medium', 'medium'] }], [{ id: 'model', efforts: ['low'] }], [{ id: 'x'.repeat(97), efforts: ['high'] }], [{ id: 'https://other.test/v1', efforts: ['high'] }], [{ ...POOL[0], endpoint }], [{ id: SESSION_MODEL_IDS[0], efforts: ['unsupported'] }]]) assert.throws(() => validateSessionPool(pool))
  await assert.rejects(createSessionProviderRuntime({ endpoint, apiKey: key, modelId: 'removed', modelPool: POOL, lookup }), { code: 'PI_SESSION_MODEL_NOT_ALLOWED' })
})

test('custom six-role requests and retry preserve frozen pool, model and exact effort', async () => {
  const original = structuredClone(POOL); const expectedDigest = modelPoolDigest(original); const requests = []
  const roleModels = { orchestrator: 'custom-fast', preflight: 'custom-fast', 'btc-analyst': 'custom-fast', 'eth-analyst': 'custom-review', synthesizer: 'custom-review', reviewer: 'custom-review' }
  const result = await runCluster({ runId: 'custom-pool-http', tier: 'daily', date: '2030-01-07', isoWeek: '2030-W02', provider: SESSION_PROVIDER_ID, model: 'custom-fast', modelPool: original, modelMode: 'auto', roleModels, evidence: { assets: { BTC: {}, ETH: {} } }, runJob: async (job) => {
    original[0].efforts = ['medium']; original.push({ id: 'changed-after-start', efforts: ['high'] })
    const output = await runPiAgentJob(job, { env: { [SESSION_API_KEY_ENV]: key, [SESSION_ENDPOINT_ENV]: endpoint }, lookup, fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body); assert.equal(body.model, roleModels[job.role]); assert.equal(body.reasoning.effort, job.effort); assert.equal(body.max_output_tokens, SESSION_OUTPUT_BUDGET); assert.equal(init.body.includes(key), false)
      requests.push({ model: body.model, effort: body.reasoning.effort, role: job.role, attempt: job.attempt, digest: modelPoolDigest(job.modelPool) })
      return stream({ id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'submit_analysis', arguments: JSON.stringify({ analysis: fixtureWorker(job).output }) })
    } })
    if (job.role === 'reviewer' && job.attempt === 0) output.modelPoolDigest = 'a'.repeat(64)
    return output
  } })
  assert.equal(result.status, 'ok', JSON.stringify(result.blockers)); assert.equal(requests.length, 7)
  assert.ok(requests.every((entry) => entry.digest === expectedDigest)); assert.deepEqual(requests.filter(({ role }) => role === 'reviewer').map(({ model, effort, attempt }) => ({ model, effort, attempt })), [{ model: 'custom-review', effort: 'xhigh', attempt: 0 }, { model: 'custom-review', effort: 'xhigh', attempt: 1 }])
  assert.equal(result.provenance.model_pool_digest, expectedDigest); assert.equal(result.provenance.model_mode, 'auto'); assert.ok(result.provenance.attempts.every((entry) => entry.model_pool_digest === expectedDigest))
  const job = makeJob({ runId: 'pool', jobId: 'pool:reviewer', role: 'reviewer', tier: 'daily', date: '2030-01-07', isoWeek: '2030-W02', provider: SESSION_PROVIDER_ID, model: 'custom-review', effort: 'xhigh', modelPool: POOL, modelMode: 'manual', timeoutMs: 1000, input: {} })
  const valid = makeResult(job, { status: 'ok', output: {} })
  assert.throws(() => validateResult({ ...valid, modelPoolDigest: [expectedDigest] }))
  assert.throws(() => assertResultMatchesJob({ ...valid, modelPoolDigest: 'b'.repeat(64) }, job))
  assert.throws(() => makeJob({ ...job, effort: 'medium' }))
})
