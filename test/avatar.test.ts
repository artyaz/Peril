/**
 * Headless verification for the player avatars.
 * Run: node --experimental-strip-types test/avatar.test.ts
 *
 * There is no renderer here, so none of this is about how the figures look. It
 * is about the things that break silently when they do: seats that drift out of
 * even spacing or off the far side of the rail, a figure that stops facing the
 * table, a fan anchor that sinks into the felt or ends up behind the player, a
 * billboard that no longer tracks the camera, a networked pose that snaps
 * instead of easing, a shader injection whose anchor was renamed out from under
 * it, geometry that stops being shared, and a dispose() that frees the wrong
 * thing.
 */

import * as THREE from 'three'
import {
  Avatar,
  seatPosition,
  avatarColour,
  AVATAR_COLOURS,
  AVATAR_HEIGHT,
  TABLE_RADIUS,
  disposeSharedAvatarResources,
} from '../src/avatar.ts'

// ---------------------------------------------------------------------------
// A minimal DOM shim.
//
// The avatar module renders the nickname to a 2D canvas and loads the face
// image through three's TextureLoader, both of which need document/Image. Node
// has neither, so stand up just enough of them here — a canvas that can be
// measured and drawn to, and an <img> that fires load once its src is set — so
// the texture paths actually run under the headless test rather than falling
// back to the no-DOM stubs. Nothing here draws real pixels; there is no GL
// context and the tests never read any back.
// ---------------------------------------------------------------------------
function installDomShim(): void {
  if (typeof (globalThis as { document?: unknown }).document !== 'undefined') return

  const ctx2d = {
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 0,
    shadowColor: '',
    shadowBlur: 0,
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    fillText() {},
    // ~0.5em per glyph is close enough that the label aspect is sane; the exact
    // width does not matter to any assertion, only that longer text is wider.
    measureText(t: string) {
      return { width: t.length * 22 }
    },
  }

  function makeCanvas(): Record<string, unknown> {
    return {
      width: 0,
      height: 0,
      getContext: () => ctx2d,
    }
  }

  function makeImage(): Record<string, unknown> {
    const listeners: Record<string, Array<() => void>> = {}
    let _src = ''
    return {
      width: 128,
      height: 128,
      naturalWidth: 128,
      naturalHeight: 128,
      complete: false,
      crossOrigin: null,
      addEventListener(type: string, cb: () => void) {
        ;(listeners[type] ??= []).push(cb)
      },
      removeEventListener() {},
      set src(v: string) {
        _src = v
        // Fire load on the next tick, as a real image would.
        setTimeout(() => {
          ;(this as { complete: boolean }).complete = true
          for (const cb of listeners['load'] ?? []) cb.call(this)
        }, 0)
      },
      get src() {
        return _src
      },
    }
  }

  const doc = {
    createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : makeImage()),
    createElementNS: (_ns: string, tag: string) => (tag === 'img' ? makeImage() : makeCanvas()),
  }
  ;(globalThis as { document?: unknown }).document = doc
  ;(globalThis as { window?: unknown }).window = { devicePixelRatio: 2 }
}
installDomShim()

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

let seq = 0
function make(nickname = 'Ada', seat = 0, seatCount = 6, colour?: string): Avatar {
  return new Avatar({ id: `p${seq++}`, nickname, seat, seatCount, colour })
}

/** A named descendant, or a hard failure — the tests depend on these existing. */
function part(a: Avatar, name: string): THREE.Mesh {
  const o = a.group.getObjectByName(name)
  if (!o) throw new Error(`avatar has no "${name}"`)
  return o as THREE.Mesh
}

function boxOf(o: THREE.Object3D): THREE.Box3 {
  o.updateWorldMatrix(true, true)
  return new THREE.Box3().setFromObject(o)
}

/** The glass silhouette: head and body together, ignoring the contour shell. */
function glassBox(a: Avatar): THREE.Box3 {
  return boxOf(part(a, 'body')).union(boxOf(part(a, 'head')))
}

function matOf(m: THREE.Mesh): THREE.Material {
  return m.material as THREE.Material
}

const CARD_H = 0.088

// A camera parked off to one side, orbited per-test where the billboard matters.
function orbitCamera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(55, 1.6, 0.05, 14)
  c.position.set(0, 0.6, 1.3)
  c.lookAt(0, 0.1, 0)
  c.updateMatrixWorld(true)
  return c
}

