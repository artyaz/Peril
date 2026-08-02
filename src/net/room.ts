/**
 * room.ts — the authoritative table.
 *
 * One `World`, the players sitting at it, and the rule that every card in a
 * hand is *server* state. There is no transport in this file and no timer: the
 * caller feeds it decoded intents, calls `step()`, and asks for messages to
 * send. That is what lets it run in a test, in a Node process on Fly.io, or in
 * the same tab as the renderer, without any of them knowing about the others.
 *
 * Three things it exists to guarantee, none of which a relay can:
 *
 *  - **Arbitration.** Two players reaching for the same card is decided here,
 *    once, and the loser is told why. A relay has nowhere to make that call.
 *
 *  - **Hidden hands.** A hand is a list of `CardId`s held in this file. What
 *    goes out over the wire for everyone else is a count and the fan's
 *    geometry, which the room derives from public data alone. The identities
 *    are not filtered out of the broadcast — they were never in it.
 *
 *  - **Legality.** Intents are checked against the world before they touch it:
 *    unknown bodies, pinch points nowhere near the card they claim, hand slots
 *    that do not exist, coordinates that are NaN. A client is a source of
 *    requests, never of positions.
 *
 * Determinism is inherited from the solver and then deliberately not spent:
 * fixed steps only, no wall clock, no `Math.random` — throws come from the
 * room's seeded generator, exactly as the single-player build does it. Two
 * rooms given the same intents produce the same checksum, which is what makes
 * a desync detectable rather than a rumour.
 */

import { World, BodyMode, TUNING, type Body, type V3, type Q4, type TableSpec } from '../physics.ts'
import { makeRandom, planPlayThrow, quatMul, type FlightModel } from '../gameplay.ts'
import {
  EventKind,
  MsgType,
  PROTOCOL_VERSION,
  RejectReason,
  type AvatarPose,
  type BodyState,
  type CardId,
  type ClientMessage,
  type EventMessage,
  type HandUpdateMessage,
  type PlayerId,
  type PlayerListMessage,
  type PublicPlayerState,
  type RejectReasonValue,
  type RoomInfo,
  type SnapshotMessage,
  type Transform,
  type WelcomeMessage,
} from './protocol.ts'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Card size and table, restated rather than imported.
 *
 * `card.ts` owns these numbers for the renderer, but it also builds an
 * `ExtrudeGeometry` at module load and pulls in Three — neither of which
 * belongs in a headless server process. The values are the real ones a playing
 * card has (63x88x0.35mm, 1.8g) and they are on the wire in `Welcome`, so a
 * client that disagrees finds out at connect time instead of drifting.
 */
export const DEFAULT_CARD_HALF: V3 = { x: 0.0315, y: 0.044, z: 0.000175 }
export const DEFAULT_CARD_MASS = 0.0018

export const DEFAULT_TABLE: TableSpec = {
  surfaceY: 0,
  radius: 0.62,
  railRadius: 0.616,
  railTopY: 0.018,
  floorY: -0.55,
}

/**
 * The fan, mirroring the client's camera-space `slotTransform` exactly.
 *
 * It has to be the same shape on both ends: the launch point of a played card
 * is the slot it came out of, so a server fan that sat somewhere else would
 * throw every card from a position the player never saw.
 */
export interface FanLayout {
  /** Anchor relative to the eye: in front and below, as the client has it. */
  pivot: V3
  radius: number
  /** Radians per card, and the ceiling on the total spread. */
  arcPerCard: number
  arcMax: number
  /** How much the arc is flattened, so the outer cards do not sag out of view. */
  droop: number
  /** Depth stagger per card, so the fan reads back to front. */
  stagger: number
  /** Tilt of each card about the fan's right axis. */
  tilt: number
}

export const DEFAULT_FAN: FanLayout = {
  pivot: { x: 0, y: -0.43, z: -0.36 },
  radius: 0.3,
  arcPerCard: 0.12,
  arcMax: 0.82,
  droop: 0.45,
  stagger: 0.0012,
  tilt: -0.22,
}

export interface RoomOptions {
  name?: string
  seed?: number
  maxPlayers?: number
  maxHandCards?: number
  /** Ticks between snapshots. 8 at 240Hz is the 30Hz the design calls for. */
  snapshotInterval?: number
  table?: TableSpec
  cardHalf?: V3
  cardMass?: number
  fan?: FanLayout
  /** Where a seat's eye sits, relative to the felt. */
  eyeHeight?: number
  seatRadius?: number
}

export type JoinResult =
  | { ok: true; playerId: PlayerId; welcome: WelcomeMessage }
  | { ok: false; reason: RejectReasonValue }

/** `to: BROADCAST` means every player; anything else is a single recipient. */
export const BROADCAST = 0

export interface OutboundEvent {
  to: PlayerId
  message: EventMessage
}

// ---------------------------------------------------------------------------
// Internal records
// ---------------------------------------------------------------------------

/** Number of float32s per body on the wire, and therefore in the change test. */
const WIRE_FLOATS = 13

