import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Redis } from '@upstash/redis'

const HAND_SIZE = 7
const ROOM_TTL_SEC = 60 * 60 * 6

function randCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function packsDir() {
  const candidates = [
    path.join(process.cwd(), 'public/data/packs'),
    path.join(process.cwd(), 'data/packs'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/data/packs'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'packs'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir
  }
  return candidates[0]
}

function loadPackCards(ids) {
  const dir = packsDir()
  const white = []
  const black = []
  const seenW = new Set()
  const seenB = new Set()
  for (const id of ids) {
    const file = path.join(dir, `${id}.json`)
    let data = null
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } else if (id === 'cah-base-set') {
      const fallback = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cah-base-set.json')
      if (fs.existsSync(fallback)) data = JSON.parse(fs.readFileSync(fallback, 'utf8'))
    }
    if (!data) continue
    for (const w of data.white || []) {
      if (seenW.has(w)) continue
      seenW.add(w)
      white.push(w)
    }
    for (const b of data.black || []) {
      const key = `${b.pick}|${b.text}`
      if (seenB.has(key)) continue
      seenB.add(key)
      black.push(b)
    }
  }
  return { white, black }
}

function blankRoom({ code, name, hostId, packIds, maxPlayers }) {
  return {
    code,
    name: name || 'Untitled',
    hostId: hostId || '',
    packIds: packIds?.length ? packIds : ['cah-base-set'],
    maxPlayers: maxPlayers || 4,
    phase: 'lobby',
    players: {},
    ipBindings: {},
    whiteDeck: [],
    blackDeck: [],
    discardWhite: [],
    blackCard: null,
    czarId: null,
    submissions: [],
    votes: {},
    winnerId: null,
    round: 0,
    hover: {},
    hoverText: {},
    drag: null,
    tablePositions: [],
    updatedAt: Date.now(),
  }
}

function playerList(room) {
  return Object.values(room.players).sort((a, b) => a.seat - b.seat)
}

function nextSeat(room) {
  const used = new Set(playerList(room).map((p) => p.seat))
  for (let i = 0; i < room.maxPlayers; i++) if (!used.has(i)) return i
  return -1
}

function stateFor(room, viewerId) {
  const you = room.players[viewerId]
  return {
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    phase: room.phase,
    players: playerList(room).map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      score: p.score,
      connected: p.connected,
      faceDataUrl: p.faceDataUrl,
      isHost: p.id === room.hostId,
      handCount: (p.hand || []).length,
    })),
    packIds: room.packIds,
    maxPlayers: room.maxPlayers,
    handSize: HAND_SIZE,
    blackCard: room.blackCard,
    czarId: room.czarId,
    submissions: (room.submissions || []).map((s) => {
      const hide =
        (room.phase === 'playing' && s.playerId !== viewerId) ||
        (room.phase === 'revealing' && !s.revealed)
      return {
        playerId: room.phase === 'playing' && s.playerId !== viewerId ? 'hidden' : s.playerId,
        cards: hide ? s.cards.map(() => '???') : s.cards,
        revealed: !!s.revealed,
      }
    }),
    votes: room.votes || {},
    winnerId: room.winnerId,
    round: room.round,
    hover: room.hover || {},
    hoverText: room.hoverText || {},
    drag: room.drag || null,
    tablePositions: room.tablePositions || [],
    you: you ? { hand: you.hand || [], selected: you.selected || [] } : undefined,
    updatedAt: room.updatedAt,
  }
}

function publicMeta(room) {
  return {
    code: room.code,
    name: room.name,
    phase: room.phase,
    players: playerList(room).map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      score: p.score,
      connected: p.connected,
      isHost: p.id === room.hostId,
      faceDataUrl: p.faceDataUrl,
    })),
    packIds: room.packIds,
    maxPlayers: room.maxPlayers,
    round: room.round,
  }
}

function touch(room) {
  room.updatedAt = Date.now()
  return room
}

