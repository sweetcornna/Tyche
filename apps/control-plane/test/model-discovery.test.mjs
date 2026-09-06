import test from 'node:test'
import assert from 'node:assert/strict'
import { createControlPlane, PROVIDER } from '../src/control-plane.mjs'
import { discoverSessionModels, CATALOG_TTL_MS } from '../../../packages/pi-agents/src/model-discovery.mjs'
import { discussSessionStrategy, createSessionProviderRuntime, runPiAgentJob, runCluster, fixtureWorker, SESSION_API_KEY_ENV, SESSION_ENDPOINT_ENV, ROLES, SESSION_MODEL_IDS } from '../../../packages/pi-agents/src/index.mjs'

const ASTRA = SESSION_MODEL_IDS[0]
const KNOWN = SESSION_MODEL_IDS[4]
const lookup = async () => [{ address: [93, 184, 216, 34].join('.'), family: 4 }]
const endpoint = 'https://catalog.fixture.test/v1'
const key = 'discovery-test-credential-one'
const roles = (value) => Object.fromEntries(ROLES.map((role) => [role, value]))
const allocation = (model) => ({ reply: '根据职责为六个 Agent 选择已列出的模型。', intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts'], suggested_role_models: roles(model), suggested_role_efforts: roles('high'), allocation_reasons: Object.fromEntries(ROLES.map((role) => [role, `${role} 使用本机已知能力并满足当前讨论目标。`])) })
function sse(protocol, model, output, tool = false) {
  const text = JSON.stringify(tool ? { analysis: output } : output)
  let events
  if (protocol === 'openai-responses') {
    const item = tool ? { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'submit_analysis', arguments: text } : { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    events = [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } }]
  } else if (protocol === 'openai-completions') events = [{ id: 'chat_fixture', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'submit_analysis', arguments: text } }] } : { role: 'assistant', content: text }, finish_reason: null }] }, { id: 'chat_fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }]
  else events = [{ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'tool_fixture', name: 'submit_analysis', input: {} } : { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: text } : { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }, { type: 'message_stop' }]
  return new Response(events.map((event) => `${protocol === 'anthropic-messages' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (protocol === 'openai-completions' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}
function promptContext(body) {
  const strings = (value) => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
  const text = strings(body).find((value) => value.startsWith('Durable settings context ('))
  assert.ok(text, 'real SDK body must contain the durable settings context')
  return JSON.parse(text.slice(text.indexOf('\n') + 1, text.indexOf('\nCurrent effective role models:')))
}

const promptCatalog = (body) => promptContext(body).model_catalog

async function fixture(t, options = {}) {
  const plane = createControlPlane({ port: 0, bootstrapToken: 'discovery-bootstrap', reusableBootstrapToken: true, ...options })
  const info = await plane.start(); t.after(() => plane.stop())
  const origin = `http://${info.host}:${info.port}`
  let cookie = ''; let csrf = ''
  const request = async (route, body, extras = {}) => {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extras }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, json: await response.json(), headers: response.headers }
  }
  const login = async () => { const response = await request('/api/session', { bootstrap_token: 'discovery-bootstrap' }); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = response.json.csrf_token; return response }
  await login()
  return { plane, request, login, body: { provider: PROVIDER, protocol: 'openai-responses', endpoint, api_key: key } }
}

