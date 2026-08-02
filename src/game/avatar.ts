/**
 * Player avatars.
 *
 * The MSN Character model referenced for this project is marked
 * `isDownloadable: false` on Sketchfab, so it cannot be fetched or vendored
 * programmatically. Rather than silently substituting a different model, this
 * module is built as a drop-in slot:
 *
 *   1. Obtain the .glb (Sketchfab download once the author enables it, or a
 *      direct licence from AzaradSeraphim).
 *   2. Save it to `public/models/msn-character.glb`.
 *   3. It is picked up automatically on next load — no code change.
 *
 * Until then every seat renders the procedural fallback below, so the game is
 * fully playable and the netcode is testable today. The loader is written for
 * the real asset's shape (2.7k tris, static, no rig), which is why it applies
 * idle motion procedurally rather than expecting animation clips.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { dampAngle } from '../spring'

export const AVATAR_MODEL_URL = '/models/msn-character.glb'

/** Seated eye height above the table surface. */
export const EYE_HEIGHT = 0.42

export type Avatar = {
  root: THREE.Group
  /** Node driven by remote head yaw/pitch. */
  head: THREE.Object3D
  setName: (name: string) => void
  setHue: (hue: number) => void
  setSpeaking: (on: boolean) => void
  setConnected: (on: boolean) => void
  setHighlight: (on: boolean) => void
  /** Advance idle motion + smooth head tracking. */
  update: (dt: number, targetYaw: number, targetPitch: number, now: number) => void
  dispose: () => void
}

// ---------------------------------------------------------------------------
// Model loading (cached — one network fetch, N clones)
// ---------------------------------------------------------------------------

let modelPromise: Promise<THREE.Group | null> | null = null

export function preloadAvatarModel(url = AVATAR_MODEL_URL): Promise<THREE.Group | null> {
  if (modelPromise) return modelPromise

  modelPromise = new Promise((resolve) => {
    const loader = new GLTFLoader()
    loader.load(
      url,
      (gltf) => {
        const scene = gltf.scene
        // Normalise: centre on the ground plane and scale to a seated human
        // torso, since we cannot rely on the asset's authored units.
        const box = new THREE.Box3().setFromObject(scene)
        const size = new THREE.Vector3()
        const centre = new THREE.Vector3()
        box.getSize(size)
        box.getCenter(centre)

        const targetHeight = 0.72
        const scale = size.y > 0.001 ? targetHeight / size.y : 1
        scene.scale.setScalar(scale)
        scene.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale)

        scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.castShadow = true
          mesh.receiveShadow = true
          const mat = mesh.material as THREE.MeshStandardMaterial
          if (mat && 'roughness' in mat) mat.roughness = Math.min(1, (mat.roughness ?? 1) * 0.9)
        })

        const wrapper = new THREE.Group()
        wrapper.add(scene)
        resolve(wrapper)
      },
      undefined,
      () => {
        // Absent or unreadable — fall back silently. This is the expected path
        // until the .glb is dropped in.
        console.info(
          `[peril] ${url} not found — using the procedural avatar. ` +
            'Drop the MSN Character .glb there to enable it.',
        )
        resolve(null)
      },
    )
  })

  return modelPromise
}

export function hasAvatarModel(): boolean {
  return loadedTemplate !== null
}

let loadedTemplate: THREE.Group | null = null

export async function initAvatars(url = AVATAR_MODEL_URL) {
  loadedTemplate = await preloadAvatarModel(url)
}

/** Find a head-ish node so remote look-at drives the right bone. */
function findHead(root: THREE.Object3D): THREE.Object3D | null {
  let best: THREE.Object3D | null = null
  root.traverse((o) => {
    if (best) return
    if (/head|neck|skull/i.test(o.name)) best = o
  })
  return best
}

// ---------------------------------------------------------------------------
// Procedural fallback
// ---------------------------------------------------------------------------

const BODY_GEO = (() => {
  // Lathe a simple torso — cheap, smooth, and reads as a person at a table.
  const pts: THREE.Vector2[] = []
  const profile: Array<[number, number]> = [
    [0.0, 0.0],
    [0.13, 0.01],
    [0.19, 0.08],
    [0.22, 0.2],
    [0.21, 0.32],
    [0.17, 0.4],
    [0.1, 0.45],
    [0.055, 0.48],
    [0.0, 0.49],
  ]
  for (const [x, y] of profile) pts.push(new THREE.Vector2(x, y))
  const g = new THREE.LatheGeometry(pts, 24)
  g.computeVertexNormals()
  return g
})()

const HEAD_GEO = new THREE.SphereGeometry(0.115, 24, 18)
const EYE_GEO = new THREE.SphereGeometry(0.016, 10, 8)
const EYE_MAT = new THREE.MeshStandardMaterial({ color: '#14141c', roughness: 0.3 })

