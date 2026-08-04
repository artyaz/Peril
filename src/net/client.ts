/**
 * Peril net client.
 *
 * Responsibilities:
 *   - one WebSocket, two channels (JSON control + binary presence)
 *   - clock synchronisation, so "server time" means the same thing on every
 *     machine and interpolation has a stable reference
 *   - reconnect with backoff that preserves the player's seat, hand and score
 *   - 20 Hz presence upload with change detection
 *
 * What it deliberately does NOT do: decide anything about the game. Every rule
 * lives on the server. The client sends intent and renders the answer.
 */

import {
  HEARTBEAT_MS,
  PRESENCE_SEND_MS,
  PROTOCOL_VERSION,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from '../../shared/constants'
import { decodePresenceSnapshot, encodePresenceUp, peekOpcode } from '../../shared/codec'
import {
  OP_PRESENCE_SNAPSHOT,
  emptyPresence,
  type ClientControl,
  type Presence,
  type RoomEvent,
  type RoomSnapshot,
  type ServerControl,
} from '../../shared/protocol'
import { InterpolationBuffer } from './interp'

export type NetStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'fatal'

export type NetOptions = {
  playerId: string
  name: string
  roomCode: string
  create: boolean
  roomName?: string
  avatarHue?: number
}

type ClockSample = { rtt: number; offset: number }

export class NetClient {
  status: NetStatus = 'idle'
  snapshot: RoomSnapshot | null = null
  readonly interp = new InterpolationBuffer()

  /** Round-trip time in ms (min-filtered — the honest number). */
  rtt = 0
  /** Last measured, unfiltered. Useful for a jitter readout. */
  rttInstant = 0

  onSnapshot: ((s: RoomSnapshot) => void) | null = null
  onEvent: ((e: RoomEvent) => void) | null = null
  onError: ((message: string, fatal: boolean) => void) | null = null
  onStatus: ((s: NetStatus) => void) | null = null

  private ws: WebSocket | null = null
  private opts: NetOptions | null = null
  private closedByUs = false

  /** Consecutive failed attempts. Public so the UI can surface a real message
   *  instead of leaving the player staring at a button that "does nothing". */
  attempts = 0
  /** True once any connection has ever succeeded. Distinguishes "server isn't
   *  there" (give up, tell the user) from "connection dropped" (retry forever). */
  everConnected = false

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private presenceTimer: ReturnType<typeof setInterval> | null = null

  /** performance.now() → server clock offset. */
  private clockOffset = 0
  private clockReady = false
  private samples: ClockSample[] = []

  private presenceSeq = 0
  private local: Presence = emptyPresence(-1)
  private lastSent: Presence = emptyPresence(-1)
  private lastSentAt = 0

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  connect(opts: NetOptions) {
    // Tear down anything already in flight FIRST.
    //
    // Without this, clicking "Create room" twice left the original socket and
    // its pending retry timer alive and started a second, independent
    // reconnect loop beside them. Each further click doubled the loops again,
    // which is how a dead endpoint produced hundreds of failed handshakes in
    // the console instead of the handful the backoff is designed to allow.
    this.teardown()

    this.opts = opts
    this.closedByUs = false
    this.attempts = 0
    this.open()
  }

  /** Detach and close the current socket without triggering a reconnect. */
  private teardown() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopTimers()

    const old = this.ws
    this.ws = null
    if (old) {
      // Null the handlers before closing, or the stale `onclose` fires and
      // schedules yet another reconnect for a socket we deliberately dropped.
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      try {
        old.close()
      } catch {
        /* already dead */
      }
    }

    this.interp.reset()
    this.clockReady = false
    this.samples.length = 0
  }

  private open() {
    if (!this.opts) return
    this.setStatus(this.attempts > 0 ? 'reconnecting' : 'connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
      this.everConnected = true
      this.setStatus('open')
      const o = this.opts!
      this.sendControl({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        playerId: o.playerId,
        name: o.name,
        roomCode: o.roomCode,
        create: o.create,
        roomName: o.roomName,
        avatarHue: o.avatarHue,
      })
      this.startTimers()
      this.ping()
    }

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        this.onControlMessage(ev.data)
      } else {
        this.onBinary(ev.data as ArrayBuffer)
      }
    }

    ws.onclose = () => {
      this.stopTimers()
      this.ws = null
      if (this.closedByUs || this.status === 'fatal') return
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // `onclose` always follows; handle reconnection there so we do it once.
    }
  }

  disconnect() {
    this.closedByUs = true
    this.teardown()
    this.setStatus('idle')
  }

  /** Attempts before we conclude the endpoint simply is not there. */
  private static readonly GIVE_UP_AFTER = 6

  private scheduleReconnect() {
    if (this.closedByUs) return

    this.attempts++

    // Never connected + repeated failures means the endpoint is wrong or the
    // server is not deployed — retrying forever just spams the console and
    // hides the problem. A drop AFTER a successful session is different: that
    // is a transient network event (or a Vercel function hitting its max
    // duration), so keep retrying indefinitely.
    if (!this.everConnected && this.attempts >= NetClient.GIVE_UP_AFTER) {
      this.setStatus('fatal')
      this.onError?.(
        `Can't reach the game server at ${wsUrl()} — ${this.attempts} attempts failed. ` +
          'The WebSocket endpoint is not responding.',
        true,
      )
      return
    }

    this.setStatus('reconnecting')
    // The buffer's timestamps refer to the old session's clock — keeping them
    // would make the first frames after reconnect jump.
    this.interp.reset()
    this.clockReady = false
    this.samples.length = 0

    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.attempts - 1))
    // Jitter so a server restart does not bring every client back in lockstep.
    const jittered = delay * (0.75 + Math.random() * 0.5)
    this.reconnectTimer = setTimeout(() => this.open(), jittered)
  }

  private startTimers() {
    this.stopTimers()
    this.pingTimer = setInterval(() => this.ping(), HEARTBEAT_MS)
    this.presenceTimer = setInterval(() => this.flushPresence(), PRESENCE_SEND_MS)
  }

  private stopTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.presenceTimer) clearInterval(this.presenceTimer)
    this.pingTimer = null
    this.presenceTimer = null
  }

  private setStatus(s: NetStatus) {
    if (this.status === s) return
    this.status = s
    this.onStatus?.(s)
  }

  // -------------------------------------------------------------------------
  // Clock sync
  //
  // Take the offset from the LOWEST-RTT sample in a rolling window rather than
  // averaging. A high RTT means the packet sat in a queue, which biases the
  // estimate; the fastest round trip is the least contaminated one.
  // -------------------------------------------------------------------------

  private ping() {
    this.sendControl({ type: 'ping', t: performance.now() })
  }

  private onPong(sentAt: number, serverTime: number) {
    const now = performance.now()
    const rtt = now - sentAt
    this.rttInstant = rtt

    // Assume symmetric latency: the server's clock at `now` is serverTime + rtt/2.
    const offset = serverTime + rtt / 2 - now
    this.samples.push({ rtt, offset })
    if (this.samples.length > 8) this.samples.shift()

    let best = this.samples[0]
    for (const s of this.samples) if (s.rtt < best.rtt) best = s
    this.rtt = best.rtt

    if (!this.clockReady) {
      this.clockOffset = best.offset
      this.clockReady = true
    } else {
      // Slew rather than snap: a jump would tear the interpolation.
      this.clockOffset += (best.offset - this.clockOffset) * 0.15
    }
  }

  /** Best estimate of the server's clock, right now. */
  serverNow(): number {
    return performance.now() + this.clockOffset
  }

  get clockSynced() {
    return this.clockReady
  }

  // -------------------------------------------------------------------------
  // Receive
  // -------------------------------------------------------------------------

  private onControlMessage(raw: string) {
    let msg: ServerControl
    try {
      msg = JSON.parse(raw) as ServerControl
    } catch {
      return
    }

    switch (msg.type) {
      case 'welcome':
        // First clock reference — refined by subsequent pongs.
        if (!this.clockReady) {
          this.clockOffset = msg.serverTime - performance.now()
        }
        break

      case 'snapshot':
        // Out-of-order or duplicate snapshot: ignore. `rev` is monotonic.
        if (this.snapshot && msg.state.rev < this.snapshot.rev) return
        this.snapshot = msg.state
        this.onSnapshot?.(msg.state)
        break

      case 'pong':
        this.onPong(msg.t, msg.serverTime)
        break

      case 'event':
        this.onEvent?.(msg.event)
        break

      case 'error':
        if (msg.fatal) {
          this.closedByUs = true
          this.setStatus('fatal')
        }
        this.onError?.(msg.message, !!msg.fatal)
        break
    }
  }

  private onBinary(data: ArrayBuffer) {
    if (peekOpcode(data) !== OP_PRESENCE_SNAPSHOT) return
    const snap = decodePresenceSnapshot(data)
    if (snap) this.interp.push(snap)
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  sendControl(msg: ClientControl) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      /* dropped */
    }
  }

  /** Write this frame's local presence. Uploaded on the next 20 Hz beat. */
  setPresence(patch: Partial<Presence>) {
    Object.assign(this.local, patch)
  }

  private flushPresence() {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (this.local.seat < 0) return

    const now = performance.now()
    const changed = presenceChanged(this.local, this.lastSent)
    // Idle players still send a keepalive so the server does not age them out
    // of the broadcast and make their avatar vanish.
    if (!changed && now - this.lastSentAt < 500) return

    // Never queue presence behind a congested socket — it is stale the moment
    // it waits, and the backlog only compounds.
    if (ws.bufferedAmount > 32 * 1024) return

    try {
      ws.send(encodePresenceUp(this.local, this.presenceSeq++))
      copyPresence(this.local, this.lastSent)
      this.lastSentAt = now
    } catch {
      /* dropped */
    }
  }

  /** Interpolated presence for every remote seat, sampled for this frame. */
  samplePresence(): Map<number, Presence> {
    return this.interp.sample(this.serverNow())
  }

  get localSeat() {
    return this.local.seat
  }

  get diagnostics() {
    return {
      status: this.status,
      rtt: Math.round(this.rtt),
      jitter: Math.round(Math.abs(this.rttInstant - this.rtt)),
      buffered: Math.round(this.interp.bufferedMs),
      starved: this.interp.lastSampleWasExtrapolated,
      rev: this.snapshot?.rev ?? 0,
    }
  }
}

