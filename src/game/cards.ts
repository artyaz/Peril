import * as THREE from 'three'
import { Spring } from '../lib/motion'

export const CARD_W = 0.63
export const CARD_H = 0.88
export const CARD_D = 0.012

const canvasCache = new Map<string, THREE.CanvasTexture>()

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
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

export function cardTexture(text: string, kind: 'white' | 'black' | 'back'): THREE.CanvasTexture {
  const key = `${kind}|${text}`
  const hit = canvasCache.get(key)
  if (hit) return hit

  const c = document.createElement('canvas')
  c.width = 512
  c.height = 720
  const ctx = c.getContext('2d')!

  if (kind === 'back') {
    ctx.fillStyle = '#1a1a18'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.strokeStyle = '#2e2e2a'
    ctx.lineWidth = 18
    ctx.strokeRect(28, 28, c.width - 56, c.height - 56)
    ctx.fillStyle = '#f2f2ee'
    ctx.font = 'italic 64px "Instrument Serif", Georgia, serif'
    ctx.textAlign = 'center'
    ctx.fillText('Peril', c.width / 2, c.height / 2)
  } else if (kind === 'black') {
    ctx.fillStyle = '#141412'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#f4f4f0'
    ctx.font = '500 36px "DM Sans", system-ui, sans-serif'
    ctx.textAlign = 'left'
    wrapText(ctx, text.replace(/_+/g, '____'), 48, 90, c.width - 96, 48)
  } else {
    ctx.fillStyle = '#f7f7f3'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#1c1c1a'
    ctx.font = '500 34px "DM Sans", system-ui, sans-serif'
    ctx.textAlign = 'left'
    wrapText(ctx, text, 48, 90, c.width - 96, 46)
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
    index: number
    selectable: boolean
  }
}

export function createCard(text: string, kind: 'white' | 'black' | 'back' = 'white'): CardMesh {
  const geo = new THREE.BoxGeometry(CARD_W, CARD_D, CARD_H)
  const front = new THREE.MeshStandardMaterial({
    map: cardTexture(text, kind),
    roughness: 0.55,
    metalness: 0.02,
  })
  const back = new THREE.MeshStandardMaterial({
    map: cardTexture('', 'back'),
    roughness: 0.6,
    metalness: 0.02,
  })
  const edge = new THREE.MeshStandardMaterial({
    color: kind === 'black' ? '#111110' : '#e8e8e4',
    roughness: 0.8,
  })
  // Box faces: +x -x +y -y +z -z — we want +y as front face when card lies flat... 
  // Actually cards stand with thin dimension as Y when flat on table: rotate later.
  // Materials order: right, left, top, bottom, front, back
  const mat = [edge, edge, front, back, edge, edge]
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.receiveShadow = true
  const card = mesh as unknown as CardMesh
  card.userData = {
    cardText: text,
    kind,
    lift: new Spring(0, 220, 22),
    tiltX: new Spring(0, 180, 18),
    tiltZ: new Spring(0, 180, 18),
    baseY: 0,
    index: 0,
    selectable: true,
  }
  return card
}

/** Drop animation: anticipation + fall + soft bounce settle via springs. */
export function dropCard(card: CardMesh, fromY: number, toY: number) {
  card.position.y = fromY
  card.userData.baseY = toY
  card.userData.lift.set(fromY - toY)
  card.userData.lift.center = 0
  card.userData.lift.velocity = -0.5
}

export function updateCardMotion(card: CardMesh, dt: number, hovered: boolean, selected: boolean) {
  const targetLift = hovered ? 0.08 : selected ? 0.05 : 0
  const targetTiltX = hovered ? -0.12 : 0
  const targetTiltZ = hovered ? 0.04 : selected ? -0.02 : 0
  const lift = card.userData.lift.animateTo(targetLift, dt)
  const tx = card.userData.tiltX.animateTo(targetTiltX, dt)
  const tz = card.userData.tiltZ.animateTo(targetTiltZ, dt)
  card.position.y = card.userData.baseY + lift
  card.rotation.x = tx
  card.rotation.z = tz
}
