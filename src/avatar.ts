import * as THREE from 'three'

/**
 * avatar.ts — the player figures seated around the table.
 *
 * The look is the old MSN Messenger / Windows-XP buddy icon rebuilt as real
 * geometry: a glass sphere head on a glass bell body, lit from above-front,
 * with a hard darker contour of the same hue tracing the silhouette. That icon
 * is a flat illustration, so a few of its features are painted on here rather
 * than lit for — the white bloom on the crown and the chest are geometry with a
 * soft radial gradient, not specular hits off a light. A real specular moves
 * with the camera and vanishes from three quarters of an orbit; the painted
 * ones are what make the figure recognisable from anywhere, and they cost
 * nothing to keep pointing at the viewer. A fresnel term added on top of the
 * physical glass is the part that does track the camera, so the edges still
 * catch and glow as the table turns.
 *
 * Everything except the tinted materials and the two per-player canvas textures
 * (nickname, face) is built once at module scope and shared. Seating six
 * players allocates six glass materials and six contour materials rather than
 * sixty meshes' worth of buffers — this runs alongside ~60 card meshes, so the
 * geometry has to be shared or the avatars alone would rival the deck.
 *
 * No DOM and no GL context are required to construct an avatar. The nickname
 * and face textures need a canvas, so they degrade to null when there isn't
 * one; the shared blooms and masks are DataTextures built from raw pixels.
 * That keeps the module importable by the headless tests and by an
 * authoritative host that never draws anything.
 */

// --- API ---------------------------------------------------------------------

/**
 * The latest networked target for one player. Seat-relative on purpose.
 *
 * This is NOT net/protocol.ts's AvatarPose. That one is an absolute eye pose
 * (position + yaw + pitch) the room broadcasts so it can derive the card fan
 * server-side. This one is what the *renderer* needs: which seat the figure
 * occupies, a small look-offset from facing the middle, and how far it is
 * leaning in. A caller bridges the two — the seat and a yaw delta are all the
 * figure needs, and keeping it seat-relative means a reconnect or a re-seat is
 * one integer rather than a world transform that has to be recomputed.
 */
export interface AvatarPose {
  /** Seat index around the table. */
  seat: number
  /** Look-offset from facing the table centre, radians. Small; ±0.5 is a lot. */
  yaw: number
  /** How far forward the figure is leaning over the table, 0..1. Optional. */
  lean?: number
}

export interface AvatarOptions {
  id: string
  nickname: string
  /** CSS colour. Defaults to a palette entry chosen from the seat. */
  colour?: string
  /** Drawn onto the front of the head when present; plain glass when not. */
  faceImageUrl?: string
  seat: number
  seatCount: number
}

// --- Proportions -------------------------------------------------------------
//
// Traced off the icon and then scaled to the table. The brief asks for a
// ~0.42m seated figure just outside a 0.62m table, reading as a person sitting
// at it. A card is 63x88mm, so at this height the figure stands about four and
// a half cards tall — roughly a seated person to a card in their hand.

/** Base of the bell to the crown of the head, in metres. */
export const AVATAR_HEIGHT = 0.42
/** Radius of the table top in main.ts. Seating defaults to it. */
export const TABLE_RADIUS = 0.62

const HEAD_R = 0.09
const BODY_R = 0.15
const BODY_H = 0.265
/**
 * Superellipse exponent for the bell wall. At 2.6 the sides leave the base
 * nearly vertically and only turn in over the top third, which is what
 * separates the icon's pawn-like bell from a plain dome or a cone.
 */
const BELL_EXP = 2.6
const BASE_FILLET = 0.017
const HEAD_Y = AVATAR_HEIGHT - HEAD_R

/**
 * How far the figure sits outside the table edge, measured from its centre to
 * the rail. Its own belly must clear the rail, so this is the body radius plus
 * a little, not zero — a figure centred on the rail would have its glass
 * intersecting the felt.
 */
const SEAT_MARGIN = BODY_R + 0.035

/**
 * How far the contour shell stands off the glass. The head's own curvature
 * decides how heavy the line reads; ~2mm on a 180mm head is about the weight of
 * the outline in the icon.
 */
