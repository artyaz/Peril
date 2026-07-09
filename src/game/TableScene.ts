import * as THREE from 'three'
import { createCard, updateCardMotion, dropCard, CARD_W, type CardMesh } from './cards'
import { createAvatar, type AvatarHandle } from './avatar'
import { Spring, TweenManager, easeOutBack, easeOutCubic } from '../lib/motion'
import type { RoomState } from '../lib/protocol'

export type TableSceneApi = {
  mount: (el: HTMLElement) => void
  unmount: () => void
  setState: (state: RoomState, localPlayerId: string) => void
  setPeerHover: (playerId: string, cardIndex: number | null) => void
  onPlayCards: (cards: string[]) => void
  onHoverCard: (index: number | null) => void
  onVote: (submissionPlayerId: string) => void
  lookCloser: (on: boolean) => void
  resize: () => void
}

type SeatLayout = { position: THREE.Vector3; yaw: number }

function seatLayouts(maxPlayers: number): SeatLayout[] {
  const dist = 2.35
  const all = [
    { position: new THREE.Vector3(0, 0, dist), yaw: Math.PI },
    { position: new THREE.Vector3(0, 0, -dist), yaw: 0 },
    { position: new THREE.Vector3(-dist, 0, 0), yaw: Math.PI / 2 },
    { position: new THREE.Vector3(dist, 0, 0), yaw: -Math.PI / 2 },
  ]
  return all.slice(0, Math.max(2, Math.min(4, maxPlayers)))
}

