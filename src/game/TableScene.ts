import * as THREE from 'three'
import {
  createCard,
  updateCardMotion,
  dropCard,
  CARD_W,
  TABLE_CARD_Y,
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
}

const TABLE_Y = 1.55
const TABLE_RADIUS = 1.15
const HAND_ZONE_Y = 0.48
const DRAG_BROADCAST_MS = 50
const CLICK_MOVE_PX = 8

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
  const camBlend = new Spring(0, 160, 24)
  const camPanX = new Spring(0, 140, 20)
  const camPanZ = new Spring(0, 140, 20)
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
  const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TABLE_Y + 0.12))
  const handPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TABLE_Y + 0.05))
  const hitPoint = new THREE.Vector3()
  let tableGroup: THREE.Group | null = null
  let handGroup: THREE.Group | null = null
  let worldGroup: THREE.Group | null = null

  let localDrag: LocalDrag | null = null
  let lastDragBroadcast = 0
  let peerDragState: CardDrag | null = null
  let knownSubKeys = new Set<string>()
  let flyingKeys = new Set<string>()

  const handCamPos = new THREE.Vector3(0, TABLE_Y + 0.32, 1.15)
  const handCamTarget = new THREE.Vector3(0, TABLE_Y + 0.02, 0.55)
  const tableCamPos = new THREE.Vector3(0, TABLE_Y + 0.72, 1.15)
  const tableCamTarget = new THREE.Vector3(0, TABLE_Y - 0.05, -0.15)

  function mount(el: HTMLElement) {
    root = el
    scene = new THREE.Scene()
    scene.background = new THREE.Color('#e6e6e2')
    scene.fog = new THREE.Fog('#e6e6e2', 10, 32)

    camera = new THREE.PerspectiveCamera(48, 1, 0.05, 60)
    camera.position.copy(handCamPos)
    camera.lookAt(handCamTarget)

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
      new THREE.CylinderGeometry(0.38, 0.62, TABLE_Y * 0.92, 32, 1, true),
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
      new THREE.CylinderGeometry(0.1, 0.16, TABLE_Y * 0.9, 16),
      new THREE.MeshStandardMaterial({ color: '#c8c8c4', roughness: 0.9, metalness: 0 }),
    )
    leg.position.y = -TABLE_Y * 0.45
    leg.castShadow = true
    tableGroup.add(leg)

    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(TABLE_RADIUS + 0.25, 48),
      new THREE.MeshBasicMaterial({ color: '#b0b0aa', transparent: true, opacity: 0.16 }),
    )
    blob.rotation.x = -Math.PI / 2
    blob.position.y = -TABLE_Y + 0.01
    tableGroup.add(blob)

    ghostCard = createCard('…', 'white')
    ghostCard.visible = false
    ghostCard.userData.baseRotX = -Math.PI / 2
    ghostCard.rotation.x = -Math.PI / 2
    ghostCard.scale.setScalar(0.85)
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
    handGroup.position.set(0, TABLE_Y + 0.05, 0.78)
    scene.add(handGroup)

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
      for (const c of cards) c.geometry.dispose()
    }
    peerHands.clear()
    clearHand()
    clearTableCards()
    if (blackCard) {
      blackCard.geometry.dispose()
      blackCard = null
    }
    if (ghostCard) {
      ghostCard.geometry.dispose()
      const mats = ghostCard.material as THREE.MeshStandardMaterial[]
      for (const m of mats) m.dispose()
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
      c.geometry.dispose()
    }
    handCards = []
  }

  function clearTableCards() {
    for (const c of tableCards) {
      tableGroup?.remove(c)
      c.geometry.dispose()
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
    const draggingText = localDrag?.source === 'hand' ? localDrag.cardText : null
    const same =
      handCards.length === texts.length &&
      handCards.every((c, i) => c.userData.cardText === texts[i])
    if (!same) {
      const keepDrag =
        localDrag?.source === 'hand' && texts.includes(localDrag.cardText) ? localDrag.card : null
      clearHand()
      texts.forEach((t, i) => {
        let card: CardMesh
        if (keepDrag && keepDrag.userData.cardText === t && !handCards.includes(keepDrag)) {
          card = keepDrag
          handGroup!.add(card)
        } else {
          card = createCard(t, 'white')
          card.userData.index = i
          card.rotation.order = 'YXZ'
          handGroup!.add(card)
          dropCard(card, 0.35, 0)
          card.userData.lift.velocity = -2.0 - i * 0.12
        }
        card.userData.index = i
        handCards.push(card)
      })
      if (localDrag?.source === 'hand') {
        const match = handCards.find((c) => c.userData.cardText === localDrag!.cardText)
        if (match) {
          localDrag.card = match
          localDrag.handIndex = match.userData.index
          match.userData.dragging = true
        }
      }
    }

    const n = handCards.length
    const spread = Math.min(0.085, 0.55 / Math.max(n, 1))
    const start = -((n - 1) * spread) / 2
    handCards.forEach((card, i) => {
      if (card.userData.dragging) return
      const mid = (n - 1) / 2
      card.position.x = start + i * spread
      card.position.z = 0.01 * Math.abs(i - mid)
      card.userData.baseY = 0
      card.userData.baseRotX = -0.22
      card.userData.baseRotY = (i - mid) * -0.028
      card.userData.baseRotZ = (i - mid) * -0.014
      card.rotation.x = card.userData.baseRotX
      card.rotation.y = card.userData.baseRotY
      card.rotation.z = card.userData.baseRotZ
    })
    handGroup.position.set(0, TABLE_Y + 0.05, 0.78)
    void draggingText
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
      c.geometry.dispose()
    }
    while (cards.length < handCount) {
      const card = createCard('Peril', 'back')
      card.scale.setScalar(0.88)
      const i = cards.length
      card.userData.index = i
      handle.handAnchor.add(card)
      cards.push(card)
    }

    const n = cards.length
    const spread = Math.min(0.072, 0.42 / Math.max(n, 1))
    const start = -((n - 1) * spread) / 2
    cards.forEach((card, i) => {
      const mid = (n - 1) / 2
      const isPeek = hoverIdx === i
      card.position.x = start + i * spread
      card.position.z = isPeek ? 0.08 : 0.02
      card.userData.baseY = isPeek ? 0.1 : 0.02
      card.userData.baseRotX = isPeek ? -0.95 : -1.15
      card.userData.baseRotY = (i - mid) * 0.035
      card.userData.baseRotZ = (i - mid) * 0.022
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
      const angle = -0.95 + t * 1.9
      const dist = 1.55
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
          for (const c of cards) c.geometry.dispose()
          peerHands.delete(id)
        }
      }
    }

    const sitY = TABLE_Y - 0.55
    peers.forEach((p, i) => {
      const seat = peerLayouts[i]
      if (!seat) return

      let handle = avatars.get(p.id)
      if (!handle) {
        handle = createAvatar(p.name, p.faceDataUrl)
        avatars.set(p.id, handle)
        worldGroup!.add(handle.group)
        handle.group.position.set(seat.position.x, sitY - 0.35, seat.position.z)
        handle.group.rotation.y = seat.yaw
        const target = handle
        const fromY = sitY - 0.35
        tweens.tween(
          0.75,
          (v) => {
            target.group.position.y = fromY + v * 0.35
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
      layoutPeerHand(handle, p.id, Math.min(p.handCount || 7, 7), hoverIdx, peekText)
    })
  }

  function syncBlack(state: RoomState) {
    if (!tableGroup) return
    const text = state.blackCard?.text
    if (!text) {
      if (blackCard) {
        tableGroup.remove(blackCard)
        blackCard.geometry.dispose()
        blackCard = null
      }
      return
    }
    if (!blackCard || blackCard.userData.cardText !== text) {
      if (blackCard) {
        tableGroup.remove(blackCard)
        blackCard.geometry.dispose()
      }
      blackCard = createCard(text, 'black')
      blackCard.userData.baseRotX = -Math.PI / 2
      blackCard.userData.baseRotY = 0
      blackCard.userData.baseRotZ = 0
      blackCard.rotation.x = -Math.PI / 2
      blackCard.position.set(0, TABLE_CARD_Y, -0.28)
      blackCard.userData.baseY = TABLE_CARD_Y
      blackCard.scale.setScalar(1.0)
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
    const scale = 0.78

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
    }[] = []

    subs.forEach((sub, i) => {
      const n = subs.length
      const t = n === 1 ? 0.5 : i / (n - 1)
      const arcX = (t - 0.5) * 1.15
      const arcZ = 0.32 + Math.abs(t - 0.5) * 0.08
      sub.cards.forEach((text, ci) => {
        const key = cardKeyFor(sub.playerId, ci, text)
        nextKeys.add(key)
        const pos = sub.positions?.[ci]
        const ox =
          pos?.x ??
          arcX + (ci - (sub.cards.length - 1) / 2) * (CARD_W * scale * 0.75)
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
        })
      })
    })

    const sig = desired
      .map((d) => `${d.key}:${d.revealed}:${d.x.toFixed(3)}:${d.z.toFixed(3)}`)
      .join(';')
    const forceRebuild =
      sig !== tableGroup.userData.subSig || tableCards.length !== desired.length

    if (!forceRebuild && tableCards.length) {
      // Still update positions if table rearrange landed
      for (const card of tableCards) {
        if (card.userData.dragging) continue
        const d = desired.find((x) => x.key === card.userData.cardKey)
        if (!d) continue
        card.position.x = d.x
        card.position.z = d.z
        card.userData.baseY = TABLE_CARD_Y + d.subIndex * 0.002
        card.position.y = card.userData.baseY + card.userData.lift.value
        card.userData.baseRotY = d.rotY
        card.rotation.y = d.rotY
        card.userData.selectable = state.phase === 'voting'
      }
      knownSubKeys = nextKeys
      return
    }

    const prevByKey = new Map(tableCards.map((c) => [c.userData.cardKey || '', c]))
    const newCards: CardMesh[] = []
    const used = new Set<CardMesh>()

    for (const d of desired) {
      const isNew = !knownSubKeys.has(d.key)
      let card = prevByKey.get(d.key)
      if (card && !used.has(card)) {
        used.add(card)
        if (card.userData.kind !== (d.revealed ? 'white' : 'back') ||
          (d.revealed && card.userData.cardText !== d.text)) {
          tableGroup.remove(card)
          card.geometry.dispose()
          card = undefined
        }
      } else {
        card = undefined
      }

      if (!card) {
        card = createCard(d.revealed ? d.text : 'Peril', d.revealed ? 'white' : 'back')
        card.scale.setScalar(scale)
        card.userData.baseRotX = -Math.PI / 2
        card.userData.baseRotZ = 0
        card.rotation.x = -Math.PI / 2
        tableGroup.add(card)
      }

      card.userData.cardKey = d.key
      card.userData.cardText = d.revealed ? d.text : '???'
      card.userData.submissionPlayerId = d.playerId
      card.userData.index = d.subIndex
      card.userData.selectable = state.phase === 'voting'
      card.userData.baseRotY = d.rotY
      card.rotation.y = d.rotY

      const toY = TABLE_CARD_Y + d.subIndex * 0.002
      const draggingThis =
        localDrag?.source === 'table' && localDrag.cardKey === d.key

      if (draggingThis && localDrag) {
        localDrag.card = card
        card.userData.dragging = true
      } else if (isNew && d.playerId !== localId && !flyingKeys.has(d.key)) {
        flyingKeys.add(d.key)
        const handle = avatars.get(d.playerId)
        const from = new THREE.Vector3()
        if (handle) {
          handle.handAnchor.getWorldPosition(from)
        } else {
          from.set(d.x * 0.3, TABLE_Y + 0.4, d.z - 0.6)
        }
        card.userData.baseRotX = -Math.PI / 2
        card.rotation.x = -Math.PI / 2
        animateFlyIn(card, from, { x: d.x, y: toY, z: d.z, rotY: d.rotY })
      } else if (!card.userData.dragging) {
        card.position.set(d.x, toY, d.z)
        card.userData.baseY = toY
        if (isNew) {
          dropCard(card, toY + 0.55, toY)
          card.userData.lift.velocity = -2.4
        }
      }

      if (d.revealed && card.userData.kind === 'white') {
        const needsFlip = isNew && Math.abs(card.userData.baseRotX + Math.PI / 2) > 0.01
        if (needsFlip) {
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
          card.userData.baseRotX = -Math.PI / 2
          card.rotation.x = -Math.PI / 2
        }
      }

      newCards.push(card)
    }

    for (const old of tableCards) {
      if (!used.has(old) && !newCards.includes(old)) {
        tableGroup.remove(old)
        old.geometry.dispose()
      }
    }

    tableCards = newCards
    tableGroup.userData.subSig = sig
    knownSubKeys = nextKeys
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
    ghostCard.position.set(drag.x, Math.max(drag.y - TABLE_Y, TABLE_CARD_Y + 0.04), drag.z)
    ghostCard.rotation.x = -Math.PI / 2
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
        : TABLE_Y + 0.12
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

  function updateLocalDragPosition() {
    if (!localDrag || !camera) return
    const zone = zoneFromPointer(pointerScreenY)
    const useHandPlane = localDrag.source === 'hand' && zone === 'hand'
    const plane = useHandPlane ? handPlane : tablePlane
    plane.constant = useHandPlane ? -(TABLE_Y + 0.05) : -(TABLE_Y + 0.12)
    const hit = projectOntoPlane(plane)
    if (!hit) return

    if (localDrag.source === 'hand') {
      if (zone === 'table' || lookClose) {
        // Reparent to table group for table-local coords
        if (localDrag.card.parent !== tableGroup && tableGroup) {
          const w = new THREE.Vector3()
          localDrag.card.getWorldPosition(w)
          handGroup?.remove(localDrag.card)
          tableGroup.add(localDrag.card)
          const loc = tableGroup.worldToLocal(w)
          localDrag.card.position.copy(loc)
          localDrag.card.userData.baseRotX = -Math.PI / 2
          localDrag.card.rotation.x = -Math.PI / 2
          localDrag.card.rotation.y = localDrag.rotY
          localDrag.card.rotation.z = 0
        }
        if (tableGroup) {
          const loc = tableGroup.worldToLocal(hit)
          const c = clampToTable(loc.x, loc.z)
          localDrag.card.position.set(c.x, TABLE_CARD_Y + 0.06, c.z)
          localDrag.card.userData.baseY = TABLE_CARD_Y + 0.06
        }
      } else {
        if (localDrag.card.parent !== handGroup && handGroup) {
          const w = new THREE.Vector3()
          localDrag.card.getWorldPosition(w)
          tableGroup?.remove(localDrag.card)
          handGroup.add(localDrag.card)
          const loc = handGroup.worldToLocal(w)
          localDrag.card.position.copy(loc)
          localDrag.card.userData.baseRotX = -0.22
          localDrag.card.rotation.order = 'YXZ'
        }
        if (handGroup) {
          const loc = handGroup.worldToLocal(hit)
          localDrag.card.position.set(loc.x, 0.06, loc.z)
          localDrag.card.userData.baseY = 0.06
          localDrag.card.rotation.x = -0.22
        }
      }
    } else if (tableGroup) {
      const loc = tableGroup.worldToLocal(hit)
      const c = clampToTable(loc.x, loc.z)
      localDrag.card.position.set(c.x, TABLE_CARD_Y + 0.06, c.z)
      localDrag.card.userData.baseY = TABLE_CARD_Y + 0.06
      localDrag.card.rotation.x = -Math.PI / 2
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
    card.userData.dragging = false
    // Remove from hand visually; server state will refresh
    handGroup?.remove(card)
    tableGroup.remove(card)
    card.geometry.dispose()
    handCards = handCards.filter((h) => h !== card)
    localDrag = null
    dragCb(null)
    playCb([text], [{ x: c.x, z: c.z, rotY }])
  }

  function endTableDrag() {
    if (!localDrag || localDrag.source !== 'table') return
    const card = localDrag.card
    const key = localDrag.cardKey || card.userData.cardKey || ''
    const x = card.position.x
    const z = card.position.z
    const rotY = localDrag.rotY
    card.userData.dragging = false
    card.userData.baseY = TABLE_CARD_Y
    card.position.y = TABLE_CARD_Y
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
      const hits = raycaster.intersectObjects(handCards, false)
      if (hits.length) {
        const card = hits[0].object as CardMesh
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
          rotY: (Math.random() - 0.5) * 0.3,
        }
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

    if (zone === 'table' || lookClose) {
      const hits = raycaster.intersectObjects(tableCards, false)
      if (hits.length) {
        const card = hits[0].object as CardMesh
        const key = card.userData.cardKey as string | undefined
        if (room.phase === 'voting') {
          // Start potential click-vote; may become drag if moved a lot — voting: click only
          localDrag = {
            source: 'table',
            card,
            cardText: card.userData.cardText,
            cardKey: key,
            pointerId: ev.pointerId,
            startX: ev.clientX,
            startY: ev.clientY,
            moved: false,
            rotY: card.userData.baseRotY || 0,
          }
          // Don't mark dragging yet — wait to see if it's a click
          try {
            ;(ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId)
          } catch {
            /* ignore */
          }
          ev.preventDefault()
          return
        }
        if (key && (room.phase === 'playing' || room.phase === 'revealing' || room.phase === 'scoring')) {
          card.userData.dragging = true
          localDrag = {
            source: 'table',
            card,
            cardText: card.userData.cardText,
            cardKey: key,
            pointerId: ev.pointerId,
            startX: ev.clientX,
            startY: ev.clientY,
            moved: false,
            rotY: card.userData.baseRotY || 0,
          }
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
  }

  function onPointerMove(ev: PointerEvent) {
    if (!camera || !threeRenderer || !root) return
    updatePointerFromEvent(ev)

    const tableAmount = THREE.MathUtils.clamp((0.48 - pointerScreenY) / 0.42, 0, 1)
    camBlend.center = lookClose ? Math.max(tableAmount, 0.9) : tableAmount
    if (tableAmount > 0.05 || lookClose) {
      camPanX.center = THREE.MathUtils.clamp(pointerNdc.x, -1, 1) * 0.85
      camPanZ.center = THREE.MathUtils.clamp(0.45 - pointerScreenY, -0.45, 0.45) * 0.55
    } else {
      camPanX.center = 0
      camPanZ.center = 0
    }

    if (localDrag && ev.pointerId === localDrag.pointerId) {
      const dx = ev.clientX - localDrag.startX
      const dy = ev.clientY - localDrag.startY
      if (Math.hypot(dx, dy) > CLICK_MOVE_PX) localDrag.moved = true

      if (room?.phase === 'voting' && localDrag.source === 'table' && !localDrag.card.userData.dragging) {
        // Voting: ignore drag motion for rearrange; keep as click candidate
        return
      }

      if (!localDrag.card.userData.dragging && localDrag.source === 'table' && localDrag.moved) {
        localDrag.card.userData.dragging = true
      }
      updateLocalDragPosition()
      return
    }

    const zone = lookClose ? 'table' : zoneFromPointer(pointerScreenY)
    raycaster.setFromCamera(pointer, camera)
    if (zone === 'hand' && !lookClose) {
      const hits = raycaster.intersectObjects(handCards.filter((c) => !c.userData.dragging), false)
      if (hits.length) setHover((hits[0].object as CardMesh).userData.index)
      else setHover(null)
    } else {
      const hits = raycaster.intersectObjects(tableCards.filter((c) => !c.userData.dragging), false)
      if (hits.length) setHover((hits[0].object as CardMesh).userData.index)
      else setHover(null)
    }
  }

  function onPointerUp(ev: PointerEvent) {
    if (!localDrag || ev.pointerId !== localDrag.pointerId) return
    updatePointerFromEvent(ev)
    const zone = lookClose ? 'table' : zoneFromPointer(pointerScreenY)

    if (room?.phase === 'voting' && localDrag.source === 'table') {
      const card = localDrag.card
      const wasClick = !localDrag.moved
      localDrag = null
      if (wasClick) {
        const pid = card.userData.submissionPlayerId
        if (pid && pid !== 'hidden' && pid !== localId) voteCb(pid)
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
    layoutHand(state.you?.hand || [])
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

    if (camera) {
      const t = camBlend.value
      const basePos = handCamPos.clone().lerp(tableCamPos, t)
      const baseTarget = handCamTarget.clone().lerp(tableCamTarget, t)
      const panStrength = Math.max(t, 0.2)
      basePos.x += camPanX.value * panStrength
      basePos.z += camPanZ.value * 0.35
      baseTarget.x += camPanX.value * panStrength * 0.95
      baseTarget.z += camPanZ.value * 0.25
      camera.position.copy(basePos)
      camera.lookAt(baseTarget)
      camera.fov = THREE.MathUtils.lerp(44, 38, t)
      camera.updateProjectionMatrix()
    }

    if (handGroup) {
      const handOpacity = 1 - camBlend.value
      handGroup.visible = handOpacity > 0.08
      handGroup.position.y = TABLE_Y + 0.05 - camBlend.value * 0.22
      handGroup.position.z = 0.78 + camBlend.value * 0.28
    }

    const inHandZone = !lookClose && zoneFromPointer(pointerScreenY) === 'hand'
    handCards.forEach((c, i) => {
      if (c.userData.dragging) return
      const hovered = hoveredIndex === i && inHandZone
      const sel = selected.has(c.userData.cardText)
      // Peek: lift height only, minimal tilt
      updateCardMotion(c, dt, hovered, sel, { lift: 0.09, tiltX: -0.04, tiltZ: 0.01 })
    })

    const inTableZone = lookClose || zoneFromPointer(pointerScreenY) === 'table'
    tableCards.forEach((c) => {
      if (c.userData.dragging) return
      const hovered = inTableZone && hoveredIndex === c.userData.index
      updateCardMotion(c, dt, hovered, false, { lift: 0.035, tiltX: 0 })
      c.rotation.x = c.userData.baseRotX
    })
    if (blackCard) {
      updateCardMotion(blackCard, dt, false, false)
      blackCard.rotation.x = blackCard.userData.baseRotX
    }

    const t = clock.elapsedTime
    const sitY = TABLE_Y - 0.55
    for (const [id, a] of avatars) {
      a.group.position.y = sitY + Math.sin(t * 1.1 + a.group.position.x * 2) * 0.008
      const hoverIdx = peerHover.get(id) ?? null
      const peekText = peerHoverText.get(id) ?? null
      const cards = peerHands.get(id)
      const count = Math.max(
        cards?.length || 0,
        Math.min(room?.players.find((p) => p.id === id)?.handCount || 7, 7),
      )
      layoutPeerHand(a, id, Math.max(count, 1), hoverIdx, peekText)
    }

    for (const [id, cards] of peerHands) {
      const hoverIdx = peerHover.get(id) ?? null
      cards.forEach((c, i) => {
        updateCardMotion(c, dt, hoverIdx === i, false, { lift: 0.1, tiltX: -0.06, tiltZ: 0.02 })
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