const OUTLINE = 0.0022
/** Just enough to keep the painted highlights off the glass they sit on. */
const GLOSS_LIFT = 0.0009

/** Vertical span of the chest bloom, as absolute heights up the bell. */
const CHEST_FROM = 0.11
const CHEST_TO = 0.245
/** Arc the chest bloom wraps, centred on the front, radians. */
const CHEST_ARC = 1.8

const FACE_ARC = 1.24
/** The face sits under the glass rather than on it, so the shell still glazes it. */
const FACE_INSET = 0.965

const LABEL_HEIGHT = 0.036
const LABEL_LIFT = 0.06

// Restrained on purpose: enough that a table of figures is not frozen, not so
// much that anyone watches them instead of the cards. Together these move the
// crown by a couple of millimetres, under a percent of the figure's height.
const BOB_AMP = 0.0012
const BREATHE_AMP = 0.0022
const BREATHE_RATE = 1.45

/** How far the figure tips in at lean = 1, radians. A nod over the table. */
const LEAN_MAX = 0.32

/**
 * Easing rate for the networked pose, per second. MathUtils.damp treats this as
 * the reciprocal of a time constant, so ~12 settles a step in roughly a tenth
 * of a second — fast enough that a 30Hz update does not read as laggy, slow
 * enough that it eases in rather than snapping.
 */
const POSE_LAMBDA = 12

/**
 * The default palette — the saturated MSN "buddy" hues. Blue, green, orange,
 * pink, purple, cyan: far enough apart to tell six players apart at a glance.
 */
export const AVATAR_COLOURS: string[] = [
  '#3aa0ff', // blue
  '#5fd15f', // green
  '#ff9e2c', // orange
  '#ff5f86', // pink
  '#b579ff', // purple
  '#33d6c4', // cyan
]

/** Palette entry for a seat, wrapping and never falling off the front. */
export function avatarColour(index: number): string {
  const n = AVATAR_COLOURS.length
  return AVATAR_COLOURS[((index % n) + n) % n]
}

// --- Seating -----------------------------------------------------------------

/**
 * World position for a seat: evenly spaced on the circle just outside the rail,
 * on the felt (y = 0). Written into `out` so a caller can place a figure or a
 * fan without allocating.
 *
 * Seat 0 sits on +Z (nearest the default camera), and seats advance clockwise
 * looking down, matching the order the room assigns them. The radius is the
 * table radius plus the figure's own reach past the rail, so the glass never
 * intersects the felt.
 */
export function seatPosition(
  seat: number,
  seatCount: number,
  tableRadius: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const angle = seatAngle(seat, seatCount)
  const r = tableRadius + SEAT_MARGIN
  return out.set(Math.sin(angle) * r, 0, Math.cos(angle) * r)
}

/** The bearing of a seat from the table centre, radians. Seat 0 is +Z. */
function seatAngle(seat: number, seatCount: number): number {
  const n = Math.max(seatCount, 1)
  return (seat / n) * Math.PI * 2
}

// --- Profile -----------------------------------------------------------------

/**
 * The bell, as a lathe profile from the centre of its underside up to the tip.
 * The tip is deliberately left on: it finishes a few mm inside the head, and
 * seeing it faintly through the glass is exactly what the icon shows where the
 * shoulders vanish behind the face.
 */
function bellProfile(): THREE.Vector2[] {
  const pts: THREE.Vector2[] = []
  const flat = BODY_R - BASE_FILLET

  for (let i = 0; i <= 3; i++) pts.push(new THREE.Vector2((i / 3) * flat, 0))
  for (let i = 1; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2)
    pts.push(new THREE.Vector2(flat + Math.sin(a) * BASE_FILLET, BASE_FILLET * (1 - Math.cos(a))))
  }

  const steps = 30
  for (let i = 1; i <= steps; i++) {
    // Bunched towards the top, where the wall turns fastest and a uniform step
    // would facet the shoulder.
    const s = 1 - Math.pow(1 - i / steps, 1.7)
    const y = BASE_FILLET + (BODY_H - BASE_FILLET) * s
    const t = Math.min(y / BODY_H, 1)
    const r = BODY_R * Math.pow(Math.max(1 - Math.pow(t, BELL_EXP), 0), 1 / BELL_EXP)
    pts.push(new THREE.Vector2(r, y))
  }
  return pts
}