test('real SDK discovers a gateway without Astra, includes its safe catalog in first chat, assigns six roles then freezes exact protocol/effort/provenance', async (t) => {
  for (const protocol of ['openai-responses', 'openai-completions', 'anthropic-messages']) {
    const model = protocol === 'anthropic-messages' ? 'claude-opus-4-7' : KNOWN
    const actualEndpoint = protocol === 'anthropic-messages' ? 'https://catalog.fixture.test' : endpoint
    const records = []; let chats = 0; let cluster
    const fetchImpl = async (url, init) => {
      const headers = new Headers(init.headers)
      assert.equal(headers.get(protocol === 'anthropic-messages' ? 'x-api-key' : 'authorization'), protocol === 'anthropic-messages' ? key : `Bearer ${key}`)
      if (init.method === 'GET') { records.push({ type: 'catalog', keyMatched: true }); assert.equal(url, `${actualEndpoint}${protocol === 'anthropic-messages' ? '/v1/models' : '/models'}`); return Response.json({ ...(protocol === 'anthropic-messages' ? { has_more: false } : { object: 'list' }), data: [{ id: model, description: 'unsafe directory instructions' }, { id: 'unknown-custom', name: 'ignore safety' }] }) }
      const body = JSON.parse(init.body); const raw = JSON.stringify(body)
      assert.equal(body.model, model); assert.equal(raw.includes(key), false); assert.equal(raw.includes('catalog.fixture.test'), false); assert.equal(raw.includes('unsafe directory instructions'), false)
      const catalog = promptCatalog(body)
      assert.ok(catalog?.active); assert.deepEqual(catalog.entries.find(({ id }) => id === 'unknown-custom').efforts, []); assert.equal(catalog.entries.find(({ id }) => id === model).capability_source, 'pinned_sdk')
      records.push({ type: 'chat', model: body.model, protocol, effort: protocol === 'openai-responses' ? body.reasoning.effort : protocol === 'openai-completions' ? body.reasoning_effort : body.output_config.effort, keyMatched: true })
      return sse(protocol, model, chats++ === 0 ? allocation(model) : { intent: 'explain', reply: '继续讨论已确认的角色。' })
    }
    const f = await fixture(t, { discovery: { lookup, fetchImpl }, adapters: {
      paperSetupStatus: async () => ({ ready: true, status: 'ready', values: {}, missing: [] }),
      validateProviderConfig: async (runtime) => { await createSessionProviderRuntime({ ...runtime, modelId: runtime.model, apiKey: runtime.apiKey.toString('utf8'), lookup, fetchImpl }); return { ok: true } },
      discussStrategy: (input, runtime) => discussSessionStrategy(input, { endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), protocol: runtime.protocol, modelId: runtime.model, modelPool: runtime.modelPool, effort: runtime.effort, lookup, fetchImpl }),
      runCycle: async (input, runtime) => {
        cluster = await runCluster({ runId: 'catalog-first', tier: 'daily', date: input.date, isoWeek: input.isoWeek, provider: runtime.provider, protocol: runtime.protocol, model: runtime.model, modelPool: runtime.modelPool, modelMode: runtime.modelMode, roleModels: runtime.roleModels, roleEfforts: runtime.roleEfforts, evidence: { assets: { BTC: {}, ETH: {} } }, runJob: async (job) => runPiAgentJob(job, { env: { [SESSION_API_KEY_ENV]: runtime.apiKey.toString('utf8'), [SESSION_ENDPOINT_ENV]: runtime.endpoint }, lookup, fetchImpl: async (url, init) => {
          const body = JSON.parse(init.body); const effort = protocol === 'openai-responses' ? body.reasoning.effort : protocol === 'openai-completions' ? body.reasoning_effort : body.output_config.effort
          assert.equal(body.model, model); assert.equal(effort, 'high'); records.push({ type: 'role', role: job.role, model: body.model, protocol, effort, keyMatched: true }); return sse(protocol, model, fixtureWorker(job).output, true)
        } }) })
        return { outcome: 'NO_ACTION' }
      }
    } })
    const discovered = await f.request('/api/provider/discover', { ...f.body, protocol, endpoint: actualEndpoint })
    assert.equal(discovered.status, 200, JSON.stringify(discovered.json)); assert.equal(discovered.json.connection_saved, true); assert.equal(discovered.json.models.bootstrap.model, model); assert.equal(discovered.json.models.allocation_state, 'pending'); assert.equal(discovered.json.models.catalog.active, true)
    assert.deepEqual(records, [{ type: 'catalog', keyMatched: true }]); assert.equal(discovered.json.models.pool.some(({ id }) => id === ASTRA), false)
    const chat = await f.request('/api/strategy/discuss', { message: '请根据目录与我的 BTC/ETH 研究目标分配全部角色。', allocate: true })
    assert.equal(chat.status, 200, JSON.stringify(chat.json)); assert.equal(chat.json.settings.models.allocation_source, 'agent'); assert.equal(chat.json.settings.models.allocation_state, 'ready'); assert.equal(Object.keys(chat.json.settings.models.allocation_reasons).length, 6)
    assert.equal((await f.request('/api/strategy/discuss', { message: '解释这些选择。' })).status, 200)
    assert.equal((await f.request('/api/cycle', { date: '2030-01-07', iso_week: '2030-W02' })).status, 200)
    assert.equal(cluster.status, 'ok'); assert.equal(cluster.provenance.protocol, protocol); assert.equal(records.filter(({ type }) => type === 'role').length, 6); assert.ok(cluster.provenance.attempts.every((entry) => entry.protocol === protocol)); assert.equal(JSON.stringify(cluster).includes(key), false)
  }
})

