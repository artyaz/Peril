/**
 * Seat rigs and the shared card fan.
 *
 * ── The important architectural point ──────────────────────────────────────
 *
 * A player's fan is a WORLD object. It hangs off `scene → seatRig → fanAnchor`,
 * at real coordinates around the table. It is emphatically NOT parented to the
 * camera.
 *
 * The previous build did `camera.add(handGroup)`, which pinned the hand to the
 * viewport. That looks fine in a screenshot and is wrong in every other way:
 * the cards existed only in the local player's view, so nobody could see anyone
 * else holding cards, a drag had no shared world position to replicate, and the
 * "table" was really seven separate private scenes that happened to agree on
 * the score.
 *
 * With the fan in world space:
 *   - every client renders every player's fan at identical coordinates;
 *   - a drag is a world position, so it replicates by sending three numbers;
 *   - occlusion, lighting and shadows are consistent for everyone;
 *   - the local player's fan is simply the one their camera happens to sit
 *     behind — no special case in the renderer.
 *
 * Card faces stay private because the fan is *tilted toward its owner* (so
 * peers physically see the backs) and, more importantly, because the server
 * never sends anyone else's card text. Geometry is a nicety; the wire format is
 * the actual guarantee.
 */

import * as THREE from 'three'
import {
  MAX_SEATS,
  SEAT_RADIUS,
  seatAngle,
  seatPosition,
} from '../../shared/constants'
import type { CardData, Presence } from '../../shared/protocol'
import { createAvatar, EYE_HEIGHT, type Avatar } from './avatar'
import { createCard, type Card } from './cards'
import { damp } from '../spring'

// --- Fan geometry (seat-local metres) --------------------------------------

/**
 * Height above the table surface at which cards are held.
 *
 * Tuned against the seated camera, not by eye: with EYE_HEIGHT 0.42 at seat
 * radius 0.95 and a 54° vertical FOV, the fan must sit high enough and close
 * enough that the full card height falls inside the lower half of the frame.
 * At FAN_Y 0.23 / FAN_Z −0.17 the bottom edge of the cards lands 28.3° below
 * the view axis against a 27° frame edge — i.e. visibly cropped. These values
 * put the cards between 0.7° and 22° below axis, which reads as "held in front
 * of me" with the table still in view above them.
 */
const FAN_Y = 0.3
/** How far in front of the seat the hand sits (−Z is toward the table). */
const FAN_Z = -0.14
/** Tilt so faces angle up toward their owner's eyes — and away from everyone else. */
const FAN_TILT = -0.62

/** Radius of the arc the cards sweep, measured from the grip point. */
const FAN_ARC_R = 0.27
const FAN_SPAN_PER_CARD = 0.132
const FAN_SPAN_MAX = 0.98
/** Depth stagger so overlapping cards never z-fight. */
const FAN_STAGGER = 0.0013

const HOVER_LIFT = 0.032
const HOVER_TOWARD = 0.026
const SELECT_LIFT = 0.055

export type FanSlot = {
  x: number
  y: number
  z: number
  rotX: number
  rotY: number
  rotZ: number
}

/**
 * Where card `i` of `n` sits inside the fan anchor.
 * Pure function of the index — every client computes the same answer, which is
 * why remote fans need no positional data on the wire at all.
 */
export function fanSlot(i: number, n: number, hover = 0, selected = false): FanSlot {
  const span = Math.min(FAN_SPAN_MAX, Math.max(1, n) * FAN_SPAN_PER_CARD)
  const t = n <= 1 ? 0.5 : i / (n - 1)
  const a = (t - 0.5) * span

  // Grip point sits below the cards, so the middle card rides highest.
  const x = Math.sin(a) * FAN_ARC_R
  const y = (Math.cos(a) - 1) * FAN_ARC_R + hover * HOVER_LIFT + (selected ? SELECT_LIFT : 0)
  const z = i * FAN_STAGGER + hover * HOVER_TOWARD

  return {
    x,
    y,
    z,
    rotX: hover * -0.14,
    rotY: 0,
    rotZ: -a,
  }
}

// ---------------------------------------------------------------------------

export class SeatRig {
  readonly seat: number
  readonly group = new THREE.Group()
  /** The global fan anchor. Lives in the scene graph, never on the camera. */
  readonly fanAnchor = new THREE.Group()
  readonly avatar: Avatar

  cards: Card[] = []
  private local = false
  private lastHover = -1

  /**
   * The local player's own avatar is hidden for them alone.
   *
   * The camera sits at this seat's eye point, and the avatar body occupies that
   * same spot — so without this you spend the game looking at the back of your
   * own head. Visibility is per-client, so peers still see you normally; only
   * your own render skips the mesh. Standard first-person practice, and free.
   */
  set isLocal(value: boolean) {
    this.local = value
    this.avatar.root.visible = !value
  }

  get isLocal(): boolean {
    return this.local
  }

  constructor(opts: {
    seat: number
    name: string
    hue: number
    seatCount: number
    parent: THREE.Object3D
  }) {
    this.seat = opts.seat

    const { x, z } = seatPosition(opts.seat, opts.seatCount, SEAT_RADIUS)
    this.group.position.set(x, 0, z)
    // rotation.y = θ points the rig's −Z at the table centre, so seat-local
    // −Z is "toward the table" and +X is the player's right, for every seat.
    this.group.rotation.y = seatAngle(opts.seat, opts.seatCount)

    this.avatar = createAvatar({ name: opts.name, hue: opts.hue, seat: opts.seat })
    this.group.add(this.avatar.root)

    this.fanAnchor.position.set(0, FAN_Y, FAN_Z)
    this.fanAnchor.rotation.x = FAN_TILT
    this.group.add(this.fanAnchor)

    opts.parent.add(this.group)
  }

