/**
 * Peril game engine — pure logic, no I/O.
 *
 * The server is authoritative: clients send intents, the engine validates them
 * and produces the next state. Nothing here touches sockets, which keeps it
 * trivially testable and makes the room layer a thin adapter.
 *
 * Every phase carries a deadline. A player who disconnects mid-round, rage
 * quits, or simply wanders off can never stall the table — `tick()` advances
 * the game on their behalf. That is the difference between a demo and
 * something you can actually play with seven friends.
 */

import {
  DISCONNECT_GRACE_MS,
  HAND_SIZE,
  MAX_SEATS,
  MIN_PLAYERS,
  TARGET_SCORE,
} from '../shared/constants'
import type {
  CardData,
  PlayerPublic,
  RoomEvent,
  RoomPhase,
  RoomSnapshot,
  Submission,
  TableCard,
} from '../shared/protocol'
import { buildDeck, type Prompt } from './deck'

// ---------------------------------------------------------------------------
// Phase durations (ms)
// ---------------------------------------------------------------------------

const DEAL_MS = 1400
const PLAY_MS = 90_000
const REVEAL_STEP_MS = 850
const JUDGE_MS = 60_000
const SCORE_MS = 7000
/** Bots wait a beat so the table does not snap instantly. */
const BOT_PLAY_MIN_MS = 1800
const BOT_PLAY_JITTER_MS = 4500

// ---------------------------------------------------------------------------
// Server-side state (superset of what any client is allowed to see)
// ---------------------------------------------------------------------------

export type ServerPlayer = {
  id: string
  name: string
  seat: number
  score: number
  connected: boolean
  isHost: boolean
  isBot: boolean
  avatarHue: number
  hand: CardData[]
  /** Committed play for this round, or null. */
  played: CardData[] | null
  disconnectedAt: number | null
  /** Bot only: server time at which it will play. */
  botActAt: number
}

