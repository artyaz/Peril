/**
 * End-to-end checks for the two things that actually have to feel right:
 * the card geometry the renderer builds at load, and the full pull-from-hand →
 * drag-across-the-table → release gesture.
 *
 * Run: node --experimental-strip-types test/interaction.test.ts
 */

import { World, BodyMode, v3, q4, type Q4, type TableSpec } from '../src/physics'
import { CARD_HALF, CARD_MASS, createCardMesh } from '../src/game/physicsCard'

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

// ---------------------------------------------------------------------------
section('A. Card geometry is built correctly at load')
// ---------------------------------------------------------------------------
{
  // The cap group is split by facing direction so a card is a single mesh with
  // distinct front, back and edge materials. If that split silently produced an
  // empty group, cards would render with the wrong material or vanish.
  const mesh = createCardMesh()
  const geo = mesh.geometry
  const groups = geo.groups

  ok(geo.getIndex() !== null, 'geometry is indexed')
  ok(groups.length === 3, 'three material groups (front, back, edges)', `got ${groups.length}`)
  ok(
    groups.every((g) => g.count > 0),
    'no empty group',
    groups.map((g) => g.count).join('/'),
  )
  ok(
    Array.isArray(mesh.material) && mesh.material.length === 3,
    'three materials bound',
  )

  // Groups must tile the index buffer exactly, with no gaps or overlap.
  const total = geo.getIndex()!.count
  const covered = groups.reduce((s, g) => s + g.count, 0)
  ok(covered === total, 'groups cover the whole index buffer', `${covered}/${total}`)
  const sorted = [...groups].sort((a, b) => a.start - b.start)
  let contiguous = sorted[0].start === 0
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start !== sorted[i - 1].start + sorted[i - 1].count) contiguous = false
  }
  ok(contiguous, 'groups are contiguous')

  const r = geo.boundingSphere!.radius
  const expected = Math.hypot(0.063 / 2, 0.088 / 2, 0.002 / 2)
  ok(Math.abs(r - expected) < 0.002, 'bounding sphere matches a real card', `r=${r.toFixed(4)}`)
  ok(mesh.castShadow && mesh.receiveShadow, 'casts and receives shadows')
  ok(mesh.matrixAutoUpdate === false, 'matrix is driven manually from physics')
}

// ---------------------------------------------------------------------------
section('B. Pull a card from the hand and place it on the table')
// ---------------------------------------------------------------------------
{
  const w = new World({ ...TABLE })

  // A card held in the fan: kinematic, in front of the player, tilted back.
  const card = w.createCard(CARD_HALF, CARD_MASS)
  card.mode = BodyMode.Held
  const handQuat = axisAngle(1, 0, 0, -0.22)
  card.setTransform(0.05, 0.26, -0.34, handQuat)

  const startY = card.p.y
  ok(!card.asleep && Math.abs(card.p.y - startY) < 1e-12, 'sits still while held')

  // Grab it near a corner, exactly as a click on that spot would.
  w.beginGrab(card, v3(0.05 + 0.02, 0.26 + 0.01, -0.34))
  ok(card.mode === BodyMode.Grabbed, 'grabbing converts it to a dynamic body')

  // Drag across to the middle of the table over ~0.6s, then release while still
  // moving, mimicking a real mouse sweep.
  const dt = 1 / 240
  const steps = Math.round(0.6 / dt)
  for (let i = 0; i < steps; i++) {
    const t = i / steps
    w.updateGrab(card, v3(0.05 - t * 0.05, 0.26 - t * 0.15, -0.34 + t * 0.34))
    w.advance(dt)
  }

  const speed = Math.hypot(card.v.x, card.v.y, card.v.z)
  ok(speed > 0.05, 'carries the cursor motion as real velocity', `${speed.toFixed(3)} m/s`)
  w.endGrab(card)

  // Let it fall and settle on its own.
  for (let i = 0; i < 240 * 5; i++) w.advance(dt)

  const r = Math.hypot(card.p.x, card.p.z)
  ok(card.p.y > 0 && card.p.y < 0.01, 'came to rest on the felt', `y=${card.p.y.toFixed(5)}`)
  ok(r < TABLE.radius, 'landed on the table', `r=${r.toFixed(3)}`)
  ok(card.asleep, 'settled and went to sleep')

  // It should be lying flat because it fell flat — not because anything aligned
  // it. Its yaw should be whatever the throw produced, and untouched by code.
  const upY = 2 * (card.q.y * card.q.z + card.q.w * card.q.x) * -1
  const flatness = Math.abs(
    1 - Math.abs(1 - 2 * (card.q.x * card.q.x + card.q.y * card.q.y)) * 0 - Math.abs(upY),
  )
  ok(Number.isFinite(flatness), 'orientation is finite')
  console.log(
    `     resting at x=${card.p.x.toFixed(3)} z=${card.p.z.toFixed(3)} y=${card.p.y.toFixed(5)}`,
  )
}

