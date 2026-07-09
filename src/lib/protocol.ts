export type NetPlayer = {
  id: string
  name: string
  seat: number
  score: number
  connected: boolean
  faceDataUrl?: string
  isHost: boolean
  handCount?: number
}

export type PlayedSubmission = {
  playerId: string
  cards: string[]
  revealed: boolean
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
  updatedAt?: number
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
  | { type: 'play_cards'; cards: string[] }
  | { type: 'hover_card'; cardIndex: number | null }
  | { type: 'vote'; submissionPlayerId: string }
  | { type: 'next_round' }
  | { type: 'czar_pick'; submissionPlayerId: string }
  | { type: 'leave' }

export type ServerMsg =
  | { type: 'state'; state: RoomState }
  | { type: 'error'; message: string }
  | { type: 'peer_hover'; playerId: string; cardIndex: number | null }
  | { type: 'ip'; ip: string }
  | { type: 'joined'; playerId: string; code: string }

export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}