// ---------------------------------------------------------------------------
section('1. seatPosition places seats evenly around the rail, on the felt')
// ---------------------------------------------------------------------------
{
  const out = new THREE.Vector3()
  for (const n of [2, 4, 5, 6]) {
    let worstY = 0
    const angles: number[] = []
    const radii: number[] = []
    for (let i = 0; i < n; i++) {
      seatPosition(i, n, TABLE_RADIUS, out)
      worstY = Math.max(worstY, Math.abs(out.y))
      angles.push(Math.atan2(out.x, out.z))
      radii.push(Math.hypot(out.x, out.z))
    }

    // Every seat the same distance from the centre.
    const rSpread = Math.max(...radii) - Math.min(...radii)

    // Neighbours a constant angle apart: 2*pi / n, to within rounding.
    let worstGap = 0
    for (let i = 0; i < n; i++) {
      let d = angles[(i + 1) % n] - angles[i]
      d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      worstGap = Math.max(worstGap, Math.abs(d - (Math.PI * 2) / n))
    }

    const rail = TABLE_RADIUS
    console.log(`     ${n} seats: r=${radii[0].toFixed(4)}m, spacing error ${(worstGap * 1e6).toFixed(2)} urad`)
    ok(rSpread < 1e-12, `${n} seats sit on one circle`, `spread ${(rSpread * 1e9).toFixed(1)}nm`)
    ok(worstY < 1e-12, `${n} seats stand on the felt (y=0)`, `worst |y|=${worstY.toExponential(1)}`)
    ok(worstGap < 1e-9, `${n} seats are evenly spaced`, `worst gap error ${(worstGap * 1e6).toFixed(2)} urad`)
    ok(radii[0] > rail, `${n} seats sit outside the ${rail}m rail`, `${(radii[0] * 1000).toFixed(0)}mm > ${(rail * 1000).toFixed(0)}mm`)
    // But not absurdly far out — a seated player is close to the edge.
    ok(radii[0] < rail + 0.25, `${n} seats are still at the table, not across the room`, `${((radii[0] - rail) * 1000).toFixed(0)}mm past the rail`)
  }

  // The out-param is returned and written in place, so a caller can chain.
  const scratch = new THREE.Vector3()
  const returned = seatPosition(0, 6, TABLE_RADIUS, scratch)
  ok(returned === scratch, 'writes into the out-param and returns it')

  // A larger table pushes the seats out by exactly the radius difference.
  const small = seatPosition(0, 6, 0.4, new THREE.Vector3())
  const large = seatPosition(0, 6, 0.9, new THREE.Vector3())
  ok(Math.abs(large.z - small.z - 0.5) < 1e-9, 'seat radius tracks the table radius', `Δ=${(large.z - small.z).toFixed(4)}m for a 0.5m Δ`)
}

// ---------------------------------------------------------------------------
section('2. A seated Avatar reads as a person at the table')
// ---------------------------------------------------------------------------
{
  const a = make()
  const glass = glassBox(a)

  ok(Math.abs(glass.min.y) < 1e-6, 'the glass base stands on its own origin', `base y=${glass.min.y.toFixed(6)}`)
  ok(Math.abs(glass.max.y - AVATAR_HEIGHT) < 1e-6, 'the crown is exactly AVATAR_HEIGHT', `${(glass.max.y * 1000).toFixed(1)}mm`)
  ok(Math.abs(AVATAR_HEIGHT - 0.42) < 1e-9, 'and AVATAR_HEIGHT is the 0.42m the brief asks for', `${AVATAR_HEIGHT}`)

  const width = glass.max.x - glass.min.x
  console.log(`     ${(glass.max.y * 1000).toFixed(0)}mm tall, ${(width * 1000).toFixed(0)}mm wide — ${(glass.max.y / CARD_H).toFixed(1)} cards tall`)
  ok(width < glass.max.y, 'is taller than it is wide')

  // Head is a sphere on the bell; the two must overlap or the silhouette has a
  // notch where they meet.
  const head = boxOf(part(a, 'head'))
  const body = boxOf(part(a, 'body'))
  ok(head.min.y < body.max.y, 'the head sinks into the shoulders', `head bottom ${head.min.y.toFixed(4)} < body top ${body.max.y.toFixed(4)}`)
  ok(head.max.y > body.max.y, 'and still clears the top of the bell')
  ok(body.max.x > head.max.x * 1.4, 'the bell is much wider than the head', `${(body.max.x / head.max.x).toFixed(2)}x`)

  // The glass is MeshPhysicalMaterial doing the glassy work.
  const gm = matOf(part(a, 'body')) as THREE.MeshPhysicalMaterial
  ok(gm instanceof THREE.MeshPhysicalMaterial, 'the figure is MeshPhysicalMaterial')
  ok(gm.transmission > 0 && gm.transmission < 1, 'transmits, but not entirely', `transmission=${gm.transmission}`)
  ok(gm.clearcoat > 0 && gm.roughness < 0.3, 'clearcoat over a smooth surface', `roughness=${gm.roughness}`)
  ok(gm.iridescence > 0, 'has the edge hue-shift of thick glass', `iridescence=${gm.iridescence}`)
  // Pure transmission takes its colour from what is behind it, which on the
  // near-black felt in main.ts is a black avatar.
  ok(gm.emissiveIntensity > 0 && gm.emissive.getHex() !== 0, 'is lit from the inside so it survives a dark background')
  ok(matOf(part(a, 'head')) === gm, 'head and body share one glass material')

  // Six figures have to fit around the table without touching.
  const out = new THREE.Vector3()
  seatPosition(0, 6, TABLE_RADIUS, out)
  const seatR = Math.hypot(out.x, out.z)
  const gap = 2 * seatR * Math.sin(Math.PI / 6) - width
  ok(gap > 0, '6 figures fit around the table without overlapping', `${(gap * 1000).toFixed(0)}mm of clearance`)
  a.dispose()
}

