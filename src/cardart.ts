import * as THREE from 'three'
import { RANKS, isRedSuit, type CardDef, type Suit } from './packs'

/**
 * cardart.ts — how a card looks, drawn from scratch onto a canvas.
 *
 * Every face, every pip, and the back are painted procedurally, so the repo
 * ships no image assets and the art regenerates at whatever resolution the
 * caller asks for. packs.ts decides *which* cards exist; this module decides
 * what they look like and hands back a texture plus the UV maths to show one.
 *
 * The important structural choice is the atlas. A pack has 54+ unique faces,
 * and one texture per face means one material per card — 54 draw calls and 54
 * uniform blocks for what is geometrically the same quad. Instead a whole pack
 * is drawn into a single canvas and every card samples a sub-rectangle of it,
 * so the entire deck runs on one shared material and the only per-card state is
 * a UV rect. `uvFor(id)` returns that rect; see the note on it for how a mesh
 * consumes it.
 *
 * No DOM is needed to *import* this file. Every canvas call is inside a
 * function, and each build guards on `typeof document` and returns an empty
 * texture rather than throwing when there is none — so an authoritative host or
 * a headless test can import it, and only actual rendering needs a browser.
 */

// ---------------------------------------------------------------------------
// Card metrics
// ---------------------------------------------------------------------------

// Art is laid out in millimetres on the real card. 63x88mm restates CARD_W and
// CARD_H from card.ts rather than importing them: a value import would need the
// './card.ts' extension to resolve under bundler resolution, which tsc rejects,
// and card.ts pulls in three's mesh code the headless side has no need to load.
const MM_W = 63
const MM_H = 88
const MID_X = MM_W / 2
const MID_Y = MM_H / 2

/** The mesh rounds its corners at 5mm (CORNER_R in card.ts), which crops the
 *  texture's corners. Nothing that must be seen may sit outside this radius. */
const MESH_CORNER_MM = 5

/**
 * Atlas resolution. At 4px/mm a card cell is 252x352 — about twice what a card
 * covers on screen with the camera at its closest, so faces hold up under
 * magnification without a 54-card atlas becoming tens of MB of VRAM.
 */
const ATLAS_PX_PER_MM = 4

/** The back is one texture for the whole table, so it can afford to be sharper
 *  than a shared atlas cell. */
const BACK_PX_PER_MM = 8

/**
 * Gutter around each atlas cell, in pixels, painted with the card's own
 * background. Without it the bilinear tap just off a card's edge — and the first
 * couple of mip levels — bleed a neighbouring card's colour onto this one's rim.
 */
const CELL_PAD = 4

/** The maximum texture size every WebGL2 implementation guarantees. Neither
 *  dimension of the atlas may exceed it. */
const MAX_TEX = 4096

const PAPER = '#fdfcf7'
const INK_RED = '#c1202e'
const INK_BLACK = '#161616'
const HAIRLINE = '#e4dfd1'

// System font stacks with generic and Liberation fallbacks, so the art is the
// same shape whether it renders in a browser or a Linux CI container.
const SANS = "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif"
const SERIF = "Georgia, 'Times New Roman', 'Liberation Serif', serif"

function font(weight: number | string, sizeMm: number, family: string): string {
  return `${weight} ${sizeMm}px ${family}`
}

const SUIT_INDEX: Record<Suit, number> = { S: 0, H: 1, D: 2, C: 3 }

// ---------------------------------------------------------------------------
// UV rects
// ---------------------------------------------------------------------------

/** A sub-rectangle of a texture in UV space, origin bottom-left (the corner
 *  three samples from with the default flipY), so it can be written straight
 *  into a UV attribute with no further flipping. */
export interface UVRect {
  x: number
  y: number
  w: number
  h: number
}

const FULL_RECT: UVRect = { x: 0, y: 0, w: 1, h: 1 }

/**
 * A pack's art as one texture, plus the map from card id to its cell.
 *
 * How a caller shows a face: take `uvFor(card.id)` and write UVs into a per-card
 * copy of the geometry. card.ts builds the card as an indexed mesh whose front
 * cap is material group 0, back is 1, edges are 2. Do not trust ExtrudeGeometry's
 * own UVs — they come out in shape units (metres), not 0..1 — so derive a clean
 * 0..1 from each vertex's position instead: u = (x + CARD_W/2) / CARD_W, v =
 * (y + CARD_H/2) / CARD_H. Then for every vertex the front group indexes, set
 * (rect.x + u * rect.w, rect.y + v * rect.h); the back cap faces -Z, so mirror u
 * there (1 - u) or its art comes out reversed. Point the shared material's map at
 * `atlas.texture`, and only the small per-card uv buffer differs between cards —
 * one material, 54 faces. Call `dispose()` when the deck is torn down.
 */
