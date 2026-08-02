/**
 * server/index.ts — the thin Node host for authoritative rooms.
 *
 * Everything with a rule in it lives in `src/net/room.ts` and everything with a
 * byte layout in it lives in `src/net/protocol.ts`; both are pure and neither
 * knows this file exists. What is left here, and *only* here, is the transport:
 * accept a socket, speak enough of RFC 6455 to exchange binary frames, hand the
 * decoded intents to a room, and pump that room off a real clock.
 *
 * Why the WebSocket layer is hand-rolled. The npm registry is firewalled in
 * this project — `ws` cannot be installed — so the handshake and the frame
 * codec are written out against `node:crypto` and `node:http`. That is less
 * code than it sounds: the client half of RFC 6455 that a browser actually
 * sends is a masked binary or close frame, occasionally a ping, and the server
 * half we need to send back is an unmasked binary, pong, or close. The long
 * tail of the spec (extensions, continuation across many frames, text) is
 * either refused or handled defensively rather than implemented in full, and
 * each such choice is called out where it is made.
 *
 * The pump is deliberately dumb: one `setInterval`, catch the room up to the
 * wall clock in whole fixed steps, and when the step count crosses a snapshot
 * boundary, send each player the delta it is owed. The room decides what has
 * changed and what each player may see; the host only moves bytes.
 */

