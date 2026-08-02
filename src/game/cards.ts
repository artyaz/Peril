/**
 * Card meshes, face textures, and per-card motion state.
 *
 * Optimisation notes:
 *  - One geometry and one back/body material are shared by every card in the
 *    scene. Only the face plane is per-card, and only when the local player is
 *    actually allowed to see that face — a remote player's hand is backs-only,
 *    so it costs no textures at all.
 *  - Face textures are cached by text. Seven cards showing the same response
 *    share one GPU upload, and the cache is bounded so a long game cannot leak.
 */

import * as THREE from 'three'
import { CARD_D, CARD_H, CARD_W } from '../../shared/constants'
import { Spring, Spring3 } from '../spring'

const CORNER_R = 0.005

// ---------------------------------------------------------------------------
// Shared geometry / materials
// ---------------------------------------------------------------------------

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const hw = w / 2
  const hh = h / 2
  s.moveTo(-hw + r, -hh)
  s.lineTo(hw - r, -hh)
  s.quadraticCurveTo(hw, -hh, hw, -hh + r)
  s.lineTo(hw, hh - r)
  s.quadraticCurveTo(hw, hh, hw - r, hh)
  s.lineTo(-hw + r, hh)
  s.quadraticCurveTo(-hw, hh, -hw, hh - r)
  s.lineTo(-hw, -hh + r)
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh)
  return s
}

const BODY_GEO = new THREE.ExtrudeGeometry(roundedRect(CARD_W, CARD_H, CORNER_R), {
  depth: CARD_D,
  bevelEnabled: true,
  bevelThickness: 0.0004,
  bevelSize: 0.0004,
  bevelSegments: 2,
  curveSegments: 8,
})
BODY_GEO.translate(0, 0, -CARD_D / 2)
BODY_GEO.computeVertexNormals()

const FACE_GEO = new THREE.PlaneGeometry(CARD_W - 0.004, CARD_H - 0.004)

const BODY_MAT = new THREE.MeshStandardMaterial({
  color: '#f7f6f1',
  roughness: 0.34,
  metalness: 0,
})

/** Card back — shared by every face-down card in the room. */
const BACK_MAT = new THREE.MeshStandardMaterial({
  color: '#191a2e',
  roughness: 0.38,
  metalness: 0.06,
})

// ---------------------------------------------------------------------------
// Face texture cache
// ---------------------------------------------------------------------------

const TEX_W = 384
const TEX_H = 536
const MAX_CACHED = 96

type CachedTex = { texture: THREE.CanvasTexture; material: THREE.MeshStandardMaterial }
const texCache = new Map<string, CachedTex>()

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = w
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawFace(text: string, variant: 'response' | 'prompt'): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = TEX_W
  c.height = TEX_H
  const ctx = c.getContext('2d')!

  const dark = variant === 'prompt'
  ctx.fillStyle = dark ? '#141422' : '#faf9f5'
  ctx.fillRect(0, 0, TEX_W, TEX_H)

  const pad = 34
  const maxWidth = TEX_W - pad * 2

  // Shrink to fit rather than overflow — long responses must stay readable.
  let size = 40
  let lines: string[] = []
  for (; size >= 21; size -= 2) {
    ctx.font = `700 ${size}px "Inter", system-ui, -apple-system, sans-serif`
    lines = wrapLines(ctx, text, maxWidth)
    if (lines.length * size * 1.24 <= TEX_H - pad * 2 - 46) break
  }

  ctx.fillStyle = dark ? '#f5f5fa' : '#16161c'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const lh = size * 1.24
  lines.forEach((ln, i) => ctx.fillText(ln, pad, pad + i * lh))

  // Foot rule + wordmark, so a card reads as a card even face-down in a pile.
  ctx.strokeStyle = dark ? 'rgba(245,245,250,0.18)' : 'rgba(20,20,28,0.14)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(pad, TEX_H - 52)
  ctx.lineTo(TEX_W - pad, TEX_H - 52)
  ctx.stroke()

  ctx.font = '700 19px "Inter", system-ui, sans-serif'
  ctx.fillStyle = dark ? 'rgba(245,245,250,0.5)' : 'rgba(20,20,28,0.42)'
  ctx.fillText('PERIL', pad, TEX_H - 40)

  return c
}

