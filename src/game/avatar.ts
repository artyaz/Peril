import * as THREE from 'three'

export type AvatarHandle = {
  group: THREE.Group
  handAnchor: THREE.Group
  silhouette: THREE.Object3D
  setFace: (dataUrl?: string) => void
  setName: (name: string) => void
  setHighlight: (on: boolean) => void
  dispose: () => void
}

function makeNameSprite(name: string) {
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 160
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
  // Soft pill so names read against the pale room
  const label = name.length > 14 ? `${name.slice(0, 13)}…` : name
  ctx.font = '700 52px "DM Sans", system-ui, sans-serif'
  const tw = Math.min(ctx.measureText(label).width + 64, c.width - 24)
  const th = 72
  const x = (c.width - tw) / 2
  const y = (c.height - th) / 2
  ctx.fillStyle = 'rgba(250,250,248,0.88)'
  roundPill(ctx, x, y, tw, th, 36)
  ctx.fill()
  ctx.fillStyle = '#2a2a28'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, c.width / 2, c.height / 2 + 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(0.62, 0.155, 1)
  sprite.position.y = 1.08
  sprite.renderOrder = 10
  return sprite
}

function roundPill(
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

/** Compact XP pear silhouette as a real lathed mesh (depth-tested, not a billboard). */
function xpBodyGeometry() {
  const pts = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.04, 0.01),
    new THREE.Vector2(0.12, 0.04),
    new THREE.Vector2(0.2, 0.1),
    new THREE.Vector2(0.26, 0.18),
    new THREE.Vector2(0.28, 0.28),
    new THREE.Vector2(0.25, 0.36),
    new THREE.Vector2(0.18, 0.42),
    new THREE.Vector2(0.1, 0.46),
    new THREE.Vector2(0.07, 0.5), // neck
    new THREE.Vector2(0.09, 0.55),
    new THREE.Vector2(0.14, 0.62),
    new THREE.Vector2(0.155, 0.7),
    new THREE.Vector2(0.14, 0.78),
    new THREE.Vector2(0.08, 0.84),
    new THREE.Vector2(0.0, 0.86),
  ]
  const geo = new THREE.LatheGeometry(pts, 40)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const alpha = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const fade = THREE.MathUtils.smoothstep(y, 0.01, 0.22)
    const shade = 0.7 + fade * 0.22
    colors[i * 3] = shade
    colors[i * 3 + 1] = shade
    colors[i * 3 + 2] = shade * 0.98
    alpha[i] = fade * fade
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1))
  return geo
}

/**
 * Small real-3D Windows XP user figure: lathed pear body + round head.
 * Uses depth testing so it never overlays the local hand like a sprite.
 */
export function createAvatar(name: string, faceDataUrl?: string): AvatarHandle {
  const group = new THREE.Group()
  const gray = '#b8b8b4'

  const bodyMat = new THREE.MeshStandardMaterial({
    color: gray,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  })
  bodyMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float alpha;\nvarying float vAlpha;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvAlpha = alpha;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vAlpha;`)
      .replace(
        '#include <dithering_fragment>',
        `gl_FragColor.a *= clamp(vAlpha, 0.0, 1.0);\n#include <dithering_fragment>`,
      )
  }

  const body = new THREE.Mesh(xpBodyGeometry(), bodyMat)
  body.scale.set(0.95, 0.95, 0.68)
  body.castShadow = true
  group.add(body)

  const headMat = new THREE.MeshStandardMaterial({
    color: '#aeaea9',
    roughness: 0.82,
    metalness: 0,
  })
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.165, 28, 22), headMat)
  head.position.y = 0.74
  head.scale.set(1, 1.02, 0.88)
  head.castShadow = true
  group.add(head)

  // Front-only face photo on a shallow sphere patch
  const faceGeo = new THREE.SphereGeometry(
    0.168,
    24,
    18,
    Math.PI * 0.22,
    Math.PI * 0.56,
    0.4,
    Math.PI * 0.5,
  )
  const faceMat = new THREE.MeshStandardMaterial({
    color: '#d8d8d4',
    roughness: 0.65,
    metalness: 0,
    transparent: true,
    opacity: 0,
  })
  const face = new THREE.Mesh(faceGeo, faceMat)
  face.position.copy(head.position)
  face.scale.copy(head.scale)
  group.add(face)

  let nameSprite = makeNameSprite(name)
  group.add(nameSprite)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.2, 0.26, 28),
    new THREE.MeshBasicMaterial({
      color: '#9a9a94',
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthTest: true,
    }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.01
  group.add(ring)

  const handAnchor = new THREE.Group()
  // Hold cards upright in front of the chest, facing the local player
  handAnchor.position.set(0, 0.48, 0.28)
  handAnchor.rotation.x = -0.12
  group.add(handAnchor)

  let faceTex: THREE.Texture | null = null

  function setFace(dataUrl?: string) {
    if (faceTex) {
      faceTex.dispose()
      faceTex = null
    }
    if (!dataUrl) {
      faceMat.map = null
      faceMat.opacity = 0
      faceMat.needsUpdate = true
      return
    }
    new THREE.TextureLoader().load(dataUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      faceTex = tex
      faceMat.map = tex
      faceMat.opacity = 1
      faceMat.color.set('#ffffff')
      faceMat.needsUpdate = true
    })
  }

  function setName(n: string) {
    group.remove(nameSprite)
    ;(nameSprite.material as THREE.SpriteMaterial).map?.dispose()
    ;(nameSprite.material as THREE.SpriteMaterial).dispose()
    nameSprite = makeNameSprite(n)
    group.add(nameSprite)
  }

  function setHighlight(on: boolean) {
    ;(ring.material as THREE.MeshBasicMaterial).opacity = on ? 0.5 : 0
  }

  function dispose() {
    faceTex?.dispose()
    group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh
        m.geometry.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat.dispose()
      }
      if ((obj as THREE.Sprite).isSprite) {
        const s = obj as THREE.Sprite
        s.material.map?.dispose()
        s.material.dispose()
      }
    })
  }

  if (faceDataUrl) setFace(faceDataUrl)

  return { group, handAnchor, silhouette: body, setFace, setName, setHighlight, dispose }
}
