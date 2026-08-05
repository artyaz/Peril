/**
 * Room hub: owns every live room, its sockets, and the 20 Hz tick.
 *
 * Design notes that matter for synchronous play:
 *
 *  - ONE timer drives every room. N rooms do not mean N drifting intervals.
 *  - Control snapshots are sent only when `rev` actually changes. Presence goes
 *    out every tick, but only to rooms with someone to see it.
 *  - Presence is relayed, not simulated: the server trusts a client's own head
 *    pose and drag position because faking those wins you nothing. Anything
 *    that affects scoring goes through the engine and is validated.
 *  - Every socket carries a `seat`, so presence packets need no id lookup on
 *    the hot path.
 */

import type { WebSocket } from 'ws'
import {
  HEARTBEAT_MS,
  CONNECTION_TIMEOUT_MS,
  MAX_SEATS,
  PROTOCOL_VERSION,
  ROOM_TTL_MS,
  TICK_MS,
} from '../shared/constants.js'
import {
  decodePresenceUp,
  encodePresenceSnapshot,
  peekOpcode,
  seqNewer,
} from '../shared/codec.js'
import {
  OP_PRESENCE_UP,
  emptyPresence,
  type ClientControl,
  type Presence,
  type ServerControl,
} from '../shared/protocol.js'
import {
  addBot,
  castVote,
  createRoom,
  drainEvents,
  joinRoom,
  makeRoomCode,
  markDisconnected,
  nextRound,
  playCards,
  removePlayer,
  restart,
  snapshotFor,
  startGame,
  tick as engineTick,
  unplay,
  type ServerRoom,
} from './engine.js'

/** Server clock: ms since process start. Fits a uint32 for ~49 days, which is
 *  what lets presence timestamps ride in 4 bytes. */
const EPOCH = Date.now()
export const serverNow = (): number => Date.now() - EPOCH

/** Presence older than this is dropped from the broadcast — a frozen avatar is
 *  worse than an absent one. */
const PRESENCE_STALE_MS = 1500

type Client = {
  ws: WebSocket
  playerId: string
  code: string
  seat: number
  alive: boolean
  lastSeq: number
  lastPresenceAt: number
  /** Last snapshot rev delivered — suppresses redundant sends. */
  sentRev: number
}

type RoomRuntime = {
  room: ServerRoom
  clients: Map<string, Client>
  /** seat → latest presence. Fixed-size: seats are the natural key. */
  presence: (Presence | null)[]
}

export class Hub {
  private rooms = new Map<string, RoomRuntime>()
  private timer: ReturnType<typeof setInterval> | null = null

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    // Never hold the process open on our account.
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      ;(this.timer as { unref: () => void }).unref()
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  stats() {
    return {
      rooms: this.rooms.size,
      clients: [...this.rooms.values()].reduce((n, r) => n + r.clients.size, 0),
      uptime: serverNow(),
    }
  }