/**
 * Push a lathe profile out along its own normal.
 *
 * Uniformly scaling the mesh would be simpler, but it lifts the base off the
 * felt and thins the contour wherever the wall is steep. Offsetting the profile
 * keeps the line the same weight all the way round, including under the skirt.
 */
function offsetProfile(pts: THREE.Vector2[], by: number): THREE.Vector2[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(i - 1, 0)]
    const b = pts[Math.min(i + 1, pts.length - 1)]
    const tx = b.x - a.x
    const ty = b.y - a.y
    const len = Math.hypot(tx, ty) || 1
    // (ty, -tx) is the outward normal for a profile running bottom to top,
    // which is the order LatheGeometry assumes.
    const x = p.x + (ty / len) * by
    const y = p.y - (tx / len) * by
    // A point on the axis must stay on it, or the shell opens a hole at the tip.
    return new THREE.Vector2(p.x === 0 ? 0 : Math.max(x, 0), y)
  })
}

// --- Shared geometry ---------------------------------------------------------

const bellPoints = bellProfile()
const chestPoints = bellPoints.filter((p) => p.y >= CHEST_FROM && p.y <= CHEST_TO)

const bodyGeometry = new THREE.LatheGeometry(bellPoints, 48)
const bodyRimGeometry = new THREE.LatheGeometry(offsetProfile(bellPoints, OUTLINE), 48)
const bodyGlossGeometry = new THREE.LatheGeometry(
  offsetProfile(chestPoints, GLOSS_LIFT),
  24,
  -CHEST_ARC / 2,
  CHEST_ARC,
)

const headGeometry = new THREE.SphereGeometry(HEAD_R, 48, 32)
const headRimGeometry = new THREE.SphereGeometry(HEAD_R + OUTLINE, 40, 26)
// A band across the upper front of the head, between two thirds and nearly all
// the way up as in the icon. Wide in phi so the crown catches it across most of
// an orbit rather than only head-on.
const headGlossGeometry = new THREE.SphereGeometry(
  HEAD_R + GLOSS_LIFT,
  32,
  20,
  Math.PI / 2 - 1.0,
  2.0,
  0.33,
  0.92,
)
// Centred on +Z at the equator: SphereGeometry puts phi = PI/2 on +Z, which is
// the figure's local front — the side it looks toward, i.e. in over the table.
// A player's face is where they look, so the decal belongs here, on the gaze
// side, where the players across the table and an orbiting camera see it.
const faceGeometry = new THREE.SphereGeometry(
  HEAD_R * FACE_INSET,
  28,
  24,
  Math.PI / 2 - FACE_ARC / 2,
  FACE_ARC,
  Math.PI / 2 - FACE_ARC / 2,
  FACE_ARC,
)

/** Billboards are scaled rather than sized, so they all share one plane. */
const unitPlane = new THREE.PlaneGeometry(1, 1)

// --- Shared textures ---------------------------------------------------------

/**
 * A white disc with a soft edge, as raw pixels rather than a canvas so the
 * module still builds its shared resources with no DOM around. `inner`/`outer`
 * are the normalised radii where the alpha starts and finishes falling off.
 */