interface CardBody {
  body: Body
  /**
   * What this body actually is, bottom card first. A stack is one body, so it
   * is one entry here with many identities — and the order is the order of the
   * pile, which is precisely the thing no client may see.
   */
  cards: CardId[]
  grabbedBy: PlayerId
  /**
   * Version at which this body's *float32* state last changed.
   *
   * Rounded to float32 before comparing, because that is what goes out: if the
   * wire value is bit-identical to the one the client already acknowledged,
   * sending it again is pure cost.
   */
  changedVersion: number
  wire: Float32Array
  wireCount: number
  wireAsleep: boolean
  wireGrabbedBy: PlayerId
}

interface Player {
  id: PlayerId
  seat: number
  name: string
  pose: AvatarPose
  hand: CardId[]
  handRevision: number
  handSentRevision: number
  /** Body this player is dragging, or 0. At most one. */
  grabbing: number
  /**
   * Snapshot versions this player has been sent, keyed by tick, newest last.
   * Bounded; see `noteSent`.
   */
  sent: Array<{ tick: number; version: number }>
  /** Version the player has acknowledged, or -1 if nothing yet. */
  ackVersion: number
  ackTick: number
  publicChangedVersion: number
  poseWire: Float32Array
  wireHandCount: number
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

export class Room {
  readonly world: World
  readonly info: RoomInfo
  readonly fan: FanLayout

  private readonly eyeHeight: number
  private readonly seatRadius: number
  private readonly flight: FlightModel

  private players = new Map<PlayerId, Player>()
  private cardBodies = new Map<number, CardBody>()
  private removals: Array<{ bodyId: number; version: number }> = []
  private events: OutboundEvent[] = []

  /**
   * Monotonic counter bumped on every observable change.
   *
   * Deltas are keyed on this rather than on the tick, and the difference
   * matters: intents are applied *between* ticks, so a card taken just after
   * this tick's snapshot went out still belongs to the same tick number. Keyed
   * on ticks that change would be invisible until the tick after next, or —
   * worse, depending which way you round it — never. A version is stamped when
   * the change happens and recorded when a snapshot is sent, so "changed since
   * you last acknowledged" means exactly that.
   */
  private version = 0

  private throwSeed: number
  private checksumTick = -1
  private checksumValue = 0

  constructor(options: RoomOptions = {}) {
    const table = options.table ?? DEFAULT_TABLE
    const cardHalf = options.cardHalf ?? DEFAULT_CARD_HALF
    const cardMass = options.cardMass ?? DEFAULT_CARD_MASS

    this.info = {
      name: options.name ?? 'table',
      seed: (options.seed ?? 1) | 0,
      maxPlayers: options.maxPlayers ?? 8,
      maxHandCards: options.maxHandCards ?? 26,
      fixedDt: TUNING.fixedDt,
      snapshotInterval: options.snapshotInterval ?? 8,
      table: { ...table },
      cardHalf: { ...cardHalf },
      cardMass,
    }
    this.fan = options.fan ?? DEFAULT_FAN
    this.eyeHeight = options.eyeHeight ?? 0.55
    this.seatRadius = options.seatRadius ?? table.radius + 0.18
    this.world = new World({ ...table })
    this.throwSeed = this.info.seed | 0

    // Mirrors the client's flight model, so the server plans the identical
    // throw. Both read it off the same tuning table.
    this.flight = {
      gravity: TUNING.gravity,
      damping: TUNING.linearDamping,
      angularDamping: TUNING.angularDamping,
      dragK: (0.5 * TUNING.aeroPressure * (cardHalf.x * 2) * (cardHalf.y * 2)) / cardMass,
    }
  }

  get tick(): number {
    return this.world.tick
  }

  checksum(): number {
    return this.world.checksum()
  }

  // ---- table setup --------------------------------------------------------

  /**
   * Put a stack of cards on the table, bottom card first.
   *
   * The room does not deal itself. What a deck is, how many, and whether the
   * game starts with one at all are gameplay questions, and answering them here
   * would bake one game into the transport layer.
   */
  addStack(cards: CardId[], position: V3, orientation: Q4, asleep = false): number {
    if (cards.length === 0) throw new Error('addStack needs at least one card')
    const cb = this.createBody(cards, position, orientation)
    if (asleep) cb.body.sleep()
    return cb.body.id
  }

  /** Identities on a body, bottom first. Server-side inspection only. */
  cardsOn(bodyId: number): readonly CardId[] | null {
    return this.cardBodies.get(bodyId)?.cards ?? null
  }

  /** A player's hand. Server-side inspection only; never broadcast. */
  handOf(playerId: PlayerId): readonly CardId[] {
    return this.players.get(playerId)?.hand ?? []
  }

  bodyIds(): number[] {
    return [...this.cardBodies.keys()]
  }

  /** Every card in the room, on the table or in a hand. Should never change. */
  cardCount(): number {
    let n = 0
    for (const cb of this.cardBodies.values()) n += cb.cards.length
    for (const p of this.players.values()) n += p.hand.length
    return n
  }

  // ---- membership ---------------------------------------------------------