export interface CardAtlas {
  texture: THREE.Texture
  /** UV rect of `cardId`'s cell, or the full texture if the id is not in this
   *  atlas — a caller that mislabels a card gets a whole (wrong) face rather
   *  than a crash mid-render. */
  uvFor(cardId: string): UVRect
  dispose(): void
}

// ---------------------------------------------------------------------------
// The canvas seam
// ---------------------------------------------------------------------------

/**
 * The slice of CanvasRenderingContext2D actually used here. Narrowing it to
 * this keeps the drawing code honest about what it depends on and lets a test
 * or a worker's OffscreenCanvas stand in structurally. `fillStyle`/`strokeStyle`
 * are widened to `string | object` only so a real context — whose styles also
 * accept gradients and patterns — stays assignable without dragging DOM type
 * names in.
 */
interface Ctx2D {
  fillStyle: string | object
  strokeStyle: string | object
  lineWidth: number
  lineCap: 'butt' | 'round' | 'square'
  lineJoin: 'round' | 'bevel' | 'miter'
  font: string
  textAlign: 'start' | 'end' | 'left' | 'right' | 'center'
  textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom'
  globalAlpha: number
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  scale(x: number, y: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
  arc(x: number, y: number, r: number, start: number, end: number, counterclockwise?: boolean): void
  fill(): void
  stroke(): void
  clip(): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  measureText(text: string): { readonly width: number }
}

/**
 * Make a canvas and its 2d context, or null when there is no DOM.
 *
 * Every entry point routes through here, so the "no canvas here" case is decided
 * once. Callers turn a null into an empty (but valid) texture, which is what
 * lets the module be imported and its data-facing parts exercised on a host with
 * no rasteriser.
 */
function surface(pxW: number, pxH: number): { canvas: HTMLCanvasElement; ctx: Ctx2D } | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = pxW
  canvas.height = pxH
  const ctx = canvas.getContext('2d') as Ctx2D | null
  if (!ctx) return null
  return { canvas, ctx }
}

