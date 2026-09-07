import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { withFileLock, writeTextAtomic } from '../../../scripts/lib-iolock.mjs'

const ID = /^[a-f0-9-]{36}$/
const SECRET = /(?:sk-[a-z0-9_-]{16,}|Bearer\s+[a-z0-9._-]{16,})/i
export const containsCredentialPattern = (value) => SECRET.test(value)
function fail(code) { throw Object.assign(new Error(code), { code }) }
function text(value, max) { return typeof value === 'string' && value.trim() && value.length <= max && !SECRET.test(value) }
function validate(state) {
  if (state?.schema !== 1 || !Array.isArray(state.items) || state.items.length > 100 || Object.keys(state).some((k) => !['schema', 'items'].includes(k))) fail('CONTROL_HISTORY_INVALID')
  const ids = new Set()
  for (const c of state.items) {
    if ((c.model !== undefined && c.model !== null && !text(c.model, 96)) || (c.effort !== undefined && c.effort !== null && !['medium', 'high', 'xhigh'].includes(c.effort)) || !ID.test(c.id) || ids.has(c.id) || !text(c.title, 80) || typeof c.pinned !== 'boolean' || typeof c.archived !== 'boolean' || !Number.isSafeInteger(c.revision) || c.revision < 0 || !Number.isFinite(c.created_at) || !Number.isFinite(c.updated_at) || !Array.isArray(c.messages) || c.messages.length > 100 || Object.keys(c).some((k) => !['id', 'title', 'pinned', 'archived', 'model', 'effort', 'revision', 'created_at', 'updated_at', 'messages', 'model', 'effort'].includes(k))) fail('CONTROL_HISTORY_INVALID')
    ids.add(c.id)
    for (const m of c.messages) if (!ID.test(m.id) || !['user', 'assistant'].includes(m.role) || !text(m.content, 8000) || Object.keys(m).some((k) => !['id', 'role', 'content'].includes(k))) fail('CONTROL_HISTORY_INVALID')
  }
  return state
}

export function createConversationStore({ file = null, now = Date.now } = {}) {
  if (file) file = path.resolve(file)
  let memory = { schema: 1, items: [] }
  function safePath() {
    if (!file) return
    let cursor = path.parse(path.resolve(file)).root
    for (const part of path.resolve(file).slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part)
      try { const stat = fs.lstatSync(cursor); if (stat.isSymbolicLink() || (cursor !== file && !stat.isDirectory())) fail('CONTROL_HISTORY_INVALID') } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
  }
  function read() {
    if (!file) return structuredClone(memory)
    safePath()
    let fd
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o077)) fail('CONTROL_HISTORY_INVALID')
      return validate(JSON.parse(fs.readFileSync(fd, 'utf8')))
    } catch (e) { if (e.code === 'ENOENT') return { schema: 1, items: [] }; fail('CONTROL_HISTORY_INVALID') } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  function change(fn) {
    const operation = () => {
      const state = read(), result = fn(state)
      validate(state)
      const json = JSON.stringify(state)
      if (Buffer.byteLength(json) > 2 * 1024 * 1024) fail('CONTROL_HISTORY_LIMIT')
      if (file) { safePath(); writeTextAtomic(file, json, { mode: 0o600 }) } else memory = state
      return structuredClone(result)
    }
    if (!file) return operation()
    safePath()
    return withFileLock(file, operation, { waitMs: 500, staleMs: 60000 })
  }
  const find = (state, id) => { const c = state.items.find((row) => row.id === id); if (!c) fail('CONTROL_HISTORY_NOT_FOUND'); return c }
  return {
    persistent: Boolean(file),
    list: () => read().items.map(({ messages, ...c }) => ({ ...c, message_count: messages.length })).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at),
    search: (query) => read().items.filter((c) => [c.title, ...c.messages.map((m) => m.content)].some((v) => v.toLocaleLowerCase().includes(query.toLocaleLowerCase()))).map(({ messages, ...c }) => ({ ...c, message_count: messages.length })),
    allText: () => read().items.map((c) => [c.title, ...c.messages.map((m) => m.content)]).flat(),
    get: (id) => structuredClone(find(read(), id)),
    create: () => change((state) => { if (state.items.length >= 100) fail('CONTROL_HISTORY_LIMIT'); const c = { id: randomUUID(), title: '新对话', revision: 0, created_at: now(), updated_at: now(), archived: false, pinned: false, messages: [] }; state.items.push(c); return c }),
    update: (id, patch) => change((state) => {
      const c = find(state, id)
      if (Object.keys(patch).some((k) => !['title', 'pinned', 'archived', 'model', 'effort'].includes(k)) || (patch.title !== undefined && !text(patch.title, 80)) || ['pinned', 'archived'].some((k) => patch[k] !== undefined && typeof patch[k] !== 'boolean')) fail('CONTROL_HISTORY_INVALID')
      Object.assign(c, patch); c.updated_at = now(); c.revision++; return c
    }),
    append: (id, revision, turns) => change((state) => {
      const c = find(state, id)
      if (c.revision !== revision || c.archived) fail('CONTROL_HISTORY_CONFLICT')
      c.messages = [...c.messages, ...turns.map(({ role, content }) => ({ id: randomUUID(), role, content }))].slice(-100)
      if (c.title === '新对话') c.title = turns[0].content.trim().split('\n')[0].slice(0, 50)
      c.updated_at = now(); c.revision++; return c
    })
  }
}