  join(name: string, protocolVersion: number = PROTOCOL_VERSION): JoinResult {
    if (protocolVersion !== PROTOCOL_VERSION) {
      return { ok: false, reason: RejectReason.VersionMismatch }
    }
    if (this.players.size >= this.info.maxPlayers) {
      return { ok: false, reason: RejectReason.RoomFull }
    }

    // Lowest free id and seat, so a rejoin after a departure is deterministic
    // rather than depending on how many people have ever been here.
    let id = 1
    while (this.players.has(id)) id++
    const taken = new Set<number>()
    for (const p of this.players.values()) taken.add(p.seat)
    let seat = 0
    while (taken.has(seat)) seat++

    const player: Player = {
      id,
      seat,
      name: cleanName(name),
      pose: this.seatPose(seat),
      hand: [],
      handRevision: 0,
      handSentRevision: -1,
      grabbing: 0,
      sent: [],
      ackVersion: -1,
      ackTick: -1,
      publicChangedVersion: ++this.version,
      poseWire: new Float32Array(5),
      wireHandCount: -1,
      }
    this.players.set(id, player)
    this.emit(BROADCAST, { type: MsgType.Event, kind: EventKind.PlayerJoined, playerId: id })

    return {
      ok: true,
      playerId: id,
      welcome: {
        type: MsgType.Welcome,
        protocolVersion: PROTOCOL_VERSION,
        yourPlayerId: id,
        tick: this.world.tick,
        room: this.info,
      },
    }
  }

  /**
   * Remove a player, returning their hand to the table as one squared stack in
   * front of their seat.
   *
   * Deleting the cards would be simpler and is wrong: the room would quietly
   * lose count of a deck every time someone's train went into a tunnel. Putting
   * them back face-down is what happens when a player leaves a real table, and
   * it keeps `cardCount()` a conserved quantity worth asserting on.
   */
  leave(playerId: PlayerId): void {
    const p = this.players.get(playerId)
    if (!p) return

    this.releaseGrab(p)
    if (p.hand.length > 0) {
      const spot = this.seatTableSpot(p.seat, p.hand.length)
      this.createBody(p.hand, spot, faceDown(this.seatPose(p.seat).yaw))
      p.hand = []
      this.bumpHand(p)
    }
    this.players.delete(playerId)
    this.emit(BROADCAST, { type: MsgType.Event, kind: EventKind.PlayerLeft, playerId })
  }

  playerList(): PlayerListMessage {
    const players = [...this.players.values()].map((p) => ({ id: p.id, seat: p.seat, name: p.name }))
    return { type: MsgType.PlayerList, players }
  }

  // ---- intents ------------------------------------------------------------

  /**
   * Apply one decoded client message. Returns the reason it was refused, or
   * null if it was accepted.
   *
   * `Join` does not come through here: it is the message that produces a
   * playerId, so the transport calls `join()` on it and routes everything
   * afterwards by the id it got back.
   */
  handle(playerId: PlayerId, msg: ClientMessage): RejectReasonValue | null {
    const p = this.players.get(playerId)
    if (!p) return this.reject(playerId, msg.type, RejectReason.NotJoined)

    switch (msg.type) {
      case MsgType.Join:
        return this.reject(playerId, msg.type, RejectReason.Unsupported)

      case MsgType.Leave:
        this.leave(playerId)
        return null

      case MsgType.Ack:
        return this.applyAck(p, msg.tick) ? null : this.reject(playerId, msg.type, RejectReason.BadAck)

      case MsgType.Resync:
        // Everything is resent next snapshot. Cheaper than trying to work out
        // which body the client and server actually disagree about.
        p.ackVersion = -1
        p.ackTick = -1
        return null

      case MsgType.Grab:
        return this.applyGrab(p, msg.bodyId, msg.pinchPoint)

      case MsgType.MoveGrab:
        return this.applyMoveGrab(p, msg.point)

      case MsgType.Release:
        if (p.grabbing === 0) return this.reject(p.id, msg.type, RejectReason.NotGrabbing)
        this.releaseGrab(p)
        return null

      case MsgType.Take:
        return this.applyTake(p, msg.bodyId)

      case MsgType.Drop:
        return this.applyDrop(p, msg.handSlot, msg.point)

      case MsgType.Square:
        return this.applySquare(p, msg.bodyIds, msg.point)

      case MsgType.AvatarPose:
        return this.applyPose(p, msg.pose)

      default: {
        const unreachable: never = msg
        void unreachable
        return this.reject(playerId, (msg as ClientMessage).type, RejectReason.Unsupported)
      }
    }
  }