function toTexture(canvas: HTMLCanvasElement | null, name: string): THREE.Texture {
  // With no canvas, hand back a valid empty texture: the material stays intact
  // and a headless caller can still read colorSpace/name without a GL context.
  const tex = canvas ? new THREE.CanvasTexture(canvas) : new THREE.Texture()
  // Card art is authored in sRGB; without this every card renders washed out.
  tex.colorSpace = THREE.SRGBColorSpace
  // Cards are usually seen at a glancing angle, exactly when trilinear filtering
  // alone turns the corner indices to mush.
  tex.anisotropy = 8
  tex.name = name
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

/**
 * Suit pips, as paths in a 1x1 box centred on the origin.
 *
 * Drawn rather than typed as the ♠♥♦♣ glyphs because those characters vary
 * wildly between system fonts, and on several platforms resolve to colour emoji
 * — which would stamp a glossy 3D heart on the five of hearts.
 */
function pipPath(ctx: Ctx2D, suit: number): void {
  ctx.beginPath()
  switch (suit) {
    case 0: // spade: apex up, two lobes and a flared stem below
      ctx.moveTo(0, -0.48)
      ctx.bezierCurveTo(-0.08, -0.3, -0.5, -0.1, -0.5, 0.1)
      ctx.bezierCurveTo(-0.5, 0.3, -0.32, 0.4, -0.16, 0.33)
      ctx.bezierCurveTo(-0.1, 0.3, -0.06, 0.27, -0.05, 0.24)
      ctx.bezierCurveTo(-0.06, 0.36, -0.12, 0.44, -0.19, 0.48)
      ctx.lineTo(0.19, 0.48)
      ctx.bezierCurveTo(0.12, 0.44, 0.06, 0.36, 0.05, 0.24)
      ctx.bezierCurveTo(0.06, 0.27, 0.1, 0.3, 0.16, 0.33)
      ctx.bezierCurveTo(0.32, 0.4, 0.5, 0.3, 0.5, 0.1)
      ctx.bezierCurveTo(0.5, -0.1, 0.08, -0.3, 0, -0.48)
      ctx.closePath()
      break
    case 1: // heart
      ctx.moveTo(0, 0.46)
      ctx.bezierCurveTo(-0.16, 0.26, -0.5, 0.02, -0.5, -0.18)
      ctx.bezierCurveTo(-0.5, -0.4, -0.24, -0.48, -0.1, -0.3)
      ctx.bezierCurveTo(-0.05, -0.24, -0.02, -0.2, 0, -0.16)
      ctx.bezierCurveTo(0.02, -0.2, 0.05, -0.24, 0.1, -0.3)
      ctx.bezierCurveTo(0.24, -0.48, 0.5, -0.4, 0.5, -0.18)
      ctx.bezierCurveTo(0.5, 0.02, 0.16, 0.26, 0, 0.46)
      ctx.closePath()
      break
    case 2: // diamond
      ctx.moveTo(0, -0.5)
      ctx.lineTo(0.36, 0)
      ctx.lineTo(0, 0.5)
      ctx.lineTo(-0.36, 0)
      ctx.closePath()
      break
    default: // club: three lobes over a stem
      ctx.arc(0, -0.235, 0.222, 0, Math.PI * 2)
      ctx.closePath()
      ctx.moveTo(-0.028, 0.115)
      ctx.arc(-0.25, 0.115, 0.222, 0, Math.PI * 2)
      ctx.closePath()
      ctx.moveTo(0.472, 0.115)
      ctx.arc(0.25, 0.115, 0.222, 0, Math.PI * 2)
      ctx.closePath()
      break
  }
  ctx.fill()

  if (suit === 3) {
    // The club stem is a separate fill: sharing the path with the three lobes
    // would need its winding to match theirs, and the non-zero rule punches a
    // hole through the middle of the club when it does not.
    ctx.beginPath()
    ctx.moveTo(0.05, 0.06)
    ctx.bezierCurveTo(0.055, 0.27, 0.14, 0.43, 0.22, 0.5)
    ctx.lineTo(-0.22, 0.5)
    ctx.bezierCurveTo(-0.14, 0.43, -0.055, 0.27, -0.05, 0.06)
    ctx.closePath()
    ctx.fill()
  }
}

/** Draw a pip `size` wide, centred at (cx, cy), optionally rotated 180° as the
 *  lower half of a real card is. */
function pip(ctx: Ctx2D, suit: number, cx: number, cy: number, size: number, flip = false): void {
  ctx.save()
  ctx.translate(cx, cy)
  if (flip) ctx.rotate(Math.PI)
  ctx.scale(size, size)
  pipPath(ctx, suit)
  ctx.restore()
}

/** Centre text horizontally, squeezing it only if it would overrun `maxWidth`. */
function fittedText(ctx: Ctx2D, text: string, cx: number, cy: number, maxWidth: number): void {
  const w = ctx.measureText(text).width
  ctx.save()
  ctx.translate(cx, cy)
  if (w > maxWidth) ctx.scale(maxWidth / w, 1)
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

/** Draw `text` with `extra` millimetres inserted between glyphs — the wide
 *  tracking that reads as a printed cap line rather than a run-on word. */
function letterspaced(ctx: Ctx2D, text: string, x: number, y: number, extra: number, align: 'left' | 'center'): void {
  const chars = [...text]
  const widths = chars.map((c) => ctx.measureText(c).width)
  const total = widths.reduce((a, b) => a + b, 0) + extra * (chars.length - 1)
  let cursor = align === 'center' ? x - total / 2 : x
  const previous = ctx.textAlign
  ctx.textAlign = 'left'
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], cursor, y)
    cursor += widths[i] + extra
  }
  ctx.textAlign = previous
}

