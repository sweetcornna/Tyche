import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createUtcScheduler,
  currentUtcSlots,
  slotsForUtcDate,
  SLOT_WINDOW_MS
} from '../scripts/utc-scheduler.mjs'

const monday = Date.parse('2030-01-07T00:00:00.000Z')

function tempState(name = 'tyche-scheduler-') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), name)), 'state.json')
}

test('UTC schedule exposes the weekly slot and all six four-hour daily slots', () => {
  const slots = slotsForUtcDate(monday)
  assert.deepEqual(slots.map((slot) => `${slot.kind}:${slot.start_at}`), [
    'weekly:2030-01-07T00:05:00.000Z',
    'daily:2030-01-07T00:10:00.000Z',
    'daily:2030-01-07T04:10:00.000Z',
    'daily:2030-01-07T08:10:00.000Z',
    'daily:2030-01-07T12:10:00.000Z',
    'daily:2030-01-07T16:10:00.000Z',
    'daily:2030-01-07T20:10:00.000Z'
  ])
  assert.equal(slotsForUtcDate(Date.parse('2030-01-08T00:00:00Z')).some((slot) => slot.kind === 'weekly'), false)
})

test('scheduler library requires explicit unsafe injection for non-runtime state paths', () => {
  const statePath = tempState('tyche-scheduler-path-')
  assert.throws(() => createUtcScheduler({ statePath }), (error) => ['SCHEDULER_PATH_OUTSIDE_RUNTIME', 'SCHEDULER_PATH_SYMLINK'].includes(error.code))
  assert.equal(createUtcScheduler({ statePath, testOnlyAllowUnsafePaths: true }).statePath, statePath)
})

test('current-slot catch-up accepts only the current 15-minute window and never replays history', () => {
  assert.deepEqual(currentUtcSlots(Date.parse('2030-01-07T00:04:59.999Z')), [])
  assert.equal(currentUtcSlots(Date.parse('2030-01-07T00:05:00.000Z')).some((slot) => slot.kind === 'weekly'), true)
  assert.equal(currentUtcSlots(Date.parse('2030-01-07T00:19:59.999Z')).some((slot) => slot.kind === 'weekly'), true)
  assert.equal(currentUtcSlots(Date.parse('2030-01-07T00:20:00.000Z')).some((slot) => slot.kind === 'weekly'), false)
  assert.deepEqual(currentUtcSlots(Date.parse('2030-01-07T00:30:00.000Z')), [])
  assert.equal(SLOT_WINDOW_MS, 900000)
})

test('Monday daily slot runs after weekly and blocks only new entries when weekly fails', async () => {
  const calls = []
  const scheduler = createUtcScheduler({
    statePath: tempState(),
    testOnlyAllowUnsafePaths: true,
    onSlot: async (slot, context) => {
      calls.push({ kind: slot.kind, allowed: context.new_entries_allowed, settlement: context.settlement_required })
      return slot.kind === 'weekly' ? { ok: false, code: 'WEEKLY_FAILED' } : { ok: true }
    }
  })
  const result = await scheduler.tick(Date.parse('2030-01-07T00:10:00Z'))
  assert.deepEqual(calls, [
    { kind: 'weekly', allowed: true, settlement: true },
    { kind: 'daily', allowed: false, settlement: true }
  ])
  assert.equal(result.triggered.length, 2)
  assert.equal(result.blocked[0].code, 'WEEKLY_DEPENDENCY_BLOCKED')
})

test('Monday weekly BLOCKED outcome blocks 00:10 new entries while still invoking settlement', async () => {
  const calls = []
  const statePath = tempState('tyche-scheduler-weekly-blocked-')
  const scheduler = createUtcScheduler({
    statePath,
    testOnlyAllowUnsafePaths: true,
    onSlot: async (slot, context) => {
      assert.equal(fs.existsSync(`${statePath}.lock`), false)
      calls.push({ kind: slot.kind, allowed: context.new_entries_allowed, settlement: context.settlement_required })
      return slot.kind === 'weekly' ? { outcome: 'BLOCKED', code: 'WEEKLY_INPUT_MISSING' } : { outcome: 'COMPLETE' }
    }
  })
  const result = await scheduler.tick(Date.parse('2030-01-07T00:10:00Z'))
  assert.deepEqual(calls, [
    { kind: 'weekly', allowed: true, settlement: true },
    { kind: 'daily', allowed: false, settlement: true }
  ])
  assert.equal(result.triggered[0].status, 'failed')
  assert.equal(result.triggered[1].status, 'completed')
  assert.ok(result.blocked.some((entry) => entry.code === 'WEEKLY_DEPENDENCY_BLOCKED'))
})

