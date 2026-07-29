import * as THREE from 'three'
import { Spring } from './spring'
import { createCard, updateCardMotion, type CardMesh } from './card'

// --- Layout constants (meters) ---
const TABLE_Y = 0.0
const TABLE_RADIUS = 0.62
const TABLE_SURFACE = TABLE_Y + 0.001
const HAND_FAN_RADIUS = 0.34
const HAND_Y_OFFSET = -0.24
const HAND_Z_OFFSET = -0.4
const DRAG_LIFT = 0.07
const NUM_CARDS = 7

// --- Renderer ---
const app = document.getElementById('app')!
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.15
renderer.outputColorSpace = THREE.SRGBColorSpace
app.appendChild(renderer.domElement)

// --- Scene ---
const scene = new THREE.Scene()
scene.background = new THREE.Color('#0b0b10')
scene.fog = new THREE.Fog('#0b0b10', 2.5, 10)

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 50)
scene.add(camera)

// --- Lighting (bold, dramatic) ---
scene.add(new THREE.AmbientLight('#303048', 0.5))

const keyLight = new THREE.DirectionalLight('#fff4e0', 2.6)
keyLight.position.set(1.2, 3.5, 1.8)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(2048, 2048)
keyLight.shadow.camera.near = 0.5
keyLight.shadow.camera.far = 10
keyLight.shadow.camera.left = -1.5
keyLight.shadow.camera.right = 1.5
keyLight.shadow.camera.top = 1.5
keyLight.shadow.camera.bottom = -1.5
keyLight.shadow.radius = 5
keyLight.shadow.bias = -0.0003
scene.add(keyLight)

const fillLight = new THREE.DirectionalLight('#7888c8', 0.6)
fillLight.position.set(-2.5, 1.5, -1)
scene.add(fillLight)

const rimLight = new THREE.PointLight('#5868ff', 1.2, 5)
rimLight.position.set(0, 1.2, -1.8)
scene.add(rimLight)

// Warm spot from above the table for card highlights
const spotLight = new THREE.SpotLight('#ffe8c0', 1.5, 4, Math.PI / 5, 0.5, 1)
spotLight.position.set(0, 2.5, 0.5)
spotLight.target.position.set(0, TABLE_Y, 0)
scene.add(spotLight)
scene.add(spotLight.target)

// --- Table ---
const tableGeo = new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS + 0.04, 0.05, 64)
const tableMat = new THREE.MeshStandardMaterial({
  color: '#14352a',
  roughness: 0.88,
  metalness: 0.02,
})
const table = new THREE.Mesh(tableGeo, tableMat)
table.position.y = TABLE_Y - 0.025
table.receiveShadow = true
table.castShadow = true
scene.add(table)

// Wooden rim
const rimGeo = new THREE.TorusGeometry(TABLE_RADIUS + 0.02, 0.022, 16, 64)
const rimMat = new THREE.MeshStandardMaterial({ color: '#3a2410', roughness: 0.55, metalness: 0.08 })
const rimMesh = new THREE.Mesh(rimGeo, rimMat)
rimMesh.rotation.x = -Math.PI / 2
rimMesh.position.y = TABLE_Y
rimMesh.castShadow = true
scene.add(rimMesh)

// Ground
const groundGeo = new THREE.CircleGeometry(10, 64)
const groundMat = new THREE.MeshStandardMaterial({ color: '#08080c', roughness: 1, metalness: 0 })
const ground = new THREE.Mesh(groundGeo, groundMat)
ground.rotation.x = -Math.PI / 2
ground.position.y = TABLE_Y - 0.6
ground.receiveShadow = true
scene.add(ground)

// --- Hand group (camera-attached, VR-style) ---
const handGroup = new THREE.Group()
camera.add(handGroup)
handGroup.position.set(0, HAND_Y_OFFSET, HAND_Z_OFFSET)
handGroup.rotation.x = 0.4

// --- Card collections ---
const handCards: CardMesh[] = []
const tableCards: CardMesh[] = []

