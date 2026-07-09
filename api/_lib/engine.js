import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Redis } from '@upstash/redis'

const HAND_SIZE = 7
const ROOM_TTL_SEC = 60 * 60 * 6
const BOT_VOTE_DELAY_MS = 700
const SCORE_SHOW_MS = 5_000
const ROOM_LOCK_MS = 4_000
const ROOM_LOCK_RETRIES = 20
const PRESENCE_HEARTBEAT_MS = 5_000
const PLAYER_TIMEOUT_MS = 20_000

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
    dragSequences: {},
    tablePositions: [],
    roundPlayerIds: [],
    nextSubmissionSeq: 0,
    phaseStartedAt: Date.now(),
    phaseEndsAt: null,
    revision: 0,
    processedActions: [],
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

function currentRoundIds(room) {
  const ids = Array.isArray(room.roundPlayerIds) && room.roundPlayerIds.length
    ? room.roundPlayerIds
    : playerList(room).map((p) => p.id)
  return ids.filter((id) => room.players[id])
}

function activeRoundIds(room) {
  return currentRoundIds(room).filter((id) => {
    const player = room.players[id]
    return player && (player.connected || player.isBot)
  })
}

function requiredSubmitterIds(room) {
  return activeRoundIds(room).filter((id) => id !== room.czarId)
}

function eligibleVoterIds(room) {
  const targets = new Set((room.submissions || []).map((s) => s.playerId))
  return activeRoundIds(room).filter((id) => {
    for (const target of targets) if (target !== id) return true
    return false
  })
}

function stateFor(room, viewerId) {
  const you = room.players[viewerId]
  const roundIds = new Set(currentRoundIds(room))
  const submitters = requiredSubmitterIds(room)
  const voters = eligibleVoterIds(room)
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
      isBot: !!p.isBot,
      activeThisRound: room.phase === 'lobby' || roundIds.has(p.id),
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
        id: s.id || `${room.round}:${s.playerId}`,
        playerId: room.phase === 'playing' && s.playerId !== viewerId ? 'hidden' : s.playerId,
        cards: hide ? s.cards.map(() => '???') : s.cards,
        revealed: !!s.revealed,
        positions: (s.positions || []).map((p) => ({
          x: Number(p?.x) || 0,
          z: Number(p?.z) || 0,
          rotY: Number(p?.rotY) || 0,
        })),
      }
    }),
    votes: room.votes || {},
    winnerId: room.winnerId,
    round: room.round,
    revision: room.revision || 0,
    hover: room.hover || {},
    hoverText: room.hoverText || {},
    drag: room.drag || null,
    tablePositions: room.tablePositions || [],
    you: you ? { hand: you.hand || [], selected: you.selected || [] } : undefined,
    updatedAt: room.updatedAt,
    phaseStartedAt: room.phaseStartedAt,
    phaseEndsAt: room.phaseEndsAt ?? null,
    progress: {
      submitted: submitters.filter((id) =>
        (room.submissions || []).some((s) => s.playerId === id)
      ).length,
      submissionsRequired: submitters.length,
      votesCast: voters.filter((id) => room.votes?.[id]).length,
      votersRequired: voters.length,
    },
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
  room.revision = (room.revision || 0) + 1
  room.updatedAt = Math.max(Date.now(), (room.updatedAt || 0) + 1)
  return room
}

function remapRecord(record, oldId, newId, remapValues = false) {
  const next = {}
  for (const [key, value] of Object.entries(record || {})) {
    next[key === oldId ? newId : key] =
      remapValues && value === oldId ? newId : value
  }
  return next
}

function replaceBot(room, bot, { playerId, name, faceDataUrl, ip }) {
  const oldId = bot.id
  const priorRoundIds = Array.isArray(room.roundPlayerIds)
    ? [...room.roundPlayerIds]
    : playerList(room).map((player) => player.id)
  delete room.players[oldId]
  bot.id = playerId
  bot.name = (name || 'Player').slice(0, 24)
  bot.connected = true
  bot.faceDataUrl = faceDataUrl || undefined
  bot.ip = ip
  bot.isBot = false
  bot.lastSeenAt = Date.now()
  room.players[playerId] = bot

  if (room.czarId === oldId) room.czarId = playerId
  room.roundPlayerIds = priorRoundIds.map((id) => id === oldId ? playerId : id)
  for (const submission of room.submissions || []) {
    if (submission.playerId === oldId) submission.playerId = playerId
  }
  room.votes = remapRecord(room.votes, oldId, playerId, true)
  room.hover = remapRecord(room.hover, oldId, playerId)
  room.hoverText = remapRecord(room.hoverText, oldId, playerId)
  if (room.drag?.playerId === oldId) room.drag.playerId = playerId
  return bot
}

