/**
 * Snapshot interpolation buffer.
 *
 * The server speaks at 20 Hz; the screen refreshes at 60–144 Hz. Rendering the
 * newest packet the instant it lands gives you 20 fps motion with jitter baked
 * in. Instead we deliberately render ~110 ms in the past, which guarantees two
 * snapshots bracket the render time, and interpolate between them. The cost is
 * a tenth of a second of latency on *other people's* avatars — which nobody can
 * perceive, because they have nothing to compare it against. Your own hand is
 * never interpolated (see prediction in client.ts), so your inputs stay instant.
 *
 * This is the single technique most responsible for a game feeling "smooth"
 * versus "networked".
 */

import {
  INTERP_DELAY_MS,
  MAX_EXTRAPOLATION_MS,
  SNAPSHOT_BUFFER,
} from '../../shared/constants'
import { emptyPresence, type Presence, type PresenceSnapshot } from '../../shared/protocol'

/** Shortest-arc angle interpolation — prevents a 359°→1° spin. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  const TAU = Math.PI * 2
  d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI
  return a + d * t
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function blend(a: Presence, b: Presence, t: number): Presence {
  return {
    seat: a.seat,
    headYaw: lerpAngle(a.headYaw, b.headYaw, t),
    headPitch: lerpAngle(a.headPitch, b.headPitch, t),
    // Discrete state snaps at the midpoint rather than smearing through
    // meaningless in-between values.
    hoverIndex: t < 0.5 ? a.hoverIndex : b.hoverIndex,
    dragging: t < 0.5 ? a.dragging : b.dragging,
    pointing: t < 0.5 ? a.pointing : b.pointing,
    dragX: lerp(a.dragX, b.dragX, t),
    dragY: lerp(a.dragY, b.dragY, t),
    dragZ: lerp(a.dragZ, b.dragZ, t),
    dragRotY: lerpAngle(a.dragRotY, b.dragRotY, t),
  }
}

export class InterpolationBuffer {
  private buffer: PresenceSnapshot[] = []
  /** Reused output map — sampling runs every frame and must not allocate. */
  private out = new Map<number, Presence>()

  /** Diagnostics. */
  lastSampleWasExtrapolated = false
  bufferedMs = 0

  push(snapshot: PresenceSnapshot) {
    const buf = this.buffer

    // Late packet: insert in order rather than discard. Out-of-order arrival is
    // normal on real networks and dropping it would leave a visible gap.
    if (buf.length && snapshot.serverTime <= buf[buf.length - 1].serverTime) {
      if (snapshot.serverTime <= (buf[0]?.serverTime ?? 0)) return
      let i = buf.length - 1
      while (i >= 0 && buf[i].serverTime > snapshot.serverTime) i--
      if (i >= 0 && buf[i].serverTime === snapshot.serverTime) return
      buf.splice(i + 1, 0, snapshot)
    } else {
      buf.push(snapshot)
    }

    while (buf.length > SNAPSHOT_BUFFER) buf.shift()
  }

  /** How far behind the newest snapshot we currently are. */
  latestServerTime(): number {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].serverTime : 0
  }

  /**
   * Sample every remote player at `serverTime - INTERP_DELAY_MS`.
   * `estimatedServerNow` comes from the clock sync in the net client.
   */
  sample(estimatedServerNow: number): Map<number, Presence> {
    const out = this.out
    out.clear()

    const buf = this.buffer
    if (!buf.length) return out

    const renderTime = estimatedServerNow - INTERP_DELAY_MS
    this.bufferedMs = this.latestServerTime() - renderTime
    this.lastSampleWasExtrapolated = false

    // Behind the whole buffer (just connected, or a long stall): clamp to the
    // oldest rather than showing nothing.
    if (renderTime <= buf[0].serverTime) {
      for (const p of buf[0].players) out.set(p.seat, p)
      return out
    }

    const newest = buf[buf.length - 1]

    // Ahead of the newest: the buffer starved. Hold the last known pose briefly
    // instead of extrapolating avatars into geometry — a frozen player reads as
    // "lagging", a flying one reads as "broken".
    if (renderTime >= newest.serverTime) {
      this.lastSampleWasExtrapolated = renderTime - newest.serverTime > 1
      if (renderTime - newest.serverTime > MAX_EXTRAPOLATION_MS) {
        for (const p of newest.players) out.set(p.seat, p)
        return out
      }
      for (const p of newest.players) out.set(p.seat, p)
      return out
    }

    // Find the bracketing pair. Buffer is tiny and sorted, so scan from newest —
    // in the steady state the answer is the last pair.
    let i = buf.length - 1
    while (i > 0 && buf[i - 1].serverTime > renderTime) i--
    const from = buf[i - 1]
    const to = buf[i]

    const span = to.serverTime - from.serverTime
    const t = span > 0 ? (renderTime - from.serverTime) / span : 0

    const toBySeat = new Map<number, Presence>()
    for (const p of to.players) toBySeat.set(p.seat, p)

    for (const a of from.players) {
      const b = toBySeat.get(a.seat)
      out.set(a.seat, b ? blend(a, b, t) : a)
      toBySeat.delete(a.seat)
    }
    // Seats that appeared only in the newer snapshot (someone just joined).
    for (const [seat, b] of toBySeat) out.set(seat, b)

    return out
  }

  /** Fallback for a seat we have never heard from. */
  static blank(seat: number): Presence {
    return emptyPresence(seat)
  }

  reset() {
    this.buffer.length = 0
    this.out.clear()
  }
}
