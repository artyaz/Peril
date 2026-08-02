/**
 * The world: renderer, seated camera, snapshot reconciliation, input, and the
 * frame loop.
 *
 * Two rules keep the multiplayer honest:
 *
 *  1. The server owns truth. Everything drawn here is either an authoritative
 *     snapshot or an explicitly-labelled local prediction that the next
 *     snapshot is allowed to overwrite.
 *  2. Your own hand is never interpolated; everyone else's is. That asymmetry
 *     is the whole trick — your input feels instant, and their motion is smooth
 *     rather than 20 Hz steppy.
 */

import * as THREE from 'three'
import {
  MAX_SEATS,
  TABLE_RADIUS,
  TABLE_SURFACE_Y,
  TABLE_Y,
} from '../../shared/constants'
import type { Presence, RoomSnapshot } from '../../shared/protocol'
import type { NetClient } from '../net/client'
import { damp, dampAngle, Spring } from '../spring'
import { EYE_HEIGHT } from './avatar'
import { createCard, revealFace, type Card } from './cards'
import { SeatManager } from './seats'
import { buildEnvironment, type Environment } from './table'

const DRAG_HEIGHT = TABLE_SURFACE_Y + 0.13
const GRAVITY = -3.4
const PLAY_RADIUS = TABLE_RADIUS * 0.92

