/**
 * protocol.ts — the wire format between a client and the authoritative room.
 *
 * Binary, and deliberately hand-rolled. A snapshot is already a packed run of
 * numbers; JSON would roughly triple it and charge a parse for every frame, and
 * a schema library would be a dependency for what amounts to a hundred lines of
 * DataView. Nothing here imports anything at runtime, so the same file loads in
 * a browser, in Node, and in a test.
 *
 * Four rules the rest of the file follows:
 *
 *  - **Float32 on the wire, float64 in the solver.** The solver's determinism
 *    rests on float64 and is not negotiable, but nothing downstream of the wire
 *    re-simulates from these numbers — they are drawn, interpolated, or used to
 *    correct a prediction. At table scale (0.62m) a float32 step is about 60nm,
 *    some four thousand times finer than a card is thick, and it halves the
 *    snapshot.
 *
 *  - **One type-id space, high bit set for server->client.** A single `decode`
 *    then cannot mistake one direction for the other, and a server handed a
 *    0x82 knows at the first byte that it is being lied to rather than
 *    discovering it three fields in.
 *
 *  - **Card identity never appears in a Snapshot.** Not filtered out of one —
 *    absent from the format. The only message that carries an identity is
 *    `HandUpdate`, which is unicast to the one player who owns those cards.
 *    Hidden hands are then a property of the wire format rather than a promise
 *    the server has to keep remembering to honour.
 *
 *  - **Encode trusts, decode does not.** Everything encoded was produced by the
 *    room a moment earlier, so the writers do no range checking. Everything
 *    decoded arrived over a network, so every read is bounds-checked and a
 *    short or unknown frame throws instead of quietly returning a half-built
 *    message.
 *
 * Little-endian throughout: every platform this will ever run on is
 * little-endian, so both ends read the bytes in their native order.
 */

import type { V3, Q4, TableSpec } from '../physics.ts'

/** Bumped whenever a layout below changes. A mismatch is refused at `Join`. */
export const PROTOCOL_VERSION = 1

export type PlayerId = number
/**
 * A card's identity — which card it actually is.
 *
 * 32 bits rather than the 6 a single deck needs, because card packs are on the
 * roadmap and an identity has to hold a pack as well as an index. It also makes
 * the hidden-hand tests meaningful: identities can be drawn from a space wide
 * enough that finding one by chance in a buffer of floats is not a thing that
 * happens.
 */
export type CardId = number

// ---------------------------------------------------------------------------
// Message ids
// ---------------------------------------------------------------------------

export const MsgType = {
  // client -> server: intents, and nothing else.
  Join: 0x01,
  Leave: 0x02,
  Ack: 0x03,
  Resync: 0x04,
  Grab: 0x05,
  MoveGrab: 0x06,
  Release: 0x07,
  Take: 0x08,
  Drop: 0x09,
  Square: 0x0a,
  AvatarPose: 0x0b,

  // server -> client: authority.
  Welcome: 0x81,
  Snapshot: 0x82,
  PlayerList: 0x83,
  HandUpdate: 0x84,
  Event: 0x85,
} as const
export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType]

export function isServerMessage(type: number): boolean {
  return (type & 0x80) !== 0
}

const MESSAGE_NAMES: Record<number, string> = {}
for (const [name, id] of Object.entries(MsgType)) MESSAGE_NAMES[id] = name

/** For logs and test labels; never used to make a decision. */
export function messageName(type: number): string {
  return MESSAGE_NAMES[type] ?? `Unknown(0x${type.toString(16)})`
}

/** Why the room turned an intent down. Sent back as an `IntentRejected` event. */
export const RejectReason = {
  UnknownBody: 1,
  /** Another player is already holding it. */
  AlreadyHeld: 2,
  AlreadyGrabbing: 3,
  NotGrabbing: 4,
  /** The pinch point is nowhere near the body it claims to be on. */
  BadPinch: 5,
  /** A coordinate that was NaN, infinite, or absurd. */
  BadPoint: 6,
  BadSlot: 7,
  HandFull: 8,
  TooFewBodies: 9,
  NotJoined: 10,
  RoomFull: 11,
  /** An ack for a tick this player was never sent. */
  BadAck: 12,
  VersionMismatch: 13,
  /** A message the room does not accept from a client. */
  Unsupported: 14,
  /** The same body id appeared twice in a `Square`, which would double-count it. */
  DuplicateBody: 15,
} as const
export type RejectReasonValue = (typeof RejectReason)[keyof typeof RejectReason]

