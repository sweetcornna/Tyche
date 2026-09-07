import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { createConversationStore } from '../src/conversations.mjs'
import { createControlPlane, PROVIDER, PROVIDER_MODELS } from '../src/control-plane.mjs'

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-history-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return path.join(root, 'history.json')
}
const pair = (content = 'BTC 与 ETH') => [{ role: 'user', content }, { role: 'assistant', content: '测试回复' }]

test('history survives process recreation, pins, searches message bodies, archives and restores', (t) => {
  const file = temporary(t), first = createConversationStore({ file })
  const a = first.create(), b = first.create()
  const updated = first.append(a.id, a.revision, pair('首行标题\n独有搜索词'))
  first.update(b.id, { title: '置顶对话', pinned: true, model: PROVIDER_MODELS[0], effort: 'medium' })
  const reopened = createConversationStore({ file })
  assert.equal(reopened.list()[0].id, b.id)
  assert.equal(reopened.get(a.id).messages.length, 2)
  assert.equal(reopened.search('独有搜索词')[0].id, a.id)
  assert.equal('messages' in reopened.list()[0], false)
  reopened.update(a.id, { archived: true })
  assert.throws(() => reopened.append(a.id, updated.revision, pair()), { code: 'CONTROL_HISTORY_CONFLICT' })
  reopened.update(a.id, { archived: false })
  reopened.append(a.id, reopened.get(a.id).revision, pair())
  assert.equal(reopened.get(a.id).messages.length, 4)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('history rejects stale commits, extra fields, credential strings, and invalid models without mutation', () => {
  const store = createConversationStore(), c = store.create()
  assert.throws(() => store.update(c.id, { api_key: 'private' }), { code: 'CONTROL_HISTORY_INVALID' })
  assert.throws(() => store.update(c.id, { effort: 'unlimited' }), { code: 'CONTROL_HISTORY_INVALID' })
  assert.throws(() => store.append(c.id, 0, pair('sk-credential-fixture-do-not-store')), { code: 'CONTROL_HISTORY_INVALID' })
  assert.equal(store.get(c.id).revision, 0)
  store.append(c.id, 0, pair())
  assert.throws(() => store.append(c.id, 0, pair()), { code: 'CONTROL_HISTORY_CONFLICT' })
  assert.equal(store.get(c.id).messages.length, 2)
})

test('corrupt, public, symbolic-link and oversized history files fail closed and are not replaced', (t) => {
  const file = temporary(t)
  for (const text of ['', '{', '{"schema":1,"items":[],"secret":true}', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    fs.writeFileSync(file, text, { mode: 0o600 })
    const store = createConversationStore({ file })
    assert.throws(() => store.list(), { code: 'CONTROL_HISTORY_INVALID' })
    assert.throws(() => store.create(), { code: 'CONTROL_HISTORY_INVALID' })
    assert.equal(fs.readFileSync(file, 'utf8'), text)
  }
  fs.writeFileSync(file, '{"schema":1,"items":[]}')
  fs.chmodSync(file, 0o644)
  assert.throws(() => createConversationStore({ file }).list(), { code: 'CONTROL_HISTORY_INVALID' })
  fs.chmodSync(file, 0o600)
  const link = path.join(path.dirname(file), 'link.json')
  fs.symlinkSync(file, link)
  assert.throws(() => createConversationStore({ file: link }).create(), { code: 'CONTROL_HISTORY_INVALID' })
  const dir = path.join(path.dirname(file), 'linked-dir')
  fs.symlinkSync(path.dirname(file), dir)
  assert.throws(() => createConversationStore({ file: path.join(dir, 'other.json') }).create(), { code: 'CONTROL_HISTORY_INVALID' })
})

test('history bounds retained turns and conversation count', () => {
  const store = createConversationStore(), c = store.create()
  for (let i = 0; i < 55; i++) store.append(c.id, i, pair(`turn-${i}`))
  assert.equal(store.get(c.id).messages.length, 100)
  assert.equal(store.get(c.id).messages[0].content, 'turn-5')
  for (let i = 1; i < 100; i++) store.create()
  assert.throws(() => store.create(), { code: 'CONTROL_HISTORY_LIMIT' })
})

async function workspace(t, { adapters = {}, ...options } = {}) {
  const service = createControlPlane({ port: 0, bootstrapToken: 'desktop-workspace-test-token', reusableBootstrapToken: true, ...options, adapters: {
    paperSetupStatus: () => ({ ready: true, status: 'ready', values: {}, missing: [] }),
    validateProviderConfig: () => ({ ok: true }),
    discussStrategy: () => ({ intent: 'explain', reply: '测试回复' }), ...adapters
  } })
  const info = await service.start()
  t.after(() => service.stop())
  const call = async (route, body, auth = {}) => {
    const r = await fetch(info.origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: info.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.csrf ? { 'X-CSRF-Token': auth.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: r.status, json: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async () => {
    const response = await call('/api/session', { bootstrap_token: info.bootstrapToken })
    assert.equal(response.status, 200)
    return { cookie: response.cookie, csrf: response.json.csrf_token }
  }
  const auth = await login()
  const post = (route, body) => call(route, body, auth)
  const get = (route) => call(route, undefined, auth)
  assert.equal((await post('/api/provider', { provider: PROVIDER, model: PROVIDER_MODELS[0], endpoint: 'https://models.example.test/v1', api_key: 'desktop-test-credential' })).status, 200)
  return { info, service, auth, call, login, post, get }
}

test('desktop routes enforce sessions, CSRF, exact fields and query rejection', async (t) => {
  const { call, auth, post } = await workspace(t)
  for (const [route, body] of [['/api/conversations', { action: 'create' }], ['/api/chat/model', { model: PROVIDER_MODELS[0], effort: 'medium' }], ['/api/ui', { theme: 'light' }], ['/api/strategy/cancel', { request_id: randomUUID() }]]) {
    assert.equal((await call(route, body)).status, 401)
    assert.equal((await call(route, body, { cookie: auth.cookie })).status, 403)
    assert.equal((await post(route, { ...body, file: '/arbitrary' })).status, 400)
    assert.equal((await post(route + '?account=other', body)).status, 400)
  }
  assert.equal((await call('/api/conversations')).status, 401)
})

test('conversation selection uses its own bounded history and model/effort, without changing workflow roles', async (t) => {
  const calls = []
  const { post, get } = await workspace(t, { adapters: { discussStrategy: (input, runtime) => { calls.push({ history: input.history, model: runtime.model, effort: runtime.effort }); return { intent: 'explain', reply: 'reply' } } } })
  const initial = (await get('/api/strategy')).json, roles = (await get('/api/models')).json.roles
  let r = await post('/api/chat/model', { model: PROVIDER_MODELS[0], effort: 'medium' })
  assert.equal(r.status, 200); assert.equal(r.json.conversation.effort, 'medium')
  assert.equal((await post('/api/strategy/discuss', { message: '对话一\n搜索正文' })).status, 200)
  assert.equal(calls[0].effort, 'medium')
  assert.deepEqual((await get('/api/models')).json.roles, roles)
  r = await post('/api/conversations', { action: 'create' })
  const second = r.json.conversation.id
  assert.notEqual(second, initial.conversation.id)
  assert.equal((await post('/api/strategy/discuss', { message: '对话二' })).status, 200)
  assert.deepEqual(calls[1].history, [])
  r = await post('/api/conversations', { action: 'select', id: initial.conversation.id })
  assert.equal(r.json.conversation.effort, 'medium')
  assert.equal(r.json.discussion.length, 2)
  r = await post('/api/conversations', { action: 'search', query: '搜索正文' })
  assert.equal(r.json.items[0].id, initial.conversation.id)
  assert.equal('messages' in r.json.items[0], false)
  assert.equal((await post('/api/conversations', { action: 'update', id: initial.conversation.id, archived: true })).status, 200)
  assert.equal((await post('/api/strategy/discuss', { message: 'should not send' })).status, 409)
  assert.equal((await post('/api/conversations', { action: 'update', id: initial.conversation.id, archived: false, title: '恢复对话', pinned: true })).status, 200)
  assert.equal((await post('/api/ui', { theme: 'light' })).json.theme, 'light')
  assert.equal((await get('/api/strategy')).json.theme, 'light')
})

test('cancel wins before request start and an uncooperative late adapter cannot mutate settings or history', async (t) => {
  let entered, release, runtime, count = 0
  const started = new Promise((resolve) => { entered = resolve })
  const { post, get } = await workspace(t, { adapters: { discussStrategy: (_, r) => { count++; runtime = r; entered(); return new Promise((resolve) => { release = resolve }) } } })
  const early = randomUUID()
  assert.equal((await post('/api/strategy/cancel', { request_id: early })).status, 200)
  assert.equal((await post('/api/strategy/discuss', { request_id: early, message: 'early' })).json.code, 'CONTROL_STRATEGY_CANCELLED')
  assert.equal(count, 0)
  const id = randomUUID(), pending = post('/api/strategy/discuss', { request_id: id, message: 'slow' })
  await started
  assert.equal((await post('/api/conversations', { action: 'create' })).status, 409)
  assert.equal((await post('/api/strategy/cancel', { request_id: id })).json.stopped, true)
  assert.equal((await pending).json.code, 'CONTROL_STRATEGY_CANCELLED')
  assert.equal(runtime.signal.aborted, true)
  release({ intent: 'configure', apply_fields: ['theme'], theme: 'light', reply: 'late' })
  await new Promise((resolve) => setImmediate(resolve))
  const state = (await get('/api/strategy')).json
  assert.equal(state.theme, 'night'); assert.equal(state.discussion.length, 0)
})

test('progress is emitted only to the requesting session and carries stable request and conversation IDs', async (t) => {
  const { info, auth, post, get, login } = await workspace(t)
  const other = await login(), packets = [[], []], sockets = []
  for (const [index, session] of [auth, other].entries()) {
    const ws = new WebSocket(info.origin.replace('http:', 'ws:') + '/api/events', { origin: info.origin, headers: { Cookie: session.cookie } })
    sockets.push(ws); t.after(() => ws.terminate())
    ws.on('message', (data) => packets[index].push(JSON.parse(data)))
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  }
  const id = randomUUID(), active = (await get('/api/strategy')).json.conversation.id
  assert.equal((await post('/api/strategy/discuss', { request_id: id, message: 'progress' })).status, 200)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const progress = packets[0].filter((p) => p.type === 'discussion_progress')
  assert.deepEqual(progress.map((p) => p.data.phase), ['generating', 'validating', 'complete'])
  assert.ok(progress.every((p) => p.data.request_id === id && p.data.conversation_id === active))
  assert.ok(packets[1].every((p) => p.type !== 'discussion_progress'))
  sockets.forEach((ws) => ws.terminate())
})

test('history write failure preserves the committed settings and reply, and retries without running the model again', async (t) => {
  const real = createConversationStore(); let writes = 0, calls = 0
  const store = { ...real, append: (...args) => { if (++writes === 1) throw new Error('disk unavailable'); return real.append(...args) } }
  const { post, get } = await workspace(t, { conversationStore: store, adapters: { discussStrategy: () => { calls++; return { intent: 'configure', apply_fields: ['theme'], theme: 'light', reply: '已设置' } } } })
  const response = await post('/api/strategy/discuss', { message: '浅色' })
  assert.equal(response.status, 200); assert.equal(response.json.application.status, 'applied')
  assert.equal(response.json.settings.theme, 'light'); assert.ok(response.json.settings.history_warning)
  assert.equal((await get('/api/strategy')).json.discussion.length, 2)
  assert.equal((await post('/api/conversations', { action: 'create' })).json.code, 'CONTROL_HISTORY_UNSAVED')
  assert.equal((await post('/api/strategy/discuss', { message: 'duplicate' })).status, 409)
  const saved = await post('/api/conversations', { action: 'save' })
  assert.equal(saved.status, 200); assert.equal(saved.json.history_warning, null)
  assert.equal(saved.json.discussion.length, 2); assert.equal(calls, 1)
})

test('a persistent workspace reopens its recent conversation after a fresh login', async (t) => {
  const file = temporary(t), { post, call, login } = await workspace(t, { conversationStore: createConversationStore({ file }) })
  const first = await post('/api/strategy/discuss', { message: '保留的历史' })
  const next = await login(), restored = await call('/api/strategy', undefined, next)
  assert.equal(restored.json.conversation.id, first.json.settings.conversation.id)
  assert.equal(restored.json.discussion[0].content, '保留的历史')
})