export class GameScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly seats: SeatManager
  private env: Environment

  private net: NetClient
  private snapshot: RoomSnapshot | null = null
  private localSeat = -1

  // Camera
  private yawOffset = 0
  private pitchOffset = 0
  private lean = new Spring(0, 90, 17)
  private camPos = new THREE.Vector3()
  private camYaw = 0
  private camPitch = 0

  // Input
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DRAG_HEIGHT)
  private hit = new THREE.Vector3()
  private pointerDown = false
  private pointerMoved = false
  private downAt = { x: 0, y: 0 }
  private lastPointer = { x: 0, y: 0 }
  private orbiting = false

  private hoveredCard: Card | null = null
  private draggedCard: Card | null = null
  private dragOffset = new THREE.Vector3()
  private dragVel = new THREE.Vector3()
  private lastDragPos = new THREE.Vector3()

  // Locally predicted cards in flight (server has not confirmed yet).
  private inFlight: Card[] = []
  // Authoritative table cards, keyed by card id.
  private tableCards = new Map<string, Card>()
  // Face-down markers for plays that are committed but not yet revealed.
  private playedMarkers = new Map<number, Card>()
  // One reusable ghost per seat for remote drags.
  private ghosts = new Map<number, Card>()

  private promptCard: Card | null = null
  private clock = new THREE.Clock()
  private running = false

  onPlay: ((cardIds: string[]) => void) | null = null
  onVote: ((submissionPlayerId: string) => void) | null = null

  constructor(container: HTMLElement, net: NetClient) {
    this.net = net

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    })
    // Cap at 2× — beyond that the cost is quadratic and the gain invisible.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.12
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(
      54,
      window.innerWidth / window.innerHeight,
      0.01,
      40,
    )
    this.camera.rotation.order = 'YXZ'
    this.scene.add(this.camera)

    this.env = buildEnvironment(this.scene)
    this.seats = new SeatManager(this.scene, MAX_SEATS)

    this.bindInput()
    window.addEventListener('resize', this.onResize)
  }

  // -------------------------------------------------------------------------
  // Snapshot reconciliation
  // -------------------------------------------------------------------------

  applySnapshot(state: RoomSnapshot) {
    const prev = this.snapshot
    this.snapshot = state
    this.localSeat = state.you.seat

    // --- Seats ---
    const occupied = new Set<number>()
    for (const p of state.players) {
      occupied.add(p.seat)
      const rig = this.seats.ensure(p.seat, p.name, p.avatarHue)
      rig.isLocal = p.seat === state.you.seat
      rig.avatar.setName(p.name)
      rig.avatar.setConnected(p.connected)
      rig.avatar.setHighlight(p.id === state.judgeId)

      if (p.seat === state.you.seat) {
        rig.syncHand({ count: p.handCount, hand: state.you.hand, renderer: this.renderer })
      } else {
        rig.syncHand({ count: p.handCount })
      }
    }
    this.seats.prune(occupied)

    // --- Prompt ---
    this.syncPrompt(state)

    // --- Played markers (committed, not yet revealed) ---
    this.syncPlayedMarkers(state)

    // --- Authoritative table cards (judging onward) ---
    this.syncTableCards(state)

    // A new round clears local prediction leftovers.
    if (prev && prev.round !== state.round) {
      for (const c of this.inFlight) c.removeFromParent()
      this.inFlight = []
    }
  }

  private syncPrompt(state: RoomSnapshot) {
    if (!state.prompt) {
      this.promptCard?.removeFromParent()
      this.promptCard = null
      return
    }
    if (this.promptCard && this.promptCard.state.text === state.prompt.text) return

    this.promptCard?.removeFromParent()
    const card = createCard({
      id: 'prompt',
      text: state.prompt.text,
      ownerSeat: -1,
      faceVisible: true,
      variant: 'prompt',
      renderer: this.renderer,
    })
    // Lies flat at the centre, angled so it is legible from every seat about
    // equally — a shared object, not oriented to any one player.
    card.position.set(0, TABLE_SURFACE_Y + 0.001, 0.13)
    card.rotation.set(-Math.PI / 2, 0, 0)
    card.scale.setScalar(1.35)
    card.state.pos.set(card.position.x, card.position.y, card.position.z)
    card.state.rot.set(card.rotation.x, 0, 0)
    card.state.mode = 'table'
    this.env.centre.add(card)
    this.promptCard = card
  }

  private syncPlayedMarkers(state: RoomSnapshot) {
    const shouldShow = state.phase === 'playing'
    for (const p of state.players) {
      const want = shouldShow && p.hasPlayed
      const existing = this.playedMarkers.get(p.seat)
      if (want && !existing) {
        const card = createCard({
          id: `played:${p.seat}`,
          text: '',
          ownerSeat: p.seat,
          faceVisible: false,
        })
        // Rest it on the felt in front of its author, face-down.
        const a = (p.seat / MAX_SEATS) * Math.PI * 2
        const r = TABLE_RADIUS * 0.56
        card.position.set(Math.sin(a) * r, TABLE_SURFACE_Y + 0.0015, Math.cos(a) * r)
        card.rotation.set(-Math.PI / 2, -a, 0)
        card.state.mode = 'table'
        card.state.pos.set(card.position.x, card.position.y, card.position.z)
        card.state.rot.set(card.rotation.x, card.rotation.y, 0)
        card.state.lift.value = 0.05
        card.state.lift.impulse(-0.9)
        this.env.centre.add(card)
        this.playedMarkers.set(p.seat, card)
      } else if (!want && existing) {
        existing.removeFromParent()
        this.playedMarkers.delete(p.seat)
      }
    }
  }

  private syncTableCards(state: RoomSnapshot) {
    const seen = new Set<string>()

    for (const tc of state.tableCards) {
      seen.add(tc.id)
      let card = this.tableCards.get(tc.id)
      if (!card) {
        card = createCard({
          id: tc.id,
          text: tc.text,
          ownerSeat: tc.ownerSeat,
          faceVisible: tc.faceUp && !!tc.text,
          renderer: this.renderer,
        })
        card.state.mode = 'table'
        card.state.interactive = true
        // Fly in from the owner's side rather than materialising.
        const a = (tc.ownerSeat / MAX_SEATS) * Math.PI * 2
        card.position.set(
          Math.sin(a) * TABLE_RADIUS * 0.8,
          TABLE_SURFACE_Y + 0.09,
          Math.cos(a) * TABLE_RADIUS * 0.8,
        )
        card.rotation.set(-Math.PI / 2, tc.rotY, 0)
        card.state.pos.set(card.position.x, card.position.y, card.position.z)
        card.state.rot.set(-Math.PI / 2, tc.rotY, 0)
        this.env.centre.add(card)
        this.tableCards.set(tc.id, card)
      } else if (tc.faceUp && tc.text && !card.state.faceVisible) {
        revealFace(card, tc.text, 'response', this.renderer)
      }

      card.state.pos.target(tc.x, TABLE_SURFACE_Y + 0.0018, tc.z)
      card.state.rot.target(-Math.PI / 2, tc.rotY, 0)
    }

    for (const [id, card] of this.tableCards) {
      if (!seen.has(id)) {
        card.removeFromParent()
        this.tableCards.delete(id)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private bindInput() {
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointercancel', this.onPointerUp)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  private updatePointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  /** Only the local fan and revealed table cards are ever interactive. */
  private pickCard(): Card | null {
    this.raycaster.setFromCamera(this.pointer, this.camera)

    const candidates: THREE.Object3D[] = []
    const rig = this.seats.get(this.localSeat)
    if (rig) for (const c of rig.cards) candidates.push(c)
    if (this.snapshot?.phase === 'judging' && this.snapshot.you.isJudge) {
      for (const c of this.tableCards.values()) candidates.push(c)
    }
    if (!candidates.length) return null

    const hits = this.raycaster.intersectObjects(candidates, true)
    if (!hits.length) return null

    let obj: THREE.Object3D | null = hits[0].object
    while (obj) {
      if ((obj as Card).state) return obj as Card
      obj = obj.parent
    }
    return null
  }

  private onPointerDown = (e: PointerEvent) => {
    this.updatePointer(e)
    this.pointerDown = true
    this.pointerMoved = false
    this.downAt = { x: e.clientX, y: e.clientY }
    this.lastPointer = { x: e.clientX, y: e.clientY }
    this.renderer.domElement.setPointerCapture?.(e.pointerId)

    const card = this.pickCard()
    const canPlay =
      this.snapshot?.phase === 'playing' &&
      !this.snapshot.you.isJudge &&
      !this.snapshot.players.find((p) => p.seat === this.localSeat)?.hasPlayed

    if (card && card.state.ownerSeat === this.localSeat && canPlay) {
      this.beginDrag(card)
      this.orbiting = false
    } else {
      this.orbiting = true
    }
  }

  private beginDrag(card: Card) {
    this.draggedCard = card
    card.state.mode = 'drag'
    card.state.hovered = false

    const world = new THREE.Vector3()
    card.getWorldPosition(world)

    // Reparent to the scene so the drag lives in world space — which is also
    // exactly the space we broadcast, so peers see the same motion.
    this.scene.attach(card)
    card.state.pos.set(card.position.x, card.position.y, card.position.z)
    const e = new THREE.Euler().setFromQuaternion(card.quaternion, 'XYZ')
    card.state.rot.set(e.x, e.y, e.z)
    card.state.pos.tune(900, 46)
    card.state.rot.tune(320, 26)

    this.raycaster.setFromCamera(this.pointer, this.camera)
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.hit)) {
      this.dragOffset.copy(world).sub(this.hit)
      this.dragOffset.y = 0
    } else {
      this.dragOffset.set(0, 0, 0)
    }
    this.lastDragPos.copy(world)
    this.dragVel.set(0, 0, 0)
    this.renderer.domElement.style.cursor = 'grabbing'
  }

  private onPointerMove = (e: PointerEvent) => {
    this.updatePointer(e)
    if (Math.abs(e.clientX - this.downAt.x) + Math.abs(e.clientY - this.downAt.y) > 4) {
      this.pointerMoved = true
    }

    if (this.draggedCard && this.pointerDown) {
      this.raycaster.setFromCamera(this.pointer, this.camera)
      if (this.raycaster.ray.intersectPlane(this.dragPlane, this.hit)) {
        const target = this.hit.clone().add(this.dragOffset)
        target.y = DRAG_HEIGHT
        const st = this.draggedCard.state
        st.pos.target(target.x, target.y, target.z)
        // Cards lie flat as they approach the felt — reads as "placing", not
        // "sliding a billboard around".
        st.rot.target(-Math.PI / 2 + 0.16, st.rot.y.value, 0)
      }
      return
    }

    if (this.pointerDown && this.orbiting && this.pointerMoved) {
      const dx = e.clientX - this.lastPointer.x
      const dy = e.clientY - this.lastPointer.y
      // Look around from a fixed head position — this is a seat at a table,
      // not a free-flying camera.
      this.yawOffset = THREE.MathUtils.clamp(this.yawOffset - dx * 0.0032, -0.85, 0.85)
      this.pitchOffset = THREE.MathUtils.clamp(this.pitchOffset - dy * 0.0026, -0.42, 0.5)
      this.lastPointer = { x: e.clientX, y: e.clientY }
      return
    }

    const card = this.pickCard()
    if (this.hoveredCard && this.hoveredCard !== card) this.hoveredCard.state.hovered = false
    if (card && card.state.mode === 'fan') {
      card.state.hovered = true
      this.hoveredCard = card
      this.renderer.domElement.style.cursor = 'grab'
    } else {
      this.hoveredCard = null
      this.renderer.domElement.style.cursor = card ? 'pointer' : 'default'
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    this.renderer.domElement.releasePointerCapture?.(e.pointerId)

    if (this.draggedCard) {
      this.releaseCard(this.draggedCard)
      this.draggedCard = null
    } else if (!this.pointerMoved) {
      // A click (not a drag) during judging is a vote.
      const card = this.pickCard()
      if (card && this.snapshot?.phase === 'judging') {
        const owner = this.snapshot.players.find((p) => p.seat === card.state.ownerSeat)
        if (owner) this.onVote?.(owner.id)
      }
    }

    this.pointerDown = false
    this.orbiting = false
    this.renderer.domElement.style.cursor = 'default'
  }

  private releaseCard(card: Card) {
    const st = card.state
    const world = new THREE.Vector3()
    card.getWorldPosition(world)
    const dist = Math.hypot(world.x, world.z)

    st.pos.tune(300, 27)
    st.rot.tune(260, 25)

    if (dist < PLAY_RADIUS) {
      // Predict the play: throw it, tell the server, let the snapshot confirm.
      st.mode = 'fly'
      st.vel.copy(this.dragVel).clampLength(0, 2.6)
      st.vel.y = Math.max(st.vel.y, 0.25)
      st.spin.set(
        (Math.random() - 0.5) * 1.2,
        this.dragVel.x * 0.9,
        (Math.random() - 0.5) * 1.4,
      )
      this.inFlight.push(card)

      const rig = this.seats.get(this.localSeat)
      if (rig) rig.cards = rig.cards.filter((c) => c !== card)
      this.onPlay?.([st.id])
    } else {
      // Not over the table — return to the fan, keeping the throw's momentum
      // so the snap-back feels elastic rather than teleported.
      const rig = this.seats.get(this.localSeat)
      if (rig) {
        st.mode = 'fan'
        rig.fanAnchor.attach(card)
        st.pos.set(card.position.x, card.position.y, card.position.z)
        const e = new THREE.Euler().setFromQuaternion(card.quaternion, 'XYZ')
        st.rot.set(e.x, e.y, e.z)
        st.pos.impulse(this.dragVel.x * 0.4, this.dragVel.y * 0.4, this.dragVel.z * 0.4)
      }
    }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.lean.target = THREE.MathUtils.clamp(this.lean.target - e.deltaY * 0.0008, -0.18, 0.34)
  }

  private onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  private updateCamera(dt: number) {
    const rig = this.seats.get(this.localSeat)
    const lean = this.lean.step(dt)

    const eye = new THREE.Vector3()
    if (rig) {
      rig.group.updateWorldMatrix(true, false)
      rig.eyeWorld(eye)
    } else {
      // Spectating / lobby: hover above the table looking down.
      eye.set(0, EYE_HEIGHT + 0.5, 1.5)
    }

    // Face the table centre, then apply the player's look-around.
    const focus = new THREE.Vector3(0, TABLE_Y + 0.06, 0)
    const dir = focus.clone().sub(eye).normalize()
    const baseYaw = Math.atan2(-dir.x, -dir.z)
    const basePitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1))

    const targetYaw = baseYaw + this.yawOffset
    const targetPitch = basePitch + this.pitchOffset

    this.camYaw = dampAngle(this.camYaw, targetYaw, 16, dt)
    this.camPitch = damp(this.camPitch, targetPitch, 16, dt)

    // Lean moves the head along its own forward axis.
    const forward = new THREE.Vector3(
      -Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      -Math.cos(this.camYaw) * Math.cos(this.camPitch),
    )
    this.camPos.copy(eye).addScaledVector(forward, lean)

    this.camera.position.copy(this.camPos)
    this.camera.rotation.set(this.camPitch, this.camYaw, 0, 'YXZ')
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  private publishPresence() {
    const dragging = !!this.draggedCard
    const drag = this.draggedCard
    this.net.setPresence({
      seat: this.localSeat,
      headYaw: this.yawOffset,
      headPitch: this.pitchOffset,
      hoverIndex: this.hoveredCard ? this.hoveredCard.state.index : -1,
      dragging,
      pointing: this.pointerDown && !dragging,
      dragX: drag ? drag.position.x : 0,
      dragY: drag ? drag.position.y : 0,
      dragZ: drag ? drag.position.z : 0,
      dragRotY: drag ? drag.rotation.y : 0,
    })
  }

  /** Render other players' live drags as world-space ghost cards. */
  private updateGhosts(presence: Map<number, Presence>, dt: number) {
    for (const [seat, p] of presence) {
      if (seat === this.localSeat) continue
      let ghost = this.ghosts.get(seat)

      if (p.dragging) {
        if (!ghost) {
          ghost = createCard({
            id: `ghost:${seat}`,
            text: '',
            ownerSeat: seat,
            faceVisible: false,
          })
          ghost.state.mode = 'table'
          this.scene.add(ghost)
          ghost.position.set(p.dragX, p.dragY, p.dragZ)
          this.ghosts.set(seat, ghost)
        }
        ghost.visible = true
        // Already interpolated upstream; a light damp absorbs quantisation steps.
        ghost.position.x = damp(ghost.position.x, p.dragX, 22, dt)
        ghost.position.y = damp(ghost.position.y, p.dragY, 22, dt)
        ghost.position.z = damp(ghost.position.z, p.dragZ, 22, dt)
        ghost.rotation.x = damp(ghost.rotation.x, -Math.PI / 2 + 0.16, 18, dt)
        ghost.rotation.y = dampAngle(ghost.rotation.y, p.dragRotY, 18, dt)
      } else if (ghost) {
        ghost.visible = false
      }
    }
  }

  // -------------------------------------------------------------------------
  // Physics
  // -------------------------------------------------------------------------

  private stepFlying(dt: number) {
    for (let i = this.inFlight.length - 1; i >= 0; i--) {
      const card = this.inFlight[i]
      const st = card.state

      st.vel.y += GRAVITY * dt
      card.position.addScaledVector(st.vel, dt)
      card.rotation.x += st.spin.x * dt
      card.rotation.y += st.spin.y * dt
      card.rotation.z += st.spin.z * dt

      const floor = TABLE_SURFACE_Y + 0.0016
      if (card.position.y <= floor) {
        card.position.y = floor
        st.mode = 'table'
        st.pos.set(card.position.x, floor, card.position.z)
        // Settle flat with whatever heading it happened to land on.
        st.rot.set(card.rotation.x, card.rotation.y, card.rotation.z)
        st.rot.target(-Math.PI / 2, card.rotation.y, 0)
        st.rot.tune(240, 22)
        st.pos.target(card.position.x, floor, card.position.z)
        st.lift.value = 0.02
        st.lift.impulse(-0.5)
        this.inFlight.splice(i, 1)
        this.tableCards.set(`local:${st.id}`, card)
      }
    }
  }

  private stepTableCards(dt: number) {
    for (const card of this.tableCards.values()) {
      const st = card.state
      st.pos.step(dt)
      st.rot.step(dt)
      st.lift.stepTo(0, dt)
      card.position.set(st.pos.x.value, st.pos.y.value + st.lift.value, st.pos.z.value)
      card.rotation.set(st.rot.x.value, st.rot.y.value, st.rot.z.value)
    }
    for (const card of this.playedMarkers.values()) {
      const st = card.state
      st.lift.stepTo(0, dt)
      card.position.y = st.pos.y.value + st.lift.value
    }
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    this.clock.start()
    const frame = () => {
      if (!this.running) return
      requestAnimationFrame(frame)
      this.frame()
    }
    requestAnimationFrame(frame)
  }

  stop() {
    this.running = false
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 1 / 20)
    const now = performance.now()

    this.updateCamera(dt)
    this.publishPresence()

    const presence = this.net.samplePresence()

    for (const rig of this.seats.all()) {
      const p = rig.seat === this.localSeat ? null : presence.get(rig.seat) ?? null
      rig.update(dt, p, now)
    }

    if (this.draggedCard) {
      const st = this.draggedCard.state
      st.pos.step(dt)
      st.rot.step(dt)
      const next = new THREE.Vector3(st.pos.x.value, st.pos.y.value, st.pos.z.value)
      // Velocity for the throw, smoothed so one jittery frame cannot launch it.
      if (dt > 0) {
        this.dragVel.lerp(next.clone().sub(this.lastDragPos).divideScalar(dt), 0.35)
      }
      this.lastDragPos.copy(next)
      this.draggedCard.position.copy(next)
      this.draggedCard.rotation.set(st.rot.x.value, st.rot.y.value, st.rot.z.value)
    }

    this.updateGhosts(presence, dt)
    this.stepFlying(dt)
    this.stepTableCards(dt)
    this.env.update(dt, now)

    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.stop()
    window.removeEventListener('resize', this.onResize)
    this.seats.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