// ---------------------------------------------------------------------------
section('3. Every seat faces the centre of the table')
// ---------------------------------------------------------------------------
{
  const centre = new THREE.Vector3(0, 0, 0)
  const front = new THREE.Vector3()
  const toCentre = new THREE.Vector3()
  const camera = orbitCamera()

  for (const n of [3, 4, 6]) {
    let worstFacing = 1
    let worstRadius = 0
    const avatars: Avatar[] = []
    for (let i = 0; i < n; i++) {
      const a = make(`P${i}`, i, n)
      // A fresh avatar with no pose eased yet already faces the middle; run a
      // frame anyway, since update() rewrites the group yaw and must not break
      // the facing when the look-offset is zero.
      a.update(1 / 60, camera)
      a.group.updateMatrixWorld(true)

      const p = a.group.position
      worstRadius = Math.max(worstRadius, Math.abs(p.y))
      // Local +Z is the front, matching the card convention in card.ts.
      front.set(0, 0, 1).applyQuaternion(a.group.getWorldQuaternion(new THREE.Quaternion()))
      toCentre.copy(centre).sub(p).setY(0).normalize()
      worstFacing = Math.min(worstFacing, front.dot(toCentre))
      avatars.push(a)
    }
    console.log(`     ${n} seats: worst facing dot ${worstFacing.toFixed(9)}`)
    ok(worstRadius < 1e-12, `${n} seats stand on the felt`, `worst |y|=${worstRadius.toExponential(1)}`)
    ok(worstFacing > 1 - 1e-9, `all ${n} face the middle`, `worst dot=${worstFacing.toFixed(9)}`)
    for (const a of avatars) a.dispose()
  }

  // A look-offset yaw turns the figure off centre without tipping it over.
  const a = make('Ada', 0, 6)
  a.setPose({ seat: 0, yaw: 0.5, lean: 0 })
  for (let i = 0; i < 120; i++) a.update(1 / 60, camera)
  ok(a.group.rotation.x === 0 && a.group.rotation.z === 0, 'a yaw offset only ever yaws the figure', `x=${a.group.rotation.x}, z=${a.group.rotation.z}`)
  front.set(0, 0, 1).applyQuaternion(a.group.quaternion)
  toCentre.copy(centre).sub(a.group.position).setY(0).normalize()
  ok(front.dot(toCentre) < 0.98 && front.dot(toCentre) > 0.7, 'and turns the figure off-centre by the offset', `dot now ${front.dot(toCentre).toFixed(3)}`)
  a.dispose()
}

// ---------------------------------------------------------------------------
section('4. The card fan anchor sits in front of the chest, above the felt')
// ---------------------------------------------------------------------------
{
  const camera = orbitCamera()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const fwd = new THREE.Vector3()

  for (const seat of [0, 1, 2]) {
    const a = make(`P${seat}`, seat, 4)
    a.update(1 / 60, camera)
    a.fanAnchor(pos, quat)

    const seatR = Math.hypot(a.group.position.x, a.group.position.z)
    const fanR = Math.hypot(pos.x, pos.z)

    ok(pos.y > 0.05 && pos.y < AVATAR_HEIGHT, `seat ${seat}: the fan floats above the felt, below the head`, `y=${(pos.y * 1000).toFixed(0)}mm`)
    // In front of the chest means between the player and the centre: nearer the
    // middle than the body is, but not past it to the far side.
    ok(fanR < seatR && fanR > 0, `seat ${seat}: the fan is in front of the player, toward the centre`, `fan r=${fanR.toFixed(3)} < seat r=${seatR.toFixed(3)}`)
    ok(fanR > seatR - 0.35, `seat ${seat}: and stays out in front, not across the table`, `${((seatR - fanR) * 1000).toFixed(0)}mm in front`)

    // The fan is unattached — it is not a child of the avatar. Reading the
    // anchor must not have parented anything to the figure.
    ok(part(a, 'body').parent!.children.every((c) => c.name !== 'fan'), `seat ${seat}: the avatar renders no fan of its own`)

    // The fan tilts up toward the player: its local +Z, which is the card
    // normal, points up and back out toward the seat rather than flat or into
    // the table.
    fwd.set(0, 0, 1).applyQuaternion(quat)
    ok(fwd.y > 0.3, `seat ${seat}: the fan faces up toward the player`, `+Z.y=${fwd.y.toFixed(3)}`)
    // The horizontal part of that normal points outward (away from centre),
    // i.e. back at the player who holds it.
    const outward = new THREE.Vector3(pos.x, 0, pos.z).normalize()
    const horiz = new THREE.Vector3(fwd.x, 0, fwd.z).normalize()
    ok(horiz.dot(outward) > 0.5, `seat ${seat}: and its face turns back toward the seat`, `dot=${horiz.dot(outward).toFixed(3)}`)
    a.dispose()
  }

  // Leaning in carries the fan with the figure: the anchor moves toward the
  // centre and drops as the player tips over the table.
  const a = make('Lean', 0, 6)
  a.update(1 / 60, camera)
  a.fanAnchor(pos, quat)
  const beforeR = Math.hypot(pos.x, pos.z)
  const beforeY = pos.y
  a.setPose({ seat: 0, yaw: 0, lean: 1 })
  for (let i = 0; i < 120; i++) a.update(1 / 60, camera)
  a.fanAnchor(pos, quat)
  const afterR = Math.hypot(pos.x, pos.z)
  console.log(`     lean pulls the fan from r=${beforeR.toFixed(3)} to r=${afterR.toFixed(3)}, y ${(beforeY * 1000).toFixed(0)}->${(pos.y * 1000).toFixed(0)}mm`)
  ok(afterR < beforeR - 0.01, 'leaning in brings the fan toward the table', `${((beforeR - afterR) * 1000).toFixed(0)}mm closer`)
  a.dispose()
}

