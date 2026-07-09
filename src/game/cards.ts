import * as THREE from 'three'
import { Spring } from '../lib/motion'

/** Small, thin, rounded cards — overlap in hand; peek lifts on hover. */
export const CARD_W = 0.135
export const CARD_H = 0.188
export const CARD_D = 0.0022
export const CARD_RADIUS = 0.012
/** Rest height above table surface so cards don't sink. */
export const TABLE_CARD_Y = 0.028

const canvasCache = new Map<string, THREE.CanvasTexture>()
let sharedGeo: THREE.ExtrudeGeometry | null = null

function roundedCardGeometry() {
  if (sharedGeo) return sharedGeo
  const shape = new THREE.Shape()
  const w = CARD_W
  const h = CARD_H
  const r = CARD_RADIUS
  const x = -w / 2
  const y = -h / 2
  shape.moveTo(x + r, y)
  shape.lineTo(x + w - r, y)
  shape.quadraticCurveTo(x + w, y, x + w, y + r)
  shape.lineTo(x + w, y + h - r)
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  shape.lineTo(x + r, y + h)
  shape.quadraticCurveTo(x, y + h, x, y + h - r)
  shape.lineTo(x, y + r)
  shape.quadraticCurveTo(x, y, x + r, y)
  sharedGeo = new THREE.ExtrudeGeometry(shape, {
    depth: CARD_D,
    bevelEnabled: true,
    bevelThickness: 0.0006,
    bevelSize: 0.0008,
    bevelSegments: 2,
    curveSegments: 8,
  })
  // Center depth on Z so ±Z faces sit symmetrically
  sharedGeo.translate(0, 0, -CARD_D / 2)
  sharedGeo.computeVertexNormals()
  return sharedGeo
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(/\s+/)
  let line = ''
  let yy = y
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, yy)
      line = word
      yy += lineHeight
    } else {
      line = test
    }
  }
  if (line) ctx.fillText(line, x, yy)
  return yy
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export function cardTexture(text: string, kind: 'white' | 'black' | 'back'): THREE.CanvasTexture {
  const key = `${kind}|${text}`
  const hit = canvasCache.get(key)
  if (hit) return hit

  const c = document.createElement('canvas')
  c.width = 512
  c.height = 720
  const ctx = c.getContext('2d')!
  const pad = 18
  const rr = 36

  ctx.clearRect(0, 0, c.width, c.height)
  roundRect(ctx, pad, pad, c.width - pad * 2, c.height - pad * 2, rr)

  if (kind === 'back') {
    ctx.fillStyle = '#161614'
    ctx.fill()
    ctx.strokeStyle = '#2c2c28'
    ctx.lineWidth = 14
    roundRect(ctx, pad + 22, pad + 22, c.width - (pad + 22) * 2, c.height - (pad + 22) * 2, 24)
    ctx.stroke()
    ctx.fillStyle = '#f2f2ee'
    ctx.font = 'italic 58px "Instrument Serif", Georgia, serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Peril', c.width / 2, c.height / 2)
  } else if (kind === 'black') {
    ctx.fillStyle = '#121210'
    ctx.fill()
    ctx.fillStyle = '#f4f4f0'
    ctx.font = '500 34px "DM Sans", system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    wrapText(ctx, text.replace(/_+/g, '____'), 56, 72, c.width - 112, 44)
  } else {
    ctx.fillStyle = '#f8f8f4'
    ctx.fill()
    // Soft inner edge
    ctx.strokeStyle = 'rgba(0,0,0,0.06)'
    ctx.lineWidth = 3
    roundRect(ctx, pad + 2, pad + 2, c.width - (pad + 2) * 2, c.height - (pad + 2) * 2, rr - 2)
    ctx.stroke()
    ctx.fillStyle = '#1a1a18'
    ctx.font = '500 32px "DM Sans", system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    wrapText(ctx, text, 56, 72, c.width - 112, 42)
  }

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  canvasCache.set(key, tex)
  return tex
}

export type CardMesh = THREE.Mesh & {
  userData: {
    cardText: string
    kind: 'white' | 'black' | 'back'
    lift: Spring
    tiltX: Spring
    tiltZ: Spring
    baseY: number
    baseRotX: number
    baseRotY: number
    baseRotZ: number
    index: number
    selectable: boolean
    submissionPlayerId?: string
    cardKey?: string
    dragging?: boolean
  }
}

/**
 * Thin rounded card. Extruded shape with polished face textures.
 * +Z and −Z both get the readable face for white/black.
 */
export function createCard(text: string, kind: 'white' | 'black' | 'back' = 'white'): CardMesh {
  const geo = roundedCardGeometry().clone()
  const faceMap = cardTexture(text, kind === 'back' ? 'back' : kind)
  const logoMap = cardTexture('Peril', 'back')
  const faceMat = new THREE.MeshStandardMaterial({
    map: faceMap,
    roughness: 0.42,
    metalness: 0.04,
  })
  const rearMat = new THREE.MeshStandardMaterial({
    map: kind === 'back' ? logoMap : faceMap,
    roughness: 0.42,
    metalness: 0.04,
  })
  const edge = new THREE.MeshStandardMaterial({
    color: kind === 'black' ? '#0e0e0c' : '#ecece8',
    roughness: 0.55,
    metalness: 0.08,
  })
  // ExtrudeGeometry groups: 0 = front(+Z-ish after translate), 1 = back, 2 = sides
  // With translate centering, material index order from ExtrudeGeometry:
  // group 0: top (shape face), group 1: bottom, group 2+: sides
  const mat = [faceMat, rearMat, edge]
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.receiveShadow = true
  const card = mesh as unknown as CardMesh
  card.userData = {
    cardText: text,
    kind,
    lift: new Spring(0, 260, 26),
    tiltX: new Spring(0, 220, 22),
    tiltZ: new Spring(0, 220, 22),
    baseY: 0,
    baseRotX: 0,
    baseRotY: 0,
    baseRotZ: 0,
    index: 0,
    selectable: true,
  }
  return card
}

export function dropCard(card: CardMesh, fromY: number, toY: number) {
  card.position.y = fromY
  card.userData.baseY = toY
  card.userData.lift.set(fromY - toY)
  card.userData.lift.center = 0
  card.userData.lift.velocity = -0.5
}

export function updateCardMotion(
  card: CardMesh,
  dt: number,
  hovered: boolean,
  selected: boolean,
  opts: { lift?: number; tiltX?: number; tiltZ?: number } = {},
) {
  if (card.userData.dragging) return
  const targetLift = hovered ? (opts.lift ?? 0.08) : selected ? 0.04 : 0
  const targetTiltX = hovered ? (opts.tiltX ?? -0.12) : selected ? -0.04 : 0
  const targetTiltZ = hovered ? (opts.tiltZ ?? 0.03) : selected ? -0.015 : 0
  const lift = card.userData.lift.animateTo(targetLift, dt)
  const tx = card.userData.tiltX.animateTo(targetTiltX, dt)
  const tz = card.userData.tiltZ.animateTo(targetTiltZ, dt)
  card.position.y = card.userData.baseY + lift
  card.rotation.x = card.userData.baseRotX + tx
  card.rotation.y = card.userData.baseRotY
  card.rotation.z = card.userData.baseRotZ + tz
}
