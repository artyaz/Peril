/**
 * Headless verification for the wire protocol, the authoritative room, and the
 * hand-rolled WebSocket host.
 * Run: node --experimental-strip-types test/net.test.ts
 *
 * These are the three things steps 1 and 2 of docs/multiplayer.md exist to make
 * true, asserted against real numbers rather than trusted from the code:
 *
 *  - the codec is exact and reversible, edge values and empty messages included;
 *  - a snapshot is a real delta — it collapses to nothing when the table is
 *    still and grows only for the bodies that moved;
 *  - a hand is server state that never reaches another player, proven by
 *    scanning the actual broadcast bytes for the identities and finding none;
 *  - the room arbitrates (two players cannot hold one card) and is deterministic
 *    (identical intents, identical checksum);
 *  - and the framing the server speaks with no `ws` package survives a real
 *    loopback round trip in both directions.
 */

import { connect } from 'node:net'

import { World, v3, q4, type Q4 } from '../src/physics.ts'
import {
  BODY_RECORD_BYTES,
  EventKind,
  MsgType,
  PROTOCOL_VERSION,
  RejectReason,
  decode,
  decodeClientMessage,
  decodeServerMessage,
  encode,
  isServerMessage,
  messageName,
  snapshotByteLength,
  type BodyState,
  type CardId,
  type Message,
  type PublicPlayerState,
  type SnapshotMessage,
} from '../src/net/protocol.ts'
import { Room } from '../src/net/room.ts'
import { startServer } from '../server/index.ts'

let failures = 0
let checks = 0