  private applyGrab(p: Player, bodyId: number, pinch: V3): RejectReasonValue | null {
    if (!finiteV3(pinch)) return this.reject(p.id, MsgType.Grab, RejectReason.BadPoint)
    const cb = this.cardBodies.get(bodyId)
    if (!cb) return this.reject(p.id, MsgType.Grab, RejectReason.UnknownBody)
    if (cb.grabbedBy !== 0 && cb.grabbedBy !== p.id) {
      return this.reject(p.id, MsgType.Grab, RejectReason.AlreadyHeld)
    }
    if (p.grabbing !== 0 && p.grabbing !== bodyId) {
      return this.reject(p.id, MsgType.Grab, RejectReason.AlreadyGrabbing)
    }

    // The pinch is a point *on the card*, and the solver drives the body by
    // pulling that point around. A client free to name a point a metre off the
    // card would be handing itself a metre-long lever arm.
    const b = cb.body
    const reach = b.boundRadius + 0.03
    if (
      Math.abs(pinch.x - b.p.x) > reach ||
      Math.abs(pinch.y - b.p.y) > reach ||
      Math.abs(pinch.z - b.p.z) > reach
    ) {
      return this.reject(p.id, MsgType.Grab, RejectReason.BadPinch)
    }

    this.world.beginGrab(b, pinch)
    cb.grabbedBy = p.id
    p.grabbing = bodyId
    return null
  }

  private applyMoveGrab(p: Player, point: V3): RejectReasonValue | null {
    if (!finiteV3(point)) return this.reject(p.id, MsgType.MoveGrab, RejectReason.BadPoint)
    const cb = p.grabbing === 0 ? undefined : this.cardBodies.get(p.grabbing)
    if (!cb) return this.reject(p.id, MsgType.MoveGrab, RejectReason.NotGrabbing)

    // Clamped, not refused. A cursor that slides off the felt is ordinary play,
    // and the clamp is the same one the client applies to its own cursor — but
    // it also means no client can drive a card through the rail or under the
    // table by simply asking.
    this.world.updateGrab(cb.body, this.clampReach(point))
    return null
  }

  private applyTake(p: Player, bodyId: number): RejectReasonValue | null {
    const cb = this.cardBodies.get(bodyId)
    if (!cb) return this.reject(p.id, MsgType.Take, RejectReason.UnknownBody)
    if (cb.grabbedBy !== 0 && cb.grabbedBy !== p.id) {
      return this.reject(p.id, MsgType.Take, RejectReason.AlreadyHeld)
    }
    if (p.hand.length >= this.info.maxHandCards) {
      return this.reject(p.id, MsgType.Take, RejectReason.HandFull)
    }

    // Reaching into a stack draws the top card off it, exactly as the
    // single-player build does: the card appears at the height you reached for
    // and the stack simply loses one. Extracting a card from the middle of a
    // solid block is not something the solver can model, and not something a
    // player wants either.
    const card = cb.cards[cb.cards.length - 1]
    cb.cards.pop()
    p.hand.push(card)
    this.bumpHand(p)

    if (cb.cards.length === 0) {
      if (cb.grabbedBy === p.id) this.releaseGrab(p)
      this.destroyBody(cb)
    } else {
      this.resizeStack(cb)
      cb.body.wake()
    }

    this.emit(BROADCAST, { type: MsgType.Event, kind: EventKind.CardTaken, playerId: p.id, bodyId })
    return null
  }

  private applyDrop(p: Player, slot: number, point: V3): RejectReasonValue | null {
    if (!finiteV3(point)) return this.reject(p.id, MsgType.Drop, RejectReason.BadPoint)
    if (!Number.isInteger(slot) || slot < 0 || slot >= p.hand.length) {
      return this.reject(p.id, MsgType.Drop, RejectReason.BadSlot)
    }

    // The card launches from the slot it was sitting in, so the throw starts
    // where the player last saw it rather than from some canonical hand point.
    const from: V3 = { x: 0, y: 0, z: 0 }
    const fromQ: Q4 = { x: 0, y: 0, z: 0, w: 1 }
    fanSlot(p.pose, slot, p.hand.length, this.fan, from, fromQ)

    const card = p.hand[slot]
    p.hand.splice(slot, 1)
    this.bumpHand(p)

    const cb = this.createBody([card], from, fromQ)

    const target = this.clampToFelt(point, 1)
    // Seeded, and advanced the same way the single-player build advances it, so
    // two rooms given the same intents plan bit-identical throws. Nothing here
    // may touch Math.random.
    this.throwSeed = (this.throwSeed * 1103515245 + 12345) | 0
    planPlayThrow(
      cb.body.p,
      cb.body.q,
      target,
      p.pose.yaw,
      this.flight,
      makeRandom(this.throwSeed),
      cb.body.v,
      cb.body.w,
    )
    cb.body.wake()

    this.emit(BROADCAST, {
      type: MsgType.Event,
      kind: EventKind.CardDropped,
      playerId: p.id,
      bodyId: cb.body.id,
    })
    return null
  }