export const EventKind = {
  PlayerJoined: 1,
  PlayerLeft: 2,
  IntentRejected: 3,
  CardTaken: 4,
  CardDropped: 5,
  Squared: 6,
} as const
export type EventKindValue = (typeof EventKind)[keyof typeof EventKind]

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export interface AvatarPose {
  /** Eye position, world space. */
  position: V3
  yaw: number
  pitch: number
}

export interface Transform {
  p: V3
  q: Q4
}

/**
 * One body's state, as the client needs it.
 *
 * Half-extents are absent: a body's thickness is `count` cards, and the client
 * already has the card size from `Welcome`, so sending the box would be sending
 * something derivable that could then disagree with the count.
 *
 * `mode` is absent for the same reason. A body is grabbed exactly when
 * `grabbedBy` is non-zero, so there is no second field to fall out of step with
 * it. Held (in-hand) bodies never appear at all — a card in a hand is not in
 * the world.
 */
export interface BodyState {
  id: number
  /** How many cards this body stands for. A stack is one body, not a pile. */
  count: number
  asleep: boolean
  /** The player holding it, or 0 for nobody. */
  grabbedBy: PlayerId
  p: V3
  q: Q4
  v: V3
  w: V3
}

/**
 * Everything about a player that everyone may see.
 *
 * `fan` is one transform per card held, and it is computed by the server from
 * `pose` and the card count alone. That is the whole trick: the fan is a pure
 * function of public inputs, so it cannot encode which cards they are even by
 * accident. The owner joins these transforms to the identities in their private
 * `HandUpdate` by index, on their own machine, and nowhere else.
 */
export interface PublicPlayerState {
  playerId: PlayerId
  pose: AvatarPose
  fan: Transform[]
}

export interface RoomInfo {
  name: string
  /** Seeds every deterministic choice the room makes, throws included. */
  seed: number
  maxPlayers: number
  maxHandCards: number
  /** Solver step in seconds; the room ticks at exactly this rate. */
  fixedDt: number
  /** Ticks between snapshots. 8 at 240Hz is the 30Hz the design calls for. */
  snapshotInterval: number
  table: TableSpec
  /** Half-extents of a single card. A stack is `count` of these thick. */
  cardHalf: V3
  cardMass: number
}

// ---------------------------------------------------------------------------
// Client -> server. Intents only: never a position the server must believe.
// ---------------------------------------------------------------------------

export interface JoinMessage {
  type: typeof MsgType.Join
  protocolVersion: number
  name: string
}

export interface LeaveMessage {
  type: typeof MsgType.Leave
}

/**
 * "I have applied everything up to and including this tick."
 *
 * The one piece of client bookkeeping the server depends on, and the reason a
 * settled table costs nothing: deltas are computed against the last
 * acknowledged tick, not the last sent one, so an unacknowledged change stays
 * in the delta until it lands.
 */
export interface AckMessage {
  type: typeof MsgType.Ack
  tick: number
}

/** "My checksum disagrees with yours; send me everything." */
export interface ResyncMessage {
  type: typeof MsgType.Resync
}

export interface GrabMessage {
  type: typeof MsgType.Grab
  bodyId: number
  /** Where on the card the pinch is, world space. Validated against the body. */
  pinchPoint: V3
}

export interface MoveGrabMessage {
  type: typeof MsgType.MoveGrab
  point: V3
}

export interface ReleaseMessage {
  type: typeof MsgType.Release
}

export interface TakeMessage {
  type: typeof MsgType.Take
  bodyId: number
}

/**
 * Play a card out of the fan onto the table.
 *
 * The slot index rather than the card's identity, deliberately. A client that
 * names a card is a client that can name a card it does not hold; a slot is
 * checked against the hand length and can only ever select something the player
 * actually has.
 */
export interface DropMessage {
  type: typeof MsgType.Drop
  handSlot: number
  point: V3
}

/**
 * Square several bodies into one stack.
 *
 * The single-player build squares whatever the marquee has gathered, which is a
 * purely client-side notion of "held". Over the wire the intent has to say what
 * it means, so it names the bodies and where they end up.
 */
export interface SquareMessage {
  type: typeof MsgType.Square
  bodyIds: number[]
  point: V3
}

export interface AvatarPoseMessage {
  type: typeof MsgType.AvatarPose
  pose: AvatarPose
}

