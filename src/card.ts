import * as THREE from 'three'
import type { CardAtlas } from './cardart'

/**
 * Card visuals. Purely presentational — every transform on screen comes from the
 * physics body, so nothing in here decides where a card goes.
 */

// Real playing card dimensions, in metres. The solver uses these same numbers,
// so mass, gravity and air drag all behave at true scale.
export const CARD_W = 0.063
export const CARD_H = 0.088
// A real playing card is about a third of a millimetre thick and weighs under
// two grams. At the old 2mm a 52-card deck stood 104mm tall — taller than a card
// is wide — so the deck read as a brick rather than a deck.
export const CARD_D = 0.00035
export const CARD_MASS = 0.0018

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
    // Scaled to the card: a bevel larger than the card is thick inverts it.
    bevelThickness: CARD_D * 0.2,
    bevelSize: CARD_D * 0.2,
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
  // Rewrite the UVs across the card face.
  //
  // ExtrudeGeometry lays UVs out in the shape's own units, which here is metres
  // — so they come out around 0.06 and are useless for sampling an atlas. Derive
  // them from vertex position instead. The back cap faces -Z, so its u is
  // mirrored; otherwise every card's back would read as its own mirror image.
  const pos = geo.getAttribute('position')
  const uv = geo.getAttribute('uv')
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) + CARD_W / 2) / CARD_W
    const v = (pos.getY(i) + CARD_H / 2) / CARD_H
    uv.setXY(i, normals.getZ(i) >= 0 ? u : 1 - u, v)
  }
  uv.needsUpdate = true

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

/**
 * Highlight levels.
 *
 * Each card owns its three materials rather than sharing one tinted set.
 * Sharing was cheaper and became wrong the moment cards had printed faces: a
 * highlight that swapped in a shared material array also swapped away whichever
 * face that card was showing. Tinting a card's own materials in place keeps the
 * face and costs only a couple of small objects per card — the texture, which is
 * the part that actually occupies memory, is still shared by every one of them.
 */
export const Highlight = { None: 0, Target: 1, Pick: 2 } as const
export type HighlightValue = (typeof Highlight)[keyof typeof Highlight]

// Warm for "you are about to drop onto this", cool for "you can pick this up".
const HIGHLIGHT_TINTS = ['#000000', '#ffa445', '#63d2ff']
const HIGHLIGHT_STRENGTH = [0, 0.5, 0.42]

export function setHighlight(mesh: THREE.Mesh, level: HighlightValue): void {
  for (const m of mesh.material as THREE.MeshStandardMaterial[]) {
    m.emissive.set(HIGHLIGHT_TINTS[level])
    m.emissiveIntensity = HIGHLIGHT_STRENGTH[level]
  }
}

/**
 * Give a card its own printed face.
 *
 * The atlas holds every face of a pack in one texture, so a card is identified
 * by which rectangle of it to sample. That is done with a cloned Texture rather
 * than cloned geometry: a clone shares the underlying `source`, so the GPU still
 * holds exactly one image, while `offset` and `repeat` pick out the cell. Cloning
 * geometry instead would mean a whole extra vertex buffer per card for the sake
 * of two floats.
 */
export function setCardFace(mesh: THREE.Mesh, atlas: CardAtlas, cardId: string): void {
  const rect = atlas.uvFor(cardId)
  const map = atlas.texture.clone()
  map.needsUpdate = true
  map.offset.set(rect.x, rect.y)
  map.repeat.set(rect.w, rect.h)

  const face = (mesh.material as THREE.MeshStandardMaterial[])[0]
  face.map = map
  face.color.set('#ffffff')
  face.needsUpdate = true
}

/**
 * Print the patterned back on every card dealt from here on.
 *
 * Set once, when the texture has been drawn. Backs deliberately stay identical
 * across every card — a back that differed in any readable way would be a tell.
 */
let sharedBack: THREE.Texture | null = null
export function setSharedCardBack(texture: THREE.Texture): void {
  sharedBack = texture
}

export function createCardMesh(): THREE.Mesh {
  // Own materials, shared texture. See the note on Highlight above.
  const back = backMaterial.clone()
  if (sharedBack) {
    back.map = sharedBack
    back.color.set('#ffffff')
  }
  const mesh = new THREE.Mesh(cardGeometry, [faceMaterial.clone(), back, edgeMaterial.clone()])
  mesh.castShadow = true
  mesh.receiveShadow = true
  // Transforms are written every frame from the physics body, so let Three skip
  // its own bookkeeping and update the matrix explicitly.
  mesh.matrixAutoUpdate = false
  return mesh
}

/** Half-extents matching the geometry, for the solver. */
export const CARD_HALF = { x: CARD_W / 2, y: CARD_H / 2, z: CARD_D / 2 }
