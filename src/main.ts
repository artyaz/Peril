import * as THREE from 'three'
import { Spring } from './spring'
import { World, BodyMode, TUNING, qSlerp, type Body } from './physics'
import { createCardMesh, setHighlight, Highlight, CARD_HALF, CARD_MASS, type HighlightValue } from './card'
import { angularVelocityTo, insertionIndexAt, makeRandom, planPlayThrow, spread } from './gameplay'
import { showPrompt, movePrompt, hidePrompt, showMarquee, hideMarquee } from './ui'

/**
 * Peril — card table.
 *
 * The rule that shapes this file: nothing here decides where a card ends up.
 * There is no snapping and no alignment. A card you pick up stays a fully
 * simulated rigid body the whole time, so it collides with the felt and with
 * other cards while you are still moving it, and when you let go it simply
 * keeps the velocity your cursor gave it.
 *
 * The keyboard actions follow the same rule. Playing a card onto another does
 * not place it — it throws it, on a solved ballistic arc with the spin needed to
 * turn face-up in flight, and lets the solver decide how it actually lands.
 */

// --- Table geometry, shared between the visuals and the solver ---------------
const TABLE_Y = 0
const TABLE_RADIUS = 0.62
const RIM_TUBE = 0.021
const RAIL_RADIUS = TABLE_RADIUS + 0.02 - RIM_TUBE
const RAIL_TOP = TABLE_Y + 0.018
const FLOOR_Y = TABLE_Y - 0.55

const NUM_CARDS = 7
/** A full deck, stacked face-down in the middle of the table. */
const DECK_SIZE = 52

// How long you must rest on a card before its action prompt appears...
const PROMPT_DELAY_MS = 340
// ...except just after you acted, when it is instant. Picking several cards up
// from different spots in a row should feel continuous, not gated four times.
const PROMPT_QUICK_MS = 1400

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
  /** Whether this card belongs to the fan in front of the camera. */
  inHand: boolean
  /** Position within the fan. The fan is drawn in this order, so reordering is
   *  just a renumbering. */
  handIndex: number
  /** Being drawn towards the hand under a grab constraint, not yet settled. */
  flying: boolean
  flyingFor: number
  flyFrom: THREE.Vector3
  /** Smoothed slot transform, kept in *camera space* so orbiting the view moves
   *  the hand instantly while re-fanning still animates. */
  slotPos: THREE.Vector3
  slotQuat: THREE.Quaternion
  slotReady: boolean
  /** Resolved world-space slot, reused as the flight target. */
  slotWorldPos: THREE.Vector3
  slotWorldQuat: THREE.Quaternion
  highlight: HighlightValue
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
    handIndex: cards.length,
    flying: false,
    flyingFor: 0,
    flyFrom: new THREE.Vector3(),
    slotPos: new THREE.Vector3(),
    slotQuat: new THREE.Quaternion(),
    slotReady: false,
    slotWorldPos: new THREE.Vector3(),
    slotWorldQuat: new THREE.Quaternion(),
    highlight: Highlight.None,
  }
  body.ref = card
  ;(mesh.userData as { card: Card }).card = card
  cards.push(card)
  return card
}

function applyHighlight(card: Card, level: HighlightValue): void {
  if (card.highlight === level) return
  card.highlight = level
  setHighlight(card.mesh, level)
}

// --- The hand ---------------------------------------------------------------
//
// Cards in hand are kinematic: this is the one place a tidy arrangement is
// correct, because a fan in your hand *is* arranged. The moment you grab one it
// becomes a dynamic body at exactly its current transform, so there is no pop
// and no hand-off logic — from then on physics owns it entirely.

// Sits just inside the bottom of the frame. At the fan's distance the visible
// half-height is only ~0.187, so the previous pivot put the whole fan below the
// edge of the screen.
const HAND_PIVOT = new THREE.Vector3(0, -0.43, -0.36)
const HAND_RADIUS = 0.3
const HAND_ARC_MAX = 0.82
/**
 * How much the fan sags towards its ends. A true circular arc drops the outer
 * cards far enough that their bottom corners fall off the screen; flattening the
 * curve keeps the whole fan in frame while still reading as a fan.
 */
