#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  readJsonStrict,
  withFileLockAsync,
  writeJsonAtomic
} from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_RUNTIME_ROOT = path.join(ROOT, 'data', 'runtime')
const DATA_TESTNET_ROOT = path.join(ROOT, 'data', 'testnet')

export const SCHEDULER_SCHEMA = 'tyche_utc_scheduler/v1'
export const SLOT_WINDOW_MS = 15 * 60 * 1000
export const WEEKLY_SLOT = Object.freeze({ weekday: 1, hour: 0, minute: 5 })
export const DAILY_SLOT_HOURS = Object.freeze([0, 4, 8, 12, 16, 20])
export const SCHEDULER_KINDS = Object.freeze(['weekly', 'daily'])

// lib-iolock serializes separate processes. This small in-process queue keeps
// two callers in the same Node event loop from blocking one another inside
// its synchronous lock acquisition while an async slot callback is pending.
const IN_PROCESS_QUEUES = new Map()

export class SchedulerError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code)
    this.name = 'SchedulerError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new SchedulerError(code, message, details)
}

function clockMs(value = Date.now) {
  const raw = typeof value === 'function' ? value() : value
  const result = raw instanceof Date ? raw.getTime() : Number(raw)
  if (!Number.isFinite(result) || !Number.isSafeInteger(result) || result < 0) fail('SCHEDULER_CLOCK_INVALID', 'UTC scheduler clock must be a finite non-negative safe integer')
  return result
}

function utcDate(ms) {
  const date = new Date(ms)
  if (!Number.isFinite(date.getTime())) fail('SCHEDULER_CLOCK_INVALID', 'UTC scheduler clock does not encode a valid date')
  return date
}

function dateKey(ms) {
  return utcDate(ms).toISOString().slice(0, 10)
}

function isoWeek(ms) {
  const source = utcDate(ms)
  const day = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()))
  const weekday = (day.getUTCDay() + 6) % 7
  day.setUTCDate(day.getUTCDate() - weekday + 3)
  const first = new Date(Date.UTC(day.getUTCFullYear(), 0, 4))
  const firstWeekday = (first.getUTCDay() + 6) % 7
  first.setUTCDate(first.getUTCDate() - firstWeekday + 3)
  const week = 1 + Math.round((day - first) / 604800000)
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function startOfUtcDay(ms) {
  const date = utcDate(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function slotAt(dayMs, kind, hour, minute) {
  const startMs = dayMs + hour * 60 * 60 * 1000 + minute * 60 * 1000
  const start = utcDate(startMs)
  const day = dateKey(startMs)
  const time = start.toISOString().slice(11, 19)
  return Object.freeze({
    kind,
    key: `${kind}:${day}T${time}.000Z`,
    date: day,
    iso_week: isoWeek(startMs),
    start_ms: startMs,
    end_ms: startMs + SLOT_WINDOW_MS,
    start_at: start.toISOString(),
    end_at: new Date(startMs + SLOT_WINDOW_MS).toISOString(),
    hour,
    minute
  })
}

/**
 * Return all fixed UTC slots for the calendar day containing `now`.
 * This function deliberately does not search previous days: the scheduler
 * is a current-slot catch-up mechanism, not a historical replay engine.
 */
export function slotsForUtcDate(now = Date.now) {
  const current = clockMs(now)
  const dayMs = startOfUtcDay(current)
  const date = utcDate(dayMs)
  const slots = DAILY_SLOT_HOURS.map((hour) => slotAt(dayMs, 'daily', hour, 10))
  if (date.getUTCDay() === WEEKLY_SLOT.weekday) slots.push(slotAt(dayMs, 'weekly', WEEKLY_SLOT.hour, WEEKLY_SLOT.minute))
  return slots.sort((left, right) => left.start_ms - right.start_ms || (left.kind === 'weekly' ? -1 : 1))
}

/**
 * Return only the slots whose 15-minute window currently contains `now`.
 * The end is exclusive, so a tick exactly at +15:00 cannot replay a slot.
 */
export function currentUtcSlots(now = Date.now) {
  const current = clockMs(now)
  return slotsForUtcDate(current).filter((slot) => current >= slot.start_ms && current < slot.end_ms)
}

export function currentUtcSlot(now = Date.now, kind = null) {
  const slots = currentUtcSlots(now)
  const filtered = kind ? slots.filter((slot) => slot.kind === kind) : slots
  return filtered[0] || null
}

export const getCurrentSlots = currentUtcSlots
export const getCurrentSlot = currentUtcSlot

export function schedulerState() {
  return {
    schema: SCHEDULER_SCHEMA,
    slots: {},
    last_tick_ms: null,
    last_tick_at: null,
    clock_fault: null
  }
}

function cloneState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== SCHEDULER_SCHEMA) {
    fail('SCHEDULER_STATE_INVALID', 'Scheduler state schema is invalid')
  }
  if (!value.slots || typeof value.slots !== 'object' || Array.isArray(value.slots)) fail('SCHEDULER_STATE_INVALID', 'Scheduler state slots must be an object')
  if (value.last_tick_ms !== null && (!Number.isSafeInteger(Number(value.last_tick_ms)) || Number(value.last_tick_ms) < 0)) fail('SCHEDULER_STATE_INVALID', 'Scheduler state clock is invalid')
  return {
    schema: SCHEDULER_SCHEMA,
    slots: structuredClone(value.slots),
    last_tick_ms: value.last_tick_ms === null ? null : Number(value.last_tick_ms),
    last_tick_at: value.last_tick_at === null ? null : String(value.last_tick_at),
    clock_fault: value.clock_fault ? structuredClone(value.clock_fault) : null
  }
}