// ---------------------------------------------------------------------------

/** Quantization-aware change test — sub-millimetre noise is not a change. */
function presenceChanged(a: Presence, b: Presence): boolean {
  return (
    a.seat !== b.seat ||
    a.dragging !== b.dragging ||
    a.pointing !== b.pointing ||
    a.hoverIndex !== b.hoverIndex ||
    Math.abs(a.headYaw - b.headYaw) > 0.002 ||
    Math.abs(a.headPitch - b.headPitch) > 0.002 ||
    Math.abs(a.dragX - b.dragX) > 0.0008 ||
    Math.abs(a.dragY - b.dragY) > 0.0008 ||
    Math.abs(a.dragZ - b.dragZ) > 0.0008 ||
    Math.abs(a.dragRotY - b.dragRotY) > 0.004
  )
}

function copyPresence(from: Presence, to: Presence) {
  to.seat = from.seat
  to.headYaw = from.headYaw
  to.headPitch = from.headPitch
  to.hoverIndex = from.hoverIndex
  to.dragging = from.dragging
  to.pointing = from.pointing
  to.dragX = from.dragX
  to.dragY = from.dragY
  to.dragZ = from.dragZ
  to.dragRotY = from.dragRotY
}

/**
 * WebSocket endpoint.
 *
 * Defaults to `/api/ws`, which is the one path that works everywhere: it is
 * the file-routed name of `api/ws.ts` on Vercel, and both the dev plugin and
 * the standalone server accept it as well as the bare `/ws`. One path, no
 * per-environment branching.
 *
 * Set `VITE_PERIL_WS` to point at a hub hosted somewhere else — e.g. keeping
 * the client on Vercel while the authoritative server runs on a long-lived
 * process:  VITE_PERIL_WS=wss://peril-hub.fly.dev/ws
 */
export function wsUrl(): string {
  const override = import.meta.env?.VITE_PERIL_WS as string | undefined
  if (override) return override
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/api/ws`
}
