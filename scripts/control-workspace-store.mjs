#!/usr/bin/env node

// Non-credential workspace configuration that survives a logout, a session
// expiry and a service restart.
//
// First-time model setup is roughly twenty inputs: protocol, endpoint, key,
// pool ids with their efforts, a default model, then six role/effort pairs.
// The session holds all of it, so a 15-minute expiry discarded the whole thing
// and the operator retyped everything. Only the credential genuinely has to be
// session-only, so everything else is kept here instead.
//
// The API key and the endpoint never enter this file. SECURITY.md requires the
// key to stay in process memory, and the endpoint identifies the gateway that
// key belongs to, so it stays with the key rather than being written to disk.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLES, validateSessionProtocol } from '../packages/pi-agents/src/protocol.mjs'
import { validateSessionPool, validateSessionRoleEfforts } from '../packages/pi-agents/src/session-provider.mjs'
import { readJsonStrict, withFileLock, writeJsonAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const WORKSPACE_SCHEMA = 'tyche_workspace_config/v1'
const RELATIVE_PATH = path.join('data', 'runtime', 'workspace-config.json')
const FIELDS = Object.freeze(['schema', 'protocol', 'pool', 'bootstrap', 'role_models', 'role_efforts', 'mode'])
const SECRET_KEY = /(?:api.?key|secret|token|password|credential|authorization|cookie|private.?key|signature|endpoint|url|host)/i

export class WorkspaceStoreError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'WorkspaceStoreError'
    this.code = code
  }
}

function fail(code, message) {
  throw new WorkspaceStoreError(code, message)
}

function noSymlink(target) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) fail('WORKSPACE_PATH_SYMLINK', 'Workspace configuration path must not be a symlink')
  } catch (error) {
    if (error instanceof WorkspaceStoreError) throw error
    if (error?.code !== 'ENOENT') fail('WORKSPACE_PATH_UNREADABLE', 'Workspace configuration path cannot be inspected')
  }
}

// A secret must never reach this file, so reject one structurally rather than
// trusting the caller to have stripped it.
function assertNoSecret(value, trail = '$') {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoSecret(item, `${trail}[${index}]`)); return }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) fail('WORKSPACE_SECRET_FIELD', `Workspace configuration must not contain ${trail}.${key}`)
      assertNoSecret(item, `${trail}.${key}`)
    }
    return
  }
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) fail('WORKSPACE_SECRET_FIELD', `Workspace configuration must not contain a URL at ${trail}`)
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/

function roleModelMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('WORKSPACE_SCHEMA_INVALID', 'Workspace role models must be an object')
  const entries = Object.entries(value)
  if (entries.some(([role, model]) => !ROLES.includes(role) || typeof model !== 'string' || !MODEL_ID.test(model) || model.includes('://'))) {
    fail('WORKSPACE_SCHEMA_INVALID', 'Workspace role models must map an allowed role to a plain model id')
  }
  return Object.freeze(Object.fromEntries(ROLES.filter((role) => Object.hasOwn(value, role)).map((role) => [role, value[role]])))
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('WORKSPACE_SCHEMA_INVALID', 'Workspace configuration must be an object')
  const extra = Object.keys(value).filter((key) => !FIELDS.includes(key))
  if (extra.length) fail('WORKSPACE_SCHEMA_INVALID', `Workspace configuration has unsupported keys: ${extra.join(', ')}`)
  if (value.schema !== WORKSPACE_SCHEMA) fail('WORKSPACE_SCHEMA_INVALID', `Workspace configuration schema must be ${WORKSPACE_SCHEMA}`)
  assertNoSecret(value)
  const protocol = validateSessionProtocol(value.protocol)
  const pool = validateSessionPool(value.pool)
  if (!pool.length) fail('WORKSPACE_SCHEMA_INVALID', 'Workspace configuration pool must not be empty')
  if (!value.bootstrap || typeof value.bootstrap !== 'object' || Array.isArray(value.bootstrap)) fail('WORKSPACE_SCHEMA_INVALID', 'Workspace configuration bootstrap must be an object')
  const bootstrapKeys = Object.keys(value.bootstrap)
  if (bootstrapKeys.some((key) => !['model', 'effort'].includes(key)) || typeof value.bootstrap.model !== 'string' || typeof value.bootstrap.effort !== 'string') {
    fail('WORKSPACE_SCHEMA_INVALID', 'Workspace configuration bootstrap must be an exact model and effort pair')
  }
  if (!pool.some(({ id }) => id === value.bootstrap.model)) fail('WORKSPACE_SCHEMA_INVALID', 'Workspace configuration bootstrap model must be in the pool')
  // Role models are shape-checked but deliberately not required to be in the
  // pool. Changing the default model rebases the role map onto the previous
  // selections, which the control plane tolerates and reports as pending
  // correction, so requiring pool membership here would reject a state the
  // application itself considers valid.
  const roleModels = roleModelMap(value.role_models ?? {})
  const roleEfforts = validateSessionRoleEfforts(value.role_efforts ?? {})
  if (!['auto', 'manual'].includes(value.mode)) fail('WORKSPACE_SCHEMA_INVALID', 'Workspace configuration mode must be auto or manual')
  return Object.freeze({
    schema: WORKSPACE_SCHEMA,
    protocol,
    pool,
    bootstrap: Object.freeze({ model: value.bootstrap.model, effort: value.bootstrap.effort }),
    role_models: roleModels,
    role_efforts: roleEfforts,
    mode: value.mode
  })
}

export function createWorkspaceStore({ root = ROOT, relativePath = RELATIVE_PATH, writeJson = writeJsonAtomic } = {}) {
  const target = path.resolve(root, relativePath)
  const dataRoot = path.join(path.resolve(root), 'data')
  const relative = path.relative(dataRoot, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('WORKSPACE_PATH_INVALID', 'Workspace configuration must live under data/')

  // A corrupt or tampered file must never silently reset the operator's setup,
  // so a read failure is reported rather than replaced with a default.
  function read() {
    noSymlink(target)
    if (!fs.existsSync(target)) return null
    return validate(readJsonStrict(target))
  }

  function write(value) {
    const config = validate({ ...value, schema: WORKSPACE_SCHEMA })
    noSymlink(target)
    noSymlink(`${target}.lock`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    return withFileLock(target, () => { writeJson(target, config, { mode: 0o600 }); return config })
  }

  function clear() {
    noSymlink(target)
    fs.rmSync(target, { force: true })
  }

  return { path: target, read, write, clear }
}
