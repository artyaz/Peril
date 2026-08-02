/**
 * DOM overlay: home, lobby, in-game HUD, connection state.
 *
 * Deliberately framework-free. The 3D scene is the product; the UI is a thin
 * chrome over it, and vanilla DOM keeps the bundle small and the frame budget
 * intact — no reconciliation work competing with the render loop.
 */

import { MIN_PLAYERS, TARGET_SCORE } from '../../shared/constants'
import type { RoomPhase, RoomSnapshot } from '../../shared/protocol'
import type { NetStatus } from '../net/client'
import { recentRooms, type RecentRoom } from '../lib/session'

const CSS = `
:root {
  --bg: #08080d;
  --panel: rgba(18, 19, 30, 0.82);
  --panel-line: rgba(255, 255, 255, 0.09);
  --ink: #f2f2f7;
  --ink-dim: rgba(242, 242, 247, 0.58);
  --accent: #ffc46b;
  --accent-ink: #2a1c06;
  --danger: #ff6b6b;
  --ok: #63d68b;
}
* { box-sizing: border-box; }
#ui {
  position: fixed; inset: 0; pointer-events: none;
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
#ui .pane { pointer-events: auto; }
#ui button { font: inherit; cursor: pointer; border: 0; }

/* ---------- modal shell ---------- */
.scrim {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  background: radial-gradient(120% 90% at 50% 0%, rgba(12,12,22,0.72), rgba(6,6,11,0.94));
  backdrop-filter: blur(7px);
  pointer-events: auto;
}
.card-panel {
  width: min(430px, calc(100vw - 40px));
  background: var(--panel);
  border: 1px solid var(--panel-line);
  border-radius: 20px;
  padding: 30px;
  box-shadow: 0 30px 90px rgba(0,0,0,0.6);
}
.brand { display: flex; align-items: baseline; gap: 11px; margin-bottom: 6px; }
.brand h1 {
  margin: 0; font-size: 34px; font-weight: 800; letter-spacing: -0.03em;
}
.brand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
.sub { margin: 0 0 24px; color: var(--ink-dim); font-size: 14px; line-height: 1.5; }

label { display: block; font-size: 12px; font-weight: 600; letter-spacing: 0.05em;
        text-transform: uppercase; color: var(--ink-dim); margin: 0 0 7px; }
input[type=text] {
  width: 100%; padding: 12px 14px; border-radius: 11px;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--panel-line);
  color: var(--ink); font-size: 15px; outline: none;
  transition: border-color .15s, background .15s;
}
input[type=text]:focus { border-color: var(--accent); background: rgba(255,255,255,0.08); }
input.code { text-transform: uppercase; letter-spacing: 0.26em; font-weight: 700; }

.row { display: flex; gap: 10px; }
.row > * { flex: 1; }
.field { margin-bottom: 16px; }

.btn {
  padding: 12px 18px; border-radius: 11px; font-weight: 650; font-size: 14.5px;
  background: rgba(255,255,255,0.08); color: var(--ink);
  border: 1px solid var(--panel-line);
  transition: transform .12s, background .15s, opacity .15s;
}
.btn:hover:not(:disabled) { background: rgba(255,255,255,0.13); }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { opacity: .42; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.btn.primary:hover:not(:disabled) { background: #ffd08a; }
.btn.ghost { background: transparent; }

.hint { font-size: 12.5px; color: var(--ink-dim); margin-top: 14px; line-height: 1.5; }
.err {
  margin-top: 14px; padding: 10px 13px; border-radius: 10px; font-size: 13.5px;
  background: rgba(255,107,107,0.13); border: 1px solid rgba(255,107,107,0.3);
  color: #ffb3b3;
}
.recent { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.chip {
  padding: 6px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
  background: rgba(255,255,255,0.06); border: 1px solid var(--panel-line); color: var(--ink-dim);
}
.chip:hover { color: var(--ink); border-color: var(--accent); }

/* ---------- lobby ---------- */
.code-display {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 16px; border-radius: 13px; margin-bottom: 18px;
  background: rgba(255,196,107,0.09); border: 1px solid rgba(255,196,107,0.26);
}
.code-display .code {
  font-size: 27px; font-weight: 800; letter-spacing: 0.2em; color: var(--accent);
}
.code-display small { display: block; font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--ink-dim); margin-bottom: 2px; }

.seats { display: flex; flex-direction: column; gap: 7px; margin-bottom: 18px; }
.seat-row {
  display: flex; align-items: center; gap: 11px;
  padding: 9px 12px; border-radius: 11px;
  background: rgba(255,255,255,0.04); border: 1px solid transparent;
  font-size: 14px;
}
.seat-row .swatch { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.seat-row .nm { flex: 1; font-weight: 600; }
.seat-row .tag {
  font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
  padding: 3px 7px; border-radius: 5px; background: rgba(255,255,255,0.09); color: var(--ink-dim);
}
.seat-row.off { opacity: .45; }

/* ---------- HUD ---------- */
.hud-top {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 16px 18px; gap: 14px;
}
.prompt-chip {
  pointer-events: auto;
  max-width: 500px; padding: 13px 17px; border-radius: 14px;
  background: var(--panel); border: 1px solid var(--panel-line);
  backdrop-filter: blur(11px);
  box-shadow: 0 12px 34px rgba(0,0,0,.42);
}
.prompt-chip .phase {
  font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  color: var(--accent); margin-bottom: 5px; display: flex; gap: 9px; align-items: center;
}
.prompt-chip .txt { font-size: 15.5px; font-weight: 600; line-height: 1.42; }
.timer {
  font-variant-numeric: tabular-nums; color: var(--ink-dim); font-weight: 700;
}

.scores {
  pointer-events: auto;
  min-width: 178px; padding: 11px 13px; border-radius: 14px;
  background: var(--panel); border: 1px solid var(--panel-line);
  backdrop-filter: blur(11px); font-size: 13px;
}
.score-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.score-row .swatch { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.score-row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.score-row .pts { font-weight: 750; font-variant-numeric: tabular-nums; }
.score-row.judge .nm { color: var(--accent); }
.score-row.off { opacity: .42; }

.hud-bottom {
  position: absolute; bottom: 0; left: 0; right: 0;
  display: flex; align-items: center; justify-content: center; gap: 11px;
  padding: 18px;
}
.action-bar {
  pointer-events: auto; display: flex; align-items: center; gap: 11px;
  padding: 10px 13px; border-radius: 14px;
  background: var(--panel); border: 1px solid var(--panel-line);
  backdrop-filter: blur(11px);
}
.action-bar .msg { font-size: 13.5px; color: var(--ink-dim); }
.action-bar .msg strong { color: var(--ink); font-weight: 650; }

/* ---------- net pill ---------- */
.netpill {
  position: absolute; left: 14px; bottom: 14px;
  display: flex; align-items: center; gap: 7px;
  padding: 6px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
  background: rgba(10,10,18,.72); border: 1px solid var(--panel-line);
  color: var(--ink-dim); font-variant-numeric: tabular-nums;
  backdrop-filter: blur(7px);
}
.netpill .led { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.netpill.warn .led { background: var(--accent); }
.netpill.bad .led { background: var(--danger); }

/* ---------- toasts ---------- */
.toasts {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  display: flex; flex-direction: column; align-items: center; gap: 9px;
}
.toast {
  padding: 10px 17px; border-radius: 999px; font-size: 14px; font-weight: 650;
  background: rgba(10,10,18,.86); border: 1px solid var(--panel-line);
  animation: rise .32s ease-out;
}
.toast.win { background: rgba(255,196,107,.94); color: var(--accent-ink); border-color: transparent; }
@keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.96); } }

.hidden { display: none !important; }
`

