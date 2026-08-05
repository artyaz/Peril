/**
 * End-to-end netcode test.
 *
 *   npx tsx server/netcode.test.ts
 *
 * Spins up a real hub on a real socket and drives it with real WebSocket
 * clients. Covers the things that actually break in multiplayer: hand privacy,
 * seat assignment, phase progression, binary presence round-trips, snapshot
 * convergence across clients, interpolation, and reconnect.
 */

import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { PROTOCOL_VERSION, MAX_SEATS } from '../shared/constants'
import {
  decodePresenceSnapshot,
  encodePresenceUp,
  encodePresenceSnapshot,
  decodePresenceUp,
  peekOpcode,
  seqNewer,
} from '../shared/codec'
import {
  OP_PRESENCE_SNAPSHOT,
  emptyPresence,
  type ClientControl,
  type Presence,
  type RoomSnapshot,
  type ServerControl,
} from '../shared/protocol'
import { Hub } from './hub'
import { InterpolationBuffer } from '../src/net/interp'

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(name: string) {
  console.log(`\n\x1b[1m${name}\x1b[0m`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Test client
// ---------------------------------------------------------------------------

class TestClient {
  ws!: WebSocket
  snapshot: RoomSnapshot | null = null
  snapshots = 0
  presenceSnapshots = 0
  readonly interp = new InterpolationBuffer()
  lastPresence: ReturnType<typeof decodePresenceSnapshot> = null
  errors: string[] = []
  welcomed = false
  private seq = 0

  constructor(
    readonly id: string,
    readonly name: string,
    readonly url: string,
  ) {}

  connect(roomCode: string, create: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.binaryType = 'arraybuffer'

      const timeout = setTimeout(() => reject(new Error(`${this.name} connect timeout`)), 4000)

      ws.on('open', () => {
        this.send({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          playerId: this.id,
          name: this.name,
          roomCode,
          create,
        })
      })

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.presenceSnapshots++
          const snap = decodePresenceSnapshot(data)
          if (snap) {
            this.lastPresence = snap
            this.interp.push(snap)
          }
          return
        }
        const msg = JSON.parse(data.toString()) as ServerControl
        if (msg.type === 'welcome') {
          this.welcomed = true
          clearTimeout(timeout)
          resolve()
        } else if (msg.type === 'snapshot') {
          this.snapshot = msg.state
          this.snapshots++
        } else if (msg.type === 'error') {
          this.errors.push(msg.message)
          clearTimeout(timeout)
          if (msg.fatal) reject(new Error(msg.message))
        }
      })

      ws.on('error', (e) => {
        clearTimeout(timeout)
        reject(e)
      })
    })
  }

  send(msg: ClientControl) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  sendPresence(p: Partial<Presence>) {
    const full: Presence = { ...emptyPresence(this.snapshot?.you.seat ?? 0), ...p }
    this.ws.send(encodePresenceUp(full, this.seq++), { binary: true })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/** Wait until `predicate` holds, polling. */
async function until(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = 'condition',
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await sleep(25)
  }
  console.log(`    (timed out waiting for ${label})`)
  return false
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('\x1b[1m\x1b[36m\nPeril netcode test suite\x1b[0m')

  // ---- Pure codec tests (no sockets needed) -------------------------------
  section('Binary codec')
  {
    const p: Presence = {
      seat: 5,
      headYaw: 1.234,
      headPitch: -0.456,
      hoverIndex: 3,
      dragging: true,
      pointing: false,
      dragX: 0.123,
      dragY: 0.456,
      dragZ: -0.789,
      dragRotY: 2.5,
    }
    const buf = encodePresenceUp(p, 42)
    check('presence upload is 17 bytes', buf.byteLength === 17, `got ${buf.byteLength}`)

    const back = decodePresenceUp(buf)
    check('round-trips seq', back?.seq === 42)
    check('round-trips flags', back?.presence.dragging === true && back?.presence.pointing === false)
    check('round-trips hoverIndex', back?.presence.hoverIndex === 3)
    check(
      'position within 1mm',
      Math.abs((back?.presence.dragX ?? 0) - p.dragX) < 0.001 &&
        Math.abs((back?.presence.dragZ ?? 0) - p.dragZ) < 0.001,
    )
    check(
      'angles within 0.001 rad',
      Math.abs((back?.presence.headYaw ?? 0) - p.headYaw) < 0.001 &&
        Math.abs((back?.presence.dragRotY ?? 0) - p.dragRotY) < 0.001,
    )

    const snap = encodePresenceSnapshot({
      serverTime: 123456,
      players: [p, { ...p, seat: 2 }],
    })
    check('snapshot is 6 + 15n bytes', snap.byteLength === 6 + 15 * 2, `got ${snap.byteLength}`)
    check('snapshot opcode', peekOpcode(snap) === OP_PRESENCE_SNAPSHOT)
    const decoded = decodePresenceSnapshot(snap)
    check('snapshot round-trips time', decoded?.serverTime === 123456)
    check('snapshot round-trips both players', decoded?.players.length === 2)
    check('snapshot preserves seats', decoded?.players[1].seat === 2)

    // Angle wrap must not clip at ±π.
    const wrapped = decodePresenceUp(
      encodePresenceUp({ ...p, headYaw: Math.PI - 0.001 }, 1),
    )
    check(
      'angle near +π survives quantization',
      Math.abs((wrapped?.presence.headYaw ?? 0) - (Math.PI - 0.001)) < 0.001,
    )

    check('seq wraparound: 0 newer than 65535', seqNewer(0, 65535))
    check('seq wraparound: 65535 not newer than 0', !seqNewer(65535, 0))

    // Simulated bandwidth at 8 players / 20 Hz.
    const bytesPerSec = (6 + 15 * 8) * 20
    check(
      `8-player presence under 4 KB/s (${bytesPerSec} B/s)`,
      bytesPerSec < 4096,
    )
  }

  // ---- Interpolation ------------------------------------------------------
  section('Interpolation buffer')
  {
    const buf = new InterpolationBuffer()
    const mk = (t: number, x: number): { serverTime: number; players: Presence[] } => ({
      serverTime: t,
      players: [{ ...emptyPresence(0), dragX: x, dragging: true }],
    })
    buf.push(mk(1000, 0))
    buf.push(mk(1050, 1))
    buf.push(mk(1100, 2))

    // renderTime = now - 110. Ask for now = 1160 → render at 1050 → exactly x=1.
    let s = buf.sample(1160)
    check('interpolates to exact keyframe', Math.abs((s.get(0)?.dragX ?? -1) - 1) < 1e-6)

    // now = 1185 → render at 1075 → halfway between 1 and 2.
    s = buf.sample(1185)
    check('interpolates midpoint', Math.abs((s.get(0)?.dragX ?? -1) - 1.5) < 1e-6)

    // Out-of-order insertion must be repaired, not dropped.
    const buf2 = new InterpolationBuffer()
    buf2.push(mk(1000, 0))
    buf2.push(mk(1100, 2))
    buf2.push(mk(1050, 1)) // late
    s = buf2.sample(1185)
    check('repairs out-of-order arrival', Math.abs((s.get(0)?.dragX ?? -1) - 1.5) < 1e-6)

    // Starvation must clamp, not fly off.
    s = buf2.sample(9999)
    check('clamps when buffer starves', (s.get(0)?.dragX ?? -1) === 2)

    // Shortest-arc angle blending across the ±π seam.
    const buf3 = new InterpolationBuffer()
    buf3.push({
      serverTime: 1000,
      players: [{ ...emptyPresence(0), headYaw: Math.PI - 0.1 }],
    })
    buf3.push({
      serverTime: 1100,
      players: [{ ...emptyPresence(0), headYaw: -Math.PI + 0.1 }],
    })
    const mid = buf3.sample(1160).get(0)!.headYaw
    check(
      'blends across the ±π seam the short way',
      Math.abs(Math.abs(mid) - Math.PI) < 0.02,
      `got ${mid.toFixed(3)}`,
    )
  }

  // ---- Live server --------------------------------------------------------
  section('Live server: rooms and membership')

  const hub = new Hub()
  hub.start()
  const http = createServer()
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => hub.handleConnection(ws))
  })
  await new Promise<void>((r) => http.listen(0, r))
  const port = (http.address() as { port: number }).port
  const url = `ws://127.0.0.1:${port}/ws`

  const alice = new TestClient('p-alice', 'Alice', url)
  const bob = new TestClient('p-bob', 'Bob', url)
  const cara = new TestClient('p-cara', 'Cara', url)

  await alice.connect('TEST1', true)
  check('host creates a room', alice.welcomed)
  await until(() => alice.snapshot !== null, 2000, 'first snapshot')
  check('host receives a snapshot', alice.snapshot !== null)
  check('host is seated at 0', alice.snapshot?.you.seat === 0)
  check('host is flagged host', alice.snapshot?.you.isHost === true)
  check('room starts in lobby', alice.snapshot?.phase === 'lobby')

  await bob.connect('TEST1', false)
  await cara.connect('TEST1', false)
  await until(() => (alice.snapshot?.players.length ?? 0) === 3, 2000, '3 players')
  check('three players in the room', alice.snapshot?.players.length === 3)
  check('seats are distinct', new Set(alice.snapshot?.players.map((p) => p.seat)).size === 3)
  check('joiner is not host', bob.snapshot?.you.isHost === false)

  const missing = new TestClient('p-ghost', 'Ghost', url)
  let rejected = false
  await missing.connect('NOPE9', false).catch(() => (rejected = true))
  check('joining a missing room is rejected', rejected)

  // ---- Game start ---------------------------------------------------------
  section('Live server: free play open')

  bob.send({ type: 'start' })
  await sleep(120)
  check('non-host cannot open the table', alice.snapshot?.phase === 'lobby')

  alice.send({ type: 'start' })
  const started = await until(
    () => alice.snapshot?.phase === 'open',
    4000,
    'open phase',
  )
  check('host opens the table into free play', started)
  check('hand is dealt to the local player', (alice.snapshot?.you.hand.length ?? 0) === 7)
  check('notepad is present', typeof alice.snapshot?.notepad === 'string')

  // ---- Hand privacy (the important one) -----------------------------------
  section('Hand privacy')
  {
    const aliceHand = new Set(alice.snapshot!.you.hand.map((c) => c.text))
    const bobHand = new Set(bob.snapshot!.you.hand.map((c) => c.text))
    check('each player gets their own distinct hand', aliceHand.size === 7 && bobHand.size === 7)

    // The decisive check: Bob's snapshot must contain zero card text for Alice.
    const bobRaw = JSON.stringify(bob.snapshot)
    const leaked = [...aliceHand].filter(
      (t) => bobRaw.includes(t) && !bobHand.has(t),
    )
    check(
      "a peer's snapshot contains none of your card text",
      leaked.length === 0,
      leaked.length ? `leaked: ${leaked.slice(0, 2).join(' | ')}` : '',
    )
    check(
      'peers see only a hand COUNT',
      bob.snapshot!.players.every((p) => typeof p.handCount === 'number'),
    )
  }

  // ---- Free place / move / pickup ----------------------------------------
  section('Free card movement')
  {
    const card = alice.snapshot!.you.hand[0]
    alice.send({
      type: 'place_cards',
      cards: [{ id: 'not-a-real-card', x: 0.1, z: 0.05, rotY: 0 }],
    })
    await sleep(120)
    check('a card not in hand is rejected', alice.snapshot!.you.hand.length === 7)

    alice.send({
      type: 'place_cards',
      cards: [{ id: card.id, x: 0.12, z: -0.08, rotY: 0.2 }],
    })
    await until(() => alice.snapshot!.you.hand.length === 6, 2000, 'hand shrinks')
    check('placed cards leave the hand', alice.snapshot!.you.hand.length === 6)
    check(
      'placed cards appear on the table for everyone',
      (bob.snapshot?.tableCards.some((c) => c.id === card.id && c.text === card.text) ?? false),
    )

    // Anyone can reposition a table card.
    bob.send({
      type: 'move_cards',
      cards: [{ id: card.id, x: -0.15, z: 0.1, rotY: -0.3 }],
    })
    await until(
      () => Math.abs((alice.snapshot?.tableCards.find((c) => c.id === card.id)?.x ?? 0) + 0.15) < 0.001,
      2000,
      'card moved',
    )
    check(
      'table card pose is authoritative',
      Math.abs(alice.snapshot!.tableCards.find((c) => c.id === card.id)!.x + 0.15) < 0.001,
    )

    // Cara picks it up into her hand.
    cara.send({ type: 'pickup_cards', cardIds: [card.id] })
    await until(
      () => cara.snapshot!.you.hand.some((c) => c.id === card.id),
      2000,
      'pickup',
    )
    check('pickup returns the card to a hand', cara.snapshot!.you.hand.some((c) => c.id === card.id))
    check(
      'picked-up card leaves the table',
      !alice.snapshot!.tableCards.some((c) => c.id === card.id),
    )

    // Shared notepad.
    alice.send({ type: 'set_notepad', text: 'Alice 3\nBob 2\nCara 1' })
    await until(() => bob.snapshot?.notepad === 'Alice 3\nBob 2\nCara 1', 2000, 'notepad sync')
    check('notepad syncs to peers', bob.snapshot?.notepad === 'Alice 3\nBob 2\nCara 1')
  }

  // ---- Presence -----------------------------------------------------------
  section('Presence channel')
  {
    const before = bob.presenceSnapshots
    for (let i = 0; i < 8; i++) {
      alice.sendPresence({
        seat: alice.snapshot!.you.seat,
        headYaw: 0.5,
        headPitch: -0.2,
        dragging: true,
        dragX: 0.25,
        dragY: 0.14,
        dragZ: -0.1,
        hoverIndex: 2,
      })
      await sleep(30)
    }
    await sleep(200)

    check('peers receive presence broadcasts', bob.presenceSnapshots > before)

    const entry = bob.lastPresence?.players.find(
      (p) => p.seat === alice.snapshot!.you.seat,
    )
    check("a peer's drag position arrives intact", !!entry && Math.abs(entry.dragX - 0.25) < 0.002)
    check('drag flag propagates', entry?.dragging === true)
    check('hover index propagates', entry?.hoverIndex === 2)
    check('head pose propagates', !!entry && Math.abs(entry.headYaw - 0.5) < 0.002)

    // Rate: the hub broadcasts at TICK_HZ regardless of client send rate.
    const t0 = bob.presenceSnapshots
    await sleep(500)
    const rate = (bob.presenceSnapshots - t0) / 0.5
    check(`broadcast rate ≈20 Hz (measured ${rate.toFixed(0)} Hz)`, rate > 12 && rate < 28)
  }

  // ---- Convergence --------------------------------------------------------
  section('State convergence')
  {
    await sleep(300)
    const revs = [alice, bob, cara].map((c) => c.snapshot?.rev ?? -1)
    check(
      'every client converges on the same revision',
      new Set(revs).size === 1,
      `revs: ${revs.join(', ')}`,
    )
    const phases = [alice, bob, cara].map((c) => c.snapshot?.phase)
    check('every client agrees on the phase', new Set(phases).size === 1)
    const scores = [alice, bob, cara].map((c) =>
      JSON.stringify(c.snapshot?.players.map((p) => [p.seat, p.handCount])),
    )
    check('every client agrees on hand counts', new Set(scores).size === 1)
    check(
      'every client agrees on the notepad',
      new Set([alice, bob, cara].map((c) => c.snapshot?.notepad)).size === 1,
    )
  }

  // ---- Reconnect ----------------------------------------------------------
  section('Reconnect')
  {
    const seatBefore = bob.snapshot!.you.seat
    const scoreBefore = bob.snapshot!.players.find((p) => p.id === bob.id)!.score

    bob.close()
    await sleep(300)
    check(
      'a dropped player is marked disconnected, not removed',
      alice.snapshot!.players.some((p) => p.id === bob.id && !p.connected),
    )

    const bob2 = new TestClient('p-bob', 'Bob', url)
    await bob2.connect('TEST1', false)
    await until(() => bob2.snapshot !== null, 2000, 'reconnect snapshot')
    check('reconnect restores the same seat', bob2.snapshot?.you.seat === seatBefore)
    check(
      'reconnect restores the score',
      bob2.snapshot?.players.find((p) => p.id === 'p-bob')?.score === scoreBefore,
    )
    check(
      'reconnect restores the hand',
      (bob2.snapshot?.you.hand.length ?? 0) > 0,
    )
    bob2.close()
  }

  // ---- Capacity -----------------------------------------------------------
  section('Capacity')
  {
    const room = new TestClient('p-cap-host', 'CapHost', url)
    await room.connect('CAP01', true)
    await until(() => room.snapshot !== null, 2000)

    const extras: TestClient[] = []
    for (let i = 1; i < MAX_SEATS; i++) {
      const c = new TestClient(`p-cap-${i}`, `Cap${i}`, url)
      await c.connect('CAP01', false)
      extras.push(c)
    }
    await until(() => (room.snapshot?.players.length ?? 0) === MAX_SEATS, 3000, 'full room')
    check(`room fills to ${MAX_SEATS} seats`, room.snapshot?.players.length === MAX_SEATS)

    const overflow = new TestClient('p-cap-x', 'Overflow', url)
    let full = false
    await overflow.connect('CAP01', false).catch(() => (full = true))
    check('the 9th player is turned away', full)

    room.close()
    for (const c of extras) c.close()
  }

  // ---- Endpoint paths -----------------------------------------------------
  section('Endpoint paths')
  {
    // The client uses a single URL everywhere; `/api/ws` is what Vercel's file
    // routing produces for api/ws.ts, and dev/standalone must accept it too.
    for (const path of ['/ws', '/api/ws']) {
      const probe = new TestClient(`p-path-${path}`, 'Path', `ws://127.0.0.1:${port}${path}`)
      let ok = true
      await probe.connect('PATHS', true).catch(() => (ok = false))
      check(`accepts an upgrade on ${path}`, ok)
      probe.close()
    }
  }

  // ---- Connection resilience (regressions) --------------------------------
  section('Connection resilience')
  {
    // Find a port with nothing on it, so connects are refused immediately.
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, r))
    const deadPort = (probe.address() as { port: number }).port
    await new Promise<void>((r) => probe.close(() => r()))

    // NetClient reaches for browser globals; supply the two it needs.
    const g = globalThis as unknown as Record<string, unknown>
    g.location = { protocol: 'http:', host: `127.0.0.1:${deadPort}` }

    // Spy on socket construction. Counting *concurrently live* sockets is what
    // actually distinguishes the bug: the give-up logic terminates either way,
    // so a test that only asserts the end state passes even when connect()
    // leaks parallel loops. Peak concurrency does not.
    const RealWS = globalThis.WebSocket
    let live = 0
    let peakLive = 0
    let constructed = 0
    class SpyWebSocket extends RealWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        constructed++
        live++
        peakLive = Math.max(peakLive, live)
        this.addEventListener('close', () => {
          live--
        })
        // Connection-refused emits 'error' before 'close'; swallow it so node
        // does not treat it as unhandled.
        this.addEventListener('error', () => {})
      }
    }
    g.WebSocket = SpyWebSocket

    const { NetClient } = await import('../src/net/client')

    const client = new NetClient()
    let fatalCount = 0
    client.onError = (_m, fatal) => {
      if (fatal) fatalCount++
    }

    // Mash the button. Before the fix each call left the previous socket and
    // its pending retry timer running, so three clicks meant three independent
    // reconnect loops racing each other.
    const opts = {
      playerId: 'p-resilience',
      name: 'Resilience',
      roomCode: 'DEAD1',
      create: true,
    }
    client.connect(opts)
    client.connect(opts)
    client.connect(opts)

    const gaveUp = await until(() => fatalCount > 0, 30_000, 'give-up')
    check('an unreachable server eventually reports a fatal error', gaveUp)
    check(
      'repeated connect() calls never leave sockets open in parallel',
      peakLive === 1,
      `peak concurrent sockets was ${peakLive}`,
    )
    // 3 explicit connect() calls + (GIVE_UP_AFTER − 1) retries on the surviving
    // loop. Anything more means a leaked loop is still constructing sockets.
    check(
      'total sockets stay bounded',
      constructed <= 8,
      `${constructed} sockets constructed`,
    )
    check('gives up exactly once', fatalCount === 1, `saw ${fatalCount}`)
    check('status is terminal after giving up', client.status === 'fatal')

    client.disconnect()
    g.WebSocket = RealWS
    delete g.location
  }

  // ---- Teardown -----------------------------------------------------------
  alice.close()
  cara.close()
  hub.stop()
  // Force sockets down: http.close() waits on live connections, and several
  // test clients are intentionally still open at this point.
  for (const ws of wss.clients) ws.terminate()
  await new Promise<void>((r) => {
    wss.close(() => {
      http.closeAllConnections?.()
      http.close(() => r())
    })
  })

  console.log(
    `\n\x1b[1m${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`,
  )
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n\x1b[31mTest harness crashed:\x1b[0m', e)
  process.exit(1)
})
