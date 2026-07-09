import * as THREE from 'three'

export type AvatarHandle = {
  group: THREE.Group
  handAnchor: THREE.Group
  setFace: (dataUrl?: string) => void
  setName: (name: string) => void
  setHighlight: (on: boolean) => void
  dispose: () => void
}

function makeNameSprite(name: string) {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 128
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.fillStyle = 'rgba(42,42,40,0.48)'
  ctx.font = '500 40px "DM Sans", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(0.95, 0.24, 1)
  sprite.position.y = 1.42
  return sprite
}

/** Classic XP account-picture pear silhouette (head + shoulders, fade before feet). */
function xpBodyGeometry() {
  // Profile curve matching the flat XP user glyph: round head, narrow neck, wide soft shoulders
  const pts = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.08, 0.02),
    new THREE.Vector2(0.22, 0.08),
    new THREE.Vector2(0.38, 0.18),
    new THREE.Vector2(0.48, 0.32),
    new THREE.Vector2(0.5, 0.48),
    new THREE.Vector2(0.46, 0.62),
    new THREE.Vector2(0.34, 0.72),
    new THREE.Vector2(0.2, 0.78),
    new THREE.Vector2(0.14, 0.86), // neck
    new THREE.Vector2(0.16, 0.94),
    new THREE.Vector2(0.24, 1.05),
    new THREE.Vector2(0.27, 1.18),
    new THREE.Vector2(0.24, 1.3),
    new THREE.Vector2(0.14, 1.38),
    new THREE.Vector2(0.0, 1.42),
  ]
  const geo = new THREE.LatheGeometry(pts, 48)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const alpha = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const fade = THREE.MathUtils.smoothstep(y, 0.02, 0.38)
    const shade = 0.72 + fade * 0.22
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
 * Windows XP user-account icon as a soft 3D figure:
 * lathed pear body, round head read, dissolves before the feet.
 */
export function createAvatar(name: string, faceDataUrl?: string): AvatarHandle {
  const group = new THREE.Group()
  const gray = '#c8c8c4'

  const bodyMat = new THREE.MeshStandardMaterial({
    color: gray,
    vertexColors: true,
    roughness: 0.92,
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
  body.scale.set(1, 1, 0.72) // flatter front-to-back like the 2D icon
  body.castShadow = true
  group.add(body)

  // Slightly denser head cap so the silhouette reads as the XP glyph
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.27, 36, 28),
    new THREE.MeshStandardMaterial({
      color: '#bcbcb8',
      roughness: 0.85,
      metalness: 0,
    }),
  )
  head.position.y = 1.18
  head.scale.set(1, 1.02, 0.92)
  head.castShadow = true
  group.add(head)

  // Front-only face photo stretch
  const faceGeo = new THREE.SphereGeometry(
    0.275,
    32,
    24,
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
    new THREE.RingGeometry(0.32, 0.38, 32),
    new THREE.MeshBasicMaterial({
      color: '#9a9a94',
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.02
  group.add(ring)

  // Cards held at chest, angled toward table center
  const handAnchor = new THREE.Group()
  handAnchor.position.set(0, 0.72, 0.42)
  handAnchor.rotation.x = -0.35
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
    group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh
        m.geometry.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat.dispose()
      }
    })
    faceTex?.dispose()
  }

  if (faceDataUrl) setFace(faceDataUrl)

  return { group, handAnchor, setFace, setName, setHighlight, dispose }
}
