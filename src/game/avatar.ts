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
  c.width = 512
  c.height = 128
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.fillStyle = 'rgba(42,42,40,0.55)'
  ctx.font = '600 42px "DM Sans", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(0.85, 0.21, 1)
  sprite.position.y = 2.15
  sprite.renderOrder = 3
  return sprite
}

/** Classic XP user-account silhouette: round head + pear shoulders, fade at feet. */
function paintXpSilhouette(ctx: CanvasRenderingContext2D, w: number, h: number, faceImg?: HTMLImageElement) {
  ctx.clearRect(0, 0, w, h)

  const cx = w / 2
  const bodyGrad = ctx.createLinearGradient(0, h * 0.42, 0, h * 0.98)
  bodyGrad.addColorStop(0, '#b8b8b4')
  bodyGrad.addColorStop(0.55, '#b0b0ac')
  bodyGrad.addColorStop(0.82, 'rgba(168,168,164,0.45)')
  bodyGrad.addColorStop(1, 'rgba(160,160,156,0)')

  ctx.fillStyle = bodyGrad
  ctx.beginPath()
  ctx.moveTo(cx, h * 0.44)
  ctx.bezierCurveTo(w * 0.22, h * 0.46, w * 0.08, h * 0.58, w * 0.06, h * 0.72)
  ctx.bezierCurveTo(w * 0.04, h * 0.86, w * 0.18, h * 0.96, cx, h * 0.98)
  ctx.bezierCurveTo(w * 0.82, h * 0.96, w * 0.96, h * 0.86, w * 0.94, h * 0.72)
  ctx.bezierCurveTo(w * 0.92, h * 0.58, w * 0.78, h * 0.46, cx, h * 0.44)
  ctx.closePath()
  ctx.fill()

  const hr = w * 0.22
  const hy = h * 0.28
  ctx.beginPath()
  ctx.arc(cx, hy, hr, 0, Math.PI * 2)
  ctx.fillStyle = '#aeaea9'
  ctx.fill()

  if (faceImg) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, hy, hr * 0.96, 0, Math.PI * 2)
    ctx.clip()
    const s = hr * 2
    ctx.drawImage(faceImg, cx - s / 2, hy - s / 2, s, s)
    ctx.restore()
  } else {
    const hg = ctx.createRadialGradient(cx - hr * 0.25, hy - hr * 0.3, hr * 0.1, cx, hy, hr)
    hg.addColorStop(0, 'rgba(220,220,216,0.5)')
    hg.addColorStop(1, 'rgba(174,174,169,0)')
    ctx.fillStyle = hg
    ctx.beginPath()
    ctx.arc(cx, hy, hr, 0, Math.PI * 2)
    ctx.fill()
  }
}

function makeXpTexture(faceDataUrl?: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 320
  const ctx = c.getContext('2d')!
  paintXpSilhouette(ctx, c.width, c.height)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true

  if (faceDataUrl) {
    const img = new Image()
    img.onload = () => {
      paintXpSilhouette(ctx, c.width, c.height, img)
      tex.needsUpdate = true
    }
    img.src = faceDataUrl
  }
  return tex
}

/**
 * Windows XP user-account icon as a camera-facing sprite (always readable from
 * hand view and table overview) plus a 3D hand anchor for held cards.
 */
export function createAvatar(name: string, faceDataUrl?: string): AvatarHandle {
  const group = new THREE.Group()

  let silTex = makeXpTexture(faceDataUrl)
  const silMat = new THREE.SpriteMaterial({
    map: silTex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    sizeAttenuation: true,
  })
  const sil = new THREE.Sprite(silMat)
  sil.scale.set(1.85, 2.3, 1)
  sil.position.y = 1.35
  sil.renderOrder = 2
  group.add(sil)

  let nameSprite = makeNameSprite(name)
  group.add(nameSprite)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.36, 32),
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

  // Cards held at chest toward table (group yaw faces center)
  const handAnchor = new THREE.Group()
  handAnchor.position.set(0, 1.15, 0.5)
  handAnchor.rotation.x = -0.55
  group.add(handAnchor)

  function setFace(dataUrl?: string) {
    const next = makeXpTexture(dataUrl)
    silTex.dispose()
    silTex = next
    silMat.map = next
    silMat.needsUpdate = true
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
    silTex.dispose()
    silMat.dispose()
    group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh
        m.geometry.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat.dispose()
      }
      if ((obj as THREE.Sprite).isSprite && obj !== sil) {
        const s = obj as THREE.Sprite
        s.material.map?.dispose()
        s.material.dispose()
      }
    })
  }

  return { group, handAnchor, silhouette: sil, setFace, setName, setHighlight, dispose }
}