function joinRoom(room, { playerId, name, faceDataUrl, ip }) {
  let player = room.players[playerId]
  if (player) {
    player.connected = true
    player.name = (name || player.name).slice(0, 24)
    if (faceDataUrl) player.faceDataUrl = faceDataUrl
    if (ip) room.ipBindings[ip] = playerId
    return touch(room)
  }

  const bound = ip ? room.ipBindings[ip] : null
  if (bound && room.players[bound] && !room.players[bound].connected) {
    const existing = room.players[bound]
    delete room.players[bound]
    existing.id = playerId
    existing.name = (name || existing.name).slice(0, 24)
    existing.connected = true
    if (faceDataUrl) existing.faceDataUrl = faceDataUrl
    if (room.hostId === bound) room.hostId = playerId
    if (room.czarId === bound) room.czarId = playerId
    for (const s of room.submissions) if (s.playerId === bound) s.playerId = playerId
    const votes = {}
    for (const [k, v] of Object.entries(room.votes || {})) {
      votes[k === bound ? playerId : k] = v === bound ? playerId : v
    }
    room.votes = votes
    room.players[playerId] = existing
    if (ip) room.ipBindings[ip] = playerId
    return touch(room)
  }

  if (Object.keys(room.players).length >= room.maxPlayers) throw new Error('Room is full')
  if (room.phase !== 'lobby') throw new Error('Game already started')
  const seat = nextSeat(room)
  if (seat < 0) throw new Error('No seats')

  room.players[playerId] = {
    id: playerId,
    name: (name || 'Player').slice(0, 24),
    seat,
    score: 0,
    connected: true,
    faceDataUrl: faceDataUrl || undefined,
    hand: [],
    selected: [],
    ip,
    isBot: false,
  }
  if (ip) room.ipBindings[ip] = playerId
  if (!room.hostId) room.hostId = playerId
  return touch(room)
}

function addBot(room) {
  if (Object.keys(room.players).length >= room.maxPlayers) return room
  const seat = nextSeat(room)
  if (seat < 0) return room
  const id = `bot-${Math.random().toString(36).slice(2, 8)}`
  const names = ['Gray', 'Beige', 'Ash', 'Fog', 'Pebble', 'Mist']
  const n = Object.keys(room.players).length
  room.players[id] = {
    id,
    name: names[n % names.length],
    seat,
    score: 0,
    connected: true,
    hand: [],
    selected: [],
    ip: 'bot',
    isBot: true,
  }
  return touch(room)
}

function drawWhite(room) {
  if (!room.whiteDeck.length) {
    room.whiteDeck = shuffle(room.discardWhite || [])
    room.discardWhite = []
  }
  return room.whiteDeck.pop()
}

function dealHands(room) {
  for (const p of Object.values(room.players)) {
    p.hand = p.hand || []
    while (p.hand.length < HAND_SIZE) {
      const c = drawWhite(room)
      if (!c) break
      p.hand.push(c)
    }
  }
}

function beginRound(room) {
  room.round += 1
  room.phase = 'playing'
  room.submissions = []
  room.votes = {}
  room.winnerId = null
  room.hover = {}
  room.hoverText = {}
  room.drag = null
  room.tablePositions = []
  for (const p of Object.values(room.players)) p.selected = []
  const players = playerList(room)
  // Round 1: prefer a bot czar so the human can test putting cards down
  if (room.round === 1) {
    const bot = players.find((p) => p.isBot)
    room.czarId = (bot || players[0]).id
  } else {
    room.czarId = players[(room.round - 1) % players.length].id
  }
  room.blackCard = room.blackDeck.length
    ? room.blackDeck.pop()
    : { text: "_ is the reason we can't have nice things.", pick: 1 }
  dealHands(room)
  return touch(room)
}

function startGame(room) {
  if (room.phase !== 'lobby') return room
  while (Object.keys(room.players).length < 3) addBot(room)
  const decks = loadPackCards(room.packIds)
  if (decks.white.length < Object.keys(room.players).length * HAND_SIZE + 10) {
    throw new Error('Not enough white cards in selected packs')
  }
  if (decks.black.length < 5) throw new Error('Not enough black cards')
  room.whiteDeck = shuffle([...decks.white])
  room.blackDeck = shuffle([...decks.black])
  room.discardWhite = []
  for (const p of Object.values(room.players)) {
    p.hand = []
    p.selected = []
    p.score = 0
  }
  room.round = 0
  dealHands(room)
  return beginRound(room)
}

