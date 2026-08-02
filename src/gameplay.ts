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

/** How high over the target the arc is aimed, and how far it may miss. */
export const PLAY_ARC_HEIGHT = 0.045
export const PLAY_SCATTER = 0.014
export const PLAY_YAW_JITTER = 0.4

/**
 * Work out the velocity and spin for playing a card onto another one.
 *
 * Returns the flight time and fills `outV` / `outW`. Everything is derived from
 * a seeded generator, so every client in a room computes the identical throw.
 * Note what this does *not* do: it never writes a position or an orientation.
 * The card is launched and the solver takes it from there.
 */
export function planPlayThrow(
  from: V3,
  fromQ: Q4,
  target: V3,
  targetQ: Q4,
  gravity: number,
  rand: () => number,
  outV: V3,
  outW: V3,
): number {
  _aim.x = target.x + spread(rand) * PLAY_SCATTER
  _aim.y = target.y + PLAY_ARC_HEIGHT
  _aim.z = target.z + spread(rand) * PLAY_SCATTER

  const flight = 0.3 + rand() * 0.08
  ballisticVelocity(from, _aim, flight, gravity, outV)

  // Land roughly squared with the card being beaten, but never exactly.
  const yaw = faceUpYawOf(targetQ) + spread(rand) * PLAY_YAW_JITTER
  faceUpQuaternion(yaw, _faceUp)

  // Slightly quicker than the flight, since angular damping bleeds some off.
  angularVelocityTo(fromQ, _faceUp, flight * 0.82, outW)
  outW.y += spread(rand) * 1.8
  return flight
}