const HAND_DROOP = 0.45
/**
 * The fan occupies roughly the bottom quarter of the screen, so "over the hand"
 * is a screen-space band rather than a sphere in the world. A world-space zone
 * around the hand looks equivalent and is not: the near rim of the table passes
 * within 24cm of the hand anchor at the default camera angle, and closer still
 * at a low one, so dropping a card on the near edge would snatch it back into
 * the fan.
 */
const HAND_BAND = 0.72

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _inverseView = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _w = { x: 0, y: 0, z: 0 }

/** A gap held open in the fan while a card is being dragged back into it. */
let reorderSlot: number | null = null

function handCards(): Card[] {
  return cards.filter((c) => c.inHand).sort((a, b) => a.handIndex - b.handIndex)
}

function fanArc(total: number): number {
  return Math.min(HAND_ARC_MAX, Math.max(1, total) * 0.12)
}

function slotTransform(i: number, total: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
  const arc = fanArc(total)
  const t = total <= 1 ? 0 : i / (total - 1) - 0.5
  const angle = t * arc
  outPos.set(
    HAND_PIVOT.x + Math.sin(angle) * HAND_RADIUS,
    HAND_PIVOT.y + HAND_RADIUS - (1 - Math.cos(angle)) * HAND_RADIUS * HAND_DROOP,
    HAND_PIVOT.z + i * 0.0012,
  )
  // Card local +Z is the face normal and camera space +Z points at the viewer,
  // so an unrotated card already faces the player.
  _e.set(-0.22, 0, -angle)
  outQuat.setFromEuler(_e)
}

/** Is the cursor down in the band of screen the fan occupies? */
function cursorOverHand(): boolean {
  return clientPos.y > renderer.domElement.clientHeight * HAND_BAND
}

function layoutHand(dt: number): void {
  const list = handCards()
  const total = list.length + (reorderSlot !== null ? 1 : 0)
  const smoothing = 1 - Math.exp(-16 * dt)

  let slot = 0
  for (const card of list) {
    // Step over the gap being held for the card currently being dragged back.
    if (reorderSlot !== null && slot === reorderSlot) slot++

    slotTransform(slot, total, _v, _q)
    if (!card.slotReady) {
      card.slotPos.copy(_v)
      card.slotQuat.copy(_q)
      card.slotReady = true
    } else {
      card.slotPos.lerp(_v, smoothing)
      card.slotQuat.slerp(_q, smoothing)
    }

    card.slotWorldPos.copy(card.slotPos).applyMatrix4(camera.matrixWorld)
    card.slotWorldQuat.copy(camera.quaternion).multiply(card.slotQuat)

    if (card.flying) {
      // Still on its way in: keep hauling it towards the slot.
      updateFlight(card, dt)
    } else {
      // Push the resolved transform into the body so a grab starts from exactly
      // what the player sees.
      const p = card.slotWorldPos
      card.body.setTransform(p.x, p.y, p.z, card.slotWorldQuat)
    }
    slot++
  }
}

/**
 * Drive a card that is flying into the hand after being taken.
 *
 * The grab target is walked from where the card was picked up to its slot over
 * FLIGHT_TIME rather than being set to the slot outright. Aimed straight at the
 * slot, the constraint saturates at its speed limit and the card covers half the
 * table in a tenth of a second — correct, but far too fast to read as a card
 * flying to your hand. Moving the target keeps the motion legible while the
 * physics still supplies the momentum, lag and slight overshoot.
 */
const FLIGHT_TIME = 0.34

function updateFlight(card: Card, dt: number): void {
  const body = card.body
  card.flyingFor += dt

  const t = Math.min(card.flyingFor / FLIGHT_TIME, 1)
  const ease = t * t * (3 - 2 * t)
  _v.lerpVectors(card.flyFrom, card.slotWorldPos, ease)
  world.updateGrab(body, _v)

  // Turn it to match its slot on the way in, rather than snapping on arrival.
  angularVelocityTo(body.q, card.slotWorldQuat, Math.max(FLIGHT_TIME - card.flyingFor, 0.08), _w)
  body.w.x = _w.x
  body.w.y = _w.y
  body.w.z = _w.z

  const dx = body.p.x - card.slotWorldPos.x
  const dy = body.p.y - card.slotWorldPos.y
  const dz = body.p.z - card.slotWorldPos.z
  const arrived = t >= 1 && dx * dx + dy * dy + dz * dz < 0.025 * 0.025
  if (arrived || card.flyingFor > FLIGHT_TIME + 0.9) {
    card.flying = false
    card.flyingFor = 0
    body.mode = BodyMode.Held
  }
}

