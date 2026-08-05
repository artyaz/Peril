/**
 * Checks for the table actions: playing a card onto another, taking one back
 * into the hand, and the fan reordering maths.
 *
 * Run: node --experimental-strip-types test/gameplay.test.ts
 */

import { World, BodyMode, TUNING, v3, q4, type Q4, type V3, type TableSpec } from '../src/physics'
import {
  angularVelocityTo,
  ballisticVelocity,
  faceUpQuaternion,
  faceUpYawOf,
  insertionIndexAt,
  makeRandom,
  planPlayThrow,
  quatMul,
} from '../src/game/tableActions'

const CARD_HALF = v3(0.0315, 0.044, 0.001)
const CARD_MASS = 0.0025
const TABLE: TableSpec = {
  surfaceY: 0,
  radius: 0.62,
  railRadius: 0.619,
  railTopY: 0.018,
  floorY: -0.55,
}

let failures = 0
let checks = 0
function ok(cond: boolean, label: string, detail = ''): void {
  checks++
  console.log(
    `  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${label}${detail ? ` — ${detail}` : ''}`,
  )
  if (!cond) failures++
}
function section(n: string): void {
  console.log(`\n\x1b[1m${n}\x1b[0m`)
}

function axisAngle(ax: number, ay: number, az: number, a: number): Q4 {
  const s = Math.sin(a / 2)
  return q4(ax * s, ay * s, az * s, Math.cos(a / 2))
}
const FLAT = axisAngle(1, 0, 0, -Math.PI / 2)

function rot(q: Q4, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}
/** How close the card's face points to straight up: +1 face-up, -1 face-down. */
function faceUpness(q: Q4): number {
  return rot(q, { x: 0, y: 0, z: 1 }).y
}

// ---------------------------------------------------------------------------
section('1. faceUpQuaternion really does lay a card face-up')
// ---------------------------------------------------------------------------
{
  const q = faceUpQuaternion(0, q4())
  const n = rot(q, { x: 0, y: 0, z: 1 })
  ok(Math.abs(n.y - 1) < 1e-9, 'face normal points at world up', `n=(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)})`)

  let worst = 0
  for (let i = 0; i < 16; i++) {
    const yaw = -Math.PI + (i / 16) * 2 * Math.PI
    const qq = faceUpQuaternion(yaw, q4())
    worst = Math.max(worst, Math.abs(faceUpness(qq) - 1))
    // faceUpYawOf must invert it.
    let back = faceUpYawOf(qq)
    let d = back - yaw
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    worst = Math.max(worst, Math.abs(d))
  }
  ok(worst < 1e-6, 'stays face-up at every yaw, and yaw round-trips', `worst err=${worst.toExponential(1)}`)
}

// ---------------------------------------------------------------------------
section('2. Ballistic velocity actually reaches the target')
// ---------------------------------------------------------------------------
{
  const from = v3(0.1, 0.3, -0.2)
  const to = v3(-0.15, 0.05, 0.25)
  const T = 0.34
  const g = -9.81
  const v = ballisticVelocity(from, to, T, g, v3())

  // Integrate the closed-form trajectory and see where it lands at t = T.
  const px = from.x + v.x * T
  const py = from.y + v.y * T + 0.5 * g * T * T
  const pz = from.z + v.z * T
  const err = Math.hypot(px - to.x, py - to.y, pz - to.z)
  ok(err < 1e-9, 'arrives exactly on target at the flight time', `err=${err.toExponential(1)}`)
}

// ---------------------------------------------------------------------------
section('3. angularVelocityTo rotates one orientation onto another')
// ---------------------------------------------------------------------------
{
  let worst = 0
  const cases: Array<[Q4, Q4]> = [
    [q4(), faceUpQuaternion(1.2, q4())],
    [FLAT, faceUpQuaternion(-2.4, q4())],
    [axisAngle(0, 1, 0, 2.9), axisAngle(1, 0, 0, -0.4)],
    [q4(), q4()],
  ]
  for (const [from, to] of cases) {
    const time = 0.3
    const w = angularVelocityTo(from, to, time, v3())
    // Integrate the spin forward and compare with the goal.
    const q: Q4 = { ...from }
    const dt = 1 / 2000
    for (let t = 0; t < time; t += dt) {
      const hx = w.x * dt * 0.5
      const hy = w.y * dt * 0.5
      const hz = w.z * dt * 0.5
      const { x, y, z, w: qw } = q
      q.x += hx * qw + hy * z - hz * y
      q.y += hy * qw + hz * x - hx * z
      q.z += hz * qw + hx * y - hy * x
      q.w += -(hx * x + hy * y + hz * z)
      const l = Math.hypot(q.x, q.y, q.z, q.w)
      q.x /= l
      q.y /= l
      q.z /= l
      q.w /= l
    }
    // |dot| == 1 means the same rotation.
    const dot = Math.abs(q.x * to.x + q.y * to.y + q.z * to.z + q.w * to.w)
    worst = Math.max(worst, 1 - dot)
  }
  ok(worst < 1e-3, 'reaches the goal orientation in the given time', `worst 1-|dot|=${worst.toExponential(1)}`)

  // Shortest arc: never take the long way round.
  const w = angularVelocityTo(axisAngle(0, 1, 0, 0.1), axisAngle(0, 1, 0, -0.1), 0.3, v3())
  ok(Math.hypot(w.x, w.y, w.z) * 0.3 < Math.PI, 'takes the short way round', `angle=${(Math.hypot(w.x, w.y, w.z) * 0.3).toFixed(3)}rad`)
}

