/**
 * Tuning shared by client and server.
 *
 * Anything here that affects the wire format (quantization scales, seat count,
 * protocol version) MUST stay in lockstep on both ends — that is precisely why
 * it lives in `shared/` and is imported rather than duplicated.
 */

export const PROTOCOL_VERSION = 3

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Server presence broadcast rate. 20 Hz is the sweet spot: smooth after
 *  interpolation, ~1/3 the bandwidth of 60 Hz. */
export const TICK_HZ = 20
export const TICK_MS = 1000 / TICK_HZ

/** Client presence upload rate. Matched to the server tick — sending faster
 *  just gets coalesced, sending slower shows up as stutter. */
export const PRESENCE_SEND_HZ = 20
export const PRESENCE_SEND_MS = 1000 / PRESENCE_SEND_HZ

/**
 * Remote players are rendered this far in the past so there are always two
 * snapshots bracketing the render time. Two ticks (100 ms) plus a small jitter
 * margin. This is the single most important number for "does it feel smooth".
 */
export const INTERP_DELAY_MS = 110

/** If the buffer starves, extrapolate at most this long before freezing. */
export const MAX_EXTRAPOLATION_MS = 120

/** Ring buffer depth for incoming snapshots (~1.2 s of history at 20 Hz). */
export const SNAPSHOT_BUFFER = 24

export const HEARTBEAT_MS = 2000
export const CONNECTION_TIMEOUT_MS = 12_000
export const RECONNECT_BASE_MS = 400
export const RECONNECT_MAX_MS = 8000

/** How long a disconnected player keeps their seat, hand and score. */
export const DISCONNECT_GRACE_MS = 45_000
export const ROOM_TTL_MS = 1000 * 60 * 60 * 3

// ---------------------------------------------------------------------------
// Game rules
// ---------------------------------------------------------------------------

export const MAX_SEATS = 8
export const MIN_PLAYERS = 3
export const HAND_SIZE = 7
export const TARGET_SCORE = 7

// ---------------------------------------------------------------------------
// Quantization
//
// Presence is the hot path, so it goes over the wire as packed integers rather
// than JSON. These scales define the precision contract.
// ---------------------------------------------------------------------------

/** Metres → int16 at 1 mm resolution. Range ±32.7 m, far beyond the table. */
export const POS_SCALE = 1000

/** Radians → int16 at ~0.0001 rad. Range ±3.27 rad covers ±π. */
export const ANG_SCALE = 10_000

/** Normalized 0..1 → uint8. */
export const UNIT_SCALE = 255

// ---------------------------------------------------------------------------
// Table geometry
//
// Lives in shared/ because drag positions travel over the wire in table space:
// both ends must agree on what the coordinates mean.
// ---------------------------------------------------------------------------

export const TABLE_Y = 0
export const TABLE_RADIUS = 0.62
export const TABLE_SURFACE_Y = TABLE_Y + 0.001

/** Distance from table centre to a seat anchor. */
export const SEAT_RADIUS = 0.95

/** Card dimensions in metres (poker card ≈ 63 × 88 mm). */
export const CARD_W = 0.063
export const CARD_H = 0.088
export const CARD_D = 0.002

/** Seat index → world angle around the table (radians, 0 = +Z toward camera). */
export function seatAngle(seat: number, seatCount: number = MAX_SEATS): number {
  return (seat / seatCount) * Math.PI * 2
}

/** Seat index → world position of that seat's anchor. */
export function seatPosition(
  seat: number,
  seatCount: number = MAX_SEATS,
  radius: number = SEAT_RADIUS,
): { x: number; z: number } {
  const a = seatAngle(seat, seatCount)
  return { x: Math.sin(a) * radius, z: Math.cos(a) * radius }
}
