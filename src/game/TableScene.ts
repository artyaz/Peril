import * as THREE from 'three'
import {
  createCard,
  updateCardMotion,
  dropCard,
  CARD_W,
  CARD_H,
  TABLE_CARD_Y,
  TABLE_FACE_UP_X,
  type CardMesh,
} from './cards'
import { createAvatar, type AvatarHandle } from './avatar'
import { Spring, TweenManager, easeOutBack, easeOutCubic } from '../lib/motion'
import type { RoomState, CardDrag } from '../lib/protocol'

export type TableSceneApi = {
  mount: (el: HTMLElement) => void
  unmount: () => void
  setState: (state: RoomState, localPlayerId: string) => void
  setPeerHover: (playerId: string, cardIndex: number | null, cardText?: string | null) => void
  setPeerDrag: (drag: CardDrag | null) => void
  onPlayCards: (cards: string[], positions: { x: number; z: number; rotY?: number }[]) => void
  onHoverCard: (index: number | null, text?: string | null) => void
  onDragCard: (drag: CardDrag | null) => void
  onMoveTableCard: (key: string, x: number, z: number, rotY?: number) => void
  onVote: (submissionPlayerId: string) => void
  lookCloser: (on: boolean) => void
  resize: () => void
}

type SeatLayout = { position: THREE.Vector3; yaw: number }

type LocalDrag = {
  source: 'hand' | 'table'
  card: CardMesh
  cardText: string
  cardKey?: string
  handIndex?: number
  pointerId: number
  startX: number
  startY: number
  moved: boolean
  rotY: number
  /** Smoothed follow target in the card's parent space */
  followX: Spring
  followY: Spring
  followZ: Spring
}

const TABLE_Y = 1.55
const TABLE_RADIUS = 0.52
const HAND_ZONE_Y = 0.58
const DRAG_BROADCAST_MS = 40
const CLICK_MOVE_PX = 6
/** Feet Y — keep heads + name pills inside the upper frame. */
const AVATAR_SIT_Y = TABLE_Y - 0.48
const DRAG_STIFF = 420
const DRAG_DAMP = 34
/** Local hand lives in camera space so framing never clips. */
const HAND_CAM_X = 0
const HAND_CAM_Y = -0.14
const HAND_CAM_Z = -0.48
const FOV_HAND = 60
const FOV_TABLE = 52