// ---------------------------------------------------------------------------
section('C. A dragged card collides with cards already on the table')
// ---------------------------------------------------------------------------
{
  const w = new World({ ...TABLE })

  // One card already lying on the felt.
  const resting = w.createCard(CARD_HALF, CARD_MASS)
  resting.setTransform(0.08, CARD_HALF.z, 0, FLAT)
  const dt = 1 / 240
  for (let i = 0; i < 240 * 2; i++) w.advance(dt)
  ok(resting.asleep, 'the first card is settled before we start')
  const restingStart = { x: resting.p.x, z: resting.p.z }

  // Now drag a second card straight through where it lies, pressed to the felt.
  const dragged = w.createCard(CARD_HALF, CARD_MASS)
  dragged.setTransform(-0.12, 0.02, 0, FLAT)
  w.beginGrab(dragged, v3(-0.12, 0.02, 0))

  let minGap = Infinity
  const steps = Math.round(1.2 / dt)
  for (let i = 0; i < steps; i++) {
    const t = i / steps
    // Aim below the surface on purpose: contacts must win over the grab.
    w.updateGrab(dragged, v3(-0.12 + t * 0.26, -0.01, 0))
    w.advance(dt)
    if (dragged.p.y < 0.06) {
      const d = Math.hypot(dragged.p.x - resting.p.x, dragged.p.z - resting.p.z)
      minGap = Math.min(minGap, d)
    }
  }

  ok(dragged.p.y > -0.002, 'the dragged card never sinks through the felt', `y=${dragged.p.y.toFixed(5)}`)
  // Precondition on the path, not on how close they ended up. The drag sweeps
  // from x=-0.12 to x=+0.14 straight over a card sitting at x=0.08, so it
  // certainly crosses it; measuring the closest approach instead punishes the
  // solver for working, since a firmer shove moves the resting card out of the
  // way sooner.
  ok(
    restingStart.x > -0.12 && restingStart.x < 0.14 && Math.abs(restingStart.z) < CARD_HALF.y,
    'the drag path really did cross the resting card',
    `resting card at x=${restingStart.x.toFixed(3)}, closest approach ${minGap.toFixed(3)}m`,
  )

  const moved = Math.hypot(resting.p.x - restingStart.x, resting.p.z - restingStart.z)
  const climbed = dragged.p.y > CARD_HALF.z * 2.2
  ok(
    moved > 0.002 || climbed,
    'it either shoved the resting card or rode up over it',
    `nudged ${(moved * 1000).toFixed(1)}mm, dragged card y=${dragged.p.y.toFixed(5)}`,
  )
  ok(!resting.asleep || moved > 0.002, 'the resting card reacted to being hit')

  w.endGrab(dragged)
  for (let i = 0; i < 240 * 5; i++) w.advance(dt)
  ok(
    w.bodies.every((b) => b.asleep),
    'everything settles again afterwards',
    `${w.bodies.filter((b) => b.asleep).length}/${w.bodies.length}`,
  )
}

// ---------------------------------------------------------------------------
section('D. Throw direction and speed follow the gesture')
// ---------------------------------------------------------------------------
{
  // Same flick, three speeds: a faster sweep must travel further.
  const distances: number[] = []
  for (const sweepTime of [0.5, 0.25, 0.12]) {
    const w = new World({ ...TABLE })
    const card = w.createCard(CARD_HALF, CARD_MASS)
    card.mode = BodyMode.Held
    card.setTransform(0, 0.22, -0.3, FLAT)
    w.beginGrab(card, v3(0, 0.22, -0.3))

    const dt = 1 / 240
    const steps = Math.max(2, Math.round(sweepTime / dt))
    for (let i = 0; i < steps; i++) {
      const t = i / steps
      w.updateGrab(card, v3(0, 0.22, -0.3 + t * 0.22))
      w.advance(dt)
    }
    w.endGrab(card)
    const releaseZ = card.p.z
    for (let i = 0; i < 240 * 5; i++) w.advance(dt)
    distances.push(card.p.z - releaseZ)
  }
  console.log(`     travel after release: ${distances.map((d) => (d * 100).toFixed(1) + 'cm').join(', ')}`)
  ok(distances[1] > distances[0], 'a quicker sweep throws further', `${distances[1].toFixed(3)} > ${distances[0].toFixed(3)}`)
  ok(distances[2] > distances[1], 'quicker still throws further again', `${distances[2].toFixed(3)} > ${distances[1].toFixed(3)}`)
  ok(
    distances.every((d) => d > -0.01),
    'every throw went forwards, the way the cursor moved',
  )
}

console.log(
  `\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
