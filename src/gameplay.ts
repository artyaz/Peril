/**
 * gameplay.ts — the maths behind the table actions.
 *
 * Deliberately free of Three.js and of any DOM, for the same reason the solver
 * is: these are the parts worth testing headlessly, and keeping them pure means
 * a networked host can compute the identical throw.
 */

import type { V3, Q4 } from './physics'

/**
 * Launch velocity that carries a body from `from` to `to` in `flightTime`,
 * under constant `gravity`.
 *
 * Solving the ballistic arc rather than nudging the card towards the target
 * means the throw is a real projectile: it is released, and nothing steers it
 * afterwards. Where it actually ends up is still up to the collision solver.
 */
export function ballisticVelocity(
  from: V3,
  to: V3,
  flightTime: number,
  gravity: number,
  out: V3,
): V3 {
  const t = Math.max(flightTime, 1e-3)
  out.x = (to.x - from.x) / t
  out.y = (to.y - from.y) / t - 0.5 * gravity * t
  out.z = (to.z - from.z) / t
  return out
}

/** q = a * b */
export function quatMul(a: Q4, b: Q4, out: Q4): Q4 {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  out.x = x
  out.y = y
  out.z = z
  out.w = w
  return out
}

const _delta: Q4 = { x: 0, y: 0, z: 0, w: 1 }
const _inv: Q4 = { x: 0, y: 0, z: 0, w: 1 }

/**
 * Angular velocity that rotates `from` onto `to` over `time`, along the
 * shortest arc.
 *
 * Used instead of assigning an orientation outright. A card that snapped to
 * face-up the instant you played it would look like a UI animation; giving it
 * the spin that gets it there lets it turn over in flight and land under its
 * own momentum, and the solver still has the final say on how it settles.
 */
export function angularVelocityTo(from: Q4, to: Q4, time: number, out: V3): V3 {
  _inv.x = -from.x
  _inv.y = -from.y
  _inv.z = -from.z
  _inv.w = from.w
  quatMul(to, _inv, _delta)

  // Shortest arc: q and -q are the same rotation, so pick the near one.
  if (_delta.w < 0) {
    _delta.x = -_delta.x
    _delta.y = -_delta.y
    _delta.z = -_delta.z
    _delta.w = -_delta.w
  }

  const sinHalf = Math.sqrt(_delta.x * _delta.x + _delta.y * _delta.y + _delta.z * _delta.z)
  if (sinHalf < 1e-6) {
    out.x = 0
    out.y = 0
    out.z = 0
    return out
  }
  const angle = 2 * Math.atan2(sinHalf, _delta.w)
  const s = angle / (sinHalf * Math.max(time, 1e-3))
  out.x = _delta.x * s
  out.y = _delta.y * s
  out.z = _delta.z * s
  return out
}

/**
 * Orientation with the card's face pointing at world +Y, spun by `yaw`.
 *
 * A card's local +Z is its front face, so a quarter turn back about X lays it
 * face-up; the yaw is then applied about world up.
 */
export function faceUpQuaternion(yaw: number, out: Q4): Q4 {
  const hy = yaw * 0.5
  const c = Math.SQRT1_2
  // Ry(yaw) * Rx(-90deg)
  out.x = Math.cos(hy) * -c
  out.y = Math.sin(hy) * c
  out.z = Math.sin(hy) * c
  out.w = Math.cos(hy) * c
  return out
}

/**
 * Where a card should slot into the fan, given the cursor and the on-screen
 * positions of the cards already there.
 *
 * Works in screen space, the way a desktop list reorder does. Inverting the fan
 * geometry instead is tempting and worse: the answer then depends on camera
 * pitch, and the fan and the near edge of the table can occupy the same screen
 * region at a low angle.
 */
export function insertionIndexAt(cursorX: number, slotXs: number[]): number {
  let i = 0
  for (const x of slotXs) if (x < cursorX) i++
  return i
}

/**
 * Small deterministic PRNG. Throws need to vary, but a networked table needs
 * every client to produce the *same* variation, so this is seeded rather than
 * using Math.random.
 */
export function makeRandom(seed: number): () => number {
  let s = (seed | 0) || 1
  return () => {
    // xorshift32
    s ^= s << 13
    s |= 0
    s ^= s >>> 17
    s ^= s << 5
    s |= 0
    return ((s >>> 0) % 100000) / 100000
  }
}

/** Even spread in [-1, 1] from a [0, 1) generator. */
export function spread(rand: () => number): number {
  return rand() * 2 - 1
}

/** Rotate `v` by `q`. */
function rotate(q: Q4, vx: number, vy: number, vz: number, out: V3): V3 {
  const tx = 2 * (q.y * vz - q.z * vy)
  const ty = 2 * (q.z * vx - q.x * vz)
  const tz = 2 * (q.x * vy - q.y * vx)
  out.x = vx + q.w * tx + (q.y * tz - q.z * ty)
  out.y = vy + q.w * ty + (q.z * tx - q.x * tz)
  out.z = vz + q.w * tz + (q.x * ty - q.y * tx)
  return out
}

const _axis: V3 = { x: 0, y: 0, z: 0 }

/**
 * The yaw a card is lying at, as `faceUpQuaternion` would express it.
 * Inverse of that function, so a card can be squared up with another one.
 */
export function faceUpYawOf(q: Q4): number {
  rotate(q, 0, 1, 0, _axis)
  return Math.atan2(-_axis.x, -_axis.z)
}

const _aim: V3 = { x: 0, y: 0, z: 0 }
const _faceUp: Q4 = { x: 0, y: 0, z: 0, w: 1 }
const _sim: V3 = { x: 0, y: 0, z: 0 }
const _simV: V3 = { x: 0, y: 0, z: 0 }