function playCards(room, playerId, cards, positions) {
  if (room.phase !== 'playing') return room
  if (playerId === room.czarId) throw new Error('Card Czar waits')
  const player = room.players[playerId]
  if (!player) return room
  if (room.submissions.some((s) => s.playerId === playerId)) throw new Error('Already played')
  const pick = room.blackCard?.pick || 1
  if (!Array.isArray(cards) || cards.length !== pick) throw new Error(`Play exactly ${pick} card(s)`)
  for (const c of cards) if (!player.hand.includes(c)) throw new Error('Card not in hand')
  for (const c of cards) {
    const i = player.hand.indexOf(c)
    if (i >= 0) player.hand.splice(i, 1)
  }
  player.selected = cards
  const pos = (positions || []).slice(0, cards.length).map((p, i) => ({
    x: Number(p?.x) || (i - (cards.length - 1) / 2) * 0.2,
    z: Number(p?.z) || 0.28,
    rotY: Number(p?.rotY) || (Math.random() - 0.5) * 0.25,
  }))
  while (pos.length < cards.length) {
    const i = pos.length
    pos.push({
      x: (i - (cards.length - 1) / 2) * 0.2,
      z: 0.28 + Math.random() * 0.08,
      rotY: (Math.random() - 0.5) * 0.25,
    })
  }
  room.submissions.push({ playerId, cards, revealed: false, positions: pos })
  for (let i = 0; i < cards.length; i++) {
    room.tablePositions = room.tablePositions || []
    room.tablePositions.push({
      key: `${playerId}:${i}:${cards[i]}`,
      x: pos[i].x,
      z: pos[i].z,
      rotY: pos[i].rotY,
    })
  }
  room.drag = null
  const needed = Object.keys(room.players).filter((id) => id !== room.czarId).length
  if (room.submissions.length >= needed) {
    shuffle(room.submissions)
    for (const s of room.submissions) s.revealed = true
    room.phase = 'voting'
  }
  return touch(room)
}

function resolveVotes(room) {
  const tallies = {}
  for (const target of Object.values(room.votes || {})) {
    tallies[target] = (tallies[target] || 0) + 1
  }
  let best = null
  let bestScore = -1
  for (const [pid, score] of Object.entries(tallies)) {
    if (score > bestScore) {
      best = pid
      bestScore = score
    }
  }
  const czarVote = room.votes[room.czarId] || room.votes[`czar:${room.czarId}`]
  if (czarVote && tallies[czarVote] === bestScore) best = czarVote
  room.winnerId = best
  if (best && room.players[best]) room.players[best].score += 1
  for (const s of room.submissions) room.discardWhite.push(...s.cards)
  room.phase = 'scoring'
  return touch(room)
}

function vote(room, voterId, submissionPlayerId) {
  if (room.phase !== 'voting') return room
  if (!room.players[voterId]) return room
  if (!room.submissions.some((s) => s.playerId === submissionPlayerId)) {
    throw new Error('Invalid submission')
  }
  if (voterId === submissionPlayerId) throw new Error('Cannot vote for yourself')
  room.votes[voterId] = submissionPlayerId
  const eligible = Object.keys(room.players).filter((id) => {
    const onlySelf = room.submissions.length === 1 && room.submissions[0].playerId === id
    return !onlySelf
  })
  if (eligible.filter((id) => room.votes[id]).length >= eligible.length) {
    return resolveVotes(room)
  }
  return touch(room)
}

function nextRound(room) {
  // Allow advancing from scoring (or stuck revealing) so the button always works
  if (room.phase !== 'scoring' && room.phase !== 'revealing') return room
  const scores = Object.values(room.players).map((p) => p.score)
  if (Math.max(...scores, 0) >= 5) {
    room.phase = 'ended'
    return touch(room)
  }
  return beginRound(room)
}

function runBots(room) {
  if (room.phase === 'playing') {
    const pick = room.blackCard?.pick || 1
    // Stagger: only play one bot per runBots call so fly-in animations are visible
    for (const p of Object.values(room.players)) {
      if (!p.isBot || p.id === room.czarId) continue
      if (room.submissions.some((s) => s.playerId === p.id)) continue
      if ((p.hand || []).length < pick) continue
      try {
        const seat = p.seat || 0
        const positions = Array.from({ length: pick }, (_, i) => ({
          x: Math.sin(seat * 1.7 + i) * 0.45 + (i - (pick - 1) / 2) * 0.16,
          z: 0.22 + Math.cos(seat * 1.3) * 0.2 + i * 0.04,
          rotY: (Math.sin(seat * 3 + i) * 0.5) * 0.35,
        }))
        playCards(room, p.id, p.hand.slice(0, pick), positions)
      } catch { /* ignore */ }
      break
    }
  }
  if (room.phase === 'voting') {
    // One bot vote per tick so humans see their green confirmation before resolve
    for (const p of Object.values(room.players)) {
      if (!p.isBot || room.votes[p.id]) continue
      const options = room.submissions.map((s) => s.playerId).filter((id) => id !== p.id)
      if (!options.length) continue
      try {
        vote(room, p.id, options[Math.floor(Math.random() * options.length)])
      } catch { /* ignore */ }
      break
    }
  }
  return room
}