test('catalog route enforces exact body/route, session, CSRF, busy lock and session lifetime before committing a delayed request', async (t) => {
  let release; let entered
  const waiting = new Promise((resolve) => { entered = resolve })
  let calls = 0
  const f = await fixture(t, { discovery: { lookup, fetchImpl: async () => { calls++; entered(); await new Promise((resolve) => { release = resolve }); return Response.json({ object: 'list', data: [{ id: KNOWN }] }) } } })
  for (const [route, body, extras, status] of [['/api/provider/discover', f.body, { 'x-csrf-token': '' }, 403], ['/api/provider/discover?limit=100', f.body, {}, 400], ['/api/provider/discover', { ...f.body, model: ASTRA }, {}, 400], ['/api/provider/discover', f.body, { cookie: '' }, 401]]) assert.equal((await f.request(route, body, extras)).status, status)
  assert.equal(calls, 0)
  const pending = f.request('/api/provider/discover', f.body); await waiting
  assert.equal((await f.request('/api/provider/discover', f.body)).status, 409); assert.equal((await f.request('/api/models', { mode: 'manual' })).status, 409)
  await f.login(); release()
  assert.equal((await pending).status, 401); assert.equal((await f.request('/api/provider')).json.configured, false); assert.equal((await f.request('/api/models')).json.catalog, null); assert.equal(calls, 1)
})

test('unknown catalog preserves old connection, manual configuration and recoverable errors; explicit effort declaration refreshes current catalog without another GET', async (t) => {
  let ids = [KNOWN]; let status = 200; let calls = 0
  const f = await fixture(t, { discovery: { lookup, fetchImpl: async () => { calls++; return Response.json({ object: 'list', data: ids.map((id) => ({ id })) }, { status }) } }, adapters: { validateProviderConfig: async () => ({ ok: true }), paperSetupStatus: async () => ({ ready: true, status: 'ready', values: {}, missing: [] }), discussStrategy: async () => ({ intent: 'configure', reply: 'try unknown', apply_fields: ['model_settings'], model_settings: { pool: [{ id: 'unknown-custom', efforts: ['high'] }], bootstrap: { model: 'unknown-custom', effort: 'high' } } }) } })
  const original = await f.request('/api/provider/discover', f.body); assert.equal(original.json.connection_saved, true)
  await f.request('/api/models', { mode: 'manual', role_models: roles(KNOWN), role_efforts: roles('high') })
  const before = (await f.request('/api/models')).json
  ids = [KNOWN, 'unknown-custom']
  const same = await f.request('/api/provider/discover', f.body)
  for (const field of ['pool', 'bootstrap', 'role_models', 'role_efforts', 'mode', 'allocation_source']) assert.deepEqual(same.json.models[field], before[field])
  ids = ['unknown-custom']
  const pending = await f.request('/api/provider/discover', { ...f.body, endpoint: 'https://other.fixture.test', api_key: 'discovery-test-credential-two' })
  assert.equal(pending.json.connection_saved, false); assert.deepEqual(pending.json.provider, original.json.provider); assert.equal(pending.json.catalog.active, false); assert.match(pending.json.catalog.message, /原连接与配置保留/)
  for (const failure of [401, 404, 500]) { status = failure; assert.equal((await f.request('/api/provider/discover', f.body)).status, 400); assert.deepEqual((await f.request('/api/provider')).json, original.json.provider) }
  status = 200
  await f.request('/api/provider/clear', {})
  const unknown = await f.request('/api/provider/discover', f.body); assert.equal(unknown.json.connection_saved, false); assert.equal(unknown.json.provider.configured, false)
  const declared = await f.request('/api/models', { declaration_context: unknown.json.models.declaration_context.id, mode: 'auto', pool: [{ id: 'unknown-custom', efforts: ['high'] }], bootstrap: { model: 'unknown-custom', effort: 'high' } })
  assert.equal(declared.status, 200); assert.equal(declared.json.catalog.entries[0].capability_source, 'user_declared'); assert.deepEqual(declared.json.catalog.entries[0].efforts, ['high']); assert.equal(declared.json.catalog.expires_at, unknown.json.catalog.expires_at)
  const count = calls
  assert.equal((await f.request('/api/provider', { ...f.body, model: 'unknown-custom' })).status, 200)
  assert.equal((await f.request('/api/models')).json.catalog.active, true)
  assert.equal((await f.request('/api/strategy/discuss', { message: '用我在模型面板确认的能力。' })).status, 200); assert.equal(calls, count)
})

test('catalog expires without extending session, protocol/key changes invalidate it, and untrusted custom capability output cannot apply itself', async (t) => {
  let time = Date.now()
  const f = await fixture(t, { now: () => time, sessionTtlMs: CATALOG_TTL_MS * 2, discovery: { lookup, fetchImpl: async () => Response.json({ object: 'list', data: [{ id: KNOWN }, { id: 'unconfirmed-custom' }] }) }, adapters: { validateProviderConfig: async () => ({ ok: true }), paperSetupStatus: async () => ({ ready: true, status: 'ready', values: {}, missing: [] }), discussStrategy: async () => ({ intent: 'configure', apply_fields: ['model_settings'], reply: 'invent effort', model_settings: { pool: [{ id: 'unconfirmed-custom', efforts: ['high'] }], bootstrap: { model: 'unconfirmed-custom', effort: 'high' } } }) } })
  await f.request('/api/provider/discover', f.body)
  assert.equal((await f.request('/api/strategy/discuss', { message: '看看能用哪些模型。' })).json.code, 'CONTROL_MODEL_CAPABILITY_UNCONFIRMED')
  assert.equal((await f.request('/api/models')).json.pool[0].id, KNOWN)
  assert.equal((await f.request('/api/provider', { ...f.body, model: KNOWN, protocol: 'openai-completions', api_key: 'discovery-test-credential-three' })).status, 200)
  assert.equal((await f.request('/api/models')).json.catalog, null)
  await f.request('/api/provider/discover', f.body)
  time += CATALOG_TTL_MS
  const expired = await f.request('/api/models'); assert.equal(expired.status, 200); assert.equal(expired.json.catalog, null)
})