// ---------------------------------------------------------------------------
section('5. The nickname is a crisp, camera-facing billboard')
// ---------------------------------------------------------------------------
{
  // The label texture must actually be built (there is a document shim below).
  const a = make('Nora')
  const label = part(a, 'label')
  const labelMat = matOf(label) as THREE.MeshBasicMaterial
  ok(labelMat.map instanceof THREE.Texture, 'the nickname is rendered to a texture')
  ok(labelMat.map !== null && labelMat.map.colorSpace === THREE.SRGBColorSpace, 'tagged sRGB so the pill is not washed out')
  ok(label.visible, 'and the label is drawn')

  // It floats clear of the crown.
  const top = glassBox(a).max.y
  ok(label.position.y > top, 'floats above the head', `${((label.position.y - top) * 1000).toFixed(0)}mm above the crown`)

  // Camera-facing from every seat and every orbit angle: the billboard must
  // cancel both the group's own yaw and the seat bearing.
  const camera = new THREE.PerspectiveCamera(55, 1.6, 0.05, 14)
  const lq = new THREE.Quaternion()
  const cq = new THREE.Quaternion()
  let worst = 0
  for (let seat = 0; seat < 6; seat++) {
    const s = make(`S${seat}`, seat, 6)
    for (let c = 0; c < 8; c++) {
      const yaw = (c / 8) * Math.PI * 2
      const pitch = 0.15 + (c % 3) * 0.45
      camera.position.set(Math.sin(yaw) * Math.cos(pitch) * 1.1, Math.sin(pitch) * 1.1, Math.cos(yaw) * Math.cos(pitch) * 1.1)
      camera.lookAt(0, 0.05, 0)
      camera.updateMatrixWorld(true)
      s.update(1 / 60, camera)
      part(s, 'label').getWorldQuaternion(lq)
      camera.getWorldQuaternion(cq)
      worst = Math.max(worst, 2 * Math.acos(Math.min(Math.abs(lq.dot(cq)), 1)))
    }
    s.dispose()
  }
  ok(worst < 1e-6, 'the label matches the camera from every seat and angle', `worst ${(worst * 1e6).toFixed(3)} urad`)

  // Stated the other way, which is what matters on screen: the plane's normal
  // points straight back down the view direction.
  const b = make('Bea', 2, 5)
  const view = new THREE.Vector3()
  const normal = new THREE.Vector3()
  camera.position.set(0.8, 0.6, -1.0)
  camera.lookAt(0, 0.05, 0)
  camera.updateMatrixWorld(true)
  b.update(1 / 60, camera)
  part(b, 'label').updateWorldMatrix(true, false)
  normal.set(0, 0, 1).applyQuaternion(part(b, 'label').getWorldQuaternion(lq))
  camera.getWorldDirection(view)
  ok(normal.dot(view) < -1 + 1e-9, 'its front faces the viewer, not away', `dot=${normal.dot(view).toFixed(9)}`)
  b.dispose()

  // Scaled, not resized: a longer nickname makes a wider plane at one height,
  // so the text is never stretched.
  const short = make('Al')
  const long = make('Bartholomew')
  const sw = part(short, 'label').scale
  const lw = part(long, 'label').scale
  ok(Math.abs(sw.y - lw.y) < 1e-9, 'every label is the same height', `${(sw.y * 1000).toFixed(1)}mm`)
  ok(lw.x > sw.x * 1.5, 'a longer name gets a wider plane', `${sw.x.toFixed(4)} -> ${lw.x.toFixed(4)}`)

  // Renaming rebuilds the texture and re-fits the plane.
  const before = (matOf(part(short, 'label')) as THREE.MeshBasicMaterial).map
  short.setNickname('Bartholomew')
  const after = (matOf(part(short, 'label')) as THREE.MeshBasicMaterial).map
  ok(after !== before && after instanceof THREE.Texture, 'renaming builds a fresh texture')
  ok(Math.abs(part(short, 'label').scale.x - lw.x) < 1e-9, 'and resizes the plane to match the new name')

  const anon = make('')
  ok(!part(anon, 'label').visible, 'an empty nickname hides the label entirely')

  for (const x of [a, short, long, anon]) x.dispose()
}

