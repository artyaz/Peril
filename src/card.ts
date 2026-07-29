import * as THREE from 'three'
import { Spring } from './spring'

// --- Card dimensions (meters) ---
// Slightly thicker than real cards for visual boldness in 3D
export const CARD_W = 0.063
export const CARD_H = 0.088
export const CARD_D = 0.002

const CORNER_R = 0.005

export type CardMesh = THREE.Group & {
  userData: {
    lift: Spring
    hoverScale: Spring
    tiltX: Spring
    tiltZ: Spring
    posX: Spring
    posY: Spring
    posZ: Spring
    baseY: number
    baseRotX: number
    baseRotY: number
    baseRotZ: number
    index: number
    dragging: boolean
    hovered: boolean
  }
}

function createRoundedRectShape(w: number, h: number, r: number): THREE.Shape {
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

const shape = createRoundedRectShape(CARD_W, CARD_H, CORNER_R)
const cardGeometry = new THREE.ExtrudeGeometry(shape, {
  depth: CARD_D,
  bevelEnabled: true,
  bevelThickness: 0.0004,
  bevelSize: 0.0004,
  bevelSegments: 3,
  curveSegments: 12,
})
cardGeometry.translate(0, 0, -CARD_D / 2)
cardGeometry.computeVertexNormals()

// Materials — bold contrast
const faceMat = new THREE.MeshStandardMaterial({
  color: '#fafaf6',
  roughness: 0.28,
  metalness: 0.0,
})
const edgeMat = new THREE.MeshStandardMaterial({
  color: '#d4d4cc',
  roughness: 0.45,
  metalness: 0.02,
})
const backMat = new THREE.MeshStandardMaterial({
  color: '#16162a',
  roughness: 0.35,
  metalness: 0.08,
})

// Back face plane geometry (inset from card edge)
const backPlaneGeo = new THREE.PlaneGeometry(CARD_W - 0.008, CARD_H - 0.008)

export function createCard(): CardMesh {
  const group = new THREE.Group() as CardMesh

  // Extruded body: material[0] = caps (front+back), material[1] = sides
  const body = new THREE.Mesh(cardGeometry, [faceMat, edgeMat])
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  // Dark back face overlay on -Z side
  const back = new THREE.Mesh(backPlaneGeo, backMat)
  back.position.z = -(CARD_D / 2 + 0.0005)
  back.rotation.y = Math.PI
  group.add(back)

  group.userData = {
    lift: new Spring(0, 340, 28),
    hoverScale: new Spring(1, 300, 26),
    tiltX: new Spring(0, 280, 24),
    tiltZ: new Spring(0, 280, 24),
    posX: new Spring(0, 260, 24),
    posY: new Spring(0, 260, 24),
    posZ: new Spring(0, 260, 24),
    baseY: 0,
    baseRotX: 0,
    baseRotY: 0,
    baseRotZ: 0,
    index: 0,
    dragging: false,
    hovered: false,
  }

  return group
}

export function updateCardMotion(card: CardMesh, dt: number) {
  const ud = card.userData
  if (ud.dragging) return

  const targetLift = ud.hovered ? 0.022 : 0
  const targetScale = ud.hovered ? 1.15 : 1
  const targetTiltX = ud.hovered ? -0.1 : 0
  const targetTiltZ = ud.hovered ? 0.025 : 0

  const lift = ud.lift.animateTo(targetLift, dt)
  const scale = ud.hoverScale.animateTo(targetScale, dt)
  const tx = ud.tiltX.animateTo(targetTiltX, dt)
  const tz = ud.tiltZ.animateTo(targetTiltZ, dt)

  card.position.y = ud.baseY + lift
  card.scale.setScalar(scale)
  card.rotation.x = ud.baseRotX + tx
  card.rotation.z = ud.baseRotZ + tz
}