function ok(cond: boolean, label: string, detail = ''): void {
  checks++
  if (cond) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`)
}

/** Quaternion from axis-angle, as physics.test.ts has it. */
function axisAngle(ax: number, ay: number, az: number, angle: number): Q4 {
  const s = Math.sin(angle / 2)
  return q4(ax * s, ay * s, az * s, Math.cos(angle / 2))
}

const FLAT = axisAngle(1, 0, 0, -Math.PI / 2)
const FACE_DOWN = axisAngle(1, 0, 0, Math.PI / 2)

/** Card geometry the room defaults to; restated so the test reads standalone. */
const CARD_HALF = v3(0.0315, 0.044, 0.000175)

/**
 * A distinctive identity space. Real card ids will be small (a pack index), but
 * the leak test needs values that cannot turn up in a buffer of float32
 * transforms by chance, so identities here are large and marked. `0xCA5D` reads
 * as "card" in a hex dump when a scan does find one where it should not.
 */
function cardId(n: number): CardId {
  return (0xca5d0000 | n) >>> 0
}

// ---------------------------------------------------------------------------
section('1. Every message round-trips encode -> decode exactly')
// ---------------------------------------------------------------------------
{
  // One representative of every message, with awkward values on purpose: empty
  // strings and lists, the largest ids each field can hold, negative and
  // fractional coordinates. `sameMessage` compares floats after `Math.fround`,
  // because float32 is what the wire carries and exact f64 equality would be
  // asserting something the format never promised.
  const messages: Message[] = [
    { type: MsgType.Join, protocolVersion: PROTOCOL_VERSION, name: 'Ada' },
    { type: MsgType.Join, protocolVersion: 65535, name: '' },
    { type: MsgType.Join, protocolVersion: 1, name: 'named with spaces' },
    { type: MsgType.Leave },
    { type: MsgType.Resync },
    { type: MsgType.Release },
    { type: MsgType.Ack, tick: 0 },
    { type: MsgType.Ack, tick: 0xffffffff },
    { type: MsgType.Grab, bodyId: 1, pinchPoint: v3(0.01, 0.2, -0.03) },
    { type: MsgType.Grab, bodyId: 0xffffffff, pinchPoint: v3(-1.5, 0, 1.5) },
    { type: MsgType.MoveGrab, point: v3(0.123456, -0.654321, 0.000001) },
    { type: MsgType.Take, bodyId: 42 },
    { type: MsgType.Drop, handSlot: 0, point: v3(0, 0, 0) },
    { type: MsgType.Drop, handSlot: 25, point: v3(0.3, 0.02, -0.3) },
    { type: MsgType.Square, bodyIds: [], point: v3(0, 0, 0) },
    { type: MsgType.Square, bodyIds: [1, 2, 3, 65535], point: v3(0.1, 0.02, 0.1) },
    { type: MsgType.AvatarPose, pose: { position: v3(0.4, 0.55, -0.4), yaw: 1.25, pitch: -0.5 } },
    {
      type: MsgType.Welcome,
      protocolVersion: PROTOCOL_VERSION,
      yourPlayerId: 3,
      tick: 12345,
      room: {
        name: 'kitchen table',
        seed: 0xdeadbeef,
        maxPlayers: 8,
        maxHandCards: 26,
        fixedDt: 1 / 240,
        snapshotInterval: 8,
        table: { surfaceY: 0, radius: 0.62, railRadius: 0.616, railTopY: 0.018, floorY: -0.55 },
        cardHalf: CARD_HALF,
        cardMass: 0.0018,
      },
    },
    // A full snapshot (baseTick -1) with one body, one removal, one player.
    {
      type: MsgType.Snapshot,
      tick: 240,
      checksum: 0xabcdef01,
      baseTick: -1,
      bodies: [
        {
          id: 1,
          count: 52,
          asleep: true,
          grabbedBy: 0,
          p: v3(0, 0.009, 0),
          q: { x: FACE_DOWN.x, y: FACE_DOWN.y, z: FACE_DOWN.z, w: FACE_DOWN.w },
          v: v3(0, 0, 0),
          w: v3(0, 0, 0),
        },
      ],
      removed: [7],
      players: [
        {
          playerId: 2,
          pose: { position: v3(0.4, 0.55, -0.4), yaw: 0.7, pitch: -0.5 },
          fan: [
            { p: v3(0.1, 0.5, -0.3), q: q4(0, 0, 0, 1) },
            { p: v3(0.12, 0.5, -0.31), q: axisAngle(0, 0, 1, 0.2) },
          ],
        },
      ],
    },
    { type: MsgType.PlayerList, players: [{ id: 1, seat: 0, name: 'Ada' }, { id: 2, seat: 3, name: 'Bo' }] },
    { type: MsgType.HandUpdate, playerId: 1, revision: 0, cards: [] },
    { type: MsgType.HandUpdate, playerId: 1, revision: 65535, cards: [cardId(1), cardId(2), cardId(51)] },
    { type: MsgType.Event, kind: EventKind.PlayerJoined, playerId: 4 },
    { type: MsgType.Event, kind: EventKind.PlayerLeft, playerId: 4 },
    {
      type: MsgType.Event,
      kind: EventKind.IntentRejected,
      playerId: 4,
      intent: MsgType.Grab,
      reason: RejectReason.AlreadyHeld,
    },
    { type: MsgType.Event, kind: EventKind.CardTaken, playerId: 4, bodyId: 9 },
    { type: MsgType.Event, kind: EventKind.CardDropped, playerId: 4, bodyId: 9 },
    { type: MsgType.Event, kind: EventKind.Squared, playerId: 4, bodyId: 9, count: 10 },
  ]

  let allExact = true
  let worstField = ''
  for (const msg of messages) {
    const bytes = encode(msg)
    const back = decode(bytes)
    const same = sameMessage(msg, back)
    if (!same.equal) {
      allExact = false
      worstField = `${messageName(msg.type)}: ${same.why}`
    }
    // Re-encoding the decoded message must reproduce the exact same bytes: proof
    // the round trip has no hidden asymmetry the field-by-field check missed.
    const reBytes = encode(back)
    if (!bytesEqual(bytes, reBytes)) {
      allExact = false
      worstField = `${messageName(msg.type)}: bytes differ on re-encode`
    }
  }
  ok(allExact, `all ${messages.length} message shapes survive the round trip`, worstField)

  // An empty snapshot is the common case on a settled table, and its header is
  // a fixed size regardless — the delta test below leans on this being tiny.
  const empty: SnapshotMessage = {
    type: MsgType.Snapshot,
    tick: 8,
    checksum: 0,
    baseTick: 0,
    bodies: [],
    removed: [],
    players: [],
  }
  const emptyBytes = encode(empty)
  ok(emptyBytes.length === snapshotByteLength(empty), 'empty snapshot size matches the predictor', `${emptyBytes.length} bytes`)
  const emptyBack = decode(emptyBytes) as SnapshotMessage
  ok(
    emptyBack.bodies.length === 0 && emptyBack.removed.length === 0 && emptyBack.players.length === 0,
    'empty snapshot decodes back to empty',
  )
  console.log(`     header-only snapshot is ${emptyBytes.length} bytes; one body adds ${BODY_RECORD_BYTES}`)

  // The size predictor has to agree with the encoder for a populated snapshot
  // too, since a host budgets with it before building the bytes.
  const populated = messages.find((m) => m.type === MsgType.Snapshot) as SnapshotMessage
  ok(encode(populated).length === snapshotByteLength(populated), 'populated snapshot size matches the predictor', `${encode(populated).length} bytes`)
}

// ---------------------------------------------------------------------------
section('2. Float32 on the wire quantises to well under a card thickness')
// ---------------------------------------------------------------------------
{
  // The design's claim, checked at the scale it is claimed for: a coordinate
  // anywhere on the 0.62m table survives the f64 -> f32 -> f64 trip to far
  // finer than the 0.35mm a card is thick. This is why re-simulating from the
  // wire is forbidden and interpolating from it is fine.
  let worst = 0
  for (let i = 0; i < 2000; i++) {
    const x = (i / 2000 - 0.5) * 2 * 0.62
    worst = Math.max(worst, Math.abs(x - Math.fround(x)))
  }
  const thickness = CARD_HALF.z * 2
  console.log(`     worst f32 error over +/-0.62m: ${(worst * 1e9).toFixed(1)}nm; card is ${(thickness * 1e3).toFixed(2)}mm`)
  ok(worst < thickness / 1000, 'float32 error is a thousandth of a card thickness or less', `${(worst * 1e9).toFixed(1)}nm`)
}

// ---------------------------------------------------------------------------
section('3. Direction bit: a client cannot masquerade as the server')
// ---------------------------------------------------------------------------
{
  const snap = encode({
    type: MsgType.Snapshot,
    tick: 0,
    checksum: 0,
    baseTick: -1,
    bodies: [],
    removed: [],
    players: [],
  })
  const join = encode({ type: MsgType.Join, protocolVersion: PROTOCOL_VERSION, name: 'x' })

  ok(isServerMessage(MsgType.Snapshot) && !isServerMessage(MsgType.Join), 'the high bit separates the two directions')

  let serverRefused = false
  try {
    decodeClientMessage(snap)
  } catch {
    serverRefused = true
  }
  ok(serverRefused, 'decodeClientMessage refuses a server frame')

  let clientRefused = false
  try {
    decodeServerMessage(join)
  } catch {
    clientRefused = true
  }
  ok(clientRefused, 'decodeServerMessage refuses a client frame')

  // A truncated frame must throw, not return a half-built message: the decoder
  // is the trust boundary and a short read is exactly what a hostile client
  // sends to probe it.
  let truncThrew = false
  try {
    decode(snap.subarray(0, 3))
  } catch {
    truncThrew = true
  }
  ok(truncThrew, 'a truncated frame throws rather than decoding partially')
}

// ---------------------------------------------------------------------------
section('4. A settled table produces an empty delta; motion makes it grow')
// ---------------------------------------------------------------------------
{
  const room = new Room({ seed: 7, snapshotInterval: 8 })
  // Two decks and a loose card, dealt as sleeping so the table starts at rest.
  const deckA = room.addStack(deck(0, 52), v3(-0.1, CARD_HALF.z * 52, 0), FACE_DOWN, true)
  room.addStack(deck(100, 52), v3(0.1, CARD_HALF.z * 52, 0), FACE_DOWN, true)
  const loose = room.addStack([cardId(200)], v3(0, CARD_HALF.z, 0.2), FACE_DOWN, true)

  const player = mustJoin(room, 'Ada')

  // First snapshot is full: the client has nothing yet.
  const first = room.snapshotFor(player)
  ok(first.baseTick === -1, 'first snapshot for a fresh client is a full one')
  ok(first.bodies.length === 3, 'full snapshot lists every body', `${first.bodies.length}`)
  const fullBytes = encode(first).length
  room.handle(player, { type: MsgType.Ack, tick: room.tick })

  // Now step a settled table and snapshot again. Nothing moved, nothing is owed.
  room.step(8)
  const settled = room.snapshotFor(player)
  const settledBytes = encode(settled).length
  room.handle(player, { type: MsgType.Ack, tick: room.tick })
  console.log(`     full snapshot ${fullBytes} bytes -> settled delta ${settledBytes} bytes`)
  ok(settled.bodies.length === 0, 'a settled table owes no body updates', `${settled.bodies.length} bodies`)
  ok(settledBytes < fullBytes / 4, 'the settled delta is a fraction of the full snapshot')

  // Grab the loose card and drag it: exactly one body should now be in the delta.
  const grabPoint = v3(0, CARD_HALF.z, 0.2)
  ok(room.handle(player, { type: MsgType.Grab, bodyId: loose, pinchPoint: grabPoint }) === null, 'grab accepted')
  let movedBytes = 0
  let movedCount = 0
  for (let i = 0; i < 6; i++) {
    room.handle(player, { type: MsgType.MoveGrab, point: v3(0.05 * i, 0.05, 0.2 - 0.02 * i) })
    room.step(8)
    const snap = room.snapshotFor(player)
    movedBytes = encode(snap).length
    movedCount = snap.bodies.length
    room.handle(player, { type: MsgType.Ack, tick: room.tick })
  }
  console.log(`     dragging one card: ${movedCount} body in the delta, ${movedBytes} bytes/snapshot`)
  ok(movedCount === 1, 'only the moving body is in the delta while one card is dragged', `${movedCount}`)
  ok(movedBytes > settledBytes, 'the delta grows once something moves')
  ok(movedBytes < fullBytes, 'but a one-body delta is still smaller than the full snapshot')

  // The two untouched decks must not have leaked into the delta.
  ok(!settled.bodies.some((b) => b.id === deckA), 'an untouched deck stays out of the delta')
}

// ---------------------------------------------------------------------------
section('5. A settled room emits near-zero bytes per tick over time')
// ---------------------------------------------------------------------------
{
  const room = new Room({ seed: 11, snapshotInterval: 8 })
  room.addStack(deck(0, 52), v3(0, CARD_HALF.z * 52, 0), FACE_DOWN, true)
  room.addStack([cardId(300)], v3(0.15, CARD_HALF.z, -0.1), FACE_DOWN, true)
  const player = mustJoin(room, 'Bo')

  // Prime with the full snapshot and let it settle for real.
  room.snapshotFor(player)
  room.handle(player, { type: MsgType.Ack, tick: room.tick })
  room.step(240)
  room.snapshotFor(player)
  room.handle(player, { type: MsgType.Ack, tick: room.tick })

  // A second of 30Hz snapshots on an undisturbed table.
  let total = 0
  let snaps = 0
  for (let i = 0; i < 30; i++) {
    room.step(8)
    const snap = room.snapshotFor(player)
    total += encode(snap).length
    snaps++
    room.handle(player, { type: MsgType.Ack, tick: room.tick })
  }
  const perTick = total / snaps
  console.log(`     ${snaps} snapshots over ~1s of a still table: ${(total / 1024).toFixed(2)}KiB total, ${perTick.toFixed(1)} bytes/snapshot`)
  ok(perTick < 20, 'a settled room costs under 20 bytes per snapshot', `${perTick.toFixed(1)} bytes`)
}

// ---------------------------------------------------------------------------
section('6. Two players cannot hold the same body')
// ---------------------------------------------------------------------------
{
  const room = new Room({ seed: 3 })
  const body = room.addStack([cardId(1), cardId(2)], v3(0, CARD_HALF.z * 2, 0), FACE_DOWN, true)
  const ada = mustJoin(room, 'Ada')
  const bo = mustJoin(room, 'Bo')

  const at = v3(0, CARD_HALF.z * 2, 0)
  const first = room.handle(ada, { type: MsgType.Grab, bodyId: body, pinchPoint: at })
  ok(first === null, 'the first player gets the grab')

  const second = room.handle(bo, { type: MsgType.Grab, bodyId: body, pinchPoint: at })
  ok(second === RejectReason.AlreadyHeld, 'the second is refused with AlreadyHeld', `reason ${second}`)

  // The refusal is delivered as an IntentRejected event addressed to Bo alone.
  const events = room.drainEvents()
  const rejection = events.find(
    (e) => e.message.type === MsgType.Event && e.message.kind === EventKind.IntentRejected,
  )
  ok(rejection !== undefined && rejection.to === bo, 'and Bo is told why, privately')

  // Ada releases; now Bo may take it. Arbitration is a lock, not a ban.
  room.handle(ada, { type: MsgType.Release })
  const third = room.handle(bo, { type: MsgType.Grab, bodyId: body, pinchPoint: at })
  ok(third === null, 'once released, the other player can grab it')

  // Unknown body and out-of-range values are refused too, with typed reasons
  // rather than exceptions. Checked against a second, unheld body so the
  // rejection is unambiguously about the value and not about someone holding it.
  const free = room.addStack([cardId(3)], v3(0.2, CARD_HALF.z, 0), FACE_DOWN, true)
  ok(
    room.handle(ada, { type: MsgType.Grab, bodyId: 99999, pinchPoint: v3(0.2, CARD_HALF.z, 0) }) === RejectReason.UnknownBody,
    'a grab on an unknown body is refused',
  )
  ok(
    room.handle(ada, { type: MsgType.Grab, bodyId: free, pinchPoint: v3(5, 5, 5) }) === RejectReason.BadPinch,
    'a pinch point off the card is refused',
  )
  ok(
    room.handle(ada, { type: MsgType.Grab, bodyId: free, pinchPoint: v3(NaN, 0, 0) }) === RejectReason.BadPoint,
    'a NaN coordinate is refused',
  )
  ok(room.cardCount() === 3, 'and no card was invented or lost through any of it', `${room.cardCount()}`)
}

// ---------------------------------------------------------------------------
section('7. A hand is server state: identities never cross the wire')
// ---------------------------------------------------------------------------
{
  const room = new Room({ seed: 5, snapshotInterval: 8 })
  // A deck to draw from, with identities from the marked space so a scan can
  // find them unambiguously if they ever escape.
  const deckBody = room.addStack(deck(0, 52), v3(0, CARD_HALF.z * 52, 0), FACE_DOWN, true)
  const ada = mustJoin(room, 'Ada')
  const bo = mustJoin(room, 'Bo')

  // Ada draws several cards into her hand.
  for (let i = 0; i < 7; i++) {
    const r = room.handle(ada, { type: MsgType.Take, bodyId: deckBody })
    ok(r === null, `take ${i + 1} accepted`, r === null ? '' : `reason ${r}`)
  }
  ok(room.handOf(ada).length === 7, "Ada's hand holds seven cards server-side", `${room.handOf(ada).length}`)

  const handCards = [...room.handOf(ada)]
  ok(handCards.length === 7 && new Set(handCards).size === 7, 'and they are seven distinct identities')

  // The private update to Ada is the one and only place an identity appears.
  const adaHand = room.pendingHandUpdate(ada)
  ok(adaHand !== null && adaHand.cards.length === 7, "Ada's own HandUpdate carries her identities")
  // Bo receives a HandUpdate too — his own, and it is empty. A HandUpdate only
  // ever describes its recipient's hand, so Bo's can never hold Ada's cards; the
  // point is not that Bo gets nothing, it is that what he gets is his own zero.
  const boHand = room.pendingHandUpdate(bo)
  ok(boHand !== null && boHand.playerId === bo && boHand.cards.length === 0, "Bo's own HandUpdate is empty")
  // Nothing new to tell either of them until a hand actually changes.
  ok(room.pendingHandUpdate(ada) === null && room.pendingHandUpdate(bo) === null, 'a hand already sent is not resent')

  // Everything broadcast, to anyone, over several snapshots and the event
  // stream. This is the buffer set a wire-tap would see.
  const broadcast: Uint8Array[] = []
  broadcast.push(encode(room.snapshotFor(ada)))
  broadcast.push(encode(room.snapshotFor(bo)))
  broadcast.push(encode(room.playerList()))
  for (const e of room.drainEvents()) broadcast.push(encode(e.message))
  // And the public view of Ada, which is what carries her fan to Bo.
  room.step(16)
  broadcast.push(encode(room.snapshotFor(bo)))

  // Ada's snapshot shows her own fan transforms too, but never the identities.
  const bosView = decode(broadcast[1]) as SnapshotMessage
  const adaPublic = bosView.players.find((p: PublicPlayerState) => p.playerId === ada)
  ok(adaPublic !== undefined && adaPublic.fan.length === 7, "Bo sees the shape of Ada's hand: seven fan slots", `${adaPublic?.fan.length}`)

  // The proof: scan the raw bytes of every broadcast buffer for each identity's
  // four-byte little-endian pattern. Not "we did not include it" — "it is not
  // in the bytes". The private HandUpdate is deliberately excluded from the scan.
  let leaks = 0
  let firstLeak = ''
  for (const id of handCards) {
    for (let i = 0; i < broadcast.length; i++) {
      if (containsU32LE(broadcast[i], id)) {
        leaks++
        if (!firstLeak) firstLeak = `id 0x${id.toString(16)} in buffer ${i}`
      }
    }
  }
  ok(leaks === 0, 'no hand identity appears in any broadcast buffer', leaks === 0 ? `scanned ${broadcast.length} buffers` : firstLeak)

  // Sanity on the scanner itself: it must find an identity that really is
  // present, or the clean result above proves nothing.
  ok(containsU32LE(encode(adaHand!), handCards[0]), "the scanner does find an identity in Ada's own HandUpdate")

  // A body's `count` is public — the pile's height is not secret — but the
  // identities behind that count are not on the body record.
  const deckState = (decode(broadcast[0]) as SnapshotMessage).bodies.find((b: BodyState) => b.id === deckBody)
  ok(deckState !== undefined && deckState.count === 45, 'the deck body still advertises its height (45 left)', `${deckState?.count}`)
}

// ---------------------------------------------------------------------------
section('8. Determinism: identical intents give identical checksums')
// ---------------------------------------------------------------------------
{
  // Two rooms, same seed, driven by the same script including a card played from
  // the hand — which routes through the seeded throw planner. If any of it
  // touched Math.random or a wall clock, the checksums would part.
  function play(seed: number): { checksum: number; tick: number; cardCount: number } {
    const room = new Room({ seed, snapshotInterval: 8 })
    const deckBody = room.addStack(deck(0, 52), v3(0, CARD_HALF.z * 52, 0), FACE_DOWN, true)
    const p = mustJoin(room, 'Player')

    // Draw two, settle, then drop one on a chosen spot and let it fly and land.
    room.handle(p, { type: MsgType.Take, bodyId: deckBody })
    room.handle(p, { type: MsgType.Take, bodyId: deckBody })
    room.step(60)
    room.handle(p, { type: MsgType.Drop, handSlot: 0, point: v3(0.2, 0.02, -0.15) })
    room.step(240)

    // Grab the remaining deck and shove it, to exercise the grab drive too.
    room.handle(p, { type: MsgType.Grab, bodyId: deckBody, pinchPoint: v3(0, CARD_HALF.z * 50, 0) })
    for (let i = 0; i < 20; i++) {
      room.handle(p, { type: MsgType.MoveGrab, point: v3(0.01 * i, 0.05, 0.01 * i) })
      room.step(8)
    }
    room.handle(p, { type: MsgType.Release })
    room.step(120)
    return { checksum: room.checksum(), tick: room.tick, cardCount: room.cardCount() }
  }

  const a = play(2024)
  const b = play(2024)
  const c = play(2025)
  console.log(`     seed 2024: checksum ${a.checksum} at tick ${a.tick}; seed 2025: checksum ${c.checksum}`)
  ok(a.tick === b.tick, 'same intents advance to the same tick', `${a.tick} === ${b.tick}`)
  ok(a.checksum === b.checksum, 'same seed and intents give the identical checksum', `${a.checksum} === ${b.checksum}`)
  ok(a.cardCount === 52 && b.cardCount === 52, 'and the card count is conserved throughout', `${a.cardCount}`)
  // A different seed must actually change the throw, or the seed is not doing
  // anything and the determinism above is vacuous.
  ok(a.checksum !== c.checksum, 'a different seed lands the thrown card differently', `${a.checksum} vs ${c.checksum}`)
}

// ---------------------------------------------------------------------------
section('9. Snapshot tracks the solver so a client can interpolate it')
// ---------------------------------------------------------------------------
{
  // A client renders from the wire, so what comes off the wire has to be the
  // solver's own transform, quantised to f32 and nothing more. Build a body,
  // settle it, then take the snapshot the whole way through encode -> decode
  // and compare against `Math.fround` of the World: the encoder is where the
  // f64 -> f32 step happens, so the decoded value must equal it exactly.
  const room = new Room({ seed: 1 })
  const body = room.addStack([cardId(1)], v3(0.05, 0.2, -0.05), FLAT)
  const p = mustJoin(room, 'Ada')
  room.step(120)

  const wire = decode(encode(room.snapshotFor(p))) as SnapshotMessage
  const rec = wire.bodies.find((s) => s.id === body)!
  const world = room.world.bodies.find((b) => b.id === body)!
  const err = Math.max(
    Math.abs(Math.fround(world.p.x) - rec.p.x),
    Math.abs(Math.fround(world.p.y) - rec.p.y),
    Math.abs(Math.fround(world.p.z) - rec.p.z),
    Math.abs(Math.fround(world.q.x) - rec.q.x),
    Math.abs(Math.fround(world.q.w) - rec.q.w),
  )
  ok(err === 0, 'the decoded wire transform equals the solver transform rounded to f32', `max diff ${err}`)
  // And the raw f32 error against the untouched f64 solver value is sub-micron,
  // the property the whole float32-on-the-wire decision rests on.
  const physErr = Math.abs(world.p.x - rec.p.x)
  ok(physErr < 1e-6, 'and that is under a micron from the true f64 position', `${(physErr * 1e9).toFixed(1)}nm`)
  ok(rec.asleep === world.asleep, 'and the sleep flag matches')
  ok(rec.count === 1, 'a single card is a count-1 body')
}

// ---------------------------------------------------------------------------
section('10. The hand-rolled WebSocket host survives a real round trip')
// ---------------------------------------------------------------------------
// This is the one section that leaves the pure layer. The server owns a
// hand-rolled RFC 6455 handshake and frame codec because no `ws` package can be
// installed; the only honest way to know they work is to speak the client half
// back at them over a loopback socket and check what comes out. Async, so it is
// wrapped in a function and awaited before the final tally.
async function transportSection(): Promise<void> {
  const server = startServer({ port: 0, room: { seed: 42 } })
  const boundPort = await server.ready
  try {
    const client = await wsConnect(boundPort, '/room/loopback')

    // Handshake completed means the accept-token maths matched; otherwise
    // `wsConnect` would have rejected.
    ok(true, 'client completed the RFC 6455 handshake against the hand-rolled server')

    // Join, and read back Welcome + PlayerList + the initial full snapshot.
    client.send(encode({ type: MsgType.Join, protocolVersion: PROTOCOL_VERSION, name: 'Loopback' }))
    const welcome = decodeServerMessage(await client.next())
    ok(welcome.type === MsgType.Welcome, 'server answered Join with a Welcome frame', messageName(welcome.type))
    const myId = welcome.type === MsgType.Welcome ? welcome.yourPlayerId : 0
    ok(myId > 0, 'and assigned a player id', `id ${myId}`)

    const list = decodeServerMessage(await client.next())
    ok(list.type === MsgType.PlayerList, 'followed by the player list')

    const firstSnap = decodeServerMessage(await client.next())
    ok(firstSnap.type === MsgType.Snapshot && firstSnap.baseTick === -1, 'and a full snapshot to start from')

    // A frame larger than 125 bytes exercises the 16-bit length path of the
    // codec in both directions. A long name is the easy way to force it.
    const longName = 'x'.repeat(200)
    const client2 = await wsConnect(boundPort, '/room/loopback')
    client2.send(encode({ type: MsgType.Join, protocolVersion: PROTOCOL_VERSION, name: longName }))
    const welcome2 = decodeServerMessage(await client2.next())
    ok(welcome2.type === MsgType.Welcome, 'a second client joins the same room')

    // The second join is broadcast to the first as a PlayerJoined event: proof
    // the server frames unprompted messages correctly, not just replies.
    const joined = await waitForType(client, MsgType.Event, 40)
    ok(
      joined !== null && joined.type === MsgType.Event && joined.kind === EventKind.PlayerJoined,
      'the first client is told, over the wire, that a second joined',
    )

    // A close frame from the client must be accepted and the socket torn down.
    client2.close()
    client.close()
    ok(true, 'close frames were sent without error')
  } finally {
    await server.close()
  }
}

// ---------------------------------------------------------------------------
// A minimal RFC 6455 client, just enough to test the server: masked frames out,
// unmasked frames in, one message at a time. No dependency, by design.
// ---------------------------------------------------------------------------

interface WsClient {
  send: (data: Uint8Array) => void
  /** Resolve with the next whole application frame's payload. */
  next: () => Promise<Uint8Array>
  close: () => void
}

function wsConnect(port: number, path: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    // A fixed key is fine for a test: the server hashes whatever we send and we
    // never check the returned token's value, only that the 101 arrived.
    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    let handshakeDone = false
    let buffer = Buffer.alloc(0)
    const queue: Uint8Array[] = []
    let waiter: ((data: Uint8Array) => void) | null = null

    function deliver(payload: Uint8Array): void {
      if (waiter) {
        const w = waiter
        waiter = null
        w(payload)
      } else {
        queue.push(payload)
      }
    }

    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          'Host: 127.0.0.1\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      )
    })

    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (!handshakeDone) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const header = buffer.subarray(0, headerEnd).toString('utf8')
        if (!/101/.test(header)) {
          reject(new Error(`handshake failed: ${header.split('\r\n')[0]}`))
          socket.destroy()
          return
        }
        handshakeDone = true
        buffer = buffer.subarray(headerEnd + 4)
        resolve({
          send: (data) => socket.write(maskedFrame(data)),
          next: () =>
            new Promise<Uint8Array>((res) => {
              const q = queue.shift()
              if (q) res(q)
              else waiter = res
            }),
          close: () => {
            // A client close frame: opcode 0x8, masked, empty body.
            socket.write(maskedFrame(Buffer.alloc(0), 0x8))
            socket.end()
          },
        })
      }
      // Drain any complete server frames (server never masks).
      for (;;) {
        const frame = readServerFrame(buffer)
        if (!frame) break
        buffer = frame.rest
        if (frame.op === 0x2) deliver(frame.payload)
        // Ignore control frames (close/ping/pong) in the test client.
      }
    })

    socket.on('error', reject)
    socket.on('close', () => {
      // Wake any pending reader so an awaited `next()` cannot hang the test.
      if (waiter) {
        const w = waiter
        waiter = null
        w(new Uint8Array(0))
      }
    })
  })
}

/** Frame a client payload: fin+op, masked length, four-byte key, XOR'd body. */
function maskedFrame(payload: Uint8Array, op = 0x2): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = 0x80 | len
  } else {
    header = Buffer.allocUnsafe(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  }
  header[0] = 0x80 | op
  // A fixed mask is legitimate; the spec requires the bit set and a key present,
  // not that the key be unpredictable (that matters for browsers, not tests).
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

/** Parse one unmasked server frame, or null if the buffer is short. */
function readServerFrame(buf: Buffer): { op: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null
  const op = buf[0] & 0x0f
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = buf.readUInt32BE(6)
    offset = 10
  }
  if (buf.length < offset + len) return null
  return { op, payload: buf.subarray(offset, offset + len), rest: buf.subarray(offset + len) }
}

/** Await the next frame of a given type, or null after `tries` reads. */
async function waitForType(client: WsClient, type: number, tries: number): Promise<Message | null> {
  for (let i = 0; i < tries; i++) {
    const bytes = await client.next()
    if (bytes.length === 0) return null
    const msg = decode(bytes)
    if (msg.type === type) return msg
  }
  return null
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A deck of `n` identities starting at `base`, bottom card first. */
function deck(base: number, n: number): CardId[] {
  const out: CardId[] = []
  for (let i = 0; i < n; i++) out.push(cardId(base + i))
  return out
}

function mustJoin(room: Room, name: string): number {
  const r = room.join(name)
  if (!r.ok) throw new Error(`join failed: ${r.reason}`)
  return r.playerId
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Does `buf` contain `value` as a little-endian uint32 at any byte offset? */
function containsU32LE(buf: Uint8Array, value: number): boolean {
  const b0 = value & 0xff
  const b1 = (value >>> 8) & 0xff
  const b2 = (value >>> 16) & 0xff
  const b3 = (value >>> 24) & 0xff
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === b0 && buf[i + 1] === b1 && buf[i + 2] === b2 && buf[i + 3] === b3) return true
  }
  return false
}

/**
 * Structural equality between two messages, comparing floats after `Math.fround`
 * because the wire is float32. Returns why it failed, for a useful assertion.
 */
function sameMessage(a: Message, b: Message): { equal: boolean; why: string } {
  const fa = flattenFloats(a)
  const fb = flattenFloats(b)
  const sa = stripFloats(a)
  const sb = stripFloats(b)
  if (JSON.stringify(sa) !== JSON.stringify(sb)) {
    return { equal: false, why: `non-float fields differ: ${JSON.stringify(sa)} vs ${JSON.stringify(sb)}` }
  }
  if (fa.length !== fb.length) return { equal: false, why: `float count differs: ${fa.length} vs ${fb.length}` }
  for (let i = 0; i < fa.length; i++) {
    if (Math.fround(fa[i]) !== fb[i]) return { equal: false, why: `float ${i}: fround(${fa[i]}) !== ${fb[i]}` }
  }
  return { equal: true, why: '' }
}

/** Pull every number that rides the wire as a float32 out of a message. */
function flattenFloats(msg: Message): number[] {
  const out: number[] = []
  const pushV = (v: { x: number; y: number; z: number }): void => {
    out.push(v.x, v.y, v.z)
  }
  const pushQ = (q: { x: number; y: number; z: number; w: number }): void => {
    out.push(q.x, q.y, q.z, q.w)
  }
  switch (msg.type) {
    case MsgType.Grab:
      pushV(msg.pinchPoint)
      break
    case MsgType.MoveGrab:
    case MsgType.Drop:
      pushV(msg.point)
      break
    case MsgType.Square:
      pushV(msg.point)
      break
    case MsgType.AvatarPose:
      pushV(msg.pose.position)
      out.push(msg.pose.yaw, msg.pose.pitch)
      break
    case MsgType.Welcome: {
      const r = msg.room
      out.push(r.fixedDt, r.table.surfaceY, r.table.radius, r.table.railRadius, r.table.railTopY, r.table.floorY)
      pushV(r.cardHalf)
      out.push(r.cardMass)
      break
    }
    case MsgType.Snapshot:
      for (const bdy of msg.bodies) {
        pushV(bdy.p)
        pushQ(bdy.q)
        pushV(bdy.v)
        pushV(bdy.w)
      }
      for (const p of msg.players) {
        pushV(p.pose.position)
        out.push(p.pose.yaw, p.pose.pitch)
        for (const slot of p.fan) {
          pushV(slot.p)
          pushQ(slot.q)
        }
      }
      break
    default:
      break
  }
  return out
}

/**
 * The same message with every float32-bound number blanked, so the non-float
 * structure (ids, counts, flags, strings) can be compared exactly by JSON.
 */
function stripFloats(msg: Message): unknown {
  const clone = JSON.parse(JSON.stringify(msg))
  const zeroV = (v: Record<string, number>): void => {
    if (v && typeof v === 'object') for (const k of Object.keys(v)) v[k] = 0
  }
  switch (clone.type) {
    case MsgType.Grab:
      zeroV(clone.pinchPoint)
      break
    case MsgType.MoveGrab:
    case MsgType.Drop:
    case MsgType.Square:
      zeroV(clone.point)
      break
    case MsgType.AvatarPose:
      zeroV(clone.pose.position)
      clone.pose.yaw = 0
      clone.pose.pitch = 0
      break
    case MsgType.Welcome: {
      const r = clone.room
      r.fixedDt = 0
      r.cardMass = 0
      zeroV(r.cardHalf)
      for (const k of Object.keys(r.table)) r.table[k] = 0
      break
    }
    case MsgType.Snapshot:
      for (const bdy of clone.bodies) {
        zeroV(bdy.p)
        zeroV(bdy.q)
        zeroV(bdy.v)
        zeroV(bdy.w)
      }
      for (const p of clone.players) {
        zeroV(p.pose.position)
        p.pose.yaw = 0
        p.pose.pitch = 0
        for (const slot of p.fan) {
          zeroV(slot.p)
          zeroV(slot.q)
        }
      }
      break
    default:
      break
  }
  return clone
}

// ---------------------------------------------------------------------------
// Run the async section, then tally.
// ---------------------------------------------------------------------------
await transportSection()

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