// ---------------------------------------------------------------------------
section('6. The face decal is a masked disc on the front of the head')
// ---------------------------------------------------------------------------
{
  const plain = make()
  const faceMat = matOf(part(plain, 'face')) as THREE.MeshBasicMaterial
  ok(faceMat.map === null, 'no face image means no texture')
  ok(part(plain, 'face').visible === false, 'and the disc is not drawn at all')
  ok(faceMat.alphaMap instanceof THREE.Texture && faceMat.transparent, 'the face is masked to a rounded disc, not a square sticker')

  // The disc geometry: inside the glass, on the front half, about half the head
  // wide, centred on the head. This is what makes it read as applied to the
  // sphere rather than floating in front of it.
  const head = boxOf(part(plain, 'head'))
  const face = boxOf(part(plain, 'face'))
  const headR = head.max.x
  ok(face.max.z < head.max.z, 'the decal sits under the glass, not on top of it', `${(face.max.z * 1000).toFixed(1)}mm vs ${(head.max.z * 1000).toFixed(1)}mm`)
  ok(face.min.z > 0, 'is entirely on the front (outward) half of the head', `nearest z=${face.min.z.toFixed(4)}`)
  ok(face.max.x < headR * 0.75 && face.max.x > headR * 0.4, 'covers about half the head width', `${((face.max.x / headR) * 100).toFixed(0)}%`)
  const faceMidY = (face.min.y + face.max.y) / 2
  const headMidY = (head.min.y + head.max.y) / 2
  ok(Math.abs(faceMidY - headMidY) < 0.008, 'is centred on the head', `${((faceMidY - headMidY) * 1000).toFixed(2)}mm off`)

  // The figure looks in over the table (requirement 1), so its front — and the
  // decal on it — is on the inward side, toward the middle. The brief also
  // calls this "facing outward from the table centre" in requirement 3, which
  // reads as the opposite; the two cannot both hold, and "looking inward at the
  // table centre" is the load-bearing one (it decides seating, the lean, and
  // where the fan goes), so the decal follows the gaze. In play that is the
  // right call anyway: the players across the table and a camera orbiting the
  // far side are who see a given player's face. Asserted as the decal centre
  // sitting nearer the table centre than the head's own centre.
  const seated = make('Face', 1, 4)
  seated.group.updateMatrixWorld(true)
  const hc = boxOf(part(seated, 'head')).getCenter(new THREE.Vector3())
  const fc = boxOf(part(seated, 'face')).getCenter(new THREE.Vector3())
  ok(Math.hypot(fc.x, fc.z) < Math.hypot(hc.x, hc.z), 'the decal is on the figure\'s front, the side it faces the table with')
  seated.dispose()

  // Setting a URL attaches a texture and (once loaded) shows the disc. The
  // document shim below makes TextureLoader return a texture synchronously
  // enough to observe the map; visibility flips in the load callback.
  const withFace = make('Grace')
  withFace.setFaceImage('face.png')
  const mat = matOf(part(withFace, 'face')) as THREE.MeshBasicMaterial
  ok(mat.map instanceof THREE.Texture, 'a supplied URL becomes a texture on the head')
  ok(mat.map !== null && mat.map.colorSpace === THREE.SRGBColorSpace, 'the photo is tagged sRGB')
  ok(matOf(part(withFace, 'head')) !== mat, 'and the head around the disc is still plain glass')

  withFace.setFaceImage(null)
  ok(mat.map === null && part(withFace, 'face').visible === false, 'clearing the URL puts the head back to plain glass')
  plain.dispose()
  withFace.dispose()
}

