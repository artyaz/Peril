import * as THREE from 'three'

export type AvatarHandle = {
  group: THREE.Group
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
  ctx.fillStyle = 'rgba(42,42,40,0.55)'
  ctx.font = '500 42px "DM Sans", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(1.1, 0.28, 1)
  sprite.position.y = 1.55
  return sprite
}

/**
 * Windows XP–inspired light-gray figure that fades out toward the feet.
 * Optional face photo is stretched only across the front hemisphere.
 */
export function createAvatar(name: string, faceDataUrl?: string): AvatarHandle {
  const group = new THREE.Group()

  const bodyMat = new THREE.MeshStandardMaterial({
    color: '#c8c8c4',
    roughness: 0.85,
    metalness: 0.0,
    transparent: true,
    opacity: 1,
  })

  // Soft gradient fade via vertex colors on body
  const bodyGeo = new THREE.CapsuleGeometry(0.28, 0.55, 6, 12)
  const colors = new Float32Array(bodyGeo.attributes.position.count * 3)
  for (let i = 0; i < bodyGeo.attributes.position.count; i++) {
    const y = bodyGeo.attributes.position.getY(i)
    const fade = THREE.MathUtils.clamp((y + 0.55) / 1.1, 0, 1)
    const g = 0.55 + fade * 0.35
    colors[i * 3] = g
    colors[i * 3 + 1] = g
    colors[i * 3 + 2] = g * 0.98
  }
  bodyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const body = new THREE.Mesh(
    bodyGeo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
      depthWrite: true,
    }),
  )
  body.position.y = 0.55
  body.castShadow = true
  group.add(body)

  // Soft dissolve toward feet using a second translucent skirt
  const fade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.38, 0.55, 20, 1, true),
    new THREE.MeshStandardMaterial({
      color: '#d2d2ce',
      transparent: true,
      opacity: 0.18,
      roughness: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  fade.position.y = 0.22
  group.add(fade)

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 32, 24),
    bodyMat.clone(),
  )
  head.position.y = 1.18
  head.castShadow = true
  group.add(head)

  // Front-only face stretch: hemisphere mapped with equirect-ish UV projection
  const faceGeo = new THREE.SphereGeometry(0.262, 32, 24, 0, Math.PI, 0, Math.PI)
  const faceMat = new THREE.MeshStandardMaterial({
    color: '#d8d8d4',
    roughness: 0.7,
    metalness: 0,
    transparent: true,
    opacity: 0,
  })
  const face = new THREE.Mesh(faceGeo, faceMat)
  face.position.copy(head.position)
  face.rotation.y = Math.PI // face outward toward table center when avatar looks in
  group.add(face)

  let nameSprite = makeNameSprite(name)
  group.add(nameSprite)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.4, 32),
    new THREE.MeshBasicMaterial({ color: '#9a9a94', transparent: true, opacity: 0, side: THREE.DoubleSide }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.02
  group.add(ring)

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
    const loader = new THREE.TextureLoader()
    loader.load(dataUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace
      // Stretch across front: use ClampToEdge and slight offset
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
    ;(ring.material as THREE.MeshBasicMaterial).opacity = on ? 0.55 : 0
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

  return { group, setFace, setName, setHighlight, dispose }
}