  private applySquare(p: Player, bodyIds: number[], point: V3): RejectReasonValue | null {
    if (!finiteV3(point)) return this.reject(p.id, MsgType.Square, RejectReason.BadPoint)
    if (bodyIds.length < 2) return this.reject(p.id, MsgType.Square, RejectReason.TooFewBodies)
    // A repeated id would count the same cards twice and then delete the body
    // they live on, inventing cards out of nothing.
    if (new Set(bodyIds).size !== bodyIds.length) {
      return this.reject(p.id, MsgType.Square, RejectReason.DuplicateBody)
    }

    const group: CardBody[] = []
    for (const id of bodyIds) {
      const cb = this.cardBodies.get(id)
      if (!cb) return this.reject(p.id, MsgType.Square, RejectReason.UnknownBody)
      if (cb.grabbedBy !== 0 && cb.grabbedBy !== p.id) {
        return this.reject(p.id, MsgType.Square, RejectReason.AlreadyHeld)
      }
      group.push(cb)
    }

    // Everything validated; only now does anything change.
    if (p.grabbing !== 0 && bodyIds.includes(p.grabbing)) this.releaseGrab(p)

    const keeper = group[0]
    const cards: CardId[] = []
    for (const cb of group) cards.push(...cb.cards)
    for (let i = 1; i < group.length; i++) this.destroyBody(group[i])

    keeper.cards = cards
    this.resizeStack(keeper)
    const spot = this.clampToFelt(point, cards.length)
    keeper.body.setTransform(spot.x, spot.y, spot.z, faceDown(p.pose.yaw))
    keeper.body.v.x = 0
    keeper.body.v.y = 0
    keeper.body.v.z = 0
    keeper.body.w.x = 0
    keeper.body.w.y = 0
    keeper.body.w.z = 0
    keeper.body.wake()

    this.emit(BROADCAST, {
      type: MsgType.Event,
      kind: EventKind.Squared,
      playerId: p.id,
      bodyId: keeper.body.id,
      count: cards.length,
    })
    return null
  }

  private applyPose(p: Player, pose: AvatarPose): RejectReasonValue | null {
    if (!finiteV3(pose.position) || !Number.isFinite(pose.yaw) || !Number.isFinite(pose.pitch)) {
      return this.reject(p.id, MsgType.AvatarPose, RejectReason.BadPoint)
    }
    // Cosmetic, so it is clamped rather than refused — but it is clamped,
    // because the fan hangs off this pose and a player who teleported a
    // kilometre away would drag their cards there with them.
    const limit = this.seatRadius + 0.6
    const r = Math.hypot(pose.position.x, pose.position.z)
    const s = r > limit ? limit / r : 1
    p.pose = {
      position: {
        x: pose.position.x * s,
        y: clamp(pose.position.y, this.info.table.floorY, this.info.table.surfaceY + 2),
        z: pose.position.z * s,
      },
      yaw: wrapAngle(pose.yaw),
      pitch: clamp(pose.pitch, -Math.PI / 2, Math.PI / 2),
    }
    return null
  }

  private applyAck(p: Player, tick: number): boolean {
    // Only a tick this player was actually sent may be acknowledged. Otherwise
    // a client claiming a tick it never received would suppress precisely the
    // bodies it is missing, and the table would be wrong on that screen for
    // as long as nothing else disturbed those cards.
    const entry = p.sent.find((s) => s.tick === tick)
    if (!entry) return false
    if (entry.version > p.ackVersion) {
      p.ackVersion = entry.version
      p.ackTick = tick
    }
    this.pruneRemovals()
    return true
  }

  // ---- simulation ---------------------------------------------------------

  /**
   * Advance the solver by whole fixed steps. The caller decides when — there is
   * no timer in this file, so a test can step it a tick at a time and a host
   * can drive it off whatever clock it likes.
   *
   * Named `step`, not `tick`, because `tick` is the read-only accessor for the
   * current step number; a class cannot expose both a getter and a method under
   * one name, and the count is the thing callers reach for far more often.
   */
  step(steps = 1): void {
    for (let i = 0; i < steps; i++) this.world.advance(TUNING.fixedDt)
  }

  /** True when `tick` lands on a snapshot boundary. */
  snapshotDue(): boolean {
    return this.world.tick % this.info.snapshotInterval === 0
  }

  // ---- outbound -----------------------------------------------------------

  /**
   * The state this player does not already have.
   *
   * Not pure: it records the version the player was sent, which is what a later
   * `Ack` is matched against. Call it once per player per snapshot.
   */
  snapshotFor(playerId: PlayerId): SnapshotMessage {
    const p = this.players.get(playerId)
    if (!p) throw new Error(`no such player ${playerId}`)
    this.refreshWire()

    const full = p.ackVersion < 0
    const base = p.ackVersion

    const bodies: BodyState[] = []
    for (const cb of this.cardBodies.values()) {
      if (!full && cb.changedVersion <= base) continue
      bodies.push(wireBody(cb))
    }

    // A full snapshot carries no removals on purpose: it is a statement of
    // everything that exists, so a client applying one drops any body it holds
    // that the snapshot does not mention.
    const removed: number[] = []
    if (!full) {
      for (const r of this.removals) if (r.version > base) removed.push(r.bodyId)
    }

    const players: PublicPlayerState[] = []
    for (const q of this.players.values()) {
      if (!full && q.publicChangedVersion <= base) continue
      players.push(this.publicStateOf(q))
    }

    const snap: SnapshotMessage = {
      type: MsgType.Snapshot,
      tick: this.world.tick,
      checksum: this.cachedChecksum(),
      baseTick: full ? -1 : p.ackTick,
      bodies,
      removed,
      players,
    }
    this.noteSent(p)
    return snap
  }