export function createTableScene(): TableSceneApi {
  let threeRenderer: THREE.WebGLRenderer | null = null
  let scene: THREE.Scene | null = null
  let camera: THREE.PerspectiveCamera | null = null
  let raf = 0
  let root: HTMLElement | null = null
  const clock = new THREE.Clock()
  const tweens = new TweenManager()

  const avatars = new Map<string, AvatarHandle>()
  const peerHands = new Map<string, CardMesh[]>()
  const peerHoverText = new Map<string, string | null>()
  let handCards: CardMesh[] = []
  let tableCards: CardMesh[] = []
  let blackCard: CardMesh | null = null
  let ghostCard: CardMesh | null = null
  let localId = ''
  let room: RoomState | null = null
  let hoveredIndex: number | null = null
  let selected = new Set<string>()
  let peerHover = new Map<string, number | null>()
  let lookClose = false
  const camBlend = new Spring(0, 220, 28)
  const camPanX = new Spring(0, 160, 22)
  const camPanZ = new Spring(0, 160, 22)
  let pointerNdc = { x: 0, y: 0 }
  let pointerScreenY = 0.72
  let playCb: (cards: string[], positions: { x: number; z: number; rotY?: number }[]) => void =
    () => {}
  let hoverCb: (i: number | null, text?: string | null) => void = () => {}
  let dragCb: (drag: CardDrag | null) => void = () => {}
  let moveTableCb: (key: string, x: number, z: number, rotY?: number) => void = () => {}
  let voteCb: (id: string) => void = () => {}

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const tablePlane = new THREE.Plane(
    new THREE.Vector3(0, 1, 0),
    -(TABLE_Y + TABLE_CARD_Y + 0.01),
  )
  const handPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  const hitPoint = new THREE.Vector3()
  let tableGroup: THREE.Group | null = null
  let handGroup: THREE.Group | null = null
  let worldGroup: THREE.Group | null = null
  const _handPlanePoint = new THREE.Vector3()
  const _handPlaneNormal = new THREE.Vector3()

  let localDrag: LocalDrag | null = null
  let lastDragBroadcast = 0
  let peerDragState: CardDrag | null = null
  let knownSubKeys = new Set<string>()
  let flyingKeys = new Set<string>()
  /** Staged local drops before submitting (for pick > 1) */
  let stagedPlays: { text: string; x: number; z: number; rotY: number; card: CardMesh }[] = []

  // Table overview: high enough to see heads/names; hand is camera-locked separately.
  const handCamPos = new THREE.Vector3(0, TABLE_Y + 0.55, 1.2)
  const handCamTarget = new THREE.Vector3(0, TABLE_Y + 0.02, 0.15)
  const tableCamPos = new THREE.Vector3(0, TABLE_Y + 1.25, 1.05)
  const tableCamTarget = new THREE.Vector3(0, TABLE_Y + 0.02, -0.08)

  function ensureHitbox(card: CardMesh) {
    if (card.getObjectByName('hitbox')) return
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(CARD_W * 1.25, CARD_H * 1.25, 0.02),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    )
    hit.name = 'hitbox'
    card.add(hit)
  }

  function disposeCardMesh(card: CardMesh) {
    const hit = card.getObjectByName('hitbox') as THREE.Mesh | undefined
    if (hit) {
      hit.geometry.dispose()
      ;(hit.material as THREE.Material).dispose()
    }
    card.geometry.dispose()
  }

  function cardFromIntersect(obj: THREE.Object3D): CardMesh | null {
    let o: THREE.Object3D | null = obj
    while (o) {
      if ((o as CardMesh).userData?.lift) return o as CardMesh
      o = o.parent
    }
    return null
  }

  function mount(el: HTMLElement) {
    root = el
    scene = new THREE.Scene()
    scene.background = new THREE.Color('#e6e6e2')
    scene.fog = new THREE.Fog('#e6e6e2', 10, 32)

    camera = new THREE.PerspectiveCamera(FOV_HAND, 1, 0.05, 60)
    camera.position.copy(handCamPos)
    camera.lookAt(handCamTarget)
    scene.add(camera)

    threeRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    threeRenderer.shadowMap.enabled = true
    threeRenderer.shadowMap.type = THREE.PCFSoftShadowMap
    threeRenderer.outputColorSpace = THREE.SRGBColorSpace
    threeRenderer.toneMapping = THREE.ACESFilmicToneMapping
    threeRenderer.toneMappingExposure = 1.05
    el.appendChild(threeRenderer.domElement)

    worldGroup = new THREE.Group()
    scene.add(worldGroup)

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(40, 64),
      new THREE.MeshStandardMaterial({ color: '#d8d8d4', roughness: 0.95, metalness: 0 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    worldGroup.add(ground)

    tableGroup = new THREE.Group()
    tableGroup.position.y = TABLE_Y
    worldGroup.add(tableGroup)

    const surface = new THREE.Mesh(
      new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS + 0.04, 0.05, 64),
      new THREE.MeshStandardMaterial({ color: '#ecece8', roughness: 0.72, metalness: 0.04 }),
    )
    surface.receiveShadow = true
    surface.castShadow = true
    tableGroup.add(surface)

    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.22, TABLE_Y * 0.92, 32, 1, true),
      new THREE.MeshStandardMaterial({
        color: '#d0d0cc',
        transparent: true,
        opacity: 0.35,
        roughness: 1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    pedestal.position.y = -TABLE_Y * 0.46
    tableGroup.add(pedestal)

    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.065, TABLE_Y * 0.9, 16),
      new THREE.MeshStandardMaterial({ color: '#c8c8c4', roughness: 0.9, metalness: 0 }),
    )
    leg.position.y = -TABLE_Y * 0.45
    leg.castShadow = true
    tableGroup.add(leg)

    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(TABLE_RADIUS + 0.08, 48),
      new THREE.MeshBasicMaterial({ color: '#b0b0aa', transparent: true, opacity: 0.16 }),
    )
    blob.rotation.x = -Math.PI / 2
    blob.position.y = -TABLE_Y + 0.01
    tableGroup.add(blob)

    ghostCard = createCard('…', 'white')
    ghostCard.visible = false
    ghostCard.userData.baseRotX = TABLE_FACE_UP_X
    ghostCard.rotation.x = TABLE_FACE_UP_X
    ghostCard.scale.setScalar(0.95)
    ghostCard.material = (ghostCard.material as THREE.MeshStandardMaterial[]).map((m) => {
      const c = m.clone()
      c.transparent = true
      c.opacity = 0.72
      return c
    }) as unknown as THREE.MeshStandardMaterial[]
    tableGroup.add(ghostCard)

    scene.add(new THREE.AmbientLight('#f0f0ec', 0.55))
    const key = new THREE.DirectionalLight('#ffffff', 1.15)
    key.position.set(3.5, 8, 4)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.near = 1
    key.shadow.camera.far = 30
    key.shadow.camera.left = -8
    key.shadow.camera.right = 8
    key.shadow.camera.top = 8
    key.shadow.camera.bottom = -8
    key.shadow.radius = 3
    scene.add(key)
    const fill = new THREE.DirectionalLight('#d8dce8', 0.35)
    fill.position.set(-4, 3, -2)
    scene.add(fill)

    handGroup = new THREE.Group()
    // Parent to camera so the fan always sits in the lower viewport
    camera.add(handGroup)
    handGroup.position.set(HAND_CAM_X, HAND_CAM_Y, HAND_CAM_Z)
    handGroup.rotation.x = 0.18

    const canvas = threeRenderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.touchAction = 'none'

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerLeaveCanvas)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)

    resize()
    clock.start()
    loop()
  }

  function unmount() {
    cancelAnimationFrame(raf)
    if (root) {
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerup', onPointerUp)
      root.removeEventListener('pointercancel', onPointerUp)
    }
    if (threeRenderer) {
      const canvas = threeRenderer.domElement
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeaveCanvas)
    }
    for (const a of avatars.values()) a.dispose()
    avatars.clear()
    for (const cards of peerHands.values()) {
      for (const c of cards) disposeCardMesh(c)
    }
    peerHands.clear()
    clearHand()
    clearTableCards()
    if (blackCard) {
      disposeCardMesh(blackCard)
      blackCard = null
    }
    if (ghostCard) {
      const mats = ghostCard.material as THREE.MeshStandardMaterial[]
      for (const m of mats) m.dispose()
      disposeCardMesh(ghostCard)
      ghostCard = null
    }
    if (threeRenderer) {
      threeRenderer.domElement.remove()
      threeRenderer.dispose()
    }
    threeRenderer = null
    scene = null
    camera = null
    root = null
    localDrag = null
  }

  function resize() {
    if (!root || !camera || !threeRenderer) return
    const w = root.clientWidth || window.innerWidth
    const h = root.clientHeight || window.innerHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    threeRenderer.setSize(w, h, false)
  }

  function clearHand() {
    for (const c of handCards) {
      handGroup?.remove(c)
      disposeCardMesh(c)
    }
    handCards = []
  }

  function clearTableCards() {
    for (const c of tableCards) {
      tableGroup?.remove(c)
      disposeCardMesh(c)
    }
    tableCards = []
  }

  function cardKeyFor(playerId: string, cardIndex: number, text: string) {
    return `${playerId}:${cardIndex}:${text}`
  }

  function zoneFromPointer(screenY: number) {
    if (screenY > HAND_ZONE_Y) return 'hand' as const
    return 'table' as const
  }

  function updatePointerFromEvent(ev: PointerEvent) {
    if (!root) return
    const rect = root.getBoundingClientRect()
    const nx = (ev.clientX - rect.left) / Math.max(rect.width, 1)
    const ny = (ev.clientY - rect.top) / Math.max(rect.height, 1)
    pointerScreenY = THREE.MathUtils.clamp(ny, 0, 1)
    pointerNdc.x = nx * 2 - 1
    pointerNdc.y = -(ny * 2 - 1)
    pointer.x = pointerNdc.x
    pointer.y = pointerNdc.y
  }

  function projectOntoPlane(plane: THREE.Plane): THREE.Vector3 | null {
    if (!camera) return null
    raycaster.setFromCamera(pointer, camera)
    const ok = raycaster.ray.intersectPlane(plane, hitPoint)
    return ok ? hitPoint.clone() : null
  }

  function worldToTableLocal(world: THREE.Vector3) {
    if (!tableGroup) return { x: world.x, z: world.z }
    const local = tableGroup.worldToLocal(world.clone())
    return { x: local.x, z: local.z }
  }

  function clampToTable(x: number, z: number) {
    const r = Math.hypot(x, z)
    const max = TABLE_RADIUS * 0.88
    if (r <= max) return { x, z }
    const s = max / r
    return { x: x * s, z: z * s }
  }

  function layoutHand(texts: string[]) {
    if (!handGroup) return
    const dragCard =
      localDrag?.source === 'hand' ? localDrag.card : null
    const byText = new Map<string, CardMesh[]>()
    for (const c of handCards) {
      const t = c.userData.cardText
      const list = byText.get(t) || []
      list.push(c)
      byText.set(t, list)
    }

    const next: CardMesh[] = []
    const reused = new Set<CardMesh>()
    texts.forEach((t, i) => {
      const pool = byText.get(t)
      let card = pool?.shift()
      if (card && card === dragCard && !texts.includes(t)) {
        card = undefined
      }
      if (card) {
        reused.add(card)
        card.userData.index = i
        if (card.parent !== handGroup && !card.userData.dragging) {
          handGroup!.add(card)
        }
        ensureHitbox(card)
        next.push(card)
      } else {
        card = createCard(t, 'white')
        card.userData.index = i
        card.rotation.order = 'YXZ'
        ensureHitbox(card)
        handGroup!.add(card)
        dropCard(card, 0.35, 0)
        card.userData.lift.velocity = -2.0 - i * 0.12
        next.push(card)
      }
    })

    for (const c of handCards) {
      if (reused.has(c) || c === dragCard) continue
      if (c.parent === handGroup) handGroup.remove(c)
      disposeCardMesh(c)
    }

    handCards = next

    if (localDrag?.source === 'hand') {
      const match = handCards.find((c) => c.userData.cardText === localDrag!.cardText)
      if (match) {
        localDrag.card = match
        localDrag.handIndex = match.userData.index
        match.userData.dragging = true
      }
    }

    const n = handCards.length
    // Compact enough for 7, tall enough to read — keep bottoms above the bezel
    const spread = Math.min(0.105, 0.78 / Math.max(n, 1))
    const start = -((n - 1) * spread) / 2
    handCards.forEach((card, i) => {
      if (card.userData.dragging) return
      const mid = (n - 1) / 2
      card.position.x = start + i * spread
      card.position.z = 0.008 * Math.abs(i - mid)
      card.userData.baseY = 0
      // Camera-space fan: slight lean toward the player
      card.userData.baseRotX = -0.08
      card.userData.baseRotY = (i - mid) * -0.03
      card.userData.baseRotZ = (i - mid) * -0.014
      card.rotation.x = card.userData.baseRotX
      card.rotation.y = card.userData.baseRotY
      card.rotation.z = card.userData.baseRotZ
    })
    handGroup.position.set(HAND_CAM_X, HAND_CAM_Y, HAND_CAM_Z)
  }

  function layoutPeerHand(
    handle: AvatarHandle,
    playerId: string,
    handCount: number,
    hoverIdx: number | null,
    peekText: string | null,
  ) {
    let cards = peerHands.get(playerId)
    if (!cards) {
      cards = []
      peerHands.set(playerId, cards)
    }

    while (cards.length > handCount) {
      const c = cards.pop()!
      handle.handAnchor.remove(c)
      disposeCardMesh(c)
    }
    while (cards.length < handCount) {
      const card = createCard('Peril', 'back')
      card.scale.setScalar(0.7)
      const i = cards.length
      card.userData.index = i
      handle.handAnchor.add(card)
      cards.push(card)
    }

    // Billboard the fan toward the local camera so cards always read portrait
    handle.handAnchor.position.set(0, 0.4, 0.24)
    if (camera) {
      const anchorWorld = new THREE.Vector3()
      handle.group.localToWorld(anchorWorld.copy(handle.handAnchor.position))
      const camPos = camera.position.clone()
      // Face camera in XZ; keep upright
      const dx = camPos.x - anchorWorld.x
      const dz = camPos.z - anchorWorld.z
      const worldYaw = Math.atan2(dx, dz)
      handle.handAnchor.rotation.set(0.08, worldYaw - handle.group.rotation.y, 0)
    } else {
      handle.handAnchor.rotation.set(0.08, 0, 0)
    }

    const n = cards.length
    const spread = Math.min(0.075, 0.48 / Math.max(n, 1))
    const start = -((n - 1) * spread) / 2
    cards.forEach((card, i) => {
      const mid = (n - 1) / 2
      const isPeek = hoverIdx === i
      card.position.x = start + i * spread
      card.position.y = isPeek ? 0.035 : 0
      card.position.z = 0.005 * Math.abs(i - mid)
      card.userData.baseY = isPeek ? 0.035 : 0
      card.userData.baseRotX = isPeek ? -0.04 : -0.1
      card.userData.baseRotY = (i - mid) * -0.026
      card.userData.baseRotZ = (i - mid) * -0.012
      card.rotation.x = card.userData.baseRotX
      card.rotation.y = card.userData.baseRotY
      card.rotation.z = card.userData.baseRotZ
      swapPeerCardFace(card, isPeek ? peekText : null, isPeek)
    })
  }

  function swapPeerCardFace(card: CardMesh, text: string | null, isPeek: boolean) {
    const wantKind: 'white' | 'back' = isPeek && text ? 'white' : 'back'
    const wantText = isPeek && text ? text : 'Peril'
    if (card.userData.kind === wantKind && card.userData.cardText === wantText) return

    const fresh = createCard(wantText, wantKind)
    const oldMats = card.material as THREE.MeshStandardMaterial[]
    const newMats = fresh.material as THREE.MeshStandardMaterial[]
    for (let i = 0; i < oldMats.length; i++) oldMats[i].dispose()
    card.material = newMats
    card.userData.kind = wantKind
    card.userData.cardText = wantText
    fresh.geometry.dispose()
  }

  function syncAvatars(state: RoomState, localPlayerId: string) {
    if (!worldGroup) return
    const players = [...state.players].sort((a, b) => a.seat - b.seat)
    const peers = players.filter((p) => p.id !== localPlayerId)
    const peerLayouts: SeatLayout[] = peers.map((_, i) => {
      const n = peers.length
      const t = n === 1 ? 0.5 : i / (n - 1)
      // Far-side arc — heads stay above the table in both camera modes
      const angle = -0.95 + t * 1.9
      const dist = TABLE_RADIUS + 0.32
      return {
        position: new THREE.Vector3(Math.sin(angle) * dist, 0, -Math.cos(angle) * dist),
        yaw: Math.atan2(-Math.sin(angle), Math.cos(angle)),
      }
    })

    const needed = new Set(players.map((p) => p.id))
    for (const [id, a] of avatars) {
      if (!needed.has(id) || id === localPlayerId) {
        worldGroup.remove(a.group)
        a.dispose()
        avatars.delete(id)
        const cards = peerHands.get(id)
        if (cards) {
          for (const c of cards) disposeCardMesh(c)
          peerHands.delete(id)
        }
      }
    }

    // Chest at rim, head above the table surface
    const sitY = AVATAR_SIT_Y
    peers.forEach((p, i) => {
      const seat = peerLayouts[i]
      if (!seat) return

      let handle = avatars.get(p.id)
      if (!handle) {
        handle = createAvatar(p.name, p.faceDataUrl)
        avatars.set(p.id, handle)
        worldGroup!.add(handle.group)
        handle.group.position.set(seat.position.x, sitY - 0.08, seat.position.z)
        handle.group.rotation.y = seat.yaw
        const target = handle
        const fromY = sitY - 0.08
        tweens.tween(
          0.75,
          (v) => {
            target.group.position.y = fromY + v * 0.08
          },
          easeOutBack,
        )
      } else {
        handle.setName(p.name)
        if (p.faceDataUrl) handle.setFace(p.faceDataUrl)
        handle.group.position.x = seat.position.x
        handle.group.position.z = seat.position.z
        handle.group.position.y = sitY
        handle.group.rotation.y = seat.yaw
      }
      handle.setHighlight(state.czarId === p.id)

      const hoverIdx = peerHover.get(p.id) ?? state.hover?.[p.id] ?? null
      const peekText = peerHoverText.get(p.id) ?? state.hoverText?.[p.id] ?? null
      const count = Math.max(1, Math.min(p.handCount ?? 7, 7))
      layoutPeerHand(handle, p.id, count, hoverIdx, peekText)
    })
  }

  function syncBlack(state: RoomState) {
    if (!tableGroup) return
    const text = state.blackCard?.text
    if (!text) {
      if (blackCard) {
        tableGroup.remove(blackCard)
        disposeCardMesh(blackCard)
        blackCard = null
      }
      return
    }
    if (!blackCard || blackCard.userData.cardText !== text) {
      if (blackCard) {
        tableGroup.remove(blackCard)
        disposeCardMesh(blackCard)
      }
      blackCard = createCard(text, 'black')
      blackCard.userData.baseRotX = TABLE_FACE_UP_X
      blackCard.userData.baseRotY = 0
      blackCard.userData.baseRotZ = 0
      blackCard.rotation.x = TABLE_FACE_UP_X
      blackCard.position.set(0, TABLE_CARD_Y, -0.1)
      blackCard.userData.baseY = TABLE_CARD_Y
      blackCard.scale.setScalar(1)
      tableGroup.add(blackCard)
      dropCard(blackCard, 0.8, TABLE_CARD_Y)
      blackCard.userData.lift.velocity = -2.5
    }
  }

  function animateFlyIn(
    card: CardMesh,
    fromWorld: THREE.Vector3,
    toLocal: { x: number; y: number; z: number; rotY: number },
  ) {
    if (!tableGroup) return
    const fromLocal = tableGroup.worldToLocal(fromWorld.clone())
    card.position.copy(fromLocal)
    card.userData.baseY = fromLocal.y
    card.userData.dragging = true
    const start = { x: fromLocal.x, y: fromLocal.y, z: fromLocal.z }
    tweens.tween(
      0.55,
      (v) => {
        const ease = easeOutCubic(v)
        card.position.x = start.x + (toLocal.x - start.x) * ease
        card.position.z = start.z + (toLocal.z - start.z) * ease
        const arc = Math.sin(ease * Math.PI) * 0.35
        card.position.y = start.y + (toLocal.y - start.y) * ease + arc
        card.userData.baseY = card.position.y
        card.rotation.y = toLocal.rotY * ease
        card.userData.baseRotY = card.rotation.y
      },
      easeOutCubic,
      () => {
        card.position.set(toLocal.x, toLocal.y, toLocal.z)
        card.userData.baseY = toLocal.y
        card.userData.baseRotY = toLocal.rotY
        card.rotation.y = toLocal.rotY
        card.userData.dragging = false
        flyingKeys.delete(card.userData.cardKey || '')
        dropCard(card, toLocal.y + 0.08, toLocal.y)
      },
    )
  }

  function syncSubmissions(state: RoomState) {
    if (!tableGroup) return
    const subs = state.submissions || []
    const nextKeys = new Set<string>()
    const scale = 0.95

    const desired: {
      key: string
      text: string
      revealed: boolean
      playerId: string
      x: number
      z: number
      rotY: number
      subIndex: number
      cardIndex: number
      hasServerPos: boolean
    }[] = []

    subs.forEach((sub, i) => {
      const n = subs.length
      const t = n === 1 ? 0.5 : i / (n - 1)
      const arcX = (t - 0.5) * 0.34
      const arcZ = 0.08
      sub.cards.forEach((text, ci) => {
        const key = cardKeyFor(sub.playerId, ci, text)
        nextKeys.add(key)
        const pos = sub.positions?.[ci]
        const hasServerPos = !!pos
        const ox =
          pos?.x ??
          arcX + (ci - (sub.cards.length - 1) / 2) * (CARD_W * scale * 0.62)
        const oz = pos?.z ?? arcZ
        const rotY = pos?.rotY ?? Math.sin(i * 7.1 + ci) * 0.5 * 0.16
        desired.push({
          key,
          text,
          revealed: sub.revealed,
          playerId: sub.playerId,
          x: ox,
          z: oz,
          rotY,
          subIndex: i,
          cardIndex: ci,
          hasServerPos,
        })
      })
    })

    const identitySig = desired.map((d) => `${d.key}:${d.revealed}`).join(';')
    const forceRebuild =
      identitySig !== tableGroup.userData.subIdentitySig || tableCards.length !== desired.length

    function findOptimisticMatch(d: (typeof desired)[0], pool: CardMesh[]): CardMesh | undefined {
      const localKey = `local:${d.playerId}:0:${d.text}`
      let card = pool.find((c) => c.userData.cardKey === d.key)
      if (card) return card
      card = pool.find((c) => c.userData.cardKey === localKey)
      if (card) return card
      card = pool.find(
        (c) =>
          (c.userData.cardKey?.startsWith('local:') ||
            c.userData.submissionPlayerId === d.playerId) &&
          (c.userData.cardText === d.text || c.userData.cardText === '???') &&
          (!d.revealed || c.userData.kind === 'white'),
      )
      return card
    }

    if (!forceRebuild && tableCards.length) {
      for (const d of desired) {
        const card = tableCards.find((c) => c.userData.cardKey === d.key)
        if (!card || card.userData.dragging) continue
        card.userData.selectable = state.phase === 'voting'
        card.userData.submissionPlayerId = d.playerId
        const myVote = state.votes?.[localId]
        const isVoted = state.phase === 'voting' && myVote === d.playerId
        const isWinner =
          (state.phase === 'scoring' || state.phase === 'ended') &&
          state.winnerId === d.playerId
        applyVoteGlow(card, isVoted, isWinner)
        const toY = TABLE_CARD_Y + d.subIndex * 0.002
        card.userData.baseY = toY
        if (d.hasServerPos) {
          card.position.x = d.x
          card.position.z = d.z
          card.userData.baseRotY = d.rotY
          card.rotation.y = d.rotY
          card.userData.pinned = true
        }
        card.position.y = card.userData.baseY + card.userData.lift.value
        if (d.revealed && card.userData.kind === 'white') {
          card.userData.baseRotX = TABLE_FACE_UP_X
          card.rotation.x = TABLE_FACE_UP_X
        }
      }
      knownSubKeys = nextKeys
      tableGroup.userData.subIdentitySig = identitySig
      return
    }

    const prevCards = [...tableCards]
    const newCards: CardMesh[] = []
    const used = new Set<CardMesh>()

    for (const d of desired) {
      const isNew = !knownSubKeys.has(d.key)
      let card = findOptimisticMatch(d, prevCards.filter((c) => !used.has(c)))
      if (card && !used.has(card)) {
        used.add(card)
        if (
          card.userData.kind !== (d.revealed ? 'white' : 'back') ||
          (d.revealed && card.userData.cardText !== d.text && card.userData.cardText !== '???')
        ) {
          // Face/kind mismatch — rebuild mesh but keep position if pinned/local
          const keepX = card.position.x
          const keepZ = card.position.z
          const keepRotY = card.userData.baseRotY
          const keepPinned = card.userData.pinned
          tableGroup.remove(card)
          disposeCardMesh(card)
          card = createCard(d.revealed ? d.text : 'Peril', d.revealed ? 'white' : 'back')
          card.scale.setScalar(scale)
          card.userData.baseRotX = TABLE_FACE_UP_X
          card.userData.baseRotZ = 0
          card.rotation.x = TABLE_FACE_UP_X
          card.position.x = keepX
          card.position.z = keepZ
          card.userData.baseRotY = keepRotY
          card.rotation.y = keepRotY
          card.userData.pinned = keepPinned
          tableGroup.add(card)
          used.add(card)
        }
      } else {
        card = undefined
      }

      if (!card) {
        card = createCard(d.revealed ? d.text : 'Peril', d.revealed ? 'white' : 'back')
        card.scale.setScalar(scale)
        card.userData.baseRotX = TABLE_FACE_UP_X
        card.userData.baseRotZ = 0
        card.rotation.x = TABLE_FACE_UP_X
        tableGroup.add(card)
      }

      const wasLocal =
        !!card.userData.cardKey?.startsWith('local:') || !!card.userData.pinned
      card.userData.cardKey = d.key
      card.userData.cardText = d.revealed ? d.text : '???'
      card.userData.submissionPlayerId = d.playerId
      card.userData.index = d.subIndex
      card.userData.selectable = state.phase === 'voting'
      const myVote = state.votes?.[localId]
      const isVoted = state.phase === 'voting' && myVote === d.playerId
      const isWinner =
        (state.phase === 'scoring' || state.phase === 'ended') &&
        state.winnerId === d.playerId
      applyVoteGlow(card, isVoted, isWinner)

      const toY = TABLE_CARD_Y + d.subIndex * 0.002
      const draggingThis =
        localDrag?.source === 'table' &&
        (localDrag.cardKey === d.key || localDrag.card === card)

      if (draggingThis && localDrag) {
        localDrag.card = card
        localDrag.cardKey = d.key
        card.userData.dragging = true
      } else if (isNew && d.playerId !== localId && !flyingKeys.has(d.key) && !wasLocal) {
        flyingKeys.add(d.key)
        const handle = avatars.get(d.playerId)
        const from = new THREE.Vector3()
        if (handle) {
          handle.handAnchor.getWorldPosition(from)
        } else {
          from.set(d.x * 0.3, TABLE_Y + 0.4, d.z - 0.6)
        }
        card.userData.baseRotX = TABLE_FACE_UP_X
        card.rotation.x = TABLE_FACE_UP_X
        card.userData.baseRotY = d.rotY
        card.rotation.y = d.rotY
        animateFlyIn(card, from, { x: d.x, y: toY, z: d.z, rotY: d.rotY })
      } else if (!card.userData.dragging) {
        if (d.hasServerPos || !wasLocal) {
          card.position.x = d.x
          card.position.z = d.z
          card.userData.baseRotY = d.rotY
          card.rotation.y = d.rotY
        }
        card.position.y = toY
        card.userData.baseY = toY
        if (isNew && !wasLocal) {
          dropCard(card, toY + 0.55, toY)
          card.userData.lift.velocity = -2.4
        }
      }

      if (d.revealed && card.userData.kind === 'white') {
        const needsFlip =
          isNew &&
          !wasLocal &&
          Math.abs(card.userData.baseRotX - TABLE_FACE_UP_X) > 0.01
        if (needsFlip) {
          // Start face-down (+π/2) then flip to face-up (TABLE_FACE_UP_X = −π/2)
          card.userData.baseRotX = Math.PI / 2
          card.rotation.x = Math.PI / 2
          const delay = d.subIndex * 0.07 + d.cardIndex * 0.04
          const start = performance.now()
          const target = card
          const tick = () => {
            const elapsed = (performance.now() - start) / 1000
            if (elapsed < delay) {
              requestAnimationFrame(tick)
              return
            }
            tweens.tween(
              0.4,
              (v) => {
                target.userData.baseRotX = Math.PI / 2 - v * Math.PI
                target.rotation.x = target.userData.baseRotX
              },
              easeOutBack,
            )
          }
          requestAnimationFrame(tick)
        } else {
          card.userData.baseRotX = TABLE_FACE_UP_X
          card.rotation.x = TABLE_FACE_UP_X
        }
      }

      newCards.push(card)
    }

    for (const old of tableCards) {
      if (!used.has(old) && !newCards.includes(old)) {
        tableGroup.remove(old)
        disposeCardMesh(old)
      }
    }

    tableCards = newCards
    tableGroup.userData.subIdentitySig = identitySig
    knownSubKeys = nextKeys
  }

  function applyVoteGlow(card: CardMesh, voted: boolean, winner: boolean) {
    const mats = card.material as THREE.MeshStandardMaterial[]
    const emissive = winner ? '#3a5a32' : voted ? '#2a4a6a' : '#000000'
    const intensity = winner ? 0.35 : voted ? 0.28 : 0
    for (const m of mats) {
      if (!m || !('emissive' in m)) continue
      m.emissive = new THREE.Color(emissive)
      m.emissiveIntensity = intensity
    }
    if (voted || winner) {
      card.userData.baseY = Math.max(card.userData.baseY, TABLE_CARD_Y + 0.012)
    }
  }

  function applyGhost(drag: CardDrag | null) {
    if (!ghostCard || !tableGroup) return
    // Hide ghost for our own local drag — we move the real card
    if (!drag || drag.playerId === localId) {
      ghostCard.visible = false
      return
    }
    if (drag.cardText && ghostCard.userData.cardText !== drag.cardText) {
      const fresh = createCard(drag.cardText, 'white')
      const oldMats = ghostCard.material as THREE.MeshStandardMaterial[]
      const newMats = (fresh.material as THREE.MeshStandardMaterial[]).map((m) => {
        const c = m.clone()
        c.transparent = true
        c.opacity = 0.72
        return c
      })
      for (const m of oldMats) m.dispose()
      ghostCard.material = newMats as unknown as THREE.MeshStandardMaterial[]
      ghostCard.userData.cardText = drag.cardText
      ghostCard.userData.kind = 'white'
      fresh.geometry.dispose()
    }
    ghostCard.visible = true
    ghostCard.position.set(drag.x, TABLE_CARD_Y + 0.02, drag.z)
    ghostCard.rotation.x = TABLE_FACE_UP_X
    ghostCard.userData.baseRotX = TABLE_FACE_UP_X
  }

  function setPeerDrag(drag: CardDrag | null) {
    peerDragState = drag
    applyGhost(drag)
  }

  function broadcastDrag(now = performance.now()) {
    if (!localDrag || !localId) return
    if (now - lastDragBroadcast < DRAG_BROADCAST_MS) return
    lastDragBroadcast = now
    const worldY =
      localDrag.source === 'hand' && zoneFromPointer(pointerScreenY) === 'hand'
        ? TABLE_Y + 0.05
        : TABLE_Y + TABLE_CARD_Y + 0.01
    const local = worldToTableLocal(
      new THREE.Vector3(localDrag.card.position.x, 0, localDrag.card.position.z).applyMatrix4(
        (localDrag.source === 'hand' && localDrag.card.parent === handGroup
          ? handGroup!
          : tableGroup!
        ).matrixWorld,
      ),
    )
    // Prefer direct table-local from card when parented to table
    let x = local.x
    let z = local.z
    if (localDrag.card.parent === tableGroup) {
      x = localDrag.card.position.x
      z = localDrag.card.position.z
    } else if (tableGroup && handGroup) {
      const w = new THREE.Vector3()
      localDrag.card.getWorldPosition(w)
      const tl = tableGroup.worldToLocal(w)
      x = tl.x
      z = tl.z
    }
    const clamped = clampToTable(x, z)
    dragCb({
      playerId: localId,
      cardText: localDrag.cardText,
      source: localDrag.source,
      key: localDrag.cardKey,
      x: clamped.x,
      z: clamped.z,
      y: worldY,
    })
  }

  function makeDragSprings(x: number, y: number, z: number) {
    return {
      followX: new Spring(x, DRAG_STIFF, DRAG_DAMP),
      followY: new Spring(y, DRAG_STIFF, DRAG_DAMP),
      followZ: new Spring(z, DRAG_STIFF, DRAG_DAMP),
    }
  }

  function updateHandDragPlane() {
    if (!handGroup || !camera) return
    handGroup.getWorldPosition(_handPlanePoint)
    // Plane facing the camera through the hand fan
    camera.getWorldDirection(_handPlaneNormal)
    handPlane.setFromNormalAndCoplanarPoint(_handPlaneNormal, _handPlanePoint)
  }

  function updateLocalDragPosition() {
    if (!localDrag || !camera) return
    const zone = zoneFromPointer(pointerScreenY)
    const useHandPlane = localDrag.source === 'hand' && zone === 'hand'
    if (useHandPlane) updateHandDragPlane()
    else tablePlane.constant = -(TABLE_Y + TABLE_CARD_Y + 0.018)
    const plane = useHandPlane ? handPlane : tablePlane
    const hit = projectOntoPlane(plane)
    if (!hit) return

    if (localDrag.source === 'hand') {
      if (zone === 'table' || lookClose) {
        if (localDrag.card.parent !== tableGroup && tableGroup) {
          const w = new THREE.Vector3()
          localDrag.card.getWorldPosition(w)
          handGroup?.remove(localDrag.card)
          tableGroup.add(localDrag.card)
          const loc = tableGroup.worldToLocal(w)
          localDrag.card.position.copy(loc)
          localDrag.followX.set(loc.x)
          localDrag.followY.set(Math.max(loc.y, TABLE_CARD_Y + 0.02))
          localDrag.followZ.set(loc.z)
          localDrag.card.userData.baseRotX = TABLE_FACE_UP_X
          localDrag.card.rotation.x = TABLE_FACE_UP_X
          localDrag.card.rotation.y = localDrag.rotY
          localDrag.card.rotation.z = 0
        }
        if (tableGroup) {
          const loc = tableGroup.worldToLocal(hit)
          const c = clampToTable(loc.x, loc.z)
          localDrag.followX.center = c.x
          localDrag.followZ.center = c.z
          localDrag.followY.center = TABLE_CARD_Y + 0.045
        }
      } else {
        if (localDrag.card.parent !== handGroup && handGroup) {
          const w = new THREE.Vector3()
          localDrag.card.getWorldPosition(w)
          tableGroup?.remove(localDrag.card)
          handGroup.add(localDrag.card)
          const loc = handGroup.worldToLocal(w)
          localDrag.card.position.copy(loc)
          localDrag.followX.set(loc.x)
          localDrag.followY.set(loc.y)
          localDrag.followZ.set(loc.z)
          localDrag.card.userData.baseRotX = -0.08
          localDrag.card.rotation.order = 'YXZ'
        }
        if (handGroup) {
          const loc = handGroup.worldToLocal(hit)
          localDrag.followX.center = loc.x
          localDrag.followY.center = loc.y
          localDrag.followZ.center = loc.z
          localDrag.card.rotation.x = -0.08
        }
      }
    } else if (tableGroup) {
      const loc = tableGroup.worldToLocal(hit)
      const c = clampToTable(loc.x, loc.z)
      localDrag.followX.center = c.x
      localDrag.followZ.center = c.z
      localDrag.followY.center = TABLE_CARD_Y + 0.045
      localDrag.card.rotation.x = TABLE_FACE_UP_X
      localDrag.card.userData.baseRotX = TABLE_FACE_UP_X
      localDrag.card.rotation.y = localDrag.rotY
    }

    localDrag.card.userData.dragging = true
    broadcastDrag()
  }

  function endHandDragCancel() {
    if (!localDrag || localDrag.source !== 'hand') return
    const card = localDrag.card
    card.userData.dragging = false
    if (card.parent !== handGroup && handGroup) {
      tableGroup?.remove(card)
      handGroup.add(card)
    }
    localDrag = null
    dragCb(null)
    layoutHand(room?.you?.hand || handCards.map((c) => c.userData.cardText))
  }

  function endHandDragPlay() {
    if (!localDrag || localDrag.source !== 'hand' || !tableGroup) return
    const card = localDrag.card
    const text = localDrag.cardText
    let x = card.position.x
    let z = card.position.z
    if (card.parent !== tableGroup) {
      const w = new THREE.Vector3()
      card.getWorldPosition(w)
      const loc = tableGroup.worldToLocal(w)
      x = loc.x
      z = loc.z
    }
    const c = clampToTable(x, z)
    const rotY = localDrag.rotY
    const pick = room?.blackCard?.pick || 1
    const stageIndex = stagedPlays.length

    handGroup?.remove(card)
    if (card.parent !== tableGroup) tableGroup.add(card)
    card.position.set(c.x, TABLE_CARD_Y + 0.06, c.z)
    card.userData.baseRotX = TABLE_FACE_UP_X
    card.rotation.x = TABLE_FACE_UP_X
    card.rotation.y = rotY
    card.userData.baseRotY = rotY
    card.rotation.z = 0
    card.userData.baseRotZ = 0
    card.scale.setScalar(0.95)
    dropCard(card, TABLE_CARD_Y + 0.06, TABLE_CARD_Y)
    card.userData.cardKey = `local:${localId}:${stageIndex}:${text}`
    card.userData.submissionPlayerId = localId
    card.userData.cardText = text
    card.userData.pinned = true
    card.userData.dragging = false
    card.userData.selectable = false

    handCards = handCards.filter((h) => h !== card)
    if (!tableCards.includes(card)) tableCards.push(card)

    stagedPlays.push({ text, x: c.x, z: c.z, rotY, card })
    localDrag = null
    dragCb(null)

    // Only submit when we've staged the full pick count — avoids "Play exactly N" errors
    if (stagedPlays.length >= pick) {
      const cards = stagedPlays.map((s) => s.text)
      const positions = stagedPlays.map((s) => ({ x: s.x, z: s.z, rotY: s.rotY }))
      stagedPlays = []
      playCb(cards, positions)
    }
  }

  function endTableDrag() {
    if (!localDrag || localDrag.source !== 'table') return
    const card = localDrag.card
    const key = localDrag.cardKey || card.userData.cardKey || ''
    const x = card.position.x
    const z = card.position.z
    const rotY = localDrag.rotY
    card.userData.dragging = false
    card.userData.pinned = true
    card.userData.baseRotY = rotY
    card.rotation.y = rotY
    card.userData.baseRotX = TABLE_FACE_UP_X
    card.rotation.x = TABLE_FACE_UP_X
    dropCard(card, card.position.y, TABLE_CARD_Y)
    localDrag = null
    dragCb(null)
    if (key) moveTableCb(key, x, z, rotY)
  }

  function onPointerDown(ev: PointerEvent) {
    if (!camera || !room || localDrag) return
    updatePointerFromEvent(ev)
    const zone = lookClose ? 'table' : zoneFromPointer(pointerScreenY)
    raycaster.setFromCamera(pointer, camera)

    if (
      room.phase === 'playing' &&
      zone === 'hand' &&
      !lookClose &&
      room.czarId !== localId
    ) {
      const hits = raycaster.intersectObjects(handCards, true)
      if (hits.length) {
        const card = cardFromIntersect(hits[0].object)
        if (!card) return
        card.userData.dragging = true
        localDrag = {
          source: 'hand',
          card,
          cardText: card.userData.cardText,
          handIndex: card.userData.index,
          pointerId: ev.pointerId,
          startX: ev.clientX,
          startY: ev.clientY,
          moved: false,
          rotY: (Math.random() - 0.5) * 0.18,
          ...makeDragSprings(card.position.x, card.position.y + 0.04, card.position.z),
        }
        localDrag.followY.center = card.position.y + 0.04
        setHover(null)
        try {
          ;(ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId)
        } catch {
          /* ignore */
        }
        updateLocalDragPosition()
        broadcastDrag(performance.now() + DRAG_BROADCAST_MS)
        ev.preventDefault()
        return
      }
    }

    const canRearrange =
      tableCards.length > 0 &&
      (room.phase === 'playing' ||
        room.phase === 'revealing' ||
        room.phase === 'voting' ||
        room.phase === 'scoring')

    if ((zone === 'table' || lookClose) && canRearrange) {
      const hits = raycaster.intersectObjects(tableCards, true)
      if (hits.length) {
        const card = cardFromIntersect(hits[0].object)
        if (!card) return
        const key = card.userData.cardKey as string | undefined
        if (room.phase === 'voting') {
          // Potential click-vote; becomes rearrange if moved past CLICK_MOVE_PX
          if (!key) card.userData.cardKey = `loose:${card.userData.submissionPlayerId || 'x'}:${card.userData.index}`
          localDrag = {
            source: 'table',
            card,
            cardText: card.userData.cardText,
            cardKey: card.userData.cardKey,
            pointerId: ev.pointerId,
            startX: ev.clientX,
            startY: ev.clientY,
            moved: false,
            rotY: card.userData.baseRotY || 0,
            ...makeDragSprings(card.position.x, card.position.y, card.position.z),
          }
          try {
            ;(ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId)
          } catch {
            /* ignore */
          }
          ev.preventDefault()
          return
        }
        // Any table card is rearrangeable — invent a key if missing
        if (!key) {
          card.userData.cardKey = `loose:${card.userData.submissionPlayerId || 'x'}:${card.userData.index}:${card.userData.cardText}`
        }
        card.userData.dragging = true
        localDrag = {
          source: 'table',
          card,
          cardText: card.userData.cardText,
          cardKey: card.userData.cardKey,
          pointerId: ev.pointerId,
          startX: ev.clientX,
          startY: ev.clientY,
          moved: false,
          rotY: card.userData.baseRotY || 0,
          ...makeDragSprings(card.position.x, TABLE_CARD_Y + 0.045, card.position.z),
        }
        localDrag.followY.center = TABLE_CARD_Y + 0.045
        try {
          ;(ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId)
        } catch {
          /* ignore */
        }
        updateLocalDragPosition()
        broadcastDrag(performance.now() + DRAG_BROADCAST_MS)
        ev.preventDefault()
      }
    }
  }

  function onPointerMove(ev: PointerEvent) {
    if (!camera || !threeRenderer || !root) return
    updatePointerFromEvent(ev)

    // Map upper half → table overview; during voting, bias toward the table
    const raw = THREE.MathUtils.clamp((HAND_ZONE_Y - pointerScreenY) / 0.4, 0, 1)
    const tableAmount = raw * raw
    const phaseBias =
      room?.phase === 'voting' || room?.phase === 'scoring' || room?.phase === 'revealing'
        ? 0.55
        : 0
    camBlend.center = lookClose
      ? Math.max(tableAmount, 0.95)
      : Math.max(tableAmount, phaseBias)
    if (tableAmount > 0.04 || lookClose) {
      camPanX.center = THREE.MathUtils.clamp(pointerNdc.x, -1, 1) * 0.35
      camPanZ.center = THREE.MathUtils.clamp(0.4 - pointerScreenY, -0.4, 0.4) * 0.2
    } else {
      camPanX.center = 0
      camPanZ.center = 0
    }

    if (localDrag && ev.pointerId === localDrag.pointerId) {
      const dx = ev.clientX - localDrag.startX
      const dy = ev.clientY - localDrag.startY
      if (Math.hypot(dx, dy) > CLICK_MOVE_PX) localDrag.moved = true

      if (!localDrag.card.userData.dragging && localDrag.source === 'table' && localDrag.moved) {
        localDrag.card.userData.dragging = true
      }
      if (localDrag.card.userData.dragging || localDrag.source === 'hand') {
        updateLocalDragPosition()
      }
      return
    }

    const zone = lookClose ? 'table' : zoneFromPointer(pointerScreenY)
    raycaster.setFromCamera(pointer, camera)
    if (zone === 'hand' && !lookClose) {
      const hits = raycaster.intersectObjects(
        handCards.filter((c) => !c.userData.dragging),
        true,
      )
      if (hits.length) {
        const card = cardFromIntersect(hits[0].object)
        if (card) setHover(card.userData.index)
        else setHover(null)
      } else setHover(null)
    } else {
      const hits = raycaster.intersectObjects(
        tableCards.filter((c) => !c.userData.dragging),
        true,
      )
      if (hits.length) {
        const card = cardFromIntersect(hits[0].object)
        if (card) setHover(card.userData.index)
        else setHover(null)
      } else setHover(null)
    }
  }

  function onPointerUp(ev: PointerEvent) {
    if (!localDrag || ev.pointerId !== localDrag.pointerId) return
    updatePointerFromEvent(ev)
    const zone = lookClose ? 'table' : zoneFromPointer(pointerScreenY)

    if (room?.phase === 'voting' && localDrag.source === 'table') {
      const card = localDrag.card
      const wasClick = !localDrag.moved
      if (wasClick) {
        localDrag = null
        dragCb(null)
        const pid = card.userData.submissionPlayerId
        if (pid && pid !== 'hidden' && pid !== localId) voteCb(pid)
      } else if (card.userData.dragging || localDrag.moved) {
        endTableDrag()
      } else {
        localDrag = null
        dragCb(null)
      }
      return
    }

    if (localDrag.source === 'hand') {
      if (zone === 'table' || lookClose) endHandDragPlay()
      else endHandDragCancel()
      return
    }

    if (localDrag.source === 'table') {
      if (localDrag.card.userData.dragging || localDrag.moved) endTableDrag()
      else {
        localDrag.card.userData.dragging = false
        localDrag = null
        dragCb(null)
      }
    }
  }

  function onPointerLeaveCanvas() {
    if (!localDrag) setHover(null)
  }

  function setState(state: RoomState, localPlayerId: string) {
    room = state
    localId = localPlayerId
    if (state.hover) {
      for (const [pid, idx] of Object.entries(state.hover)) {
        if (pid !== localPlayerId) peerHover.set(pid, idx)
      }
    }
    if (state.hoverText) {
      for (const [pid, text] of Object.entries(state.hoverText)) {
        if (pid !== localPlayerId) peerHoverText.set(pid, text)
      }
    }
    syncAvatars(state, localPlayerId)
    syncBlack(state)
    syncSubmissions(state)
    // Clear staging when our submission is confirmed or round changes
    if (state.phase !== 'playing') {
      stagedPlays = []
    } else if (state.submissions?.some((s) => s.playerId === localPlayerId)) {
      stagedPlays = []
    }
    const rawHand = state.you?.hand || []
    const optimisticPlayed = new Map<string, number>()
    for (const s of stagedPlays) {
      optimisticPlayed.set(s.text, (optimisticPlayed.get(s.text) || 0) + 1)
    }
    for (const c of tableCards) {
      if (
        c.userData.cardKey?.startsWith(`local:${localPlayerId}:`) ||
        (c.userData.pinned && c.userData.submissionPlayerId === localPlayerId)
      ) {
        const t = c.userData.cardText
        if (t && t !== '???') {
          optimisticPlayed.set(t, (optimisticPlayed.get(t) || 0) + 1)
        }
      }
    }
    const filteredHand: string[] = []
    for (const t of rawHand) {
      const n = optimisticPlayed.get(t) || 0
      if (n > 0) {
        optimisticPlayed.set(t, n - 1)
        continue
      }
      filteredHand.push(t)
    }
    layoutHand(filteredHand)
    selected = new Set(state.you?.selected || [])
    if (state.drag && state.drag.playerId !== localPlayerId) {
      setPeerDrag(state.drag)
    } else if (!state.drag && peerDragState && peerDragState.playerId !== localPlayerId) {
      setPeerDrag(null)
    } else if (!localDrag) {
      applyGhost(state.drag?.playerId === localPlayerId ? null : state.drag ?? null)
    }
  }

  function setPeerHover(playerId: string, cardIndex: number | null, cardText?: string | null) {
    peerHover.set(playerId, cardIndex)
    if (cardText !== undefined) peerHoverText.set(playerId, cardText)
    const handle = avatars.get(playerId)
    if (!handle) return
    const count = peerHands.get(playerId)?.length ?? 7
    layoutPeerHand(handle, playerId, count, cardIndex, peerHoverText.get(playerId) ?? null)
  }

  function setHover(index: number | null) {
    if (hoveredIndex === index) return
    hoveredIndex = index
    const text = index != null ? handCards[index]?.userData.cardText ?? null : null
    hoverCb(index, text)
  }

  function lookCloser(on: boolean) {
    lookClose = on
    if (on) camBlend.center = 1
  }

  function loop() {
    raf = requestAnimationFrame(loop)
    const dt = Math.min(clock.getDelta(), 0.05)
    tweens.update(dt)

    if (lookClose) camBlend.animateTo(1, dt)
    else camBlend.animate(dt)
    camPanX.animate(dt)
    camPanZ.animate(dt)

    if (localDrag?.card.userData.dragging) {
      const x = localDrag.followX.animate(dt)
      const y = localDrag.followY.animate(dt)
      const z = localDrag.followZ.animate(dt)
      localDrag.card.position.set(x, y, z)
      localDrag.card.userData.baseY = y
    }

    if (camera) {
      const t = camBlend.value
      const basePos = handCamPos.clone().lerp(tableCamPos, t)
      const baseTarget = handCamTarget.clone().lerp(tableCamTarget, t)
      const panStrength = Math.max(t, 0.15)
      basePos.x += camPanX.value * panStrength
      basePos.z += camPanZ.value * 0.2
      baseTarget.x += camPanX.value * panStrength * 0.9
      baseTarget.z += camPanZ.value * 0.15
      camera.position.copy(basePos)
      camera.lookAt(baseTarget)
      // Slightly wider FOV overall; table peek only tightens a little
      camera.fov = THREE.MathUtils.lerp(FOV_HAND, FOV_TABLE, t)
      camera.updateProjectionMatrix()
    }

    if (handGroup) {
      const t = camBlend.value
      handGroup.visible = t < 0.92
      // Slide the camera-space fan down/out when looking at the table
      handGroup.position.set(
        HAND_CAM_X,
        HAND_CAM_Y - t * 0.12,
        HAND_CAM_Z - t * 0.08,
      )
      handGroup.rotation.x = 0.18 + t * 0.1
    }

    const inHandZone = !lookClose && zoneFromPointer(pointerScreenY) === 'hand'
    handCards.forEach((c, i) => {
      if (c.userData.dragging) return
      const hovered = hoveredIndex === i && inHandZone
      const sel = selected.has(c.userData.cardText)
      // Peek: lift height only, minimal tilt
      updateCardMotion(c, dt, hovered, sel, { lift: 0.07, tiltX: -0.018, tiltZ: 0.006 })
    })

    const inTableZone = lookClose || zoneFromPointer(pointerScreenY) === 'table'
    const voting = room?.phase === 'voting'
    tableCards.forEach((c) => {
      if (c.userData.dragging) return
      const hovered = inTableZone && hoveredIndex === c.userData.index
      const voted =
        voting && localId && room?.votes?.[localId] === c.userData.submissionPlayerId
      updateCardMotion(c, dt, hovered || !!voted, false, {
        lift: voting ? (hovered ? 0.045 : voted ? 0.03 : 0.012) : 0.028,
        tiltX: 0,
      })
      c.rotation.x = c.userData.baseRotX
    })
    if (blackCard) {
      updateCardMotion(blackCard, dt, false, false)
      blackCard.rotation.x = blackCard.userData.baseRotX
    }

    const t = clock.elapsedTime
    const sitY = AVATAR_SIT_Y
    for (const [id, a] of avatars) {
      a.group.position.y = sitY + Math.sin(t * 1.1 + a.group.position.x * 2) * 0.005
      const hoverIdx = peerHover.get(id) ?? null
      const peekText = peerHoverText.get(id) ?? null
      const cards = peerHands.get(id)
      const count = Math.max(
        cards?.length || 0,
        Math.min(room?.players.find((p) => p.id === id)?.handCount || 7, 7),
        1,
      )
      layoutPeerHand(a, id, count, hoverIdx, peekText)
    }

    for (const [id, cards] of peerHands) {
      const hoverIdx = peerHover.get(id) ?? null
      cards.forEach((c, i) => {
        updateCardMotion(c, dt, hoverIdx === i, false, { lift: 0.08, tiltX: -0.05, tiltZ: 0.016 })
      })
    }

    if (peerDragState && peerDragState.playerId !== localId) {
      applyGhost(peerDragState)
    }

    if (threeRenderer && scene && camera) threeRenderer.render(scene, camera)
  }

  return {
    mount,
    unmount,
    setState,
    setPeerHover,
    setPeerDrag,
    lookCloser,
    resize,
    get onPlayCards() {
      return playCb
    },
    set onPlayCards(fn) {
      playCb = fn
    },
    get onHoverCard() {
      return hoverCb
    },
    set onHoverCard(fn) {
      hoverCb = fn
    },
    get onDragCard() {
      return dragCb
    },
    set onDragCard(fn) {
      dragCb = fn
    },
    get onMoveTableCard() {
      return moveTableCb
    },
    set onMoveTableCard(fn) {
      moveTableCb = fn
    },
    get onVote() {
      return voteCb
    },
    set onVote(fn) {
      voteCb = fn
    },
  }
}
