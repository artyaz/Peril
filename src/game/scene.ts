/**
 * The world: renderer, seated camera, snapshot reconciliation, input, and the
 * frame loop.
 *
 * Free play: anyone can select, group, drag, place, and pick up cards at any
 * time once the table is open. The server owns ownership + table poses; local
 * input is applied immediately and confirmed by the next snapshot.
 */

import * as THREE from 'three'
import {
  MAX_SEATS,
  TABLE_RADIUS,
  TABLE_SURFACE_Y,
  TABLE_Y,
} from '../../shared/constants'
import type { CardPose, Presence, RoomSnapshot } from '../../shared/protocol'
import type { NetClient } from '../net/client'
import { damp, dampAngle, Spring } from '../spring'
import { EYE_HEIGHT } from './avatar'
import { createCard, revealFace, type Card } from './cards'
import { SeatManager } from './seats'
import { buildEnvironment, type Environment } from './table'

const DRAG_HEIGHT = TABLE_SURFACE_Y + 0.13
const PLAY_RADIUS = TABLE_RADIUS * 0.92
/** Drop inside this radius of your seat returns cards to your hand. */
const PICKUP_SEAT_RADIUS = 0.38

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
  private shiftHeld = false

  private hoveredCard: Card | null = null
  /** Primary card under the pointer when a drag begins. */
  private draggedCard: Card | null = null
  /** All cards moving together (selection group). */
  private dragGroup: Card[] = []
  private dragOffsets = new Map<string, THREE.Vector3>()
  private dragVel = new THREE.Vector3()
  private lastDragPos = new THREE.Vector3()
  private selected = new Set<string>()

  /** Hide the local fan from this client's viewport only. */
  fanHidden = false

  // Authoritative + locally predicted table cards, keyed by card id.
  private tableCards = new Map<string, Card>()
  // One reusable ghost per seat for remote drags.
  private ghosts = new Map<number, Card>()

  private clock = new THREE.Clock()
  private running = false
  /** Card ids we just placed/moved/picked — ignore conflicting snapshots briefly. */
  private pendingIds = new Set<string>()
  private pendingClearAt = 0

  onPlace: ((cards: CardPose[]) => void) | null = null
  onPickup: ((cardIds: string[]) => void) | null = null
  onMove: ((cards: CardPose[]) => void) | null = null

  constructor(container: HTMLElement, net: NetClient) {
    this.net = net

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    })
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
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  // -------------------------------------------------------------------------
  // Snapshot reconciliation
  // -------------------------------------------------------------------------

  applySnapshot(state: RoomSnapshot) {
    this.snapshot = state
    this.localSeat = state.you.seat

    if (performance.now() > this.pendingClearAt) this.pendingIds.clear()

    const occupied = new Set<number>()
    for (const p of state.players) {
      occupied.add(p.seat)
      const rig = this.seats.ensure(p.seat, p.name, p.avatarHue)
      rig.isLocal = p.seat === state.you.seat
      rig.avatar.setName(p.name)
      rig.avatar.setConnected(p.connected)
      rig.avatar.setHighlight(false)

      if (p.seat === state.you.seat) {
        // Never rebuild cards that are mid-drag or awaiting server confirmation —
        // that was the main source of fan/table flicker.
        const busy = new Set<string>([
          ...this.pendingIds,
          ...this.dragGroup.map((c) => c.state.id),
        ])
        if (this.draggedCard) busy.add(this.draggedCard.state.id)
        rig.syncHand({
          count: p.handCount,
          hand: state.you.hand,
          renderer: this.renderer,
          preserveIds: busy,
        })
        rig.fanAnchor.visible = !this.fanHidden
      } else {
        rig.syncHand({ count: p.handCount })
      }
    }
    this.seats.prune(occupied)

    this.syncTableCards(state)
  }

  private syncTableCards(state: RoomSnapshot) {
    const seen = new Set<string>()
    const dragging = new Set(this.dragGroup.map((c) => c.state.id))
    if (this.draggedCard) dragging.add(this.draggedCard.state.id)

    for (const tc of state.tableCards) {
      seen.add(tc.id)

      // Local prediction owns this card until the server catches up, or while
      // the player is actively dragging it — do not snap under the pointer.
      if (dragging.has(tc.id) || this.pendingIds.has(tc.id)) {
        let card = this.tableCards.get(tc.id)
        if (!card) {
          // Snapshot arrived before our local mesh was keyed — adopt any
          // in-hand card of the same id that we already pulled out.
          continue
        }
        if (!dragging.has(tc.id)) {
          card.state.pos.target(tc.x, TABLE_SURFACE_Y + 0.0018, tc.z)
          card.state.rot.target(-Math.PI / 2, tc.rotY, 0)
        }
        continue
      }

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

      card.state.selected = this.selected.has(tc.id)
      card.state.mode = 'table'
      card.state.interactive = true
      card.state.pos.target(tc.x, TABLE_SURFACE_Y + 0.0018, tc.z)
      card.state.rot.target(-Math.PI / 2, tc.rotY, 0)
    }

    for (const [id, card] of this.tableCards) {
      if (seen.has(id)) continue
      if (dragging.has(id) || this.pendingIds.has(id)) continue
      card.removeFromParent()
      this.tableCards.delete(id)
      this.selected.delete(id)
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

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Shift') this.shiftHeld = true
    if (e.repeat) return
    if (this.isTypingTarget(e.target)) return

    if (e.key === 'Escape') {
      this.clearSelection()
    } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      this.selectAllLocal()
      e.preventDefault()
    }
  }

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Shift') this.shiftHeld = false
  }

  private isTypingTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false
    const tag = t.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable
  }

  toggleFanHidden() {
    this.fanHidden = !this.fanHidden
    const rig = this.seats.get(this.localSeat)
    if (rig) rig.fanAnchor.visible = !this.fanHidden
  }

  private updatePointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  /** Local fan + every table card are interactive during free play. */
  private pickCard(): Card | null {
    this.raycaster.setFromCamera(this.pointer, this.camera)

    const candidates: THREE.Object3D[] = []
    const open = this.snapshot?.phase === 'open'
    const rig = this.seats.get(this.localSeat)
    if (rig && !this.fanHidden) {
      for (const c of rig.cards) {
        if (c.state.mode === 'fan' || c.state.mode === 'drag') candidates.push(c)
      }
    }
    if (open) {
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

    if (this.snapshot?.phase !== 'open') {
      this.orbiting = true
      return
    }

    const card = this.pickCard()
    if (card) {
      this.beginDrag(card)
      this.orbiting = false
    } else {
      if (!this.shiftHeld) this.clearSelection()
      this.orbiting = true
    }
  }

  private beginDrag(card: Card) {
    // Selection: shift toggles; otherwise select the clicked card (keep group
    // if it was already part of the selection so multi-drag works).
    if (this.shiftHeld) {
      this.toggleSelect(card)
    } else if (!this.selected.has(card.state.id)) {
      this.clearSelection()
      this.select(card)
    }

    const group = [...this.selected]
      .map((id) => this.findCard(id))
      .filter((c): c is Card => !!c)
    if (!group.includes(card)) group.push(card)

    this.draggedCard = card
    this.dragGroup = group
    this.dragOffsets.clear()

    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hitOk = this.raycaster.ray.intersectPlane(this.dragPlane, this.hit)

    for (const c of group) {
      c.state.mode = 'drag'
      c.state.hovered = false
      c.state.selected = true

      const world = new THREE.Vector3()
      c.getWorldPosition(world)
      this.scene.attach(c)
      c.state.pos.set(c.position.x, c.position.y, c.position.z)
      const eul = new THREE.Euler().setFromQuaternion(c.quaternion, 'XYZ')
      c.state.rot.set(eul.x, eul.y, eul.z)
      c.state.pos.tune(900, 46)
      c.state.rot.tune(320, 26)

      const offset = new THREE.Vector3()
      if (hitOk) {
        offset.copy(world).sub(this.hit)
        offset.y = 0
      }
      this.dragOffsets.set(c.state.id, offset)

      // Leave the fan roster so layout cannot fight the drag.
      const rig = this.seats.get(this.localSeat)
      if (rig) rig.cards = rig.cards.filter((x) => x !== c)
    }

    this.lastDragPos.copy(card.position)
    this.dragVel.set(0, 0, 0)
    this.renderer.domElement.style.cursor = 'grabbing'
  }

  private findCard(id: string): Card | null {
    const table = this.tableCards.get(id)
    if (table) return table
    const rig = this.seats.get(this.localSeat)
    return rig?.cards.find((c) => c.state.id === id) ?? null
  }

  private select(card: Card) {
    this.selected.add(card.state.id)
    card.state.selected = true
  }

  private toggleSelect(card: Card) {
    if (this.selected.has(card.state.id)) {
      this.selected.delete(card.state.id)
      card.state.selected = false
    } else {
      this.select(card)
    }
  }

  private clearSelection() {
    for (const id of this.selected) {
      const c = this.findCard(id)
      if (c) c.state.selected = false
    }
    this.selected.clear()
  }

  private selectAllLocal() {
    this.clearSelection()
    const rig = this.seats.get(this.localSeat)
    if (rig && !this.fanHidden) {
      for (const c of rig.cards) this.select(c)
    }
    for (const c of this.tableCards.values()) this.select(c)
  }

  private onPointerMove = (e: PointerEvent) => {
    this.updatePointer(e)
    if (Math.abs(e.clientX - this.downAt.x) + Math.abs(e.clientY - this.downAt.y) > 4) {
      this.pointerMoved = true
    }

    if (this.dragGroup.length && this.pointerDown) {
      this.raycaster.setFromCamera(this.pointer, this.camera)
      if (this.raycaster.ray.intersectPlane(this.dragPlane, this.hit)) {
        for (const c of this.dragGroup) {
          const offset = this.dragOffsets.get(c.state.id) ?? new THREE.Vector3()
          const target = this.hit.clone().add(offset)
          target.y = DRAG_HEIGHT
          c.state.pos.target(target.x, target.y, target.z)
          c.state.rot.target(-Math.PI / 2 + 0.16, c.state.rot.y.value, 0)
        }
      }
      return
    }

    if (this.pointerDown && this.orbiting && this.pointerMoved) {
      const dx = e.clientX - this.lastPointer.x
      const dy = e.clientY - this.lastPointer.y
      this.yawOffset = THREE.MathUtils.clamp(this.yawOffset - dx * 0.0032, -0.85, 0.85)
      this.pitchOffset = THREE.MathUtils.clamp(this.pitchOffset - dy * 0.0026, -0.42, 0.5)
      this.lastPointer = { x: e.clientX, y: e.clientY }
      return
    }

    const card = this.pickCard()
    if (this.hoveredCard && this.hoveredCard !== card) this.hoveredCard.state.hovered = false
    if (card && (card.state.mode === 'fan' || card.state.mode === 'table')) {
      card.state.hovered = true
      this.hoveredCard = card
      this.renderer.domElement.style.cursor = 'grab'
    } else {
      this.hoveredCard = null
      this.renderer.domElement.style.cursor = 'default'
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    this.renderer.domElement.releasePointerCapture?.(e.pointerId)

    if (this.dragGroup.length) {
      if (this.pointerMoved) {
        this.releaseGroup(this.dragGroup)
      } else {
        // Pure click — selection already applied in beginDrag; snap back if
        // we yanked a fan card into world space without moving.
        this.cancelDragNoMove(this.dragGroup)
      }
      this.draggedCard = null
      this.dragGroup = []
      this.dragOffsets.clear()
    }

    this.pointerDown = false
    this.orbiting = false
    this.renderer.domElement.style.cursor = 'default'
  }

  private cancelDragNoMove(group: Card[]) {
    const rig = this.seats.get(this.localSeat)
    for (const card of group) {
      const wasTable = this.tableCards.has(card.state.id)
      if (wasTable) {
        card.state.mode = 'table'
        this.env.centre.attach(card)
        card.state.pos.tune(300, 27)
        card.state.rot.tune(260, 25)
      } else if (rig) {
        card.state.mode = 'fan'
        rig.fanAnchor.attach(card)
        if (!rig.cards.includes(card)) rig.cards.push(card)
        card.state.pos.set(card.position.x, card.position.y, card.position.z)
        const eul = new THREE.Euler().setFromQuaternion(card.quaternion, 'XYZ')
        card.state.rot.set(eul.x, eul.y, eul.z)
      }
    }
  }

  private releaseGroup(group: Card[]) {
    if (!group.length) return

    const primary = this.draggedCard ?? group[0]
    const world = new THREE.Vector3()
    primary.getWorldPosition(world)
    const onTable = Math.hypot(world.x, world.z) < PLAY_RADIUS
    const nearSeat = this.isNearLocalSeat(world)

    const fromHand = group.filter((c) => !this.tableCards.has(c.state.id))
    const fromTable = group.filter((c) => this.tableCards.has(c.state.id))

    for (const card of group) {
      const st = card.state
      st.pos.tune(300, 27)
      st.rot.tune(260, 25)
    }

    // Prefer pickup when the drop is near your seat (even if still over the
    // table rim) — that is how you reclaim cards into the fan.
    if (nearSeat && !onTable) {
      this.returnGroupToHand(group)
      return
    }

    if (nearSeat && fromTable.length && fromHand.length === 0) {
      this.returnGroupToHand(group)
      return
    }

    if (onTable) {
      this.commitGroupToTable(group, fromHand, fromTable)
      return
    }

    // Off-table, not near seat: hand cards snap back; table cards stay put.
    if (fromHand.length) this.returnGroupToHand(fromHand)
    if (fromTable.length) this.commitGroupToTable(fromTable, [], fromTable)
  }

  private isNearLocalSeat(world: THREE.Vector3): boolean {
    const rig = this.seats.get(this.localSeat)
    if (!rig) return false
    const seat = new THREE.Vector3()
    rig.group.getWorldPosition(seat)
    return Math.hypot(world.x - seat.x, world.z - seat.z) < PICKUP_SEAT_RADIUS
  }

  private returnGroupToHand(group: Card[]) {
    const rig = this.seats.get(this.localSeat)
    if (!rig) return

    const fromTableIds: string[] = []

    for (const card of group) {
      const wasTable = this.tableCards.has(card.state.id)
      if (wasTable) {
        fromTableIds.push(card.state.id)
        this.tableCards.delete(card.state.id)
      }

      card.state.mode = 'fan'
      card.state.ownerSeat = this.localSeat
      rig.fanAnchor.attach(card)
      if (!rig.cards.includes(card)) rig.cards.push(card)
      card.state.pos.set(card.position.x, card.position.y, card.position.z)
      const eul = new THREE.Euler().setFromQuaternion(card.quaternion, 'XYZ')
      card.state.rot.set(eul.x, eul.y, eul.z)
      card.state.pos.impulse(this.dragVel.x * 0.25, this.dragVel.y * 0.25, this.dragVel.z * 0.25)

      this.pendingIds.add(card.state.id)
    }

    this.pendingClearAt = performance.now() + 600

    if (fromTableIds.length) this.onPickup?.(fromTableIds)
  }

  private commitGroupToTable(group: Card[], fromHand: Card[], fromTable: Card[]) {
    const poses: CardPose[] = []

    for (const card of group) {
      const st = card.state
      const floor = TABLE_SURFACE_Y + 0.0018
      // Light throw settle without a full ballistic sim (avoids fighting snaps).
      st.mode = 'table'
      st.interactive = true
      this.env.centre.attach(card)
      st.pos.target(card.position.x, floor, card.position.z)
      st.rot.target(-Math.PI / 2, card.rotation.y, 0)
      st.lift.value = 0.02
      st.lift.impulse(-0.45)
      this.tableCards.set(st.id, card)
      this.pendingIds.add(st.id)

      poses.push({
        id: st.id,
        x: st.pos.x.target,
        z: st.pos.z.target,
        rotY: st.rot.y.target,
      })
    }

    this.pendingClearAt = performance.now() + 600

    const handIds = new Set(fromHand.map((c) => c.state.id))
    const place = poses.filter((p) => handIds.has(p.id))
    const move = poses.filter((p) => !handIds.has(p.id))
    if (place.length) this.onPlace?.(place)
    if (move.length) this.onMove?.(move)

    // fromTable unused beyond move — kept for clarity at call sites.
    void fromTable
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
      eye.set(0, EYE_HEIGHT + 0.5, 1.5)
    }

    const focus = new THREE.Vector3(0, TABLE_Y + 0.06, 0)
    const dir = focus.clone().sub(eye).normalize()
    const baseYaw = Math.atan2(-dir.x, -dir.z)
    const basePitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1))

    const targetYaw = baseYaw + this.yawOffset
    const targetPitch = basePitch + this.pitchOffset

    this.camYaw = dampAngle(this.camYaw, targetYaw, 16, dt)
    this.camPitch = damp(this.camPitch, targetPitch, 16, dt)

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
    const dragging = this.dragGroup.length > 0
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

  private stepTableCards(dt: number) {
    for (const card of this.tableCards.values()) {
      if (card.state.mode === 'drag') continue
      const st = card.state
      st.pos.step(dt)
      st.rot.step(dt)
      st.lift.stepTo(0, dt)
      card.position.set(st.pos.x.value, st.pos.y.value + st.lift.value, st.pos.z.value)
      card.rotation.set(st.rot.x.value, st.rot.y.value, st.rot.z.value)
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

    if (this.dragGroup.length) {
      for (const card of this.dragGroup) {
        const st = card.state
        st.pos.step(dt)
        st.rot.step(dt)
        card.position.set(st.pos.x.value, st.pos.y.value, st.pos.z.value)
        card.rotation.set(st.rot.x.value, st.rot.y.value, st.rot.z.value)
      }
      const primary = this.draggedCard
      if (primary && dt > 0) {
        const next = primary.position.clone()
        this.dragVel.lerp(next.clone().sub(this.lastDragPos).divideScalar(dt), 0.35)
        this.lastDragPos.copy(next)
      }
    }

    this.updateGhosts(presence, dt)
    this.stepTableCards(dt)
    this.env.update(dt, now)

    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.stop()
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.seats.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