export type ServerRoom = {
  code: string
  name: string
  hostId: string
  phase: RoomPhase
  round: number
  rev: number
  players: Map<string, ServerPlayer>
  /** seat index → playerId. Length MAX_SEATS. */
  seats: (string | null)[]
  promptPile: Prompt[]
  responsePile: string[]
  discard: string[]
  prompt: Prompt | null
  judgeSeat: number
  /** Shuffled player ids — reveal + display order, hides who played what. */
  submissionOrder: string[]
  revealedCount: number
  /** voterId → submission owner id. The judge's entry is binding. */
  votes: Record<string, string>
  roundWinnerId: string | null
  winnerId: string | null
  tableCards: TableCard[]
  phaseEndsAt: number
  cardSeq: number
  createdAt: number
  updatedAt: number
  pendingEvents: RoomEvent[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function emit(room: ServerRoom, event: RoomEvent) {
  room.pendingEvents.push(event)
}

function touch(room: ServerRoom) {
  room.rev++
  room.updatedAt = Date.now()
}

export function makeRoomCode(): string {
  // Ambiguous glyphs (0/O, 1/I) removed — these get read aloud over voice chat.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 5; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

export function createRoom(opts: {
  code: string
  name: string
  hostId: string
  packIds?: string[]
}): ServerRoom {
  const deck = buildDeck(opts.packIds ?? [])
  return {
    code: opts.code,
    name: opts.name || 'Peril',
    hostId: opts.hostId,
    phase: 'lobby',
    round: 0,
    rev: 0,
    players: new Map(),
    seats: new Array(MAX_SEATS).fill(null),
    promptPile: shuffle([...deck.prompts]),
    responsePile: shuffle([...deck.responses]),
    discard: [],
    prompt: null,
    judgeSeat: -1,
    submissionOrder: [],
    revealedCount: 0,
    votes: {},
    roundWinnerId: null,
    winnerId: null,
    tableCards: [],
    phaseEndsAt: 0,
    cardSeq: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pendingEvents: [],
  }
}

function activePlayers(room: ServerRoom): ServerPlayer[] {
  return [...room.players.values()].sort((a, b) => a.seat - b.seat)
}

/** Players who can act this round: connected (or bot), seated. */
function livePlayers(room: ServerRoom): ServerPlayer[] {
  return activePlayers(room).filter((p) => p.connected || p.isBot)
}

function judgeId(room: ServerRoom): string | null {
  if (room.judgeSeat < 0) return null
  return room.seats[room.judgeSeat]
}

function firstFreeSeat(room: ServerRoom): number {
  for (let i = 0; i < MAX_SEATS; i++) if (room.seats[i] === null) return i
  return -1
}

function drawResponse(room: ServerRoom): string {
  if (!room.responsePile.length) {
    // Recycle. A long game must never run dry.
    room.responsePile = shuffle(room.discard.splice(0))
    if (!room.responsePile.length) room.responsePile = ['(the deck is empty)']
  }
  return room.responsePile.pop()!
}

function newCard(room: ServerRoom, text: string): CardData {
  return { id: `c${room.cardSeq++}`, text }
}

function refillHand(room: ServerRoom, p: ServerPlayer) {
  while (p.hand.length < HAND_SIZE) {
    p.hand.push(newCard(room, drawResponse(room)))
  }
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export function joinRoom(
  room: ServerRoom,
  input: { playerId: string; name: string; avatarHue?: number },
): { ok: true; player: ServerPlayer } | { ok: false; error: string } {
  const existing = room.players.get(input.playerId)
  if (existing) {
    // Reconnect — seat, hand and score survive.
    existing.connected = true
    existing.disconnectedAt = null
    if (input.name) existing.name = input.name.slice(0, 18)
    touch(room)
    return { ok: true, player: existing }
  }

  const seat = firstFreeSeat(room)
  if (seat < 0) return { ok: false, error: 'Room is full' }

  const player: ServerPlayer = {
    id: input.playerId,
    name: (input.name || 'Player').slice(0, 18),
    seat,
    score: 0,
    connected: true,
    isHost: room.players.size === 0 || room.hostId === input.playerId,
    isBot: false,
    avatarHue: input.avatarHue ?? Math.floor(Math.random() * 360),
    hand: [],
    played: null,
    disconnectedAt: null,
    botActAt: 0,
  }

  if (player.isHost) room.hostId = player.id
  room.players.set(player.id, player)
  room.seats[seat] = player.id

  // Late joiners get a hand immediately so they can play the next round.
  if (room.phase !== 'lobby') refillHand(room, player)

  emit(room, { kind: 'player_joined', name: player.name, seat })
  touch(room)
  return { ok: true, player }
}

export function addBot(room: ServerRoom): boolean {
  const seat = firstFreeSeat(room)
  if (seat < 0) return false
  const names = ['Bishop', 'Cortana', 'HAL', 'Marvin', 'Data', 'Wheatley', 'GLaDOS', 'Clippy']
  const used = new Set([...room.players.values()].map((p) => p.name))
  const name = names.find((n) => !used.has(n)) ?? `Bot ${seat + 1}`
  const id = `bot:${seat}:${Math.random().toString(36).slice(2, 8)}`

  const bot: ServerPlayer = {
    id,
    name,
    seat,
    score: 0,
    connected: true,
    isHost: false,
    isBot: true,
    avatarHue: Math.floor(Math.random() * 360),
    hand: [],
    played: null,
    disconnectedAt: null,
    botActAt: 0,
  }
  room.players.set(id, bot)
  room.seats[seat] = id
  if (room.phase !== 'lobby') refillHand(room, bot)
  emit(room, { kind: 'player_joined', name: bot.name, seat })
  touch(room)
  return true
}

export function markDisconnected(room: ServerRoom, playerId: string, now: number) {
  const p = room.players.get(playerId)
  if (!p) return
  p.connected = false
  p.disconnectedAt = now
  touch(room)
}

export function removePlayer(room: ServerRoom, playerId: string) {
  const p = room.players.get(playerId)
  if (!p) return
  room.seats[p.seat] = null
  room.players.delete(playerId)
  // Discard their hand so cards return to circulation.
  room.discard.push(...p.hand.map((c) => c.text))
  emit(room, { kind: 'player_left', name: p.name, seat: p.seat })

  if (room.hostId === playerId) {
    const next = livePlayers(room).find((q) => !q.isBot)
    if (next) {
      next.isHost = true
      room.hostId = next.id
    }
  }
  touch(room)
}

// ---------------------------------------------------------------------------
// Round flow
// ---------------------------------------------------------------------------

export function startGame(room: ServerRoom, now: number): boolean {
  if (room.phase !== 'lobby' && room.phase !== 'ended') return false
  if (livePlayers(room).length < MIN_PLAYERS) return false

  for (const p of room.players.values()) {
    p.score = 0
    p.hand = []
    p.played = null
    refillHand(room, p)
    emit(room, { kind: 'cards_dealt', seat: p.seat, count: p.hand.length })
  }

  room.round = 0
  room.winnerId = null
  room.judgeSeat = -1
  room.phase = 'dealing'
  room.phaseEndsAt = now + DEAL_MS
  touch(room)
  return true
}

function advanceJudge(room: ServerRoom) {
  const seated = livePlayers(room)
  if (!seated.length) return
  const seats = seated.map((p) => p.seat).sort((a, b) => a - b)
  if (room.judgeSeat < 0) {
    room.judgeSeat = seats[0]
    return
  }
  const next = seats.find((s) => s > room.judgeSeat)
  room.judgeSeat = next ?? seats[0]
}

export function beginRound(room: ServerRoom, now: number) {
  room.round++
  advanceJudge(room)

  if (!room.promptPile.length) {
    const deck = buildDeck([])
    room.promptPile = shuffle([...deck.prompts])
  }
  room.prompt = room.promptPile.pop() ?? null

  for (const p of room.players.values()) {
    if (p.played) room.discard.push(...p.played.map((c) => c.text))
    p.played = null
    refillHand(room, p)
    if (p.isBot) {
      p.botActAt = now + BOT_PLAY_MIN_MS + Math.random() * BOT_PLAY_JITTER_MS
    }
  }

  room.submissionOrder = []
  room.revealedCount = 0
  room.votes = {}
  room.roundWinnerId = null
  room.tableCards = []
  room.phase = 'playing'
  room.phaseEndsAt = now + PLAY_MS

  emit(room, { kind: 'round_start', round: room.round })
  touch(room)
}

/** Everyone except the judge must play. */
function expectedPlayers(room: ServerRoom): ServerPlayer[] {
  const jid = judgeId(room)
  return livePlayers(room).filter((p) => p.id !== jid)
}

export function playCards(
  room: ServerRoom,
  playerId: string,
  cardIds: string[],
  now: number,
): { ok: boolean; error?: string } {
  if (room.phase !== 'playing') return { ok: false, error: 'Not the play phase' }
  const p = room.players.get(playerId)
  if (!p) return { ok: false, error: 'Unknown player' }
  if (p.id === judgeId(room)) return { ok: false, error: 'The judge does not play' }
  if (p.played) return { ok: false, error: 'Already played' }

  const need = room.prompt?.pick ?? 1
  if (cardIds.length !== need) return { ok: false, error: `Play exactly ${need}` }

  const picked: CardData[] = []
  for (const id of cardIds) {
    const card = p.hand.find((c) => c.id === id)
    if (!card) return { ok: false, error: 'Card not in hand' }
    if (picked.some((c) => c.id === id)) return { ok: false, error: 'Duplicate card' }
    picked.push(card)
  }

  p.hand = p.hand.filter((c) => !cardIds.includes(c.id))
  p.played = picked
  emit(room, { kind: 'played', seat: p.seat })

  if (expectedPlayers(room).every((q) => q.played)) {
    enterRevealing(room, now)
  }
  touch(room)
  return { ok: true }
}

/** Take a play back while the round is still open. */
export function unplay(room: ServerRoom, playerId: string): boolean {
  if (room.phase !== 'playing') return false
  const p = room.players.get(playerId)
  if (!p || !p.played) return false
  p.hand.push(...p.played)
  p.played = null
  touch(room)
  return true
}

function enterRevealing(room: ServerRoom, now: number) {
  const submitters = expectedPlayers(room).filter((p) => p.played)
  room.submissionOrder = shuffle(submitters.map((p) => p.id))
  room.revealedCount = 0
  room.phase = 'revealing'
  room.phaseEndsAt = now + REVEAL_STEP_MS
  touch(room)
}

function enterJudging(room: ServerRoom, now: number) {
  room.phase = 'judging'
  room.phaseEndsAt = now + JUDGE_MS

  // Lay the revealed plays out on the table so every client agrees on where
  // each card sits — positions are authoritative, not locally invented.
  room.tableCards = []
  const n = room.submissionOrder.length
  for (let i = 0; i < n; i++) {
    const pid = room.submissionOrder[i]
    const p = room.players.get(pid)
    if (!p?.played) continue
    const spread = Math.min(0.42, n * 0.09)
    const t = n === 1 ? 0.5 : i / (n - 1)
    const baseX = (t - 0.5) * spread * 2
    p.played.forEach((card, ci) => {
      room.tableCards.push({
        id: card.id,
        ownerSeat: p.seat,
        text: card.text,
        x: baseX + ci * 0.035,
        z: -0.06 + ci * 0.02,
        rotY: (Math.random() - 0.5) * 0.12,
        faceUp: true,
      })
    })
  }
  touch(room)
}

export function castVote(
  room: ServerRoom,
  voterId: string,
  submissionPlayerId: string,
  now: number,
): boolean {
  if (room.phase !== 'judging') return false
  if (!room.players.has(submissionPlayerId)) return false
  if (!room.submissionOrder.includes(submissionPlayerId)) return false

  room.votes[voterId] = submissionPlayerId

  // Only the judge's vote resolves the round; everyone else's is advisory,
  // which keeps the whole table engaged instead of idling during judging.
  if (voterId === judgeId(room)) {
    resolveRound(room, submissionPlayerId, now)
  }
  touch(room)
  return true
}

function resolveRound(room: ServerRoom, winnerPlayerId: string, now: number) {
  const winner = room.players.get(winnerPlayerId)
  if (winner) {
    winner.score++
    room.roundWinnerId = winner.id
    emit(room, { kind: 'round_won', seat: winner.seat, score: winner.score })
    if (winner.score >= TARGET_SCORE) {
      room.winnerId = winner.id
      emit(room, { kind: 'game_won', seat: winner.seat })
    }
  }
  room.phase = 'scoring'
  room.phaseEndsAt = now + SCORE_MS
  touch(room)
}

export function nextRound(room: ServerRoom, now: number) {
  if (room.winnerId) {
    room.phase = 'ended'
    room.phaseEndsAt = 0
    touch(room)
    return
  }
  if (livePlayers(room).length < MIN_PLAYERS) {
    room.phase = 'lobby'
    room.phaseEndsAt = 0
    touch(room)
    return
  }
  beginRound(room, now)
}

export function restart(room: ServerRoom) {
  room.phase = 'lobby'
  room.round = 0
  room.winnerId = null
  room.roundWinnerId = null
  room.prompt = null
  room.judgeSeat = -1
  room.submissionOrder = []
  room.votes = {}
  room.tableCards = []
  room.phaseEndsAt = 0
  for (const p of room.players.values()) {
    p.score = 0
    p.played = null
    p.hand = []
  }
  touch(room)
}

// ---------------------------------------------------------------------------
// Tick — deadlines, bots, disconnect reaping
// ---------------------------------------------------------------------------

export function tick(room: ServerRoom, now: number): boolean {
  const before = room.rev

  // Reap players who never came back.
  for (const p of [...room.players.values()]) {
    if (
      !p.connected &&
      !p.isBot &&
      p.disconnectedAt !== null &&
      now - p.disconnectedAt > DISCONNECT_GRACE_MS
    ) {
      removePlayer(room, p.id)
    }
  }

  switch (room.phase) {
    case 'dealing': {
      if (now >= room.phaseEndsAt) beginRound(room, now)
      break
    }

    case 'playing': {
      // Bots commit on their own schedule.
      for (const p of room.players.values()) {
        if (!p.isBot || p.played || p.id === judgeId(room)) continue
        if (now >= p.botActAt) {
          const need = room.prompt?.pick ?? 1
          const ids = shuffle([...p.hand]).slice(0, need).map((c) => c.id)
          if (ids.length === need) playCards(room, p.id, ids, now)
        }
      }
      // Deadline: auto-play for anyone still holding out.
      if (room.phase === 'playing' && now >= room.phaseEndsAt) {
        for (const p of expectedPlayers(room)) {
          if (p.played) continue
          const need = room.prompt?.pick ?? 1
          const ids = shuffle([...p.hand]).slice(0, need).map((c) => c.id)
          if (ids.length === need) playCards(room, p.id, ids, now)
        }
        if (room.phase === 'playing') enterRevealing(room, now)
      }
      break
    }

    case 'revealing': {
      if (now >= room.phaseEndsAt) {
        if (room.revealedCount < room.submissionOrder.length) {
          emit(room, { kind: 'reveal', index: room.revealedCount })
          room.revealedCount++
          room.phaseEndsAt = now + REVEAL_STEP_MS
          touch(room)
        } else {
          enterJudging(room, now)
        }
      }
      break
    }

    case 'judging': {
      const jid = judgeId(room)
      const judge = jid ? room.players.get(jid) : null

      // A bot judge decides quickly; a human judge gets the full clock.
      if (judge?.isBot && now >= room.phaseEndsAt - JUDGE_MS + 2500) {
        const pick = room.submissionOrder[
          Math.floor(Math.random() * room.submissionOrder.length)
        ]
        if (pick) castVote(room, judge.id, pick, now)
      } else if (now >= room.phaseEndsAt) {
        // Judge went silent: fall back to the advisory tally, then to random.
        const tally = new Map<string, number>()
        for (const target of Object.values(room.votes)) {
          tally.set(target, (tally.get(target) ?? 0) + 1)
        }
        let best: string | null = null
        let bestN = -1
        for (const [id, n] of tally) {
          if (n > bestN) {
            best = id
            bestN = n
          }
        }
        const pick =
          best ??
          room.submissionOrder[Math.floor(Math.random() * room.submissionOrder.length)]
        if (pick) resolveRound(room, pick, now)
        else nextRound(room, now)
      }
      break
    }

    case 'scoring': {
      if (now >= room.phaseEndsAt) nextRound(room, now)
      break
    }
  }

  return room.rev !== before
}

// ---------------------------------------------------------------------------
// Per-viewer serialisation
//
// Hands are never broadcast. A client physically cannot see another player's
// cards because the bytes never leave the server — the only defence that
// actually holds up.
// ---------------------------------------------------------------------------

export function snapshotFor(room: ServerRoom, viewerId: string): RoomSnapshot {
  const viewer = room.players.get(viewerId)
  const jid = judgeId(room)
  const hideAuthors = room.phase === 'playing' || room.phase === 'revealing'

  const players: PlayerPublic[] = activePlayers(room).map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    score: p.score,
    connected: p.connected,
    isHost: p.isHost,
    isBot: p.isBot,
    handCount: p.hand.length,
    hasPlayed: p.played !== null,
    avatarHue: p.avatarHue,
  }))

  const submissions: Submission[] = room.submissionOrder.map((pid, i) => {
    const p = room.players.get(pid)
    const revealed = room.phase === 'judging' || i < room.revealedCount
    const own = pid === viewerId
    return {
      playerId: hideAuthors && !own && !revealed ? `hidden:${i}` : pid,
      cards: revealed || own ? (p?.played ?? []) : (p?.played ?? []).map((c) => ({
        id: c.id,
        text: '',
      })),
      revealed,
    }
  })

  return {
    code: room.code,
    name: room.name,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    judgeId: jid,
    players,
    prompt: room.prompt,
    submissions,
    votes: room.phase === 'judging' || room.phase === 'scoring' ? room.votes : {},
    winnerId: room.winnerId,
    roundWinnerId: room.roundWinnerId,
    tableCards: room.tableCards,
    phaseEndsAt: room.phaseEndsAt || null,
    rev: room.rev,
    you: {
      id: viewerId,
      seat: viewer?.seat ?? -1,
      hand: viewer?.hand ?? [],
      isHost: viewer?.isHost ?? false,
      isJudge: viewerId === jid,
    },
  }
}

export function drainEvents(room: ServerRoom): RoomEvent[] {
  if (!room.pendingEvents.length) return []
  const out = room.pendingEvents
  room.pendingEvents = []
  return out
}