function joinRoom(room, { playerId, name, faceDataUrl, ip }) {
  if (!playerId) throw new Error('Player identity is required')
  let player = room.players[playerId]
  if (player) {
    player.connected = true
    player.name = (name || player.name).slice(0, 24)
    if (faceDataUrl) player.faceDataUrl = faceDataUrl
    player.lastSeenAt = Date.now()
    if (ip) room.ipBindings[ip] = playerId
    return touch(room)
  }

  // A late guest takes a bot's seat, hand, and score so an invite remains useful
  // after the game starts without changing the current round's participant count.
  if (room.phase !== 'lobby') {
    const bots = playerList(room).filter((p) => p.isBot)
    const bot =
      bots.find((p) =>
        p.id !== room.czarId &&
        !(room.submissions || []).some((s) => s.playerId === p.id)
      ) ||
      bots.find((p) => p.id !== room.czarId) ||
      bots[0]
    if (bot) {
      replaceBot(room, bot, { playerId, name, faceDataUrl, ip })
      if (ip) room.ipBindings[ip] = playerId
      return touch(room)
    }
  }

  if (Object.keys(room.players).length >= room.maxPlayers) throw new Error('Room is full')
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
    lastSeenAt: Date.now(),
  }
  if (room.phase === 'lobby') {
    room.roundPlayerIds = []
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
    lastSeenAt: Date.now(),
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
  room.phaseStartedAt = Date.now()
  room.phaseEndsAt = null
  room.submissions = []
  room.votes = {}
  room.winnerId = null
  room.hover = {}
  room.hoverText = {}
  room.drag = null
  room.tablePositions = []
  for (const p of Object.values(room.players)) p.selected = []
  const players = playerList(room).filter((p) => p.connected || p.isBot)
  if (players.length < 2) throw new Error('At least two active players are required')
  room.roundPlayerIds = players.map((p) => p.id)
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
  if (room.phase !== 'lobby') throw new Error('Game has already started')
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

function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function maybeStartVoting(room) {
  if (room.phase !== 'playing') return room
  const needed = requiredSubmitterIds(room)
  if (!needed.length) return room
  const submitted = new Set((room.submissions || []).map((s) => s.playerId))
  if (!needed.every((id) => submitted.has(id))) return room

  shuffle(room.submissions)
  for (const submission of room.submissions) submission.revealed = true
  room.phase = 'voting'
  room.phaseStartedAt = Date.now()
  room.phaseEndsAt = null
  room.votes = {}
  return touch(room)
}

function playCards(room, playerId, cards, positions) {
  if (room.phase !== 'playing') throw new Error('Cards can only be played during the play phase')
  if (playerId === room.czarId) throw new Error('Card Czar waits')
  const player = room.players[playerId]
  if (!player) throw new Error('Player not found')
  if (!currentRoundIds(room).includes(playerId)) throw new Error('You join the game next round')
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
    x: finiteOr(p?.x, (i - (cards.length - 1) / 2) * 0.2),
    z: finiteOr(p?.z, 0.28),
    rotY: finiteOr(p?.rotY, 0),
  }))
  while (pos.length < cards.length) {
    const i = pos.length
    pos.push({
      x: (i - (cards.length - 1) / 2) * 0.2,
      z: 0.28 + Math.random() * 0.08,
      rotY: 0,
    })
  }
  const submission = {
    id: `r${room.round}-s${room.nextSubmissionSeq || 0}`,
    playerId,
    cards,
    revealed: false,
    positions: pos,
  }
  room.nextSubmissionSeq = (room.nextSubmissionSeq || 0) + 1
  room.submissions.push(submission)
  for (let i = 0; i < cards.length; i++) {
    room.tablePositions = room.tablePositions || []
    room.tablePositions.push({
      key: `${submission.id}:${i}`,
      x: pos[i].x,
      z: pos[i].z,
      rotY: pos[i].rotY,
    })
  }
  room.drag = null
  touch(room)
  return maybeStartVoting(room)
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
  room.phaseStartedAt = Date.now()
  room.phaseEndsAt = room.phaseStartedAt + SCORE_SHOW_MS
  return touch(room)
}