function wrapText(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

// ---------------------------------------------------------------------------
// Standard faces
// ---------------------------------------------------------------------------

// The pip field for number cards: three columns and a run of rows, sized so
// nothing collides with the corner indices.
const PIP_COL = 10.6
const PIP_TOP = 20.5
const PIP_BOT = 67.5
const PIP_SIZE = 11.2

/**
 * Pip positions per rank as [column, t]: column in {-1, 0, 1}, t from 0 at the
 * top row to 1 at the bottom. This is the traditional arrangement — nine and
 * ten drop to four-row columns, seven and eight tuck an extra pip between the
 * outer rows — and any other layout looks subtly wrong to anyone who has held a
 * deck. Indexed by rank; the Ace (index 0) is drawn separately.
 */
const PIP_LAYOUT: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = (() => {
  const col = (t: number): Array<readonly [number, number]> => [
    [-1, t],
    [1, t],
  ]
  const third = 1 / 3
  const outer4: Array<readonly [number, number]> = [...col(0), ...col(third), ...col(2 * third), ...col(1)]
  return [
    [[0, 0.5]], // A — overridden by drawAce, kept so indices line up with RANKS
    [
      [0, 0],
      [0, 1],
    ],
    [
      [0, 0],
      [0, 0.5],
      [0, 1],
    ],
    [...col(0), ...col(1)],
    [...col(0), [0, 0.5], ...col(1)],
    [...col(0), ...col(0.5), ...col(1)],
    [...col(0), [0, 0.25], ...col(0.5), ...col(1)],
    [...col(0), [0, 0.25], ...col(0.5), [0, 0.75], ...col(1)],
    [...outer4, [0, 0.5]],
    [...outer4, [0, 1 / 6], [0, 5 / 6]],
  ]
})()

/** The rank + suit index in one corner. Called twice per card, the second time
 *  under a 180° transform, which is what makes a card read the same either way
 *  up — the property real cards have and players rely on when squaring a fan. */
function drawCornerIndex(ctx: Ctx2D, rank: string, suit: number, ink: string): void {
  ctx.fillStyle = ink
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = font(700, 10.2, SANS)
  // "10" is the only two-glyph rank; squeezing it to the width of the others
  // stops the corner column looking ragged when cards overlap in a fan.
  fittedText(ctx, rank, 6.3, 9.6, 7.6)
  pip(ctx, suit, 6.3, 17.6, 5.8)
}

/**
 * Court cards get a double-ended monogram panel rather than a lone letter.
 *
 * A bare "K" in the middle reads as a placeholder, so this is three layers: an
 * oversized suit pip ghosted back as a watermark, the letter over it, and a
 * solid pip at the waist — mirrored top and bottom so each half is the other
 * rotated 180°, the way a real double-headed court reads upright either way.
 * Stylised on purpose: figure art for twelve courts is a different project, and
 * a clean monogram panel is the tasteful version that still says "this is a K".
 */
function drawCourt(ctx: Ctx2D, rank: string, suit: number, ink: string): void {
  const x = 14.6
  const y = 17.2
  const w = MM_W - 2 * x
  const h = MM_H - 2 * y

  ctx.globalAlpha = 0.05
  ctx.fillStyle = ink
  roundedRectPath(ctx, x, y, w, h, 3)
  ctx.fill()
  ctx.globalAlpha = 1

  ctx.strokeStyle = ink
  ctx.lineWidth = 0.55
  roundedRectPath(ctx, x, y, w, h, 3)
  ctx.stroke()
  ctx.lineWidth = 0.22
  roundedRectPath(ctx, x + 1.1, y + 1.1, w - 2.2, h - 2.2, 2.2)
  ctx.stroke()

  ctx.lineWidth = 0.3
  ctx.beginPath()
  ctx.moveTo(x + 1.1, MID_Y)
  ctx.lineTo(x + w - 1.1, MID_Y)
  ctx.stroke()

  for (const flip of [false, true]) {
    ctx.save()
    ctx.translate(MID_X, MID_Y)
    if (flip) ctx.rotate(Math.PI)
    ctx.fillStyle = ink
    ctx.globalAlpha = 0.1
    pip(ctx, suit, 0, -14.6, 21)
    ctx.globalAlpha = 1
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = font('bold', 19, SERIF)
    ctx.fillText(rank, 0, -14.6)
    pip(ctx, suit, 0, -3.9, 7)
    ctx.restore()
  }
}

/** The Ace: one large pip inside a fine double ring, the way an ace's centre is
 *  traditionally given more ceremony than a single spot pip would. */
function drawAce(ctx: Ctx2D, suit: number, ink: string): void {
  ctx.strokeStyle = ink
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 0.35
  ctx.beginPath()
  ctx.arc(MID_X, MID_Y, 17.5, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 0.18
  ctx.beginPath()
  ctx.arc(MID_X, MID_Y, 16.2, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.fillStyle = ink
  pip(ctx, suit, MID_X, MID_Y, 24)
}

/**
 * A jester's cap: three horns off a band, each tipped with a bell.
 *
 * The two side horns hang out and *down* past the band. Drawn upright they read
 * as a crown instead — which is the wrong card entirely.
 */
function drawJesterCap(ctx: Ctx2D, cx: number, cy: number, scale: number): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(scale, scale)

  const horn = (tipX: number, tipY: number, baseX: number, half: number, bow: number): void => {
    ctx.beginPath()
    ctx.moveTo(baseX - half, 5)
    ctx.bezierCurveTo(baseX - half + bow, -4, tipX * 0.6 + bow, tipY * 0.8, tipX, tipY)
    ctx.bezierCurveTo(tipX - bow * 0.4, tipY + 4.4, baseX + half - bow * 0.3, -3, baseX + half, 5)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.arc(tipX, tipY, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  horn(-15.5, 1.5, -7.6, 3.4, -3.5)
  horn(15.5, 1.5, 7.6, 3.4, 3.5)
  horn(0, -15, 0, 4, 0)

  roundedRectPath(ctx, -12.5, 4.4, 25, 4.4, 2.2)
  ctx.fill()
  ctx.restore()
}

function drawJoker(ctx: Ctx2D, red: boolean): void {
  const ink = red ? INK_RED : INK_BLACK
  ctx.fillStyle = ink
  drawJesterCap(ctx, MID_X, MID_Y - 6, 1)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = font(700, 7.6, SERIF)
  letterspaced(ctx, 'JOKER', MID_X, MID_Y + 18, 1.6, 'center')

  // No rank for the corners, so the word runs up the edge instead — still
  // rotationally symmetric, which is the property that actually matters.
  for (const flip of [false, true]) {
    ctx.save()
    ctx.translate(MID_X, MID_Y)
    if (flip) ctx.rotate(Math.PI)
    ctx.translate(-MID_X, -MID_Y)
    ctx.translate(6.6, 8)
    ctx.rotate(Math.PI / 2)
    ctx.font = font(700, 4.2, SANS)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    letterspaced(ctx, 'JOKER', 0, 0, 1.1, 'left')
    ctx.restore()
  }
}

/** Paper, edge hairline, then whatever the card is. The one entry point per
 *  standard card, given the card's own definition. */
function drawStandardFace(ctx: Ctx2D, card: CardDef): void {
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, MM_W, MM_H)

  // A hairline parallel to the mesh's rounded corner, so the card keeps a
  // defined edge even against a pale table.
  ctx.strokeStyle = HAIRLINE
  ctx.lineWidth = 0.3
  roundedRectPath(ctx, 1.8, 1.8, MM_W - 3.6, MM_H - 3.6, MESH_CORNER_MM - 1.8)
  ctx.stroke()

  if (card.kind === 'joker') {
    drawJoker(ctx, card.id === 'joker-red')
    return
  }

  // A suit card. rank/suit are always present for kind 'suit'; fall back rather
  // than assert, so a malformed def degrades to a blank paper card.
  const suit = card.suit ? SUIT_INDEX[card.suit] : 0
  const rankIndex = card.rank ? RANKS.indexOf(card.rank as (typeof RANKS)[number]) : -1
  if (rankIndex < 0) return
  const rank = RANKS[rankIndex]
  const ink = card.suit && isRedSuit(card.suit) ? INK_RED : INK_BLACK

  for (const flip of [false, true]) {
    ctx.save()
    if (flip) {
      ctx.translate(MID_X, MID_Y)
      ctx.rotate(Math.PI)
      ctx.translate(-MID_X, -MID_Y)
    }
    drawCornerIndex(ctx, rank, suit, ink)
    ctx.restore()
  }

  ctx.fillStyle = ink
  if (rankIndex === 0) {
    drawAce(ctx, suit, ink)
  } else if (rankIndex >= 10) {
    drawCourt(ctx, rank, suit, ink)
  } else {
    for (const [column, t] of PIP_LAYOUT[rankIndex]) {
      const yy = PIP_TOP + t * (PIP_BOT - PIP_TOP)
      pip(ctx, suit, MID_X + column * PIP_COL, yy, PIP_SIZE, t > 0.5)
    }
  }
}

// ---------------------------------------------------------------------------
// Text (Cards Against Humanity–style) faces
// ---------------------------------------------------------------------------

const TEXT_MARGIN = 6.4
const TEXT_TOP = 9.5
const TEXT_W = MM_W - 2 * TEXT_MARGIN
/** Leaves a strip along the bottom for the pack mark. */
const TEXT_H = MM_H - TEXT_TOP - 14

/** Black pack is white ink on near-black, white pack the reverse — decided by
 *  the card's pack, so the drawer needs no extra argument. */
function drawTextFace(ctx: Ctx2D, card: CardDef): void {
  const black = card.pack === 'cah-black'
  const paper = black ? '#0c0c0c' : '#f6f5f2'
  const ink = black ? '#f6f5f2' : '#101010'
  const text = card.text ?? ''

  ctx.fillStyle = paper
  ctx.fillRect(0, 0, MM_W, MM_H)

  ctx.fillStyle = ink
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  // Step the size down until the block fits rather than trusting one size for
  // every string: a long prompt silently running off the card is exactly the
  // kind of thing nobody notices until it is face-up on the table.
  let size = 6.6
  let lines: string[] = []
  for (const candidate of [6.6, 6.1, 5.6, 5.1, 4.7, 4.3, 3.9]) {
    size = candidate
    ctx.font = font(800, size, SANS)
    lines = wrapText(ctx, text, TEXT_W)
    if (lines.length * size * 1.22 <= TEXT_H) break
  }

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], TEXT_MARGIN, TEXT_TOP + i * size * 1.22)
  }

  // Pack mark, bottom-left: a small filled square and the game name, the way the
  // real cards carry a tiny logo in that corner.
  const markY = MM_H - 9.4
  ctx.fillStyle = ink
  roundedRectPath(ctx, TEXT_MARGIN, markY, 3.4, 3.4, 0.7)
  ctx.fill()
  ctx.font = font(800, 3.1, SANS)
  ctx.textBaseline = 'middle'
  letterspaced(ctx, 'PERIL', TEXT_MARGIN + 4.8, markY + 1.9, 0.55, 'left')
}

