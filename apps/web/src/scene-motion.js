import { Quaternion, Vector3 } from 'three'

// Motion for the Paper asset shapes. Display only: nothing here reads or changes position data.
const STEP = 1 / 120
const MAX_SPIN = 14
const HOMING_SPEED = 2.6
const STIFFNESS = 24
const DAMPING = 7.5
const FRICTION = 1.1
const step = new Quaternion(), arc = new Vector3()

// Semi-implicit damped spring for one scalar; fixed substeps keep it stable at the 40 FPS frame cap.
export function spring(state, target, dt, stiffness = 170, damping = 20) {
  for (let left = Math.min(dt, .1); left > 1e-6; left -= STEP) {
    const h = Math.min(left, STEP)
    state.v += (stiffness * (target - state.x) - damping * state.v) * h
    state.x += state.v * h
  }
  return state.x
}

// Shortest-arc rotation vector (axis × angle) of a unit quaternion.
export function rotationVector(q, out = new Vector3()) {
  const sign = q.w < 0 ? -1 : 1
  const half = Math.acos(Math.min(1, q.w * sign))
  const sine = Math.sin(half)
  return out.set(q.x, q.y, q.z).multiplyScalar(sine < 1e-6 ? 2 * sign : 2 * half * sign / sine)
}

export function createGrip() {
  return { q: new Quaternion(), w: new Vector3(), held: false, homing: -1 }
}

// Catching a shape stops any spin; drags then turn it about a world axis.
export function holdGrip(grip) {
  grip.held = true; grip.homing = -1; grip.w.set(0, 0, 0)
}

export function turnGrip(grip, axis, angle, dt) {
  grip.q.premultiply(step.setFromAxisAngle(axis, angle)).normalize()
  // Smoothed angular velocity, kept for the throw.
  if (dt > 0) grip.w.lerp(arc.copy(axis).multiplyScalar(angle / Math.max(dt, 1 / 240)), .45)
}

// A release keeps the throw only while the pointer was still moving.
export function releaseGrip(grip, idle) {
  grip.held = false
  if (!(idle <= .08)) grip.w.set(0, 0, 0)
  const speed = grip.w.length()
  if (speed > MAX_SPIN) grip.w.multiplyScalar(MAX_SPIN / speed)
}

// Fast throws coast under light friction; once slow, a spring eases the shape back to rest the short way.
export function settleGrip(grip, dt) {
  if (grip.held || (grip.q.w === 1 && grip.w.lengthSq() === 0)) return
  for (let left = Math.min(dt, .1); left > 1e-6; left -= STEP) {
    const h = Math.min(left, STEP)
    if (grip.homing < 0 && grip.w.length() < HOMING_SPEED) grip.homing = 0
    if (grip.homing >= 0) grip.homing += h
    const pull = grip.homing < 0 ? 0 : Math.min(1, grip.homing / .35)
    rotationVector(grip.q, arc)
    if (pull === 1 && arc.lengthSq() < 1e-10 && grip.w.lengthSq() < 1e-10) { grip.q.identity(); grip.w.set(0, 0, 0); return }
    grip.w.addScaledVector(arc, -STIFFNESS * pull * h).multiplyScalar(Math.exp(-(FRICTION + (DAMPING - FRICTION) * pull) * h))
    const speed = grip.w.length()
    if (speed * h > 1e-12) grip.q.premultiply(step.setFromAxisAngle(arc.copy(grip.w).divideScalar(speed), speed * h)).normalize()
  }
}
