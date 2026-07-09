import * as THREE from 'three'
import { createCard, updateCardMotion, dropCard, CARD_W, type CardMesh } from './cards'
import { createAvatar, type AvatarHandle } from './avatar'
import { Spring, TweenManager, easeOutBack, easeOutCubic } from '../lib/motion'
import type { RoomState } from '../lib/protocol'

export type TableSceneApi = {
  mount: (el: HTMLElement) => void
  unmount: () => void
  setState: (state: RoomState, localPlayerId: string) => void
  setPeerHover: (playerId: string, cardIndex: number | null, cardText?: string | null) => void
  onPlayCards: (cards: string[]) => void
  onHoverCard: (index: number | null, text?: string | null) => void
  onVote: (submissionPlayerId: string) => void
  lookCloser: (on: boolean) => void
  resize: () => void
}

type SeatLayout = { position: THREE.Vector3; yaw: number }

/** Raised table — seated height, not floor level */
const TABLE_Y = 1.35

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
  let pointerScreenY = 0.72 // start in hand zone
  let playCb: (cards: string[]) => void = () => {}
  let hoverCb: (i: number | null, text?: string | null) => void = () => {}
  let voteCb: (id: string) => void = () => {}

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let tableGroup: THREE.Group | null = null
  let handGroup: THREE.Group | null = null
  let worldGroup: THREE.Group | null = null

  // Sitting at a raised table — bottom of screen = hand, top = overview
  // Pull back so a full hand fits; look slightly down at cards (not up from the floor)
  const handCamPos = new THREE.Vector3(0, TABLE_Y + 0.55, 1.45)
  const handCamTarget = new THREE.Vector3(0, TABLE_Y + 0.05, 0.55)
  const tableCamPos = new THREE.Vector3(0, TABLE_Y + 2.15, 1.75)
  const tableCamTarget = new THREE.Vector3(0, TABLE_Y + 0.02, -0.2)

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
      new THREE.CylinderGeometry(1.55, 1.6, 0.05, 64),
      new THREE.MeshStandardMaterial({ color: '#ecece8', roughness: 0.72, metalness: 0.04 }),
    )
    surface.receiveShadow = true
    surface.castShadow = true
    tableGroup.add(surface)

    // Soft pedestal fade under the surface
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.78, TABLE_Y * 0.88, 32, 1, true),
      new THREE.MeshStandardMaterial({
        color: '#d6d6d2',
        transparent: true,
        opacity: 0.2,
        roughness: 1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    pedestal.position.y = -TABLE_Y * 0.44
    tableGroup.add(pedestal)

    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(1.8, 48),
      new THREE.MeshBasicMaterial({ color: '#b0b0aa', transparent: true, opacity: 0.16 }),
    )
    blob.rotation.x = -Math.PI / 2
    blob.position.y = -TABLE_Y + 0.01
    tableGroup.add(blob)

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
    scene.add(handGroup)

    const canvas = threeRenderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', () => setHover(null))
    canvas.addEventListener('click', onClick)
    // Host captures pointer even when HUD sits on top (HUD uses pointer-events: none)
    el.addEventListener('pointermove', onPointerMove)

    resize()
    clock.start()
    loop()
  }

  function unmount() {
    cancelAnimationFrame(raf)
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
    if (threeRenderer) {
      threeRenderer.domElement.remove()
      threeRenderer.dispose()
    }
    threeRenderer = null
    scene = null
    camera = null
    root = null
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

  function layoutHand(texts: string[]) {
    if (!handGroup) return
    const same =
      handCards.length === texts.length &&
      handCards.every((c, i) => c.userData.cardText === texts[i])
    if (!same) {
      clearHand()
      texts.forEach((t, i) => {
        const card = createCard(t, 'white')
        card.userData.index = i
        card.rotation.order = 'YXZ'
        handGroup!.add(card)
        dropCard(card, 0.35, 0)
        card.userData.lift.velocity = -2.0 - i * 0.12
        handCards.push(card)
      })
    }

    const n = handCards.length
    // Fit hand to viewport: compact fan
    const spread = Math.min(0.22, 1.35 / Math.max(n, 1))
    const start = -((n - 1) * spread) / 2
    handCards.forEach((card, i) => {
      const mid = (n - 1) / 2
      card.position.x = start + i * spread
      card.position.z = 0.01 * Math.abs(i - mid)
      card.userData.baseY = 0
      // Face the player: readable text toward camera
      card.userData.baseRotX = -0.18
      card.userData.baseRotY = (i - mid) * -0.03
      card.userData.baseRotZ = (i - mid) * -0.012
      card.rotation.x = card.userData.baseRotX
      card.rotation.y = card.userData.baseRotY
      card.rotation.z = card.userData.baseRotZ
    })
    handGroup.position.set(0, TABLE_Y + 0.02, 0.88)
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
      card.scale.setScalar(0.9)
      const i = cards.length
      card.userData.index = i
      handle.handAnchor.add(card)
      cards.push(card)
    }

    const n = cards.length
    const spread = Math.min(0.1, 0.58 / Math.max(n, 1))
    const start = -((n - 1) * spread) / 2
    cards.forEach((card, i) => {
      const mid = (n - 1) / 2
      const isPeek = hoverIdx === i
      // Fan held toward table; peek lifts + tips face toward local player
      card.position.x = start + i * spread
      card.position.z = isPeek ? 0.14 : 0.025
      card.userData.baseY = isPeek ? 0.16 : 0.02
      card.userData.baseRotX = isPeek ? -0.5 : -1.2
      card.userData.baseRotY = (i - mid) * 0.04
      card.userData.baseRotZ = (i - mid) * 0.028
      if (hoverIdx != null && Math.abs(i - hoverIdx) === 1) {
        card.position.x += (i < hoverIdx ? -1 : 1) * 0.04
      }
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
    const local = players.find((p) => p.id === localPlayerId)
    const localSeat = local?.seat ?? 0
    const peers = players.filter((p) => p.id !== localPlayerId)
    // Place peers evenly around the far half of the table (always visible from local seat)
    const peerLayouts: SeatLayout[] = peers.map((_, i) => {
      const n = peers.length
      const t = n === 1 ? 0.5 : i / (n - 1)
      const angle = -Math.PI * 0.72 + t * Math.PI * 1.44 // ~west → north → east arc
      const dist = 1.85
      return {
        position: new THREE.Vector3(Math.sin(angle) * dist, 0, -Math.cos(angle) * dist),
        yaw: angle + Math.PI, // face table center
      }
    })
    void localSeat

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

    peers.forEach((p, i) => {
      const seat = peerLayouts[i]
      if (!seat) return

      let handle = avatars.get(p.id)
      // Sit so XP silhouette chest meets the raised table rim
      const sitY = TABLE_Y - 0.95
      if (!handle) {
        handle = createAvatar(p.name, p.faceDataUrl)
        avatars.set(p.id, handle)
        worldGroup!.add(handle.group)
        handle.group.position.set(seat.position.x, sitY - 0.4, seat.position.z)
        handle.group.rotation.y = seat.yaw
        const target = handle
        const fromY = sitY - 0.4
        tweens.tween(0.75, (v) => {
          target.group.position.y = fromY + v * 0.4
        }, easeOutBack)
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
      blackCard.position.set(0, 0.03, -0.38)
      blackCard.userData.baseY = 0.03
      blackCard.scale.setScalar(1.15)
      tableGroup.add(blackCard)
      dropCard(blackCard, 0.8, 0.035)
      blackCard.userData.lift.velocity = -2.5
    }
  }

  function syncSubmissions(state: RoomState) {
    if (!tableGroup) return
    const subs = state.submissions || []
    const sig = subs.map((s) => `${s.playerId}:${s.cards.join('|')}:${s.revealed}`).join(';')
    if (sig === tableGroup.userData.subSig && tableCards.length) return
    tableGroup.userData.subSig = sig
    clearTableCards()

    const n = subs.length
    const scale = 0.78
    subs.forEach((sub, i) => {
      // Arc in front of black card — leave the prompt clear
      const t = n === 1 ? 0.5 : i / (n - 1)
      const x = (t - 0.5) * 1.4
      const z = 0.38 + Math.abs(t - 0.5) * 0.1
      sub.cards.forEach((text, ci) => {
        const card = createCard(sub.revealed ? text : 'Peril', sub.revealed ? 'white' : 'back')
        card.scale.setScalar(scale)
        card.userData.baseRotX = -Math.PI / 2
        card.userData.baseRotY = (Math.sin(i * 7.1 + ci) * 0.5) * 0.16
        card.userData.baseRotZ = 0
        card.rotation.x = -Math.PI / 2
        card.rotation.y = card.userData.baseRotY
        const ox = x + (ci - (sub.cards.length - 1) / 2) * (CARD_W * scale * 0.75)
        card.position.set(ox, 0.03 + i * 0.002, z)
        card.userData.baseY = 0.03 + i * 0.002
        card.userData.index = i
        card.userData.cardText = sub.revealed ? text : '???'
        card.userData.submissionPlayerId = sub.playerId
        card.userData.selectable = state.phase === 'voting'
        tableGroup!.add(card)
        dropCard(card, 0.65 + i * 0.06, card.userData.baseY)
        card.userData.lift.velocity = -2.4
        tableCards.push(card)

        if (sub.revealed) {
          card.userData.baseRotX = Math.PI / 2
          card.rotation.x = Math.PI / 2
          const delay = i * 0.07 + ci * 0.04
          const start = performance.now()
          const tick = () => {
            const elapsed = (performance.now() - start) / 1000
            if (elapsed < delay) {
              requestAnimationFrame(tick)
              return
            }
            tweens.tween(0.4, (v) => {
              card.userData.baseRotX = Math.PI / 2 - v * Math.PI
              card.rotation.x = card.userData.baseRotX
            }, easeOutBack)
          }
          requestAnimationFrame(tick)
        }
      })
    })
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

  function zoneFromPointer(screenY: number) {
    // Bottom ~42% = hand; upper = table camera
    if (screenY > 0.58) return 'hand' as const
    return 'table' as const
  }

  function onPointerMove(ev: PointerEvent) {
    if (!camera || !threeRenderer || !root) return
    const rect = root.getBoundingClientRect()
    const nx = (ev.clientX - rect.left) / Math.max(rect.width, 1)
    const ny = (ev.clientY - rect.top) / Math.max(rect.height, 1)
    pointerScreenY = THREE.MathUtils.clamp(ny, 0, 1)
    pointerNdc.x = nx * 2 - 1
    pointerNdc.y = -(ny * 2 - 1)
    pointer.x = pointerNdc.x
    pointer.y = pointerNdc.y

    // Bottom = hand view; moving up blends to table overview + pan
    const tableAmount = THREE.MathUtils.clamp((0.72 - pointerScreenY) / 0.55, 0, 1)
    camBlend.center = lookClose ? Math.max(tableAmount, 0.9) : tableAmount
    if (tableAmount > 0.05 || lookClose) {
      camPanX.center = THREE.MathUtils.clamp(pointerNdc.x, -1, 1) * 1.35
      camPanZ.center = THREE.MathUtils.clamp(0.45 - pointerScreenY, -0.45, 0.45) * 1.05
    } else {
      camPanX.center = 0
      camPanZ.center = 0
    }

    const zone = lookClose ? 'table' : zoneFromPointer(pointerScreenY)
    raycaster.setFromCamera(pointer, camera)
    if (zone === 'hand' && !lookClose) {
      const hits = raycaster.intersectObjects(handCards, false)
      if (hits.length) setHover((hits[0].object as CardMesh).userData.index)
      else setHover(null)
    } else {
      const hits = raycaster.intersectObjects(tableCards, false)
      if (hits.length) setHover((hits[0].object as CardMesh).userData.index)
      else setHover(null)
    }
  }

  function onClick() {
    if (!room) return
    const zone = lookClose ? 'table' : zoneFromPointer(pointerScreenY)
    if (room.phase === 'playing' && zone === 'hand' && hoveredIndex != null && handCards[hoveredIndex]) {
      const text = handCards[hoveredIndex].userData.cardText
      const pick = room.blackCard?.pick || 1
      if (selected.has(text)) selected.delete(text)
      else {
        if (selected.size >= pick) selected.clear()
        selected.add(text)
      }
      selected = new Set(selected)
      const card = handCards[hoveredIndex]
      card.scale.set(1.05, 1.05, 1.05)
      tweens.tween(0.18, (v) => {
        const s = 1.05 - v * 0.05
        card.scale.set(s, s, s)
      }, easeOutCubic)
      if (selected.size === pick) playCb([...selected])
      return
    }
    if (room.phase === 'voting' && hoveredIndex != null) {
      const card = tableCards.find((c) => c.userData.index === hoveredIndex)
      const pid = card?.userData.submissionPlayerId
      if (pid && pid !== 'hidden' && pid !== localId) voteCb(pid)
    }
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
      // Pan is strongest when looking at the table
      const panStrength = Math.max(t, 0.2)
      basePos.x += camPanX.value * panStrength
      basePos.z += camPanZ.value * 0.65
      baseTarget.x += camPanX.value * panStrength * 0.95
      baseTarget.z += camPanZ.value * 0.45
      camera.position.copy(basePos)
      camera.lookAt(baseTarget)
      camera.fov = THREE.MathUtils.lerp(44, 36, t)
      camera.updateProjectionMatrix()
    }

    if (handGroup) {
      const handOpacity = 1 - camBlend.value
      handGroup.visible = handOpacity > 0.08
      handGroup.position.y = TABLE_Y + 0.02 - camBlend.value * 0.28
      handGroup.position.z = 0.88 + camBlend.value * 0.35
    }

    const inHandZone = !lookClose && zoneFromPointer(pointerScreenY) === 'hand'
    handCards.forEach((c, i) => {
      const hovered = hoveredIndex === i && inHandZone
      const sel = selected.has(c.userData.cardText)
      updateCardMotion(c, dt, hovered, sel, { lift: 0.1, tiltX: -0.2 })
    })

    const inTableZone = lookClose || zoneFromPointer(pointerScreenY) === 'table'
    tableCards.forEach((c) => {
      const hovered = inTableZone && hoveredIndex === c.userData.index
      updateCardMotion(c, dt, hovered, false, { lift: 0.035, tiltX: 0 })
      c.rotation.x = c.userData.baseRotX
    })
    if (blackCard) {
      updateCardMotion(blackCard, dt, false, false)
      blackCard.rotation.x = blackCard.userData.baseRotX
    }

    const t = clock.elapsedTime
    for (const [id, a] of avatars) {
      const sitY = TABLE_Y - 0.95
      a.group.position.y = sitY + Math.sin(t * 1.1 + a.group.position.x * 2) * 0.008
      const hoverIdx = peerHover.get(id) ?? null
      const peekText = peerHoverText.get(id) ?? null
      const cards = peerHands.get(id)
      if (cards) layoutPeerHand(a, id, cards.length, hoverIdx, peekText)
    }

    for (const [id, cards] of peerHands) {
      const hoverIdx = peerHover.get(id) ?? null
      cards.forEach((c, i) => {
        updateCardMotion(c, dt, hoverIdx === i, false, { lift: 0.14, tiltX: -0.28, tiltZ: 0.04 })
      })
    }

    if (threeRenderer && scene && camera) threeRenderer.render(scene, camera)
  }

  return {
    mount,
    unmount,
    setState,
    setPeerHover,
    lookCloser,
    resize,
    get onPlayCards() { return playCb },
    set onPlayCards(fn) { playCb = fn },
    get onHoverCard() { return hoverCb },
    set onHoverCard(fn) { hoverCb = fn },
    get onVote() { return voteCb },
    set onVote(fn) { voteCb = fn },
  }
}