/** Route a definition to its drawer. The discriminant is the card's `kind`,
 *  except text cards, which are recognised by carrying `text`. */
function drawFace(ctx: Ctx2D, card: CardDef): void {
  if (card.kind === 'text') drawTextFace(ctx, card)
  else drawStandardFace(ctx, card)
}

// ---------------------------------------------------------------------------
// The back
// ---------------------------------------------------------------------------

const BACK_FIELD = '#7a1f2b' // the original Peril back colour, kept as the base
const BACK_DEEP = '#5a141e'
const BACK_LIGHT = 'rgba(255, 226, 214, 0.92)'

/** A four-petal ornament, the repeating unit of the lattice. */
function fleuron(ctx: Ctx2D, cx: number, cy: number, size: number): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.beginPath()
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    const px = Math.cos(a + Math.PI / 2)
    const py = Math.sin(a + Math.PI / 2)
    ctx.moveTo(0, 0)
    ctx.quadraticCurveTo((dx + px * 0.55) * size, (dy + py * 0.55) * size, dx * size, dy * size)
    ctx.quadraticCurveTo((dx - px * 0.55) * size, (dy - py * 0.55) * size, 0, 0)
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/**
 * The shared card back on the deep-red Peril base: a diagonal lattice guilloché
 * with a fleuron at every crossing, a double border, and a radial centre
 * medallion.
 *
 * 180°-rotational symmetry is not decoration here — a back with any
 * distinguishable orientation lets a player read a card from the wrong side of
 * the table. Everything below is either radial about the centre or laid on a
 * lattice centred on it, and the lattice step divides the half-width so an exact
 * number of cells falls either side of the centre line; an arbitrary step reads
 * as off-centre. The design is authored on the full card and drawn once, so it
 * "tiles" only in the sense that the lattice is seamless across the field — it
 * is not a wrap-repeated tile, which a single card face has no need to be.
 */