function slotStatus(state, slot) {
  const value = state.slots[slot.key]
  return value && typeof value === 'object' ? value.status : null
}

function callbackSucceeded(value) {
  if (value === undefined || value === null) return true
  if (value === false) return false
  if (value === true) return true
  if (typeof value === 'string') return !['BLOCKED', 'FAILED', 'RECONCILE_RED'].includes(value.trim().toUpperCase())
  if (typeof value !== 'object') return true
  const outcomes = ['outcome', 'phase', 'status']
    .map((key) => String(value[key] || '').trim().toUpperCase())
    .filter(Boolean)
  if (outcomes.some((outcome) => ['BLOCKED', 'FAILED', 'RECONCILE_RED'].includes(outcome))) return false
  return value.ok !== false && value.success !== false
}

function safeCallbackError(error) {
  return {
    code: String(error?.code || 'SCHEDULER_CALLBACK_FAILED').slice(0, 80),
    message: String(error?.message || (error?.code ? error.code : error) || 'callback failed').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240)
  }
}

function serializePath(targetPath, task) {
  const previous = IN_PROCESS_QUEUES.get(targetPath) || Promise.resolve()
  const current = previous.then(task, task)
  const cleanup = () => {
    if (IN_PROCESS_QUEUES.get(targetPath) === tail) IN_PROCESS_QUEUES.delete(targetPath)
  }
  const tail = current.then(cleanup, cleanup)
  IN_PROCESS_QUEUES.set(targetPath, tail)
  return current
}