test('scheduler treats a failure marker in any callback result status field as failed', async () => {
  const statePath = tempState('tyche-scheduler-secondary-status-')
  const scheduler = createUtcScheduler({
    statePath,
    testOnlyAllowUnsafePaths: true,
    onSlot: async (slot) => slot.kind === 'weekly' ? { outcome: 'COMPLETE', phase: 'FAILED', status: 'ok' } : undefined
  })
  const result = await scheduler.tick(Date.parse('2030-01-07T00:10:00Z'))
  assert.equal(result.triggered.find((entry) => entry.kind === 'weekly')?.status, 'failed')
  assert.equal(result.triggered.find((entry) => entry.kind === 'daily')?.new_entries_allowed, false)
})

test('non-Monday daily slots do not wait for a same-day weekly slot', async () => {
  let context
  const scheduler = createUtcScheduler({
    statePath: tempState(),
    testOnlyAllowUnsafePaths: true,
    onSlot: async (slot, value) => { if (slot.kind === 'daily') context = value }
  })
  const result = await scheduler.tick(Date.parse('2030-01-08T04:12:00Z'))
  assert.equal(result.triggered.length, 1)
  assert.equal(context.new_entries_allowed, true)
  assert.equal(result.blocked.length, 0)
})

test('only Monday 00:10 depends on weekly; later Monday slots remain eligible', async () => {
  let context
  const scheduler = createUtcScheduler({
    statePath: tempState('tyche-scheduler-monday-later-'),
    testOnlyAllowUnsafePaths: true,
    onSlot: async (slot, value) => { context = { kind: slot.kind, allowed: value.new_entries_allowed } }
  })
  const result = await scheduler.tick(Date.parse('2030-01-07T04:12:00Z'))
  assert.equal(result.triggered.length, 1)
  assert.deepEqual(context, { kind: 'daily', allowed: true })
})

test('state key makes repeated ticks and concurrent scheduler instances idempotent', async () => {
  const statePath = tempState('tyche-scheduler-concurrent-')
  let calls = 0
  const options = {
    statePath,
    testOnlyAllowUnsafePaths: true,
    onSlot: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const first = createUtcScheduler(options)
  const second = createUtcScheduler(options)
  const [left, right] = await Promise.all([
    first.tick(Date.parse('2030-01-07T00:10:00Z')),
    second.tick(Date.parse('2030-01-07T00:10:00Z'))
  ])
  assert.equal(calls, 2)
  assert.equal(left.triggered.length + right.triggered.length, 2)
  assert.equal((await first.tick(Date.parse('2030-01-07T00:10:01Z'))).triggered.length, 0)
})

test('scheduler fails closed on UTC clock rollback', async () => {
  const statePath = tempState('tyche-scheduler-clock-')
  const scheduler = createUtcScheduler({ statePath, testOnlyAllowUnsafePaths: true })
  await scheduler.tick(Date.parse('2030-01-07T00:10:00Z'))
  const result = await scheduler.tick(Date.parse('2030-01-07T00:09:00Z'))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SCHEDULER_CLOCK_ROLLBACK')
})

test('orphaned running scheduler claim is not replayed and requires exact-token reconcile', async () => {
  const statePath = tempState('tyche-scheduler-orphan-')
  const scheduler = createUtcScheduler({ statePath, testOnlyAllowUnsafePaths: true, onSlot: async () => { throw new Error('must not run') } })
  await scheduler.tick(Date.parse('2030-01-07T00:10:00Z'))
  // Inject the persisted shape left by a process crash between claim and callback.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.slots['weekly:2030-01-07T00:05:00.000Z'] = {
    kind: 'weekly', date: '2030-01-07', iso_week: '2030-W02', start_at: '2030-01-07T00:05:00.000Z',
    claim_token: 'orphan-token', claimed_at: '2030-01-07T00:10:00.000Z', status: 'running'
  }
  fs.writeFileSync(statePath, JSON.stringify(state))
  const orphaned = await scheduler.tick(Date.parse('2030-01-07T00:10:01Z'))
  assert.equal(orphaned.triggered.length, 0)
  assert.ok(orphaned.blocked.some((entry) => entry.code === 'SCHEDULER_SLOT_ORPHANED'))
  const wrong = await scheduler.reconcile('weekly:2030-01-07T00:05:00.000Z', { token: 'wrong' })
  assert.equal(wrong.code, 'SCHEDULER_CLAIM_TOKEN_MISMATCH')
  const reconciled = await scheduler.reconcile('weekly:2030-01-07T00:05:00.000Z', { token: 'orphan-token', status: 'failed' })
  assert.equal(reconciled.outcome, 'RECONCILED')
})
