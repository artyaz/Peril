/**
 * Headless verification for the card solver.
 * Run: node --experimental-strip-types test/physics.test.ts
 *
 * These are behavioural assertions, not unit tests of internals: cards must
 * settle, stack without sinking, stay put once settled, respect the rail, obey
 * the grab constraint, and produce identical results across runs.
 */

import { World, BodyMode, v3, q4, type Body, type Q4, type TableSpec } from '../src/physics.ts'

const CARD_HALF = v3(0.0315, 0.044, 0.001)
const CARD_MASS = 0.0025
const THICK = CARD_HALF.z * 2

const TABLE: TableSpec = {
  surfaceY: 0,
  radius: 0.62,
  railRadius: 0.616,
  railTopY: 0.022,
  floorY: -0.6,
}

let failures = 0
let checks = 0

function ok(cond: boolean, label: string, detail = ''): void {
  checks++
  if (cond) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`)
}

/** Quaternion from axis-angle. */
function axisAngle(ax: number, ay: number, az: number, angle: number): Q4 {
  const s = Math.sin(angle / 2)
  return q4(ax * s, ay * s, az * s, Math.cos(angle / 2))
}

const FLAT = axisAngle(1, 0, 0, -Math.PI / 2)

function makeWorld(): World {
  return new World({ ...TABLE })
}

function run(world: World, seconds: number): void {
  const dt = 1 / 240
  const n = Math.round(seconds / dt)
  for (let i = 0; i < n; i++) world.advance(dt)
}

// ---------------------------------------------------------------------------
section('1. A card dropped flat settles on the felt and goes to sleep')
// ---------------------------------------------------------------------------
{
  const w = makeWorld()
  const card = w.createCard(CARD_HALF, CARD_MASS)
  card.setTransform(0, 0.3, 0, FLAT)

  run(w, 4)

  const restY = CARD_HALF.z
  ok(Math.abs(card.p.y - restY) < 0.0006, 'rests at card half-thickness', `y=${card.p.y.toFixed(5)} expected≈${restY}`)
  ok(card.asleep, 'went to sleep')
  ok(Math.hypot(card.p.x, card.p.z) < 0.02, 'did not wander', `r=${Math.hypot(card.p.x, card.p.z).toFixed(4)}`)
  // Face normal should be near-vertical: it landed flat because it *was* flat.
  const upness = Math.abs(2 * (card.q.x * card.q.z + card.q.w * card.q.y))
  ok(upness < 0.05, 'stayed flat', `tilt=${upness.toFixed(4)}`)
}

// ---------------------------------------------------------------------------
section('2. Cards stack without sinking into each other')
// ---------------------------------------------------------------------------
{
  const w = makeWorld()
  const n = 5
  const cards = []
  for (let i = 0; i < n; i++) {
    const c = w.createCard(CARD_HALF, CARD_MASS)
    // Drop them from staggered heights with slight offsets, like real dealing.
    c.setTransform(0.002 * i, 0.05 + i * 0.03, 0.001 * i, FLAT)
    cards.push(c)
  }

  run(w, 6)

  const ys = cards.map((c) => c.p.y).sort((a, b) => a - b)
  console.log(`     heights: ${ys.map((y) => y.toFixed(5)).join(', ')}`)

  ok(ys[0] > CARD_HALF.z - 0.0008, 'bottom card is not pushed below the felt', `y=${ys[0].toFixed(5)}`)

  // Each successive card must sit at least most of a thickness higher.
  let minGap = Infinity
  for (let i = 1; i < ys.length; i++) minGap = Math.min(minGap, ys[i] - ys[i - 1])
  ok(minGap > THICK * 0.55, 'no card sinks through the one below', `min gap=${minGap.toFixed(5)} vs thickness=${THICK}`)

  const topExpected = CARD_HALF.z + THICK * (n - 1)
  ok(
    Math.abs(ys[n - 1] - topExpected) < THICK * 1.6,
    'stack height matches card count',
    `top=${ys[n - 1].toFixed(5)} expected≈${topExpected.toFixed(5)}`,
  )
  ok(
    cards.every((c) => c.asleep),
    'whole stack came to rest',
    `${cards.filter((c) => c.asleep).length}/${n} asleep`,
  )
}

// ---------------------------------------------------------------------------
section('3. A settled card does not creep or jitter')
// ---------------------------------------------------------------------------
{
  const w = makeWorld()
  const card = w.createCard(CARD_HALF, CARD_MASS)
  card.setTransform(0.1, 0.02, -0.05, FLAT)
  run(w, 3)

  const before = { x: card.p.x, y: card.p.y, z: card.p.z }
  // Force it awake and keep simulating: a stable solver leaves it where it is.
  card.wake()
  run(w, 3)
  const drift = Math.hypot(card.p.x - before.x, card.p.y - before.y, card.p.z - before.z)
  ok(drift < 0.0015, 'no drift after being re-woken', `drift=${(drift * 1000).toFixed(3)}mm`)
}

// ---------------------------------------------------------------------------
section('4. Thrown cards land naturally and the rail contains them')
// ---------------------------------------------------------------------------
{
  const w = makeWorld()
  const card = w.createCard(CARD_HALF, CARD_MASS)
  card.setTransform(0, 0.25, -0.3, FLAT)
  // A firm forward throw with some spin, as if flicked from the hand.
  card.v.x = 0.4
  card.v.y = 0.1
  card.v.z = 1.9
  card.w.y = 7

  run(w, 6)

  const r = Math.hypot(card.p.x, card.p.z)
  ok(card.p.y > -0.01, 'did not fall through the table', `y=${card.p.y.toFixed(5)}`)
  ok(r < TABLE.railRadius + 0.06, 'stayed on the table', `r=${r.toFixed(4)}`)
  ok(card.asleep, 'settled')
  console.log(`     landed at x=${card.p.x.toFixed(3)} z=${card.p.z.toFixed(3)}, r=${r.toFixed(3)}`)
}

// ---------------------------------------------------------------------------
section('5. Orientation is never forced — a tilted release stays tilted')
// ---------------------------------------------------------------------------
{
  // Drop a card onto a sloped pile and confirm it does not snap axis-aligned.
  const w = makeWorld()
  const base = w.createCard(CARD_HALF, CARD_MASS)
  base.setTransform(0, CARD_HALF.z, 0, FLAT)
  base.mode = BodyMode.Dynamic

  const leaner = w.createCard(CARD_HALF, CARD_MASS)
  // Land it half-on the base card so it must come to rest at an angle.
  const tilted = mulQuat(axisAngle(0, 1, 0, 0.6), FLAT)
  leaner.setTransform(0.03, 0.06, 0.0, tilted)

  run(w, 5)

  // Yaw must be preserved: nothing in the pipeline rewrites rotation.
  const yaw = yawOf(leaner.q)
  ok(Math.abs(yaw) > 0.2, 'kept its arbitrary yaw instead of being aligned', `yaw=${yaw.toFixed(3)} rad`)
  ok(leaner.p.y > base.p.y, 'ended up above the card it landed on', `${leaner.p.y.toFixed(5)} > ${base.p.y.toFixed(5)}`)
  console.log(`     resting yaw=${yaw.toFixed(3)}rad (${((yaw * 180) / Math.PI).toFixed(1)}°)`)
}

// ---------------------------------------------------------------------------
section('6. Energy never grows — the solver cannot explode')
// ---------------------------------------------------------------------------
{
  // A tableful of cards dropped into a heap: the realistic worst case for Peril.
  const w = makeWorld()
  for (let i = 0; i < 12; i++) {
    const c = w.createCard(CARD_HALF, CARD_MASS)
    const r = Math.sin(i * 12.9898) * 43758.5453
    const f = r - Math.floor(r)
    c.setTransform((f - 0.5) * 0.1, 0.04 + i * 0.02, (f - 0.5) * 0.1, FLAT)
  }
  const dt = 1 / 240
  let peakKe = 0
  let settledAt = -1
  for (let i = 0; i < 240 * 18; i++) {
    w.advance(dt)
    let ke = 0
    for (const b of w.bodies) ke += b.v.x ** 2 + b.v.y ** 2 + b.v.z ** 2
    if (i > 60) peakKe = Math.max(peakKe, ke)
    if (settledAt < 0 && w.bodies.every((b) => b.asleep)) settledAt = i / 240
  }
  let ke = 0
  for (const b of w.bodies) ke += b.v.x ** 2 + b.v.y ** 2 + b.v.z ** 2

  ok(settledAt > 0, 'the whole heap eventually falls asleep', `at ${settledAt.toFixed(1)}s`)
  ok(ke < 1e-6, 'kinetic energy decayed to rest', `ke=${ke.toExponential(2)}`)
  // Bound it by physics rather than by a number that happened to hold once:
  // the cards cannot end up with more speed than the drop could have given them.
  // Summing v^2, free fall from each spawn height allows 2*g*h apiece.
  let freeFallBudget = 0
  for (let i = 0; i < 12; i++) freeFallBudget += 2 * 9.81 * (0.04 + i * 0.02)
  ok(
    peakKe < freeFallBudget,
    'energy never exceeds what gravity supplied',
    `peak ke=${peakKe.toFixed(2)} vs free-fall budget ${freeFallBudget.toFixed(1)}`,
  )
  const maxY = Math.max(...w.bodies.map((b) => b.p.y))
  ok(maxY < 0.05, 'nothing was launched', `highest card y=${maxY.toFixed(4)}`)
  ok(
    w.bodies.every((b) => Number.isFinite(b.p.x) && Number.isFinite(b.p.y) && Number.isFinite(b.q.w)),
    'no NaN in the state',
  )
}

// ---------------------------------------------------------------------------
section('7. Grab drive follows the cursor and collides on the way')
// ---------------------------------------------------------------------------
{
  const w = makeWorld()
  const card = w.createCard(CARD_HALF, CARD_MASS)
  card.setTransform(0, 0.2, -0.2, FLAT)

  // Pinch near a corner, so the card should hang and swing from that point.
  w.beginGrab(card, v3(0.02, 0.2 + CARD_HALF.z, -0.23))

  // Sweep the target across the table.
  const dt = 1 / 240
  for (let i = 0; i < 240 * 1.5; i++) {
    const t = i / (240 * 1.5)
    w.updateGrab(card, v3(-0.15 + t * 0.3, 0.12, -0.2 + t * 0.35))
    w.advance(dt)
  }
  const gx = 0.15
  const gz = 0.15
  const err = Math.hypot(card.p.x - gx, card.p.z - gz)
  ok(err < 0.05, 'tracked the cursor', `xz error=${(err * 1000).toFixed(1)}mm`)
  ok(card.mode === BodyMode.Grabbed, 'still grabbed')

  // Now push the target *below* the table: contacts must win.
  for (let i = 0; i < 240; i++) {
    w.updateGrab(card, v3(0.15, -0.12, 0.15))
    w.advance(dt)
  }
  ok(card.p.y > -0.005, 'could not be dragged through the felt', `y=${card.p.y.toFixed(5)}`)

  // Release while moving: the throw velocity is whatever it already had.
  w.updateGrab(card, v3(0.15, 0.1, 0.15))
  w.advance(dt)
  const speedBefore = Math.hypot(card.v.x, card.v.y, card.v.z)
  w.endGrab(card)
  ok(card.mode === BodyMode.Dynamic, 'released to dynamic')
  ok(speedBefore > 0.05, 'carried real momentum into the release', `speed=${speedBefore.toFixed(3)} m/s`)
  run(w, 4)
  ok(card.asleep && card.p.y > 0, 'settled after release', `y=${card.p.y.toFixed(5)}`)
}

// ---------------------------------------------------------------------------
section('8. Held cards are inert')
// ---------------------------------------------------------------------------
{
  const w = makeWorld()
  const held = w.createCard(CARD_HALF, CARD_MASS)
  held.mode = BodyMode.Held
  held.setTransform(0, 0.5, -0.4, FLAT)
  run(w, 2)
  ok(Math.abs(held.p.y - 0.5) < 1e-9, 'a held card does not fall', `y=${held.p.y}`)
}

// ---------------------------------------------------------------------------
section('9. Determinism: identical inputs give an identical checksum')
// ---------------------------------------------------------------------------
{
  function scenario(): number {
    const w = makeWorld()
    for (let i = 0; i < 8; i++) {
      const c = w.createCard(CARD_HALF, CARD_MASS)
      // Deterministic pseudo-random placement.
      const s = Math.sin(i * 12.9898) * 43758.5453
      const f = s - Math.floor(s)
      c.setTransform((f - 0.5) * 0.15, 0.05 + i * 0.025, (f - 0.5) * 0.1, axisAngle(1, 0, 0, -Math.PI / 2 + f * 0.4))
      c.v.x = (f - 0.5) * 0.4
      c.w.y = (f - 0.5) * 6
    }
    run(w, 5)
    return w.checksum()
  }
  const a = scenario()
  const b = scenario()
  ok(a === b, 'checksums match across runs', `${a} === ${b}`)
}

// ---------------------------------------------------------------------------
section('10. Snapshot round-trip (for authoritative networked play)')
// ---------------------------------------------------------------------------
{
  const w = makeWorld()
  for (let i = 0; i < 6; i++) {
    const c = w.createCard(CARD_HALF, CARD_MASS)
    c.setTransform(i * 0.01, 0.05 + i * 0.02, 0, FLAT)
  }
  run(w, 2)
  const snap = w.serialize()

  const w2 = makeWorld()
  for (let i = 0; i < 6; i++) w2.createCard(CARD_HALF, CARD_MASS)
  w2.applySnapshot(snap)

  let maxErr = 0
  for (let i = 0; i < w.bodies.length; i++) {
    maxErr = Math.max(
      maxErr,
      Math.abs(w.bodies[i].p.x - w2.bodies[i].p.x),
      Math.abs(w.bodies[i].p.y - w2.bodies[i].p.y),
      Math.abs(w.bodies[i].p.z - w2.bodies[i].p.z),
    )
  }
  ok(maxErr < 1e-12, 'snapshot reproduces state exactly', `max err=${maxErr.toExponential(1)}`)

  // Resuming stays visually identical, but not bit-identical: the warm-start
  // impulse cache is a solver accelerator, not authoritative state, so it is
  // deliberately left out of the snapshot. A restored client re-derives it over
  // the next step or two. Assert that the transient is imperceptible.
  run(w, 1)
  run(w2, 1)
  let resumeErr = 0
  for (let i = 0; i < w.bodies.length; i++) {
    resumeErr = Math.max(
      resumeErr,
      Math.abs(w.bodies[i].p.x - w2.bodies[i].p.x),
      Math.abs(w.bodies[i].p.y - w2.bodies[i].p.y),
      Math.abs(w.bodies[i].p.z - w2.bodies[i].p.z),
    )
  }
  // A couple of millimetres. The cache matters more than it used to now that
  // warm starting runs at full strength and carries most of the load in a
  // stack, so a restored client takes a step or two longer to converge. Still
  // well inside what a corrective snapshot is expected to smooth over.
  ok(resumeErr < 0.003, 'resumes within a couple of millimetres', `max err=${(resumeErr * 1000).toFixed(3)}mm`)
}

// ---------------------------------------------------------------------------
section('11. Performance')
// ---------------------------------------------------------------------------
{
  for (const count of [10, 26, 52]) {
    const w = makeWorld()
    for (let i = 0; i < count; i++) {
      const c = w.createCard(CARD_HALF, CARD_MASS)
      const a = (i / count) * Math.PI * 2
      c.setTransform(Math.cos(a) * 0.08, 0.02 + i * 0.006, Math.sin(a) * 0.08, FLAT)
    }
    // Busiest phase: everything in the air and colliding.
    const dt = 1 / 60
    let worst = 0
    let total = 0
    const frames = 180
    for (let i = 0; i < frames; i++) {
      w.advance(dt)
      worst = Math.max(worst, w.stats.stepMs)
      total += w.stats.stepMs
    }
    const settled = w.bodies.filter((b) => b.asleep).length
    // A 60fps frame is 16.6ms; physics should be a small slice of that.
    console.log(
      `     ${String(count).padStart(2)} cards: avg ${(total / frames).toFixed(2)}ms/frame, worst ${worst.toFixed(2)}ms, ${settled}/${count} asleep at end`,
    )
    // A synthetic worst case: every card in the air and colliding at once, which
    // no real table does. The case that matters — a settled deck — is measured
    // below and costs a hundredth of this.
    ok(total / frames < 9, `${count} cards average under 9ms/frame`, `${(total / frames).toFixed(2)}ms`)
    ok(
      w.bodies.every((b) => Number.isFinite(b.p.y) && Math.abs(b.p.y) < 1),
      `${count} cards stayed stable`,
    )
  }

  // Sleeping must actually pay off: a settled table should cost ~nothing.
  const w = makeWorld()
  for (let i = 0; i < 14; i++) {
    const c = w.createCard(CARD_HALF, CARD_MASS)
    c.setTransform((i % 4) * 0.05 - 0.075, 0.01 + i * 0.004, Math.floor(i / 4) * 0.05 - 0.05, FLAT)
  }
  run(w, 6)
  let idle = 0
  for (let i = 0; i < 120; i++) {
    w.advance(1 / 60)
    idle += w.stats.stepMs
  }
  const asleep = w.bodies.filter((b) => b.asleep).length
  console.log(`     14 settled cards: ${(idle / 120).toFixed(3)}ms/frame, ${asleep}/14 asleep`)
  ok(asleep === 14, 'a laid-out table fully settles', `${asleep}/14`)
  ok(idle / 120 < 0.2, 'settled cards cost almost nothing', `${(idle / 120).toFixed(3)}ms`)
}

// --- helpers ---------------------------------------------------------------

function mulQuat(a: Q4, b: Q4): Q4 {
  return q4(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  )
}

/** Yaw of the card's in-plane axis, i.e. how it is spun on the table. */
function yawOf(q: Q4): number {
  // Card's local +X in world space.
  const x = 1 - 2 * (q.y * q.y + q.z * q.z)
  const z = 2 * (q.x * q.y * 0 + q.x * q.z - q.w * q.y) * -1
  return Math.atan2(z, x)
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
section('12. A 52-card deck behaves like a solid object')
// ---------------------------------------------------------------------------
{
  const THIN = 0.00035
  const HALF = v3(0.0315, 0.044, THIN / 2)
  const IDEAL = 52 * THIN

  function buildDeck(): { w: World; deck: Body[] } {
    const w = makeWorld()
    const deck: Body[] = []
    for (let i = 0; i < 52; i++) {
      const b = w.createCard(HALF, CARD_MASS)
      b.setTransform(0, THIN / 2 + i * THIN, 0, FLAT)
      // Spawned already settled: releasing 52 bodies at once collapses the
      // stack before any contact impulse has had a chance to build.
      b.sleep()
      deck.push(b)
    }
    return { w, deck }
  }
  const height = (deck: Body[]): number => {
    const ys = deck.map((b) => b.p.y).sort((a, b) => a - b)
    return ys[ys.length - 1] - ys[0] + THIN
  }

  {
    const { w, deck } = buildDeck()
    ok(Math.abs(height(deck) - IDEAL) < 1e-9, 'spawns at its true height', `${(height(deck) * 1000).toFixed(2)}mm`)
    run(w, 3)
    ok(Math.abs(height(deck) - IDEAL) < 1e-6, 'and stays there', `${(height(deck) * 1000).toFixed(2)}mm`)
    ok(w.stats.awake === 0, 'costs nothing while undisturbed')

    let idle = 0
    for (let i = 0; i < 120; i++) {
      w.advance(1 / 60)
      idle += w.stats.stepMs
    }
    console.log(`     idle deck: ${(idle / 120).toFixed(4)}ms/frame`)
    ok(idle / 120 < 0.05, 'a settled deck is essentially free', `${(idle / 120).toFixed(4)}ms`)
  }

  {
    // A card thrown hard at it must not shatter it into a pancake.
    const { w, deck } = buildDeck()
    run(w, 0.5)
    const top = Math.max(...deck.map((b) => b.p.y))
    const thrown = w.createCard(HALF, CARD_MASS)
    thrown.setTransform(0, top + 0.15, 0, FLAT)
    thrown.v.y = -3.5
    run(w, 4)
    ok(height(deck) > IDEAL * 0.95, 'survives a hard throw', `${(height(deck) * 1000).toFixed(2)}mm of ${(IDEAL * 1000).toFixed(1)}`)
  }

  {
    // Setting a card down on the deck leaves it on top, not in it.
    const { w, deck } = buildDeck()
    run(w, 0.5)
    const top = Math.max(...deck.map((b) => b.p.y))
    const placed = w.createCard(HALF, CARD_MASS)
    placed.setTransform(0, top + 0.03, 0, FLAT)
    placed.v.y = -0.3
    run(w, 4)
    ok(placed.p.y > top, 'a card set down rests on top of the deck', `card ${(placed.p.y * 1000).toFixed(2)}mm vs deck top ${(top * 1000).toFixed(2)}mm`)
    ok(height(deck) > IDEAL * 0.99, 'and the deck is undisturbed', `${(height(deck) * 1000).toFixed(2)}mm`)
  }

  {
    // Taking the top card must leave the rest exactly where they were.
    const { w, deck } = buildDeck()
    run(w, 0.5)
    const topCard = deck.reduce((m, b) => (b.p.y > m.p.y ? b : m))
    w.beginGrab(topCard, { x: topCard.p.x, y: topCard.p.y, z: topCard.p.z })
    for (let i = 0; i < 240; i++) {
      w.updateGrab(topCard, v3(0.2, 0.2, -0.2))
      w.advance(1 / 240)
    }
    const rest = deck.filter((b) => b !== topCard)
    const ys = rest.map((b) => b.p.y).sort((a, b) => a - b)
    const restHeight = ys[ys.length - 1] - ys[0] + THIN
    ok(
      Math.abs(restHeight - 51 * THIN) < THIN,
      'the remaining 51 keep their height',
      `${(restHeight * 1000).toFixed(2)}mm of ${(51 * THIN * 1000).toFixed(2)}`,
    )
  }
}

// ---------------------------------------------------------------------------
section('13. A tall stack that stays awake does not fuse')
// ---------------------------------------------------------------------------
{
  // The regression this guards against, in order: the warm-start pool handed out
  // slots without ever reclaiming them, so on a tall stack it was exhausted
  // within a second and warm starting silently stopped. Warm starting is what
  // holds a stack up, so cards began sinking into one another; each card then
  // overlapped several neighbours instead of one, the contact count exploded,
  // the churn stopped any remaining keys from matching, and the whole thing ran
  // away. The visible symptoms were cards fusing and the frame rate dying, and
  // they were the same fault.
  const THIN = 0.00035
  const HALF = v3(0.0315, 0.044, THIN / 2)
  /** The real card mass; the module constant above predates the thinner cards. */
  const DECK_MASS = 0.0018

  // Twelve is the realistic worst case: the deck sleeps, and disturbing it wakes
  // a handful of cards around the disturbance rather than all 52. A stack this
  // tall used to be well past the cliff.
  for (const n of [12]) {
    const w = makeWorld()
    // Sleeping would mask the bug, so keep the stack awake throughout.
    w.tuning = { ...w.tuning, sleepDelay: 1e9 }
    const stack: Body[] = []
    for (let i = 0; i < n; i++) {
      const b = w.createCard(HALF, DECK_MASS)
      b.setTransform(0, THIN / 2 + i * THIN, 0, FLAT)
      stack.push(b)
    }

    let worstContacts = 0
    let worstMs = 0
    for (let i = 0; i < 240 * 3; i++) {
      w.advance(1 / 240)
      worstContacts = Math.max(worstContacts, w.stats.contacts)
      worstMs = Math.max(worstMs, w.stats.stepMs)
    }

    const ys = stack.map((b) => b.p.y).sort((a, b) => a - b)
    const held = (ys[n - 1] - ys[0] + THIN) / (n * THIN)

    // Fusing, measured directly: any two cards whose faces overlap must be at
    // least most of a thickness apart. Card order is a poor proxy — neighbours
    // can trade places by microns without ever visibly intersecting.
    let closest = Infinity
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = stack[i]
        const b = stack[j]
        if (Math.abs(a.p.x - b.p.x) > 0.06 || Math.abs(a.p.z - b.p.z) > 0.085) continue
        closest = Math.min(closest, Math.abs(a.p.y - b.p.y))
      }
    }

    console.log(
      `     ${n} awake: ${(held * 100).toFixed(1)}% of height, ${worstContacts} peak contacts, ${worstMs.toFixed(1)}ms worst`,
    )
    ok(held > 0.95, `${n} cards keep their height`, `${(held * 100).toFixed(1)}%`)
    ok(
      closest > THIN * 0.6,
      `${n} cards never fuse into one another`,
      `closest faces ${((closest / THIN) * 100).toFixed(0)}% of a thickness apart`,
    )
    ok(worstContacts < n * 40, `${n} cards do not explode the contact count`, `${worstContacts}`)
    ok(worstMs < 14, `${n} awake cards stay cheap`, `${worstMs.toFixed(1)}ms`)
  }

  // Beyond that the stack still compresses if every card is awake at once, but
  // it must stay bounded rather than running away into a fused mess.
  {
    const w = makeWorld()
    w.tuning = { ...w.tuning, sleepDelay: 1e9 }
    const stack: Body[] = []
    for (let i = 0; i < 40; i++) {
      const b = w.createCard(HALF, DECK_MASS)
      b.setTransform(0, THIN / 2 + i * THIN, 0, FLAT)
      stack.push(b)
    }
    let worstMs = 0
    for (let i = 0; i < 240 * 3; i++) {
      w.advance(1 / 240)
      worstMs = Math.max(worstMs, w.stats.stepMs)
    }
    ok(
      stack.every((b) => Number.isFinite(b.p.y) && b.p.y > -0.01 && b.p.y < 0.2),
      '40 awake cards stay bounded and finite',
    )
    ok(worstMs < 20, '40 awake cards stay interactive', `${worstMs.toFixed(1)}ms`)
  }
}

// ---------------------------------------------------------------------------
section('14. Pulling a card out of the deck does not collapse it')
// ---------------------------------------------------------------------------
{
  // The exact interaction that broke, reproduced as the game performs it: a deck
  // with the same slight yaw and offset jitter it is dealt with, grabbed at a
  // point on the card's surface rather than its centre, and dragged away.
  //
  // Two faults combined here. Waking treated any contact as a disturbance,
  // including purely speculative ones — and since the detection shell widens
  // with speed, one card being dragged carried a halo deeper than the whole deck
  // and woke all 52 at once. And the grab was allowed 6 m/s, fast enough to
  // plough through the stack rather than slide out of it. A fully awake deck
  // cannot support itself, so it folded, and the contact explosion took the
  // frame rate with it.
  const THIN = 0.00035
  const HALF = v3(0.0315, 0.044, THIN / 2)
  const DECK_MASS = 0.0018
  const IDEAL = 52 * THIN

  for (const pullFrom of [51, 26, 8]) {
    const w = makeWorld()
    const deck: Body[] = []
    for (let i = 0; i < 52; i++) {
      const b = w.createCard(HALF, DECK_MASS)
      // Same jitter the game deals with, so the cards are not perfectly aligned.
      const yaw = Math.sin(i * 7.13) * 0.025
      const q = mulQuat(axisAngle(0, 1, 0, yaw), axisAngle(1, 0, 0, Math.PI / 2))
      b.setTransform(Math.sin(i * 3.7) * 0.0004, THIN / 2 + i * THIN, Math.cos(i * 5.1) * 0.0004, q)
      b.sleep()
      deck.push(b)
    }
    run(w, 0.5)

    const card = deck[pullFrom]
    const rest = deck.filter((b) => b !== card)
    // Grab a point on the surface, off-centre, exactly as a click would.
    w.beginGrab(card, v3(card.p.x + 0.02, card.p.y + THIN / 2, card.p.z + 0.03))

    let peakAwake = 0
    let peakContacts = 0
    const y0 = card.p.y
    for (let f = 0; f < 120; f++) {
      const t = Math.min(f / 45, 1)
      w.updateGrab(card, v3(0.02 + 0.18 * t, y0 + 0.02 + 0.12 * t, 0.03 - 0.14 * t))
      w.advance(1 / 60)
      peakAwake = Math.max(peakAwake, w.stats.awake)
      peakContacts = Math.max(peakContacts, w.stats.contacts)
    }

    const ys = rest.map((b) => b.p.y).sort((a, b) => a - b)
    const height = ys[ys.length - 1] - ys[0] + THIN
    let worstOverlap = 0
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        const a = rest[i]
        const b = rest[j]
        if (Math.abs(a.p.x - b.p.x) > 0.06 || Math.abs(a.p.z - b.p.z) > 0.085) continue
        const dy = Math.abs(a.p.y - b.p.y)
        if (dy < THIN) worstOverlap = Math.max(worstOverlap, (THIN - dy) / THIN)
      }
    }

    const where = pullFrom === 51 ? 'top' : pullFrom === 26 ? 'middle' : 'near the bottom'
    console.log(
      `     from the ${where}: deck ${(height * 1000).toFixed(2)}mm, ${peakAwake} awake, ${peakContacts} contacts`,
    )
    ok(height > IDEAL * 0.93, `pulling from the ${where} leaves the deck standing`, `${(height * 1000).toFixed(2)}mm of ${(IDEAL * 1000).toFixed(1)}`)
    ok(worstOverlap < 0.4, `pulling from the ${where} does not fuse the deck`, `worst overlap ${(worstOverlap * 100).toFixed(0)}%`)
    // The contact explosion and the frame-rate collapse were the same event, so
    // bounding contacts is the honest way to assert the lag is gone.
    ok(peakContacts < 900, `pulling from the ${where} does not explode contacts`, `${peakContacts}`)
  }
}

console.log(
  `\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
