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
  c.width = 768
  c.height = 192
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
  const label = name.length > 14 ? `${name.slice(0, 13)}…` : name
  ctx.font = '700 64px "DM Sans", system-ui, sans-serif'
  const tw = Math.min(Math.max(ctx.measureText(label).width + 80, 220), c.width - 32)
  const th = 88
  const x = (c.width - tw) / 2
  const y = (c.height - th) / 2
  ctx.fillStyle = 'rgba(42,42,40,0.78)'
  roundPill(ctx, x, y, tw, th, 44)
  ctx.fill()
  ctx.fillStyle = '#fafaf8'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, c.width / 2, c.height / 2 + 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    sizeAttenuation: true,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(0.78, 0.2, 1)
  sprite.position.y = 0.98
  sprite.center.set(0.5, 0.5)
  sprite.renderOrder = 20
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

/** Compact XP pear torso as a lathed mesh — head is a separate sphere. */
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
    new THREE.Vector2(0.11, 0.46),
    new THREE.Vector2(0.07, 0.5), // neck stump
    new THREE.Vector2(0.0, 0.52),
  ]
  const geo = new THREE.LatheGeometry(pts, 40)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const alpha = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const fade = THREE.MathUtils.smoothstep(y, 0.01, 0.22)
    const shade = 0.72 + fade * 0.2
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
  body.scale.set(0.92, 0.92, 0.64)
  body.castShadow = true
  group.add(body)

  const headMat = new THREE.MeshStandardMaterial({
    color: '#b0b0aa',
    roughness: 0.75,
    metalness: 0,
  })
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 32, 24), headMat)
  head.position.y = 0.64
  head.scale.set(1, 1.06, 0.92)
  head.castShadow = true
  group.add(head)

  // Front-only face photo on a shallow sphere patch
  const faceGeo = new THREE.SphereGeometry(
    0.173,
    24,
    18,
    Math.PI * 0.22,
    Math.PI * 0.56,
    0.35,
    Math.PI * 0.55,
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
  nameSprite.position.y = 0.88
  group.add(nameSprite)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.28, 28),
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
  handAnchor.position.set(0, 0.48, 0.2)
  handAnchor.rotation.x = -0.22
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