  /**
   * This player's own cards, or null if they already have the current list.
   *
   * The only message in the protocol that carries an identity, and it goes to
   * one socket. Everything the other players get about this hand — the count,
   * the fan's transforms — is in the snapshot, derived from the pose and the
   * count alone. The two are joined by index on the owner's machine and nowhere
   * else, which is the whole of the hidden-hand mechanism.
   */
  pendingHandUpdate(playerId: PlayerId): HandUpdateMessage | null {
    const p = this.players.get(playerId)
    if (!p || p.handSentRevision === p.handRevision) return null
    p.handSentRevision = p.handRevision
    return {
      type: MsgType.HandUpdate,
      playerId: p.id,
      revision: p.handRevision,
      cards: [...p.hand],
    }
  }

  /** Events since the last call, with their recipients. */
  drainEvents(): OutboundEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  // ---- public geometry ----------------------------------------------------

  /**
   * What everyone may know about a player: where they are, and one transform
   * per card they hold.
   *
   * Every number here is a function of the pose and the card count. Nothing
   * reads `hand[i]`, and that is not an accident of this implementation — it is
   * the reason the fan is laid out by a pure function in the first place. A fan
   * that depended on which cards were in it could leak through its own
   * geometry.
   */
  private publicStateOf(p: Player): PublicPlayerState {
    const fan: Transform[] = []
    for (let i = 0; i < p.hand.length; i++) {
      const slot: Transform = { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } }
      fanSlot(p.pose, i, p.hand.length, this.fan, slot.p, slot.q)
      fan.push(slot)
    }
    return {
      playerId: p.id,
      pose: { position: { ...p.pose.position }, yaw: p.pose.yaw, pitch: p.pose.pitch },
      fan,
    }
  }

  private seatPose(seat: number): AvatarPose {
    const a = (seat / this.info.maxPlayers) * Math.PI * 2
    return {
      position: {
        x: Math.sin(a) * this.seatRadius,
        y: this.info.table.surfaceY + this.eyeHeight,
        z: Math.cos(a) * this.seatRadius,
      },
      // Facing the middle of the table: the client reads yaw as
      // atan2(-forward.x, -forward.z), which at this angle points inward.
      yaw: a,
      pitch: -0.5,
    }
  }

  /** Where a departing player's hand is set down: on the felt, at their seat. */
  private seatTableSpot(seat: number, count: number): V3 {
    const a = (seat / this.info.maxPlayers) * Math.PI * 2
    const r = this.info.table.radius * 0.62
    return {
      x: Math.sin(a) * r,
      y: this.info.table.surfaceY + this.info.cardHalf.z * count,
      z: Math.cos(a) * r,
    }
  }

  // ---- body bookkeeping ---------------------------------------------------

  private createBody(cards: CardId[], position: V3, orientation: Q4): CardBody {
    const n = cards.length
    const half: V3 = {
      x: this.info.cardHalf.x,
      y: this.info.cardHalf.y,
      z: this.info.cardHalf.z * n,
    }
    const body = this.world.createCard(half, this.info.cardMass * n)
    body.setTransform(position.x, position.y, position.z, orientation)

    const cb: CardBody = {
      body,
      cards: [...cards],
      grabbedBy: 0,
      changedVersion: ++this.version,
      wire: new Float32Array(WIRE_FLOATS),
      // -1 can never be a real count, so the first `refreshWire` always sees a
      // difference and the body is never born looking already-sent.
      wireCount: -1,
      wireAsleep: false,
      wireGrabbedBy: 0,
    }
    body.ref = cb
    this.cardBodies.set(body.id, cb)
    return cb
  }

  private destroyBody(cb: CardBody): void {
    const id = cb.body.id
    if (cb.grabbedBy !== 0) {
      const holder = this.players.get(cb.grabbedBy)
      if (holder) holder.grabbing = 0
      cb.grabbedBy = 0
    }
    this.world.remove(cb.body)
    this.cardBodies.delete(id)
    this.removals.push({ bodyId: id, version: ++this.version })
    this.guardRemovalBacklog()
  }

  /** Resize a stack in place, leaving its bottom face where it was. */
  private resizeStack(cb: CardBody): void {
    const n = cb.cards.length
    const before = cb.body.half.z / this.info.cardHalf.z
    cb.body.resize(
      { x: this.info.cardHalf.x, y: this.info.cardHalf.y, z: this.info.cardHalf.z * n },
      this.info.cardMass * n,
    )
    // The box grows about its centre, so shift by the same amount along world
    // up — not along the card's normal, which for a face-down deck points down
    // and would float the stack off the felt as it shrank.
    cb.body.p.y += (n - before) * this.info.cardHalf.z
  }

  private releaseGrab(p: Player): void {
    if (p.grabbing === 0) return
    const cb = this.cardBodies.get(p.grabbing)
    p.grabbing = 0
    if (!cb) return
    cb.grabbedBy = 0
    if (cb.body.mode === BodyMode.Grabbed) this.world.endGrab(cb.body)
  }