function radialAlpha(size: number, inner: number, outer: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5
      const dy = (y + 0.5) / size - 0.5
      const d = Math.hypot(dx, dy) * 2
      const t = THREE.MathUtils.clamp((d - inner) / Math.max(outer - inner, 1e-4), 0, 1)
      const i = (y * size + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      // smoothstep, so the disc has no hard ring where it meets the glass.
      data[i + 3] = Math.round((1 - t * t * (3 - 2 * t)) * 255)
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

const glossTexture = radialAlpha(96, 0.04, 0.96)
const faceMaskTexture = radialAlpha(128, 0.74, 0.99)

// --- Shared materials --------------------------------------------------------

/**
 * Additive white for the painted highlights. Additive rather than an opaque
 * white because the bloom has to survive whatever the glass under it is doing,
 * on a black table or a pale one.
 */
const glossMaterial = new THREE.MeshBasicMaterial({
  map: glossTexture,
  color: '#ffffff',
  transparent: true,
  opacity: 0.8,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: true,
})

/** The bloom where the head sinks into the shoulders. Softer than the gloss. */
const neckGlowMaterial = new THREE.MeshBasicMaterial({
  map: glossTexture,
  color: '#ffffff',
  transparent: true,
  opacity: 0.5,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: true,
})

/**
 * Mask a back-face shell down to its silhouette.
 *
 * The usual inverted-hull outline assumes the thing in front of it is opaque.
 * These figures transmit, so an unmasked shell shows straight through the glass
 * and drags the whole avatar towards black. Fading it out wherever the shell
 * faces the camera leaves only the contour, which is the part that was wanted.
 *
 * Defined once and shared by reference on purpose: three keys its program cache
 * on onBeforeCompile.toString(), so every player's contour compiles once.
 */
const RIM_FALLOFF = 0.45

function rimShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader =
    'varying vec3 vRimN;\nvarying vec3 vRimV;\n' +
    shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
        vec4 rimMv = modelViewMatrix * vec4( transformed, 1.0 );
        vRimN = normalize( normalMatrix * normal );
        vRimV = normalize( - rimMv.xyz );`,
    )
  shader.fragmentShader =
    'varying vec3 vRimN;\nvarying vec3 vRimV;\n' +
    shader.fragmentShader.replace(
      '#include <alphamap_fragment>',
      `#include <alphamap_fragment>
        float rimFacing = abs( dot( normalize( vRimN ), normalize( vRimV ) ) );
        diffuseColor.a *= 1.0 - smoothstep( 0.0, ${RIM_FALLOFF.toFixed(2)}, rimFacing );`,
    )
}

/**
 * A view-dependent fresnel glow injected into the physical glass.
 *
 * The painted blooms are fixed to the figure and read the same from anywhere,
 * which is what makes the icon recognisable — but on their own they make the
 * glass look like a printed decal. This adds the part a real glass surface does
 * that a decal cannot: a rim that brightens toward the silhouette and tracks
 * the camera, so an edge that is glancing to the viewer lights up and the same
 * edge dims as the table turns to face it. Emissive-side so it survives the
 * dark felt, and shared by reference for the same one-compile reason as the
 * contour.
 */
function fresnelShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader =
    'varying vec3 vFresN;\nvarying vec3 vFresV;\n' +
    shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
        vec4 fresMv = modelViewMatrix * vec4( transformed, 1.0 );
        vFresN = normalize( normalMatrix * normal );
        vFresV = normalize( - fresMv.xyz );`,
    )
  shader.fragmentShader =
    'varying vec3 vFresN;\nvarying vec3 vFresV;\n' +
    shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
        float fres = 1.0 - abs( dot( normalize( vFresN ), normalize( vFresV ) ) );
        totalEmissiveRadiance += pow( fres, 2.5 ) * 0.9 * diffuseColor.rgb;`,
    )
}

// --- Colour ------------------------------------------------------------------

const _hsl = { h: 0, s: 0, l: 0 }

/** A relative of `base`: same hue, saturation and lightness scaled, capped. */
function shade(base: THREE.Color, s: number, l: number, lCap: number, out: THREE.Color): THREE.Color {
  base.getHSL(_hsl)
  return out.setHSL(_hsl.h, Math.min(_hsl.s * s, 1), Math.min(_hsl.l * l, lCap))
}

// --- Nickname label ----------------------------------------------------------

const LABEL_FONT_PX = 46
const LABEL_PAD_X = 26
const LABEL_PAD_Y = 13
const LABEL_FONT = `600 ${LABEL_FONT_PX}px ui-rounded, "SF Pro Text", -apple-system, "Segoe UI", system-ui, sans-serif`

interface LabelArt {
  texture: THREE.Texture | null
  aspect: number
}

/** Rough width of the pill before it exists, so the plane is sized sanely when
 *  there is no canvas to measure with. */
function estimateAspect(text: string): number {
  return (text.length * LABEL_FONT_PX * 0.52 + LABEL_PAD_X * 2) / (LABEL_FONT_PX + LABEL_PAD_Y * 2)
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/**
 * Render the nickname to a canvas at device resolution.
 *
 * The canvas is sized in *device* pixels — the CSS size times devicePixelRatio
 * — so the text is sampled at the density it will actually be drawn at. Sizing
 * it in CSS pixels and letting the GPU upscale is what makes billboarded labels
 * read fuzzy on a retina display; this keeps the glyph edges crisp. The world
 * size of the plane comes from the CSS aspect, so the higher-DPR texture is
 * denser, not bigger.
 */
function drawLabel(text: string): LabelArt {
  if (typeof document === 'undefined') return { texture: null, aspect: estimateAspect(text) }
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return { texture: null, aspect: estimateAspect(text) }

  const dpr =
    typeof window !== 'undefined' && window.devicePixelRatio ? Math.min(window.devicePixelRatio, 3) : 1

  ctx.font = LABEL_FONT
  const cssW = Math.ceil(ctx.measureText(text).width) + LABEL_PAD_X * 2
  const cssH = LABEL_FONT_PX + LABEL_PAD_Y * 2
  canvas.width = Math.ceil(cssW * dpr)
  canvas.height = Math.ceil(cssH * dpr)

  // Resizing a canvas resets its context, so scale and re-set the font here.
  ctx.scale(dpr, dpr)
  ctx.font = LABEL_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // A dark pill behind the text is what makes it legible over a lit table and
  // over a black one without the text itself having to be loud.
  const inset = 2
  roundedRectPath(ctx, inset, inset, cssW - inset * 2, cssH - inset * 2, cssH / 2 - inset)
  ctx.fillStyle = 'rgba(9,11,18,0.66)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(190,205,255,0.20)'
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.shadowColor = 'rgba(0,0,0,0.8)'
  ctx.shadowBlur = 7
  ctx.fillStyle = '#eef2ff'
  ctx.fillText(text, cssW / 2, cssH / 2 + 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  // Anisotropy would sharpen the label further at grazing angles, but it needs
  // the renderer's capabilities to set correctly, and the module never sees a
  // renderer. Left at the default; the DPR-sized canvas is what matters.
  return { texture, aspect: cssW / cssH }
}

// --- Avatar ------------------------------------------------------------------

/** FNV-1a, so two players are never breathing in step. */
function phaseOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) / 4294967296) * Math.PI * 2
}

const _worldQuat = new THREE.Quaternion()
const _camQuat = new THREE.Quaternion()
const _seatPos = new THREE.Vector3()
const _fanTilt = new THREE.Quaternion()
const _xAxis = new THREE.Vector3(1, 0, 0)

export class Avatar {
  /** Add this to the scene. Its origin is the centre of the figure's base. */
  readonly group: THREE.Group

  readonly id: string

  private readonly figure: THREE.Group
  private readonly face: THREE.Mesh
  private readonly neckGlow: THREE.Mesh
  private readonly labelMesh: THREE.Mesh

  private readonly glass: THREE.MeshPhysicalMaterial
  private readonly rim: THREE.MeshBasicMaterial
  private readonly faceMaterial: THREE.MeshBasicMaterial
  private readonly labelMaterial: THREE.MeshBasicMaterial

  private readonly base = new THREE.Color()

  private nickname: string
  private labelTexture: THREE.Texture | null
  private faceTexture: THREE.Texture | null = null
  private phase: number
  private time = 0

  private readonly seatCount: number
  private readonly tableRadius: number

  // The interpolated pose and the target it is easing toward. Yaw and lean are
  // the only things the network drives per frame; the seat position is fixed
  // once a player sits, so only its bearing (which changes if the seat count
  // changes mid-game) is tracked here.
  private curYaw = 0
  private curLean = 0
  private targetYaw = 0
  private targetLean = 0
  private seat: number

  constructor(opts: AvatarOptions) {
    this.id = opts.id
    this.seat = opts.seat
    this.seatCount = opts.seatCount
    this.tableRadius = TABLE_RADIUS
    this.nickname = opts.nickname
    this.phase = phaseOf(opts.id || opts.nickname)

    this.base.set(opts.colour ?? avatarColour(opts.seat))

    this.group = new THREE.Group()
    this.group.name = `avatar:${opts.id}`

    // Everything that breathes or leans hangs off this; the label does not,
    // because text that drifts a millimetre a second is just hard to read.
    this.figure = new THREE.Group()
    this.figure.name = 'figure'
    this.group.add(this.figure)

    /**
     * One glass material for the whole figure.
     *
     * Transmission alone would make the avatar take its colour from whatever is
     * behind it, which on the near-black felt means a black avatar. Holding it
     * near half and paying for the rest with emissive keeps the figure lit from
     * the inside, so it reads the same over the table, over the floor, and over
     * a pale background. Iridescence adds the faint hue shift toward the edges
     * that a thick blown-glass bead has, which is a good part of why the icon
     * never looked like flat plastic.
     */
    this.glass = new THREE.MeshPhysicalMaterial({
      color: shade(this.base, 0.92, 1.0, 1, new THREE.Color()),
      roughness: 0.13,
      metalness: 0,
      transmission: 0.55,
      thickness: HEAD_R * 2,
      ior: 1.46,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      iridescence: 0.35,
      iridescenceIOR: 1.3,
      attenuationColor: shade(this.base, 1.0, 0.55, 1, new THREE.Color()),
      attenuationDistance: 0.2,
      emissive: shade(this.base, 0.55, 1.6, 0.86, new THREE.Color()),
      emissiveIntensity: 0.35,
      envMapIntensity: 1.1,
      // The figure is built from overlapping translucent shells whose order is
      // fixed by renderOrder. Writing depth would make the head occlude its own
      // face and the glass occlude its own highlights. Depth *testing* stays
      // on, so cards and the table still hide the parts they should.
      depthWrite: false,
    })
    this.glass.onBeforeCompile = fresnelShader

    this.rim = new THREE.MeshBasicMaterial({
      color: shade(this.base, 1.1, 0.3, 1, new THREE.Color()),
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      toneMapped: true,
    })
    this.rim.onBeforeCompile = rimShader

    this.faceMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      alphaMap: faceMaskTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: true,
    })

    const label = drawLabel(this.nickname)
    this.labelTexture = label.texture
    this.labelMaterial = new THREE.MeshBasicMaterial({
      map: label.texture,
      transparent: true,
      depthWrite: false,
      // The pill is already drawn at the contrast it wants to be read at. Tone
      // mapping it alongside the table would crush the backing toward the felt.
      toneMapped: false,
    })

    // Draw order, first drawn first: body glass, head glass over it, the face
    // under the glaze, the painted blooms, then the contour last so the line
    // stays crisp instead of being washed out by the glass drawn over it.
    const body = this.mesh('body', bodyGeometry, this.glass, 1)
    const head = this.mesh('head', headGeometry, this.glass, 2)
    head.position.y = HEAD_Y

    this.face = this.mesh('face', faceGeometry, this.faceMaterial, 3)
    this.face.position.y = HEAD_Y
    this.face.visible = false

    const bodyGloss = this.mesh('bodyGloss', bodyGlossGeometry, glossMaterial, 4)
    const headGloss = this.mesh('headGloss', headGlossGeometry, glossMaterial, 4)
    headGloss.position.y = HEAD_Y

    this.neckGlow = this.mesh('neckGlow', unitPlane, neckGlowMaterial, 5)
    this.neckGlow.position.y = BODY_H * 0.92
    this.neckGlow.scale.set(0.11, 0.075, 1)

    const bodyRim = this.mesh('bodyRim', bodyRimGeometry, this.rim, 6)
    const headRim = this.mesh('headRim', headRimGeometry, this.rim, 6)
    headRim.position.y = HEAD_Y

    this.figure.add(body, head, this.face, bodyGloss, headGloss, this.neckGlow, bodyRim, headRim)

    this.labelMesh = this.mesh('label', unitPlane, this.labelMaterial, 7)
    this.labelMesh.position.y = AVATAR_HEIGHT + LABEL_LIFT
    this.labelMesh.scale.set(LABEL_HEIGHT * label.aspect, LABEL_HEIGHT, 1)
    // An unmapped MeshBasicMaterial is a solid white rectangle, so the plane
    // stays hidden until there is genuinely something written on it.
    this.labelMesh.visible = this.nickname.length > 0 && label.texture !== null
    this.group.add(this.labelMesh)

    // Seat it and snap the interpolated pose to the target, so the first frame
    // is not an ease-in from zero.
    this.placeAtSeat()
    if (opts.faceImageUrl) this.setFaceImage(opts.faceImageUrl)
  }

  private mesh(
    name: string,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    order: number,
  ): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat)
    m.name = name
    m.renderOrder = order
    return m
  }

  /** Put the group on its seat, facing the table centre, base on the felt. */
  private placeAtSeat(): void {
    seatPosition(this.seat, this.seatCount, this.tableRadius, _seatPos)
    this.group.position.copy(_seatPos)
    // Local +Z is the front, matching the card convention. A seat on +Z must
    // turn to face -Z (the centre), so the base facing is its bearing plus half
    // a turn; the networked yaw is a look-offset on top of that.
    this.group.rotation.set(0, seatAngle(this.seat, this.seatCount) + Math.PI + this.curYaw, 0)
  }

  /**
   * The latest networked pose. update() eases toward it rather than snapping,
   * so the ~30Hz stream reads as continuous motion. Re-seating is allowed —
   * moving a player to a new seat updates where update() eases the figure to.
   */
  setPose(pose: AvatarPose): void {
    if (pose.seat !== this.seat) {
      this.seat = pose.seat
      // The seat is a hard cut, not an ease: a player does not slide around the
      // rail to a new chair. Only yaw and lean interpolate.
      this.placeAtSeat()
    }
    this.targetYaw = pose.yaw
    this.targetLean = pose.lean ?? 0
  }

  setNickname(name: string): void {
    this.nickname = name
    this.phase = phaseOf(this.id || name)
    if (this.labelTexture) this.labelTexture.dispose()
    const next = drawLabel(name)
    this.labelTexture = next.texture
    this.labelMaterial.map = next.texture
    this.labelMaterial.needsUpdate = true
    this.labelMesh.scale.set(LABEL_HEIGHT * next.aspect, LABEL_HEIGHT, 1)
    this.labelMesh.visible = name.length > 0 && next.texture !== null
  }

  /**
   * Set or clear the face decal. Loading is asynchronous: the texture is
   * attached and the disc shown as soon as the image decodes, so a slow URL
   * never blocks a frame and a null clears it immediately. No DOM / no loader
   * means the call is a no-op beyond clearing, which is what the headless host
   * wants.
   */
  setFaceImage(url: string | null): void {
    if (this.faceTexture) {
      this.faceTexture.dispose()
      this.faceTexture = null
    }
    if (!url) {
      this.faceMaterial.map = null
      this.faceMaterial.needsUpdate = true
      this.face.visible = false
      return
    }
    if (typeof document === 'undefined') return

    const tex = new THREE.TextureLoader().load(url, () => {
      // The disc only appears once the pixels are in, so a half-loaded texture
      // never flashes as a grey patch on the head.
      this.faceMaterial.needsUpdate = true
      this.face.visible = true
    })
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    this.faceTexture = tex
    this.faceMaterial.map = tex
    this.faceMaterial.needsUpdate = true
  }

  /**
   * World transform where this player's card fan should be drawn: in front of
   * the chest, tipped up to face the player, above the felt. The avatar renders
   * no cards itself — this is only where the caller should place the fan it
   * owns. Written into the out-params so the caller never allocates.
   *
   * The anchor rides the figure's lean, so a player leaning in brings their fan
   * with them, but it is read off the figure's *current* eased transform rather
   * than the target, so the fan and the figure never disagree for a frame.
   */
  fanAnchor(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    this.figure.updateWorldMatrix(true, false)
    // A point out in front of the chest and a little below the head. In the
    // figure's local frame that is +Z, at chest height.
    outPos.set(0, BODY_H * 0.78, BODY_R + 0.09)
    outPos.applyMatrix4(this.figure.matrixWorld)
    // The card faces have to turn back and up toward the player who holds them:
    // the figure looks in over the table, so the fan sits between it and the
    // centre, tipped so its faces angle up and back out toward the seat rather
    // than lying flat or presenting to the middle. A -2pi/3 tilt about the
    // figure's local +X does exactly that once the figure's own inward-facing
    // yaw is applied — the resulting card normal points up and outward, at the
    // player's eyeline.
    this.figure.getWorldQuaternion(outQuat)
    _fanTilt.setFromAxisAngle(_xAxis, -(2 * Math.PI) / 3)
    outQuat.multiply(_fanTilt)
  }

  /**
   * Ease toward the networked pose, run the idle motion, and billboard the
   * label and neck glow. Call once per frame. `dt` is real seconds; the easing
   * is frame-rate independent, so it behaves the same at 30 and 144 fps.
   */
  update(dt: number, camera: THREE.Camera): void {
    this.time += dt

    // Exponential ease toward the target. damp() is the frame-rate-independent
    // form: the figure covers the same fraction of the remaining gap per unit
    // time regardless of how the frames fall, so a stutter does not lurch it.
    this.curYaw = THREE.MathUtils.damp(this.curYaw, this.targetYaw, POSE_LAMBDA, dt)
    this.curLean = THREE.MathUtils.damp(this.curLean, this.targetLean, POSE_LAMBDA, dt)

    const breathe = Math.sin(this.time * BREATHE_RATE + this.phase)
    // The bob only ever lifts. A symmetric one puts the skirt a millimetre into
    // the felt for half of every cycle, far more visible than the same
    // millimetre of hover. The scale breathes about the base, so it raises the
    // crown without moving the figure off the table at all.
    this.figure.position.y = (breathe * 0.5 + 0.5) * BOB_AMP
    this.figure.scale.setScalar(1 + breathe * BREATHE_AMP)
    // Lean tips the whole figure forward from its base. The rotation is on the
    // figure, not the group, so the label above stays upright.
    this.figure.rotation.set(this.curLean * LEAN_MAX, 0, 0)

    // The look-offset yaw is on the group, so the figure faces where the player
    // is looking and the fan anchor and label follow.
    this.group.rotation.y = seatAngle(this.seat, this.seatCount) + Math.PI + this.curYaw

    // Match the camera's orientation rather than aiming at it: a screen-aligned
    // label stays rectangular, where one that turns to point at the camera
    // shears as it passes overhead. Both billboards hang off group-space (the
    // label off the group, the glow off the figure), so cancel each parent's
    // world rotation against the camera's.
    camera.getWorldQuaternion(_camQuat)

    this.group.getWorldQuaternion(_worldQuat)
    this.labelMesh.quaternion.copy(_worldQuat.invert().multiply(_camQuat))

    this.neckGlow.parent!.getWorldQuaternion(_worldQuat)
    this.neckGlow.quaternion.copy(_worldQuat.invert().multiply(_camQuat))
  }

  /** Frees this player's materials and textures. Shared resources survive. */
  dispose(): void {
    this.glass.dispose()
    this.rim.dispose()
    this.faceMaterial.dispose()
    this.labelMaterial.dispose()
    if (this.labelTexture) this.labelTexture.dispose()
    if (this.faceTexture) this.faceTexture.dispose()
    this.group.removeFromParent()
  }
}

/**
 * Release the geometry and textures every avatar shares. Only for tearing the
 * whole scene down — calling it while any avatar is still on screen leaves that
 * avatar with freed buffers.
 */
export function disposeSharedAvatarResources(): void {
  for (const g of [
    bodyGeometry,
    bodyRimGeometry,
    bodyGlossGeometry,
    headGeometry,
    headRimGeometry,
    headGlossGeometry,
    faceGeometry,
    unitPlane,
  ]) {
    g.dispose()
  }
  glossTexture.dispose()
  faceMaskTexture.dispose()
  glossMaterial.dispose()
  neckGlowMaterial.dispose()
}
