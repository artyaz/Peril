import * as THREE from 'three'
import { Spring } from './spring'
import { World, BodyMode, qSlerp, type Body } from './physics'
import { createCardMesh, CARD_HALF, CARD_MASS } from './card'

/**
 * Peril — card table.
 *
 * The rule that shapes this file: nothing here decides where a card ends up.
 * There is no snapping, no alignment, no "drop onto table" branch. A card you
 * pick up stays a fully simulated rigid body the whole time, so it collides with
 * the felt and with other cards while you are still moving it, and when you let
 * go it simply keeps the velocity your cursor gave it. Where it lands, and at
 * what angle, is whatever the physics produces.
 */

// --- Table geometry, shared between the visuals and the solver ---------------
const TABLE_Y = 0
const TABLE_RADIUS = 0.62
const RIM_TUBE = 0.021
const RAIL_RADIUS = TABLE_RADIUS + 0.02 - RIM_TUBE
const RAIL_TOP = TABLE_Y + 0.018
const FLOOR_Y = TABLE_Y - 0.55

const NUM_CARDS = 7

// --- Renderer ---------------------------------------------------------------
const app = document.getElementById('app')!
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
// Shadows are re-rendered only on frames where something actually moved.
renderer.shadowMap.autoUpdate = false
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.15
renderer.outputColorSpace = THREE.SRGBColorSpace
app.appendChild(renderer.domElement)

// --- Scene ------------------------------------------------------------------
const scene = new THREE.Scene()
scene.background = new THREE.Color('#0b0b10')
scene.fog = new THREE.Fog('#0b0b10', 2.5, 10)

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 50)
scene.add(camera)

scene.add(new THREE.AmbientLight('#303048', 0.5))

const keyLight = new THREE.DirectionalLight('#fff4e0', 2.6)
keyLight.position.set(1.2, 3.5, 1.8)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(1536, 1536)
keyLight.shadow.camera.near = 0.5
keyLight.shadow.camera.far = 8
keyLight.shadow.camera.left = -0.9
keyLight.shadow.camera.right = 0.9
keyLight.shadow.camera.top = 0.9
keyLight.shadow.camera.bottom = -0.9
keyLight.shadow.radius = 4
keyLight.shadow.bias = -0.0002
scene.add(keyLight)

const fillLight = new THREE.DirectionalLight('#7888c8', 0.6)
fillLight.position.set(-2.5, 1.5, -1)
scene.add(fillLight)

const rimLight = new THREE.PointLight('#5868ff', 1.2, 5)
rimLight.position.set(0, 1.2, -1.8)
scene.add(rimLight)

const spotLight = new THREE.SpotLight('#ffe8c0', 1.5, 4, Math.PI / 5, 0.5, 1)
spotLight.position.set(0, 2.5, 0.5)
spotLight.target.position.set(0, TABLE_Y, 0)
scene.add(spotLight, spotLight.target)

// --- Table ------------------------------------------------------------------
const table = new THREE.Mesh(
  new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS + 0.04, 0.05, 64),
  new THREE.MeshStandardMaterial({ color: '#14352a', roughness: 0.88, metalness: 0.02 }),
)
table.position.y = TABLE_Y - 0.025
table.receiveShadow = true
scene.add(table)

const rim = new THREE.Mesh(
  new THREE.TorusGeometry(TABLE_RADIUS + 0.02, RIM_TUBE, 12, 64),
  new THREE.MeshStandardMaterial({ color: '#3a2410', roughness: 0.55, metalness: 0.08 }),
)
rim.rotation.x = -Math.PI / 2
rim.position.y = TABLE_Y
rim.castShadow = true
scene.add(rim)

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(10, 48),
  new THREE.MeshStandardMaterial({ color: '#08080c', roughness: 1, metalness: 0 }),
)
ground.rotation.x = -Math.PI / 2
ground.position.y = FLOOR_Y
ground.receiveShadow = true
scene.add(ground)

// --- Physics ----------------------------------------------------------------
const world = new World({
  surfaceY: TABLE_Y,
  radius: TABLE_RADIUS,
  railRadius: RAIL_RADIUS,
  railTopY: RAIL_TOP,
  floorY: FLOOR_Y,
})

interface Card {
  body: Body
  mesh: THREE.Mesh
  /** Whether this card currently belongs to the fan in front of the camera. */
  inHand: boolean
  /** Smoothed slot transform, kept in *camera space* so that orbiting the view
   *  moves the hand instantly while re-fanning still animates. */
  slotPos: THREE.Vector3
  slotQuat: THREE.Quaternion
  slotReady: boolean
}

const cards: Card[] = []

function spawnCard(): Card {
  const body = world.createCard(CARD_HALF, CARD_MASS)
  const mesh = createCardMesh()
  scene.add(mesh)
  const card: Card = {
    body,
    mesh,
    inHand: false,
    slotPos: new THREE.Vector3(),
    slotQuat: new THREE.Quaternion(),
    slotReady: false,
  }
  body.ref = card
  ;(mesh.userData as { card: Card }).card = card
  cards.push(card)
  return card
}