/** How far the throw may miss, and how far off square it may land. */
export const PLAY_SCATTER = 0.008
export const PLAY_YAW_JITTER = 0.35
/** Passes of aim correction. Two is plenty; the first removes most of the miss. */
export const PLAY_AIM_PASSES = 6

/** The forces a thrown card feels, mirroring the solver's own model. */
export interface FlightModel {
  gravity: number
  damping: number
  angularDamping: number
  /** 0.5 * airDensity * dragCoefficient * faceArea / mass. */
  dragK: number
}

const _simQ: Q4 = { x: 0, y: 0, z: 0, w: 1 }
const _simW: V3 = { x: 0, y: 0, z: 0 }
const _simN: V3 = { x: 0, y: 0, z: 0 }

/**
 * Fly a card forward and report where it crosses `landingY`.
 *
 * The orientation is integrated alongside the position, which is the whole
 * point. Drag on a card acts along its face normal, not downward, so a card
 * still tilted from the hand it was thrown out of gets a large *sideways* push
 * that curves it off course. Modelling it as a face-up plate falling straight
 * down predicts the landing to within a centimetre and is wrong by ten.
 */
export function simulateFlight(
  from: V3,
  v: V3,
  q: Q4,
  w: V3,
  model: FlightModel,
  landingY: number,
  out: V3,
): number {
  _simV.x = v.x
  _simV.y = v.y
  _simV.z = v.z
  _simQ.x = q.x
  _simQ.y = q.y
  _simQ.z = q.z
  _simQ.w = q.w
  _simW.x = w.x
  _simW.y = w.y
  _simW.z = w.z
  out.x = from.x
  out.y = from.y
  out.z = from.z

  const dt = 1 / 240
  let t = 0
  for (let i = 0; i < 1200; i++) {
    _simV.y += model.gravity * dt

    // Pressure drag along the face normal, exactly as the solver applies it.
    rotate(_simQ, 0, 0, 1, _simN)
    const vn = _simV.x * _simN.x + _simV.y * _simN.y + _simV.z * _simN.z
    const a = -model.dragK * Math.abs(vn) * vn * dt
    _simV.x += _simN.x * a
    _simV.y += _simN.y * a
    _simV.z += _simN.z * a

    const d = Math.exp(-model.damping * dt)
    _simV.x *= d
    _simV.y *= d
    _simV.z *= d

    // Spin, so the normal above follows the card as it turns face-up.
    const hx = _simW.x * dt * 0.5
    const hy = _simW.y * dt * 0.5
    const hz = _simW.z * dt * 0.5
    const { x: qx, y: qy, z: qz, w: qw } = _simQ
    _simQ.x += hx * qw + hy * qz - hz * qy
    _simQ.y += hy * qw + hz * qx - hx * qz
    _simQ.z += hz * qw + hx * qy - hy * qx
    _simQ.w += -(hx * qx + hy * qy + hz * qz)
    const l = Math.hypot(_simQ.x, _simQ.y, _simQ.z, _simQ.w) || 1
    _simQ.x /= l
    _simQ.y /= l
    _simQ.z /= l
    _simQ.w /= l
    const ad = Math.exp(-model.angularDamping * dt)
    _simW.x *= ad
    _simW.y *= ad
    _simW.z *= ad

    out.x += _simV.x * dt
    out.y += _simV.y * dt
    out.z += _simV.z * dt
    t += dt
    if (out.y <= landingY && _simV.y < 0) break
  }
  return t
}

/**
 * Work out the velocity and spin to drop a card on a chosen spot.
 *
 * Returns the flight time and fills `outV` / `outW`. Everything is derived from
 * a seeded generator, so every client in a room computes the identical throw.
 * Note what this does *not* do: it never writes a position or an orientation.
 * The card is launched and the solver takes it from there.
 *
 * The arc is aimed by iteration rather than by formula. A closed-form ballistic
 * solution assumes a vacuum, and a card is about the worst projectile for that
 * assumption there is: face-up and falling, it has enough drag to stay airborne
 * appreciably longer than the formula expects and to sail 5-15cm past the mark.
 * Flying the trajectory first and shifting the aim by however far it missed
 * removes that in a couple of passes, and costs a few hundred multiplications
 * once per throw.
 */
export function planPlayThrow(
  from: V3,
  fromQ: Q4,
  target: V3,
  targetYaw: number,
  model: FlightModel,
  rand: () => number,
  outV: V3,
  outW: V3,
): number {
  const flight = 0.34 + rand() * 0.06

  // Land roughly squared with the way the player is facing, but never exactly.
  // Worked out first, because the spin decides how the card is angled through
  // the flight and therefore which way drag pushes it.
  faceUpQuaternion(targetYaw + spread(rand) * PLAY_YAW_JITTER, _faceUp)
  angularVelocityTo(fromQ, _faceUp, flight * 0.82, outW)
  outW.y += spread(rand) * 0.8

  // Aim straight at the spot. Lobbing at a point above it only adds fall time
  // for the card to drift through.
  _aim.x = target.x + spread(rand) * PLAY_SCATTER
  _aim.y = target.y
  _aim.z = target.z + spread(rand) * PLAY_SCATTER
  const wantX = _aim.x
  const wantZ = _aim.z

  for (let pass = 0; pass < PLAY_AIM_PASSES; pass++) {
    ballisticVelocity(from, _aim, flight, model.gravity, outV)
    if (pass === PLAY_AIM_PASSES - 1) break
    simulateFlight(from, outV, fromQ, outW, model, target.y, _sim)
    // Shift the aim by exactly how far the flight missed.
    _aim.x += wantX - _sim.x
    _aim.z += wantZ - _sim.z
  }
  return flight
}
