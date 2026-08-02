/**
 * Binary codec for the presence channel.
 *
 * Presence is sent 20×/second by every player, so it is the only part of the
 * protocol where bytes actually matter. JSON for a single presence update runs
 * ~180 bytes; packed it is 17 up / 15 per player down.
 *
 *   8 players @ 20 Hz  →  6 + 15×8 = 126 B/tick  ≈ 2.5 KB/s downstream
 *   the JSON equivalent ≈ 29 KB/s.
 *
 * Layouts are fixed-size and offset-addressed: no length prefixes, no loops
 * over keys, no allocation beyond the single output buffer.
 */

import {
  ANG_SCALE,
  POS_SCALE,
} from './constants'
import {
  OP_PRESENCE_SNAPSHOT,
  OP_PRESENCE_UP,
  PRESENCE_FLAG_DRAGGING,
  PRESENCE_FLAG_POINTING,
  type Presence,
  type PresenceSnapshot,
} from './protocol'

const I16_MIN = -32768
const I16_MAX = 32767

function q(value: number, scale: number): number {
  const v = Math.round(value * scale)
  return v < I16_MIN ? I16_MIN : v > I16_MAX ? I16_MAX : v
}

/** Normalize an angle to (-π, π] so quantization never clips at the wrap. */
export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2
  let x = a % TAU
  if (x > Math.PI) x -= TAU
  else if (x <= -Math.PI) x += TAU
  return x
}

/**
 * Node's `ws` hands us a Buffer, which is a view into a pooled ArrayBuffer.
 * Constructing a DataView without honouring byteOffset reads the wrong bytes —
 * a classic and very confusing source of corruption.
 */
export function toDataView(data: ArrayBuffer | Uint8Array | DataView): DataView {
  if (data instanceof DataView) return data
  if (data instanceof Uint8Array) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  return new DataView(data)
}

export function peekOpcode(data: ArrayBuffer | Uint8Array | DataView): number {
  const view = toDataView(data)
  return view.byteLength > 0 ? view.getUint8(0) : -1
}

// ---------------------------------------------------------------------------
// Client → server: presence upload
//
//   0  u8    opcode
//   1  u16   seq            (wraps; used to drop reordered packets)
//   3  i16   headYaw
//   5  i16   headPitch
//   7  u8    flags
//   8  i8    hoverIndex     (-1 = none)
//   9  i16   dragX
//  11  i16   dragY
//  13  i16   dragZ
//  15  i16   dragRotY
//                                                            = 17 bytes
// ---------------------------------------------------------------------------

export const PRESENCE_UP_BYTES = 17

export function encodePresenceUp(p: Presence, seq: number): ArrayBuffer {
  const buf = new ArrayBuffer(PRESENCE_UP_BYTES)
  const v = new DataView(buf)

  let flags = 0
  if (p.dragging) flags |= PRESENCE_FLAG_DRAGGING
  if (p.pointing) flags |= PRESENCE_FLAG_POINTING
  if (p.hoverIndex >= 0) flags |= 1 << 1

  v.setUint8(0, OP_PRESENCE_UP)
  v.setUint16(1, seq & 0xffff)
  v.setInt16(3, q(wrapAngle(p.headYaw), ANG_SCALE))
  v.setInt16(5, q(wrapAngle(p.headPitch), ANG_SCALE))
  v.setUint8(7, flags)
  v.setInt8(8, Math.max(-1, Math.min(127, p.hoverIndex | 0)))
  v.setInt16(9, q(p.dragX, POS_SCALE))
  v.setInt16(11, q(p.dragY, POS_SCALE))
  v.setInt16(13, q(p.dragZ, POS_SCALE))
  v.setInt16(15, q(wrapAngle(p.dragRotY), ANG_SCALE))

  return buf
}

export function decodePresenceUp(
  data: ArrayBuffer | Uint8Array | DataView,
): { seq: number; presence: Omit<Presence, 'seat'> } | null {
  const v = toDataView(data)
  if (v.byteLength < PRESENCE_UP_BYTES) return null
  if (v.getUint8(0) !== OP_PRESENCE_UP) return null

  const flags = v.getUint8(7)
  return {
    seq: v.getUint16(1),
    presence: {
      headYaw: v.getInt16(3) / ANG_SCALE,
      headPitch: v.getInt16(5) / ANG_SCALE,
      hoverIndex: v.getInt8(8),
      dragging: (flags & PRESENCE_FLAG_DRAGGING) !== 0,
      pointing: (flags & PRESENCE_FLAG_POINTING) !== 0,
      dragX: v.getInt16(9) / POS_SCALE,
      dragY: v.getInt16(11) / POS_SCALE,
      dragZ: v.getInt16(13) / POS_SCALE,
      dragRotY: v.getInt16(15) / ANG_SCALE,
    },
  }
}