import { createServer, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { Socket } from 'node:net'

import {
  decodeClientMessage,
  encode,
  isServerMessage,
  messageName,
  MsgType,
  ProtocolError,
  type ServerMessage,
} from '../src/net/protocol.ts'
import { BROADCAST, Room, type RoomOptions } from '../src/net/room.ts'
import { TUNING } from '../src/physics.ts'

// ---------------------------------------------------------------------------
// WebSocket framing — RFC 6455, only the parts a browser uses.
// ---------------------------------------------------------------------------

/**
 * The fixed GUID from RFC 6455 §4.2.2. Appended to the client's key, hashed,
 * and echoed back; it is the whole of the handshake's proof that the server
 * spoke WebSocket rather than blindly accepting an HTTP upgrade.
 */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OpCode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const

/**
 * Guard against a hostile or broken client announcing a colossal frame. A
 * legitimate intent is tens of bytes; the largest thing a client ever sends is
 * a `Join`, which is a version and a short name. 64KiB is orders of magnitude
 * of headroom and still small enough that a bad length cannot exhaust memory.
 */
const MAX_FRAME_BYTES = 64 * 1024

/**
 * A single WebSocket connection, framing bytes on top of a raw TCP socket.
 *
 * Owns exactly one direction of policy: turn inbound bytes into whole messages
 * and hand each to `onMessage`; turn an outbound `Uint8Array` into one binary
 * frame. It knows nothing about rooms or the protocol — a decoded `Message`
 * never passes through here, only the framed bytes on either side of it.
 */
class WebSocketConn {
  private inbound: Buffer = Buffer.alloc(0)
  private closed = false
  /**
   * A control frame (ping/close) can legally arrive interleaved between the
   * fragments of a data message, so the data payload is accumulated separately
   * from whatever control frame might land mid-stream.
   */
  private fragments: Buffer[] = []
  private fragmentOp = 0

  onMessage: (data: Buffer) => void = () => {}
  onClose: () => void = () => {}

  // Declared as a field rather than a parameter property: Node's
  // `--experimental-strip-types` only erases types, and a parameter property
  // needs code generated to assign it, so the tests would refuse to load.
  private readonly socket: Socket

  constructor(socket: Socket) {
    this.socket = socket
    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('close', () => this.handleClose())
    socket.on('error', () => this.handleClose())
  }

  /** Append inbound bytes and drain as many whole frames as they contain. */
  private feed(chunk: Buffer): void {
    if (this.closed) return
    this.inbound = this.inbound.length === 0 ? chunk : Buffer.concat([this.inbound, chunk])

    // A frame's length is not known until its header is parsed, so parse
    // greedily and stop the moment the buffer is short of a whole frame,
    // leaving the partial bytes for the next chunk.
    for (;;) {
      const frame = this.readFrame()
      if (!frame) break
      this.dispatch(frame.op, frame.payload, frame.fin)
      if (this.closed) break
    }
  }

  /**
   * Parse one frame off the head of `inbound`, or return null if the buffer
   * does not yet hold a complete one. Every client frame MUST be masked
   * (RFC 6455 §5.1); an unmasked one is a protocol violation and the
   * connection is dropped rather than trusted.
   */
  private readFrame(): { op: number; payload: Buffer; fin: boolean } | null {
    const buf = this.inbound
    if (buf.length < 2) return null

    const b0 = buf[0]
    const b1 = buf[1]
    const fin = (b0 & 0x80) !== 0
    const op = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f

    let offset = 2
    if (len === 126) {
      if (buf.length < offset + 2) return null
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return null
      // A payload that needs the top 32 bits is far past MAX_FRAME_BYTES and
      // reading it as a Number would lose precision, so refuse it outright.
      const hi = buf.readUInt32BE(offset)
      const lo = buf.readUInt32BE(offset + 4)
      if (hi !== 0) return this.fail('frame length exceeds 32 bits')
      len = lo
      offset += 8
    }

    if (len > MAX_FRAME_BYTES) return this.fail(`frame of ${len} bytes over cap`)
    if (!masked) return this.fail('client frame was not masked')

    const maskStart = offset
    if (buf.length < maskStart + 4) return null
    const dataStart = maskStart + 4
    if (buf.length < dataStart + len) return null

    // Unmask in place into a fresh buffer: XOR each byte with the rotating
    // four-byte key. This is the one unavoidable copy per inbound frame.
    const payload = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) {
      payload[i] = buf[dataStart + i] ^ buf[maskStart + (i & 3)]
    }

    this.inbound = buf.subarray(dataStart + len)
    return { op, payload, fin }
  }

  /**
   * Act on one decoded frame. Data frames (binary, and their continuations)
   * are reassembled and surfaced; control frames are answered here and never
   * reach the room.
   */
  private dispatch(op: number, payload: Buffer, fin: boolean): void {
    switch (op) {
      case OpCode.Binary:
      case OpCode.Continuation: {
        if (op === OpCode.Binary) {
          this.fragments = []
          this.fragmentOp = OpCode.Binary
        }
        this.fragments.push(payload)
        if (!fin) return
        const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)
        this.fragments = []
        if (this.fragmentOp === OpCode.Binary) this.onMessage(whole)
        return
      }

      case OpCode.Text:
        // The protocol is binary end to end. A text frame can only be a client
        // that has misunderstood the contract, so say so and hang up rather
        // than guess at a decoding.
        this.close(1003, 'text frames are not supported')
        return

      case OpCode.Ping:
        // Echo the payload back as a pong, per §5.5.2. Keeps NAT mappings and
        // load-balancer idle timers alive without the room ever knowing.
        this.sendFrame(OpCode.Pong, payload)
        return

      case OpCode.Pong:
        // Unsolicited pongs are allowed as a one-way heartbeat (§5.5.3) and
        // need no reply.
        return

      case OpCode.Close:
        this.close(1000, '')
        return

      default:
        this.fail(`unknown opcode 0x${op.toString(16)}`)
    }
  }

  /** Frame and send one binary application message. */
  send(data: Uint8Array): void {
    this.sendFrame(OpCode.Binary, data)
  }

  private sendFrame(op: number, payload: Uint8Array): void {
    if (this.closed || this.socket.destroyed) return

    // Server frames are never masked (§5.1), so the header is just the fin+op
    // byte and a length that widens in the same three tiers the reader parses.
    const len = payload.length
    let header: Buffer
    if (len < 126) {
      header = Buffer.allocUnsafe(2)
      header[1] = len
    } else if (len <= 0xffff) {
      header = Buffer.allocUnsafe(4)
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.allocUnsafe(10)
      header[1] = 127
      // High 32 bits are always zero: nothing this server sends approaches 4GiB.
      header.writeUInt32BE(0, 2)
      header.writeUInt32BE(len, 6)
    }
    header[0] = 0x80 | op
    this.socket.write(header)
    this.socket.write(payload)
  }

  /** Send a close frame with a status code, then tear the socket down. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    const reasonBytes = Buffer.from(reason, 'utf8')
    const body = Buffer.allocUnsafe(2 + reasonBytes.length)
    body.writeUInt16BE(code, 0)
    reasonBytes.copy(body, 2)
    this.sendFrame(OpCode.Close, body)
    this.handleClose()
  }

  private fail(why: string): null {
    // 1002 is "protocol error". Returning null lets `readFrame`'s caller stop
    // draining; the socket is already on its way down.
    this.close(1002, why)
    return null
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    this.onClose()
  }
}

/**
 * Complete the opening HTTP handshake and return a framed connection, or null
 * if the request was not a well-formed WebSocket upgrade (in which case a plain
 * HTTP error has already been written).
 *
 * The accept token is `base64(sha1(key + WS_MAGIC))` — the client sent a random
 * key, and echoing this specific transform of it is how the client knows it is
 * talking to something that actually implements the protocol and not a cache or
 * proxy replaying an old 101.
 */
