/**
 * Peril entry point.
 *
 * Flow: identity → home screen → connect → 3D table.
 * The scene is created once and driven by authoritative snapshots; the overlay
 * is chrome over the top of it.
 */

import { GameScene } from './game/scene'
import { initAvatars } from './game/avatar'
import { NetClient } from './net/client'
import { Overlay } from './ui/overlay'
import {
  avatarHue,
  playerId,
  playerName,
  rememberRoom,
  recentRooms,
  roomCodeFromUrl,
  setPlayerName,
  setUrlRoom,
} from './lib/session'
import type { RoomEvent } from '../shared/protocol'

const app = document.getElementById('app')!

// Dismiss the boot splash now that the module has evaluated.
const boot = document.getElementById('boot')
if (boot) {
  boot.style.opacity = '0'
  setTimeout(() => boot.remove(), 420)
}

const net = new NetClient()
const overlay = new Overlay(app, {
  name: playerName(),
  code: roomCodeFromUrl() || recentRooms()[0]?.code || '',
})

let scene: GameScene | null = null
let joined = false

// The avatar model (if present) loads in parallel with the home screen, so the
// first frame after joining is never blocked on a network fetch.
const avatarsReady = initAvatars()

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

overlay.onHomeSubmit = async ({ name, code, create }) => {
  setPlayerName(name)
  await avatarsReady

  if (!scene) {
    scene = new GameScene(app, net)
    scene.onPlay = (cardIds) => net.sendControl({ type: 'play_cards', cardIds })
    scene.onVote = (submissionPlayerId) =>
      net.sendControl({ type: 'vote', submissionPlayerId })
    scene.start()
    // Keep the overlay above the canvas.
    app.appendChild(overlay.root)
  }

  net.connect({
    playerId: playerId(),
    name,
    roomCode: code,
    create,
    roomName: `${name}'s table`,
    avatarHue: avatarHue(),
  })
}

// ---------------------------------------------------------------------------
// Net wiring
// ---------------------------------------------------------------------------

net.onSnapshot = (state) => {
  if (!joined) {
    joined = true
    overlay.setConnecting(false)
    overlay.clearError()
    setUrlRoom(state.code)
    rememberRoom(state.code, state.name)
  }
  scene?.applySnapshot(state)
  overlay.render(state, net.serverNow())
}

net.onEvent = (event: RoomEvent) => {
  switch (event.kind) {
    case 'player_joined':
      overlay.toast(`${event.name} sat down`)
      break
    case 'player_left':
      overlay.toast(`${event.name} left`)
      break
    case 'round_start':
      overlay.toast(`Round ${event.round}`)
      break
    case 'round_won': {
      const name = net.snapshot?.players.find((p) => p.seat === event.seat)?.name ?? 'Someone'
      overlay.toast(`${name} wins the round`, 'win')
      break
    }
    case 'game_won': {
      const name = net.snapshot?.players.find((p) => p.seat === event.seat)?.name ?? 'Someone'
      overlay.toast(`${name} wins the game!`, 'win', 4200)
      break
    }
  }
}

net.onError = (message, fatal) => {
  overlay.showError(message)
  if (fatal) {
    joined = false
    overlay.setView('home')
  }
}

net.onStatus = () => {
  overlay.setNet(net.status, Math.round(net.rtt), net.diagnostics.starved)
}

// ---------------------------------------------------------------------------
// Overlay actions
// ---------------------------------------------------------------------------

overlay.onStart = () => net.sendControl({ type: 'start' })
overlay.onAddBot = () => net.sendControl({ type: 'add_bot' })
overlay.onNextRound = () => net.sendControl({ type: 'next_round' })
overlay.onRestart = () => net.sendControl({ type: 'restart' })
overlay.onLeave = () => {
  net.sendControl({ type: 'leave' })
  net.disconnect()
  joined = false
  overlay.setView('home')
}

// Refresh the countdown and the latency readout without re-rendering on every
// animation frame — the HUD does not need 60 Hz.
setInterval(() => {
  const s = net.snapshot
  if (s && joined) overlay.render(s, net.serverNow())
  overlay.setNet(net.status, Math.round(net.rtt), net.diagnostics.starved)

  // Report progress while the first connection is still being attempted, so a
  // slow or unreachable server reads as "trying" rather than "broken button".
  if (!joined && net.status === 'reconnecting' && net.attempts >= 2) {
    overlay.showConnectingHint(
      `Still trying to reach the server… (attempt ${net.attempts})`,
    )
  }
}, 250)

// Expose a handle for debugging in the console.
;(window as unknown as Record<string, unknown>).peril = { net, get scene() { return scene } }