  private bumpHand(p: Player): void {
    // u16 on the wire, and it only has to be different from the last one.
    p.handRevision = (p.handRevision + 1) & 0xffff
  }

  // ---- change detection ---------------------------------------------------

  /**
   * Stamp every body and player whose float32 wire state has moved.
   *
   * The comparison is against the rounded value rather than the solver's
   * float64, because float32 is what the client will hold: if the bytes would
   * be identical there is nothing to tell it. A sleeping body writes the same
   * thirteen numbers every tick, so a settled table stamps nothing and its
   * snapshots are empty — which is the entire bandwidth argument for the sleep
   * system, cashed in.
   *
   * Run on every `snapshotFor` rather than once per tick. It is idempotent, and
   * running it per call is what makes a snapshot taken after an intent — but on
   * the same tick — include that intent.
   */
  private refreshWire(): void {
    for (const cb of this.cardBodies.values()) {
      const b = cb.body
      const w = cb.wire
      let changed =
        cb.wireCount !== cb.cards.length ||
        cb.wireAsleep !== b.asleep ||
        cb.wireGrabbedBy !== cb.grabbedBy

      // Assigning into a Float32Array rounds on the way in, so this compares
      // exactly what the encoder would emit without a fround in sight.
      const next = SCRATCH
      next[0] = b.p.x
      next[1] = b.p.y
      next[2] = b.p.z
      next[3] = b.q.x
      next[4] = b.q.y
      next[5] = b.q.z
      next[6] = b.q.w
      next[7] = b.v.x
      next[8] = b.v.y
      next[9] = b.v.z
      next[10] = b.w.x
      next[11] = b.w.y
      next[12] = b.w.z
      if (!changed) {
        for (let i = 0; i < WIRE_FLOATS; i++) {
          if (next[i] !== w[i]) {
            changed = true
            break
          }
        }
      }
      if (!changed) continue

      w.set(next)
      cb.wireCount = cb.cards.length
      cb.wireAsleep = b.asleep
      cb.wireGrabbedBy = cb.grabbedBy
      cb.changedVersion = ++this.version
    }

    for (const p of this.players.values()) {
      const pose = SCRATCH
      pose[0] = p.pose.position.x
      pose[1] = p.pose.position.y
      pose[2] = p.pose.position.z
      pose[3] = p.pose.yaw
      pose[4] = p.pose.pitch
      let changed = p.wireHandCount !== p.hand.length
      if (!changed) {
        for (let i = 0; i < 5; i++) {
          if (pose[i] !== p.poseWire[i]) {
            changed = true
            break
          }
        }
      }
      if (!changed) continue
      for (let i = 0; i < 5; i++) p.poseWire[i] = pose[i]
      p.wireHandCount = p.hand.length
      p.publicChangedVersion = ++this.version
    }
  }

  private cachedChecksum(): number {
    if (this.checksumTick !== this.world.tick) {
      this.checksumTick = this.world.tick
      this.checksumValue = this.world.checksum()
    }
    return this.checksumValue
  }

  private noteSent(p: Player): void {
    p.sent.push({ tick: this.world.tick, version: this.version })
    // Two seconds of 30Hz snapshots. A client that has not acknowledged inside
    // that window has bigger problems than a delta, and will be handed a full
    // snapshot by `guardRemovalBacklog` long before this matters.
    if (p.sent.length > 64) p.sent.shift()
  }

  private pruneRemovals(): void {
    if (this.removals.length === 0) return
    let oldest = Infinity
    for (const p of this.players.values()) {
      // A player who has acknowledged nothing gets a full snapshot, which
      // carries no removals, so they cannot pin the list.
      if (p.ackVersion >= 0) oldest = Math.min(oldest, p.ackVersion)
    }
    if (oldest === Infinity) {
      this.removals.length = 0
      return
    }
    this.removals = this.removals.filter((r) => r.version > oldest)
  }

  /**
   * Never let the removal list grow without bound.
   *
   * Trimming the oldest entries would be the obvious fix and is the one that
   * leaves phantom cards on a lagging client's table forever. Forcing everyone
   * who is that far behind onto a full snapshot costs one large message and is
   * correct by construction.
   */
  private guardRemovalBacklog(): void {
    if (this.removals.length <= 1024) return
    for (const p of this.players.values()) {
      p.ackVersion = -1
      p.ackTick = -1
    }
    this.removals.length = 0
  }

  // ---- helpers ------------------------------------------------------------

  /** Clamp a grab target into the volume above the table. */
  private clampReach(point: V3): V3 {
    const t = this.info.table
    const r = Math.hypot(point.x, point.z)
    const limit = t.radius
    const s = r > limit ? limit / r : 1
    return {
      x: point.x * s,
      y: clamp(point.y, t.floorY, t.surfaceY + 0.8),
      z: point.z * s,
    }
  }