function layoutHand() {
  const n = handCards.length
  if (n === 0) return
  const arcSpan = Math.min(0.75, n * 0.1)
  for (let i = 0; i < n; i++) {
    const card = handCards[i]
    if (card.userData.dragging) continue
    const t = n === 1 ? 0.5 : i / (n - 1)
    const angle = (t - 0.5) * arcSpan
    const x = Math.sin(angle) * HAND_FAN_RADIUS
    const z = -Math.cos(angle) * HAND_FAN_RADIUS + HAND_FAN_RADIUS
    card.userData.posX.center = x
    card.userData.posZ.center = z
    card.userData.baseRotY = -angle * 0.7
    card.userData.baseRotZ = -angle * 0.18
    card.userData.baseRotX = -0.12
    card.userData.baseY = 0
    card.userData.index = i
  }
}

function dealCards() {
  for (let i = 0; i < NUM_CARDS; i++) {
    const card = createCard()
    handGroup.add(card)
    handCards.push(card)
    // Staggered deal from above
    card.position.set((Math.random() - 0.5) * 0.08, 0.35 + i * 0.006, -0.15)
    card.rotation.set(-Math.PI / 2 + 0.3, (Math.random() - 0.5) * 0.2, 0)
    card.userData.lift.value = 0.35
    card.userData.lift.velocity = -2.0 - i * 0.4
    card.userData.baseRotX = -0.12
  }
  layoutHand()
}

dealCards()

// --- Interaction state ---
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const hitPoint = new THREE.Vector3()

let hoveredCard: CardMesh | null = null
let draggedCard: CardMesh | null = null
const dragOffset = new THREE.Vector3()
let pointerDown = false
let pointerMoved = false
let downPos = { x: 0, y: 0 }
let lastPointer = { x: 0, y: 0 }

// Camera orbit (spring-smoothed)
const camYaw = new Spring(0, 100, 14)
const camPitch = new Spring(0.6, 100, 14)
const camDist = new Spring(0.9, 100, 14)

function updatePointer(e: PointerEvent) {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
}

function getIntersectedCard(): CardMesh | null {
  raycaster.setFromCamera(pointer, camera)
  const all = [...handCards, ...tableCards]
  const meshes: THREE.Object3D[] = []
  for (const c of all) c.traverse((child) => meshes.push(child))
  const hits = raycaster.intersectObjects(meshes, false)
  if (hits.length === 0) return null
  let obj: THREE.Object3D | null = hits[0].object
  while (obj) {
    if (obj.userData && 'lift' in obj.userData && 'hovered' in obj.userData) {
      return obj as CardMesh
    }
    obj = obj.parent
  }
  return null
}

function onPointerDown(e: PointerEvent) {
  updatePointer(e)
  pointerDown = true
  pointerMoved = false
  downPos = { x: e.clientX, y: e.clientY }
  lastPointer = { x: e.clientX, y: e.clientY }

  const card = getIntersectedCard()
  if (card) {
    draggedCard = card
    card.userData.dragging = true
    card.userData.hovered = false
    renderer.domElement.style.cursor = 'grabbing'

    // Drag plane at lifted height
    const worldPos = new THREE.Vector3()
    card.getWorldPosition(worldPos)
    dragPlane.constant = -(worldPos.y + DRAG_LIFT)

    raycaster.setFromCamera(pointer, camera)
    raycaster.ray.intersectPlane(dragPlane, hitPoint)
    dragOffset.copy(worldPos).sub(hitPoint)
    dragOffset.y = 0
  }
}

function onPointerMove(e: PointerEvent) {
  updatePointer(e)

  if (Math.abs(e.clientX - downPos.x) + Math.abs(e.clientY - downPos.y) > 5) {
    pointerMoved = true
  }

  if (draggedCard && pointerDown) {
    raycaster.setFromCamera(pointer, camera)
    if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
      const target = hitPoint.clone().add(dragOffset)
      if (draggedCard.parent === handGroup) {
        handGroup.worldToLocal(target)
      }
      const ud = draggedCard.userData
      ud.posX.center = target.x
      ud.posY.center = target.y
      ud.posZ.center = target.z
      // Stiff follow while dragging
      ud.posX.stiffness = 600
      ud.posX.damping = 38
      ud.posY.stiffness = 600
      ud.posY.damping = 38
      ud.posZ.stiffness = 600
      ud.posZ.damping = 38
    }
    return
  }

  if (pointerDown && !draggedCard && pointerMoved) {
    // Orbit
    const dx = e.clientX - lastPointer.x
    const dy = e.clientY - lastPointer.y
    camYaw.center -= dx * 0.004
    camPitch.center = THREE.MathUtils.clamp(camPitch.center + dy * 0.003, 0.15, 1.3)
    lastPointer = { x: e.clientX, y: e.clientY }
    return
  }

  // Hover
  const card = getIntersectedCard()
  if (hoveredCard && hoveredCard !== card) {
    hoveredCard.userData.hovered = false
  }
  if (card && !card.userData.dragging) {
    card.userData.hovered = true
    hoveredCard = card
    renderer.domElement.style.cursor = 'grab'
  } else {
    hoveredCard = null
    renderer.domElement.style.cursor = 'default'
  }
}

