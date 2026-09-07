import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPaperSceneAdapter, projectPaperScene } from '../scripts/control-paper-scene.mjs'
import { paperSceneDto } from '../apps/control-plane/src/paper-scene.mjs'
import { sceneFixture } from './paper-scene-fixtures.mjs'

test('scene follows confirmed quantities through partial fill, remainder cancellation, reduction and close', () => {
  const f = sceneFixture()
  assert.deepEqual(projectPaperScene(f.ledger).positions, [])
  const order = f.open()
  let scene = projectPaperScene(f.ledger)
  assert.equal(scene.orders[0].status, 'OPEN'); assert.equal(scene.positions.length, 0)
  f.fill(order, '3', true)
  scene = projectPaperScene(f.ledger)
  assert.equal(scene.positions[0].contracts, '3'); assert.equal(scene.orders[0].filled_contracts, '3')
  assert.equal(scene.orders[0].status, 'PARTIALLY_FILLED')
  f.append('SIMULATED_CANCELLED', { paper_order_id: order, symbol: 'BTC_USDT', reason: 'VISIBLE_DEPTH_EXHAUSTED' })
  scene = projectPaperScene(f.ledger)
  assert.equal(scene.orders.length, 0); assert.equal(scene.positions[0].contracts, '3')
  f.close('BTC_USDT', '1'); assert.equal(projectPaperScene(f.ledger).positions[0].contracts, '2')
  f.close('BTC_USDT', '2'); assert.equal(projectPaperScene(f.ledger).positions.length, 0)
})

test('scene retains exact long/short valuation at its actual mark, and never invents a missing valuation', () => {
  const f = sceneFixture()
  f.fill(f.open())
  f.fill(f.open('ETH_USDT', 'sell', '10'), '10')
  let scene = projectPaperScene(f.ledger)
  assert.equal(scene.positions[0].unrealized_pnl, null); assert.equal(scene.summary.equity, null)
  f.mark()
  scene = projectPaperScene(f.ledger)
  assert.deepEqual(scene.positions.map((row) => [row.side, row.unrealized_pnl]), [['long', '7.5'], ['short', '1']])
  assert.equal(scene.summary.unrealized_pnl, '8.5'); assert.equal(scene.summary.equity, '10008.3')
  const valuation = scene.valuation_at
  f.close('BTC_USDT', '1')
  scene = projectPaperScene(f.ledger)
  assert.equal(scene.positions[0].mark_price, null); assert.equal(scene.positions[0].unrealized_pnl, null)
  assert.equal(scene.positions[1].unrealized_pnl, '1')
  assert.equal(scene.valuation_at, valuation); assert.equal(scene.summary.equity, '10008.3')
  f.mark({ BTC_USDT: '69500' })
  scene = projectPaperScene(f.ledger)
  assert.equal(scene.summary.unrealized_pnl, null); assert.equal(scene.positions[1].unrealized_pnl, null)
})

test('expired orders create no position and liquidation removes exactly the recorded position', () => {
  const f = sceneFixture(), order = f.open()
  f.append('SIMULATED_CANCELLED', { paper_order_id: order, symbol: 'BTC_USDT', reason: 'WATCH_EXPIRED' })
  assert.equal(projectPaperScene(f.ledger).positions.length, 0)
  const next = f.open('ETH_USDT', 'sell'); f.fill(next)
  const position = projectPaperScene(f.ledger).positions[0]
  f.append('SIMULATED_LIQUIDATION', { symbol: 'ETH_USDT', loss: position.margin })
  const scene = projectPaperScene(f.ledger)
  assert.equal(scene.positions.length, 0); assert.equal(scene.events.at(-1).type, 'SIMULATED_LIQUIDATION')
})

test('scene projection is bounded and strips raw objects, proof material and unrecognized strings', () => {
  const f = sceneFixture(); f.fill(f.open())
  for (let i = 0; i < 60; i++) f.append('SIMULATION_EVIDENCE_GAP', { symbol: 'BTC_USDT', private_key: 'never-visible' })
  const value = projectPaperScene(f.ledger)
  assert.equal(value.events.length, 50); assert.equal(value.events_start_sequence, value.sequence - 49)
  const result = paperSceneDto({ ...value, account: 'never-visible', ledger: f.ledger, credentials: 'never-visible', positions: value.positions.map((p) => ({ ...p, proof: 'never-visible', account_id: 'never-visible' })) })
  assert.doesNotMatch(JSON.stringify(result), /never-visible|account_id|private_key|ledger|proof|source_id|event_hash/)
  assert.equal(result.environment, 'paper'); assert.equal(result.positions[0].contracts, '5')
  assert.equal(paperSceneDto({ ...value, positions: [{ symbol: 'BTC_USDT', side: 'long', contracts: '-1' }] }).status, 'invalid')
})

test('readonly adapter distinguishes missing, corrupt, inaccessible and repaired files and rejects symlinks', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tyche-scene-'))
  try {
    const read = createPaperSceneAdapter({ root }), file = path.join(root, 'data/paper/active.json')
    assert.equal(read().status, 'unconfigured')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const f = sceneFixture(); fs.writeFileSync(file, JSON.stringify(f.ledger))
    assert.equal(read().status, 'ready')
    const before = fs.readFileSync(file, 'utf8'); read(); assert.equal(fs.readFileSync(file, 'utf8'), before)
    fs.writeFileSync(file, '{'); assert.equal(read().status, 'invalid')
    f.fill(f.open()); fs.writeFileSync(file, JSON.stringify(f.ledger)); assert.equal(read().positions.length, 1)
    const broken = structuredClone(f.ledger); broken.events[0].event_hash = 'tampered'; fs.writeFileSync(file, JSON.stringify(broken)); assert.equal(read().status, 'invalid')
    fs.rmSync(file); fs.mkdirSync(file); assert.equal(read().status, 'invalid')
    fs.rmdirSync(file); fs.symlinkSync('/etc/hosts', file); assert.equal(read().status, 'invalid')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
