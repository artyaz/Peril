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
  ctx.fillStyle = 'rgba(42,42,40,0.5)'
  ctx.font = '500 40px "DM Sans", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(0.9, 0.22, 1)
  sprite.position.y = 1.55
  return sprite
}

/** Classic XP account-picture silhouette: round head + pear shoulders, fade at feet. */
function xpSilhouetteTexture(faceDataUrl?: string): Promise<THREE.CanvasTexture> {
  return new Promise((resolve) => {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 320
    const ctx = c.getContext('2d')!

    const paint = (faceImg?: HTMLImageElement) => {
      ctx.clearRect(0, 0, c.width, c.height)

      const g = ctx.createLinearGradient(0, 40, 0, 310)
      g.addColorStop(0, 'rgba(176,176,172,1)')
      g.addColorStop(0.5, 'rgba(168,168,164,0.98)')
      g.addColorStop(0.78, 'rgba(158,158,154,0.45)')
      g.addColorStop(1, 'rgba(150,150,146,0)')

      // Shoulders / torso pear
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(128, 148)
      ctx.bezierCurveTo(68, 152, 32, 188, 26, 232)
      ctx.bezierCurveTo(22, 268, 42, 305, 128, 314)
      ctx.bezierCurveTo(214, 305, 234, 268, 230, 232)
      ctx.bezierCurveTo(224, 188, 188, 152, 128, 148)
      ctx.closePath()
      ctx.fill()

      // Head
      ctx.beginPath()
      ctx.arc(128, 96, 60, 0, Math.PI * 2)
      ctx.fillStyle = '#b0b0ac'
      ctx.fill()

      if (faceImg) {
        ctx.save()
        ctx.beginPath()
        ctx.arc(128, 96, 58, 0, Math.PI * 2)
        ctx.clip()
        // Stretch face across the head circle (XP-style)
        ctx.drawImage(faceImg, 70, 38, 116, 116)
        ctx.restore()
      } else {
        const hg = ctx.createRadialGradient(112, 78, 6, 128, 96, 60)
        hg.addColorStop(0, 'rgba(205,205,201,0.4)')
        hg.addColorStop(1, 'rgba(176,176,172,0)')
        ctx.fillStyle = hg
        ctx.beginPath()
        ctx.arc(128, 96, 60, 0, Math.PI * 2)
        ctx.fill()
      }

      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.needsUpdate = true
      resolve(tex)
    }

    if (faceDataUrl) {
      const img = new Image()
      img.onload = () => paint(img)
      img.onerror = () => paint()
      img.src = faceDataUrl
    } else {
      paint()
    }
  })
}

/**
 * Windows XP user-account icon: camera-facing soft silhouette (not a cylinder+ball).
 * Cards attach to a 3D hand anchor that faces the table.
 */
export function createAvatar(name: string, faceDataUrl?: string): AvatarHandle {
  const group = new THREE.Group()

  const silMat = new THREE.SpriteMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
  })
  const sil = new THREE.Sprite(silMat)
  sil.scale.set(1.05, 1.3, 1)
  sil.position.y = 0.78
  group.add(sil)

  let silTex: THREE.Texture | null = null
  void xpSilhouetteTexture(faceDataUrl).then((tex) => {
    silTex = tex
    silMat.map = tex
    silMat.needsUpdate = true
  })

  let nameSprite = makeNameSprite(name)
  group.add(nameSprite)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.34, 32),
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

  // Cards held at chest, toward table center (group yaw handles facing)
  const handAnchor = new THREE.Group()
  handAnchor.position.set(0, 0.72, 0.32)
  handAnchor.rotation.x = -0.45
  group.add(handAnchor)

  function setFace(dataUrl?: string) {
    void xpSilhouetteTexture(dataUrl).then((tex) => {
      silTex?.dispose()
      silTex = tex
      silMat.map = tex
      silMat.needsUpdate = true
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
    silTex?.dispose()
    silMat.dispose()
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

  return { group, handAnchor, setFace, setName, setHighlight, dispose }
}