function onPointerUp() {
  if (draggedCard) {
    const card = draggedCard
    const ud = card.userData
    ud.dragging = false
    // Relax springs for smooth settle
    ud.posX.stiffness = 260
    ud.posX.damping = 24
    ud.posY.stiffness = 260
    ud.posY.damping = 24
    ud.posZ.stiffness = 260
    ud.posZ.damping = 24

    const worldPos = new THREE.Vector3()
    card.getWorldPosition(worldPos)
    const distFromCenter = Math.hypot(worldPos.x, worldPos.z)

    if (worldPos.y < TABLE_Y + 0.2 && distFromCenter < TABLE_RADIUS * 0.88) {
      // Drop onto table
      if (card.parent === handGroup) {
        handGroup.remove(card)
        scene.add(card)
      }
      const dropY = TABLE_SURFACE + 0.002
      card.position.set(worldPos.x, dropY, worldPos.z)
      card.rotation.set(-Math.PI / 2, card.rotation.y, 0)
      ud.baseY = dropY
      ud.baseRotX = -Math.PI / 2
      ud.baseRotZ = 0
      ud.posX.set(worldPos.x)
      ud.posY.set(dropY)
      ud.posZ.set(worldPos.z)
      // Satisfying drop bounce
      ud.lift.value = 0.05
      ud.lift.velocity = -1.5
      if (!tableCards.includes(card)) {
        tableCards.push(card)
        const idx = handCards.indexOf(card)
        if (idx >= 0) handCards.splice(idx, 1)
      }
      layoutHand()
    } else {
      // Snap back to hand slot
      layoutHand()
    }
    draggedCard = null
  }
  pointerDown = false
  renderer.domElement.style.cursor = 'default'
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  camDist.center = THREE.MathUtils.clamp(camDist.center + e.deltaY * 0.0006, 0.45, 1.8)
}

renderer.domElement.addEventListener('pointerdown', onPointerDown)
renderer.domElement.addEventListener('pointermove', onPointerMove)
renderer.domElement.addEventListener('pointerup', onPointerUp)
renderer.domElement.addEventListener('pointercancel', onPointerUp)
renderer.domElement.addEventListener('wheel', onWheel, { passive: false })

// --- Resize ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

// --- Render loop ---
const clock = new THREE.Clock()

function animate() {
  requestAnimationFrame(animate)
  const dt = Math.min(clock.getDelta(), 1 / 30)

  // Smooth camera orbit
  const yaw = camYaw.animate(dt)
  const pitch = camPitch.animate(dt)
  const dist = camDist.animate(dt)
  camera.position.set(
    Math.sin(yaw) * Math.cos(pitch) * dist,
    TABLE_Y + Math.sin(pitch) * dist,
    Math.cos(yaw) * Math.cos(pitch) * dist,
  )
  camera.lookAt(0, TABLE_Y, 0)

  // Hand cards
  for (const card of handCards) {
    const ud = card.userData
    ud.posX.animate(dt)
    ud.posZ.animate(dt)
    if (ud.dragging) {
      ud.posY.animate(dt)
      card.position.set(ud.posX.value, ud.posY.value, ud.posZ.value)
    } else {
      card.position.x = ud.posX.value
      card.position.z = ud.posZ.value
      card.rotation.y = ud.baseRotY
      updateCardMotion(card, dt)
    }
  }

  // Table cards
  for (const card of tableCards) {
    updateCardMotion(card, dt)
  }

  renderer.render(scene, camera)
}

animate()