export type ClientMessage =
  | JoinMessage
  | LeaveMessage
  | AckMessage
  | ResyncMessage
  | GrabMessage
  | MoveGrabMessage
  | ReleaseMessage
  | TakeMessage
  | DropMessage
  | SquareMessage
  | AvatarPoseMessage

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  type: typeof MsgType.Welcome
  protocolVersion: number
  yourPlayerId: PlayerId
  /** The tick the room is on, so a client can size its own clock immediately. */
  tick: number
  room: RoomInfo
}

/**
 * The authoritative state of everything that has changed.
 *
 * `baseTick` is the client ack this was built against, or -1 for a full
 * snapshot. A full snapshot is also a statement of what exists: a client
 * receiving one must discard any body it holds that is not listed, because
 * removals are not replayed into it.
 */
export interface SnapshotMessage {
  type: typeof MsgType.Snapshot
  tick: number
  /** `World.checksum()`. A client that disagrees sends `Resync`. */
  checksum: number
  baseTick: number
  bodies: BodyState[]
  /** Bodies that left the table — taken into a hand, or squared away. */
  removed: number[]
  players: PublicPlayerState[]
}

export interface PlayerInfo {
  id: PlayerId
  seat: number
  name: string
}

export interface PlayerListMessage {
  type: typeof MsgType.PlayerList
  players: PlayerInfo[]
}

/**
 * The cards in one player's hand, sent to that player and to nobody else.
 *
 * `revision` increments on every change, so a client can tell a stale update
 * from a fresh one without diffing the contents.
 */
export interface HandUpdateMessage {
  type: typeof MsgType.HandUpdate
  playerId: PlayerId
  revision: number
  cards: CardId[]
}

/**
 * Something happened that is worth telling a client about but is not itself
 * authoritative — the authority is always in Snapshot, PlayerList or
 * HandUpdate. Events drive prompts, sounds and log lines; dropping one loses
 * nothing that cannot be recovered from the next snapshot.
 */
export type EventMessage = { type: typeof MsgType.Event } & (
  | { kind: typeof EventKind.PlayerJoined; playerId: PlayerId }
  | { kind: typeof EventKind.PlayerLeft; playerId: PlayerId }
  | {
      kind: typeof EventKind.IntentRejected
      playerId: PlayerId
      /** The `MsgType` that was refused. */
      intent: number
      reason: RejectReasonValue
    }
  | { kind: typeof EventKind.CardTaken; playerId: PlayerId; bodyId: number }
  | { kind: typeof EventKind.CardDropped; playerId: PlayerId; bodyId: number }
  | { kind: typeof EventKind.Squared; playerId: PlayerId; bodyId: number; count: number }
)

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | PlayerListMessage
  | HandUpdateMessage
  | EventMessage

export type Message = ClientMessage | ServerMessage

// ---------------------------------------------------------------------------
// Reader / writer
// ---------------------------------------------------------------------------

export class ProtocolError extends Error {}

const LE = true
const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

/** Per-body wire size, exported so a host can budget a snapshot without one. */
export const BODY_RECORD_BYTES = 60
/** Per-fan-slot wire size: position and orientation. */
export const FAN_SLOT_BYTES = 28

class Writer {
  private bytes: Uint8Array
  private view: DataView
  private at = 0

  constructor(capacity: number) {
    const buf = new ArrayBuffer(capacity)
    this.bytes = new Uint8Array(buf)
    this.view = new DataView(buf)
  }

  private room(n: number): void {
    const need = this.at + n
    if (need <= this.bytes.length) return
    let size = this.bytes.length * 2
    while (size < need) size *= 2
    const buf = new ArrayBuffer(size)
    const bytes = new Uint8Array(buf)
    bytes.set(this.bytes)
    this.bytes = bytes
    this.view = new DataView(buf)
  }

  u8(v: number): void {
    this.room(1)
    this.view.setUint8(this.at, v)
    this.at += 1
  }
  u16(v: number): void {
    this.room(2)
    this.view.setUint16(this.at, v, LE)
    this.at += 2
  }
  u32(v: number): void {
    this.room(4)
    this.view.setUint32(this.at, v, LE)
    this.at += 4
  }
  i32(v: number): void {
    this.room(4)
    this.view.setInt32(this.at, v, LE)
    this.at += 4
  }
  f32(v: number): void {
    this.room(4)
    this.view.setFloat32(this.at, v, LE)
    this.at += 4
  }
  vec3(v: V3): void {
    this.f32(v.x)
    this.f32(v.y)
    this.f32(v.z)
  }
  quat(q: Q4): void {
    this.f32(q.x)
    this.f32(q.y)
    this.f32(q.z)
    this.f32(q.w)
  }
  text(s: string): void {
    const utf8 = TEXT_ENCODER.encode(s)
    this.u16(utf8.length)
    this.room(utf8.length)
    this.bytes.set(utf8, this.at)
    this.at += utf8.length
  }

