/**
 * DOM overlay: home, lobby, lightweight free-play chrome, notepad.
 *
 * Deliberately framework-free. The 3D scene is the product; the UI is a thin
 * chrome over it, and vanilla DOM keeps the bundle small and the frame budget
 * intact — no reconciliation work competing with the render loop.
 */

import { MIN_PLAYERS, NOTEPAD_MAX } from '../../shared/constants'
import type { RoomSnapshot } from '../../shared/protocol'
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
input[type=text], textarea {
  width: 100%; padding: 12px 14px; border-radius: 11px;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--panel-line);
  color: var(--ink); font-size: 15px; outline: none;
  transition: border-color .15s, background .15s;
}
input[type=text]:focus, textarea:focus {
  border-color: var(--accent); background: rgba(255,255,255,0.08);
}
input.code { text-transform: uppercase; letter-spacing: 0.26em; font-weight: 700; }
textarea {
  resize: vertical; min-height: 180px; line-height: 1.45;
  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13.5px;
}

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
.btn.tiny { padding: 7px 11px; font-size: 12.5px; border-radius: 9px; }

.hint { font-size: 12.5px; color: var(--ink-dim); margin-top: 14px; line-height: 1.5; }
.err {
  margin-top: 14px; padding: 10px 13px; border-radius: 10px; font-size: 13.5px;
  line-height: 1.5;
  background: rgba(255,255,255,0.06); border: 1px solid var(--panel-line);
  color: var(--ink-dim);
}
.err.fatal {
  background: rgba(255,107,107,0.13); border-color: rgba(255,107,107,0.3);
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
.room-chip {
  pointer-events: auto;
  padding: 11px 14px; border-radius: 14px;
  background: var(--panel); border: 1px solid var(--panel-line);
  backdrop-filter: blur(11px);
  box-shadow: 0 12px 34px rgba(0,0,0,.42);
  font-size: 13px;
}
.room-chip .code {
  font-weight: 800; letter-spacing: 0.14em; color: var(--accent); font-size: 15px;
}
.room-chip .meta { color: var(--ink-dim); margin-top: 3px; font-size: 12px; }

.roster {
  pointer-events: auto;
  min-width: 160px; padding: 11px 13px; border-radius: 14px;
  background: var(--panel); border: 1px solid var(--panel-line);
  backdrop-filter: blur(11px); font-size: 13px;
}
.roster-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.roster-row .swatch { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.roster-row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.roster-row .pts { font-weight: 750; font-variant-numeric: tabular-nums; color: var(--ink-dim); }
.roster-row.off { opacity: .42; }

.hud-bottom {
  position: absolute; bottom: 0; left: 0; right: 0;
  display: flex; align-items: center; justify-content: center; gap: 11px;
  padding: 18px;
}
.action-bar {
  pointer-events: auto; display: flex; align-items: center; gap: 10px;
  padding: 10px 13px; border-radius: 14px;
  background: var(--panel); border: 1px solid var(--panel-line);
  backdrop-filter: blur(11px);
}
.action-bar .msg { font-size: 12.5px; color: var(--ink-dim); }
.action-bar kbd {
  display: inline-block; min-width: 1.4em; padding: 1px 5px; margin: 0 1px;
  border-radius: 5px; border: 1px solid var(--panel-line);
  background: rgba(255,255,255,0.06); font: 650 11px ui-monospace, Menlo, monospace;
  color: var(--ink); text-align: center;
}

/* ---------- notepad ---------- */
.notepad {
  position: absolute; top: 72px; right: 18px;
  width: min(320px, calc(100vw - 36px));
  pointer-events: auto;
  padding: 14px; border-radius: 16px;
  background: var(--panel); border: 1px solid var(--panel-line);
  backdrop-filter: blur(12px);
  box-shadow: 0 18px 50px rgba(0,0,0,.45);
}
.notepad-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; margin-bottom: 10px;
}
.notepad-head h2 {
  margin: 0; font-size: 13px; font-weight: 750; letter-spacing: .06em;
  text-transform: uppercase; color: var(--accent);
}
.notepad .hint { margin-top: 8px; }

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
  onRestart: (() => void) | null = null
  onLeave: (() => void) | null = null
  onToggleFan: (() => void) | null = null
  onNotepadChange: ((text: string) => void) | null = null

  private homeEl!: HTMLDivElement
  private lobbyEl!: HTMLDivElement
  private hudEl!: HTMLDivElement
  private notepadEl!: HTMLDivElement
  private notepadInput!: HTMLTextAreaElement
  private toastEl!: HTMLDivElement
  private netEl!: HTMLDivElement
  private errEl!: HTMLDivElement
  private joinBtn!: HTMLButtonElement
  private createBtn!: HTMLButtonElement
  private hideFanBtn!: HTMLButtonElement
  private busy = false
  private notepadOpen = false
  private notepadLocal = ''
  private notepadDirty = false
  private fanHidden = false
  private notepadTimer: ReturnType<typeof setTimeout> | null = null

  /** Current view — read by callers deciding whether to route input to the UI. */
  view: 'home' | 'lobby' | 'game' = 'home'

  constructor(container: HTMLElement, opts: { name: string; code: string }) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href =
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Inter:wght@400;600;700;800&display=swap'
    document.head.appendChild(link)

    this.root = document.createElement('div')
    this.root.id = 'ui'
    container.appendChild(this.root)

    this.buildHome(opts)
    this.buildLobby()
    this.buildHud()
    this.buildNotepad()

    this.toastEl = el('div', 'toasts')
    this.root.appendChild(this.toastEl)

    this.netEl = el('div', 'netpill hidden')
    this.netEl.innerHTML = '<span class="led"></span><span class="txt">—</span>'
    this.root.appendChild(this.netEl)

    window.addEventListener('keydown', this.onKey)
  }

  private onKey = (e: KeyboardEvent) => {
    if (this.view !== 'game') return
    if (e.repeat) return
    const t = e.target
    const typing =
      t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)

    if ((e.key === 'p' || e.key === 'P') && !typing) {
      this.setNotepadOpen(!this.notepadOpen)
      e.preventDefault()
      return
    }
    if (e.key === 'Escape' && this.notepadOpen) {
      this.setNotepadOpen(false)
      e.preventDefault()
    }
  }

  // -------------------------------------------------------------------------

  private buildHome(opts: { name: string; code: string }) {
    const scrim = el('div', 'scrim pane')
    const panel = el('div', 'card-panel')

    panel.innerHTML = `
      <div class="brand"><span class="dot"></span><h1>Peril</h1></div>
      <p class="sub">A shared 3D table for free play. Drag, select, group, and
        move cards with friends — no turns, no judge, no scripts.</p>
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
      if (this.busy) return
      const name = nameInput.value.trim() || 'Player'
      const code = codeInput.value.trim().toUpperCase()
      if (!create && !code) {
        this.showError('Enter a room code, or create a new room.')
        codeInput.focus()
        return
      }
      this.clearError()
      this.setConnecting(true)
      this.onHomeSubmit?.({ name, code, create })
    }

    this.joinBtn = panel.querySelector<HTMLButtonElement>('#join')!
    this.createBtn = panel.querySelector<HTMLButtonElement>('#create')!
    this.joinBtn.addEventListener('click', () => submit(false))
    this.createBtn.addEventListener('click', () => submit(true))
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
        <button class="btn primary" id="start">Open table</button>
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
        <div class="room-chip">
          <div class="code" id="hcode">—</div>
          <div class="meta" id="hmeta">Free play</div>
        </div>
        <div class="roster" id="hroster"></div>
      </div>
      <div class="hud-bottom">
        <div class="action-bar">
          <span class="msg">
            Drag · <kbd>Z</kbd> take · <kbd>X</kbd> drop · hold <kbd>C</kbd> select · <kbd>S</kbd> stack
            · <kbd>H</kbd> hide hand · <kbd>P</kbd> notepad
          </span>
          <button class="btn tiny" id="hhide">Hide hand</button>
          <button class="btn tiny" id="hpad">Notepad</button>
          <button class="btn ghost hidden" id="hrestart">Back to lobby</button>
        </div>
      </div>
    `
    this.hideFanBtn = hud.querySelector<HTMLButtonElement>('#hhide')!
    this.hideFanBtn.addEventListener('click', () => {
      this.onToggleFan?.()
    })
    hud.querySelector('#hpad')!.addEventListener('click', () => {
      this.setNotepadOpen(!this.notepadOpen)
    })
    hud.querySelector('#hrestart')!.addEventListener('click', () => this.onRestart?.())
    this.root.appendChild(hud)
    this.hudEl = hud as HTMLDivElement
  }

  private buildNotepad() {
    const pad = el('div', 'notepad hidden')
    pad.innerHTML = `
      <div class="notepad-head">
        <h2>Table notepad</h2>
        <button class="btn tiny" id="padclose">Close</button>
      </div>
      <textarea id="padbody" maxlength="${NOTEPAD_MAX}" spellcheck="false"
        placeholder="Scores, rules you invent, whatever the table needs…"></textarea>
      <div class="hint">Shared with everyone. Edit freely — players maintain it.</div>
    `
    this.notepadInput = pad.querySelector('#padbody')!
    pad.querySelector('#padclose')!.addEventListener('click', () => this.setNotepadOpen(false))
    this.notepadInput.addEventListener('input', () => {
      this.notepadDirty = true
      this.notepadLocal = this.notepadInput.value
      if (this.notepadTimer) clearTimeout(this.notepadTimer)
      this.notepadTimer = setTimeout(() => {
        this.onNotepadChange?.(this.notepadLocal)
        this.notepadDirty = false
      }, 280)
    })
    this.root.appendChild(pad)
    this.notepadEl = pad
  }

  private syncFanButton() {
    this.hideFanBtn.textContent = this.fanHidden ? 'Show hand' : 'Hide hand'
  }

  setNotepadOpen(open: boolean) {
    this.notepadOpen = open
    this.notepadEl.classList.toggle('hidden', !open)
    if (open) {
      // Defer focus so the same keydown that opened it does not type into it.
      setTimeout(() => this.notepadInput.focus(), 0)
    } else {
      this.notepadInput.blur()
    }
  }

  setFanHidden(hidden: boolean) {
    this.fanHidden = hidden
    this.syncFanButton()
  }

  // -------------------------------------------------------------------------

  setView(view: 'home' | 'lobby' | 'game') {
    this.view = view
    this.homeEl.classList.toggle('hidden', view !== 'home')
    this.lobbyEl.classList.toggle('hidden', view !== 'lobby')
    this.hudEl.classList.toggle('hidden', view !== 'game')
    this.netEl.classList.toggle('hidden', view === 'home')
    if (view !== 'game') this.setNotepadOpen(false)
  }

  setConnecting(on: boolean) {
    this.busy = on
    this.joinBtn.disabled = on
    this.createBtn.disabled = on
    this.joinBtn.textContent = on ? 'Connecting…' : 'Join room'
    this.createBtn.textContent = on ? '…' : 'Create new'
  }

  showConnectingHint(message: string) {
    this.errEl.textContent = message
    this.errEl.classList.remove('hidden', 'fatal')
  }

  showError(message: string) {
    this.errEl.textContent = message
    this.errEl.classList.remove('hidden')
    this.errEl.classList.add('fatal')
    this.setConnecting(false)
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

  render(state: RoomSnapshot) {
    const inLobby = state.phase === 'lobby'
    this.setView(inLobby ? 'lobby' : 'game')
    if (inLobby) this.renderLobby(state)
    else this.renderHud(state)
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
      ? 'Waiting for the host to open the table…'
      : 'Open the table whenever you are ready — free play, no turns.'
  }

  private renderHud(s: RoomSnapshot) {
    const hud = this.hudEl
    hud.querySelector('#hcode')!.textContent = s.code
    hud.querySelector('#hmeta')!.textContent =
      `${s.players.length} at the table · free play`

    const roster = hud.querySelector('#hroster')!
    roster.innerHTML = ''
    for (const p of s.players) {
      const row = el('div', `roster-row ${p.connected ? '' : 'off'}`)
      row.innerHTML = `
        <span class="swatch" style="background: hsl(${p.avatarHue} 55% 58%)"></span>
        <span class="nm"></span>
        <span class="pts">${p.handCount}</span>
      `
      row.querySelector('.nm')!.textContent =
        p.name + (p.id === s.you.id ? ' (you)' : '')
      roster.appendChild(row)
    }

    const restartBtn = hud.querySelector<HTMLElement>('#hrestart')!
    restartBtn.classList.toggle('hidden', !s.you.isHost)

    // Push remote notepad edits in, but do not clobber an in-progress edit.
    if (!this.notepadDirty && s.notepad !== this.notepadLocal) {
      this.notepadLocal = s.notepad
      this.notepadInput.value = s.notepad
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
