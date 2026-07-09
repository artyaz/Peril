import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blankRoom,
  joinRoom,
  applyAction,
  stateFor,
  runBots,
  eligibleVoterIds,
} from '../api/_lib/engine.js'

let sequence = 0

function roomWithPlayers(count = 3) {
  const room = blankRoom({
    code: `T${String(sequence++).padStart(4, '0')}`,
    name: 'Test room',
    hostId: 'p1',
    packIds: ['cah-base-set'],
    maxPlayers: 4,
  })
  for (let index = 1; index <= count; index += 1) {
    joinRoom(room, {
      playerId: `p${index}`,
      name: `Player ${index}`,
      ip: `test-${sequence}-${index}`,
    })
  }
  return room
}

function start(room) {
  applyAction(room, { type: 'start', playerId: room.hostId })
  return room
}

function playCurrentPick(room, playerId) {
  const pick = room.blackCard?.pick || 1
  const cards = room.players[playerId].hand.slice(0, pick)
  const positions = cards.map((_, index) => ({
    x: index * 0.1,
    z: 0.2 + index * 0.03,
    rotY: index * 0.04,
  }))
  applyAction(room, {
    type: 'play_cards',
    playerId,
    cards,
    positions,
  })
}

test('submission identity and positions stay stable through reveal', () => {
  const room = start(roomWithPlayers())
  const submitters = room.roundPlayerIds.filter((id) => id !== room.czarId)

  playCurrentPick(room, submitters[0])
  assert.equal(room.phase, 'playing')
  const hidden = stateFor(room, room.czarId).submissions[0]
  assert.equal(hidden.playerId, 'hidden')
  assert.match(hidden.id, /^r1-s\d+$/)
  assert.deepEqual(hidden.cards, hidden.cards.map(() => '???'))
  assert.equal(hidden.positions.length, room.blackCard.pick)

  playCurrentPick(room, submitters[1])
  assert.equal(room.phase, 'voting')
  const revealed = stateFor(room, room.czarId).submissions.find(
    (submission) => submission.id === hidden.id,
  )
  assert.ok(revealed)
  assert.notEqual(revealed.playerId, 'hidden')
  assert.deepEqual(revealed.positions, hidden.positions)
  assert.equal(new Set(room.submissions.map((submission) => submission.id)).size, 2)
})

test('a disconnected player cannot stall play or voting', () => {
  const room = start(roomWithPlayers())
  const submitters = room.roundPlayerIds.filter((id) => id !== room.czarId)
  applyAction(room, { type: 'leave', playerId: submitters[1] })

  playCurrentPick(room, submitters[0])
  assert.equal(room.phase, 'voting')
  assert.deepEqual(eligibleVoterIds(room), [room.czarId])

  applyAction(room, {
    type: 'vote',
    playerId: room.czarId,
    submissionPlayerId: submitters[0],
  })
  assert.equal(room.phase, 'scoring')
  assert.equal(room.winnerId, submitters[0])
})

test('a late multiplayer guest replaces a bot and stays in the active round', () => {
  const room = start(roomWithPlayers(1))
  const botCount = Object.values(room.players).filter((player) => player.isBot).length
  assert.equal(botCount, 2)

  joinRoom(room, {
    playerId: 'guest',
    name: 'Late guest',
    ip: 'late-guest',
  })

  assert.ok(room.players.guest)
  assert.equal(room.players.guest.isBot, false)
  assert.ok(room.roundPlayerIds.includes('guest'))
  assert.equal(Object.keys(room.players).length, 3)
  assert.equal(
    Object.values(room.players).filter((player) => player.isBot).length,
    1,
  )
  assert.equal(stateFor(room, 'guest').players.find((p) => p.id === 'guest').activeThisRound, true)
})

test('bot actions complete voting without depending on multiple poll ticks', () => {
  const room = start(roomWithPlayers(1))
  playCurrentPick(room, 'p1')
  assert.equal(room.phase, 'voting')

  const target = room.submissions.find((submission) => submission.playerId !== 'p1')
  applyAction(room, {
    type: 'vote',
    playerId: 'p1',
    submissionPlayerId: target.playerId,
  })
  room.phaseStartedAt = Date.now() - 1_000
  runBots(room)

  assert.equal(room.phase, 'scoring')
  assert.ok(room.winnerId)
})

test('wrong-phase actions fail instead of silently desynchronizing the client', () => {
  const room = roomWithPlayers()
  assert.throws(
    () => applyAction(room, {
      type: 'vote',
      playerId: 'p1',
      submissionPlayerId: 'p2',
    }),
    /Voting is not open/,
  )
  assert.throws(
    () => applyAction(room, {
      type: 'play_cards',
      playerId: 'p2',
      cards: [],
    }),
    /play phase/,
  )
})