function applyAction(room, action) {
  const { type, playerId } = action
  switch (type) {
    case 'set_packs':
      if (playerId !== room.hostId) throw new Error('Only host')
      if (room.phase === 'lobby') room.packIds = (action.packIds || []).slice(0, 40)
      break
    case 'set_face': {
      const p = room.players[playerId]
      if (p) p.faceDataUrl = String(action.faceDataUrl || '').slice(0, 400_000)
      break
    }
    case 'add_bot':
      if (playerId !== room.hostId) throw new Error('Only host')
      addBot(room)
      break
    case 'start':
      if (playerId !== room.hostId) throw new Error('Only host')
      startGame(room)
      runBots(room)
      break
    case 'play_cards':
      playCards(room, playerId, action.cards, action.positions)
      runBots(room)
      break
    case 'hover_card':
      room.hover[playerId] = action.cardIndex
      if (action.cardIndex == null) {
        room.hoverText[playerId] = null
      } else if (typeof action.cardText === 'string') {
        room.hoverText[playerId] = action.cardText
      } else {
        const hand = room.players[playerId]?.hand || []
        room.hoverText[playerId] = hand[action.cardIndex] || null
      }
      break
    case 'drag_card':
      room.drag = action.drag
        ? { ...action.drag, playerId }
        : null
      break
    case 'move_table_card': {
      room.tablePositions = room.tablePositions || []
      const key = String(action.key || '')
      let hit = room.tablePositions.find((p) => p.key === key)
      if (!hit) {
        hit = { key, x: 0, z: 0.3, rotY: 0 }
        room.tablePositions.push(hit)
      }
      hit.x = Number(action.x) || 0
      hit.z = Number(action.z) || 0
      if (action.rotY != null) hit.rotY = Number(action.rotY) || 0
      // Mirror into submission positions when possible
      for (const s of room.submissions || []) {
        const idx = s.cards.findIndex((c, i) => `${s.playerId}:${i}:${c}` === key)
        if (idx >= 0) {
          s.positions = s.positions || []
          s.positions[idx] = { x: hit.x, z: hit.z, rotY: hit.rotY }
        }
      }
      room.drag = null
      break
    }
    case 'vote':
      vote(room, playerId, action.submissionPlayerId)
      // Don't resolve with bots in the same request — voter needs to see green confirm.
      // Bots catch up on subsequent state polls.
      break
    case 'next_round':
      nextRound(room)
      runBots(room)
      break
    case 'tick_bots':
      runBots(room)
      break
    case 'leave': {
      const p = room.players[playerId]
      if (p) p.connected = false
      break
    }
    default:
      throw new Error('Unknown action')
  }
  return touch(room)
}

// ---- persistence ----
const g = globalThis
if (!g.__perilRooms) g.__perilRooms = new Map()

function redis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  if (!url || !token) return null
  return new Redis({ url, token })
}

export function storeMode() {
  return redis() ? 'redis' : 'memory'
}

export async function saveRoom(room) {
  touch(room)
  g.__perilRooms.set(room.code, room)
  const r = redis()
  if (r) await r.set(`peril:room:${room.code}`, room, { ex: ROOM_TTL_SEC })
  return room
}

export async function loadRoom(code) {
  const c = String(code || '').toUpperCase()
  if (!c) return null
  if (g.__perilRooms.has(c)) return g.__perilRooms.get(c)
  const r = redis()
  if (r) {
    const data = await r.get(`peril:room:${c}`)
    if (data) {
      g.__perilRooms.set(c, data)
      return data
    }
  }
  return null
}

export async function createRoom(opts) {
  let code = (opts.code || randCode()).toUpperCase()
  let tries = 0
  while (await loadRoom(code)) {
    code = randCode()
    if (++tries > 20) throw new Error('Could not allocate room code')
  }
  const room = blankRoom({ ...opts, code })
  await saveRoom(room)
  return room
}

export {
  blankRoom,
  stateFor,
  publicMeta,
  joinRoom,
  applyAction,
  runBots,
  HAND_SIZE,
}