// ---------------------------------------------------------------------------
section('4. Fan reordering places a card where the cursor is')
// ---------------------------------------------------------------------------
{
  // Screen x of five cards already fanned out in the hand.
  const xs = [400, 450, 500, 550, 600]

  ok(insertionIndexAt(380, xs) === 0, 'left of every card inserts at the front')
  ok(insertionIndexAt(620, xs) === xs.length, 'right of every card inserts at the back')
  ok(insertionIndexAt(505, xs) === 3, 'between two cards inserts between them')
  ok(insertionIndexAt(500, []) === 0, 'an empty hand always inserts at 0')

  // Monotonic: sweeping right must never move the slot left.
  let prev = -1
  let monotonic = true
  const seen = new Set<number>()
  for (let x = 350; x <= 650; x += 2) {
    const i = insertionIndexAt(x, xs)
    if (i < prev) monotonic = false
    prev = i
    seen.add(i)
  }
  ok(monotonic, 'sweeping across the fan never moves the slot backwards')
  ok(seen.size === xs.length + 1, 'every gap in the fan is reachable', `${seen.size}/${xs.length + 1}`)

  // Reordering must be a pure permutation: no card lost, none duplicated.
  const order = ['a', 'b', 'c', 'd', 'e']
  const moved = order.slice()
  const taken = moved.splice(1, 1)[0]
  moved.splice(insertionIndexAt(620, [400, 450, 550, 600]), 0, taken)
  ok(moved.length === 5 && new Set(moved).size === 5, 'reordering keeps every card exactly once')
  ok(moved[4] === 'b', 'the dragged card lands where it was dropped', moved.join(''))
}

// ---------------------------------------------------------------------------
section('5. Seeded randomness is deterministic and in range')
// ---------------------------------------------------------------------------
{
  const a = makeRandom(12345)
  const b = makeRandom(12345)
  let same = true
  let inRange = true
  for (let i = 0; i < 500; i++) {
    const x = a()
    const y = b()
    if (x !== y) same = false
    if (!(x >= 0 && x < 1)) inRange = false
  }
  ok(same, 'the same seed gives the same sequence')
  ok(inRange, 'values stay in [0,1)')
  const c = makeRandom(999)
  ok(c() !== makeRandom(12345)(), 'different seeds differ')
}