function maybeResolveVotes(room) {
  if (room.phase !== 'voting') return room
  const eligible = eligibleVoterIds(room)
  if (eligible.length && eligible.every((id) => room.votes?.[id])) {
    return resolveVotes(room)
  }
  return room
}

function vote(room, voterId, submissionPlayerId) {
  if (room.phase !== 'voting') throw new Error('Voting is not open')
  if (!room.players[voterId]) throw new Error('Player not found')
  if (!eligibleVoterIds(room).includes(voterId)) throw new Error('You cannot vote this round')
  if (!room.submissions.some((s) => s.playerId === submissionPlayerId)) {
    throw new Error('Invalid submission')
  }
  if (voterId === submissionPlayerId) throw new Error('Cannot vote for yourself')
  room.votes[voterId] = submissionPlayerId
  touch(room)
  return maybeResolveVotes(room)
}

function nextRound(room) {
  if (room.phase !== 'scoring') throw new Error('The round is not ready to advance')
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
    // Fill every bot submission in one authoritative pass. Human actions then
    // transition to voting immediately instead of depending on future polls.
    for (const p of playerList(room)) {
      if (!p.isBot || p.id === room.czarId) continue
      if (!currentRoundIds(room).includes(p.id)) continue
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
    }
  }
  if (
    room.phase === 'voting' &&
    Date.now() - (room.phaseStartedAt || 0) >= BOT_VOTE_DELAY_MS
  ) {
    for (const p of playerList(room)) {
      if (!p.isBot || room.votes[p.id]) continue
      if (!eligibleVoterIds(room).includes(p.id)) continue
      const options = room.submissions.map((s) => s.playerId).filter((id) => id !== p.id)
      if (!options.length) continue
      try {
        vote(room, p.id, options[Math.floor(Math.random() * options.length)])
      } catch { /* ignore */ }
      if (room.phase !== 'voting') break
    }
  }
  if (
    room.phase === 'scoring' &&
    room.phaseEndsAt &&
    Date.now() >= room.phaseEndsAt
  ) {
    nextRound(room)
    runBots(room)
  }
  return room
}