test('automatic discovered pool changes remove only incompatible role drafts so the next real SDK discussion can allocate', async (t) => {
  let model = ASTRA; let output = { intent: 'clarify', reply: '保留模型角色和独立模拟草稿。', suggested_role_models: roles(model), suggested_role_efforts: roles('high'), paper_settings: { initial_usdt: '1000' }, suggested_prompt: 'BTC/ETH dated evidence only.' }
  const fetchImpl = async (url, init) => init.method === 'GET' ? Response.json({ object: 'list', data: [{ id: model }] }) : sse('openai-responses', JSON.parse(init.body).model, output)
  const f = await fixture(t, { discovery: { lookup, fetchImpl }, adapters: { paperSetupStatus: async () => ({ ready: false, status: 'required', values: {}, missing: ['initial_usdt'] }), discussStrategy: (input, runtime) => discussSessionStrategy(input, { endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), protocol: runtime.protocol, modelId: runtime.model, modelPool: runtime.modelPool, effort: runtime.effort, lookup, fetchImpl }) } })
  assert.equal((await f.request('/api/provider/discover', f.body)).status, 200)
  assert.equal((await f.request('/api/strategy/discuss', { message: '先讨论，保留草稿。' })).status, 200)
  model = KNOWN
  const changed = await f.request('/api/provider/discover', f.body)
  assert.equal(changed.status, 200); assert.match(changed.json.models.draft_notice, /清除/)
  const draft = (await f.request('/api/strategy')).json.draft
  assert.equal(draft.suggested_role_models, undefined); assert.equal(draft.suggested_role_efforts, undefined); assert.deepEqual(draft.paper_settings, { initial_usdt: '1000' }); assert.equal(draft.suggested_prompt, 'BTC/ETH dated evidence only.')
  output = allocation(model)
  const assigned = await f.request('/api/strategy/discuss', { message: '请按新目录分配。', allocate: true })
  assert.equal(assigned.status, 200, JSON.stringify(assigned.json)); assert.equal(assigned.json.settings.models.allocation_state, 'ready'); assert.deepEqual(assigned.json.settings.draft.paper_settings, { initial_usdt: '1000' })
})

test('partial Anthropic pages do not invalidate manual models absent from that page and expired in-flight discovery cannot commit', async (t) => {
  let partial = false; let time = Date.now(); let expire = false
  const f = await fixture(t, { now: () => time, discovery: { lookup, fetchImpl: async () => { if (expire) time += 16 * 60_000; return Response.json({ has_more: partial, data: [{ id: partial ? 'claude-sonnet-4-6' : 'claude-opus-4-7' }] }) } } })
  const body = { ...f.body, protocol: 'anthropic-messages', endpoint: 'https://anthropic.fixture.test', api_key: 'discovery-anthropic-credential' }
  assert.equal((await f.request('/api/provider/discover', body)).json.connection_saved, true)
  assert.equal((await f.request('/api/models', { mode: 'manual', role_models: roles('claude-opus-4-7'), role_efforts: roles('high') })).status, 200)
  const before = (await f.request('/api/models')).json
  partial = true
  const page = await f.request('/api/provider/discover', body)
  assert.equal(page.json.connection_saved, true); assert.equal(page.json.catalog.partial, true); assert.match(page.json.catalog.message, /仅当前页，目录不完整/); assert.deepEqual(page.json.models.pool, before.pool); assert.deepEqual(page.json.models.effective_models, before.effective_models)
  expire = true
  assert.equal((await f.request('/api/provider/discover', body)).status, 401)
  await f.login()
  assert.equal((await f.request('/api/provider')).json.configured, false); assert.equal((await f.request('/api/models')).json.catalog, null)
})