/** Insert `card` into the fan at `slot`, renumbering the rest around it. */
function insertIntoHand(card: Card, slot: number): void {
  const list = handCards()
  const at = Math.max(0, Math.min(list.length, slot))
  list.splice(at, 0, card)
  for (let i = 0; i < list.length; i++) list[i].handIndex = i
  card.inHand = true
}

// --- Deal -------------------------------------------------------------------
for (let i = 0; i < NUM_CARDS; i++) {
  const card = spawnCard()
  card.inHand = true
  card.handIndex = i
  card.body.mode = BodyMode.Held
}

/**
 * The deck. Spawned already stacked and already asleep.
 *
 * Placed at its exact resting transform rather than dropped: fifty-two bodies
 * released together all accelerate before any contact impulse has built, and the
 * stack folds into itself before it can catch. Starting it settled skips that
 * entirely, and a sleeping body is infinite mass, so an untouched deck is
 * genuinely rigid — which is what makes cards land on it rather than in it.
 */
const deckRandom = makeRandom(20260802)
for (let i = 0; i < DECK_SIZE; i++) {
  const card = spawnCard()
  // Backs up, with a touch of yaw so it looks handled rather than machined.
  _e.set(Math.PI / 2, spread(deckRandom) * 0.025, 0, 'YXZ')
  _q.setFromEuler(_e)
  card.body.setTransform(
    spread(deckRandom) * 0.0004,
    CARD_HALF.z + i * CARD_HALF.z * 2,
    spread(deckRandom) * 0.0004,
    _q,
  )
  card.body.sleep()
}

// --- Camera orbit -----------------------------------------------------------
const camYaw = new Spring(0, 100, 14)
const camPitch = new Spring(0.62, 100, 14)
const camDist = new Spring(0.92, 100, 14)

// --- Input state ------------------------------------------------------------
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const clientPos = { x: 0, y: 0 }
const pickList: THREE.Object3D[] = []

let grabbed: Card | null = null
/** Distance from the camera to the grabbed point, along the view direction.
 *  Held constant while dragging, which is what makes mouse control of a 3D
 *  object feel natural; the wheel pushes it away or pulls it closer. */
let grabDepth = 0
let orbiting = false
let pointerMoved = false
let pointerDown = false
const downAt = { x: 0, y: 0 }
const lastAt = { x: 0, y: 0 }

const forward = new THREE.Vector3()
const grabTarget = new THREE.Vector3()
const anchor = new THREE.Vector3()

// Hover / prompt
let hoverCard: Card | null = null
let hoverSince = 0
/** The action available right now. Live the instant a target is hovered. */
let hoverAction: 'X' | 'Z' | null = null
/** Whether the prompt for it is actually on screen, which lags behind. */
let promptAction: 'X' | 'Z' | null = null
let quickUntil = 0

// Group selection
let cHeld = false
let marqueeActive = false
const marqueeFrom = { x: 0, y: 0 }
let selection: Card[] = []
let groupHeld: Card[] = []
let groupDepth = 0

let throwSeed = 1

function updatePointer(e: PointerEvent): void {
  const r = renderer.domElement.getBoundingClientRect()
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1
  clientPos.x = e.clientX
  clientPos.y = e.clientY
}

/** Nearest card under the cursor, ignoring any the player is already holding. */
function pickCard(exclude: Card | null): THREE.Intersection | null {
  raycaster.setFromCamera(pointer, camera)
  pickList.length = 0
  for (const c of cards) {
    if (c === exclude || c.flying) continue
    pickList.push(c.mesh)
  }
  const hits = raycaster.intersectObjects(pickList, false)
  return hits.length > 0 ? hits[0] : null
}

function cardOf(hit: THREE.Intersection): Card {
  return (hit.object as THREE.Mesh & { userData: { card: Card } }).userData.card
}

/** Where the cursor points, on the plane the card was grabbed on. */
function cursorTarget(depth: number, out: THREE.Vector3): THREE.Vector3 {
  camera.getWorldDirection(forward)
  raycaster.setFromCamera(pointer, camera)
  const dir = raycaster.ray.direction
  const denom = dir.dot(forward)
  const t = denom > 1e-4 ? depth / denom : depth
  return out.copy(camera.position).addScaledVector(dir, t)
}