// ---------------------------------------------------------------------------
section('7. The networked pose eases toward its target instead of snapping')
// ---------------------------------------------------------------------------
{
  const camera = orbitCamera()
  const a = make('Ease', 0, 6)
  const base = Math.PI // seat 0 faces the centre at yaw 0, i.e. group.y = PI

  // Jump the target: a 30Hz update lands a new yaw and lean. The figure must
  // approach it smoothly over several frames, not teleport on the first.
  a.setPose({ seat: 0, yaw: 0.6, lean: 1 })
  const yaws: number[] = []
  const leans: number[] = []
  const figure = part(a, 'body').parent as THREE.Object3D
  for (let i = 0; i < 90; i++) {
    a.update(1 / 30, camera)
    yaws.push(a.group.rotation.y - base)
    leans.push(figure.rotation.x)
  }

  const firstStep = Math.abs(yaws[0])
  const total = Math.abs(0.6)
  ok(firstStep > 1e-4 && firstStep < total * 0.5, 'the first frame moves partway, not all the way', `${((firstStep / total) * 100).toFixed(0)}% of the way in one step`)

  // Monotone approach: each frame is at least as close to the target as the
  // last (a critically-damped ease never overshoots).
  let monotone = true
  for (let i = 1; i < yaws.length; i++) {
    if (Math.abs(0.6 - yaws[i]) > Math.abs(0.6 - yaws[i - 1]) + 1e-9) monotone = false
  }
  ok(monotone, 'it approaches the target without overshooting')

  // And it actually gets there.
  ok(Math.abs(0.6 - yaws[yaws.length - 1]) < 1e-3, 'yaw converges on the target', `settled at ${yaws[yaws.length - 1].toFixed(4)} of 0.6`)
  ok(Math.abs(leans[leans.length - 1] - leans[0]) > 0.01 && leans[leans.length - 1] > leans[0], 'lean eases in as well', `x ${leans[0].toFixed(4)} -> ${leans[leans.length - 1].toFixed(4)}`)
  console.log(`     yaw after 1 frame ${yaws[0].toFixed(4)}, after 90 ${yaws[yaws.length - 1].toFixed(4)} (target 0.6)`)

  // Frame-rate independence: the same elapsed time reaches the same place
  // whether it arrives in a few big steps or many small ones. This is the whole
  // reason for an exponential ease over a fixed per-frame lerp.
  const coarse = make('Coarse', 0, 6)
  const fine = make('Fine', 0, 6)
  coarse.setPose({ seat: 0, yaw: 0.5 })
  fine.setPose({ seat: 0, yaw: 0.5 })
  const T = 0.5
  for (let t = 0; t < T; t += 1 / 15) coarse.update(1 / 15, camera)
  for (let t = 0; t < T; t += 1 / 120) fine.update(1 / 120, camera)
  const diff = Math.abs(coarse.group.rotation.y - fine.group.rotation.y)
  ok(diff < 0.02, 'coarse and fine timesteps land in the same place', `${(diff * 1000).toFixed(2)} mrad apart after ${T}s`)

  // Re-seating is a hard cut, not an ease: a player does not slide around the
  // rail to a new chair.
  const mover = make('Mover', 0, 6)
  mover.update(1 / 60, camera)
  const p0 = mover.group.position.clone()
  mover.setPose({ seat: 3, yaw: 0 })
  mover.update(1 / 60, camera)
  const p1 = mover.group.position.clone()
  ok(p0.distanceTo(p1) > 0.1, 'moving to a new seat cuts straight there', `jumped ${(p0.distanceTo(p1) * 100).toFixed(0)}cm in one frame`)
  const expected = seatPosition(3, 6, TABLE_RADIUS, new THREE.Vector3())
  ok(p1.distanceTo(expected) < 1e-9, 'and lands exactly on the new seat')

  for (const x of [a, coarse, fine, mover]) x.dispose()
}

// ---------------------------------------------------------------------------
section('8. The glass look: layers, contour shell, and its shader injections')
// ---------------------------------------------------------------------------
{
  const a = make()

  // Draw order is the whole reason the layers composite: glass first, face
  // under the glaze, painted blooms over it, contour last.
  const order = (n: string): number => part(a, n).renderOrder
  ok(
    order('body') < order('head') &&
      order('head') < order('face') &&
      order('face') < order('headGloss') &&
      order('headGloss') < order('neckGlow') &&
      order('neckGlow') < order('headRim'),
    'render order runs glass -> face -> bloom -> contour',
    [order('body'), order('head'), order('face'), order('headGloss'), order('neckGlow'), order('headRim')].join(' < '),
  )
  ok(order('label') > order('headRim'), 'and the label is on top of everything')

  // The specular highlights: one big on the head, a smaller one on the body,
  // both additive so they survive any background.
  const headGloss = boxOf(part(a, 'headGloss'))
  const bodyGloss = boxOf(part(a, 'bodyGloss'))
  // The head highlight belongs on the crown, i.e. within roughly the top 60mm
  // of a 420mm figure, which is what sells the sphere as glass lit from above.
  ok(headGloss.max.y > AVATAR_HEIGHT - 0.06, 'the head highlight sits high on the crown', `top ${(headGloss.max.y * 1000).toFixed(0)}mm`)
  const glossMat = matOf(part(a, 'headGloss')) as THREE.MeshBasicMaterial
  ok(glossMat.blending === THREE.AdditiveBlending, 'highlights are additive so they read on any background')
  ok((headGloss.max.x - headGloss.min.x) > (bodyGloss.max.x - bodyGloss.min.x) * 0.3, 'both the head and body carry a highlight', `head ${((headGloss.max.x - headGloss.min.x) * 1000).toFixed(0)}mm, body ${((bodyGloss.max.x - bodyGloss.min.x) * 1000).toFixed(0)}mm`)

  // The contour shell stands proud of the glass all round — a line, not a halo.
  for (const [solid, shell] of [
    ['head', 'headRim'],
    ['body', 'bodyRim'],
  ] as const) {
    const s = boxOf(part(a, solid))
    const r = boxOf(part(a, shell))
    ok(
      r.min.x < s.min.x && r.max.x > s.max.x && r.min.z < s.min.z && r.max.z > s.max.z && r.max.y > s.max.y,
      `${shell} stands proud of ${solid} all round`,
      `+${((r.max.x - s.max.x) * 1000).toFixed(2)}mm`,
    )
    const grow = r.max.x - s.max.x
    ok(grow > 0.0008 && grow < 0.005, `${shell} is a line, not a halo`, `${(grow * 1000).toFixed(2)}mm`)
  }

  const rim = matOf(part(a, 'headRim')) as THREE.MeshBasicMaterial
  ok(rim.side === THREE.BackSide, 'the contour shell is rendered back-face only')
  ok(rim.transparent && !rim.depthWrite, 'and composites over the glass instead of occluding it')
  ok(matOf(part(a, 'bodyRim')) === rim, 'head and body share one contour material')

  // The two shader injections are string replaces into three's GLSL. If an
  // anchor is ever renamed the replace silently does nothing — the contour
  // stops being masked and every avatar turns into a dark blob, or the fresnel
  // glow just disappears. Run both against the real ShaderLib source and check
  // they took.
  const rimShaderObj = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms
  rim.onBeforeCompile!(rimShaderObj, null as unknown as THREE.WebGLRenderer)
  ok(rimShaderObj.vertexShader.includes('vRimN = normalize( normalMatrix * normal );'), 'the contour vertex anchor still exists in three')
  ok(rimShaderObj.fragmentShader.includes('diffuseColor.a *= 1.0 - smoothstep('), 'the contour fragment anchor still exists in three')

  const glass = matOf(part(a, 'body')) as THREE.MeshPhysicalMaterial
  const fresObj = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms
  glass.onBeforeCompile!(fresObj, null as unknown as THREE.WebGLRenderer)
  ok(fresObj.fragmentShader.includes('totalEmissiveRadiance += pow( fres'), 'the fresnel glow injects into the physical shader')
  ok(fresObj.vertexShader.split('varying vec3 vFresN;').length === 2, 'and declares its varying exactly once')

  // Shared function references, so three compiles each program once for the
  // whole table (its cache keys on onBeforeCompile.toString()).
  const b = make('Bea', 1, 6)
  ok((matOf(part(b, 'headRim')) as THREE.MeshBasicMaterial).onBeforeCompile === rim.onBeforeCompile, 'every player patches the contour with the same function')
  ok((matOf(part(b, 'body')) as THREE.MeshPhysicalMaterial).onBeforeCompile === glass.onBeforeCompile, 'and the glass fresnel with the same function')
  a.dispose()
  b.dispose()
}

