/**
 * Peril entry point.
 *
 * Flow: identity → home → connect → lobby → open table → physics sandbox.
 * Card interaction is the restored rigid-body sandbox (X/Z/C/S); the network
 * layer keeps rooms, presence-ready seats, and the shared notepad.
 */

import { createSandbox, type SandboxApi } from './game/sandbox'
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

let sandbox: SandboxApi | null = null
let joined = false

function ensureSandbox() {
  if (sandbox) return
  sandbox = createSandbox(app)
  sandbox.onHandHidden = (hidden) => overlay.setFanHidden(hidden)
  // Keep overlay above the canvas.
  app.appendChild(overlay.root)
  overlay.setFanHidden(sandbox.handHidden())
}

function tearSandbox() {
  sandbox?.dispose()
  sandbox = null
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

overlay.onHomeSubmit = async ({ name, code, create }) => {
  setPlayerName(name)

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

  if (state.phase === 'open') ensureSandbox()
  else tearSandbox()

  overlay.render(state)
}

net.onEvent = (event: RoomEvent) => {
  switch (event.kind) {
    case 'player_joined':
      overlay.toast(`${event.name} sat down`)
      break
    case 'player_left':
      overlay.toast(`${event.name} left`)
      break
    case 'table_open':
      overlay.toast('Table open — free play')
      break
  }
}

net.onError = (message, fatal) => {
  overlay.showError(message)
  if (fatal) {
    joined = false
    tearSandbox()
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
overlay.onRestart = () => net.sendControl({ type: 'restart' })
overlay.onLeave = () => {
  net.sendControl({ type: 'leave' })
  net.disconnect()
  joined = false
  tearSandbox()
  overlay.setView('home')
}
overlay.onToggleFan = () => {
  if (!sandbox) return
  sandbox.setHandHidden(!sandbox.handHidden())
  overlay.setFanHidden(sandbox.handHidden())
}
overlay.onNotepadChange = (text) => net.sendControl({ type: 'set_notepad', text })

setInterval(() => {
  const s = net.snapshot
  if (s && joined) overlay.render(s)
  overlay.setNet(net.status, Math.round(net.rtt), net.diagnostics.starved)

  if (!joined && net.status === 'reconnecting' && net.attempts >= 2) {
    overlay.showConnectingHint(
      `Still trying to reach the server… (attempt ${net.attempts})`,
    )
  }
}, 250)

;(window as unknown as Record<string, unknown>).peril = {
  net,
  get sandbox() {
    return sandbox
  },
}