function applyAction(room, action) {
  const { type, playerId } = action
  const revision = room.revision || 0
  switch (type) {
    case 'set_packs':
      if (playerId !== room.hostId) throw new Error('Only host')
      if (room.phase !== 'lobby') throw new Error('Packs can only change in the lobby')
      room.packIds = (action.packIds || []).slice(0, 40)
      break
    case 'set_face': {
      const p = room.players[playerId]
      if (p) p.faceDataUrl = String(action.faceDataUrl || '').slice(0, 400_000)
      break
    }
    case 'add_bot':
      if (playerId !== room.hostId) throw new Error('Only host')
      if (room.phase !== 'lobby') throw new Error('Bots can only be added in the lobby')
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
      {
        room.dragSequences = room.dragSequences || {}
        const lastSequence = room.dragSequences[playerId] || 0
        const requestedSequence = Number(action.sequence)
        const sequence = Number.isFinite(requestedSequence)
          ? requestedSequence
          : lastSequence + 1
        if (sequence > lastSequence) {
          room.dragSequences[playerId] = sequence
          room.drag = action.drag
            ? { ...action.drag, playerId }
            : room.drag?.playerId === playerId
              ? null
              : room.drag
        }
      }
      break
    case 'move_table_card': {
      if (room.phase !== 'playing') throw new Error('Played cards are locked')
      room.tablePositions = room.tablePositions || []
      const key = String(action.key || '')
      let hit = room.tablePositions.find((p) => p.key === key)
      if (!hit) throw new Error('Card position not found')
      let owned = false
      for (const s of room.submissions || []) {
        const idx = s.cards.findIndex((_, i) => `${s.id}:${i}` === key)
        if (idx >= 0) {
          if (s.playerId !== playerId) throw new Error('You can only move your own play')
          owned = true
          hit.x = finiteOr(action.x, hit.x)
          hit.z = finiteOr(action.z, hit.z)
          hit.rotY = finiteOr(action.rotY, hit.rotY)
          s.positions = s.positions || []
          s.positions[idx] = { x: hit.x, z: hit.z, rotY: hit.rotY }
        }
      }
      if (!owned) throw new Error('Card position not found')
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
      {
        const now = Date.now()
        let presenceChanged = false
        const current = room.players[playerId]
        if (
          current &&
          (!current.connected ||
            !current.lastSeenAt ||
            now - current.lastSeenAt >= PRESENCE_HEARTBEAT_MS)
        ) {
          current.connected = true
          current.lastSeenAt = now
          presenceChanged = true
        }
        for (const player of Object.values(room.players)) {
          if (
            !player.isBot &&
            player.id !== playerId &&
            player.connected &&
            player.lastSeenAt &&
            now - player.lastSeenAt > PLAYER_TIMEOUT_MS
          ) {
            player.connected = false
            presenceChanged = true
          }
        }
        if (presenceChanged) {
          if (!room.players[room.hostId]?.connected) {
            const nextHost = playerList(room).find(
              (player) => player.connected && !player.isBot,
            )
            if (nextHost) room.hostId = nextHost.id
          }
          touch(room)
          maybeStartVoting(room)
          maybeResolveVotes(room)
        }
      }
      runBots(room)
      return room
    case 'leave': {
      const p = room.players[playerId]
      if (p) {
        p.connected = false
        p.lastSeenAt = Date.now()
        if (room.hostId === playerId) {
          const nextHost = playerList(room).find((candidate) => candidate.connected && !candidate.isBot)
          if (nextHost) room.hostId = nextHost.id
        }
        maybeStartVoting(room)
        maybeResolveVotes(room)
      }
      break
    }
    default:
      throw new Error('Unknown action')
  }
  return (room.revision || 0) === revision ? touch(room) : room
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

function roomKey(code) {
  return `peril:room:${code}`
}

function lockKey(code) {
  return `peril:lock:${code}`
}

export async function saveRoom(room) {
  touch(room)
  g.__perilRooms.set(room.code, room)
  const r = redis()
  if (r) await r.set(roomKey(room.code), room, { ex: ROOM_TTL_SEC })
  return room
}

export async function loadRoom(code) {
  const c = String(code || '').toUpperCase()
  if (!c) return null
  const r = redis()
  if (r) {
    // Redis is authoritative. Never serve the warm-instance cache first or one
    // serverless instance can overwrite votes/actions written by another.
    const data = await r.get(roomKey(c))
    if (data) {
      g.__perilRooms.set(c, data)
      return data
    }
    return null
  }
  return g.__perilRooms.get(c) || null
}

async function releaseLock(r, key, token) {
  await r.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    [key],
    [token],
  )
}

/**
 * Serialize every room mutation when shared storage is enabled. This prevents
 * simultaneous votes, joins, and card plays from replacing each other's state.
 */
export async function mutateRoom(code, updater) {
  const c = String(code || '').toUpperCase()
  if (!c) return null
  const r = redis()
  if (!r) {
    const room = g.__perilRooms.get(c)
    if (!room) return null
    const revision = room.revision || 0
    const value = await updater(room)
    if ((room.revision || 0) !== revision) g.__perilRooms.set(c, room)
    return { room, value }
  }

  const key = lockKey(c)
  const token =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let acquired = false
  for (let attempt = 0; attempt < ROOM_LOCK_RETRIES; attempt += 1) {
    const result = await r.set(key, token, { nx: true, px: ROOM_LOCK_MS })
    if (result) {
      acquired = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 5))
  }
  if (!acquired) throw new Error('Room is busy. Try again.')

  try {
    const room = await r.get(roomKey(c))
    if (!room) return null
    g.__perilRooms.set(c, room)
    const revision = room.revision || 0
    const value = await updater(room)
    if ((room.revision || 0) !== revision) {
      g.__perilRooms.set(c, room)
      await r.set(roomKey(c), room, { ex: ROOM_TTL_SEC })
    }
    return { room, value }
  } finally {
    await releaseLock(r, key, token)
  }
}

export async function createRoom(opts) {
  let code = (opts.code || randCode()).toUpperCase()
  let tries = 0
  const r = redis()
  if (r) {
    while (tries <= 20) {
      const room = blankRoom({ ...opts, code })
      const result = await r.set(roomKey(code), room, {
        nx: true,
        ex: ROOM_TTL_SEC,
      })
      if (result) {
        g.__perilRooms.set(code, room)
        return room
      }
      code = randCode()
      tries += 1
    }
    throw new Error('Could not allocate room code')
  }

  while (g.__perilRooms.has(code)) {
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
  activeRoundIds,
  eligibleVoterIds,
  HAND_SIZE,
}