// ---------------------------------------------------------------------------
section('6. Dropping a card lands it on the spot, face up')
// ---------------------------------------------------------------------------
{
  const AREA = 0.063 * 0.088
  const MODEL = {
    gravity: TUNING.gravity,
    damping: TUNING.linearDamping,
    angularDamping: TUNING.angularDamping,
    dragK: (0.5 * TUNING.aeroPressure * AREA) / CARD_MASS,
  }

  let faceUp = 0
  let settled = 0
  const runs = 24
  const misses: number[] = []

  for (let seed = 1; seed <= runs; seed++) {
    const w = new World({ ...TABLE })

    // Aim at a spot somewhere on the felt.
    const a = (seed / runs) * Math.PI * 2
    const radius = 0.06 + (seed % 5) * 0.05
    const target = v3(Math.cos(a) * radius, CARD_HALF.z, Math.sin(a) * radius)

    // Held near the player, dangling from the pinch as if being dragged.
    const card = w.createCard(CARD_HALF, CARD_MASS)
    card.setTransform(-0.02, 0.24, -0.3, axisAngle(1, 0, 0, -0.3))
    card.mode = BodyMode.Dynamic

    const rand = makeRandom(seed * 7919)
    planPlayThrow(
      card.p,
      card.q,
      target,
      (seed / runs) * Math.PI,
      MODEL,
      rand,
      card.v,
      card.w,
    )
    card.wake()

    const dt = 1 / 240
    for (let i = 0; i < 240 * 5; i++) w.advance(dt)

    misses.push(Math.hypot(card.p.x - target.x, card.p.z - target.z))
    if (faceUpness(card.q) > 0.75) faceUp++
    if (card.asleep) settled++
  }

  const mean = misses.reduce((a, b) => a + b, 0) / runs
  const worst = Math.max(...misses)
  console.log(
    `     landed ${(mean * 1000).toFixed(0)}mm from the mark on average, worst ${(worst * 1000).toFixed(0)}mm, over ${runs} drops`,
  )

  // A card is 63mm wide, so landing inside its own width of the mark means the
  // card covers the spot you pointed at.
  // A card is 63mm wide, so landing this close means it covers the spot you
  // pointed at. Before the arc was solved against the real flight rather than a
  // vacuum, the average miss was 54mm and the worst 129mm.
  ok(mean < 0.03, 'lands within half a card of the mark on average', `${(mean * 1000).toFixed(1)}mm`)
  // The tail is wider than the average because a card that comes down on its
  // edge skitters before it settles. Rare, and inherent to throwing something
  // that tumbles; the average is what the aim correction fixed.
  ok(worst < 0.2, 'and never wildly off', `worst ${(worst * 1000).toFixed(1)}mm`)
  // A tumbling card can still occasionally come down on its edge and settle the
  // other way up; it should be rare rather than impossible.
  ok(faceUp >= runs - 2, 'drops land face up', `${faceUp}/${runs}`)
  ok(settled === runs, 'every drop settles', `${settled}/${runs}`)

  // ...but no two identical, or the scatter is doing nothing.
  const spreadRange = Math.max(...misses) - Math.min(...misses)
  ok(spreadRange > 0.002, 'drops still vary from one another', `range=${(spreadRange * 1000).toFixed(1)}mm`)
}

// ---------------------------------------------------------------------------
section('7. Taking a card flies it into the hand and it stays there')
// ---------------------------------------------------------------------------
{
  const w = new World({ ...TABLE })
  const card = w.createCard(CARD_HALF, CARD_MASS)
  card.setTransform(0.2, CARD_HALF.z, 0.15, FLAT)
  const dt = 1 / 240
  for (let i = 0; i < 240; i++) w.advance(dt)
  ok(card.asleep, 'card starts settled on the table')

  // Mirror what takeCard does: grab the centre and haul it to the hand slot.
  const slot = v3(-0.03, 0.26, -0.33)
  const slotQ = axisAngle(1, 0, 0, -0.22)
  card.flying = false
  w.beginGrab(card, { x: card.p.x, y: card.p.y, z: card.p.z })

  // Mirror updateFlight: walk the grab target from pickup to slot, eased.
  const FLIGHT_TIME = 0.34
  const from = { x: card.p.x, y: card.p.y, z: card.p.z }
  let arrivedAt = -1
  let peakSpeed = 0
  const wv = v3()
  for (let i = 0; i < 240 * 2; i++) {
    const t = Math.min(i / 240 / FLIGHT_TIME, 1)
    const e = t * t * (3 - 2 * t)
    w.updateGrab(card, {
      x: from.x + (slot.x - from.x) * e,
      y: from.y + (slot.y - from.y) * e,
      z: from.z + (slot.z - from.z) * e,
    })
    angularVelocityTo(card.q, slotQ, Math.max(FLIGHT_TIME - i / 240, 0.08), wv)
    card.w.x = wv.x
    card.w.y = wv.y
    card.w.z = wv.z
    w.advance(dt)
    peakSpeed = Math.max(peakSpeed, Math.hypot(card.v.x, card.v.y, card.v.z))
    const d = Math.hypot(card.p.x - slot.x, card.p.y - slot.y, card.p.z - slot.z)
    if (arrivedAt < 0 && t >= 1 && d < 0.025) arrivedAt = i / 240
  }
  ok(arrivedAt > 0, 'reached the hand slot', arrivedAt > 0 ? `in ${arrivedAt.toFixed(2)}s` : 'never')
  // Fast enough to feel responsive, slow enough to actually see.
  ok(arrivedAt > 0.2 && arrivedAt < 0.75, 'takes a readable amount of time', `${arrivedAt.toFixed(2)}s`)
  ok(peakSpeed < 5, 'never snaps at the grab speed limit', `peak ${peakSpeed.toFixed(2)} m/s`)

  const dot = Math.abs(card.q.x * slotQ.x + card.q.y * slotQ.y + card.q.z * slotQ.z + card.q.w * slotQ.w)
  ok(dot > 0.97, 'turned to match the fan on the way in', `|dot|=${dot.toFixed(4)}`)

  // Once held it must sit perfectly still, like any other card in the fan.
  card.mode = BodyMode.Held
  const at = { x: card.p.x, y: card.p.y, z: card.p.z }
  for (let i = 0; i < 240; i++) w.advance(dt)
  ok(
    Math.abs(card.p.x - at.x) < 1e-12 && Math.abs(card.p.y - at.y) < 1e-12,
    'sits still once it is in the hand',
  )
}