function isWithin(target, root) {
  const relative = path.relative(root, target)
  return relative === '' || (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertNoSymlink(target) {
  let cursor = target
  while (true) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) fail('SCHEDULER_PATH_SYMLINK', 'Scheduler state paths may not be symbolic links')
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return target
}

function schedulerStatePath(options = {}) {
  const allowUnsafe = options.testOnlyAllowUnsafePaths === true || Boolean(options.runtimeRoot)
  const explicitRoot = options.runtimeRoot ? path.resolve(String(options.runtimeRoot)) : null
  const roots = explicitRoot ? [explicitRoot] : [DATA_RUNTIME_ROOT, DATA_TESTNET_ROOT]
  const fallback = path.join(explicitRoot || DATA_RUNTIME_ROOT, 'utc_scheduler.json')
  const raw = String(options.statePath || fallback).trim()
  if (!raw || raw.includes('\u0000')) fail('SCHEDULER_PATH_INVALID', 'Scheduler state path is invalid')
  const target = path.resolve(raw)
  if (!allowUnsafe) assertNoSymlink(target)
  if (explicitRoot && !isWithin(target, explicitRoot)) fail('SCHEDULER_PATH_OUTSIDE_RUNTIME', 'Scheduler state path must stay inside runtimeRoot')
  if (!allowUnsafe && !explicitRoot && !roots.some((root) => isWithin(target, root))) fail('SCHEDULER_PATH_OUTSIDE_RUNTIME', 'Scheduler state path must stay inside repository runtime data roots')
  for (const root of roots) {
    try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }) } catch {}
    if (!allowUnsafe) assertNoSymlink(root)
  }
  return target
}

function markSlot(state, slot, status, now, result = undefined) {
  const entry = {
    kind: slot.kind,
    date: slot.date,
    iso_week: slot.iso_week,
    start_at: slot.start_at,
    completed_at: new Date(now).toISOString(),
    status
  }
  if (result && typeof result === 'object') {
    if (result.outcome !== undefined) entry.outcome = String(result.outcome).slice(0, 80)
    if (result.code !== undefined) entry.code = String(result.code).slice(0, 100)
  }
  state.slots[slot.key] = entry
}

function markSlotTerminal(state, slot, token, status, now, result = undefined, reconciled = false) {
  const running = state.slots[slot.key]
  if (!running || running.status !== 'running' || running.claim_token !== token) return false
  markSlot(state, slot, status, now, result)
  state.slots[slot.key].claim_token = token
  if (reconciled) state.slots[slot.key].reconciled = true
  return true
}

function isWeeklyComplete(state, slot) {
  // Only the Monday 00:10 daily slot depends on the Monday 00:05
  // weekly refresh. Later Monday slots and later days are still checked by
  // their normal anchor freshness gates, but are not blocked here.
  const day = utcDate(slot.start_ms)
  if (day.getUTCDay() !== WEEKLY_SLOT.weekday || slot.hour !== 0 || slot.minute !== 10) return true
  const weekly = slotsForUtcDate(slot.start_ms).find((candidate) => candidate.kind === 'weekly')
  return Boolean(weekly && slotStatus(state, weekly) === 'completed')
}

/**
 * Construct a persistent scheduler. `onSlot` is called at most once for a
 * slot key, including when the callback reports failure. Callers can still
 * settle paper state when `new_entries_allowed` is false.
 */
