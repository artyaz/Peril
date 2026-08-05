/**
 * Peril free-play engine — pure logic, no I/O.
 *
 * The server is authoritative: clients send intents, the engine validates them
 * and produces the next state. There is no judge, no voting, no phase clock —
 * once the table is open, anyone can place, pick up, and move cards at any
 * time. The notepad is a shared scratch pad the players maintain themselves.
 */

import {
  DISCONNECT_GRACE_MS,
  HAND_SIZE,
  MAX_SEATS,
  MIN_PLAYERS,
  NOTEPAD_MAX,
  TABLE_RADIUS,
} from '../shared/constants.js'
import type {
  CardData,
  CardPose,
  PlayerPublic,
  RoomEvent,
  RoomPhase,
  RoomSnapshot,
  TableCard,
} from '../shared/protocol.js'
import { buildDeck } from './deck.js'

// ---------------------------------------------------------------------------
// Server-side state
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
  disconnectedAt: number | null
}

export type ServerRoom = {
  code: string
  name: string
  hostId: string
  phase: RoomPhase
  rev: number
  players: Map<string, ServerPlayer>
  /** seat index → playerId. Length MAX_SEATS. */
  seats: (string | null)[]
  responsePile: string[]
  discard: string[]
  tableCards: TableCard[]
  notepad: string
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
    rev: 0,
    players: new Map(),
    seats: new Array(MAX_SEATS).fill(null),
    responsePile: shuffle([...deck.responses]),
    discard: [],
    tableCards: [],
    notepad: 'Scores\n—————\n',
    cardSeq: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pendingEvents: [],
  }
}

function activePlayers(room: ServerRoom): ServerPlayer[] {
  return [...room.players.values()].sort((a, b) => a.seat - b.seat)
}

function livePlayers(room: ServerRoom): ServerPlayer[] {
  return activePlayers(room).filter((p) => p.connected || p.isBot)
}

function firstFreeSeat(room: ServerRoom): number {
  for (let i = 0; i < MAX_SEATS; i++) if (room.seats[i] === null) return i
  return -1
}