// ---------------------------------------------------------------------------
section('8. Gathering a group pulls cards to the cursor and holds them')
// ---------------------------------------------------------------------------
{
  const w = new World({ ...TABLE })
  const group = []
  for (let i = 0; i < 6; i++) {
    const c = w.createCard(CARD_HALF, CARD_MASS)
    const a = (i / 6) * Math.PI * 2
    c.setTransform(Math.cos(a) * 0.22, CARD_HALF.z, Math.sin(a) * 0.22, FLAT)
    group.push(c)
  }
  const dt = 1 / 240
  for (let i = 0; i < 240 * 2; i++) w.advance(dt)
  ok(
    group.every((c) => c.asleep),
    'all six start settled and spread out',
  )

  const spreadBefore = Math.max(...group.map((c) => Math.hypot(c.p.x, c.p.z)))

  // Gather: grab each centre, targets in a tight golden-angle clump.
  const cursor = v3(0.0, 0.16, 0.0)
  for (const c of group) w.beginGrab(c, { x: c.p.x, y: c.p.y, z: c.p.z })
  for (let i = 0; i < 240 * 1.5; i++) {
    for (let j = 0; j < group.length; j++) {
      const a = j * 2.39996
      const r = 0.009 * Math.sqrt(j)
      w.updateGrab(group[j], {
        x: cursor.x + Math.cos(a) * r,
        y: cursor.y + j * 0.0022,
        z: cursor.z + Math.sin(a) * r,
      })
    }
    w.advance(dt)
  }

  const spreadAfter = Math.max(...group.map((c) => Math.hypot(c.p.x - cursor.x, c.p.z - cursor.z)))
  ok(spreadAfter < 0.06, 'the group is bunched at the cursor', `max radius ${(spreadAfter * 1000).toFixed(0)}mm (was ${(spreadBefore * 1000).toFixed(0)}mm)`)
  ok(
    group.every((c) => c.p.y > 0.05),
    'and lifted off the table',
    `lowest y=${Math.min(...group.map((c) => c.p.y)).toFixed(3)}`,
  )

  // Cards must not be inside one another while clumped.
  let minSep = Infinity
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      minSep = Math.min(
        minSep,
        Math.hypot(group[i].p.x - group[j].p.x, group[i].p.y - group[j].p.y, group[i].p.z - group[j].p.z),
      )
    }
  }
  ok(minSep > 0.0015, 'cards in the clump stay separated', `closest pair ${(minSep * 1000).toFixed(2)}mm`)

  // Drop them somewhere else; they must fall and settle.
  for (const c of group) w.endGrab(c)
  for (let i = 0; i < 240 * 6; i++) w.advance(dt)
  ok(
    group.every((c) => c.asleep),
    'the dropped group settles',
    `${group.filter((c) => c.asleep).length}/6 asleep`,
  )
  ok(
    group.every((c) => c.p.y > -0.01 && c.p.y < 0.02),
    'and ends up lying on the table',
  )
}

// ---------------------------------------------------------------------------
section('9. quatMul matches a reference implementation')
// ---------------------------------------------------------------------------
{
  const a = axisAngle(0.3, 0.5, 0.81, 1.1)
  const b = axisAngle(-0.6, 0.2, 0.77, -0.7)
  const got = quatMul(a, b, q4())
  const want = {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
  const err = Math.max(
    Math.abs(got.x - want.x),
    Math.abs(got.y - want.y),
    Math.abs(got.z - want.z),
    Math.abs(got.w - want.w),
  )
  ok(err < 1e-12, 'product is correct', `err=${err.toExponential(1)}`)
  // Aliasing the output onto an input must still work.
  const c = { ...a }
  quatMul(c, b, c)
  ok(Math.abs(c.x - want.x) < 1e-12 && Math.abs(c.w - want.w) < 1e-12, 'safe when out aliases an input')
}

console.log(
  `\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