// ---------------------------------------------------------------------------
// Server → client: presence snapshot
//
//   0  u8    opcode
//   1  u32   serverTime  (ms since server epoch — fits 32 bits for ~49 days)
//   5  u8    playerCount
//   6  [ per player, 15 bytes ]
//        +0  u8   seat
//        +1  i16  headYaw
//        +3  i16  headPitch
//        +5  u8   flags
//        +6  i8   hoverIndex
//        +7  i16  dragX
//        +9  i16  dragY
//       +11  i16  dragZ
//       +13  i16  dragRotY
// ---------------------------------------------------------------------------

export const PRESENCE_HEADER_BYTES = 6
export const PRESENCE_ENTRY_BYTES = 15

export function encodePresenceSnapshot(snap: PresenceSnapshot): ArrayBuffer {
  const n = snap.players.length
  const buf = new ArrayBuffer(PRESENCE_HEADER_BYTES + n * PRESENCE_ENTRY_BYTES)
  const v = new DataView(buf)

  v.setUint8(0, OP_PRESENCE_SNAPSHOT)
  v.setUint32(1, snap.serverTime >>> 0)
  v.setUint8(5, n)

  let o = PRESENCE_HEADER_BYTES
  for (let i = 0; i < n; i++) {
    const p = snap.players[i]
    let flags = 0
    if (p.dragging) flags |= PRESENCE_FLAG_DRAGGING
    if (p.pointing) flags |= PRESENCE_FLAG_POINTING
    if (p.hoverIndex >= 0) flags |= 1 << 1

    v.setUint8(o, p.seat & 0xff)
    v.setInt16(o + 1, q(wrapAngle(p.headYaw), ANG_SCALE))
    v.setInt16(o + 3, q(wrapAngle(p.headPitch), ANG_SCALE))
    v.setUint8(o + 5, flags)
    v.setInt8(o + 6, Math.max(-1, Math.min(127, p.hoverIndex | 0)))
    v.setInt16(o + 7, q(p.dragX, POS_SCALE))
    v.setInt16(o + 9, q(p.dragY, POS_SCALE))
    v.setInt16(o + 11, q(p.dragZ, POS_SCALE))
    v.setInt16(o + 13, q(wrapAngle(p.dragRotY), ANG_SCALE))
    o += PRESENCE_ENTRY_BYTES
  }

  return buf
}

export function decodePresenceSnapshot(
  data: ArrayBuffer | Uint8Array | DataView,
): PresenceSnapshot | null {
  const v = toDataView(data)
  if (v.byteLength < PRESENCE_HEADER_BYTES) return null
  if (v.getUint8(0) !== OP_PRESENCE_SNAPSHOT) return null

  const serverTime = v.getUint32(1)
  const n = v.getUint8(5)
  if (v.byteLength < PRESENCE_HEADER_BYTES + n * PRESENCE_ENTRY_BYTES) return null

  const players: Presence[] = new Array(n)
  let o = PRESENCE_HEADER_BYTES
  for (let i = 0; i < n; i++) {
    const flags = v.getUint8(o + 5)
    players[i] = {
      seat: v.getUint8(o),
      headYaw: v.getInt16(o + 1) / ANG_SCALE,
      headPitch: v.getInt16(o + 3) / ANG_SCALE,
      hoverIndex: v.getInt8(o + 6),
      dragging: (flags & PRESENCE_FLAG_DRAGGING) !== 0,
      pointing: (flags & PRESENCE_FLAG_POINTING) !== 0,
      dragX: v.getInt16(o + 7) / POS_SCALE,
      dragY: v.getInt16(o + 9) / POS_SCALE,
      dragZ: v.getInt16(o + 11) / POS_SCALE,
      dragRotY: v.getInt16(o + 13) / ANG_SCALE,
    }
    o += PRESENCE_ENTRY_BYTES
  }

  return { serverTime, players }
}

/** True when `a` is newer than `b` under uint16 wraparound. */
export function seqNewer(a: number, b: number): boolean {
  return ((a - b) & 0xffff) < 0x8000 && a !== b
}