function acceptUpgrade(req: IncomingMessage, socket: Socket): WebSocketConn | null {
  const key = req.headers['sec-websocket-key']
  // Node usually collapses a header to a single string, but the types admit an
  // array; take the first value either way rather than assume.
  const rawUpgrade = req.headers['upgrade']
  const upgrade = (Array.isArray(rawUpgrade) ? rawUpgrade[0] : rawUpgrade ?? '').toLowerCase()
  if (upgrade !== 'websocket' || typeof key !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return null
  }

  const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  )
  // Turn off Nagle: a stream of small snapshots wants latency, not throughput,
  // and coalescing 40-byte frames to save header overhead is the wrong trade.
  socket.setNoDelay(true)
  return new WebSocketConn(socket)
}

// ---------------------------------------------------------------------------
// Host: rooms, connections, and the pump that drives them.
// ---------------------------------------------------------------------------

interface Connection {
  ws: WebSocketConn
  room: HostedRoom
  /** 0 until the client has sent a valid `Join`. */
  playerId: number
}

/**
 * A room plus the sockets attached to it and the clock state that catches it up
 * to real time. The `Room` itself has no timer by design; this is where the
 * wall clock finally meets it.
 */
class HostedRoom {
  readonly name: string
  readonly room: Room
  readonly connections = new Set<Connection>()
  private lastStepAt = now()
  /** Fractional fixed-steps carried between pumps, so timing never drifts. */
  private accumulator = 0

  constructor(name: string, options: RoomOptions) {
    this.name = name
    this.room = new Room(options)
  }

  /**
   * Advance the room by however much real time has passed, in whole fixed
   * steps, and flush a snapshot on every step that lands on a boundary.
   *
   * Snapshots are checked per crossed step rather than once at the end so that
   * catching up several steps at once (after a GC pause, say) still emits every
   * boundary it passed through and a client's tick sequence stays contiguous.
   */
  pump(): void {
    const t = now()
    const elapsed = Math.min((t - this.lastStepAt) / 1000, 0.25)
    this.lastStepAt = t
    this.accumulator += elapsed

    const dt = TUNING.fixedDt
    let stepped = false
    while (this.accumulator >= dt) {
      this.room.step(1)
      this.accumulator -= dt
      stepped = true
      if (this.room.snapshotDue()) this.flush()
    }
    // A room with no awake bodies still needs its very first snapshot out and
    // its events drained even on a tick where nothing stepped past a boundary.
    if (!stepped) this.flushEvents()
  }

  /**
   * Send each connected player the state it is owed: its private hand, its
   * personal delta snapshot, and any events addressed to it or broadcast.
   *
   * Order matters. `HandUpdate` goes first so a client that is about to see its
   * fan grow in the snapshot already holds the identities behind it. Events go
   * last: they are prompts and sounds layered over authoritative state, so they
   * should never arrive describing a world the client has not yet been given.
   */
  private flush(): void {
    for (const conn of this.connections) {
      if (conn.playerId === 0) continue
      const hand = this.room.pendingHandUpdate(conn.playerId)
      if (hand) send(conn, hand)
      send(conn, this.room.snapshotFor(conn.playerId))
    }
    this.flushEvents()
  }

