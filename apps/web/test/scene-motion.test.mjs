import test from 'node:test'
import assert from 'node:assert/strict'
import { spring, rotationVector, createGrip, holdGrip, turnGrip, releaseGrip, settleGrip } from '../src/scene-motion.js'

const UP = { x: 0, y: 1, z: 0 }
const angle = (grip) => rotationVector(grip.q).length()
// Advance at the canvas frame cap; report the total turn and the largest offset from rest.
function settle(grip, seconds) {
  const previous = grip.q.clone()
  let travelled = 0, largest = 0
  for (let frame = 0; frame < seconds * 40; frame++) {
    settleGrip(grip, 1 / 40)
    travelled += previous.angleTo(grip.q); previous.copy(grip.q)
    largest = Math.max(largest, angle(grip))
  }
  return { travelled, largest }
}

test('springs settle on target and stay stable at the 40 FPS frame cap', () => {
  for (const [stiffness, damping] of [[150, 17], [380, 15], [90, 14], [40, 13]]) {
    const state = { x: 0, v: 0 }
    for (let frame = 0; frame < 120; frame++) spring(state, 1, .06, stiffness, damping)
    assert.ok(Math.abs(state.x - 1) < 1e-3 && Math.abs(state.v) < 1e-2, `${stiffness}/${damping}`)
  }
  const pop = { x: 0, v: 0 }
  let peak = 0
  for (let frame = 0; frame < 40; frame++) peak = Math.max(peak, spring(pop, 1, 1 / 40, 380, 15))
  assert.ok(peak > 1.05 && peak < 1.5, String(peak))
  assert.equal(spring({ x: .4, v: 0 }, 1, 0), .4)
})

test('rotation vectors take the shortest arc', () => {
  const grip = createGrip()
  assert.equal(angle(grip), 0)
  turnGrip(grip, UP, Math.PI * 5 / 3, 0)
  assert.ok(Math.abs(angle(grip) - Math.PI / 3) < 1e-9)
})

test('a held shape stays where the pointer leaves it', () => {
  const grip = createGrip()
  holdGrip(grip)
  turnGrip(grip, UP, 1, 1 / 60)
  assert.ok(settle(grip, 2).travelled < 1e-5)
  assert.ok(Math.abs(angle(grip) - 1) < 1e-9)
})

test('a throw coasts past a full turn, then settles at rest', () => {
  const grip = createGrip()
  holdGrip(grip)
  for (let move = 0; move < 6; move++) turnGrip(grip, UP, .12, .008)
  releaseGrip(grip, .01)
  assert.ok(grip.w.length() > 10 && grip.w.length() <= 14, String(grip.w.length()))
  assert.ok(settle(grip, 8).travelled > Math.PI * 2)
  assert.ok(angle(grip) < 1e-4 && grip.w.length() < 1e-4)
})

test('a paused release does not throw, and settling never unwinds whole turns', () => {
  const grip = createGrip()
  holdGrip(grip)
  turnGrip(grip, UP, Math.PI * 5 / 3, .01)
  releaseGrip(grip, .5)
  assert.equal(grip.w.length(), 0)
  const { travelled, largest } = settle(grip, 5)
  assert.ok(largest <= Math.PI / 3 + 1e-9 && travelled < Math.PI / 2, `${largest} ${travelled}`)
  assert.ok(angle(grip) < 1e-4)
})