// --- The hand ---------------------------------------------------------------
//
// Cards in hand are kinematic: they are the one place a tidy arrangement is
// correct, because a fan in your hand *is* arranged. The moment you grab one it
// becomes a dynamic body at exactly its current transform, so there is no pop
// and no hand-off logic — from then on physics owns it entirely.

const HAND_PIVOT = new THREE.Vector3(0, -0.5, -0.36)
const HAND_RADIUS = 0.3
const HAND_ARC = 0.62

const _v = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()

function handAnchorWorld(out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, HAND_PIVOT.y + HAND_RADIUS, HAND_PIVOT.z).applyMatrix4(camera.matrixWorld)
}

function layoutHand(dt: number): void {
  const inHand = cards.filter((c) => c.inHand)
  const n = inHand.length
  const smoothing = 1 - Math.exp(-16 * dt)

  for (let i = 0; i < n; i++) {
    const card = inHand[i]
    const t = n === 1 ? 0 : i / (n - 1) - 0.5
    const angle = t * HAND_ARC

    // Target slot, in camera space.
    _v.set(
      HAND_PIVOT.x + Math.sin(angle) * HAND_RADIUS,
      HAND_PIVOT.y + Math.cos(angle) * HAND_RADIUS,
      HAND_PIVOT.z + i * 0.0012,
    )
    // Card local +Z is the face normal, and camera space +Z points at the
    // viewer, so an unrotated card already faces the player.
    _e.set(-0.22, 0, -angle)
    _q.setFromEuler(_e)

    if (!card.slotReady) {
      card.slotPos.copy(_v)
      card.slotQuat.copy(_q)
      card.slotReady = true
    } else {
      card.slotPos.lerp(_v, smoothing)
      card.slotQuat.slerp(_q, smoothing)
    }

    // Push the resolved transform into the body so a grab starts from exactly
    // what the player sees.
    const body = card.body
    _v.copy(card.slotPos).applyMatrix4(camera.matrixWorld)
    _q.copy(camera.quaternion).multiply(card.slotQuat)
    body.setTransform(_v.x, _v.y, _v.z, _q)
  }
}

// --- Deal -------------------------------------------------------------------
for (let i = 0; i < NUM_CARDS; i++) {
  const card = spawnCard()
  card.inHand = true
  card.body.mode = BodyMode.Held
}

// --- Camera orbit -----------------------------------------------------------
const camYaw = new Spring(0, 100, 14)
const camPitch = new Spring(0.62, 100, 14)
const camDist = new Spring(0.92, 100, 14)

// --- Input ------------------------------------------------------------------
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const cardMeshes: THREE.Object3D[] = []

let grabbed: Card | null = null
/** Distance from the camera to the grabbed point, along the view direction.
 *  Held constant while dragging, which is what makes mouse control of a 3D
 *  object feel natural; the wheel pushes it further away or pulls it closer. */
let grabDepth = 0
let orbiting = false
let pointerMoved = false
const downAt = { x: 0, y: 0 }
const lastAt = { x: 0, y: 0 }

const forward = new THREE.Vector3()
const grabTarget = new THREE.Vector3()
const anchor = new THREE.Vector3()

function updatePointer(e: PointerEvent): void {
  const r = renderer.domElement.getBoundingClientRect()
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1
}

function pickCard(): THREE.Intersection | null {
  raycaster.setFromCamera(pointer, camera)
  cardMeshes.length = 0
  for (const c of cards) cardMeshes.push(c.mesh)
  const hits = raycaster.intersectObjects(cardMeshes, false)
  return hits.length > 0 ? hits[0] : null
}

/** Where the cursor points, on the plane the card was grabbed on. */
function cursorTarget(out: THREE.Vector3): THREE.Vector3 {
  camera.getWorldDirection(forward)
  raycaster.setFromCamera(pointer, camera)
  const dir = raycaster.ray.direction
  const denom = dir.dot(forward)
  const t = denom > 1e-4 ? grabDepth / denom : grabDepth
  return out.copy(camera.position).addScaledVector(dir, t)
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  updatePointer(e)
  pointerMoved = false
  downAt.x = e.clientX
  downAt.y = e.clientY
  lastAt.x = e.clientX
  lastAt.y = e.clientY

  const hit = pickCard()
  if (hit) {
    const card = (hit.object as THREE.Mesh & { userData: { card?: Card } }).userData.card!
    grabbed = card
    camera.getWorldDirection(forward)
    grabDepth = _v.copy(hit.point).sub(camera.position).dot(forward)

    // Pinch exactly where the cursor touched the card. Because the grab pulls
    // that point rather than the centre, the card swings and hangs from it —
    // the tilt comes out of the physics, not from any assigned rotation.
    card.inHand = false
    card.slotReady = false
    world.beginGrab(card.body, { x: hit.point.x, y: hit.point.y, z: hit.point.z })
    renderer.domElement.style.cursor = 'grabbing'
    renderer.domElement.setPointerCapture(e.pointerId)
  } else {
    orbiting = true
  }
})