export function createUtcScheduler(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('SCHEDULER_OPTIONS_INVALID', 'Scheduler options must be an object')
  const statePath = schedulerStatePath(options)
  if (typeof options.onSlot !== 'function' && options.onSlot !== undefined) fail('SCHEDULER_CALLBACK_INVALID', 'onSlot must be a function')
  const onSlot = options.onSlot || (() => undefined)
  const lockOptions = options.lockOptions || {}
  const clock = options.now || Date.now
  let timer = null

  async function lockedState(mutator) {
    return serializePath(statePath, () => withFileLockAsync(statePath, async () => {
      const state = cloneState(readJsonStrict(statePath, { missingDefault: schedulerState() }))
      const result = await mutator(state)
      writeJsonAtomic(statePath, state, { mode: 0o600 })
      try { fs.chmodSync(statePath, 0o600) } catch {}
      return result
    }, lockOptions))
  }

  async function claimSlot(slot, current) {
    return lockedState((state) => {
      if (state.clock_fault) return { ok: false, kind: 'fault', code: state.clock_fault.code, message: state.clock_fault.message }
      if (state.last_tick_ms !== null && current < state.last_tick_ms) {
        state.clock_fault = { code: 'SCHEDULER_CLOCK_ROLLBACK', message: 'UTC scheduler clock moved backwards', at: new Date(current).toISOString(), previous_at: new Date(state.last_tick_ms).toISOString() }
        return { ok: false, kind: 'fault', code: state.clock_fault.code, message: state.clock_fault.message }
      }
      state.last_tick_ms = current
      state.last_tick_at = new Date(current).toISOString()
      const status = slotStatus(state, slot)
      if (status === 'running') return { ok: false, kind: 'orphaned', code: 'SCHEDULER_SLOT_ORPHANED', message: 'A prior scheduler claim is still running; reconcile is required before any replay', slot, token: state.slots[slot.key].claim_token }
      if (status !== null) return { ok: false, kind: 'skipped', status, slot }
      const weeklyReady = slot.kind !== 'daily' || isWeeklyComplete(state, slot)
      const token = randomUUID()
      state.slots[slot.key] = {
        kind: slot.kind,
        date: slot.date,
        iso_week: slot.iso_week,
        start_at: slot.start_at,
        claim_token: token,
        claimed_at: new Date(current).toISOString(),
        status: 'running'
      }
      return {
        ok: true,
        slot,
        token,
        context: {
          slot,
          slot_key: slot.key,
          now_ms: current,
          now: new Date(current).toISOString(),
          settlement_required: true,
          new_entries_allowed: weeklyReady,
          ...(weeklyReady ? {} : { blocked_by: 'weekly', entry_blocked: true })
        }
      }
    })
  }

  async function commitSlot(slot, token, current, result, succeeded) {
    return lockedState((state) => {
      const committed = markSlotTerminal(state, slot, token, succeeded ? 'completed' : 'failed', current, result)
      if (!committed) return { ok: false, code: 'SCHEDULER_CLAIM_LOST', message: 'Scheduler claim changed before terminal commit', slot_key: slot.key }
      return { ok: true, slot, status: succeeded ? 'completed' : 'failed' }
    })
  }

  async function reconcileSlot(slotKey, optionsForReconcile = {}) {
    const key = String(slotKey || '').trim()
    if (!key) fail('SCHEDULER_SLOT_KEY_REQUIRED', 'reconcile requires a slot key')
    const token = String(optionsForReconcile.token || optionsForReconcile.claim_token || '')
    if (!token) fail('SCHEDULER_CLAIM_TOKEN_REQUIRED', 'reconcile requires the exact orphan claim token')
    const status = String(optionsForReconcile.status || 'failed').toLowerCase()
    if (!['completed', 'failed'].includes(status)) fail('SCHEDULER_TERMINAL_STATUS_INVALID', 'reconcile status must be completed or failed')
    return lockedState((state) => {
      const running = state.slots[key]
      if (!running || running.status !== 'running') return { ok: false, code: 'SCHEDULER_SLOT_NOT_RUNNING', message: 'Only an orphan running slot can be reconciled', slot_key: key }
      if (running.claim_token !== token) return { ok: false, code: 'SCHEDULER_CLAIM_TOKEN_MISMATCH', message: 'Reconcile token does not match the persisted claim', slot_key: key }
      const slot = {
        kind: running.kind,
        key,
        date: running.date,
        iso_week: running.iso_week,
        start_at: running.start_at
      }
      markSlotTerminal(state, slot, token, status, clockMs(optionsForReconcile.now ?? clock), { code: optionsForReconcile.code || 'RECONCILED' }, true)
      return { ok: true, outcome: 'RECONCILED', slot_key: key, status }
    })
  }

  async function tick(at = clock) {
    const current = clockMs(at)
    const triggered = []
    const skipped = []
    const blocked = []
    for (const slot of currentUtcSlots(current)) {
      const claim = await claimSlot(slot, current)
      if (!claim.ok) {
        if (claim.kind === 'fault') return { ok: false, code: claim.code, message: claim.message, triggered, skipped, blocked, state: await readState() }
        if (claim.kind === 'orphaned') {
          blocked.push({ key: slot.key, kind: slot.kind, code: claim.code, message: claim.message })
          continue
        }
        skipped.push({ key: slot.key, kind: slot.kind, status: claim.status })
        continue
      }
      let result
      let succeeded = true
      try {
        // The external callback is deliberately outside the state-file lock.
        result = await onSlot(slot, claim.context)
        succeeded = callbackSucceeded(result)
      } catch (error) {
        succeeded = false
        result = { ok: false, ...safeCallbackError(error) }
      }
      const committed = await commitSlot(slot, claim.token, current, result, succeeded)
      if (!committed.ok) {
        blocked.push({ key: slot.key, kind: slot.kind, code: committed.code, message: committed.message })
        continue
      }
      triggered.push({ key: slot.key, kind: slot.kind, status: succeeded ? 'completed' : 'failed', new_entries_allowed: claim.context.new_entries_allowed, ...(succeeded ? {} : { error: safeCallbackError(result) }) })
      if (!claim.context.new_entries_allowed) blocked.push({ key: slot.key, kind: slot.kind, code: 'WEEKLY_DEPENDENCY_BLOCKED', message: 'Weekly slot is missing or failed; paper settlement may continue but new entries are blocked' })
    }
    const state = await readState()
    return { ok: true, triggered, skipped, blocked, state }
  }

  function start(intervalMs = 60 * 1000) {
    if (timer) return { ok: true, running: true }
    const delay = Number(intervalMs)
    if (!Number.isFinite(delay) || delay <= 0) fail('SCHEDULER_INTERVAL_INVALID', 'Scheduler interval must be positive')
    timer = setInterval(() => { void tick().catch(() => {}) }, delay)
    timer.unref?.()
    return { ok: true, running: true, interval_ms: delay }
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    return { ok: true, running: false }
  }

  async function readState() {
    return cloneState(readJsonStrict(statePath, { missingDefault: schedulerState() }))
  }

  return Object.freeze({ statePath, tick, start, stop, readState, reconcile: reconcileSlot, reconcileSlot, get running() { return timer !== null } })
}