function buildFallback(hue: number): { root: THREE.Group; head: THREE.Object3D } {
  const root = new THREE.Group()

  const bodyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(hue / 360, 0.42, 0.46),
    roughness: 0.62,
    metalness: 0.04,
  })
  const body = new THREE.Mesh(BODY_GEO, bodyMat)
  body.castShadow = true
  body.receiveShadow = true
  root.add(body)

  const head = new THREE.Group()
  head.position.y = 0.6
  root.add(head)

  const skull = new THREE.Mesh(
    HEAD_GEO,
    new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(hue / 360, 0.3, 0.72),
      roughness: 0.5,
    }),
  )
  skull.castShadow = true
  head.add(skull)

  // Eyes give the head an unambiguous facing direction, which makes remote
  // head-tracking legible from across the table.
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(EYE_GEO, EYE_MAT)
    eye.position.set(sx * 0.042, 0.018, -0.101)
    head.add(eye)
  }

  return { root, head }
}

// ---------------------------------------------------------------------------
// Name plate
// ---------------------------------------------------------------------------

function makeNamePlate(): {
  sprite: THREE.Sprite
  set: (name: string, dim: boolean) => void
  dispose: () => void
} {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(0.44, 0.11, 1)
  sprite.position.y = 0.87
  sprite.renderOrder = 30

  function set(name: string, dim: boolean) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const label = name.length > 14 ? `${name.slice(0, 13)}…` : name
    ctx.font = '700 52px "Inter", system-ui, sans-serif'
    const w = Math.min(Math.max(ctx.measureText(label).width + 56, 160), canvas.width - 16)
    const h = 74
    const x = (canvas.width - w) / 2
    const y = (canvas.height - h) / 2

    ctx.fillStyle = dim ? 'rgba(18,18,26,0.55)' : 'rgba(18,18,26,0.82)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 37)
    ctx.fill()

    ctx.fillStyle = dim ? 'rgba(240,240,248,0.45)' : '#f4f4f8'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 2)
    texture.needsUpdate = true
  }

  return {
    sprite,
    set,
    dispose: () => {
      texture.dispose()
      material.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAvatar(opts: { name: string; hue: number; seat: number }): Avatar {
  const root = new THREE.Group()
  let head: THREE.Object3D

  if (loadedTemplate) {
    const instance = loadedTemplate.clone(true)
    // Clone materials so per-player tint does not bleed across seats.
    instance.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && mesh.material) {
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => m.clone())
          : (mesh.material as THREE.Material).clone()
      }
    })
    root.add(instance)
    head = findHead(instance) ?? instance
  } else {
    const built = buildFallback(opts.hue)
    root.add(built.root)
    head = built.head
  }

  const plate = makeNamePlate()
  plate.set(opts.name, false)
  root.add(plate.sprite)

  // Soft contact shadow — grounds the avatar without a second shadow-casting light.
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.24, 20),
    new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.22 }),
  )
  blob.rotation.x = -Math.PI / 2
  blob.position.y = 0.004
  root.add(blob)

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.27, 0.012, 8, 40),
    new THREE.MeshBasicMaterial({ color: '#ffd479', transparent: true, opacity: 0 }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.008
  root.add(ring)

  let name = opts.name
  let connected = true
  let highlight = 0
  let highlightTarget = 0
  let speaking = false
  const phase = opts.seat * 1.7 + Math.random() * 3

  const headYaw = { v: 0 }
  const headPitch = { v: 0 }

  return {
    root,
    head,

    setName(next) {
      name = next
      plate.set(name, !connected)
    },

    setHue(hue) {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const mat = mesh.material as THREE.MeshStandardMaterial
        if (mat && mat.color && mesh.name !== 'blob') {
          // Only retint the fallback body; a real model keeps its own texture.
          if (!loadedTemplate) mat.color.setHSL(hue / 360, 0.42, 0.46)
        }
      })
    },

    setSpeaking(on) {
      speaking = on
    },

    setConnected(on) {
      connected = on
      plate.set(name, !on)
      root.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) {
          const mat = mesh.material as THREE.MeshStandardMaterial
          if (mat && 'opacity' in mat) {
            mat.transparent = !on
            mat.opacity = on ? 1 : 0.4
          }
        }
      })
    },

    setHighlight(on) {
      highlightTarget = on ? 1 : 0
    },

    update(dt, targetYaw, targetPitch, now) {
      // Head tracking is damped, not snapped: interpolated network poses still
      // arrive in 50 ms steps and raw application looks robotic.
      headYaw.v = dampAngle(headYaw.v, targetYaw, 12, dt)
      headPitch.v = dampAngle(headPitch.v, THREE.MathUtils.clamp(targetPitch, -0.6, 0.5), 12, dt)
      head.rotation.y = headYaw.v
      head.rotation.x = headPitch.v

      // Idle: breathing plus a slow weight shift. Costs nothing and is the
      // difference between "players" and "statues".
      const t = now * 0.001 + phase
      const breathe = Math.sin(t * 1.15) * 0.006
      const sway = Math.sin(t * 0.42) * 0.012
      root.position.y = breathe
      root.rotation.z = sway * 0.35
      if (speaking) root.position.y += Math.sin(t * 11) * 0.004

      highlight += (highlightTarget - highlight) * (1 - Math.exp(-8 * dt))
      const ringMat = ring.material as THREE.MeshBasicMaterial
      ringMat.opacity = highlight * (0.5 + Math.sin(t * 3) * 0.18)
    },

    dispose() {
      plate.dispose()
      root.removeFromParent()
    },
  }
}