const PHASE_LABEL: Record<RoomPhase, string> = {
  lobby: 'Lobby',
  dealing: 'Dealing',
  playing: 'Play a card',
  revealing: 'Revealing',
  judging: 'Judging',
  scoring: 'Round over',
  ended: 'Game over',
}

export type HomeSubmit = {
  name: string
  code: string
  create: boolean
}

export class Overlay {
  readonly root: HTMLDivElement

  onHomeSubmit: ((v: HomeSubmit) => void) | null = null
  onStart: (() => void) | null = null
  onAddBot: (() => void) | null = null
  onNextRound: (() => void) | null = null
  onRestart: (() => void) | null = null
  onLeave: (() => void) | null = null

  private homeEl!: HTMLDivElement
  private lobbyEl!: HTMLDivElement
  private hudEl!: HTMLDivElement
  private toastEl!: HTMLDivElement
  private netEl!: HTMLDivElement
  private errEl!: HTMLDivElement

  /** Current view — read by callers deciding whether to route input to the UI. */
  view: 'home' | 'lobby' | 'game' = 'home'

  constructor(container: HTMLElement, opts: { name: string; code: string }) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href =
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap'
    document.head.appendChild(link)

    this.root = document.createElement('div')
    this.root.id = 'ui'
    container.appendChild(this.root)