export function createTableScene(): TableSceneApi {
  let threeRenderer: THREE.WebGLRenderer | null = null
  let scene: THREE.Scene | null = null
  let camera: THREE.PerspectiveCamera | null = null
  let raf = 0
  let root: HTMLElement | null = null
  const clock = new THREE.Clock()
  const tweens = new TweenManager()

  const avatars = new Map<string, AvatarHandle>()
  const peerStacks = new Map<string, THREE.Group>()
  let handCards: CardMesh[] = []
  let tableCards: CardMesh[] = []
  let blackCard: CardMesh | null = null
  let localId = ''
  let room: RoomState | null = null
  let hoveredIndex: number | null = null
  let selected = new Set<string>()
  let peerHover = new Map<string, number | null>()
  let lookClose = false
  const camBlend = new Spring(0, 90, 14)
  let playCb: (cards: string[]) => void = () => {}
  let hoverCb: (i: number | null) => void = () => {}
  let voteCb: (id: string) => void = () => {}

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let tableGroup: THREE.Group | null = null
  let handGroup: THREE.Group | null = null
  let worldGroup: THREE.Group | null = null

  const fpPos = new THREE.Vector3(0, 1.35, 2.55)
  const fpTarget = new THREE.Vector3(0, 0.85, 0.2)
  const closePos = new THREE.Vector3(0, 2.45, 1.55)
  const closeTarget = new THREE.Vector3(0, 0.05, 0)

  function mount(el: HTMLElement) {
    root = el
    scene = new THREE.Scene()
    scene.background = new THREE.Color('#e6e6e2')
    scene.fog = new THREE.Fog('#e6e6e2', 8, 28)

    camera = new THREE.PerspectiveCamera(52, 1, 0.05, 60)
    camera.position.copy(fpPos)
    camera.lookAt(fpTarget)

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
    worldGroup.add(tableGroup)

    const surface = new THREE.Mesh(
      new THREE.CylinderGeometry(1.85, 1.9, 0.06, 64),
      new THREE.MeshStandardMaterial({ color: '#ecece8', roughness: 0.72, metalness: 0.04 }),
    )
    surface.position.y = 0.03
    surface.receiveShadow = true
    surface.castShadow = true
    tableGroup.add(surface)

    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(2.1, 48),
      new THREE.MeshBasicMaterial({ color: '#b8b8b2', transparent: true, opacity: 0.22 }),
    )
    blob.rotation.x = -Math.PI / 2
    blob.position.y = 0.002
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
    const rim = new THREE.DirectionalLight('#ffffff', 0.2)
    rim.position.set(0, 2, -5)
    scene.add(rim)

    handGroup = new THREE.Group()
    scene.add(handGroup)

    const canvas = threeRenderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', () => setHover(null))
    canvas.addEventListener('click', onClick)

    resize()
    clock.start()
    loop()
  }

  function unmount() {
    cancelAnimationFrame(raf)
    for (const a of avatars.values()) a.dispose()
    avatars.clear()
    for (const g of peerStacks.values()) {
      worldGroup?.remove(g)
    }
    peerStacks.clear()
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
        card.rotation.x = -0.95
        handGroup!.add(card)
        dropCard(card, 0.55, 0)
        // Stagger drop for addictive deal feel
        card.userData.lift.velocity = -2.2 - i * 0.15
        handCards.push(card)
      })
    }

    const n = handCards.length
    const spread = Math.min(0.72, 2.4 / Math.max(n, 1))
    const start = -((n - 1) * spread) / 2
    handCards.forEach((card, i) => {
      card.position.x = start + i * spread
      card.position.z = 0.02 * Math.abs(i - (n - 1) / 2)
      card.userData.baseY = 0
      card.rotation.y = (i - (n - 1) / 2) * -0.04
      card.rotation.x = -0.95
    })
    handGroup.position.set(0, 0.55, 1.55)
  }

  function ensurePeerStack(playerId: string, seat: SeatLayout, handCount: number) {
    if (!worldGroup) return
    let group = peerStacks.get(playerId)
    if (!group) {
      group = new THREE.Group()
      peerStacks.set(playerId, group)
      worldGroup.add(group)
      // Place stack toward table center from seat
      const inward = seat.position.clone().multiplyScalar(-1).normalize()
      group.position.copy(seat.position).addScaledVector(inward, 0.85)
      group.position.y = 0.08
      group.lookAt(0, 0.08, 0)
    }
    const existing = group.children.length
    if (existing === handCount) return
    while (group.children.length > handCount) {
      const c = group.children.pop() as CardMesh
      c.geometry.dispose()
      group.remove(c)
    }
    while (group.children.length < handCount) {
      const card = createCard('', 'back')
      card.scale.setScalar(0.72)
      const i = group.children.length
      card.position.set((i - 3) * 0.08, i * 0.004, 0)
      card.rotation.z = (i - 3) * 0.03
      card.userData.index = i
      card.userData.baseY = i * 0.004
      group.add(card)
    }
  }

  function syncAvatars(state: RoomState, localPlayerId: string) {
    if (!worldGroup) return
    const players = [...state.players].sort((a, b) => a.seat - b.seat)
    const local = players.find((p) => p.id === localPlayerId)
    const localSeat = local?.seat ?? 0
    const layouts = seatLayouts(state.maxPlayers)

    const needed = new Set(players.map((p) => p.id))
    for (const [id, a] of avatars) {
      if (!needed.has(id) || id === localPlayerId) {
        worldGroup.remove(a.group)
        a.dispose()
        avatars.delete(id)
      }
    }
    for (const [id, g] of peerStacks) {
      if (!needed.has(id) || id === localPlayerId) {
        worldGroup.remove(g)
        peerStacks.delete(id)
      }
    }

    for (const p of players) {
      if (p.id === localPlayerId) continue
      const rel = (p.seat - localSeat + state.maxPlayers) % state.maxPlayers
      const seat = layouts[rel] || layouts[1]
      if (!seat || rel === 0) continue

      let handle = avatars.get(p.id)
      if (!handle) {
        handle = createAvatar(p.name, p.faceDataUrl)
        avatars.set(p.id, handle)
        worldGroup.add(handle.group)
        handle.group.position.set(seat.position.x, -0.35, seat.position.z)
        handle.group.rotation.y = seat.yaw
        const target = handle
        const fromY = -0.35
        tweens.tween(0.75, (v) => {
          target.group.position.y = fromY + v * 0.35
        }, easeOutBack)
      } else {
        handle.setName(p.name)
        if (p.faceDataUrl) handle.setFace(p.faceDataUrl)
        handle.group.position.x = seat.position.x
        handle.group.position.z = seat.position.z
        handle.group.rotation.y = seat.yaw
      }
      handle.setHighlight(state.czarId === p.id)
      ensurePeerStack(p.id, seat, Math.min(p.handCount || 7, 7))
    }
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
      blackCard.position.set(0, 0.08, -0.15)
      blackCard.userData.baseY = 0.08
      tableGroup.add(blackCard)
      dropCard(blackCard, 1.35, 0.08)
      blackCard.userData.lift.velocity = -3
      tweens.tween(0.5, (v) => {
        if (!blackCard) return
        blackCard.rotation.z = (1 - v) * 0.4
      }, easeOutCubic)
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
    subs.forEach((sub, i) => {
      const angle = n === 1 ? -Math.PI / 2 : (i / n) * Math.PI * 2 - Math.PI / 2
      const radius = 0.9
      sub.cards.forEach((text, ci) => {
        const card = createCard(sub.revealed ? text : 'Peril', sub.revealed ? 'white' : 'back')
        if (!sub.revealed) card.rotation.x = Math.PI
        const x = Math.cos(angle) * radius + (ci - (sub.cards.length - 1) / 2) * (CARD_W * 0.55)
        const z = Math.sin(angle) * radius * 0.85
        card.position.set(x, 0.1, z)
        card.userData.baseY = 0.1
        card.userData.index = i
        card.userData.cardText = sub.revealed ? text : '???'
        ;(card.userData as { submissionPlayerId?: string }).submissionPlayerId = sub.playerId
        card.userData.selectable = state.phase === 'voting'
        tableGroup!.add(card)
        dropCard(card, 1.0 + i * 0.1 + ci * 0.05, 0.1)
        card.userData.lift.velocity = -2.8
        card.rotation.y = (Math.sin(i * 12.9898) * 0.5) * 0.25
        tableCards.push(card)

        if (sub.revealed) {
          // Flip reveal: start face-down then spring up
          card.rotation.x = Math.PI
          tweens.tween(0.35, (v) => {
            card.rotation.x = Math.PI * (1 - easeOutBack(v))
          }, (t) => t, undefined)
          // delay per card
          card.rotation.x = Math.PI
          const delay = i * 0.08 + ci * 0.05
          const start = performance.now()
          const tick = () => {
            const elapsed = (performance.now() - start) / 1000
            if (elapsed < delay) {
              requestAnimationFrame(tick)
              return
            }
            tweens.tween(0.42, (v) => {
              card.rotation.x = Math.PI * (1 - v)
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
    syncAvatars(state, localPlayerId)
    syncBlack(state)
    syncSubmissions(state)
    layoutHand(state.you?.hand || [])
    selected = new Set(state.you?.selected || [])
  }

  function setPeerHover(playerId: string, cardIndex: number | null) {
    peerHover.set(playerId, cardIndex)
    const stack = peerStacks.get(playerId)
    if (!stack) return
    stack.children.forEach((obj, i) => {
      const card = obj as CardMesh
      const lift = cardIndex === i ? 0.07 : cardIndex != null && Math.abs(i - cardIndex) === 1 ? 0.025 : 0
      card.userData.lift.center = lift
    })
    const a = avatars.get(playerId)
    if (a) a.group.scale.setScalar(cardIndex != null ? 1.025 : 1)
  }

  function setHover(index: number | null) {
    if (hoveredIndex === index) return
    hoveredIndex = index
    hoverCb(index)
  }

  function onPointerMove(ev: PointerEvent) {
    if (!camera || !threeRenderer) return
    const rect = threeRenderer.domElement.getBoundingClientRect()
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const targets = lookClose ? tableCards : handCards
    const hits = raycaster.intersectObjects(targets, false)
    if (hits.length) setHover((hits[0].object as CardMesh).userData.index)
    else setHover(null)
  }

  function onClick() {
    if (!room) return
    if (room.phase === 'playing' && hoveredIndex != null && handCards[hoveredIndex] && !lookClose) {
      const text = handCards[hoveredIndex].userData.cardText
      const pick = room.blackCard?.pick || 1
      if (selected.has(text)) selected.delete(text)
      else {
        if (selected.size >= pick) selected.clear()
        selected.add(text)
      }
      selected = new Set(selected)
      // Micro anticipation squash before commit
      const card = handCards[hoveredIndex]
      card.scale.set(1.04, 1, 1.04)
      tweens.tween(0.18, (v) => {
        const s = 1.04 - v * 0.04
        card.scale.set(s, 1, s)
      }, easeOutCubic)
      if (selected.size === pick) playCb([...selected])
      return
    }
    if (room.phase === 'voting' && hoveredIndex != null) {
      const card = tableCards.find((c) => c.userData.index === hoveredIndex)
      const pid = (card?.userData as { submissionPlayerId?: string }).submissionPlayerId
      if (pid && pid !== 'hidden' && pid !== localId) voteCb(pid)
    }
  }

  function lookCloser(on: boolean) {
    lookClose = on
  }

  function loop() {
    raf = requestAnimationFrame(loop)
    const dt = Math.min(clock.getDelta(), 0.05)
    tweens.update(dt)

    camBlend.animateTo(lookClose ? 1 : 0, dt)
    if (camera) {
      const t = camBlend.value
      camera.position.lerpVectors(fpPos, closePos, t)
      const target = fpTarget.clone().lerp(closeTarget, t)
      camera.lookAt(target)
      camera.fov = THREE.MathUtils.lerp(52, 40, t)
      camera.updateProjectionMatrix()
    }

    handCards.forEach((c, i) => {
      const hovered = hoveredIndex === i && !lookClose
      const sel = selected.has(c.userData.cardText)
      updateCardMotion(c, dt, hovered, sel)
      c.rotation.x = -0.95 + c.userData.tiltX.value
    })

    tableCards.forEach((c) => {
      const hovered = lookClose && hoveredIndex === c.userData.index
      updateCardMotion(c, dt, hovered, false)
    })
    if (blackCard) updateCardMotion(blackCard, dt, false, false)

    for (const stack of peerStacks.values()) {
      for (const obj of stack.children) {
        updateCardMotion(obj as CardMesh, dt, false, false)
      }
    }

    const t = clock.elapsedTime
    for (const a of avatars.values()) {
      a.group.position.y = Math.sin(t * 1.15 + a.group.position.x * 2) * 0.012
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