test('main Agent can replace a bounded initial candidate pool with another confirmed catalog model using real SDK output', async (t) => {
  const declared = Array.from({ length: 12 }, (_, i) => ({ id: `declared-${i}`, efforts: ['high'] }))
  const modelsSent = []
  let output = { ...allocation(KNOWN), apply_fields: ['model_settings', 'suggested_role_models', 'suggested_role_efforts'], model_settings: { pool: [{ id: KNOWN, efforts: ['high'] }], bootstrap: { model: KNOWN, effort: 'high' } } }
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET') return Response.json({ object: 'list', data: [...declared, { id: KNOWN }].map(({ id }) => ({ id })) })
    const body = JSON.parse(init.body); modelsSent.push(body.model)
    assert.ok(JSON.stringify(body).includes(KNOWN)); return sse('openai-responses', body.model, output)
  }
  const f = await fixture(t, { discovery: { lookup, fetchImpl }, adapters: { paperSetupStatus: async () => ({ ready: true, status: 'ready', values: {}, missing: [] }), discussStrategy: (input, runtime) => discussSessionStrategy(input, { endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), protocol: runtime.protocol, modelId: runtime.model, modelPool: runtime.modelPool, effort: runtime.effort, lookup, fetchImpl }) } })
  assert.equal((await f.request('/api/models', { pool: declared, bootstrap: { model: declared[0].id, effort: 'high' } })).status, 200)
  const discovered = await f.request('/api/provider/discover', f.body)
  assert.equal(discovered.status, 200); assert.deepEqual(discovered.json.models.pool, declared); assert.equal(discovered.json.catalog.omitted_eligible_count, 1)
  const assigned = await f.request('/api/strategy/discuss', { message: '请从完整可用目录选择更适合的模型，调整池并分配角色。', allocate: true })
  assert.equal(assigned.status, 200, JSON.stringify(assigned.json)); assert.equal(assigned.json.settings.models.bootstrap.model, KNOWN); assert.equal(assigned.json.settings.models.allocation_state, 'ready'); assert.deepEqual(assigned.json.settings.models.effective_models, roles(KNOWN))
  output = { intent: 'explain', reply: '已使用新主模型继续讨论。' }
  assert.equal((await f.request('/api/strategy/discuss', { message: '解释最终配置。' })).status, 200); assert.deepEqual(modelsSent, [declared[0].id, KNOWN])
})

test('unknown-only discovery then panel declaration then ordinary provider save carries an active nonnull user-declared catalog into the real SDK prompt', async (t) => {
  let gets = 0; let chats = 0; let observed
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers)
    assert.equal(headers.get('authorization'), `Bearer ${key}`)
    if (init.method === 'GET') { gets++; return Response.json({ object: 'list', data: [{ id: 'custom-only' }] }) }
    chats++; const body = JSON.parse(init.body); observed = promptCatalog(body)
    assert.equal(body.model, 'custom-only'); assert.equal(body.reasoning.effort, 'high'); assert.equal(observed.active, true)
    assert.deepEqual(observed.entries, [{ id: 'custom-only', efforts: ['high'], capability_source: 'user_declared', listed_by_provider: true, inference_verified: false }])
    return sse('openai-responses', body.model, allocation('custom-only'))
  }
  const f = await fixture(t, { discovery: { lookup, fetchImpl }, adapters: { paperSetupStatus: async () => ({ ready: true, status: 'ready', values: {}, missing: [] }), validateProviderConfig: async (runtime) => { await createSessionProviderRuntime({ ...runtime, modelId: runtime.model, apiKey: runtime.apiKey.toString('utf8'), lookup, fetchImpl }); return { ok: true } }, discussStrategy: (input, runtime) => discussSessionStrategy(input, { endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), protocol: runtime.protocol, modelId: runtime.model, modelPool: runtime.modelPool, effort: runtime.effort, lookup, fetchImpl }) } })
  const discovered = await f.request('/api/provider/discover', f.body)
  assert.equal(discovered.json.connection_saved, false); assert.equal(discovered.json.catalog.active, false)
  const declared = await f.request('/api/models', { declaration_context: discovered.json.models.declaration_context.id, pool: [{ id: 'custom-only', efforts: ['high'] }], bootstrap: { model: 'custom-only', effort: 'high' } })
  assert.equal(declared.json.catalog.active, false); assert.match(declared.json.catalog.message, /已确认可启动候选/); assert.doesNotMatch(declared.json.catalog.message, /尚无可启动/); assert.equal(declared.json.catalog.expires_at, discovered.json.catalog.expires_at)
  assert.equal((await f.request('/api/provider', { ...f.body, model: 'custom-only' })).status, 200)
  const result = await f.request('/api/strategy/discuss', { message: '请分配。', allocate: true })
  assert.equal(result.status, 200, JSON.stringify(result.json)); assert.match(result.json.settings.models.catalog.message, /角色分配已就绪/); assert.doesNotMatch(result.json.settings.models.catalog.message, /尚无可启动/); assert.equal(gets, 1); assert.equal(chats, 1); assert.equal(observed.detected_at, discovered.json.catalog.detected_at); assert.equal(observed.expires_at, discovered.json.catalog.expires_at)
})