// --- Actions ----------------------------------------------------------------

/**
 * Play the held card onto `target`: a solved ballistic arc, plus the spin that
 * turns it face-up before it lands, plus scatter so no two plays look alike.
 * Nothing steers it once released, and nothing places it — the solver decides
 * where it comes to rest.
 */
function playOnto(target: Card): void {
  const card = grabbed
  if (!card) return

  world.endGrab(card.body)
  grabbed = null
  card.inHand = false
  reorderSlot = null

  const rand = makeRandom((throwSeed = (throwSeed * 1103515245 + 12345) | 0))
  const body = card.body
  planPlayThrow(body.p, body.q, target.body.p, target.body.q, TUNING.gravity, rand, body.v, body.w)

  body.wake()
  quickUntil = performance.now() + PROMPT_QUICK_MS
  clearHover()
}

/** Take a card off the table; it flies into the fan under a grab constraint. */
function takeCard(card: Card): void {
  if (card.inHand || card.flying) return
  card.flying = true
  card.flyingFor = 0
  card.flyFrom.set(card.body.p.x, card.body.p.y, card.body.p.z)
  card.slotReady = false
  insertIntoHand(card, handCards().length)
  // Pinch the centre so it travels level instead of tumbling from a corner.
  world.beginGrab(card.body, card.body.p)
  quickUntil = performance.now() + PROMPT_QUICK_MS
  clearHover()
}

function clearHover(): void {
  if (hoverCard) applyHighlight(hoverCard, Highlight.None)
  hoverCard = null
  hoverAction = null
  promptAction = null
  hidePrompt()
}

// --- Group selection --------------------------------------------------------

const _proj = new THREE.Vector3()

function screenOf(card: Card, out: THREE.Vector3): THREE.Vector3 {
  out.set(card.body.p.x, card.body.p.y, card.body.p.z).project(camera)
  const r = renderer.domElement.getBoundingClientRect()
  out.x = r.left + ((out.x + 1) / 2) * r.width
  out.y = r.top + ((1 - out.y) / 2) * r.height
  return out
}

function updateSelection(): void {
  const x0 = Math.min(marqueeFrom.x, clientPos.x)
  const x1 = Math.max(marqueeFrom.x, clientPos.x)
  const y0 = Math.min(marqueeFrom.y, clientPos.y)
  const y1 = Math.max(marqueeFrom.y, clientPos.y)

  for (const c of selection) applyHighlight(c, Highlight.None)
  selection = []
  for (const c of cards) {
    if (c.inHand || c.flying) continue
    screenOf(c, _proj)
    if (_proj.x >= x0 && _proj.x <= x1 && _proj.y >= y0 && _proj.y <= y1) {
      selection.push(c)
      applyHighlight(c, Highlight.Pick)
    }
  }
}

/** Gather the marquee selection into the cursor's grip. */
function gatherSelection(): void {
  if (selection.length === 0) return
  camera.getWorldDirection(forward)

  let cx = 0
  let cy = 0
  let cz = 0
  for (const c of selection) {
    cx += c.body.p.x
    cy += c.body.p.y
    cz += c.body.p.z
  }
  cx /= selection.length
  cy /= selection.length
  cz /= selection.length
  groupDepth = THREE.MathUtils.clamp(
    _v.set(cx, cy, cz).sub(camera.position).dot(forward),
    0.22,
    1.2,
  )

  groupHeld = selection.slice()
  selection = []
  for (const c of groupHeld) {
    applyHighlight(c, Highlight.None)
    world.beginGrab(c.body, c.body.p)
  }
}

/** Hold the gathered cards in a loose clump around the cursor. */
function updateGroupTargets(): void {
  if (groupHeld.length === 0) return
  cursorTarget(groupDepth, grabTarget)
  const right = _v.set(1, 0, 0).applyQuaternion(camera.quaternion)
  const up = _v2.set(0, 1, 0).applyQuaternion(camera.quaternion)

  for (let i = 0; i < groupHeld.length; i++) {
    // Golden-angle spiral: a tight bunch that does not put two cards on the
    // exact same target, which would just make them fight.
    const a = i * 2.39996
    const r = 0.009 * Math.sqrt(i)
    const ox = Math.cos(a) * r
    const oy = Math.sin(a) * r + i * 0.0022
    world.updateGrab(groupHeld[i].body, {
      x: grabTarget.x + right.x * ox + up.x * oy,
      y: grabTarget.y + right.y * ox + up.y * oy,
      z: grabTarget.z + right.z * ox + up.z * oy,
    })
  }
}

