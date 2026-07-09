import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKS_DIR = path.join(__dirname, '../public/data/packs')

const HAND_SIZE = 7
const rooms = new Map()

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

function loadPackCards(ids) {
  const white = []
  const black = []
  const seenW = new Set()
  const seenB = new Set()
  for (const id of ids) {
    const file = path.join(PACKS_DIR, `${id}.json`)
    if (!fs.existsSync(file)) continue
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
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

class Room {
  constructor({ code, name, hostId, packIds, maxPlayers }) {
    this.code = code
    this.name = name
    this.hostId = hostId
    this.packIds = packIds
    this.maxPlayers = maxPlayers
    this.phase = 'lobby'
    this.players = new Map() // id -> player
    this.sockets = new Map() // id -> ws
    this.ipBindings = new Map() // ip -> playerId
    this.whiteDeck = []
    this.blackDeck = []
    this.discardWhite = []
    this.blackCard = null
    this.czarId = null
    this.submissions = [] // { playerId, cards, revealed }
    this.votes = {} // voterId -> submissionPlayerId
    this.winnerId = null
    this.round = 0
    this.hover = {} // playerId -> cardIndex|null
    this.hoverText = {} // playerId -> peeked card text|null
    this.drag = null
    this.tablePositions = []
  }

  publicMeta() {
    return {
      code: this.code,
      name: this.name,
      phase: this.phase,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        score: p.score,
        connected: p.connected,
        isHost: p.id === this.hostId,
        faceDataUrl: p.faceDataUrl,
      })),
      packIds: this.packIds,
      maxPlayers: this.maxPlayers,
      round: this.round,
    }
  }

  stateFor(viewerId) {
    const you = this.players.get(viewerId)
    return {
      code: this.code,
      name: this.name,
      hostId: this.hostId,
      phase: this.phase,
      players: [...this.players.values()]
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          id: p.id,
          name: p.name,
          seat: p.seat,
          score: p.score,
          connected: p.connected,
          faceDataUrl: p.faceDataUrl,
          isHost: p.id === this.hostId,
          handCount: p.hand.length,
        })),
      packIds: this.packIds,
      maxPlayers: this.maxPlayers,
      handSize: HAND_SIZE,
      blackCard: this.blackCard,
      czarId: this.czarId,
      submissions: this.submissions.map((s) => ({
        playerId: this.phase === 'playing' && s.playerId !== viewerId ? 'hidden' : s.playerId,
        cards: this.phase === 'playing' || (this.phase === 'revealing' && !s.revealed)
          ? s.cards.map(() => '???')
          : s.cards,
        revealed: s.revealed,
        realPlayerId: s.playerId,
      })).map(({ realPlayerId, ...rest }) => {
        // Always include real id for voting after reveal; hide during play except own
        if (this.phase === 'playing' && realPlayerId !== viewerId) {
          return { ...rest, playerId: 'hidden' }
        }
        return { ...rest, playerId: realPlayerId }
      }),
      votes: this.votes,
      winnerId: this.winnerId,
      round: this.round,
      hover: this.hover || {},
      hoverText: this.hoverText || {},
      drag: this.drag || null,
      tablePositions: this.tablePositions || [],
      you: you
        ? { hand: you.hand, selected: you.selected }
        : undefined,
    }
  }

  broadcast() {
    for (const [id, ws] of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'state', state: this.stateFor(id) }))
      }
    }
  }

  send(id, msg) {
    const ws = this.sockets.get(id)
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  nextSeat() {
    const used = new Set([...this.players.values()].map((p) => p.seat))
    for (let i = 0; i < this.maxPlayers; i++) if (!used.has(i)) return i
    return -1
  }

  join({ playerId, name, faceDataUrl, ip, create }) {
    let player = this.players.get(playerId)
    if (player) {
      player.connected = true
      player.name = name.slice(0, 24) || player.name
      if (faceDataUrl) player.faceDataUrl = faceDataUrl
      this.ipBindings.set(ip, playerId)
      return player
    }

    // IP rejoin: if same IP had a disconnected seat, reclaim it
    const bound = this.ipBindings.get(ip)
    if (bound && this.players.has(bound)) {
      const existing = this.players.get(bound)
      if (!existing.connected) {
        // Transfer identity if client brings a new id but same IP
        this.players.delete(bound)
        existing.id = playerId
        existing.name = name.slice(0, 24) || existing.name
        existing.connected = true
        if (faceDataUrl) existing.faceDataUrl = faceDataUrl
        if (this.hostId === bound) this.hostId = playerId
        this.players.set(playerId, existing)
        this.ipBindings.set(ip, playerId)
        // fix submissions / votes / czar
        if (this.czarId === bound) this.czarId = playerId
        for (const s of this.submissions) if (s.playerId === bound) s.playerId = playerId
        const votes = {}
        for (const [k, v] of Object.entries(this.votes)) {
          votes[k === bound ? playerId : k] = v === bound ? playerId : v
        }
        this.votes = votes
        return existing
      }
    }

    if (this.players.size >= this.maxPlayers) throw new Error('Room is full')
    if (this.phase !== 'lobby' && !create) throw new Error('Game already started')

    const seat = this.nextSeat()
    if (seat < 0) throw new Error('No seats')

    player = {
      id: playerId,
      name: name.slice(0, 24) || 'Player',
      seat,
      score: 0,
      connected: true,
      faceDataUrl: faceDataUrl || undefined,
      hand: [],
      selected: [],
      ip,
    }
    this.players.set(playerId, player)
    this.ipBindings.set(ip, playerId)
    if (!this.hostId) this.hostId = playerId
    return player
  }

  setPacks(packIds) {
    if (this.phase !== 'lobby') return
    this.packIds = packIds.slice(0, 40)
  }

  start() {
    if (this.phase !== 'lobby') return
    // Need 3 seats so voting has a non-self option (czar + 2 players)
    while (this.players.size < 3) {
      this.addBot()
    }
    if (this.players.size < 2) throw new Error('Need at least 2 players')
    const decks = loadPackCards(this.packIds)
    if (decks.white.length < this.players.size * HAND_SIZE + 10) {
      throw new Error('Not enough white cards in selected packs')
    }
    if (decks.black.length < 5) throw new Error('Not enough black cards')
    this.whiteDeck = shuffle([...decks.white])
    this.blackDeck = shuffle([...decks.black])
    this.discardWhite = []
    for (const p of this.players.values()) {
      p.hand = []
      p.selected = []
      p.score = 0
    }
    this.round = 0
    this.dealHands()
    this.beginRound()
  }

  addBot() {
    if (this.players.size >= this.maxPlayers) return null
    const seat = this.nextSeat()
    if (seat < 0) return null
    const id = `bot-${Math.random().toString(36).slice(2, 8)}`
    const names = ['Gray', 'Beige', 'Ash', 'Fog', 'Pebble', 'Mist']
    const player = {
      id,
      name: names[this.players.size % names.length],
      seat,
      score: 0,
      connected: true,
      faceDataUrl: undefined,
      hand: [],
      selected: [],
      ip: 'bot',
      isBot: true,
    }
    this.players.set(id, player)
    return player
  }

  runBots() {
    if (this.phase === 'playing') {
      const pick = this.blackCard?.pick || 1
      for (const p of this.players.values()) {
        if (!p.isBot) continue
        if (p.id === this.czarId) continue
        if (this.submissions.some((s) => s.playerId === p.id)) continue
        if (p.hand.length < pick) continue
        const cards = p.hand.slice(0, pick)
        const seat = p.seat || 0
        const positions = Array.from({ length: pick }, (_, i) => ({
          x: Math.sin(seat * 1.7 + i) * 0.45 + (i - (pick - 1) / 2) * 0.16,
          z: 0.22 + Math.cos(seat * 1.3) * 0.2 + i * 0.04,
          rotY: (Math.sin(seat * 3 + i) * 0.5) * 0.35,
        }))
        // Broadcast a hardcoded drag path so peers see the card leave the hand
        const from = positions[0]
        this.drag = {
          playerId: p.id,
          cardText: cards[0],
          source: 'hand',
          x: from.x * 0.2,
          z: from.z - 0.5,
          y: 1.9,
        }
        this.broadcast()
        const room = this
        setTimeout(() => {
          room.drag = {
            playerId: p.id,
            cardText: cards[0],
            source: 'hand',
            x: from.x,
            z: from.z,
            y: 1.7,
          }
          room.broadcast()
        }, 280)
        setTimeout(() => {
          try { room.playCards(p.id, cards, positions) } catch { /* ignore */ }
          setTimeout(() => room.runBots(), 450)
        }, 700)
        return
      }
    }
    if (this.phase === 'voting') {
      for (const p of this.players.values()) {
        if (!p.isBot) continue
        if (this.votes[p.id]) continue
        const options = this.submissions.map((s) => s.playerId).filter((id) => id !== p.id)
        if (!options.length) continue
        const choice = options[Math.floor(Math.random() * options.length)]
        try { this.vote(p.id, choice) } catch { /* ignore */ }
      }
    }
  }

  drawWhite() {
    if (!this.whiteDeck.length) {
      this.whiteDeck = shuffle(this.discardWhite)
      this.discardWhite = []
    }
    return this.whiteDeck.pop()
  }

  dealHands() {
    for (const p of this.players.values()) {
      while (p.hand.length < HAND_SIZE) {
        const c = this.drawWhite()
        if (!c) break
        p.hand.push(c)
      }
    }
  }

  beginRound() {
    this.round += 1
    this.phase = 'playing'
    this.submissions = []
    this.votes = {}
    this.winnerId = null
    this.hover = {}
    this.hoverText = {}
    this.drag = null
    this.tablePositions = []
    for (const p of this.players.values()) p.selected = []

    const players = [...this.players.values()].sort((a, b) => a.seat - b.seat)
    // Round 1: prefer a bot czar so the human can test putting cards down
    if (this.round === 1) {
      const bot = players.find((p) => p.isBot)
      this.czarId = (bot || players[0]).id
    } else {
      this.czarId = players[(this.round - 1) % players.length].id
    }
    this.blackCard = this.blackDeck.length
      ? this.blackDeck.pop()
      : { text: '_ is the reason we can\'t have nice things.', pick: 1 }

    this.dealHands()
    this.broadcast()
  }

  playCards(playerId, cards, positions) {
    if (this.phase !== 'playing') return
    if (playerId === this.czarId) throw new Error('Card Czar waits')
    const player = this.players.get(playerId)
    if (!player) return
    if (this.submissions.some((s) => s.playerId === playerId)) throw new Error('Already played')
    const pick = this.blackCard?.pick || 1
    if (!Array.isArray(cards) || cards.length !== pick) throw new Error(`Play exactly ${pick} card(s)`)
    for (const c of cards) {
      if (!player.hand.includes(c)) throw new Error('Card not in hand')
    }
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
    this.submissions.push({ playerId, cards, revealed: false, positions: pos })
    this.tablePositions = this.tablePositions || []
    for (let i = 0; i < cards.length; i++) {
      this.tablePositions.push({
        key: `${playerId}:${i}:${cards[i]}`,
        x: pos[i].x,
        z: pos[i].z,
        rotY: pos[i].rotY,
      })
    }
    this.drag = null

    const needed = [...this.players.keys()].filter((id) => id !== this.czarId).length
    if (this.submissions.length >= needed) {
      this.phase = 'revealing'
      shuffle(this.submissions)
      for (const s of this.submissions) s.revealed = true
      this.phase = 'voting'
    }
    this.broadcast()
  }

  vote(voterId, submissionPlayerId) {
    if (this.phase !== 'voting') return
    if (!this.players.has(voterId)) return
    if (!this.submissions.some((s) => s.playerId === submissionPlayerId)) {
      throw new Error('Invalid submission')
    }
    if (voterId === submissionPlayerId) throw new Error('Cannot vote for yourself')
    this.votes[voterId] = submissionPlayerId

    const eligible = [...this.players.keys()].filter((id) => {
      // everyone except the sole submission author must vote when possible
      const onlySelf = this.submissions.length === 1 && this.submissions[0].playerId === id
      return !onlySelf
    })
    const cast = eligible.filter((id) => this.votes[id])
    if (cast.length >= eligible.length) {
      this.resolveVotes()
    } else {
      this.broadcast()
    }
  }

  czarPick(czarId, submissionPlayerId) {
    if (this.phase !== 'voting') return
    if (czarId !== this.czarId) throw new Error('Only the Card Czar')
    this.votes[czarId] = submissionPlayerId
    // Czar pick counts as double weight
    this.votes[`czar:${czarId}`] = submissionPlayerId
    if (Object.keys(this.votes).filter((k) => !k.startsWith('czar:')).length >= this.players.size) {
      this.resolveVotes()
    } else {
      this.broadcast()
    }
  }

  resolveVotes() {
    const tallies = {}
    for (const target of Object.values(this.votes)) {
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
    // tie-break: czar preference
    const czarVote = this.votes[this.czarId] || this.votes[`czar:${this.czarId}`]
    if (czarVote && tallies[czarVote] === bestScore) best = czarVote

    this.winnerId = best
    if (best && this.players.has(best)) {
      this.players.get(best).score += 1
    }
    for (const s of this.submissions) {
      this.discardWhite.push(...s.cards)
    }
    this.phase = 'scoring'
    this.broadcast()
  }

  nextRound() {
    // Allow advancing from scoring (or stuck revealing) so the button always works
    if (this.phase !== 'scoring' && this.phase !== 'revealing') return
    const scores = [...this.players.values()].map((p) => p.score)
    if (Math.max(...scores, 0) >= 5) {
      this.phase = 'ended'
      this.broadcast()
      return
    }
    this.beginRound()
  }
}

function createRoom({ name, hostId, packIds, maxPlayers, code }) {
  let c = (code || randCode()).toUpperCase()
  while (rooms.has(c)) c = randCode()
  const room = new Room({
    code: c,
    name: name || 'Untitled',
    hostId: hostId || '',
    packIds: packIds?.length ? packIds : ['cah-base-set'],
    maxPlayers: maxPlayers || 4,
  })
  rooms.set(c, room)
  return room
}

function getRoom(code) {
  return rooms.get(String(code).toUpperCase()) || null
}

function attachClient(ws, ip) {
  let playerId = null
  let roomCode = null

  ws.send(JSON.stringify({ type: 'ip', ip }))

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }

    try {
      if (msg.type === 'hello') {
        playerId = String(msg.playerId)
        roomCode = String(msg.roomCode || '').toUpperCase()
        let room = getRoom(roomCode)
        if (!room && msg.create) {
          room = createRoom({
            name: msg.roomName || 'Untitled',
            hostId: playerId,
            packIds: msg.packIds || ['cah-base-set'],
            maxPlayers: 4,
            code: roomCode,
          })
        }
        if (!room) throw new Error('Room not found')
        room.join({
          playerId,
          name: msg.name || 'Player',
          faceDataUrl: msg.faceDataUrl,
          ip,
          create: !!msg.create,
        })
        room.sockets.set(playerId, ws)
        ws.send(JSON.stringify({ type: 'joined', playerId, code: room.code }))
        room.broadcast()
        return
      }

      const room = roomCode ? getRoom(roomCode) : null
      if (!room || !playerId) throw new Error('Not in a room')

      switch (msg.type) {
        case 'set_packs':
          if (playerId !== room.hostId) throw new Error('Only host')
          room.setPacks(msg.packIds || [])
          room.broadcast()
          break
        case 'set_face':
          {
            const p = room.players.get(playerId)
            if (p) p.faceDataUrl = String(msg.faceDataUrl || '').slice(0, 400_000)
            room.broadcast()
          }
          break
        case 'start':
          if (playerId !== room.hostId) throw new Error('Only host')
          room.start()
          setTimeout(() => room.runBots(), 600)
          setTimeout(() => room.runBots(), 1400)
          break
        case 'play_cards':
          room.playCards(playerId, msg.cards, msg.positions)
          setTimeout(() => room.runBots(), 500)
          break
        case 'hover_card': {
          room.hover[playerId] = msg.cardIndex
          const player = room.players.get(playerId)
          if (msg.cardIndex == null) room.hoverText[playerId] = null
          else if (typeof msg.cardText === 'string') room.hoverText[playerId] = msg.cardText
          else room.hoverText[playerId] = player?.hand?.[msg.cardIndex] || null
          for (const [id, sock] of room.sockets) {
            if (id === playerId) continue
            if (sock.readyState === WebSocket.OPEN) {
              sock.send(JSON.stringify({
                type: 'peer_hover',
                playerId,
                cardIndex: msg.cardIndex,
                cardText: room.hoverText[playerId] ?? null,
              }))
            }
          }
          break
        }
        case 'drag_card':
          room.drag = msg.drag ? { ...msg.drag, playerId } : null
          room.broadcast()
          for (const [id, sock] of room.sockets) {
            if (id === playerId) continue
            if (sock.readyState === WebSocket.OPEN) {
              sock.send(JSON.stringify({ type: 'peer_drag', drag: room.drag }))
            }
          }
          break
        case 'move_table_card': {
          room.tablePositions = room.tablePositions || []
          const key = String(msg.key || '')
          let hit = room.tablePositions.find((p) => p.key === key)
          if (!hit) {
            hit = { key, x: 0, z: 0.3, rotY: 0 }
            room.tablePositions.push(hit)
          }
          hit.x = Number(msg.x) || 0
          hit.z = Number(msg.z) || 0
          if (msg.rotY != null) hit.rotY = Number(msg.rotY) || 0
          for (const s of room.submissions || []) {
            const idx = s.cards.findIndex((c, i) => `${s.playerId}:${i}:${c}` === key)
            if (idx >= 0) {
              s.positions = s.positions || []
              s.positions[idx] = { x: hit.x, z: hit.z, rotY: hit.rotY }
            }
          }
          room.drag = null
          room.broadcast()
          break
        }
        case 'vote':
          room.vote(playerId, msg.submissionPlayerId)
          setTimeout(() => room.runBots(), 400)
          break
        case 'czar_pick':
          room.czarPick(playerId, msg.submissionPlayerId)
          setTimeout(() => room.runBots(), 400)
          break
        case 'add_bot':
          if (playerId !== room.hostId) throw new Error('Only host')
          room.addBot()
          room.broadcast()
          break
        case 'next_round':
          room.nextRound()
          setTimeout(() => room.runBots(), 800)
          break
        case 'leave':
          disconnect()
          break
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message || 'error' }))
    }
  })

  function disconnect() {
    if (!roomCode || !playerId) return
    const room = getRoom(roomCode)
    if (!room) return
    const p = room.players.get(playerId)
    if (p) p.connected = false
    room.sockets.delete(playerId)
    room.broadcast()
    // cleanup empty lobby rooms
    if ([...room.players.values()].every((x) => !x.connected) && room.phase === 'lobby') {
      rooms.delete(room.code)
    }
  }

  ws.on('close', disconnect)
}

export { rooms, createRoom, getRoom, attachClient }