  listRooms() {
    return [...this.rooms.values()].map((rt) => ({
      code: rt.room.code,
      name: rt.room.name,
      phase: rt.room.phase,
      players: rt.room.players.size,
      max: MAX_SEATS,
    }))
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  handleConnection(ws: WebSocket) {
    let client: Client | null = null

    ws.on('message', (data: unknown, isBinary: boolean) => {
      try {
        if (isBinary) {
          if (client) this.onPresence(client, data as Uint8Array)
          return
        }
        const msg = JSON.parse(String(data)) as ClientControl
        if (msg.type === 'hello') {
          client = this.onHello(ws, msg)
          return
        }
        if (client) this.onControl(client, msg)
      } catch {
        // A malformed frame kills the frame, never the socket.
      }
    })

    ws.on('pong', () => {
      if (client) client.alive = true
    })

    ws.on('close', () => {
      if (!client) return
      const rt = this.rooms.get(client.code)
      if (!rt) return
      rt.clients.delete(client.playerId)
      rt.presence[client.seat] = null
      markDisconnected(rt.room, client.playerId, serverNow())
      this.flush(rt)
      client = null
    })

    ws.on('error', () => {
      try {
        ws.close()
      } catch {
        /* already gone */
      }
    })
  }

  private onHello(ws: WebSocket, msg: Extract<ClientControl, { type: 'hello' }>): Client | null {
    if (msg.protocol !== PROTOCOL_VERSION) {
      send(ws, {
        type: 'error',
        message: `Version mismatch — reload the page (client v${msg.protocol}, server v${PROTOCOL_VERSION}).`,
        fatal: true,
      })
      return null
    }

    const code = (msg.roomCode || '').toUpperCase().trim()
    let rt = code ? this.rooms.get(code) : undefined

    if (!rt) {
      if (!msg.create) {
        send(ws, { type: 'error', message: `Room ${code} not found.`, fatal: true })
        return null
      }
      const newCode = code || makeRoomCode()
      rt = {
        room: createRoom({
          code: newCode,
          name: msg.roomName || `${msg.name}'s table`,
          hostId: msg.playerId,
        }),
        clients: new Map(),
        presence: new Array(MAX_SEATS).fill(null),
      }
      this.rooms.set(newCode, rt)
    }

    // Re-joining from a second tab: drop the stale socket, keep the seat.
    const prior = rt.clients.get(msg.playerId)
    if (prior && prior.ws !== ws) {
      try {
        prior.ws.close()
      } catch {
        /* ignore */
      }
    }

    const joined = joinRoom(rt.room, {
      playerId: msg.playerId,
      name: msg.name,
      avatarHue: msg.avatarHue,
    })
    if (!joined.ok) {
      send(ws, { type: 'error', message: joined.error, fatal: true })
      return null
    }

    const client: Client = {
      ws,
      playerId: msg.playerId,
      code: rt.room.code,
      seat: joined.player.seat,
      alive: true,
      lastSeq: -1,
      lastPresenceAt: 0,
      sentRev: -1,
    }
    rt.clients.set(client.playerId, client)
    rt.presence[client.seat] = emptyPresence(client.seat)

    send(ws, {
      type: 'welcome',
      playerId: client.playerId,
      code: rt.room.code,
      serverTime: serverNow(),
    })
    this.flush(rt)
    return client
  }

  // -------------------------------------------------------------------------
  // Presence (hot path)
  // -------------------------------------------------------------------------

  private onPresence(client: Client, data: Uint8Array) {
    if (peekOpcode(data) !== OP_PRESENCE_UP) return
    const decoded = decodePresenceUp(data)
    if (!decoded) return

    // Drop reordered/duplicate packets. Presence is lossy by design; a stale
    // one would visibly snap the avatar backwards.
    if (client.lastSeq >= 0 && !seqNewer(decoded.seq, client.lastSeq)) return
    client.lastSeq = decoded.seq
    client.lastPresenceAt = serverNow()

    const rt = this.rooms.get(client.code)
    if (!rt) return
    rt.presence[client.seat] = { seat: client.seat, ...decoded.presence }
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  private onControl(client: Client, msg: ClientControl) {
    const rt = this.rooms.get(client.code)
    if (!rt) return
    const now = serverNow()
    const room = rt.room

    switch (msg.type) {
      case 'ping':
        send(client.ws, { type: 'pong', t: msg.t, serverTime: now })
        return

      case 'start':
        if (room.hostId === client.playerId) {
          if (!startGame(room, now)) {
            send(client.ws, { type: 'error', message: 'Need at least 3 players — add a bot?' })
          }
        }
        break

      case 'add_bot':
        if (room.hostId === client.playerId) {
          if (!addBot(room)) send(client.ws, { type: 'error', message: 'Table is full.' })
        }
        break

      case 'remove_bot': {
        const target = room.players.get(msg.playerId)
        if (room.hostId === client.playerId && target?.isBot) removePlayer(room, msg.playerId)
        break
      }

      case 'play_cards': {
        const res = playCards(room, client.playerId, msg.cardIds, now)
        if (!res.ok) send(client.ws, { type: 'error', message: res.error ?? 'Could not play' })
        break
      }

      case 'unplay':
        unplay(room, client.playerId)
        break

      case 'vote':
        castVote(room, client.playerId, msg.submissionPlayerId, now)
        break

      case 'next_round':
        if (room.hostId === client.playerId && room.phase === 'scoring') nextRound(room, now)
        break

      case 'restart':
        if (room.hostId === client.playerId) restart(room)
        break

      case 'set_name': {
        const p = room.players.get(client.playerId)
        if (p) {
          p.name = (msg.name || p.name).slice(0, 18)
          room.rev++
        }
        break
      }

      case 'leave':
        removePlayer(room, client.playerId)
        rt.clients.delete(client.playerId)
        rt.presence[client.seat] = null
        try {
          client.ws.close()
        } catch {
          /* ignore */
        }
        break
    }

    this.flush(rt)
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  private lastHeartbeat = 0

  private tick() {
    const now = serverNow()
    const wall = Date.now()
    const beat = now - this.lastHeartbeat >= HEARTBEAT_MS
    if (beat) this.lastHeartbeat = now

    for (const [code, rt] of this.rooms) {
      // Reap empty / expired rooms.
      if (rt.clients.size === 0 && wall - rt.room.updatedAt > ROOM_TTL_MS) {
        this.rooms.delete(code)
        continue
      }

      if (engineTick(rt.room, now)) {
        // Seats may have changed (reaped players) — resync presence slots.
        for (let s = 0; s < MAX_SEATS; s++) {
          if (rt.room.seats[s] === null) rt.presence[s] = null
        }
      }

      this.flush(rt)
      this.broadcastPresence(rt, now)

      if (beat) this.heartbeat(rt)
    }
  }

  private heartbeat(rt: RoomRuntime) {
    for (const client of rt.clients.values()) {
      if (!client.alive) {
        // Missed two beats: the socket is a zombie. Close it so the grace
        // timer starts and the seat is eventually freed.
        try {
          client.ws.terminate()
        } catch {
          /* ignore */
        }
        continue
      }
      client.alive = false
      try {
        client.ws.ping()
      } catch {
        /* ignore */
      }
    }
  }

  /** Send authoritative state to anyone whose view is out of date. */
  private flush(rt: RoomRuntime) {
    const events = drainEvents(rt.room)
    const rev = rt.room.rev

    for (const client of rt.clients.values()) {
      if (client.ws.readyState !== 1) continue
      if (client.sentRev !== rev) {
        client.sentRev = rev
        send(client.ws, { type: 'snapshot', state: snapshotFor(rt.room, client.playerId) })
      }
      for (const event of events) send(client.ws, { type: 'event', event })
    }
  }

  private broadcastPresence(rt: RoomRuntime, now: number) {
    // Nobody to see it — skip the encode entirely.
    if (rt.clients.size < 2) return

    const players: Presence[] = []
    for (let s = 0; s < MAX_SEATS; s++) {
      const p = rt.presence[s]
      if (!p) continue
      const owner = rt.room.seats[s]
      if (!owner) continue
      const client = rt.clients.get(owner)
      if (client && now - client.lastPresenceAt > PRESENCE_STALE_MS) continue
      players.push(p)
    }
    if (!players.length) return

    const buf = encodePresenceSnapshot({ serverTime: now, players })
    for (const client of rt.clients.values()) {
      if (client.ws.readyState !== 1) continue
      // Skip a socket that is already backed up — presence is disposable, and
      // queueing it behind a slow link only makes the backlog worse.
      if (client.ws.bufferedAmount > 64 * 1024) continue
      try {
        client.ws.send(buf, { binary: true })
      } catch {
        /* dropped */
      }
    }
  }
}

function send(ws: WebSocket, msg: ServerControl) {
  if (ws.readyState !== 1) return
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    /* socket died mid-send */
  }
}

export { CONNECTION_TIMEOUT_MS }