    this.buildHome(opts)
    this.buildLobby()
    this.buildHud()

    this.toastEl = el('div', 'toasts')
    this.root.appendChild(this.toastEl)

    this.netEl = el('div', 'netpill hidden')
    this.netEl.innerHTML = '<span class="led"></span><span class="txt">—</span>'
    this.root.appendChild(this.netEl)
  }

  // -------------------------------------------------------------------------

  private buildHome(opts: { name: string; code: string }) {
    const scrim = el('div', 'scrim pane')
    const panel = el('div', 'card-panel')

    panel.innerHTML = `
      <div class="brand"><span class="dot"></span><h1>Peril</h1></div>
      <p class="sub">A card game around a shared 3D table. Everyone sees the same
        room, the same cards, and each other's hands in real time.</p>
      <div class="field">
        <label for="nm">Your name</label>
        <input id="nm" type="text" maxlength="18" placeholder="Alex" autocomplete="nickname" />
      </div>
      <div class="field">
        <label for="cd">Room code</label>
        <input id="cd" class="code" type="text" maxlength="6" placeholder="ABCDE" />
      </div>
      <div class="row">
        <button class="btn primary" id="join">Join room</button>
        <button class="btn" id="create">Create new</button>
      </div>
      <div class="recent" id="recent"></div>
      <div class="hint">Share the room code — or just send the page URL. Up to 8 seats.</div>
    `

    const nameInput = panel.querySelector<HTMLInputElement>('#nm')!
    const codeInput = panel.querySelector<HTMLInputElement>('#cd')!
    nameInput.value = opts.name
    codeInput.value = opts.code

    const submit = (create: boolean) => {
      const name = nameInput.value.trim() || 'Player'
      const code = codeInput.value.trim().toUpperCase()
      if (!create && !code) {
        this.showError('Enter a room code, or create a new room.')
        codeInput.focus()
        return
      }
      this.clearError()
      this.onHomeSubmit?.({ name, code, create })
    }

    panel.querySelector('#join')!.addEventListener('click', () => submit(false))
    panel.querySelector('#create')!.addEventListener('click', () => submit(true))
    codeInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') submit(false)
    })
    nameInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') codeInput.focus()
    })

    const recentWrap = panel.querySelector<HTMLDivElement>('#recent')!
    const rooms: RecentRoom[] = recentRooms()
    for (const r of rooms) {
      const chip = el('button', 'chip')
      chip.textContent = `${r.code} · ${r.name}`
      chip.addEventListener('click', () => {
        codeInput.value = r.code
        submit(false)
      })
      recentWrap.appendChild(chip)
    }

    this.errEl = el('div', 'err hidden')
    panel.appendChild(this.errEl)

    scrim.appendChild(panel)
    this.root.appendChild(scrim)
    this.homeEl = scrim
    setTimeout(() => (opts.name ? codeInput : nameInput).focus(), 60)
  }

  private buildLobby() {
    const scrim = el('div', 'scrim pane hidden')
    const panel = el('div', 'card-panel')
    panel.innerHTML = `
      <div class="brand"><span class="dot"></span><h1>Lobby</h1></div>
      <div class="code-display">
        <div><small>Room code</small><div class="code" id="lcode">—</div></div>
        <button class="btn" id="copy">Copy link</button>
      </div>
      <div class="seats" id="lseats"></div>
      <div class="row">
        <button class="btn" id="bot">Add bot</button>
        <button class="btn primary" id="start">Start game</button>
      </div>
      <div class="hint" id="lhint"></div>
    `
    panel.querySelector('#bot')!.addEventListener('click', () => this.onAddBot?.())
    panel.querySelector('#start')!.addEventListener('click', () => this.onStart?.())
    panel.querySelector('#copy')!.addEventListener('click', (e) => {
      void navigator.clipboard?.writeText(location.href)
      const b = e.currentTarget as HTMLButtonElement
      b.textContent = 'Copied'
      setTimeout(() => (b.textContent = 'Copy link'), 1400)
    })
    scrim.appendChild(panel)
    this.root.appendChild(scrim)
    this.lobbyEl = scrim
  }

  private buildHud() {
    const hud = el('div', 'hidden')
    hud.innerHTML = `
      <div class="hud-top">
        <div class="prompt-chip">
          <div class="phase"><span id="hphase">—</span><span class="timer" id="htimer"></span></div>
          <div class="txt" id="hprompt">—</div>
        </div>
        <div class="scores" id="hscores"></div>
      </div>
      <div class="hud-bottom">
        <div class="action-bar">
          <span class="msg" id="hmsg">—</span>
          <button class="btn ghost hidden" id="hnext">Next round</button>
          <button class="btn ghost hidden" id="hrestart">Play again</button>
        </div>
      </div>
    `
    hud.querySelector('#hnext')!.addEventListener('click', () => this.onNextRound?.())
    hud.querySelector('#hrestart')!.addEventListener('click', () => this.onRestart?.())
    this.root.appendChild(hud)
    this.hudEl = hud as HTMLDivElement
  }

  // -------------------------------------------------------------------------

  setView(view: 'home' | 'lobby' | 'game') {
    this.view = view
    this.homeEl.classList.toggle('hidden', view !== 'home')
    this.lobbyEl.classList.toggle('hidden', view !== 'lobby')
    this.hudEl.classList.toggle('hidden', view !== 'game')
    this.netEl.classList.toggle('hidden', view === 'home')
  }

  showError(message: string) {
    this.errEl.textContent = message
    this.errEl.classList.remove('hidden')
  }

  clearError() {
    this.errEl.classList.add('hidden')
  }

  toast(text: string, kind: 'info' | 'win' = 'info', ms = 2100) {
    const t = el('div', `toast ${kind === 'win' ? 'win' : ''}`)
    t.textContent = text
    this.toastEl.appendChild(t)
    setTimeout(() => t.remove(), ms)
  }

  setNet(status: NetStatus, rtt: number, starved: boolean) {
    const txt = this.netEl.querySelector('.txt')!
    this.netEl.classList.remove('warn', 'bad')
    if (status === 'open') {
      txt.textContent = `${rtt} ms`
      if (starved || rtt > 180) this.netEl.classList.add('warn')
    } else if (status === 'reconnecting' || status === 'connecting') {
      txt.textContent = status === 'connecting' ? 'connecting…' : 'reconnecting…'
      this.netEl.classList.add('warn')
    } else {
      txt.textContent = 'offline'
      this.netEl.classList.add('bad')
    }
  }

  render(state: RoomSnapshot, serverNow: number) {
    const inLobby = state.phase === 'lobby'
    this.setView(inLobby ? 'lobby' : 'game')
    if (inLobby) this.renderLobby(state)
    else this.renderHud(state, serverNow)
  }

  private renderLobby(s: RoomSnapshot) {
    const panel = this.lobbyEl
    panel.querySelector('#lcode')!.textContent = s.code

    const seats = panel.querySelector('#lseats')!
    seats.innerHTML = ''
    for (const p of s.players) {
      const row = el('div', `seat-row ${p.connected ? '' : 'off'}`)
      row.innerHTML = `
        <span class="swatch" style="background: hsl(${p.avatarHue} 55% 58%)"></span>
        <span class="nm"></span>
        ${p.isHost ? '<span class="tag">Host</span>' : ''}
        ${p.isBot ? '<span class="tag">Bot</span>' : ''}
        ${p.id === s.you.id ? '<span class="tag">You</span>' : ''}
      `
      row.querySelector('.nm')!.textContent = p.name
      seats.appendChild(row)
    }

    const startBtn = panel.querySelector<HTMLButtonElement>('#start')!
    const botBtn = panel.querySelector<HTMLButtonElement>('#bot')!
    const enough = s.players.length >= MIN_PLAYERS
    startBtn.disabled = !s.you.isHost || !enough
    botBtn.disabled = !s.you.isHost || s.players.length >= 8

    panel.querySelector('#lhint')!.textContent = !s.you.isHost
      ? 'Waiting for the host to start…'
      : enough
        ? `First to ${TARGET_SCORE} points wins.`
        : `Need ${MIN_PLAYERS - s.players.length} more player(s) — or add a bot.`
  }

  private renderHud(s: RoomSnapshot, serverNow: number) {
    const hud = this.hudEl
    hud.querySelector('#hphase')!.textContent = `${PHASE_LABEL[s.phase]} · Round ${s.round}`
    hud.querySelector('#hprompt')!.textContent = s.prompt?.text ?? '—'

    const timer = hud.querySelector<HTMLElement>('#htimer')!
    if (s.phaseEndsAt && (s.phase === 'playing' || s.phase === 'judging')) {
      const left = Math.max(0, Math.ceil((s.phaseEndsAt - serverNow) / 1000))
      timer.textContent = `${left}s`
    } else {
      timer.textContent = ''
    }

    const scores = hud.querySelector('#hscores')!
    scores.innerHTML = ''
    for (const p of [...s.players].sort((a, b) => b.score - a.score)) {
      const row = el(
        'div',
        `score-row ${p.id === s.judgeId ? 'judge' : ''} ${p.connected ? '' : 'off'}`,
      )
      row.innerHTML = `
        <span class="swatch" style="background: hsl(${p.avatarHue} 55% 58%)"></span>
        <span class="nm"></span>
        <span class="pts">${p.score}</span>
      `
      const nm = row.querySelector('.nm')!
      nm.textContent = p.name + (p.id === s.judgeId ? ' (judge)' : '')
      scores.appendChild(row)
    }

    const msg = hud.querySelector<HTMLElement>('#hmsg')!
    const nextBtn = hud.querySelector<HTMLElement>('#hnext')!
    const restartBtn = hud.querySelector<HTMLElement>('#hrestart')!
    nextBtn.classList.add('hidden')
    restartBtn.classList.add('hidden')

    const me = s.players.find((p) => p.id === s.you.id)
    switch (s.phase) {
      case 'dealing':
        msg.innerHTML = 'Dealing…'
        break
      case 'playing':
        msg.innerHTML = s.you.isJudge
          ? 'You are the <strong>judge</strong> — sit tight.'
          : me?.hasPlayed
            ? 'Played. Waiting for the table…'
            : `Drag a card onto the table${(s.prompt?.pick ?? 1) > 1 ? ' (×2)' : ''}.`
        break
      case 'revealing':
        msg.innerHTML = 'Revealing plays…'
        break
      case 'judging':
        msg.innerHTML = s.you.isJudge
          ? 'Click the winning card.'
          : 'The judge is deciding. Click a favourite to weigh in.'
        break
      case 'scoring': {
        const w = s.players.find((p) => p.id === s.roundWinnerId)
        msg.innerHTML = w ? `<strong>${escapeHtml(w.name)}</strong> takes the round.` : 'Round over.'
        if (s.you.isHost) nextBtn.classList.remove('hidden')
        break
      }
      case 'ended': {
        const w = s.players.find((p) => p.id === s.winnerId)
        msg.innerHTML = w ? `<strong>${escapeHtml(w.name)}</strong> wins the game!` : 'Game over.'
        if (s.you.isHost) restartBtn.classList.remove('hidden')
        break
      }
      default:
        msg.textContent = ''
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}