// ---------------------------------------------------------------------------
section('9. Colours: a MSN-ish palette, per-player, that never leaks')
// ---------------------------------------------------------------------------
{
  ok(AVATAR_COLOURS.length >= 6, 'the palette offers at least six hues', `${AVATAR_COLOURS.length}`)
  const seen = new Set<number>()
  const hsl = { h: 0, s: 0, l: 0 }
  const hues: number[] = []
  let minSat = 1
  for (const c of AVATAR_COLOURS) {
    const col = new THREE.Color(c)
    seen.add(col.getHex())
    col.getHSL(hsl)
    hues.push(hsl.h)
    minSat = Math.min(minSat, hsl.s)
  }
  ok(seen.size === AVATAR_COLOURS.length, 'the palette has no duplicates', `${seen.size} of ${AVATAR_COLOURS.length}`)
  ok(minSat > 0.5, 'and every hue is strongly saturated, as the buddy icons are', `min saturation ${minSat.toFixed(2)}`)
  let closest = 1
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const d = Math.abs(hues[i] - hues[j])
      closest = Math.min(closest, Math.min(d, 1 - d))
    }
  }
  ok(closest > 0.04, 'no two hues are near-identical', `closest pair ${(closest * 360).toFixed(0)}° apart`)
  ok(avatarColour(AVATAR_COLOURS.length) === avatarColour(0), 'the palette wraps for a seventh player')
  ok(avatarColour(-1) === avatarColour(AVATAR_COLOURS.length - 1), 'and does not fall off the front')

  // Four players get four distinct glasses and four distinct contours.
  const players = [0, 1, 2, 3].map((i) => new Avatar({ id: `c${i}`, nickname: `P${i}`, seat: i, seatCount: 4 }))
  const glasses = new Set(players.map((p) => (matOf(part(p, 'body')) as THREE.MeshPhysicalMaterial).color.getHex()))
  const rims = new Set(players.map((p) => (matOf(part(p, 'headRim')) as THREE.MeshBasicMaterial).color.getHex()))
  ok(glasses.size === 4, 'four players get four different glasses', `${glasses.size}`)
  ok(rims.size === 4, 'and four different contours', `${rims.size}`)

  // The contour is "the same hue, darker" — not black, and not the glass again.
  for (const p of players) {
    const g = { h: 0, s: 0, l: 0 }
    const r = { h: 0, s: 0, l: 0 }
    ;(matOf(part(p, 'body')) as THREE.MeshPhysicalMaterial).color.getHSL(g)
    ;(matOf(part(p, 'headRim')) as THREE.MeshBasicMaterial).color.getHSL(r)
    ok(Math.abs(g.h - r.h) < 1e-6 && r.l < g.l * 0.6 && r.s > 0.2, `the contour is the same hue, darker`, `L ${g.l.toFixed(2)} -> ${r.l.toFixed(2)}`)
  }

  // An explicit colour overrides the palette.
  const custom = new Avatar({ id: 'x', nickname: 'X', seat: 0, seatCount: 4, colour: '#ff0066' })
  const ch = { h: 0, s: 0, l: 0 }
  ;(matOf(part(custom, 'body')) as THREE.MeshPhysicalMaterial).color.getHSL(ch)
  const th = { h: 0, s: 0, l: 0 }
  new THREE.Color('#ff0066').getHSL(th)
  ok(Math.abs(ch.h - th.h) < 1e-6, 'an explicit colour reaches the glass', `hue ${(ch.h * 360).toFixed(0)}°`)

  for (const p of players) p.dispose()
  custom.dispose()
}

