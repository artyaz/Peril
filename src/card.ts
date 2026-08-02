import * as THREE from 'three'

/**
 * Card visuals. Purely presentational — every transform on screen comes from the
 * physics body, so nothing in here decides where a card goes.
 */

// Real playing card dimensions, in metres. The solver uses these same numbers,
// so mass, gravity and air drag all behave at true scale.
export const CARD_W = 0.063
export const CARD_H = 0.088
export const CARD_D = 0.002
export const CARD_MASS = 0.0025

const CORNER_R = 0.005

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

/**
 * Build the card geometry as a single mesh with three material groups: front
 * face, back face, and edges.
 *
 * ExtrudeGeometry lumps both caps into one group, which would force a separate
 * overlay mesh just to give the back a different colour — an extra object and
 * an extra matrix update for every card on the table. Splitting the cap
 * triangles by facing direction keeps each card a single Object3D.
 */
function buildCardGeometry(): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(roundedRect(CARD_W, CARD_H, CORNER_R), {
    depth: CARD_D,
    bevelEnabled: true,
    bevelThickness: 0.0004,
    bevelSize: 0.0004,
    bevelSegments: 2,
    curveSegments: 10,
  })
  geo.translate(0, 0, -CARD_D / 2)
  geo.computeVertexNormals()

  const capGroup = geo.groups[0]
  const sideGroup = geo.groups[1]
  const normals = geo.getAttribute('normal')

  const front: number[] = []
  const back: number[] = []
  for (let i = capGroup.start; i < capGroup.start + capGroup.count; i += 3) {
    // Non-indexed: each run of three vertices is one triangle.
    ;(normals.getZ(i) >= 0 ? front : back).push(i, i + 1, i + 2)
  }
  const sides: number[] = []
  for (let i = sideGroup.start; i < sideGroup.start + sideGroup.count; i++) sides.push(i)

  geo.setIndex([...front, ...back, ...sides])
  geo.clearGroups()
  geo.addGroup(0, front.length, 0)
  geo.addGroup(front.length, back.length, 1)
  geo.addGroup(front.length + back.length, sides.length, 2)
  geo.computeBoundingSphere()
  return geo
}

const cardGeometry = buildCardGeometry()

/** Shared across every card, so the GPU sees one set of uniforms. */
const faceMaterial = new THREE.MeshStandardMaterial({
  color: '#f7f6f1',
  roughness: 0.32,
  metalness: 0.0,
})
const backMaterial = new THREE.MeshStandardMaterial({
  color: '#7a1f2b',
  roughness: 0.38,
  metalness: 0.05,
})
const edgeMaterial = new THREE.MeshStandardMaterial({
  color: '#d8d6cd',
  roughness: 0.5,
  metalness: 0.02,
})

const materials = [faceMaterial, backMaterial, edgeMaterial]

/**
 * Highlight variants.
 *
 * Highlighting by swapping in a *shared* material set rather than tinting a
 * per-card clone keeps every highlighted card on one set of uniforms, which
 * matters when a marquee selection lights up a dozen at once.
 */
export const Highlight = { None: 0, Target: 1, Pick: 2 } as const
export type HighlightValue = (typeof Highlight)[keyof typeof Highlight]

function tinted(emissive: string, intensity: number): THREE.Material[] {
  return materials.map((m) => {
    const c = (m as THREE.MeshStandardMaterial).clone()
    c.emissive = new THREE.Color(emissive)
    c.emissiveIntensity = intensity
    return c
  })
}

// Warm for "you are about to play onto this", cool for "you can pick this up".
const targetMaterials = tinted('#ffa445', 0.5)
const pickMaterials = tinted('#63d2ff', 0.42)

const materialSets: THREE.Material[][] = [materials, targetMaterials, pickMaterials]

export function setHighlight(mesh: THREE.Mesh, level: HighlightValue): void {
  mesh.material = materialSets[level]
}

export function createCardMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(cardGeometry, materials)
  mesh.castShadow = true
  mesh.receiveShadow = true
  // Transforms are written every frame from the physics body, so let Three skip
  // its own bookkeeping and update the matrix explicitly.
  mesh.matrixAutoUpdate = false
  return mesh
}

/** Half-extents matching the geometry, for the solver. */
export const CARD_HALF = { x: CARD_W / 2, y: CARD_H / 2, z: CARD_D / 2 }
