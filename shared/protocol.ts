/**
 * Peril wire protocol.
 *
 * Two channels share one WebSocket:
 *
 *   1. Control  (JSON, reliable, event-driven) — joins, phase changes, plays,
 *      votes, authoritative room snapshots. Low rate, high value.
 *   2. Presence (binary, 20 Hz, lossy-by-design) — head pose, hover, live card
 *      drags. High rate, individually disposable: a dropped presence packet is
 *      corrected 50 ms later by the next one, so it never blocks.
 *
 * Splitting them is what makes drags feel synchronous without flooding the
 * socket with JSON.
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type RoomPhase =
  | 'lobby'
  | 'dealing'
  | 'playing'
  | 'revealing'
  | 'judging'
  | 'scoring'
  | 'ended'

export type PlayerPublic = {
  id: string
  name: string
  seat: number
  score: number
  connected: boolean
  isHost: boolean
  isBot: boolean
  /** Card count only — never the contents of someone else's hand. */
  handCount: number
  /** Has this player committed their play this round? */
  hasPlayed: boolean
  avatarHue: number
}

/** A card as the client knows it. `id` is stable for the card's lifetime. */
export type CardData = {
  id: string
  text: string
}

/** One player's committed play for the round. */
export type Submission = {
  /** Anonymised to `hidden:<n>` until the reveal phase. */
  playerId: string
  cards: CardData[]
  revealed: boolean
}

/** A card resting on the shared table surface, in table space. */
export type TableCard = {
  id: string
  ownerSeat: number
  text: string
  x: number
  z: number
  rotY: number
  faceUp: boolean
}

/**
 * Authoritative room snapshot. `you` is the only per-recipient field — it is
 * why the server serialises state per viewer instead of broadcasting one blob.
 */
export type RoomSnapshot = {
  code: string
  name: string
  phase: RoomPhase
  round: number
  hostId: string
  judgeId: string | null
  players: PlayerPublic[]
  prompt: { text: string; pick: number } | null
  submissions: Submission[]
  /** voterId → submission owner id. Present from `judging` onward. */
  votes: Record<string, string>
  winnerId: string | null
  roundWinnerId: string | null
  tableCards: TableCard[]
  /** Server-authoritative deadline for the current phase (server clock, ms). */
  phaseEndsAt: number | null
  /** Monotonic version — clients discard out-of-order snapshots. */
  rev: number
  you: {
    id: string
    seat: number
    hand: CardData[]
    isHost: boolean
    isJudge: boolean
  }
}

// ---------------------------------------------------------------------------
// Control channel: client → server
// ---------------------------------------------------------------------------

export type ClientControl =
  | {
      type: 'hello'
      protocol: number
      playerId: string
      name: string
      roomCode: string
      create: boolean
      roomName?: string
      avatarHue?: number
    }
  | { type: 'start' }
  | { type: 'add_bot' }
  | { type: 'remove_bot'; playerId: string }
  | { type: 'play_cards'; cardIds: string[] }
  | { type: 'unplay' }
  | { type: 'vote'; submissionPlayerId: string }
  | { type: 'next_round' }
  | { type: 'set_name'; name: string }
  | { type: 'restart' }
  | { type: 'leave' }
  /** Cheap RTT probe. `t` is echoed back untouched. */
  | { type: 'ping'; t: number }

// ---------------------------------------------------------------------------
// Control channel: server → client
// ---------------------------------------------------------------------------

export type ServerControl =
  | { type: 'welcome'; playerId: string; code: string; serverTime: number }
  | { type: 'snapshot'; state: RoomSnapshot }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'pong'; t: number; serverTime: number }
  /** Transient events the client turns into effects (sound, particles, toasts). */
  | { type: 'event'; event: RoomEvent }

export type RoomEvent =
  | { kind: 'player_joined'; name: string; seat: number }
  | { kind: 'player_left'; name: string; seat: number }
  | { kind: 'round_start'; round: number }
  | { kind: 'cards_dealt'; seat: number; count: number }
  | { kind: 'played'; seat: number }
  | { kind: 'reveal'; index: number }
  | { kind: 'round_won'; seat: number; score: number }
  | { kind: 'game_won'; seat: number }

// ---------------------------------------------------------------------------
// Presence channel (binary)
// ---------------------------------------------------------------------------

export const OP_PRESENCE_UP = 0x01
export const OP_PRESENCE_SNAPSHOT = 0x02

export const PRESENCE_FLAG_DRAGGING = 1 << 0
export const PRESENCE_FLAG_HOVERING = 1 << 1
export const PRESENCE_FLAG_CARD_FACE_UP = 1 << 2
export const PRESENCE_FLAG_POINTING = 1 << 3

/**
 * One player's transient state for a single tick.
 *
 * Drag coordinates are TABLE SPACE (origin = table centre, +Y up), not the
 * sender's local space — so every client can render the drag at the same world
 * point without knowing the sender's seat transform.
 */
export type Presence = {
  seat: number
  /** Head orientation, for avatar look-at. */
  headYaw: number
  headPitch: number
  /** Index of the hovered card within the player's own fan, or -1. */
  hoverIndex: number
  dragging: boolean
  pointing: boolean
  /** Live drag position in table space. Only meaningful when `dragging`. */
  dragX: number
  dragY: number
  dragZ: number
  dragRotY: number
}

export type PresenceSnapshot = {
  /** Server clock (ms) at which this snapshot was assembled. */
  serverTime: number
  players: Presence[]
}

export function emptyPresence(seat: number): Presence {
  return {
    seat,
    headYaw: 0,
    headPitch: 0,
    hoverIndex: -1,
    dragging: false,
    pointing: false,
    dragX: 0,
    dragY: 0,
    dragZ: 0,
    dragRotY: 0,
  }
}