function drawBack(ctx: Ctx2D): void {
  ctx.fillStyle = BACK_FIELD
  ctx.fillRect(0, 0, MM_W, MM_H)

  const inset = 2.6
  roundedRectPath(ctx, inset, inset, MM_W - 2 * inset, MM_H - 2 * inset, MESH_CORNER_MM - inset)
  ctx.save()
  ctx.clip()
  ctx.fillStyle = BACK_DEEP
  ctx.fillRect(0, 0, MM_W, MM_H)

  // Diagonal lattice. Both diagonal families, so the crossings form a diamond
  // grid rather than parallel rules.
  const step = 4.4
  const span = MM_W + MM_H
  ctx.strokeStyle = BACK_LIGHT
  ctx.globalAlpha = 0.16
  ctx.lineWidth = 0.22
  ctx.beginPath()
  for (let d = -span; d <= span; d += step) {
    ctx.moveTo(MID_X + d - span, MID_Y - span)
    ctx.lineTo(MID_X + d + span, MID_Y + span)
    ctx.moveTo(MID_X + d - span, MID_Y + span)
    ctx.lineTo(MID_X + d + span, MID_Y - span)
  }
  ctx.stroke()

  // A fleuron at every second crossing, so they sit on the diamond centres.
  ctx.globalAlpha = 0.3
  ctx.fillStyle = BACK_LIGHT
  const rows = Math.ceil(MM_H / step) + 2
  const cols = Math.ceil(MM_W / step) + 2
  for (let r = -rows; r <= rows; r++) {
    for (let c = -cols; c <= cols; c++) {
      if ((r + c) % 2 !== 0) continue
      const x = MID_X + c * step
      const y = MID_Y + r * step
      if (x < -step || x > MM_W + step || y < -step || y > MM_H + step) continue
      fleuron(ctx, x, y, 1.5)
    }
  }
  ctx.globalAlpha = 1
  ctx.restore()

  // Central medallion: a field disc that masks the lattice, a double ring, a
  // ring of petals, and a fleuron in a small hub.
  ctx.save()
  ctx.translate(MID_X, MID_Y)
  ctx.fillStyle = BACK_FIELD
  ctx.beginPath()
  ctx.arc(0, 0, 17.6, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = BACK_LIGHT
  ctx.globalAlpha = 0.85
  ctx.lineWidth = 0.5
  ctx.beginPath()
  ctx.arc(0, 0, 17.6, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 0.22
  ctx.beginPath()
  ctx.arc(0, 0, 16.3, 0, Math.PI * 2)
  ctx.stroke()

  const petals = 12
  ctx.globalAlpha = 0.5
  ctx.fillStyle = BACK_LIGHT
  for (let i = 0; i < petals; i++) {
    ctx.save()
    ctx.rotate((i / petals) * Math.PI * 2)
    ctx.beginPath()
    ctx.moveTo(0, -5.4)
    ctx.bezierCurveTo(3.3, -7.4, 3.6, -12.4, 0, -15.2)
    ctx.bezierCurveTo(-3.6, -12.4, -3.3, -7.4, 0, -5.4)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.arc(0, 0, 4.4, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = BACK_DEEP
  ctx.beginPath()
  ctx.arc(0, 0, 3.4, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.fillStyle = BACK_LIGHT
  fleuron(ctx, 0, 0, 2.6)
  ctx.restore()

  // Border: a heavy rule with a hairline just inside it.
  ctx.strokeStyle = BACK_LIGHT
  ctx.globalAlpha = 0.9
  ctx.lineWidth = 0.55
  roundedRectPath(ctx, inset, inset, MM_W - 2 * inset, MM_H - 2 * inset, MESH_CORNER_MM - inset)
  ctx.stroke()
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 0.22
  const inner = inset + 1.4
  roundedRectPath(ctx, inner, inner, MM_W - 2 * inner, MM_H - 2 * inner, MESH_CORNER_MM - inner)
  ctx.stroke()
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------------------
// Atlas assembly
// ---------------------------------------------------------------------------

interface Grid {
  cols: number
  rows: number
}

/**
 * Pick the cheapest grid for `count` cells: least total area, then most square.
 * A 1x54 strip of cards is 3.6 metres of texture and drivers hate it, so the
 * square-ness tie-breaker earns its keep even when a taller strip has equal
 * area. Throws if no arrangement fits the 4096px limit at this resolution — the
 * honest failure, rather than silently cropping the deck.
 */
function chooseGrid(count: number, pitchW: number, pitchH: number): Grid {
  let best: Grid | null = null
  let bestScore = Infinity
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const w = cols * pitchW
    const h = rows * pitchH
    if (w > MAX_TEX || h > MAX_TEX) continue
    const score = w * h * (1 + 0.02 * (Math.max(w, h) / Math.min(w, h)))
    if (score < bestScore) {
      bestScore = score
      best = { cols, rows }
    }
  }
  if (!best) throw new Error(`cardart: ${count} cards do not fit a ${MAX_TEX}px atlas at this resolution`)
  return best
}

/**
 * Draw a whole pack of cards into one atlas texture.
 *
 * Cells are laid out in the order the cards arrive, left to right then top to
 * bottom. That order is the caller's: pass the array from `buildDeck(pack)` and
 * the atlas matches packs.ts's canonical order, or pass a shuffled array and the
 * ids still map correctly because `uvFor` keys on id, not position. Mixing packs
 * in one array is allowed — each card is drawn by its own `kind` — though a
 * single-pack atlas is the usual case.
 *
 * Returns an atlas whose UV rects have their origin bottom-left, ready to write
 * straight into a UV attribute. See {@link CardAtlas} for how a mesh applies one.
 */
export function buildAtlas(cards: CardDef[]): CardAtlas {
  const count = cards.length
  const artW = Math.round(MM_W * ATLAS_PX_PER_MM)
  const artH = Math.round(MM_H * ATLAS_PX_PER_MM)
  const pitchW = artW + CELL_PAD * 2
  const pitchH = artH + CELL_PAD * 2
  const { cols, rows } = chooseGrid(Math.max(count, 1), pitchW, pitchH)
  const width = cols * pitchW
  const height = rows * pitchH

  // id -> cell index, resolved once. Later duplicates of an id do not overwrite
  // the first, so a caller that repeats a card still gets a stable rect for it.
  const cellOf = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    if (!cellOf.has(cards[i].id)) cellOf.set(cards[i].id, i)
  }

  const rectAt = (i: number): UVRect => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const px = col * pitchW + CELL_PAD
    const py = row * pitchH + CELL_PAD
    return {
      x: px / width,
      // Cells are drawn top-down but sampled bottom-up, so flip the row.
      y: 1 - (py + artH) / height,
      w: artW / width,
      h: artH / height,
    }
  }

  const made = surface(width, height)
  if (made) {
    const { ctx } = made
    for (let i = 0; i < count; i++) {
      ctx.save()
      // Draw across the gutter too, then clip back to the card, so the padding
      // carries this card's own background rather than a hard seam.
      ctx.translate((i % cols) * pitchW, Math.floor(i / cols) * pitchH)
      ctx.scale(ATLAS_PX_PER_MM, ATLAS_PX_PER_MM)
      ctx.translate(CELL_PAD / ATLAS_PX_PER_MM, CELL_PAD / ATLAS_PX_PER_MM)
      const bleed = CELL_PAD / ATLAS_PX_PER_MM
      ctx.beginPath()
      ctx.moveTo(-bleed, -bleed)
      ctx.lineTo(MM_W + bleed, -bleed)
      ctx.lineTo(MM_W + bleed, MM_H + bleed)
      ctx.lineTo(-bleed, MM_H + bleed)
      ctx.closePath()
      ctx.clip()
      drawFace(ctx, cards[i])
      ctx.restore()
    }
  }

  const texture = toTexture(made ? made.canvas : null, `atlas:${cards[0]?.pack ?? 'empty'}:${count}`)

  return {
    texture,
    uvFor(cardId: string): UVRect {
      const i = cellOf.get(cardId)
      return i === undefined ? FULL_RECT : rectAt(i)
    },
    dispose(): void {
      texture.dispose()
    },
  }
}

/** The shared back as its own texture. One per table, so it can afford the
 *  higher resolution the atlas cells cannot. */
export function buildCardBackTexture(): THREE.Texture {
  const made = surface(Math.round(MM_W * BACK_PX_PER_MM), Math.round(MM_H * BACK_PX_PER_MM))
  if (made) {
    made.ctx.save()
    made.ctx.scale(BACK_PX_PER_MM, BACK_PX_PER_MM)
    drawBack(made.ctx)
    made.ctx.restore()
  }
  return toTexture(made ? made.canvas : null, 'card:back')
}