  /** World-space eye position for this seat — used to place the local camera. */
  eyeWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, EYE_HEIGHT, 0.06).applyMatrix4(this.group.matrixWorld)
  }

  /**
   * Reconcile the fan against authoritative data.
   *
   * `hand` is present only for the local player. Remote seats get `count`
   * face-down cards — we cannot render text we were never sent, which is the
   * point.
   */
  syncHand(opts: {
    count: number
    hand?: CardData[]
    renderer?: THREE.WebGLRenderer
  }) {
    const target = opts.hand ? opts.hand.length : opts.count
    const local = !!opts.hand

    // Reuse existing meshes; only create/destroy the delta.
    if (local && opts.hand) {
      const byId = new Map(this.cards.map((c) => [c.state.id, c]))
      const next: Card[] = []
      for (const data of opts.hand) {
        const existing = byId.get(data.id)
        if (existing) {
          byId.delete(data.id)
          next.push(existing)
        } else {
          const card = createCard({
            id: data.id,
            text: data.text,
            ownerSeat: this.seat,
            faceVisible: true,
            renderer: opts.renderer,
          })
          card.state.interactive = true
          this.dealIn(card, next.length)
          next.push(card)
        }
      }
      for (const stale of byId.values()) stale.removeFromParent()
      this.cards = next
    } else {
      while (this.cards.length > target) {
        this.cards.pop()?.removeFromParent()
      }
      while (this.cards.length < target) {
        const card = createCard({
          id: `${this.seat}:back:${this.cards.length}`,
          text: '',
          ownerSeat: this.seat,
          faceVisible: false,
        })
        this.dealIn(card, this.cards.length)
        this.cards.push(card)
      }
    }

    this.cards.forEach((c, i) => {
      c.state.index = i
    })
  }

  /** Drop a new card in from above so dealing reads as a physical action. */
  private dealIn(card: Card, index: number) {
    this.fanAnchor.add(card)
    const slot = fanSlot(index, Math.max(this.cards.length + 1, 1))
    card.state.pos.set(slot.x, slot.y + 0.34, slot.z - 0.12)
    card.state.rot.set(slot.rotX - 0.5, slot.rotY, slot.rotZ + (Math.random() - 0.5) * 0.5)
    card.state.pos.y.velocity = -0.9
    card.position.set(card.state.pos.x.value, card.state.pos.y.value, card.state.pos.z.value)
  }

  /** Remote peek: lift whichever card the owner is hovering. */
  applyRemoteHover(hoverIndex: number) {
    if (hoverIndex === this.lastHover) return
    this.lastHover = hoverIndex
    this.cards.forEach((c, i) => {
      c.state.hovered = i === hoverIndex
    })
  }

  layout(dt: number) {
    const n = this.cards.length
    for (let i = 0; i < n; i++) {
      const card = this.cards[i]
      const st = card.state
      if (st.mode === 'drag' || st.mode === 'fly' || st.mode === 'table') continue

      st.hover = damp(st.hover, st.hovered ? 1 : 0, 14, dt)
      const slot = fanSlot(i, n, st.hover, st.selected)

      st.pos.target(slot.x, slot.y, slot.z)
      st.rot.target(slot.rotX, slot.rotY, slot.rotZ)
      st.pos.step(dt)
      st.rot.step(dt)

      card.position.set(st.pos.x.value, st.pos.y.value, st.pos.z.value)
      card.rotation.set(st.rot.x.value, st.rot.y.value, st.rot.z.value)

      const scale = 1 + st.hover * 0.09
      card.scale.setScalar(scale)
    }
  }

  update(dt: number, presence: Presence | null, now: number) {
    this.avatar.update(dt, presence?.headYaw ?? 0, presence?.headPitch ?? 0, now)
    if (presence) this.applyRemoteHover(presence.hoverIndex)
    this.layout(dt)
  }

  dispose() {
    for (const c of this.cards) c.removeFromParent()
    this.cards = []
    this.avatar.dispose()
    this.group.removeFromParent()
  }
}

// ---------------------------------------------------------------------------

/** Owns every seat rig and keeps the set in sync with the room roster. */
export class SeatManager {
  private rigs = new Map<number, SeatRig>()

  constructor(
    private readonly scene: THREE.Object3D,
    private readonly seatCount = MAX_SEATS,
  ) {}

  get(seat: number): SeatRig | undefined {
    return this.rigs.get(seat)
  }

  all(): SeatRig[] {
    return [...this.rigs.values()]
  }

  ensure(seat: number, name: string, hue: number): SeatRig {
    let rig = this.rigs.get(seat)
    if (!rig) {
      rig = new SeatRig({
        seat,
        name,
        hue,
        seatCount: this.seatCount,
        parent: this.scene,
      })
      this.rigs.set(seat, rig)
    }
    return rig
  }

  remove(seat: number) {
    this.rigs.get(seat)?.dispose()
    this.rigs.delete(seat)
  }

  /** Drop rigs for seats that are no longer occupied. */
  prune(occupied: Set<number>) {
    for (const seat of [...this.rigs.keys()]) {
      if (!occupied.has(seat)) this.remove(seat)
    }
  }

  dispose() {
    for (const rig of this.rigs.values()) rig.dispose()
    this.rigs.clear()
  }
}
