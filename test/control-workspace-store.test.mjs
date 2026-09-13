import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWorkspaceStore, WORKSPACE_SCHEMA } from '../scripts/control-workspace-store.mjs'

function root() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tyche-workspace-'))
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true })
  return dir
}

const POOL = [{ id: 'deepseek-v4-flash', efforts: ['medium', 'high', 'xhigh'] }]
const CONFIG = Object.freeze({
  protocol: 'openai-completions',
  pool: POOL,
  bootstrap: { model: 'deepseek-v4-flash', effort: 'high' },
  role_models: { reviewer: 'deepseek-v4-flash' },
  role_efforts: { reviewer: 'xhigh' },
  mode: 'manual'
})

test('a stored workspace round-trips without a credential and stays private', () => {
  const dir = root()
  try {
    const store = createWorkspaceStore({ root: dir })
    assert.equal(store.read(), null)
    const written = store.write(CONFIG)
    assert.equal(written.schema, WORKSPACE_SCHEMA)
    const restored = store.read()
    assert.equal(restored.protocol, 'openai-completions')
    assert.equal(restored.mode, 'manual')
    assert.deepEqual(restored.pool, POOL)
    assert.deepEqual(restored.bootstrap, { model: 'deepseek-v4-flash', effort: 'high' })
    assert.deepEqual(restored.role_models, { reviewer: 'deepseek-v4-flash' })
    assert.deepEqual(restored.role_efforts, { reviewer: 'xhigh' })
    assert.equal(fs.statSync(store.path).mode & 0o777, 0o600)
    const raw = fs.readFileSync(store.path, 'utf8')
    assert.equal(/api|secret|token|bearer|https?:\/\//i.test(raw), false, raw)
    store.clear()
    assert.equal(store.read(), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('credential-shaped fields and absolute locations are rejected structurally', () => {
  const dir = root()
  try {
    const store = createWorkspaceStore({ root: dir })
    for (const [label, value] of [
      ['api key beside a pool entry', { ...CONFIG, pool: [{ ...POOL[0], api_key: 'sk-live' }] }],
      ['endpoint field', { ...CONFIG, endpoint: 'https://api.example.invalid/v1' }],
      ['url inside the bootstrap', { ...CONFIG, bootstrap: { model: 'https://api.example.invalid', effort: 'high' } }],
      ['unknown top-level field', { ...CONFIG, authorization: 'Bearer x' }]
    ]) {
      assert.throws(() => store.write(value), (error) => ['WORKSPACE_SECRET_FIELD', 'WORKSPACE_SCHEMA_INVALID'].includes(error.code), label)
    }
    assert.equal(fs.existsSync(store.path), false, 'a rejected write must not create the file')
    assert.throws(() => createWorkspaceStore({ root: dir, relativePath: path.join('..', 'escape.json') }), (error) => error.code === 'WORKSPACE_PATH_INVALID')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an incomplete or inconsistent workspace is refused rather than partially restored', () => {
  const dir = root()
  try {
    const store = createWorkspaceStore({ root: dir })
    for (const [label, value] of [
      ['bootstrap outside the pool', { ...CONFIG, bootstrap: { model: 'other-model', effort: 'high' } }],
      ['empty pool', { ...CONFIG, pool: [] }],
      ['unsupported protocol', { ...CONFIG, protocol: 'openai-chat' }],
      ['unsupported mode', { ...CONFIG, mode: 'semi' }],
      ['unknown role', { ...CONFIG, role_models: { auditor: 'deepseek-v4-flash' } }],
      ['unsupported effort', { ...CONFIG, role_efforts: { reviewer: 'low' } }]
    ]) {
      assert.throws(() => store.write(value), (error) => typeof error.code === 'string' && error.code.startsWith('WORKSPACE_') || error.code.startsWith('PI_'), label)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a corrupt stored workspace is reported instead of silently reset', () => {
  const dir = root()
  try {
    const store = createWorkspaceStore({ root: dir })
    store.write(CONFIG)
    fs.writeFileSync(store.path, '{"schema":"tyche_workspace_config/v1","pool":[]}', 'utf8')
    assert.throws(() => store.read(), (error) => typeof error.code === 'string')
    assert.ok(fs.existsSync(store.path), 'a failed read must leave the operator file in place')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a role model outside the pool is preserved because the control plane tolerates it', () => {
  const dir = root()
  try {
    const store = createWorkspaceStore({ root: dir })
    // Changing the default model rebases role selections onto the previous
    // models, which the control plane reports as pending correction rather
    // than rejecting, so persistence must not be stricter than that.
    const rebased = { ...CONFIG, role_models: { reviewer: 'legacy-pool-model' } }
    assert.deepEqual(store.write(rebased).role_models, { reviewer: 'legacy-pool-model' })
    assert.deepEqual(store.read().role_models, { reviewer: 'legacy-pool-model' })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
