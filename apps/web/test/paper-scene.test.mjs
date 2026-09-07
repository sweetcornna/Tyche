import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { advancePaperScene, paperPollDelay, paperAmount, consumeSceneEvents } from '../src/paper-scene.js'

function snapshot(sequence, overrides = {}) {
  return { status: 'ready', dataset_id: 'paper_a', revision: `r_${sequence}`, sequence, events_start_sequence: 1,
    events: Array.from({ length: sequence }, (_, n) => ({ id: `e_${n + 1}`, sequence: n + 1 })), orders: [], ...overrides }
}

test('initial load and session baseline never replay historical fills', () => {
  const initial = advancePaperScene(null, snapshot(8))
  assert.equal(initial.events.length, 0)
  const refresh = advancePaperScene(initial.cursor, snapshot(10), true)
  assert.equal(refresh.events.length, 0); assert.equal(refresh.cursor.sequence, 10)
  const change = advancePaperScene(refresh.cursor, snapshot(3, { dataset_id: 'paper_b' }))
  assert.equal(change.events.length, 0); assert.equal(change.cursor.dataset, 'paper_b')
})

test('only unseen confirmed events animate, duplicates and out-of-order responses do not rewind positions', () => {
  let cursor = advancePaperScene(null, snapshot(2)).cursor
  const next = advancePaperScene(cursor, snapshot(4, { events: [{ id: 'e_4', sequence: 4 }, { id: 'e_3', sequence: 3 }, { id: 'e_3', sequence: 3 }] }))
  assert.deepEqual(next.events.map((event) => event.id), ['e_3', 'e_4'])
  cursor = next.cursor
  assert.equal(advancePaperScene(cursor, snapshot(4)).events.length, 0)
  assert.equal(advancePaperScene(cursor, snapshot(3)).accepted, false)
  assert.equal(advancePaperScene(cursor, snapshot(3), true).accepted, false)
  const duplicate = advancePaperScene(cursor, snapshot(5, { events: [{ id: 'e_4', sequence: 5 }] }))
  assert.equal(duplicate.events.length, 0)
})

test('event window gaps synchronize state without fabricating intermediate animations', () => {
  const cursor = advancePaperScene(null, snapshot(1)).cursor
  const result = advancePaperScene(cursor, snapshot(100, { events_start_sequence: 51, events: [] }))
  assert.equal(result.cursor.sequence, 100); assert.equal(result.events.length, 0); assert.match(result.notice, /已同步/)
  // Ledger sequence includes valuation events that do not have a visible animation.
  const sparse = advancePaperScene(cursor, snapshot(3, { events: [{ id: 'e_3', sequence: 3 }] }))
  assert.equal(sparse.events.length, 1); assert.equal(sparse.notice, '')
  assert.equal(advancePaperScene(cursor, { status: 'invalid' }).cursor, cursor)
})

test('polling accelerates only during execution or active orders; decimals retain precision', () => {
  assert.equal(paperPollDelay(true, null), 1000)
  assert.equal(paperPollDelay(false, snapshot(1, { orders: [{}] })), 1000)
  assert.equal(paperPollDelay(false, snapshot(1)), 15000)
  assert.equal(paperAmount('10000000000000000.00000001'), '10,000,000,000,000,000.00000001')
  assert.equal(paperAmount('0'), '0'); assert.equal(paperAmount(null), '待核算')
})

test('canvas remounts and motion resume cannot replay a consumed order event', () => {
  const shared = new Set()
  const event = { id: 'fill_1', symbol: 'BTC_USDT' }
  assert.equal(consumeSceneEvents([event], shared).length, 1)
  assert.equal(consumeSceneEvents([event], shared).length, 0)
  // Static mode consumes updates without playing them.
  consumeSceneEvents([{ id: 'fill_2', symbol: 'ETH_USDT' }], shared)
  assert.equal(consumeSceneEvents([{ id: 'fill_2', symbol: 'ETH_USDT' }], shared).length, 0)
  consumeSceneEvents(Array.from({ length: 120 }, (_, n) => ({ id: `next_${n}`, symbol: 'BTC_USDT' })), shared)
  assert.equal(shared.size, 100)
})

test('shipped Blender asset contains both scenes and animation clips within the render budget', () => {
  const buffer = fs.readFileSync(new URL('../public/models/tyche-console.glb', import.meta.url))
  assert.equal(buffer.toString('utf8', 0, 4), 'glTF'); assert.ok(buffer.length < 3 * 1024 * 1024)
  const gltf = JSON.parse(buffer.toString('utf8', 20, 20 + buffer.readUInt32LE(12)))
  for (const name of ['Workflow', 'Trading', 'agent_orchestrator', 'agent_btc-analyst', 'agent_eth-analyst', 'asset_BTC_USDT', 'asset_ETH_USDT']) assert.ok(gltf.nodes.some((node) => node.name === name), name)
  for (const name of ['Idle', 'Reveal']) assert.ok(gltf.animations.some((clip) => clip.name === name), name)
  const triangles = gltf.meshes.reduce((total, mesh) => total + mesh.primitives.reduce((sum, primitive) => sum + gltf.accessors[primitive.indices].count / 3, 0), 0)
  assert.ok(triangles < 5000)
  assert.ok(gltf.materials.every((material) => Object.hasOwn(material.extensions || {}, 'KHR_materials_unlit')))
  assert.ok((gltf.buffers || []).every((buffer) => !buffer.uri))
  assert.equal(gltf.images?.length || 0, 0)
})