// ---------------------------------------------------------------------------
section('10. Six players share geometry; only the tinted bits are per-player')
// ---------------------------------------------------------------------------
{
  const players = Array.from({ length: 6 }, (_, i) => new Avatar({ id: `s${i}`, nickname: `P${i}`, seat: i, seatCount: 6 }))
  const first = players[0]

  for (const n of ['body', 'head', 'face', 'bodyGloss', 'headGloss', 'neckGlow', 'bodyRim', 'headRim', 'label']) {
    const shared = players.every((p) => part(p, n).geometry === part(first, n).geometry)
    ok(shared, `every player reuses the same "${n}" geometry`)
  }
  ok(part(first, 'label').geometry === part(first, 'neckGlow').geometry, 'both billboards are the same unit plane')

  for (const n of ['bodyGloss', 'headGloss', 'neckGlow']) {
    ok(players.every((p) => matOf(part(p, n)) === matOf(part(first, n))), `the white "${n}" material is shared`)
  }

  // Anything tinted is its own instance.
  const glasses = new Set(players.map((p) => matOf(part(p, 'body'))))
  const rims = new Set(players.map((p) => matOf(part(p, 'headRim'))))
  ok(glasses.size === 6, 'each player owns its glass material', `${glasses.size}`)
  ok(rims.size === 6, 'and its contour material', `${rims.size}`)

  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  for (const p of players) {
    p.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) geometries.add(m.geometry)
      if (m.material) materials.add(m.material as THREE.Material)
    })
  }
  console.log(`     6 players: ${geometries.size} geometries, ${materials.size} materials total`)
  ok(geometries.size <= 9, 'a full table never exceeds nine geometries', `${geometries.size}`)
  // Per player: glass, contour, face, label = 4. Plus the 3 shared white blooms.
  ok(materials.size <= 6 * 4 + 3, 'and allocates only the tinted materials per player', `${materials.size}`)

  for (const p of players) p.dispose()
}

// ---------------------------------------------------------------------------
section('11. Disposal frees the player, not the table')
// ---------------------------------------------------------------------------
{
  const scene = new THREE.Scene()
  const keep = make('Ada', 0, 6)
  const drop = make('Grace', 1, 6)
  scene.add(keep.group, drop.group)

  const sharedGeometry = part(drop, 'head').geometry
  const sharedGloss = matOf(part(drop, 'headGloss'))
  const disposed = new Set<string>()
  for (const m of [matOf(part(drop, 'body')), matOf(part(drop, 'headRim')), matOf(part(drop, 'face')), matOf(part(drop, 'label'))]) {
    m.addEventListener('dispose', () => disposed.add(m.uuid))
  }

  drop.dispose()
  ok(disposed.size === 4, "the player's own materials are released", `${disposed.size} of 4`)
  ok(drop.group.parent === null, 'and it leaves the scene')
  ok(scene.children.includes(keep.group), 'the other player stays')
  ok(part(keep, 'head').geometry === sharedGeometry, 'shared geometry is untouched')
  ok(matOf(part(keep, 'headGloss')) === sharedGloss, 'so is the shared highlight material')

  // The label texture is a per-player canvas texture; it must be freed too.
  const solo = make('Solo', 0, 4)
  const labelTex = (matOf(part(solo, 'label')) as THREE.MeshBasicMaterial).map!
  let texFreed = false
  labelTex.addEventListener('dispose', () => { texFreed = true })
  solo.dispose()
  ok(texFreed, "the player's nickname texture is freed with it")

  // Still usable afterward: dispose() must not have pulled anything out from
  // under the players that remain.
  keep.setNickname('Ada Lovelace')
  keep.setPose({ seat: 2, yaw: 0.1, lean: 0.5 })
  const cam = orbitCamera()
  keep.update(1 / 60, cam)
  ok((matOf(part(keep, 'body')) as THREE.MeshPhysicalMaterial).color.getHex() !== 0, 'and the survivor still renames and re-poses')
  keep.dispose()

  // Finally, tearing the shared resources down must not throw.
  let tore = true
  try {
    disposeSharedAvatarResources()
  } catch {
    tore = false
  }
  ok(tore, 'the shared geometry and textures tear down cleanly')
}

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