  /** Clamp a landing point onto the felt, allowing for a stack's thickness. */
  private clampToFelt(point: V3, count: number): V3 {
    const t = this.info.table
    // Inside the rail by the card's own half-length, as the client's cursor is.
    const limit = t.railRadius - this.info.cardHalf.y
    const r = Math.hypot(point.x, point.z)
    const s = r > limit ? limit / r : 1
    return {
      x: point.x * s,
      y: t.surfaceY + this.info.cardHalf.z * count,
      z: point.z * s,
    }
  }

  private reject(playerId: PlayerId, intent: number, reason: RejectReasonValue): RejectReasonValue {
    this.emit(playerId, {
      type: MsgType.Event,
      kind: EventKind.IntentRejected,
      playerId,
      intent,
      reason,
    })
    return reason
  }

  private emit(to: PlayerId, message: EventMessage): void {
    this.events.push({ to, message })
  }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

const SCRATCH = new Float32Array(WIRE_FLOATS)

function wireBody(cb: CardBody): BodyState {
  const b = cb.body
  return {
    id: b.id,
    count: cb.cards.length,
    asleep: b.asleep,
    grabbedBy: cb.grabbedBy,
    p: { x: b.p.x, y: b.p.y, z: b.p.z },
    q: { x: b.q.x, y: b.q.y, z: b.q.z, w: b.q.w },
    v: { x: b.v.x, y: b.v.y, z: b.v.z },
    w: { x: b.w.x, y: b.w.y, z: b.w.z },
  }
}

/**
 * Where the card in slot `index` of a fan of `count` sits, in world space.
 *
 * Exported because the client needs the identical answer: it renders its own
 * fan from this, and the server launches a played card from it. Pure, and
 * pointedly unaware of what the cards are.
 */
export function fanSlot(
  pose: AvatarPose,
  index: number,
  count: number,
  layout: FanLayout,
  outP: V3,
  outQ: Q4,
): void {
  const arc = Math.min(layout.arcMax, Math.max(1, count) * layout.arcPerCard)
  const t = count <= 1 ? 0 : index / (count - 1) - 0.5
  const angle = t * arc

  // In the avatar's own frame first, then rotated onto the head. The client
  // does this by parenting the fan to the camera; here the head rotation is
  // written out, and the two have to agree to the millimetre or a played card
  // will not come from where the player watched it leave.
  const lx = layout.pivot.x + Math.sin(angle) * layout.radius
  const ly = layout.pivot.y + layout.radius - (1 - Math.cos(angle)) * layout.radius * layout.droop
  const lz = layout.pivot.z + index * layout.stagger

  axisY(pose.yaw, _qa)
  axisX(pose.pitch, _qb)
  quatMul(_qa, _qb, _head)

  rotateBy(_head, lx, ly, lz, outP)
  outP.x += pose.position.x
  outP.y += pose.position.y
  outP.z += pose.position.z

  axisX(layout.tilt, _qb)
  quatMul(_head, _qb, _qa)
  axisZ(-angle, _qb)
  quatMul(_qa, _qb, outQ)
}

/** Orientation of a card lying face-down on the felt, spun by `yaw`. */
function faceDown(yaw: number): Q4 {
  // `faceUpQuaternion` in gameplay.ts is Ry(yaw) * Rx(-90deg); a deck sits the
  // other way up, which is Rx(+90deg).
  const out: Q4 = { x: 0, y: 0, z: 0, w: 1 }
  axisY(yaw, _qa)
  axisX(Math.PI / 2, _qb)
  quatMul(_qa, _qb, out)
  return out
}

const _qa: Q4 = { x: 0, y: 0, z: 0, w: 1 }
const _qb: Q4 = { x: 0, y: 0, z: 0, w: 1 }
const _head: Q4 = { x: 0, y: 0, z: 0, w: 1 }

function axisX(a: number, out: Q4): void {
  out.x = Math.sin(a / 2)
  out.y = 0
  out.z = 0
  out.w = Math.cos(a / 2)
}
function axisY(a: number, out: Q4): void {
  out.x = 0
  out.y = Math.sin(a / 2)
  out.z = 0
  out.w = Math.cos(a / 2)
}
function axisZ(a: number, out: Q4): void {
  out.x = 0
  out.y = 0
  out.z = Math.sin(a / 2)
  out.w = Math.cos(a / 2)
}

function rotateBy(q: Q4, vx: number, vy: number, vz: number, out: V3): void {
  const tx = 2 * (q.y * vz - q.z * vy)
  const ty = 2 * (q.z * vx - q.x * vz)
  const tz = 2 * (q.x * vy - q.y * vx)
  out.x = vx + q.w * tx + (q.y * tz - q.z * ty)
  out.y = vy + q.w * ty + (q.z * tx - q.x * tz)
  out.z = vz + q.w * tz + (q.x * ty - q.y * tx)
}

function finiteV3(v: V3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (Math.PI * 2)
  return (t < 0 ? t + Math.PI * 2 : t) - Math.PI
}

/** Names are shown to other players, so they are bounded and stripped here. */
function cleanName(name: string): string {
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (trimmed.length === 0 ? 'player' : trimmed).slice(0, 24)
}