function drawResponse(room: ServerRoom): string {
  if (!room.responsePile.length) {
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

function clampTable(x: number, z: number): { x: number; z: number } {
  const r = Math.hypot(x, z)
  const max = TABLE_RADIUS * 0.94
  if (r <= max || r < 1e-6) return { x, z }
  const s = max / r
  return { x: x * s, z: z * s }
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
    disconnectedAt: null,
  }

  if (player.isHost) room.hostId = player.id
  room.players.set(player.id, player)
  room.seats[seat] = player.id

  // Late joiners get a hand immediately so they can play right away.
  if (room.phase === 'open') refillHand(room, player)

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
    disconnectedAt: null,
  }
  room.players.set(id, bot)
  room.seats[seat] = id
  if (room.phase === 'open') refillHand(room, bot)
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
  room.discard.push(...p.hand.map((c) => c.text))
  // Leave their table cards — the table is shared. Just clear the owner seat
  // association by keeping ownerSeat as-is for history.
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
// Free play
// ---------------------------------------------------------------------------

export function startGame(room: ServerRoom): boolean {
  if (room.phase !== 'lobby') return false
  if (livePlayers(room).length < MIN_PLAYERS) return false

  for (const p of room.players.values()) {
    p.hand = []
    refillHand(room, p)
    emit(room, { kind: 'cards_dealt', seat: p.seat, count: p.hand.length })
  }

  room.tableCards = []
  room.phase = 'open'
  emit(room, { kind: 'table_open' })
  touch(room)
  return true
}

export function placeCards(
  room: ServerRoom,
  playerId: string,
  poses: CardPose[],
): { ok: boolean; error?: string } {
  if (room.phase !== 'open') return { ok: false, error: 'Table is not open yet' }
  const p = room.players.get(playerId)
  if (!p) return { ok: false, error: 'Unknown player' }
  if (!poses.length) return { ok: false, error: 'Nothing to place' }

  const placed: TableCard[] = []
  const used = new Set<string>()

  for (const pose of poses) {
    if (used.has(pose.id)) return { ok: false, error: 'Duplicate card' }
    used.add(pose.id)
    const card = p.hand.find((c) => c.id === pose.id)
    if (!card) return { ok: false, error: 'Card not in hand' }
    const { x, z } = clampTable(pose.x, pose.z)
    placed.push({
      id: card.id,
      ownerSeat: p.seat,
      text: card.text,
      x,
      z,
      rotY: pose.rotY,
      faceUp: true,
    })
  }

  p.hand = p.hand.filter((c) => !used.has(c.id))
  room.tableCards.push(...placed)
  touch(room)
  return { ok: true }
}

export function pickupCards(
  room: ServerRoom,
  playerId: string,
  cardIds: string[],
): { ok: boolean; error?: string } {
  if (room.phase !== 'open') return { ok: false, error: 'Table is not open yet' }
  const p = room.players.get(playerId)
  if (!p) return { ok: false, error: 'Unknown player' }
  if (!cardIds.length) return { ok: false, error: 'Nothing to pick up' }

  const used = new Set<string>()
  const grabbed: CardData[] = []

  for (const id of cardIds) {
    if (used.has(id)) return { ok: false, error: 'Duplicate card' }
    used.add(id)
    const idx = room.tableCards.findIndex((c) => c.id === id)
    if (idx < 0) return { ok: false, error: 'Card not on table' }
    const tc = room.tableCards[idx]
    grabbed.push({ id: tc.id, text: tc.text })
  }

  room.tableCards = room.tableCards.filter((c) => !used.has(c.id))
  p.hand.push(...grabbed)
  touch(room)
  return { ok: true }
}

export function moveCards(
  room: ServerRoom,
  playerId: string,
  poses: CardPose[],
): { ok: boolean; error?: string } {
  if (room.phase !== 'open') return { ok: false, error: 'Table is not open yet' }
  if (!room.players.has(playerId)) return { ok: false, error: 'Unknown player' }
  if (!poses.length) return { ok: false, error: 'Nothing to move' }

  for (const pose of poses) {
    const tc = room.tableCards.find((c) => c.id === pose.id)
    if (!tc) return { ok: false, error: 'Card not on table' }
    const { x, z } = clampTable(pose.x, pose.z)
    tc.x = x
    tc.z = z
    tc.rotY = pose.rotY
  }
  touch(room)
  return { ok: true }
}

export function setNotepad(room: ServerRoom, text: string): boolean {
  room.notepad = (text ?? '').slice(0, NOTEPAD_MAX)
  touch(room)
  return true
}

export function setScore(room: ServerRoom, playerId: string, score: number): boolean {
  const p = room.players.get(playerId)
  if (!p) return false
  p.score = Math.max(0, Math.min(999, Math.round(score)))
  touch(room)
  return true
}

export function restart(room: ServerRoom) {
  room.phase = 'lobby'
  room.tableCards = []
  room.notepad = 'Scores\n—————\n'
  for (const p of room.players.values()) {
    p.score = 0
    room.discard.push(...p.hand.map((c) => c.text))
    p.hand = []
  }
  touch(room)
}

// ---------------------------------------------------------------------------
// Tick — disconnect reaping only (no phase clocks)
// ---------------------------------------------------------------------------

export function tick(room: ServerRoom, now: number): boolean {
  const before = room.rev

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

  return room.rev !== before
}

// ---------------------------------------------------------------------------
// Per-viewer serialisation
// ---------------------------------------------------------------------------

export function snapshotFor(room: ServerRoom, viewerId: string): RoomSnapshot {
  const viewer = room.players.get(viewerId)

  const players: PlayerPublic[] = activePlayers(room).map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    score: p.score,
    connected: p.connected,
    isHost: p.isHost,
    isBot: p.isBot,
    handCount: p.hand.length,
    avatarHue: p.avatarHue,
  }))

  return {
    code: room.code,
    name: room.name,
    phase: room.phase,
    hostId: room.hostId,
    players,
    tableCards: room.tableCards,
    notepad: room.notepad,
    rev: room.rev,
    you: {
      id: viewerId,
      seat: viewer?.seat ?? -1,
      hand: viewer?.hand ?? [],
      isHost: viewer?.isHost ?? false,
    },
  }
}

export function drainEvents(room: ServerRoom): RoomEvent[] {
  if (!room.pendingEvents.length) return []
  const out = room.pendingEvents
  room.pendingEvents = []
  return out
}