  /**
   * A view onto the written bytes, not a copy — `ws.send()` takes it directly.
   * It aliases the writer's buffer, so it must be sent or copied before this
   * writer is touched again. `encode` builds a fresh writer every call, so in
   * practice each result owns its bytes outright.
   */
  finish(): Uint8Array {
    return this.bytes.subarray(0, this.at)
  }
}

class Reader {
  private view: DataView
  private at = 0

  constructor(data: ArrayBuffer | ArrayBufferView) {
    // A Node Buffer is a window onto a shared pool, so its byteOffset is
    // usually not zero. Reading `.buffer` alone would decode whatever else the
    // pool happens to be holding — which mostly works, right up until it
    // silently does not.
    if (ArrayBuffer.isView(data)) {
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    } else {
      this.view = new DataView(data)
    }
  }

  private need(n: number): number {
    const at = this.at
    if (at + n > this.view.byteLength) {
      throw new ProtocolError(`truncated message: wanted ${n} bytes at ${at} of ${this.view.byteLength}`)
    }
    this.at = at + n
    return at
  }

  u8(): number {
    return this.view.getUint8(this.need(1))
  }
  u16(): number {
    return this.view.getUint16(this.need(2), LE)
  }
  u32(): number {
    return this.view.getUint32(this.need(4), LE)
  }
  i32(): number {
    return this.view.getInt32(this.need(4), LE)
  }
  f32(): number {
    return this.view.getFloat32(this.need(4), LE)
  }
  vec3(): V3 {
    return { x: this.f32(), y: this.f32(), z: this.f32() }
  }
  quat(): Q4 {
    return { x: this.f32(), y: this.f32(), z: this.f32(), w: this.f32() }
  }
  text(): string {
    const len = this.u16()
    const at = this.need(len)
    return TEXT_DECODER.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + at, len))
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Exact encoded size of a snapshot.
 *
 * Snapshots are the only message big enough for a growing buffer to matter, and
 * the only one whose size is worth knowing before it is built — a host deciding
 * whether it is about to flood a slow client wants the number, not the bytes.
 * A test asserts this against the real encoder, so the two cannot drift.
 */
export function snapshotByteLength(msg: SnapshotMessage): number {
  let n = 1 + 4 + 4 + 4 + 2 + 2 + 1
  n += msg.bodies.length * BODY_RECORD_BYTES
  n += msg.removed.length * 4
  for (const p of msg.players) n += 2 + 20 + p.fan.length * FAN_SLOT_BYTES
  return n
}

function writeBody(w: Writer, b: BodyState): void {
  w.u32(b.id)
  w.u16(b.count)
  w.u8(b.asleep ? 1 : 0)
  w.u8(b.grabbedBy)
  w.vec3(b.p)
  w.quat(b.q)
  w.vec3(b.v)
  w.vec3(b.w)
}

function readBody(r: Reader): BodyState {
  const id = r.u32()
  const count = r.u16()
  const asleep = r.u8() !== 0
  const grabbedBy = r.u8()
  return { id, count, asleep, grabbedBy, p: r.vec3(), q: r.quat(), v: r.vec3(), w: r.vec3() }
}

function writePose(w: Writer, pose: AvatarPose): void {
  w.vec3(pose.position)
  w.f32(pose.yaw)
  w.f32(pose.pitch)
}

function readPose(r: Reader): AvatarPose {
  return { position: r.vec3(), yaw: r.f32(), pitch: r.f32() }
}