export const createScheduler = createUtcScheduler

async function cli(argv) {
  const values = argv.slice(2)
  const command = values[0] || 'slot'
  const allowed = new Set(['slot', 'status'])
  if (!allowed.has(command)) fail('SCHEDULER_COMMAND_UNSUPPORTED', 'Commands: slot, status')
  const flags = new Set(['--at', '--state'])
  const unknown = values.slice(1).filter((value) => value.startsWith('--') && !flags.has(value))
  if (unknown.length) fail('SCHEDULER_ARGUMENT_UNKNOWN', `Unsupported arguments: ${[...new Set(unknown)].join(', ')}`)
  const positional = []
  for (let index = 1; index < values.length; index += 1) {
    if (values[index].startsWith('--')) { index += 1; continue }
    positional.push(values[index])
  }
  if (positional.length) fail('SCHEDULER_ARGUMENT_INVALID', `Unexpected positional arguments: ${positional.join(', ')}`)
  const get = (flag) => {
    const indexes = values.map((value, index) => value === flag ? index : -1).filter((index) => index >= 0)
    if (indexes.length > 1) fail('SCHEDULER_ARGUMENT_DUPLICATE', `${flag} may be supplied only once`)
    if (!indexes.length) return null
    const value = values[indexes[0] + 1]
    if (!value || value.startsWith('--')) fail('SCHEDULER_ARGUMENT_INVALID', `${flag} requires a value`)
    return value
  }
  const dateValue = get('--at')
  const at = dateValue ? Date.parse(dateValue) : Date.now()
  if (!Number.isFinite(at)) fail('SCHEDULER_ARGUMENT_INVALID', '--at must be an ISO timestamp')
  const statePath = get('--state') || undefined
  if (command === 'slot') {
    process.stdout.write(`${JSON.stringify({ now: new Date(at).toISOString(), slots: currentUtcSlots(at) }, null, 2)}\n`)
    return
  }
  const scheduler = createUtcScheduler({ statePath })
  process.stdout.write(`${JSON.stringify(await scheduler.readState(), null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await cli(process.argv)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'SCHEDULER_ERROR', message: String(error.message || error) }, null, 2)}\n`)
    process.exitCode = 1
  }
}