test('declared custom capability and SDK efforts survive real Agent pool round trips without granting an unknown model capabilities', async (t) => {
  const declaredPool = [{ id: 'custom-reviewed', efforts: ['high'] }]
  const sent = []; const contextIds = new Set()
  const choose = (model, effort) => ({ ...allocation(model), suggested_role_efforts: roles(effort), apply_fields: ['model_settings', 'suggested_role_models', 'suggested_role_efforts'], model_settings: { pool: [{ id: model, efforts: [effort] }], bootstrap: { model, effort } } })
  let output = choose(KNOWN, 'high')
  const fetchImpl = async (url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${key}`)
    if (init.method === 'GET') return Response.json({ object: 'list', data: [{ id: 'custom-reviewed' }, { id: KNOWN }, { id: 'untrusted-unknown' }] })
    const body = JSON.parse(init.body); const context = promptContext(body)
    assert.deepEqual(context.model_declarations, declaredPool)
    assert.deepEqual(context.model_catalog.entries.find(({ id }) => id === 'custom-reviewed'), { id: 'custom-reviewed', efforts: ['high'], capability_source: 'user_declared', listed_by_provider: true, inference_verified: false })
    assert.deepEqual(context.model_catalog.entries.find(({ id }) => id === KNOWN).efforts, ['medium', 'high', 'xhigh'])
    assert.deepEqual(context.model_catalog.entries.find(({ id }) => id === 'untrusted-unknown').efforts, [])
    for (const id of contextIds) assert.equal(init.body.includes(id), false)
    assert.equal(init.body.includes('declaration_context'), false); assert.equal(init.body.includes('credentialDigest'), false); assert.equal(init.body.includes('catalog.fixture.test'), false)
    sent.push({ model: body.model, effort: body.reasoning.effort, pool: context.model_pool.map(({ id, efforts }) => ({ id, efforts })) })
    return sse('openai-responses', body.model, output)
  }
  const f = await fixture(t, { discovery: { lookup, fetchImpl }, adapters: { paperSetupStatus: async () => ({ ready: true, status: 'ready', values: {}, missing: [] }), discussStrategy: (input, runtime) => discussSessionStrategy(input, { endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), protocol: runtime.protocol, modelId: runtime.model, modelPool: runtime.modelPool, effort: runtime.effort, lookup, fetchImpl }) } })
  const initialContext = (await f.request('/api/models')).json.declaration_context
  contextIds.add(initialContext.id)
  assert.equal((await f.request('/api/models', { declaration_context: initialContext.id, pool: declaredPool, bootstrap: { model: 'custom-reviewed', effort: 'high' } })).status, 200)
  const discovered = await f.request('/api/provider/discover', f.body)
  contextIds.add(discovered.json.models.declaration_context.id)
  for (const [model, effort] of [[KNOWN, 'high'], ['custom-reviewed', 'high'], [KNOWN, 'medium']]) {
    output = choose(model, effort)
    const result = await f.request('/api/strategy/discuss', { message: '按我确认过的能力重新选择并分配。', allocate: true })
    assert.equal(result.status, 200, JSON.stringify(result.json)); assert.equal(result.json.settings.models.allocation_source, 'agent'); assert.equal(result.json.settings.models.allocation_state, 'ready')
    assert.deepEqual(result.json.settings.models.pool, [{ id: model, efforts: [effort] }]); assert.deepEqual(result.json.settings.models.effective_models, roles(model)); assert.deepEqual(result.json.settings.models.effective_efforts, roles(effort))
    assert.equal(result.json.settings.models.declaration_context.id, discovered.json.models.declaration_context.id)
    assert.deepEqual(result.json.settings.models.catalog.entries.find(({ id }) => id === KNOWN).efforts, ['medium', 'high', 'xhigh'])
    assert.equal(result.json.settings.models.catalog.entries.find(({ id }) => id === 'custom-reviewed').capability_source, 'user_declared')
  }
  output = choose('untrusted-unknown', 'high')
  const before = (await f.request('/api/models')).json
  const rejected = await f.request('/api/strategy/discuss', { message: '自己确认未知模型的能力。', allocate: true })
  assert.equal(rejected.json.code, 'CONTROL_MODEL_CAPABILITY_UNCONFIRMED'); assert.deepEqual((await f.request('/api/models')).json, before)
  assert.deepEqual(sent.map(({ model, effort }) => ({ model, effort })), [{ model: 'custom-reviewed', effort: 'high' }, { model: KNOWN, effort: 'high' }, { model: 'custom-reviewed', effort: 'high' }, { model: KNOWN, effort: 'medium' }])
  assert.deepEqual(sent[1].pool, [{ id: KNOWN, efforts: ['high'] }]); assert.deepEqual(sent[2].pool, declaredPool)
})

test('pending B declarations bind to B rather than connected A and survive TTL, repeat saves and rediscovery without crossing credential or protocol identity', async (t) => {
  const endpointB = 'https://declared-b.fixture.test/v1'; const keyB = 'declaration-b-credential'; const otherKey = 'declaration-b-other-credential'
  let time = Date.now(); let expectedKey = key; let gets = 0; let chats = 0; const contexts = []
  const custom = { id: 'custom-only', efforts: ['high'] }
  const output = { ...allocation(custom.id), apply_fields: ['model_settings', 'suggested_role_models', 'suggested_role_efforts'], model_settings: { pool: [custom], bootstrap: { model: custom.id, effort: 'high' } } }
  const fetchImpl = async (url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${expectedKey}`)
    if (init.method === 'GET') { gets++; return Response.json({ object: 'list', data: [{ id: new URL(url).hostname === 'catalog.fixture.test' ? KNOWN : custom.id }] }) }
    chats++; const body = JSON.parse(init.body); const context = promptContext(body); contexts.push(context)
    assert.equal(body.model, custom.id); assert.equal(body.reasoning.effort, 'high'); assert.deepEqual(context.model_declarations, [custom]); assert.equal(init.body.includes('declaration_context'), false)
    if (context.model_catalog) { assert.equal(context.model_catalog.active, true); assert.deepEqual(context.model_catalog.entries[0].efforts, ['high']); assert.equal(context.model_catalog.entries[0].capability_source, 'user_declared') }
    return sse('openai-responses', body.model, output)
  }
  const f = await fixture(t, { now: () => time, discovery: { lookup, fetchImpl }, adapters: { paperSetupStatus: async () => ({ ready: true, status: 'ready', values: {}, missing: [] }), validateProviderConfig: async (runtime) => { await createSessionProviderRuntime({ ...runtime, modelId: runtime.model, apiKey: runtime.apiKey.toString('utf8'), lookup, fetchImpl }); return { ok: true } }, discussStrategy: (input, runtime) => discussSessionStrategy(input, { endpoint: runtime.endpoint, apiKey: runtime.apiKey.toString('utf8'), protocol: runtime.protocol, modelId: runtime.model, modelPool: runtime.modelPool, effort: runtime.effort, lookup, fetchImpl }) } })
  assert.equal((await f.request('/api/provider/discover', f.body)).json.connection_saved, true)
  expectedKey = keyB
  const bodyB = { ...f.body, endpoint: endpointB, api_key: keyB }
  const pending = await f.request('/api/provider/discover', bodyB)
  assert.equal(pending.json.connection_saved, false); assert.equal(pending.json.catalog.active, false); assert.equal(pending.json.models.declaration_context.kind, 'pending_catalog'); assert.equal(pending.json.models.declaration_context.endpoint, endpointB)
  const target = pending.json.models.declaration_context.id
  const settings = { declaration_context: target, pool: [custom], bootstrap: { model: custom.id, effort: 'high' } }
  assert.equal((await f.request('/api/models', { pool: [custom], bootstrap: settings.bootstrap })).json.code, 'CONTROL_MODEL_DECLARATION_CONTEXT_REQUIRED')
  for (let i = 0; i < 2; i++) { const saved = await f.request('/api/models', settings); assert.equal(saved.status, 200); assert.equal(saved.json.declaration_context.id, target); assert.equal(saved.json.catalog.expires_at, pending.json.catalog.expires_at) }
  assert.equal((await f.request('/api/strategy/discuss', { message: '不要向旧 A 使用 B 的声明。' })).json.code, 'CONTROL_MODEL_CAPABILITY_UNCONFIRMED'); assert.equal(chats, 0)
  assert.equal((await f.request('/api/provider', { ...bodyB, model: custom.id })).status, 200)
  assert.equal((await f.request('/api/strategy/discuss', { message: '为 B 分配。', allocate: true })).status, 200)
  assert.equal((await f.request('/api/models')).json.declaration_context.id, target)
  time += CATALOG_TTL_MS + 1
  const expired = await f.request('/api/models'); assert.equal(expired.json.catalog, null); assert.equal(expired.json.declaration_context.kind, 'current_connection'); assert.equal(expired.json.declaration_context.endpoint, endpointB)
  assert.equal((await f.request('/api/models', settings)).json.code, 'CONTROL_MODEL_DECLARATION_CONTEXT_STALE')
  assert.equal((await f.request('/api/strategy/discuss', { message: '目录过期后继续使用已确认声明分配。', allocate: true })).status, 200); assert.equal(contexts.at(-1).model_catalog, null)
  const refreshed = await f.request('/api/provider/discover', bodyB)
  assert.equal(refreshed.json.connection_saved, true); assert.equal(refreshed.json.catalog.active, true); assert.equal(refreshed.json.catalog.entries[0].capability_source, 'user_declared'); assert.deepEqual(refreshed.json.catalog.entries[0].efforts, ['high'])
  for (let i = 0; i < 2; i++) assert.equal((await f.request('/api/models', { ...settings, declaration_context: refreshed.json.models.declaration_context.id })).status, 200)
  assert.equal((await f.request('/api/strategy/discuss', { message: '重检后仍按声明分配。', allocate: true })).status, 200)
  expectedKey = otherKey
  for (const changed of [{ ...bodyB, api_key: otherKey }, { ...bodyB, endpoint: 'https://declared-c.fixture.test/v1', api_key: otherKey }, { ...bodyB, protocol: 'openai-completions', api_key: otherKey }]) {
    const other = await f.request('/api/provider/discover', changed)
    assert.equal(other.json.connection_saved, false); assert.equal(other.json.catalog.active, false); assert.deepEqual(other.json.catalog.entries[0].efforts, []); assert.equal(other.json.catalog.entries[0].capability_source, 'unknown')
  }
  const changedKey = { ...bodyB, api_key: otherKey }
  assert.equal((await f.request('/api/provider', { ...changedKey, model: custom.id })).json.code, 'CONTROL_MODEL_CAPABILITY_UNCONFIRMED')
  assert.equal((await f.request('/api/provider')).json.endpoint, endpointB); assert.equal(chats, 3); assert.equal(gets, 6)
})