export function encode(msg: Message): Uint8Array {
  const w = new Writer(msg.type === MsgType.Snapshot ? snapshotByteLength(msg) : 128)
  w.u8(msg.type)

  switch (msg.type) {
    case MsgType.Join:
      w.u16(msg.protocolVersion)
      w.text(msg.name)
      break

    case MsgType.Leave:
    case MsgType.Resync:
    case MsgType.Release:
      break

    case MsgType.Ack:
      w.u32(msg.tick)
      break

    case MsgType.Grab:
      w.u32(msg.bodyId)
      w.vec3(msg.pinchPoint)
      break

    case MsgType.MoveGrab:
      w.vec3(msg.point)
      break

    case MsgType.Take:
      w.u32(msg.bodyId)
      break

    case MsgType.Drop:
      w.u8(msg.handSlot)
      w.vec3(msg.point)
      break

    case MsgType.Square:
      w.u16(msg.bodyIds.length)
      for (const id of msg.bodyIds) w.u32(id)
      w.vec3(msg.point)
      break

    case MsgType.AvatarPose:
      writePose(w, msg.pose)
      break

    case MsgType.Welcome: {
      w.u16(msg.protocolVersion)
      w.u8(msg.yourPlayerId)
      w.u32(msg.tick)
      const r = msg.room
      w.text(r.name)
      w.u32(r.seed >>> 0)
      w.u8(r.maxPlayers)
      w.u16(r.maxHandCards)
      w.f32(r.fixedDt)
      w.u16(r.snapshotInterval)
      w.f32(r.table.surfaceY)
      w.f32(r.table.radius)
      w.f32(r.table.railRadius)
      w.f32(r.table.railTopY)
      w.f32(r.table.floorY)
      w.vec3(r.cardHalf)
      w.f32(r.cardMass)
      break
    }

    case MsgType.Snapshot:
      w.u32(msg.tick)
      w.u32(msg.checksum)
      w.i32(msg.baseTick)
      w.u16(msg.bodies.length)
      w.u16(msg.removed.length)
      w.u8(msg.players.length)
      for (const b of msg.bodies) writeBody(w, b)
      for (const id of msg.removed) w.u32(id)
      for (const p of msg.players) {
        w.u8(p.playerId)
        w.u8(p.fan.length)
        writePose(w, p.pose)
        for (const slot of p.fan) {
          w.vec3(slot.p)
          w.quat(slot.q)
        }
      }
      break

    case MsgType.PlayerList:
      w.u8(msg.players.length)
      for (const p of msg.players) {
        w.u8(p.id)
        w.u8(p.seat)
        w.text(p.name)
      }
      break

    case MsgType.HandUpdate:
      w.u8(msg.playerId)
      w.u16(msg.revision)
      w.u8(msg.cards.length)
      for (const c of msg.cards) w.u32(c >>> 0)
      break

    case MsgType.Event:
      w.u8(msg.kind)
      w.u8(msg.playerId)
      switch (msg.kind) {
        case EventKind.PlayerJoined:
        case EventKind.PlayerLeft:
          break
        case EventKind.IntentRejected:
          w.u8(msg.intent)
          w.u8(msg.reason)
          break
        case EventKind.CardTaken:
        case EventKind.CardDropped:
          w.u32(msg.bodyId)
          break
        case EventKind.Squared:
          w.u32(msg.bodyId)
          w.u16(msg.count)
          break
      }
      break

    default: {
      // Exhaustiveness: adding a message without an encoder fails to compile.
      const unreachable: never = msg
      throw new ProtocolError(`no encoder for ${JSON.stringify(unreachable)}`)
    }
  }

  return w.finish()
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function decode(data: ArrayBuffer | ArrayBufferView): Message {
  const r = new Reader(data)
  const type = r.u8()

  switch (type) {
    case MsgType.Join:
      return { type: MsgType.Join, protocolVersion: r.u16(), name: r.text() }

    case MsgType.Leave:
      return { type: MsgType.Leave }

    case MsgType.Resync:
      return { type: MsgType.Resync }

    case MsgType.Release:
      return { type: MsgType.Release }

    case MsgType.Ack:
      return { type: MsgType.Ack, tick: r.u32() }

    case MsgType.Grab:
      return { type: MsgType.Grab, bodyId: r.u32(), pinchPoint: r.vec3() }

    case MsgType.MoveGrab:
      return { type: MsgType.MoveGrab, point: r.vec3() }

    case MsgType.Take:
      return { type: MsgType.Take, bodyId: r.u32() }

    case MsgType.Drop:
      return { type: MsgType.Drop, handSlot: r.u8(), point: r.vec3() }

    case MsgType.Square: {
      const n = r.u16()
      const bodyIds: number[] = []
      for (let i = 0; i < n; i++) bodyIds.push(r.u32())
      return { type: MsgType.Square, bodyIds, point: r.vec3() }
    }

    case MsgType.AvatarPose:
      return { type: MsgType.AvatarPose, pose: readPose(r) }

    case MsgType.Welcome: {
      const protocolVersion = r.u16()
      const yourPlayerId = r.u8()
      const tick = r.u32()
      const name = r.text()
      const seed = r.u32()
      const maxPlayers = r.u8()
      const maxHandCards = r.u16()
      const fixedDt = r.f32()
      const snapshotInterval = r.u16()
      const table: TableSpec = {
        surfaceY: r.f32(),
        radius: r.f32(),
        railRadius: r.f32(),
        railTopY: r.f32(),
        floorY: r.f32(),
      }
      const cardHalf = r.vec3()
      const cardMass = r.f32()
      return {
        type: MsgType.Welcome,
        protocolVersion,
        yourPlayerId,
        tick,
        room: {
          name,
          seed,
          maxPlayers,
          maxHandCards,
          fixedDt,
          snapshotInterval,
          table,
          cardHalf,
          cardMass,
        },
      }
    }

    case MsgType.Snapshot: {
      const tick = r.u32()
      const checksum = r.u32()
      const baseTick = r.i32()
      const bodyCount = r.u16()
      const removedCount = r.u16()
      const playerCount = r.u8()
      const bodies: BodyState[] = []
      for (let i = 0; i < bodyCount; i++) bodies.push(readBody(r))
      const removed: number[] = []
      for (let i = 0; i < removedCount; i++) removed.push(r.u32())
      const players: PublicPlayerState[] = []
      for (let i = 0; i < playerCount; i++) {
        const playerId = r.u8()
        const fanCount = r.u8()
        const pose = readPose(r)
        const fan: Transform[] = []
        for (let j = 0; j < fanCount; j++) fan.push({ p: r.vec3(), q: r.quat() })
        players.push({ playerId, pose, fan })
      }
      return { type: MsgType.Snapshot, tick, checksum, baseTick, bodies, removed, players }
    }

    case MsgType.PlayerList: {
      const n = r.u8()
      const players: PlayerInfo[] = []
      for (let i = 0; i < n; i++) players.push({ id: r.u8(), seat: r.u8(), name: r.text() })
      return { type: MsgType.PlayerList, players }
    }

    case MsgType.HandUpdate: {
      const playerId = r.u8()
      const revision = r.u16()
      const n = r.u8()
      const cards: CardId[] = []
      for (let i = 0; i < n; i++) cards.push(r.u32())
      return { type: MsgType.HandUpdate, playerId, revision, cards }
    }

    case MsgType.Event: {
      const kind = r.u8()
      const playerId = r.u8()
      switch (kind) {
        case EventKind.PlayerJoined:
          return { type: MsgType.Event, kind: EventKind.PlayerJoined, playerId }
        case EventKind.PlayerLeft:
          return { type: MsgType.Event, kind: EventKind.PlayerLeft, playerId }
        case EventKind.IntentRejected:
          return {
            type: MsgType.Event,
            kind: EventKind.IntentRejected,
            playerId,
            intent: r.u8(),
            reason: r.u8() as RejectReasonValue,
          }
        case EventKind.CardTaken:
          return { type: MsgType.Event, kind: EventKind.CardTaken, playerId, bodyId: r.u32() }
        case EventKind.CardDropped:
          return { type: MsgType.Event, kind: EventKind.CardDropped, playerId, bodyId: r.u32() }
        case EventKind.Squared:
          return {
            type: MsgType.Event,
            kind: EventKind.Squared,
            playerId,
            bodyId: r.u32(),
            count: r.u16(),
          }
        default:
          throw new ProtocolError(`unknown event kind ${kind}`)
      }
    }

    default:
      throw new ProtocolError(`unknown message type 0x${type.toString(16)}`)
  }
}

/**
 * Decode a frame that must have come from a client.
 *
 * The server calls this rather than `decode` so a client cannot present itself
 * as an authority: the check is one bit and it happens before any field is
 * read.
 */
export function decodeClientMessage(data: ArrayBuffer | ArrayBufferView): ClientMessage {
  const msg = decode(data)
  if (isServerMessage(msg.type)) {
    throw new ProtocolError(`${messageName(msg.type)} is server-to-client and cannot arrive from a client`)
  }
  return msg as ClientMessage
}

export function decodeServerMessage(data: ArrayBuffer | ArrayBufferView): ServerMessage {
  const msg = decode(data)
  if (!isServerMessage(msg.type)) {
    throw new ProtocolError(`${messageName(msg.type)} is client-to-server and cannot arrive from the server`)
  }
  return msg as ServerMessage
}