function releaseGroup(): void {
  for (const c of groupHeld) world.endGrab(c.body)
  groupHeld = []
}

function cancelMarquee(): void {
  marqueeActive = false
  hideMarquee()
  for (const c of selection) applyHighlight(c, Highlight.None)
  selection = []
}

// --- Pointer events ---------------------------------------------------------

renderer.domElement.addEventListener('pointerdown', (e) => {
  updatePointer(e)
  pointerMoved = false
  pointerDown = true
  downAt.x = e.clientX
  downAt.y = e.clientY
  lastAt.x = e.clientX
  lastAt.y = e.clientY
  renderer.domElement.setPointerCapture(e.pointerId)

  if (cHeld) {
    marqueeActive = true
    marqueeFrom.x = e.clientX
    marqueeFrom.y = e.clientY
    showMarquee(e.clientX, e.clientY, e.clientX, e.clientY)
    clearHover()
    return
  }

  const hit = pickCard(null)
  if (hit) {
    const card = cardOf(hit)
    if (card.flying) return
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
  } else {
    orbiting = true
  }
})

renderer.domElement.addEventListener('pointermove', (e) => {
  updatePointer(e)
  if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 4) pointerMoved = true
  movePrompt(e.clientX, e.clientY)

  if (marqueeActive) {
    showMarquee(marqueeFrom.x, marqueeFrom.y, e.clientX, e.clientY)
    updateSelection()
    return
  }

  if (groupHeld.length > 0) return

  if (grabbed) {
    world.updateGrab(grabbed.body, cursorTarget(grabDepth, grabTarget))
    return
  }

  if (orbiting && pointerMoved) {
    camYaw.center -= (e.clientX - lastAt.x) * 0.004
    camPitch.center = THREE.MathUtils.clamp(camPitch.center + (e.clientY - lastAt.y) * 0.003, 0.12, 1.32)
    lastAt.x = e.clientX
    lastAt.y = e.clientY
  }
})

function release(): void {
  pointerDown = false

  if (marqueeActive) {
    // Letting go of the mouse before C abandons the selection.
    cancelMarquee()
  } else if (groupHeld.length > 0) {
    releaseGroup()
  } else if (grabbed) {
    const card = grabbed
    // Let go. The card keeps the velocity it built up following the cursor, so
    // the throw comes from how fast and which way you were actually moving.
    world.endGrab(card.body)

    // Released over the hand? Slot it in wherever the fan opened a gap.
    if (cursorOverHand()) {
      insertIntoHand(card, reorderSlot ?? handCards().length)
      card.body.mode = BodyMode.Held
    }
    grabbed = null
  }

  reorderSlot = null
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
      grabDepth = THREE.MathUtils.clamp(grabDepth + e.deltaY * 0.0004, 0.12, 2.0)
    } else if (groupHeld.length > 0) {
      groupDepth = THREE.MathUtils.clamp(groupDepth + e.deltaY * 0.0004, 0.12, 2.0)
    } else {
      camDist.center = THREE.MathUtils.clamp(camDist.center + e.deltaY * 0.0006, 0.45, 1.8)
    }
  },
  { passive: false },
)

// --- Debug HUD --------------------------------------------------------------
const hud = document.createElement('div')
hud.style.cssText =
  'position:fixed;top:10px;left:10px;font:11px/1.5 ui-monospace,monospace;color:#8ff;' +
  'background:rgba(0,0,0,.45);padding:8px 10px;border-radius:6px;pointer-events:none;' +
  'white-space:pre;display:none;z-index:10'
document.body.appendChild(hud)
let fps = 60

// --- Keyboard ---------------------------------------------------------------

let hudOn = false

window.addEventListener('keydown', (e) => {
  if (e.repeat) return
  const k = e.key.toLowerCase()

  if (k === 'c' && !cHeld) {
    cHeld = true
    if (!grabbed && groupHeld.length === 0) {
      renderer.domElement.style.cursor = 'crosshair'
      clearHover()
    }
    return
  }
  // Keyed off the live action, not the prompt: the delay exists to stop the
  // hint flickering, not to make a player who already knows the key wait.
  if (k === 'x' && hoverAction === 'X' && hoverCard) {
    playOnto(hoverCard)
    return
  }
  if (k === 'z' && hoverAction === 'Z' && hoverCard) {
    takeCard(hoverCard)
    return
  }
  if (k === 'h') {
    hudOn = !hudOn
    hud.style.display = hudOn ? 'block' : 'none'
  }
})