  /** Route drained events by recipient. */
  private flushEvents(): void {
    const events = this.room.drainEvents()
    if (events.length === 0) return
    for (const { to, message } of events) {
      if (to === BROADCAST) {
        for (const conn of this.connections) {
          if (conn.playerId !== 0) send(conn, message)
        }
      } else {
        for (const conn of this.connections) {
          if (conn.playerId === to) send(conn, message)
        }
      }
    }
  }
}

/** One send point, so a failed frame write can never take the pump down. */
function send(conn: Connection, message: ServerMessage): void {
  if (!isServerMessage(message.type)) {
    // A server that framed a client message would be a bug in the room, not the
    // client; surface it loudly rather than putting it on the wire.
    throw new Error(`refusing to send client message ${messageName(message.type)}`)
  }
  try {
    conn.ws.send(encode(message))
  } catch (err) {
    console.error(`[${conn.room.name}] send failed:`, err)
    conn.ws.close(1011, 'send failed')
  }
}

export interface ServerOptions {
  port?: number
  /** Options applied to every room this host creates on demand. */
  room?: RoomOptions
  /** Milliseconds of wall time per pump. Defaults to the solver's own step. */
  tickMs?: number
}

export interface RunningServer {
  /** The port passed in, or 0 if the OS was asked to choose. See `ready`. */
  port: number
  /** Resolves with the actually-bound port once the socket is listening. */
  ready: Promise<number>
  close: () => Promise<void>
}

/**
 * Start the host. Returns a `close()` so a test — or a supervisor — can shut it
 * down cleanly, which is also why the pump interval is tracked and cleared
 * rather than left running for the process lifetime.
 *
 * `ready` resolves with the real bound port, which is the only way to learn it
 * when `port: 0` asked the OS to pick — a test connects a loopback client to
 * that number.
 */
