export type NetPlayer = {
  id: string
  name: string
  seat: number
  score: number
  connected: boolean
  faceDataUrl?: string
  isHost: boolean
  isBot?: boolean
  /** False when a player joined after the current round began. */
  activeThisRound?: boolean
  handCount?: number
}

export type PlayedSubmission = {
  /** Stable, anonymous identity that does not change when cards are revealed. */
  id: string
  playerId: string
  cards: string[]
  revealed: boolean
  /** Drop positions on the table (local table-space xz) */
  positions?: { x: number; z: number; rotY?: number }[]
}

export type TableCardPos = {
  key: string
  x: number
  z: number
  rotY: number
}

/** Live drag of a card (hand→table or rearrange on table) — visible to all peers */
export type CardDrag = {
  playerId: string
  cardText: string
  source: 'hand' | 'table'
  key?: string
  x: number
  z: number
  y: number
}

export type RoomPhase =
  | 'lobby'
  | 'dealing'
  | 'playing'
  | 'revealing'
  | 'voting'
  | 'scoring'
  | 'ended'

export type RoomState = {
  code: string
  name: string
  hostId: string
  phase: RoomPhase
  players: NetPlayer[]
  packIds: string[]
  maxPlayers: number
  handSize: number
  blackCard: { text: string; pick: number } | null
  czarId: string | null
  submissions: PlayedSubmission[]
  votes: Record<string, string> // voterId -> submission playerId
  winnerId: string | null
  round: number
  /** Monotonic room version used to reject stale/out-of-order responses. */
  revision?: number
  updatedAt?: number
  phaseStartedAt?: number
  phaseEndsAt?: number | null
  progress?: {
    submitted: number
    submissionsRequired: number
    votesCast: number
    votersRequired: number
  }
  /** playerId → hovered card index (or null) — synced so peers see peeks */
  hover?: Record<string, number | null>
  /** playerId → text of the card currently being peeked (if any) */
  hoverText?: Record<string, string | null>
  /** Live card drag shared with peers */
  drag?: CardDrag | null
  /** Free positions of cards currently on the table */
  tablePositions?: TableCardPos[]
  you?: {
    hand: string[]
    selected: string[]
  }
}

export type ClientMsg =
  | { type: 'hello'; playerId: string; name: string; faceDataUrl?: string; roomCode: string; create?: boolean; roomName?: string; packIds?: string[]; ipHint?: string }
  | { type: 'set_packs'; packIds: string[] }
  | { type: 'set_face'; faceDataUrl: string }
  | { type: 'start' }
  | { type: 'add_bot' }
  | { type: 'play_cards'; cards: string[]; positions?: { x: number; z: number; rotY?: number }[] }
  | { type: 'hover_card'; cardIndex: number | null; cardText?: string | null }
  | { type: 'drag_card'; drag: CardDrag | null; sequence?: number }
  | { type: 'move_table_card'; key: string; x: number; z: number; rotY?: number }
  | { type: 'vote'; submissionPlayerId: string }
  | { type: 'next_round' }
  | { type: 'czar_pick'; submissionPlayerId: string }
  | { type: 'leave' }

export type ServerMsg =
  | { type: 'state'; state: RoomState }
  | { type: 'error'; message: string }
  | { type: 'peer_hover'; playerId: string; cardIndex: number | null; cardText?: string | null }
  | { type: 'peer_drag'; drag: CardDrag | null }
  | { type: 'ip'; ip: string }
  | { type: 'joined'; playerId: string; code: string }

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'

export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}