window.addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() !== 'c') return
  cHeld = false
  if (marqueeActive) {
    marqueeActive = false
    hideMarquee()
    // Mouse still down: the selection comes with you. Mouse already released:
    // there is nothing to carry it.
    if (pointerDown) gatherSelection()
    else cancelMarquee()
  }
  if (groupHeld.length === 0 && !grabbed) renderer.domElement.style.cursor = 'default'
})

window.addEventListener('blur', () => {
  cHeld = false
  if (marqueeActive) cancelMarquee()
})

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

// --- Hover and prompts ------------------------------------------------------

function updateHover(nowMs: number): void {
  if (marqueeActive || groupHeld.length > 0) {
    clearHover()
    return
  }

  const hit = pickCard(grabbed)
  const under = hit ? cardOf(hit) : null

  // Holding a card: the action is to play it onto whatever is underneath.
  // Empty-handed: the action is to take the card you are pointing at.
  let candidate: Card | null = null
  let action: 'X' | 'Z' | null = null
  if (under && !under.inHand && !under.flying) {
    if (grabbed) {
      candidate = under
      action = 'X'
    } else if (!orbiting) {
      candidate = under
      action = 'Z'
    }
  }

  if (candidate !== hoverCard) {
    if (hoverCard) applyHighlight(hoverCard, Highlight.None)
    hoverCard = candidate
    hoverSince = nowMs
    promptAction = null
    hidePrompt()
  }
  hoverAction = action
  if (!hoverCard || !action) return

  // The highlight and the hint wait; the key itself does not.
  const delay = nowMs < quickUntil ? 0 : PROMPT_DELAY_MS
  if (nowMs - hoverSince < delay) return

  if (promptAction !== action) {
    promptAction = action
    applyHighlight(hoverCard, action === 'X' ? Highlight.Target : Highlight.Pick)
    showPrompt(
      action,
      action === 'X' ? 'play onto this card' : 'take this card',
      clientPos.x,
      clientPos.y,
    )
  }
}

/** Keep a gap open in the fan while a card is dragged back over the hand. */
function updateReorder(): void {
  if (!grabbed || !cursorOverHand()) {
    reorderSlot = null
    return
  }
  // Compare the cursor against where the other cards actually sit on screen,
  // exactly like dragging a row into place in a list.
  const xs: number[] = []
  for (const c of handCards()) xs.push(screenOf(c, _proj).x)
  reorderSlot = insertionIndexAt(clientPos.x, xs)
}

// --- Render loop ------------------------------------------------------------
const clock = new THREE.Clock()
const rp = new THREE.Vector3()
const rq = new THREE.Quaternion()
const one = new THREE.Vector3(1, 1, 1)
const qa = { x: 0, y: 0, z: 0, w: 1 }

function animate(): void {
  requestAnimationFrame(animate)
  const dt = Math.min(clock.getDelta(), 1 / 15)
  const nowMs = performance.now()
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
  _inverseView.copy(camera.matrixWorld).invert()

  updateReorder()
  layoutHand(dt)

  // Keep targets tracking even when the pointer is still, so orbiting or
  // zooming while holding cards behaves.
  if (grabbed) world.updateGrab(grabbed.body, cursorTarget(grabDepth, grabTarget))
  updateGroupTargets()

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
    // Cards are direct children of the scene, so the world matrix is the local
    // one. Writing it here rather than leaving it to the renderer means the
    // hover raycast below tests against this frame's positions instead of the
    // previous frame's.
    card.mesh.matrixWorld.copy(card.mesh.matrix)
    card.mesh.matrixWorldNeedsUpdate = false
  }

  updateHover(nowMs)

  // Only pay for shadows on frames where geometry actually moved.
  renderer.shadowMap.needsUpdate = world.stats.awake > 0 || grabbed !== null || groupHeld.length > 0

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
      `selected   ${selection.length}  held ${groupHeld.length}\n` +
      `tick       ${world.tick}`
  }
}

animate()