export function startServer(options: ServerOptions = {}): RunningServer {
  const port = options.port ?? 8787
  const rooms = new Map<string, HostedRoom>()
  const connections = new Set<Connection>()

  function roomFor(name: string): HostedRoom {
    let hosted = rooms.get(name)
    if (!hosted) {
      // The room name seeds nothing by itself; a caller who wants a reproducible
      // table passes a seed in `options.room`. Two connections to the same name
      // share one authoritative room, which is the entire point of a name.
      hosted = new HostedRoom(name, { name, ...options.room })
      rooms.set(name, hosted)
    }
    return hosted
  }

  const http = createServer((_req, res) => {
    // This process serves exactly one thing — the WebSocket upgrade below.
    // Any plain GET is a health check or a mistake; 426 tells a browser it must
    // upgrade, and gives a monitor a body to match on.
    res.writeHead(426, { 'Content-Type': 'text/plain' })
    res.end('peril room server: connect over WebSocket\n')
  })

  http.on('upgrade', (req, socket) => {
    // `socket` is typed as a Duplex by the http types, but an upgrade is always
    // carried on the underlying TCP socket, which is the Socket the framer needs.
    const ws = acceptUpgrade(req, socket as Socket)
    if (!ws) return

    // Room chosen from the path: `/room/kitchen-table` -> "kitchen-table".
    // Missing or "/" falls back to a single default room, so the simplest
    // possible client (connect and play) works with no routing at all.
    const url = req.url ?? '/'
    const match = /^\/room\/([^/?#]+)/.exec(url)
    const roomName = match ? decodeURIComponent(match[1]) : 'default'
    const hosted = roomFor(roomName)

    const conn: Connection = { ws, room: hosted, playerId: 0 }
    hosted.connections.add(conn)
    connections.add(conn)

    ws.onMessage = (data) => handleMessage(conn, data)
    ws.onClose = () => {
      // A player who was seated leaves the table properly (their hand goes back
      // to the felt); one who never finished `Join` just vanishes.
      if (conn.playerId !== 0) hosted.room.leave(conn.playerId)
      hosted.connections.delete(conn)
      connections.delete(conn)
      // Drain the PlayerLeft so the others hear it on the next pump.
    }
  })

  function handleMessage(conn: Connection, data: Buffer): void {
    let msg
    try {
      msg = decodeClientMessage(data)
    } catch (err) {
      // A frame that will not decode is not something to reason about — a
      // client on this protocol does not produce one. Close on the protocol
      // errors we defined; log and ignore anything stranger so one bad frame
      // cannot crash the host.
      if (err instanceof ProtocolError) conn.ws.close(1002, err.message)
      else console.error(`[${conn.room.name}] decode error:`, err)
      return
    }

    // `Join` is special: it is the one message that mints a playerId, so it is
    // handled here rather than in `room.handle`, which routes by an id that does
    // not exist yet. Everything after Join goes straight to the room.
    if (msg.type === MsgType.Join) {
      if (conn.playerId !== 0) {
        conn.ws.close(1002, 'already joined')
        return
      }
      const result = conn.room.room.join(msg.name, msg.protocolVersion)
      if (!result.ok) {
        // The join was refused (bad version, room full). The room does not know
        // this socket yet, so the rejection is delivered by hand and the socket
        // closed — there is no seat to keep it around for.
        conn.ws.close(1008, `join refused: ${result.reason}`)
        return
      }
      conn.playerId = result.playerId
      send(conn, result.welcome)
      send(conn, conn.room.room.playerList())
      // A full snapshot immediately, so the client has the table before the
      // first pump boundary rather than a blank felt for up to a frame.
      send(conn, conn.room.room.snapshotFor(conn.playerId))
      const hand = conn.room.room.pendingHandUpdate(conn.playerId)
      if (hand) send(conn, hand)
      return
    }

    if (conn.playerId === 0) {
      // Anything before a successful Join is a client that skipped the
      // handshake step. Nothing to route it to.
      conn.ws.close(1008, 'first message must be Join')
      return
    }

    // The room returns a reject reason or null; either way it has already queued
    // any IntentRejected event, so there is nothing to do with the return here.
    conn.room.room.handle(conn.playerId, msg)
  }

  // One clock for every room. Rooms are cheap to pump when idle — a settled
  // table steps sleeping bodies and emits nothing — so a shared interval is
  // simpler and no worse than a timer per room.
  const stepMs = options.tickMs ?? TUNING.fixedDt * 1000
  const timer = setInterval(() => {
    for (const hosted of rooms.values()) hosted.pump()
  }, stepMs)
  // `setInterval` is typed as returning a `number` by the DOM lib, but at
  // runtime under Node it is a `Timeout` object carrying `unref`. Reach for it
  // through a cast rather than pull in the Node global just for this one call,
  // so an idle host (or a test runner) is never held open by the pump.
  const timerHandle = timer as unknown as { unref?: () => void }
  if (typeof timerHandle.unref === 'function') timerHandle.unref()

  const ready = new Promise<number>((resolve) => {
    http.listen(port, () => {
      const addr = http.address()
      resolve(addr && typeof addr === 'object' ? addr.port : port)
    })
  })

  return {
    port,
    ready,
    async close(): Promise<void> {
      clearInterval(timer)
      for (const conn of connections) conn.ws.close(1001, 'server shutting down')
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

/** Monotonic clock in milliseconds; `performance` exists in modern Node. */
const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

// Run directly (`node --experimental-strip-types server/index.ts`) rather than
// imported: start listening. A default seed keeps a manually-started server
// reproducible across restarts, which matters while the client is being built
// against it.
if (isEntrypoint()) {
  const port = Number(process.env.PORT ?? 8787)
  const seed = Number(process.env.ROOM_SEED ?? 1)
  const server = startServer({ port, room: { seed } })
  server.ready.then((bound) => console.log(`peril room server listening on :${bound}`))
  const shutdown = (): void => {
    server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * True when this module is the process entrypoint rather than an import.
 *
 * `import.meta.url` against `process.argv[1]` is the portable check now that
 * there is no CommonJS `require.main`. Kept in a try so that importing the file
 * in an exotic host (no argv, say) cannot throw at load.
 */
function isEntrypoint(): boolean {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry)
  } catch {
    return false
  }
}