function faceMaterial(
  text: string,
  variant: 'response' | 'prompt',
  renderer?: THREE.WebGLRenderer,
): THREE.MeshStandardMaterial {
  const key = `${variant}:${text}`
  const hit = texCache.get(key)
  if (hit) {
    // Refresh LRU position.
    texCache.delete(key)
    texCache.set(key, hit)
    return hit.material
  }

  const texture = new THREE.CanvasTexture(drawFace(text, variant))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.needsUpdate = true

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.42,
    metalness: 0,
  })

  texCache.set(key, { texture, material })

  // Evict oldest once over budget.
  while (texCache.size > MAX_CACHED) {
    const oldestKey = texCache.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    const old = texCache.get(oldestKey)!
    texCache.delete(oldestKey)
    old.texture.dispose()
    old.material.dispose()
  }

  return material
}

// ---------------------------------------------------------------------------
// Card object
// ---------------------------------------------------------------------------

export type CardMode = 'fan' | 'drag' | 'fly' | 'table' | 'stack'

export type CardState = {
  id: string
  text: string
  /** Seat that owns this card, or -1 for community/table cards. */
  ownerSeat: number
  mode: CardMode
  faceVisible: boolean
  /** Index within the owning fan — drives layout and hover sync. */
  index: number

  pos: Spring3
  rot: Spring3
  lift: Spring
  /** 0..1 hover blend, smoothed outside the spring system. */
  hover: number
  hovered: boolean
  selected: boolean

  /** Ballistic state, used only while `mode === 'fly'`. */
  vel: THREE.Vector3
  spin: THREE.Vector3

  /** Set when the card is a remote player's — never raycast against these. */
  interactive: boolean
}

export type Card = THREE.Group & { state: CardState }

export function createCard(opts: {
  id: string
  text: string
  ownerSeat: number
  faceVisible: boolean
  variant?: 'response' | 'prompt'
  renderer?: THREE.WebGLRenderer
}): Card {
  const group = new THREE.Group() as Card

  const body = new THREE.Mesh(BODY_GEO, BODY_MAT)
  body.castShadow = true
  body.receiveShadow = true
  body.name = 'body'
  group.add(body)

  // Back is always present; the face only when we may legitimately see it.
  const back = new THREE.Mesh(FACE_GEO, BACK_MAT)
  back.position.z = -(CARD_D / 2 + 0.0004)
  back.rotation.y = Math.PI
  back.name = 'back'
  group.add(back)

  if (opts.faceVisible) {
    const face = new THREE.Mesh(
      FACE_GEO,
      faceMaterial(opts.text, opts.variant ?? 'response', opts.renderer),
    )
    face.position.z = CARD_D / 2 + 0.0004
    face.name = 'face'
    group.add(face)
  }

  group.state = {
    id: opts.id,
    text: opts.text,
    ownerSeat: opts.ownerSeat,
    mode: 'fan',
    faceVisible: opts.faceVisible,
    index: 0,
    pos: new Spring3(300, 27),
    rot: new Spring3(260, 25),
    lift: new Spring(0, 420, 30),
    hover: 0,
    hovered: false,
    selected: false,
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    interactive: false,
  }

  return group
}

/** Swap a card's face in without rebuilding it — used when a play is revealed. */
export function revealFace(
  card: Card,
  text: string,
  variant: 'response' | 'prompt' = 'response',
  renderer?: THREE.WebGLRenderer,
) {
  card.state.text = text
  card.state.faceVisible = true
  const existing = card.getObjectByName('face') as THREE.Mesh | undefined
  const material = faceMaterial(text, variant, renderer)
  if (existing) {
    existing.material = material
    return
  }
  const face = new THREE.Mesh(FACE_GEO, material)
  face.position.z = CARD_D / 2 + 0.0004
  face.name = 'face'
  card.add(face)
}

/** Move a card between parents while keeping it exactly where it looks. */
export function reparentKeepingWorld(card: Card, next: THREE.Object3D) {
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  card.updateWorldMatrix(true, false)
  card.matrixWorld.decompose(pos, quat, scale)

  next.add(card)
  next.updateWorldMatrix(true, false)

  const inv = new THREE.Matrix4().copy(next.matrixWorld).invert()
  const local = new THREE.Matrix4().compose(pos, quat, scale).premultiply(inv)
  local.decompose(card.position, card.quaternion, card.scale)

  const e = new THREE.Euler().setFromQuaternion(card.quaternion, 'XYZ')
  card.state.pos.set(card.position.x, card.position.y, card.position.z)
  card.state.rot.set(e.x, e.y, e.z)
}

export function disposeCard(card: Card) {
  card.removeFromParent()
  // Geometry and materials are shared — only per-card face materials that came
  // from the cache would be freed there, so nothing to dispose here.
}

export { BODY_GEO, FACE_GEO, BACK_MAT }
