/**
 * Table, room shell and lighting.
 *
 * Performance stance: exactly one shadow-casting light, with its frustum pulled
 * tight around the table so the 2048² map is spent where it is visible. Fill
 * and rim lights are shadowless. This is the cheapest way to get a dramatic,
 * readable table without paying for multiple shadow passes every frame.
 */

import * as THREE from 'three'
import { TABLE_RADIUS, TABLE_Y } from '../../shared/constants'

export type Environment = {
  root: THREE.Group
  keyLight: THREE.DirectionalLight
  /** Anchors the prompt card and played cards at the table centre. */
  centre: THREE.Group
  update: (dt: number, now: number) => void
}

export function buildEnvironment(scene: THREE.Scene): Environment {
  const root = new THREE.Group()
  scene.add(root)

  scene.background = new THREE.Color('#0a0a10')
  scene.fog = new THREE.Fog('#0a0a10', 3.2, 11)

  // --- Lighting ------------------------------------------------------------

  scene.add(new THREE.HemisphereLight('#8fa2d8', '#12121c', 0.55))

  const keyLight = new THREE.DirectionalLight('#fff2dc', 2.4)
  keyLight.position.set(1.1, 3.2, 1.6)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(2048, 2048)
  keyLight.shadow.camera.near = 0.8
  keyLight.shadow.camera.far = 7
  // Tight frustum: the table plus a seat ring, nothing more.
  keyLight.shadow.camera.left = -1.7
  keyLight.shadow.camera.right = 1.7
  keyLight.shadow.camera.top = 1.7
  keyLight.shadow.camera.bottom = -1.7
  keyLight.shadow.bias = -0.0004
  keyLight.shadow.normalBias = 0.012
  keyLight.shadow.radius = 3
  scene.add(keyLight)
  scene.add(keyLight.target)

  const fill = new THREE.DirectionalLight('#7d8ed0', 0.5)
  fill.position.set(-2.4, 1.4, -1.2)
  scene.add(fill)

  const rim = new THREE.PointLight('#5566ff', 1.1, 6, 2)
  rim.position.set(0, 1.3, -2.0)
  scene.add(rim)

  // Warm pool over the felt — the visual anchor of the room.
  const spot = new THREE.SpotLight('#ffe6bc', 2.2, 4.5, Math.PI / 4.5, 0.55, 1.4)
  spot.position.set(0, 2.3, 0.35)
  spot.target.position.set(0, TABLE_Y, 0)
  root.add(spot)
  root.add(spot.target)

  // --- Table ---------------------------------------------------------------

  const feltMat = new THREE.MeshStandardMaterial({
    color: '#173a2c',
    roughness: 0.92,
    metalness: 0.01,
  })
  const table = new THREE.Mesh(
    new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS + 0.035, 0.055, 72),
    feltMat,
  )
  table.position.y = TABLE_Y - 0.0275
  table.receiveShadow = true
  table.castShadow = true
  root.add(table)

  const rimMesh = new THREE.Mesh(
    new THREE.TorusGeometry(TABLE_RADIUS + 0.018, 0.024, 12, 72),
    new THREE.MeshStandardMaterial({ color: '#3d2712', roughness: 0.5, metalness: 0.1 }),
  )
  rimMesh.rotation.x = -Math.PI / 2
  rimMesh.position.y = TABLE_Y - 0.002
  rimMesh.castShadow = true
  rimMesh.receiveShadow = true
  root.add(rimMesh)

  // Pedestal — cheap, but stops the table reading as a floating disc.
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.26, 0.56, 24),
    new THREE.MeshStandardMaterial({ color: '#241a14', roughness: 0.7 }),
  )
  pedestal.position.y = TABLE_Y - 0.33
  pedestal.castShadow = true
  root.add(pedestal)

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(9, 48),
    new THREE.MeshStandardMaterial({ color: '#08080d', roughness: 1 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = TABLE_Y - 0.62
  floor.receiveShadow = true
  root.add(floor)

  const centre = new THREE.Group()
  centre.position.y = TABLE_Y
  root.add(centre)

  let t = 0
  return {
    root,
    keyLight,
    centre,
    update(dt) {
      t += dt
      // Barely-there light drift keeps the still frame from looking like a render.
      spot.intensity = 2.2 + Math.sin(t * 0.6) * 0.08
    },
  }
}