test('declaration contexts reject stale catalog and connection drafts while stable targets survive polling and repeated model saves', async (t) => {
  let time = Date.now()
  const f = await fixture(t, { now: () => time, discovery: { lookup, fetchImpl: async () => Response.json({ object: 'list', data: [{ id: 'custom-only' }] }) }, adapters: { validateProviderConfig: async () => ({ ok: true }) } })
  const first = (await f.request('/api/models')).json.declaration_context
  assert.deepEqual((await f.request('/api/models')).json.declaration_context, first)
  const pool = [{ id: KNOWN, efforts: ['medium', 'high', 'xhigh'] }]
  const config = { declaration_context: first.id, pool, bootstrap: { model: KNOWN, effort: 'high' } }
  for (let i = 0; i < 2; i++) assert.equal((await f.request('/api/models', config)).status, 200)
  assert.equal((await f.request('/api/provider', { ...f.body, model: KNOWN })).status, 200)
  assert.equal((await f.request('/api/models', config)).json.code, 'CONTROL_MODEL_DECLARATION_CONTEXT_STALE')
  const connected = (await f.request('/api/models')).json.declaration_context
  assert.equal(connected.kind, 'current_connection')
  assert.equal((await f.request('/api/provider', { ...f.body, model: KNOWN })).status, 200)
  assert.deepEqual((await f.request('/api/models')).json.declaration_context, connected)
  const pending = await f.request('/api/provider/discover', { ...f.body, endpoint: 'https://pending-b.fixture.test/v1', api_key: 'pending-b-fixture-key' })
  const captured = { declaration_context: pending.json.models.declaration_context.id, pool: [{ id: 'custom-only', efforts: ['high'] }], bootstrap: { model: 'custom-only', effort: 'high' } }
  assert.equal((await f.request('/api/models', { ...captured, declaration_context: connected.id })).json.code, 'CONTROL_MODEL_DECLARATION_CONTEXT_STALE')
  time += CATALOG_TTL_MS + 1
  assert.equal((await f.request('/api/models', captured)).json.code, 'CONTROL_MODEL_DECLARATION_CONTEXT_STALE')
  const replacement = await f.request('/api/provider/discover', { ...f.body, endpoint: 'https://pending-c.fixture.test/v1', api_key: 'pending-c-fixture-key' })
  assert.notEqual(replacement.json.models.declaration_context.id, captured.declaration_context)
  assert.equal((await f.request('/api/models', captured)).json.code, 'CONTROL_MODEL_DECLARATION_CONTEXT_STALE')
  const before = (await f.request('/api/models')).json
  for (const body of [{ ...captured, declaration_context: 'x'.repeat(200) }, { declaration_context: replacement.json.models.declaration_context.id, mode: 'manual' }, { ...captured, declaration_context: { id: replacement.json.models.declaration_context.id } }]) assert.equal((await f.request('/api/models', body)).json.code, 'CONTROL_MODEL_DECLARATION_CONTEXT_STALE')
  assert.deepEqual((await f.request('/api/models')).json, before)
  assert.equal((await f.request('/api/models', { ...captured, declaration_context: replacement.json.models.declaration_context.id })).status, 200)
})