renderer.domElement.addEventListener('pointermove', (e) => {
  updatePointer(e)
  if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 4) pointerMoved = true

  if (grabbed) {
    world.updateGrab(grabbed.body, cursorTarget(grabTarget))
    return
  }

  if (orbiting && pointerMoved) {
    camYaw.center -= (e.clientX - lastAt.x) * 0.004
    camPitch.center = THREE.MathUtils.clamp(camPitch.center + (e.clientY - lastAt.y) * 0.003, 0.12, 1.32)
    lastAt.x = e.clientX
    lastAt.y = e.clientY
    return
  }

  renderer.domElement.style.cursor = pickCard() ? 'grab' : 'default'
})

function release(): void {
  if (grabbed) {
    const card = grabbed
    // Let go. The card keeps the velocity it built up following the cursor, so
    // the throw comes from how fast and which way you were actually moving.
    world.endGrab(card.body)

    // Only if the card never really left the hand does it go back to the fan.
    handAnchorWorld(anchor)
    const dx = card.body.p.x - anchor.x
    const dy = card.body.p.y - anchor.y
    const dz = card.body.p.z - anchor.z
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 0.16) {
      card.inHand = true
      card.body.mode = BodyMode.Held
    }
    grabbed = null
  }
  orbiting = false
  renderer.domElement.style.cursor = 'default'
}

renderer.domElement.addEventListener('pointerup', release)
renderer.domElement.addEventListener('pointercancel', release)

renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    if (grabbed) {
      // Push the card away or pull it closer while holding it.
      grabDepth = THREE.MathUtils.clamp(grabDepth + e.deltaY * 0.0004, 0.12, 2.0)
    } else {
      camDist.center = THREE.MathUtils.clamp(camDist.center + e.deltaY * 0.0006, 0.45, 1.8)
    }
  },
  { passive: false },
)

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

// --- Debug HUD --------------------------------------------------------------
const hud = document.createElement('div')
hud.style.cssText =
  'position:fixed;top:10px;left:10px;font:11px/1.5 ui-monospace,monospace;color:#8ff;' +
  'background:rgba(0,0,0,.45);padding:8px 10px;border-radius:6px;pointer-events:none;' +
  'white-space:pre;display:none'
document.body.appendChild(hud)
let hudOn = false
let fps = 60
window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') {
    hudOn = !hudOn
    hud.style.display = hudOn ? 'block' : 'none'
  }
})

// --- Render loop ------------------------------------------------------------
const clock = new THREE.Clock()
const rp = new THREE.Vector3()
const rq = new THREE.Quaternion()
const one = new THREE.Vector3(1, 1, 1)
const qa = { x: 0, y: 0, z: 0, w: 1 }

function animate(): void {
  requestAnimationFrame(animate)
  const dt = Math.min(clock.getDelta(), 1 / 15)
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.08

  // Camera first: the hand is defined relative to it.
  const yaw = camYaw.animate(dt)
  const pitch = camPitch.animate(dt)
  const dist = camDist.animate(dt)
  camera.position.set(
    Math.sin(yaw) * Math.cos(pitch) * dist,
    TABLE_Y + Math.sin(pitch) * dist,
    Math.cos(yaw) * Math.cos(pitch) * dist,
  )
  camera.lookAt(0, TABLE_Y + 0.01, 0)
  camera.updateMatrixWorld()

  layoutHand(dt)

  // Keep the grab target following the cursor even when the pointer is still,
  // so orbiting or zooming while holding a card behaves.
  if (grabbed) world.updateGrab(grabbed.body, cursorTarget(grabTarget))

  world.advance(dt)

  // Present. Dynamic bodies are interpolated between the last two physics
  // states, so motion stays smooth no matter how the display refresh lines up
  // with the fixed timestep.
  const alpha = world.alpha
  for (const card of cards) {
    const b = card.body
    if (b.mode === BodyMode.Held) {
      rp.set(b.p.x, b.p.y, b.p.z)
      rq.set(b.q.x, b.q.y, b.q.z, b.q.w)
    } else {
      rp.set(
        b.prevP.x + (b.p.x - b.prevP.x) * alpha,
        b.prevP.y + (b.p.y - b.prevP.y) * alpha,
        b.prevP.z + (b.p.z - b.prevP.z) * alpha,
      )
      qSlerp(qa, b.prevQ, b.q, alpha)
      rq.set(qa.x, qa.y, qa.z, qa.w)
    }
    card.mesh.matrix.compose(rp, rq, one)
    card.mesh.matrixWorldNeedsUpdate = true
  }

  // Only pay for shadows on frames where geometry actually moved.
  renderer.shadowMap.needsUpdate = world.stats.awake > 0 || grabbed !== null

  renderer.render(scene, camera)

  if (hudOn) {
    const info = renderer.info.render
    hud.textContent =
      `${fps.toFixed(0)} fps\n` +
      `cards      ${cards.length}  (hand ${cards.filter((c) => c.inHand).length})\n` +
      `awake      ${world.stats.awake}\n` +
      `contacts   ${world.stats.contacts}\n` +
      `substeps   ${world.stats.substeps}\n` +
      `physics    ${world.stats.stepMs.toFixed(2)} ms\n` +
      `draws      ${info.calls}\n` +
      `tick       ${world.tick}`
  }
}

animate()
