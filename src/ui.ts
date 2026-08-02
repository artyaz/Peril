/**
 * ui.ts — the thin DOM layer: action prompts, the selection marquee, and the
 * controls hint. No game state lives here; main drives it.
 */

const FONT =
  '12px/1.4 ui-rounded, "SF Pro Text", -apple-system, "Segoe UI", system-ui, sans-serif'

function el(css: string): HTMLDivElement {
  const d = document.createElement('div')
  d.style.cssText = css
  document.body.appendChild(d)
  return d
}

// --- Action prompt ----------------------------------------------------------

const prompt = el(
  `position:fixed;left:0;top:0;font:${FONT};color:#f2f4ff;` +
    'background:rgba(14,16,26,.82);border:1px solid rgba(150,170,255,.22);' +
    'padding:5px 9px;border-radius:7px;pointer-events:none;white-space:nowrap;' +
    'backdrop-filter:blur(6px);opacity:0;transition:opacity .13s ease;' +
    'transform:translate(14px,14px);z-index:10;display:flex;align-items:center;gap:6px',
)

const keyCapCss =
  'display:inline-block;min-width:15px;text-align:center;font-weight:600;' +
  'background:rgba(150,170,255,.16);border:1px solid rgba(150,170,255,.3);' +
  'border-radius:4px;padding:1px 4px;font-size:11px'

let promptVisible = false

export function showPrompt(key: string, label: string, x: number, y: number): void {
  prompt.innerHTML = `<span style="${keyCapCss}">${key}</span><span>${label}</span>`
  prompt.style.left = `${x}px`
  prompt.style.top = `${y}px`
  if (!promptVisible) {
    prompt.style.opacity = '1'
    promptVisible = true
  }
}

export function movePrompt(x: number, y: number): void {
  prompt.style.left = `${x}px`
  prompt.style.top = `${y}px`
}

export function hidePrompt(): void {
  if (!promptVisible) return
  prompt.style.opacity = '0'
  promptVisible = false
}

// --- Selection marquee ------------------------------------------------------

const marquee = el(
  'position:fixed;border:1px solid rgba(120,200,255,.9);' +
    'background:rgba(120,200,255,.12);border-radius:2px;pointer-events:none;' +
    'display:none;z-index:9',
)

export function showMarquee(x0: number, y0: number, x1: number, y1: number): void {
  marquee.style.display = 'block'
  marquee.style.left = `${Math.min(x0, x1)}px`
  marquee.style.top = `${Math.min(y0, y1)}px`
  marquee.style.width = `${Math.abs(x1 - x0)}px`
  marquee.style.height = `${Math.abs(y1 - y0)}px`
}

export function hideMarquee(): void {
  marquee.style.display = 'none'
}

// --- Controls hint ----------------------------------------------------------

const hint = el(
  `position:fixed;left:50%;bottom:14px;transform:translateX(-50%);font:${FONT};` +
    'color:rgba(220,228,255,.42);pointer-events:none;white-space:nowrap;z-index:8',
)
hint.textContent =
  'drag to move a card  ·  Z take  ·  X play onto a card  ·  hold C to select a group  ·  H stats'

export function setHint(text: string): void {
  hint.textContent = text
}
