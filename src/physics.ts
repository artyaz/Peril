/**
 * physics.ts — a small, deterministic rigid-body solver tuned specifically for
 * playing cards.
 *
 * Why hand-rolled instead of a general engine:
 *   - Cards are extremely thin flat boxes. That is the pathological case for
 *     generic convex solvers (jitter, sinking, CCD tuning). Sampling the eight
 *     OBB corners as contact points is both cheaper and *more* stable here: a
 *     card resting flat produces four coplanar contacts, which is a naturally
 *     rigid support polygon.
 *   - No dependency on the renderer, so this module runs headless in Node. That
 *     makes it unit-testable and lets an authoritative host run the exact same
 *     simulation for networked play.
 *   - Determinism: pure float64 IEEE-754 with a fixed operation order and a
 *     fixed timestep. Same inputs -> bit-identical outputs on every client.
 *
 * Units are SI. A real playing card is ~63x88mm and ~2g, and those real values
 * are used directly, so gravity and drag behave at true scale.
 */

// ---------------------------------------------------------------------------
// Minimal math. Plain objects + out-params, so the hot loop never allocates.
// ---------------------------------------------------------------------------

export interface V3 {
  x: number
  y: number
  z: number
}
export interface Q4 {
  x: number
  y: number
  z: number
  w: number
}

export function v3(x = 0, y = 0, z = 0): V3 {
  return { x, y, z }
}
export function q4(x = 0, y = 0, z = 0, w = 1): Q4 {
  return { x, y, z, w }
}

function vset(o: V3, x: number, y: number, z: number): V3 {
  o.x = x
  o.y = y
  o.z = z
  return o
}
function vcopy(o: V3, a: V3): V3 {
  o.x = a.x
  o.y = a.y
  o.z = a.z
  return o
}
function vaddScaled(o: V3, a: V3, s: number): V3 {
  o.x += a.x * s
  o.y += a.y * s
  o.z += a.z * s
  return o
}
function vdot(a: V3, b: V3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}
function vcross(o: V3, a: V3, b: V3): V3 {
  const x = a.y * b.z - a.z * b.y
  const y = a.z * b.x - a.x * b.z
  const z = a.x * b.y - a.y * b.x
  o.x = x
  o.y = y
  o.z = z
  return o
}
function vlen(a: V3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}
function vlen2(a: V3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z
}

/** Rotate `v` by quaternion `q`. */
function qRot(o: V3, q: Q4, v: V3): V3 {
  const { x, y, z, w } = q
  const tx = 2 * (y * v.z - z * v.y)
  const ty = 2 * (z * v.x - x * v.z)
  const tz = 2 * (x * v.y - y * v.x)
  const ox = v.x + w * tx + (y * tz - z * ty)
  const oy = v.y + w * ty + (z * tx - x * tz)
  const oz = v.z + w * tz + (x * ty - y * tx)
  o.x = ox
  o.y = oy
  o.z = oz
  return o
}

/** Rotate `v` by the conjugate of `q` (i.e. world -> local). */
function qRotInv(o: V3, q: Q4, v: V3): V3 {
  const x = -q.x
  const y = -q.y
  const z = -q.z
  const w = q.w
  const tx = 2 * (y * v.z - z * v.y)
  const ty = 2 * (z * v.x - x * v.z)
  const tz = 2 * (x * v.y - y * v.x)
  const ox = v.x + w * tx + (y * tz - z * ty)
  const oy = v.y + w * ty + (z * tx - x * tz)
  const oz = v.z + w * tz + (x * ty - y * tx)
  o.x = ox
  o.y = oy
  o.z = oz
  return o
}

function qNormalize(q: Q4): Q4 {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
  if (l > 1e-12) {
    const inv = 1 / l
    q.x *= inv
    q.y *= inv
    q.z *= inv
    q.w *= inv
  } else {
    q.x = 0
    q.y = 0
    q.z = 0
    q.w = 1
  }
  return q
}

/** Integrate orientation by angular velocity `w` (world space) over `dt`. */
function qIntegrate(q: Q4, w: V3, dt: number): void {
  const hx = w.x * dt * 0.5
  const hy = w.y * dt * 0.5
  const hz = w.z * dt * 0.5
  const { x, y, z, w: qw } = q
  q.x += hx * qw + hy * z - hz * y
  q.y += hy * qw + hz * x - hx * z
  q.z += hz * qw + hx * y - hy * x
  q.w += -(hx * x + hy * y + hz * z)
  qNormalize(q)
}

/** Shortest-arc quaternion slerp, used only for render interpolation. */
export function qSlerp(o: Q4, a: Q4, b: Q4, t: number): Q4 {
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw
  if (cos < 0) {
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    cos = -cos
  }
  if (cos > 0.9995) {
    o.x = a.x + (bx - a.x) * t
    o.y = a.y + (by - a.y) * t
    o.z = a.z + (bz - a.z) * t
    o.w = a.w + (bw - a.w) * t
    return qNormalize(o)
  }
  const theta = Math.acos(cos)
  const sin = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / sin
  const wb = Math.sin(t * theta) / sin
  o.x = a.x * wa + bx * wb
  o.y = a.y * wa + by * wb
  o.z = a.z * wa + bz * wb
  o.w = a.w * wa + bw * wb
  return o
}

// ---------------------------------------------------------------------------
// Tunables. Every "feel" knob lives here so the game can be tuned in one place.
// ---------------------------------------------------------------------------

export const TUNING = {
  /** Fixed physics timestep. 240Hz keeps 2mm-thick bodies from tunnelling. */
  fixedDt: 1 / 240,
  /** Upper bound on substeps per rendered frame, so a stall can't death-spiral. */
  maxSubsteps: 12,

  gravity: -9.81,

  /**
   * Contact solver iterations — a floor, not a fixed count. See
   * `iterationsPerAwakeBody`.
   */
  velocityIterations: 8,
  /**
   * Extra velocity iterations per awake body, and the ceiling on them.
   *
   * Left at zero. Gauss-Seidel does need roughly as many sweeps as a stack is
   * tall to carry support to the top, and before the warm-start cache was fixed
   * this mattered enormously — 24 cards needed 32 iterations to stand up at all.
   * With warm starting actually persisting, the accumulated impulses carry that
   * load across substeps instead, and 24 cards hold at the base 8. Scaling the
   * count up now buys nothing and costs a great deal: a table of 52 loose cards
   * goes from 9ms a frame to 38ms for no improvement in how they settle.
   */
  iterationsPerAwakeBody: 0,
  maxVelocityIterations: 8,
  /** Overlap-resolution passes, run on the pseudo-velocity channel. */
  positionIterations: 6,
  /**
   * Solve contacts lowest-first, alternating direction between iterations.
   *
   * Gauss-Seidel propagates support one contact per sweep, so in an unordered
   * pass a tall stack needs about as many iterations as it has cards and
   * otherwise settles compressed — a 52-card deck stands at a fifth of its
   * height. Sweeping up from the table carries the support all the way in a
   * single iteration, and reversing on alternate iterations keeps the result
   * symmetric rather than biased towards the bottom.
   *
   * An earlier attempt pinned the lower body of each contact instead (shock
   * propagation). It made things markedly worse: shifting positions every
   * substep changed the contact set, which expired the warm-start impulses that
   * were doing most of the work holding the stack up.
   */
  sortContacts: true,
  /**
   * Sweep contacts lowest-first, and only ever in that direction.
   *
   * Alternating the sweep is the textbook way to keep Gauss-Seidel unbiased, and
   * here it is actively destructive: each downward pass unwinds the support the
   * upward pass just propagated. Same iteration count, 31% of stack height
   * against 99%.
   */
  sweepAlternate: false,
  /**
   * Bottom-up passes that pin the supporting card and lift only what rests on
   * it.
   *
   * Symmetric position correction cannot expand a compressed stack: an interior
   * card is pushed up by the contact below and down by the contact above in
   * equal measure, so the two cancel and only the topmost card can move. The
   * overlap therefore never comes out, and a deck that briefly compresses stays
   * compressed. Pinning the lower body breaks the symmetry so the expansion
   * propagates all the way up in one sweep. Confined to the pseudo-velocity
   * channel, so it removes overlap without touching momentum.
   *
   * Exactly one sweep. Each pass compounds the correction up the stack, and at
   * three or more a 52-card deck detonates.
   */
  shockIterations: 1,
  /**
   * Fraction of the previous substep's impulse re-applied as the initial guess.
   *
   * Full strength. Warm starting is not an optimisation here, it is the entire
   * mechanism holding a tall stack up: the impulse at the bottom of a 52-card
   * deck has to carry the weight of everything above it, and no realistic
   * iteration count rebuilds that from zero each substep. Re-applying even 92%
   * bleeds support faster than the solver can replace it, and the deck sinks
   * into itself. Safety comes from clamping the accumulated impulse to be
   * non-negative and re-solving every substep, not from damping it.
   */
  warmStartScale: 1.0,

  /** Position bias, applied only through the pseudo channel so it adds no
   *  energy. Can therefore be far stiffer than a classic Baumgarte term. */
  contactBias: 0.9,
  /**
   * Overlap tolerated before correction kicks in, as a fraction of the thinner
   * body's half-thickness rather than an absolute distance.
   *
   * Every length in this solver has to scale with the cards, or the tuning
   * silently inverts when they get thinner. At 0.3mm a fixed 40um slop is 13%
   * of a card, and cards visibly sink into one another.
   */
  slopFraction: 0.02,
  /** Cap on de-penetration velocity so deep overlap doesn't explode. */
  maxCorrectionSpeed: 0.9,

  /**
   * Speculative detection shell: contacts appear this far before touching, so a
   * fast card is braked onto the surface instead of skipping past it.
   *
   * `specMargin` is the floor, applied to every pair. `specSpeedMargin` adds the
   * distance the pair will actually close before the next substep.
   *
   * Both halves are load-bearing, and an earlier version got each wrong in turn.
   * A shell that scales purely with closing speed collapses to nothing at rest,
   * so the contact set flickers, warm-start impulses expire, and stacks bounce
   * forever. A large constant shell instead is worse still at card thicknesses:
   * at 0.3mm every card in a deck falls inside the shell of forty others, and
   * five thousand mostly spurious constraints stop Gauss-Seidel converging — a
   * struck deck folded to a tenth of its height at 27ms a frame. And a small
   * constant shell simply lets a dropped card tunnel straight through the deck,
   * since at 2m/s a card crosses 8mm in one substep.
   *
   * A constant floor plus a speed term gives all three: resting pairs get a
   * fixed, flicker-free shell; only the handful of genuinely fast pairs pay for
   * a wide one; and nothing tunnels.
   */
  specMargin: 0.004,
  specSpeedMargin: 1.3,
  /** Fraction of the remaining gap a pair may close in one substep. */
  specApproach: 0.5,
  /**
   * How near to parallel two cards must be before their overlap is treated as a
   * face contact. cos(53deg): deliberately generous.
   *
   * A tight threshold looks safer and is not. A card landing even slightly
   * off-centre on a deck tilts as it settles, drops out of the face-manifold
   * path, and is resolved by raw corner penetration instead — which, wedged
   * among 52 near-coincident bodies, happily squeezes it down between them. Any
   * two overlapping plates at a plausible resting angle should separate through
   * their faces.
   */
  faceManifoldCos: 0.6,

  /** Cards barely bounce; below this approach speed they don't bounce at all. */
  restitution: 0.08,
  restitutionThreshold: 0.28,

  frictionCardTable: 0.62,
  frictionCardCard: 0.34,

  linearDamping: 0.12,
  angularDamping: 0.65,
  /** Below this speed, damping is increased sharply to mimic static friction. */
  restSpeed: 0.05,
  restDamping: 7.0,

  /** Air density * drag coefficient, folded together. Drives the flutter. */
  aeroPressure: 1.2 * 1.15,
  /** How far the centre of pressure sits ahead of the CoM, as a fraction of
   *  the card's half-length. This offset is what makes a card tumble. */
  aeroCopFraction: 0.24,

  maxLinearSpeed: 7.5,
  maxAngularSpeed: 42,

  /** Sleep thresholds: below these for `sleepDelay` seconds and we freeze. */
  sleepLinear: 0.022,
  sleepAngular: 0.28,
  /**
   * Wake thresholds, deliberately well above the sleep ones.
   *
   * Without this hysteresis, waking is contagious: a card landing on a deck
   * nudges the top card, which stirs enough to wake the one beneath, and the
   * cascade unfreezes all 52 within a few substeps. They then all fall at once
   * and the deck folds up, because no realistic iteration count can propagate
   * support through a stack that tall from a cold start. A sleeping body acts as
   * infinite mass, so leaving the bulk of the deck asleep is not merely cheaper,
   * it is what makes it behave like a solid object.
   */
  wakeLinear: 0.16,
  wakeAngular: 1.6,
  /**
   * How many neighbours out a wake may spread from whatever caused it.
   *
   * Waking is contagious, and in a deck that is ruinous: lift one card off the
   * top and the card beneath is briefly unsupported, wakes its own neighbour,
   * and within a few substeps all 52 are awake. A stack that tall cannot hold
   * itself up — the impulse at the bottom has to carry fifty cards and no
   * practical iteration count rebuilds that in time — so it folds, and the
   * contact count explodes as every card starts overlapping several others.
   * The visible collapse and the frame-rate crash are the same event.
   *
   * A sleeping body is infinite mass, so capping how far the wake travels is
   * what keeps the untouched remainder of the deck acting as the rigid
   * foundation it ought to be. Direct disturbance — the player's hand, or an
   * impact — always starts at zero, so this limits the ripple, not the cause.
   */
  maxWakeDepth: 2,
  /**
   * Above this speed an impact disturbs a settled stack regardless.
   *
   * Set above `maxThrowSpeed` on purpose, so nothing a player can throw will
   * shatter a settled deck from above — it lands on top instead, which is both
   * what a real deck does and the only behaviour this solver can hold. A
   * 52-card stack that is awake all at once cannot support itself: the impulse
   * at the bottom has to carry fifty cards' weight, and no practical iteration
   * count rebuilds that before gravity has already folded the stack. Leaving it
   * asleep, and therefore infinitely rigid, is the mechanism that makes a deck a
   * solid object. Lateral shoves and the player's own hand still disturb it.
   */
  wakeImpactSpeed: 6.5,
  sleepDelay: 0.32,
  /** How close counts as "touching" when grouping bodies into sleep islands,
   *  in multiples of half-thickness, with a floor for very thin cards. */
  islandTouchFraction: 0.8,
  islandTouchFloor: 0.0003,
  /** Below this centre separation — as a fraction of half-thickness — two cards
   *  count as coincident, and the push-out direction has to be decided by a
   *  stable tie-break instead. */
  coincidentFraction: 0.15,
  /** How much shallower an in-plane overlap must be before it is preferred over
   *  the face normal, as a fraction of half-thickness. Breaks the exact ties
   *  that flat overlapping cards create, while staying small enough to keep
   *  true edge contacts correct. */
  faceBiasFraction: 0.3,

  /** Grab drive. `grabStrength` is the fraction of the velocity error removed
   *  per substep; `grabMaxSpeed` clamps how fast the hand can pull. */
  grabStrength: 0.34,
  /**
   * How fast the grab may haul a card.
   *
   * This is a collision setting as much as a feel one. At 6 m/s a card pulled
   * out of a deck is a battering ram: it ploughs through the cards around it,
   * and because the speculative shell widens with speed it also carries a 36mm
   * detection halo — deeper than the whole deck — so it churns against every
   * card at once. Pulling one card from the middle woke all 52, folded the deck
   * to an eighth of its height and cost 72ms a frame. At 3 m/s the same pull
   * disturbs five cards, leaves the deck at full height, and costs 9ms. Still
   * quicker than any real hand moves a card.
   */
  grabMaxSpeed: 3.0,
  /** Angular bleed while held: settles the dangle without killing flick spin. */
  grabAngularDamping: 4.5,
  /** Release velocity is scaled by this. >1 makes throws feel snappier. */
  throwGain: 1.0,
  maxThrowSpeed: 5.5,
}

export const BodyMode = {
  /** Fully simulated. */
  Dynamic: 0,
  /** Simulated, plus a grab constraint pulling a pinch point to a target. */
  Grabbed: 1,
  /** Transform driven externally (a card in hand). Skipped by the solver. */
  Held: 2,
} as const
export type BodyModeValue = (typeof BodyMode)[keyof typeof BodyMode]

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

const LOCAL_CORNER_SIGNS: Array<[number, number, number]> = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
]

export class Body {
  id: number
  mode: BodyModeValue = BodyMode.Dynamic

  /** Half-extents in local space: x = width/2, y = height/2, z = thickness/2. */
  half: V3
  /** Distance from centre to a corner. Used for the broadphase. */
  boundRadius: number

  p: V3 = v3()
  q: Q4 = q4()
  v: V3 = v3()
  w: V3 = v3()

  /**
   * Split-impulse "pseudo" velocities. Overlap is pushed out through this
   * channel instead of the real one, so de-penetration never injects energy
   * into the simulation. Without this a resting card settles at the depth where
   * the positional bias happens to cancel gravity — about 0.8mm at 240Hz, which
   * is most of a card's thickness — and the leftover bias velocity also keeps
   * it permanently above the sleep threshold.
   */
  pv: V3 = v3()
  pw: V3 = v3()

  /** World-space AABB, refreshed per substep for the broadphase. */
  aabbMin: V3 = v3()
  aabbMax: V3 = v3()

  /** Transform at the start of the current substep, for render interpolation. */
  prevP: V3 = v3()
  prevQ: Q4 = q4()

  mass: number
  invMass: number
  /** Principal inertia inverse, local axes. */
  invInertia: V3

  asleep = false
  sleepTimer = 0
  /**
   * How many contacts removed this body is from whatever actually disturbed it.
   * Waking spreads from neighbour to neighbour, and in a deck that means one
   * card being lifted can unfreeze the entire stack; this bounds how far it
   * travels. Zero means the disturbance was direct — the player's own hand, or
   * an impact.
   */
  wakeDepth = 0
  /** Scratch slot for the sleep-island union-find. */
  islandIndex = 0

  /** Pinch point in local space, valid while `mode === Grabbed`. */
  grabLocal: V3 = v3()
  /** World-space point the pinch is being pulled toward. */
  grabTarget: V3 = v3()

  /** Scratch: the eight corners in world space, refreshed once per substep. */
  corners: V3[] = []

  /** Free-form slot for gameplay data (owner seat, card identity, mesh ref). */
  ref: unknown = null

  constructor(id: number, halfExtents: V3, mass: number) {
    this.id = id
    this.half = v3(halfExtents.x, halfExtents.y, halfExtents.z)
    this.mass = mass
    this.invMass = mass > 0 ? 1 / mass : 0
    this.boundRadius = vlen(this.half)

    // Solid cuboid principal inertia, expressed with half-extents:
    //   I = m/12 * (H^2 + D^2) = m/3 * (hy^2 + hz^2)
    const { x: hx, y: hy, z: hz } = this.half
    const c = mass / 3
    const ix = c * (hy * hy + hz * hz)
    const iy = c * (hx * hx + hz * hz)
    const iz = c * (hx * hx + hy * hy)
    this.invInertia = v3(ix > 0 ? 1 / ix : 0, iy > 0 ? 1 / iy : 0, iz > 0 ? 1 / iz : 0)

    for (let i = 0; i < 8; i++) this.corners.push(v3())
  }

  wake(depth = 0): void {
    this.asleep = false
    this.sleepTimer = 0
    this.wakeDepth = depth
  }

  sleep(): void {
    this.asleep = true
    this.sleepTimer = 0
    vset(this.v, 0, 0, 0)
    vset(this.w, 0, 0, 0)
  }

  setTransform(px: number, py: number, pz: number, q?: Q4): void {
    vset(this.p, px, py, pz)
    if (q) {
      this.q.x = q.x
      this.q.y = q.y
      this.q.z = q.z
      this.q.w = q.w
      qNormalize(this.q)
    }
    vcopy(this.prevP, this.p)
    this.prevQ.x = this.q.x
    this.prevQ.y = this.q.y
    this.prevQ.z = this.q.z
    this.prevQ.w = this.q.w
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

class Contact {
  a: Body = null as unknown as Body
  /** null means the contact is against immovable world geometry. */
  b: Body | null = null
  ra: V3 = v3()
  rb: V3 = v3()
  n: V3 = v3()
  t1: V3 = v3()
  t2: V3 = v3()
  depth = 0
  friction = 0.5
  restitution = 0
  /** Accumulated impulses, for correct Coulomb clamping across iterations. */
  jn = 0
  jt1 = 0
  jt2 = 0
  /** Accumulated pseudo-impulse for the overlap-only pass. */
  pjn = 0
  /** Accumulated pseudo-impulse for the bottom-up pass. */
  sjn = 0
  /** Overlap tolerated here, scaled to how thin these particular bodies are. */
  slop = 0
  /** World height of the contact point, for ordering the shock pass. */
  py = 0
  /** Approach speed captured before solving, used for the bounce term. */
  vnInitial = 0
  /** Effective mass along the normal; identical for both passes, so cache it. */
  kn = 0
  /** Stable identity across substeps, so impulses can be warm-started. */
  key = 0
}

// ---------------------------------------------------------------------------
// Static world geometry
// ---------------------------------------------------------------------------

export interface TableSpec {
  /** Y of the playing surface. */
  surfaceY: number
  /** Radius of the felt. */
  radius: number
  /** Inward-facing rail that keeps cards on the table. */
  railRadius: number
  railTopY: number
  /** Catch plane far below, so an escaped card doesn't fall forever. */
  floorY: number
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

const _tmp1 = v3()
const _tmp2 = v3()
const _tmp3 = v3()
const _tmp4 = v3()
const _tmp5 = v3()
const _tmp6 = v3()
const _tmpLocal = v3()
const _tmpCentre = v3()
const _tmpRa = v3()
const _tmpRb = v3()
const _tmpAxis = v3()
const _tmpAxis2 = v3()

export class World {
  bodies: Body[] = []
  table: TableSpec
  tuning = TUNING

  /** Monotonic fixed-step counter. Shared clock for networked play. */
  tick = 0
  /** Leftover time carried between frames; also the render blend factor. */
  private accumulator = 0

  private contacts: Contact[] = []
  private contactCount = 0
  private nextId = 1

  /**
   * Warm-start cache: contact key -> slot in `warmData`, stride 4
   * [jn, jt1, jt2, lastTick].
   *
   * Re-deriving a resting contact's impulse from zero every substep leaves
   * residual error that shows up as angular micro-jitter, which in turn keeps a
   * stack permanently above the sleep threshold. Seeding each substep with the
   * previous solution removes it and converges in far fewer iterations.
   */
  private islandParent = new Int32Array(0)
  private islandQuiet = new Uint8Array(0)
  private islandTimer = new Float64Array(0)

  private contactOrder: number[] = []

  private warmSlot = new Map<number, number>()
  private warmData = new Float64Array(4 * 2048)
  private warmUsed = 0
  private warmSweptAt = 0

  /** Diagnostics, read by the debug HUD. */
  stats = { awake: 0, contacts: 0, substeps: 0, stepMs: 0, iterations: 0 }

  constructor(table: TableSpec) {
    this.table = table
  }

  createCard(halfExtents: V3, mass: number): Body {
    const b = new Body(this.nextId++, halfExtents, mass)
    this.bodies.push(b)
    return b
  }

  remove(body: Body): void {
    const i = this.bodies.indexOf(body)
    if (i >= 0) this.bodies.splice(i, 1)
  }

  /** Blend factor in [0,1) between `prevP/prevQ` and `p/q`, for rendering. */
  get alpha(): number {
    return this.accumulator / this.tuning.fixedDt
  }

  /**
   * Advance the simulation by a real elapsed time, in fixed substeps.
   * Rendering should interpolate using `alpha`.
   */
  advance(realDt: number): void {
    const t0 = now()
    const dt = this.tuning.fixedDt
    this.accumulator += Math.min(realDt, 0.25)

    let steps = 0
    while (this.accumulator >= dt && steps < this.tuning.maxSubsteps) {
      this.substep(dt)
      this.accumulator -= dt
      steps++
      this.tick++
    }
    // If we blew the substep budget, drop the backlog rather than lag behind.
    if (steps >= this.tuning.maxSubsteps) this.accumulator = 0

    this.stats.substeps = steps
    this.stats.stepMs = now() - t0
  }

  // ---- one fixed step -----------------------------------------------------

  /**
   * One fixed step, in the canonical sequential-impulse order: apply forces,
   * detect against current positions, solve velocity constraints, and only then
   * integrate positions. Detecting *after* integrating (the obvious-looking
   * order) makes every contact respond a step late, which lets a dragged card
   * be pushed straight through the table.
   */
  private substep(dt: number): void {
    const bodies = this.bodies

    // 1. Snapshot transforms for render interpolation.
    let awake = 0
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]
      vcopy(b.prevP, b.p)
      b.prevQ.x = b.q.x
      b.prevQ.y = b.q.y
      b.prevQ.z = b.q.z
      b.prevQ.w = b.q.w

      if (b.mode === BodyMode.Held) {
        // Externally driven; keep it out of the simulation entirely.
        b.sleepTimer = 0
        b.asleep = false
        continue
      }
      if (b.asleep) continue
      awake++
      this.integrateVelocity(b, dt)
    }
    this.stats.awake = awake

    // 2. Grab constraint, at velocity level. Contacts are solved afterwards and
    //    can fully cancel this, which is what stops a dragged card from being
    //    shoved through the felt or through a stack.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]
      if (b.mode === BodyMode.Grabbed) this.solveGrab(b, dt)
    }

    // 3. Collision detection against current positions.
    this.refreshCorners()
    this.buildContacts()

    // 4. Solve velocity, then overlap through the pseudo-velocity channel.
    this.solveContacts(dt)

    // 5. Integrate positions, real velocity plus de-penetration.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]
      if (b.mode === BodyMode.Held || b.asleep) continue
      clampV(b.v, this.tuning.maxLinearSpeed)
      clampV(b.w, this.tuning.maxAngularSpeed)

      vaddScaled(b.p, b.v, dt)
      qIntegrate(b.q, b.w, dt)

      if (b.pv.x !== 0 || b.pv.y !== 0 || b.pv.z !== 0) {
        vaddScaled(b.p, b.pv, dt)
        vset(b.pv, 0, 0, 0)
      }
      if (b.pw.x !== 0 || b.pw.y !== 0 || b.pw.z !== 0) {
        qIntegrate(b.q, b.pw, dt)
        vset(b.pw, 0, 0, 0)
      }
    }

    // 6. Sleep bookkeeping.
    this.updateSleep(dt)
  }

  private integrateVelocity(b: Body, dt: number): void {
    const T = this.tuning
    b.v.y += T.gravity * dt

    // Aerodynamics. A card's face pushes a lot of air and its edge almost
    // none, which is exactly why a dropped card flutters instead of dropping
    // like a stone. Model pressure drag on the face only, applied slightly
    // ahead of the centre of mass so the card also tumbles.
    const n = qRot(_tmp1, b.q, UNIT_Z)
    const vn = vdot(b.v, n)
    const speed2 = vlen2(b.v)
    if (speed2 > 1e-6 && Math.abs(vn) > 1e-4) {
      const area = 4 * b.half.x * b.half.y
      // F = -1/2 * rho*Cd * A * |vn| * vn * n
      const fMag = -0.5 * T.aeroPressure * area * Math.abs(vn) * vn
      vaddScaled(b.v, n, fMag * b.invMass * dt)

      // Centre of pressure offset, along the in-plane direction of travel.
      const vin = vset(_tmp2, b.v.x - n.x * vn, b.v.y - n.y * vn, b.v.z - n.z * vn)
      const vinLen = vlen(vin)
      if (vinLen > 1e-4) {
        const s = (T.aeroCopFraction * b.half.y) / vinLen
        const cop = vset(_tmp3, vin.x * s, vin.y * s, vin.z * s)
        const torque = vcross(_tmp4, cop, vset(_tmp5, n.x * fMag, n.y * fMag, n.z * fMag))
        this.applyAngularImpulse(b, torque, dt)
      }
    }

    // Stand-in for static friction.
    //
    // The contact solver only models *dynamic* Coulomb friction, which resists
    // sliding but never fully arrests it. A large interlocked pile therefore
    // creeps forever at a hair above the sleep threshold and never settles.
    // Bleeding velocity harder once a body is nearly stationary is what a real
    // static regime would do, and it is invisible at these speeds.
    if (vlen2(b.v) < T.restSpeed * T.restSpeed) {
      const rd = Math.exp(-T.restDamping * dt)
      b.v.x *= rd
      b.v.y *= rd
      b.v.z *= rd
      b.w.x *= rd
      b.w.y *= rd
      b.w.z *= rd
    }

    // Exponential damping: stable at any timestep, unlike (1 - k*dt).
    const ld = Math.exp(-T.linearDamping * dt)
    b.v.x *= ld
    b.v.y *= ld
    b.v.z *= ld
    const ad = Math.exp(-(b.mode === BodyMode.Grabbed ? T.grabAngularDamping : T.angularDamping) * dt)
    b.w.x *= ad
    b.w.y *= ad
    b.w.z *= ad
  }

  /** w += invI_world * (torque * dt), via the local principal axes. */
  private applyAngularImpulse(b: Body, torque: V3, dt: number): void {
    const local = qRotInv(_tmpLocal, b.q, torque)
    local.x *= b.invInertia.x * dt
    local.y *= b.invInertia.y * dt
    local.z *= b.invInertia.z * dt
    const world = qRot(local, b.q, local)
    b.w.x += world.x
    b.w.y += world.y
    b.w.z += world.z
  }

  // ---- grab ---------------------------------------------------------------

  /**
   * Pull the pinched point toward the cursor target by injecting velocity at
   * that point. Because the impulse is applied off-centre it also produces
   * torque, so the card swings and hangs from wherever you grabbed it — the
   * orientation emerges from the physics rather than being assigned. And
   * because the body stays dynamic, the contact solver still runs, so the card
   * slides along the table and shoves other cards while you move it.
   */
  private solveGrab(b: Body, dt: number): void {
    const T = this.tuning
    const ra = qRot(_tmp1, b.q, b.grabLocal)

    // Where the pinch is now, and where it should be.
    const gx = b.p.x + ra.x
    const gy = b.p.y + ra.y
    const gz = b.p.z + ra.z
    const dx = b.grabTarget.x - gx
    const dy = b.grabTarget.y - gy
    const dz = b.grabTarget.z - gz

    // Velocity that would close the gap this substep, speed-limited.
    let tvx = dx / dt
    let tvy = dy / dt
    let tvz = dz / dt
    const tSpeed = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz)
    if (tSpeed > T.grabMaxSpeed) {
      const s = T.grabMaxSpeed / tSpeed
      tvx *= s
      tvy *= s
      tvz *= s
    }

    // Current velocity of the pinch point: v + w x r
    const vp = vcross(_tmp2, b.w, ra)
    const evx = (tvx - (b.v.x + vp.x)) * T.grabStrength
    const evy = (tvy - (b.v.y + vp.y)) * T.grabStrength
    const evz = (tvz - (b.v.z + vp.z)) * T.grabStrength
    const eLen = Math.sqrt(evx * evx + evy * evy + evz * evz)
    if (eLen < 1e-7) return

    const dir = vset(_tmp3, evx / eLen, evy / eLen, evz / eLen)
    const k = invMassOf(b) + this.angularTerm(b, ra, dir)
    if (k < 1e-12) return

    const j = eLen / k
    const impulse = vset(_tmp4, dir.x * j, dir.y * j, dir.z * j)
    this.applyImpulse(b, ra, impulse, false)
  }

  /** n . ((invI (r x n)) x r) — the rotational part of the effective mass. */
  private angularTerm(b: Body, r: V3, n: V3): number {
    if (b.asleep) return 0
    const rn = vcross(_tmp5, r, n)
    const local = qRotInv(_tmpLocal, b.q, rn)
    local.x *= b.invInertia.x
    local.y *= b.invInertia.y
    local.z *= b.invInertia.z
    const world = qRot(local, b.q, local)
    const cr = vcross(_tmp6, world, r)
    return vdot(n, cr)
  }

  /** Apply a world-space impulse at offset `r`, to the real or pseudo channel. */
  private applyImpulse(b: Body, r: V3, impulse: V3, pseudo: boolean): void {
    // A sleeping body is skipped by integration, so any impulse applied here
    // would silently bank up in its velocity and erupt the moment it woke.
    // Treat it as immovable instead, exactly like static geometry.
    if (b.asleep) return
    const lin = pseudo ? b.pv : b.v
    const ang = pseudo ? b.pw : b.w
    lin.x += impulse.x * b.invMass
    lin.y += impulse.y * b.invMass
    lin.z += impulse.z * b.invMass
    const torque = vcross(_grabScratch, r, impulse)
    const local = qRotInv(_grabScratch2, b.q, torque)
    local.x *= b.invInertia.x
    local.y *= b.invInertia.y
    local.z *= b.invInertia.z
    const world = qRot(local, b.q, local)
    ang.x += world.x
    ang.y += world.y
    ang.z += world.z
  }

  // ---- collision detection ------------------------------------------------

  private refreshCorners(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]
      if (b.mode === BodyMode.Held) continue
      const h = b.half
      let minX = Infinity
      let minY = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let maxZ = -Infinity
      const { x: qx, y: qy, z: qz, w: qw } = b.q
      for (let c = 0; c < 8; c++) {
        const s = LOCAL_CORNER_SIGNS[c]
        const lx = s[0] * h.x
        const ly = s[1] * h.y
        const lz = s[2] * h.z
        const out = b.corners[c]
        // Inline rotate for the hot path.
        const tx = 2 * (qy * lz - qz * ly)
        const ty = 2 * (qz * lx - qx * lz)
        const tz = 2 * (qx * ly - qy * lx)
        const wx = b.p.x + lx + qw * tx + (qy * tz - qz * ty)
        const wy = b.p.y + ly + qw * ty + (qz * tx - qx * tz)
        const wz = b.p.z + lz + qw * tz + (qx * ty - qy * tx)
        out.x = wx
        out.y = wy
        out.z = wz
        if (wx < minX) minX = wx
        if (wy < minY) minY = wy
        if (wz < minZ) minZ = wz
        if (wx > maxX) maxX = wx
        if (wy > maxY) maxY = wy
        if (wz > maxZ) maxZ = wz
      }
      vset(b.aabbMin, minX, minY, minZ)
      vset(b.aabbMax, maxX, maxY, maxZ)
    }
  }

  private nextContact(): Contact {
    if (this.contactCount === this.contacts.length) this.contacts.push(new Contact())
    const c = this.contacts[this.contactCount++]
    c.jn = 0
    c.jt1 = 0
    c.jt2 = 0
    c.pjn = 0
      return c
  }

  /**
   * Stable contact identity for warm starting. `feature` is the static surface
   * id for world contacts, or the chosen separating axis for card-card ones.
   * A body id of 0 never occurs, so `b === null` can never alias a real pair.
   */
  private static contactKey(aId: number, bId: number, corner: number, feature: number): number {
    return ((aId * 4096 + bId) * 8 + corner) * 8 + feature
  }

  private addContact(
    a: Body,
    b: Body | null,
    point: V3,
    nx: number,
    ny: number,
    nz: number,
    depth: number,
    friction: number,
    corner: number,
    feature: number,
  ): void {
    // A speculative contact that is both far from touching and already
    // separating can never do anything. Dropping it here keeps a settled table
    // from carrying hundreds of no-op constraints through every iteration.
    const scale = this.pairScale(a, b)
    const gap = -depth
    if (gap > this.islandTouch(scale)) {
      // Contact-point velocity on each body: v + w x r.
      vset(_tmpRa, point.x - a.p.x, point.y - a.p.y, point.z - a.p.z)
      const va = vcross(_tmp5, a.w, _tmpRa)
      let rvx = a.v.x + va.x
      let rvy = a.v.y + va.y
      let rvz = a.v.z + va.z
      if (b) {
        vset(_tmpRb, point.x - b.p.x, point.y - b.p.y, point.z - b.p.z)
        const vb = vcross(_tmp6, b.w, _tmpRb)
        rvx -= b.v.x + vb.x
        rvy -= b.v.y + vb.y
        rvz -= b.v.z + vb.z
      }
      // Keep it if the pair could close that gap in the next couple of substeps.
      // Requiring it to close within *this* one discards the contact on exactly
      // the step before impact, and a card dropped on a deck sails through it.
      const closing = -(rvx * nx + rvy * ny + rvz * nz)
      if (closing * this.tuning.fixedDt * 2.5 < gap) return
    }

    const c = this.nextContact()
    c.key = World.contactKey(a.id, b ? b.id : 0, corner, feature)
    c.slop = this.tuning.slopFraction * scale
    c.py = point.y
    c.a = a
    c.b = b
    vset(c.ra, point.x - a.p.x, point.y - a.p.y, point.z - a.p.z)
    if (b) vset(c.rb, point.x - b.p.x, point.y - b.p.y, point.z - b.p.z)
    vset(c.n, nx, ny, nz)
    c.depth = depth
    c.friction = friction
    c.restitution = this.tuning.restitution
    buildBasis(c.n, c.t1, c.t2)
  }

  private buildContacts(): void {
    this.contactCount = 0
    const bodies = this.bodies
    const T = this.table

    // Card vs. static geometry.
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i]
      if (a.mode === BodyMode.Held || a.asleep) continue
      const margin = this.specMarginFor(a, null)
      const friction = this.tuning.frictionCardTable

      for (let c = 0; c < 8; c++) {
        const p = a.corners[c]

        // Felt: a half-space, clipped to the table disc.
        if (p.y < T.surfaceY + margin) {
          const rr = Math.sqrt(p.x * p.x + p.z * p.z)
          if (rr <= T.radius) {
            this.addContact(a, null, p, 0, 1, 0, T.surfaceY - p.y, friction, c, 0)
          }
        }

        // Rail: an inward-facing cylinder wall, only up to the rail top. A hard
        // enough throw still clears it, which is exactly what a real rail does.
        if (p.y < T.railTopY && p.y > T.surfaceY - 0.05) {
          const rr = Math.sqrt(p.x * p.x + p.z * p.z)
          if (rr > T.railRadius - margin && rr < T.railRadius + 0.08) {
            const inv = 1 / Math.max(rr, 1e-6)
            this.addContact(a, null, p, -p.x * inv, 0, -p.z * inv, rr - T.railRadius, friction, c, 1)
          }
        }

        // Catch floor, for anything thrown clear over the rail.
        if (p.y < T.floorY + margin) {
          this.addContact(a, null, p, 0, 1, 0, T.floorY - p.y, friction, c, 2)
        }
      }
    }

    // Card vs. card.
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i]
      if (a.mode === BodyMode.Held) continue
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j]
        if (b.mode === BodyMode.Held) continue
        if (a.asleep && b.asleep) continue
        const margin = this.specMarginFor(a, b)

        // Broadphase: world AABBs. A flat card's box is only ~2mm tall, so
        // cards stacked above one another reject immediately — a bounding
        // sphere (radius 54mm) would accept nearly every pair in a deck.
        if (
          a.aabbMin.x > b.aabbMax.x + margin ||
          a.aabbMax.x + margin < b.aabbMin.x ||
          a.aabbMin.y > b.aabbMax.y + margin ||
          a.aabbMax.y + margin < b.aabbMin.y ||
          a.aabbMin.z > b.aabbMax.z + margin ||
          a.aabbMax.z + margin < b.aabbMin.z
        ) {
          continue
        }

        const before = this.contactCount
        // Both directions, always.
        //
        // For a face contact it is tempting to test one way only, since two
        // aligned cards give the same four corners either way. They do not once
        // the cards are offset: the contact patch is their overlapping
        // rectangle, and its corners come from both cards. Testing one
        // direction then yields a lopsided two-point manifold, and a card
        // dropped even slightly off-centre onto a deck tips and works its way
        // down between the cards instead of resting on top. The facing-corner
        // filter already keeps this at four points per side, and corners
        // outside the overlap are rejected by the box test anyway.
        this.cornersAgainstBox(a, b, margin)
        this.cornersAgainstBox(b, a, margin)

        // A real touch wakes a sleeping neighbour, so stacks respond to a card
        // landing on them. Requiring actual motion matters: a speculative
        // contact from a barely-twitching card would otherwise keep re-waking
        // the whole stack underneath it forever.
        // Only a real touch wakes a sleeper, never a speculative near-miss.
        //
        // The detection shell grows with closing speed so nothing tunnels, which
        // means a card being dragged at a few metres per second carries a shell
        // some 20mm deep — deeper than the whole deck. Treating every contact in
        // that shell as a disturbance woke all 52 cards at once from a single
        // moving card, no matter how far away it actually was, and a fully awake
        // deck cannot hold itself up.
        let touching = false
        for (let k = before; k < this.contactCount; k++) {
          if (this.contacts[k].depth > -this.islandTouch(this.pairScale(a, b))) {
            touching = true
            break
          }
        }
        if (touching) {
          // Waking still spreads from neighbour to neighbour, but only so far,
          // so lifting one card cannot ripple down and unfreeze the whole stack.
          if (a.asleep && !b.asleep && b.wakeDepth < this.tuning.maxWakeDepth && this.shouldWake(a, b)) {
            a.wake(b.wakeDepth + 1)
          } else if (b.asleep && !a.asleep && a.wakeDepth < this.tuning.maxWakeDepth && this.shouldWake(b, a)) {
            b.wake(a.wakeDepth + 1)
          }
        }
      }
    }

    this.stats.contacts = this.contactCount
  }

  /** Detection shell for a pair: a fixed floor plus how far they will close. */
  private specMarginFor(a: Body, b: Body | null): number {
    const T = this.tuning
    let rel = vlen(a.v)
    if (b) rel += vlen(b.v)
    return T.specMargin + rel * T.fixedDt * T.specSpeedMargin
  }

  /**
   * Reference half-thickness for a pair, used to scale every tolerance. Keeping
   * these relative is what lets the same tuning hold for 2mm and 0.3mm cards.
   */
  private pairScale(a: Body, b: Body | null): number {
    return b ? Math.min(a.half.z, b.half.z) : a.half.z
  }

  private islandTouch(scale: number): number {
    return Math.max(this.tuning.islandTouchFraction * scale, this.tuning.islandTouchFloor)
  }

  /**
   * Should `mover` wake the sleeping `sleeper` it is touching?
   *
   * Weight bearing down from above deliberately does not. A card set down on a
   * deck nudges the top card just enough to wake the one below it, and the
   * cascade unfreezes all 52 within a few substeps; they then fall together and
   * the deck folds up, because support cannot propagate through a stack that
   * tall from a cold start at any realistic iteration count. Since a sleeping
   * body is infinite mass, leaving the deck asleep is precisely what makes it
   * behave like the solid object it is — the same reason a real deck does not
   * care that you put a card on it.
   *
   * Impact, lateral shove, spin, or the player's own hand all still wake it.
   */
  private shouldWake(sleeper: Body, mover: Body): boolean {
    const T = this.tuning
    // The player grabbing or holding something is always deliberate.
    if (mover.mode !== BodyMode.Dynamic) return true
    if (vlen(mover.v) > T.wakeImpactSpeed) return true
    if (mover.p.y > sleeper.p.y) {
      // Bearing down from above: only a sideways push counts. Spin is excluded
      // too — a card landing even slightly off-centre picks up plenty of it, and
      // letting that through reopens the same cascade by another route.
      return Math.hypot(mover.v.x, mover.v.z) > T.wakeLinear
    }
    return vlen(mover.v) > T.wakeLinear || vlen(mover.w) > T.wakeAngular
  }

  /**
   * Corners of `a` against the oriented box of `b`, using a speculative shell.
   *
   * Two details make this work for bodies only 2mm thick:
   *
   *  - The box is inflated by a margin that scales with closing speed, so a
   *    contact appears *before* the corner arrives. The velocity solver then
   *    brakes the approach to land exactly on the surface. Without this a card
   *    falling at 2.5m/s moves 10mm per substep — five times its own thickness —
   *    and jumps clean through whatever it was about to land on.
   *
   *  - The push-out direction comes from the centre-to-centre offset rather than
   *    from the corner's own side of the mid-plane. Once two cards overlap by
   *    more than half a thickness the corner's sign flips and would eject it out
   *    the far face, welding the pair into one coplanar sheet.
   */
  private cornersAgainstBox(a: Body, b: Body, margin: number): void {
    const T = this.tuning
    const h = b.half
    const scale = this.pairScale(a, b)
    const coincidentEps = T.coincidentFraction * scale
    const faceBias = T.faceBiasFraction * scale

    // Relative centre offset in b's frame: the stable "which side" reference.
    const dCentre = qRotInv(
      _tmpCentre,
      b.q,
      vset(_tmp1, a.p.x - b.p.x, a.p.y - b.p.y, a.p.z - b.p.z),
    )

    // Do the two cards genuinely overlap face-to-face? If b's footprint
    // contains a's centre, the only physically sensible way to separate them is
    // along the face normal, however shallow some other axis may look.
    const faceOverlap = Math.abs(dCentre.x) < h.x && Math.abs(dCentre.y) < h.y

    // Are they near-parallel? Needed before a single slab depth can stand in for
    // every corner.
    const aAxisZ = qRotInv(_tmpAxis, b.q, qRot(_tmpAxis2, a.q, UNIT_Z))
    const parallel = Math.abs(aAxisZ.z) > this.tuning.faceManifoldCos

    const useSlab = faceOverlap && parallel

    // Which face of b should a leave through? Decided once per pair from the
    // centre offset, so every corner agrees. Perfectly coincident cards have no
    // offset to read, so fall back to a stable tie-break on body id; anything
    // state-derived flips between substeps and welds the pair together.
    const faceSign =
      Math.abs(dCentre.z) > coincidentEps ? (dCentre.z > 0 ? 1 : -1) : a.id > b.id ? 1 : -1
    const signX = dCentre.x >= 0 ? 1 : -1
    const signY = dCentre.y >= 0 ? 1 : -1

    const ex = h.x + margin
    const ey = h.y + margin
    const ez = h.z + margin

    // For a face manifold, only a's four corners on the side facing b form the
    // real contact patch. Feeding all eight (and then repeating the whole test
    // from b's side) piles up sixteen redundant constraints that all try to
    // remove the same overlap, and the pair ends up shoved twice as far apart as
    // it should be. Four well-spread points is the classic manifold size.
    const facingSign = useSlab ? -faceSign : 0

    for (let c = 0; c < 8; c++) {
      if (useSlab && LOCAL_CORNER_SIGNS[c][2] !== facingSign) continue
      const p = a.corners[c]
      const rel = vset(_tmp1, p.x - b.p.x, p.y - b.p.y, p.z - b.p.z)
      const l = qRotInv(_tmp2, b.q, rel)

      if (Math.abs(l.x) >= ex || Math.abs(l.y) >= ey || Math.abs(l.z) >= ez) continue

      // Penetration measured past the *chosen* exit face, not the nearest one.
      //
      // Using the nearest face (h - |l|) is the intuitive choice and is wrong in
      // two ways at once. It saturates: a corner pushed past the mid-plane
      // starts reporting a shrinking depth, so two coincident cards read zero
      // overlap and never separate. And it is blind to tilt: measuring from
      // whichever face happens to be closer gives every corner of a tilted card
      // the same depth, leaving the solver no torque with which to flatten it —
      // cards then come to rest leaning at 20 degrees. Signing against one fixed
      // face makes depth monotonic through the whole body and preserves the
      // per-corner gradient that tilt correction needs.
      const dx = h.x - signX * l.x
      const dy = h.y - signY * l.y
      const dz = h.z - faceSign * l.z

      // Pick the exit axis. A genuine face overlap always leaves through the
      // face; otherwise fall back to least penetration, biased slightly toward
      // the face normal so exact ties between a coplanar pair cannot send some
      // corners sideways and others through the face.
      let axis: number
      let depth: number
      if (useSlab) {
        axis = 2
        depth = dz
      } else if (dz <= dx + faceBias && dz <= dy + faceBias) {
        axis = 2
        depth = dz
      } else if (dx <= dy) {
        axis = 0
        depth = dx
      } else {
        axis = 1
        depth = dy
      }

      const sign = axis === 0 ? signX : axis === 1 ? signY : faceSign

      const nWorld = qRot(
        _tmp3,
        b.q,
        vset(_tmp4, axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0),
      )
      this.addContact(a, b, p, nWorld.x, nWorld.y, nWorld.z, depth, this.tuning.frictionCardCard, c, axis)
    }
  }

  // ---- contact solving ----------------------------------------------------

  private solveContacts(dt: number): void {
    const T = this.tuning
    const n = this.contactCount
    if (n === 0) return

    // Cache effective masses and capture approach speeds up front, so
    // restitution uses the true impact velocity rather than a partly-solved one.
    for (let i = 0; i < n; i++) {
      const c = this.contacts[i]
      let kn = invMassOf(c.a) + (c.b ? invMassOf(c.b) : 0) + this.angularTerm(c.a, c.ra, c.n)
      if (c.b) kn += this.angularTerm(c.b, c.rb, c.n)
      c.kn = kn
      c.vnInitial = this.relativeNormalVelocity(c, false)
    }

    // Contact order: lowest first. Built once and reused by every pass.
    const order = this.contactOrder
    order.length = n
    for (let i = 0; i < n; i++) order[i] = i
    if (T.sortContacts && n > 1) {
      const cs = this.contacts
      order.sort((x, y) => cs[x].py - cs[y].py)
    }

    // Warm start: re-apply last substep's solution for contacts that persisted.
    for (let i = 0; i < n; i++) {
      const c = this.contacts[i]
      const slot = this.warmSlot.get(c.key)
      if (slot === undefined) continue
      const o = slot * 4
      // Only trust it if this same contact existed on the previous tick.
      if (this.warmData[o + 3] !== this.tick - 1) continue

      c.jn = this.warmData[o] * T.warmStartScale
      c.jt1 = this.warmData[o + 1] * T.warmStartScale
      c.jt2 = this.warmData[o + 2] * T.warmStartScale
      if (c.jn === 0 && c.jt1 === 0 && c.jt2 === 0) continue

      const imp = vset(
        _tmp3,
        c.n.x * c.jn + c.t1.x * c.jt1 + c.t2.x * c.jt2,
        c.n.y * c.jn + c.t1.y * c.jt1 + c.t2.y * c.jt2,
        c.n.z * c.jn + c.t1.z * c.jt1 + c.t2.z * c.jt2,
      )
      this.applyImpulse(c.a, c.ra, imp, false)
      if (c.b) {
        vset(imp, -imp.x, -imp.y, -imp.z)
        this.applyImpulse(c.b, c.rb, imp, false)
      }
    }

    // Pass 1: real velocity. Stops motion and applies friction and bounce.
    // Iterations scale with how many bodies are actually awake, since that is
    // what sets how far support has to travel.
    const iterations = Math.max(
      T.velocityIterations,
      Math.min(T.maxVelocityIterations, Math.ceil(this.stats.awake * T.iterationsPerAwakeBody)),
    )
    this.stats.iterations = iterations
    for (let it = 0; it < iterations; it++) {
      if (T.sweepAlternate && it & 1) {
        for (let i = n - 1; i >= 0; i--) this.solveContactVelocity(this.contacts[order[i]], dt)
      } else {
        for (let i = 0; i < n; i++) this.solveContactVelocity(this.contacts[order[i]], dt)
      }
    }

    // Pass 2: overlap only, through the pseudo-velocity channel. Because these
    // impulses never touch the real velocity, the bias can be aggressive
    // without adding energy, so cards rest exactly on the surface instead of
    // hovering at a penetration equilibrium.
    for (let it = 0; it < T.positionIterations; it++) {
      if (it & 1) {
        for (let i = n - 1; i >= 0; i--) this.solveContactPosition(this.contacts[order[i]], dt)
      } else {
        for (let i = 0; i < n; i++) this.solveContactPosition(this.contacts[order[i]], dt)
      }
    }

    // Pass 3: bottom-up, pinning each support. See `shockIterations`.
    for (let it = 0; it < T.shockIterations; it++) {
      for (let i = 0; i < n; i++) this.solveContactShock(this.contacts[order[i]], dt)
    }

    // Store solutions for next substep's warm start.
    this.storeWarmStart()
  }

  /** One contact of the bottom-up pass: pin whichever body is underneath. */
  private solveContactShock(c: Contact, dt: number): void {
    const T = this.tuning
    const pen = c.depth - c.slop
    if (pen <= 0) return

    // `n` points from b towards a, so a is the body pushed along +n.
    let mover: Body
    let sign: number
    if (!c.b || c.n.y >= 0) {
      mover = c.a
      sign = 1
    } else {
      mover = c.b
      sign = -1
    }
    if (mover.asleep || mover.mode === BodyMode.Held) return

    const r = mover === c.a ? c.ra : c.rb
    const nx = c.n.x * sign
    const ny = c.n.y * sign
    const nz = c.n.z * sign

    const k = mover.invMass + this.angularTerm(mover, r, vset(_tmp4, nx, ny, nz))
    if (k < 1e-12) return

    // Relative to the support, not absolute.
    //
    // Reading only the mover's own pseudo-velocity looks equivalent and is not:
    // every card then receives the same correction, the stack translates upward
    // as a rigid column instead of expanding, and the resulting churn costs more
    // than it fixes. Including the support's velocity while withholding the
    // impulse from it is what makes the correction accumulate up the stack.
    const support = mover === c.a ? c.b : c.a
    const vp = vcross(_tmp1, mover.pw, r)
    let rvx = mover.pv.x + vp.x
    let rvy = mover.pv.y + vp.y
    let rvz = mover.pv.z + vp.z
    if (support) {
      const rs = mover === c.a ? c.rb : c.ra
      const vs = vcross(_tmp2, support.pw, rs)
      rvx -= support.pv.x + vs.x
      rvy -= support.pv.y + vs.y
      rvz -= support.pv.z + vs.z
    }
    const vn = rvx * nx + rvy * ny + rvz * nz

    const target = Math.min((T.contactBias * pen) / dt, T.maxCorrectionSpeed)
    let j = (target - vn) / k
    const acc = Math.max(0, c.sjn + j)
    j = acc - c.sjn
    c.sjn = acc
    if (j === 0) return

    this.applyImpulse(mover, r, vset(_tmp3, nx * j, ny * j, nz * j), true)
  }

  private storeWarmStart(): void {
    // Recycle stale entries instead of only ever appending.
    //
    // Slots used to be handed out until the pool ran dry and then refused, with
    // a wholesale clear far too late to help. A 52-card deck carries some four
    // hundred live contacts whose keys drift as corners and axes change, so the
    // pool filled almost immediately and warm starting simply stopped for
    // anything new. That put a ceiling on stack height no amount of extra
    // iterations could lift, since warm starting is what holds a stack up.
    if (this.tick - this.warmSweptAt > 240 || this.warmUsed >= this.warmData.length / 4) {
      this.compactWarmStart()
    }
    const capacity = this.warmData.length / 4
    for (let i = 0; i < this.contactCount; i++) {
      const c = this.contacts[i]
      let slot = this.warmSlot.get(c.key)
      if (slot === undefined) {
        if (this.warmUsed >= capacity) continue
        slot = this.warmUsed++
        this.warmSlot.set(c.key, slot)
      }
      const o = slot * 4
      this.warmData[o] = c.jn
      this.warmData[o + 1] = c.jt1
      this.warmData[o + 2] = c.jt2
      this.warmData[o + 3] = this.tick
    }
  }

  /** Drop entries no contact has touched recently, reclaiming their slots. */
  private compactWarmStart(): void {
    this.warmSweptAt = this.tick
    const keep = new Map<number, number>()
    const next = new Float64Array(this.warmData.length)
    let used = 0
    for (const [key, slot] of this.warmSlot) {
      const o = slot * 4
      if (this.tick - this.warmData[o + 3] > 2) continue
      const n = used * 4
      next[n] = this.warmData[o]
      next[n + 1] = this.warmData[o + 1]
      next[n + 2] = this.warmData[o + 2]
      next[n + 3] = this.warmData[o + 3]
      keep.set(key, used)
      used++
    }
    if (used > this.warmData.length / 8 && this.warmData.length < 4 * 65536) {
      // Still tight after pruning: the scene genuinely needs a bigger pool.
      const grown = new Float64Array(this.warmData.length * 2)
      grown.set(next.subarray(0, used * 4))
      this.warmData = grown
    } else {
      this.warmData = next
    }
    this.warmSlot = keep
    this.warmUsed = used
  }

  /** Relative normal velocity at the contact, real or pseudo channel. */
  private relativeNormalVelocity(c: Contact, pseudo: boolean): number {
    const a = c.a
    const av = pseudo ? a.pv : a.v
    const aw = pseudo ? a.pw : a.w
    const va = vcross(_tmp1, aw, c.ra)
    let rvx = av.x + va.x
    let rvy = av.y + va.y
    let rvz = av.z + va.z
    if (c.b) {
      const bv = pseudo ? c.b.pv : c.b.v
      const bw = pseudo ? c.b.pw : c.b.w
      const vb = vcross(_tmp2, bw, c.rb)
      rvx -= bv.x + vb.x
      rvy -= bv.y + vb.y
      rvz -= bv.z + vb.z
    }
    return rvx * c.n.x + rvy * c.n.y + rvz * c.n.z
  }

  private solveContactVelocity(c: Contact, dt: number): void {
    const T = this.tuning
    const a = c.a
    const b = c.b
    if (c.kn < 1e-12) return

    // --- normal ---
    // `n` points from b toward a, and vnInitial is negative when approaching.
    //
    // A speculative contact (depth < 0, i.e. still separated) does not push;
    // it only forbids closing the gap faster than `gap / dt`. That brakes the
    // body to arrive exactly on the surface instead of overshooting through it.
    const vn = this.relativeNormalVelocity(c, false)
    // Approach no faster than covering half the remaining gap this substep.
    // Allowing the full gap means arriving with exactly enough speed to land on
    // the surface, and any staleness in the measurement overshoots straight
    // into penetration — which, inside a deck, means ending up between cards.
    let target = c.depth < 0 ? (c.depth / dt) * T.specApproach : 0
    // Bounce only off a contact that is genuinely touching. Applying it to a
    // speculative one throws the body back from a distance it never reached: a
    // card dropped on a deck was rebounding off thin air several millimetres
    // up, falling out of the detection shell, and stair-stepping its way down
    // through all 52 cards.
    if (c.depth >= 0 && c.vnInitial < -T.restitutionThreshold) {
      target = Math.max(target, -c.restitution * c.vnInitial)
    }

    let jn = (target - vn) / c.kn
    // Clamp the *accumulated* impulse so a contact can only ever push.
    const newJn = Math.max(0, c.jn + jn)
    jn = newJn - c.jn
    c.jn = newJn

    if (jn !== 0) {
      const imp = vset(_tmp3, c.n.x * jn, c.n.y * jn, c.n.z * jn)
      this.applyImpulse(a, c.ra, imp, false)
      if (b) {
        vset(imp, -imp.x, -imp.y, -imp.z)
        this.applyImpulse(b, c.rb, imp, false)
      }
    }

    // --- friction: two tangents, clamped together to the Coulomb cone ---
    const maxFriction = c.friction * c.jn
    if (maxFriction <= 0) return

    const invMassSum = invMassOf(a) + (b ? invMassOf(b) : 0)
    for (let axis = 0; axis < 2; axis++) {
      const t = axis === 0 ? c.t1 : c.t2
      let kt = invMassSum + this.angularTerm(a, c.ra, t)
      if (b) kt += this.angularTerm(b, c.rb, t)
      if (kt < 1e-12) continue

      const va = vcross(_tmp1, a.w, c.ra)
      let rvx = a.v.x + va.x
      let rvy = a.v.y + va.y
      let rvz = a.v.z + va.z
      if (b) {
        const vb = vcross(_tmp2, b.w, c.rb)
        rvx -= b.v.x + vb.x
        rvy -= b.v.y + vb.y
        rvz -= b.v.z + vb.z
      }
      const vt = rvx * t.x + rvy * t.y + rvz * t.z

      const acc = axis === 0 ? c.jt1 : c.jt2
      const other = axis === 0 ? c.jt2 : c.jt1
      let next = acc + -vt / kt
      const combined = Math.sqrt(next * next + other * other)
      if (combined > maxFriction && combined > 1e-12) next *= maxFriction / combined
      const jt = next - acc
      if (axis === 0) c.jt1 = next
      else c.jt2 = next

      if (jt !== 0) {
        const imp = vset(_tmp3, t.x * jt, t.y * jt, t.z * jt)
        this.applyImpulse(a, c.ra, imp, false)
        if (b) {
          vset(imp, -imp.x, -imp.y, -imp.z)
          this.applyImpulse(b, c.rb, imp, false)
        }
      }
    }
  }

  private solveContactPosition(c: Contact, dt: number): void {
    const T = this.tuning
    if (c.kn < 1e-12) return
    const pen = c.depth - c.slop
    if (pen <= 0) return

    const target = Math.min((T.contactBias * pen) / dt, T.maxCorrectionSpeed)
    const vn = this.relativeNormalVelocity(c, true)

    let jn = (target - vn) / c.kn
    const newJn = Math.max(0, c.pjn + jn)
    jn = newJn - c.pjn
    c.pjn = newJn
    if (jn === 0) return

    const imp = vset(_tmp3, c.n.x * jn, c.n.y * jn, c.n.z * jn)
    this.applyImpulse(c.a, c.ra, imp, true)
    if (c.b) {
      vset(imp, -imp.x, -imp.y, -imp.z)
      this.applyImpulse(c.b, c.rb, imp, true)
    }
  }

  // ---- sleeping -----------------------------------------------------------

  private findRoot(i: number): number {
    const p = this.islandParent
    let r = i
    while (p[r] !== r) r = p[r]
    while (p[i] !== r) {
      const next = p[i]
      p[i] = r
      i = next
    }
    return r
  }

  /**
   * Sleep in islands rather than per body.
   *
   * Sleeping bodies individually looks reasonable and is quietly disastrous: the
   * moment the bottom card of a stack sleeps it becomes infinite-mass, which
   * invalidates the warm-started impulses of everything resting on it. The card
   * above gets jolted, that jolt re-wakes the sleeper, and the pair oscillates
   * forever with a period of exactly `sleepDelay`. Freezing a whole contact
   * island at once removes the discontinuity — and lets a settled table cost
   * almost nothing to simulate.
   */
  private updateSleep(dt: number): void {
    const T = this.tuning
    const bodies = this.bodies
    const n = bodies.length
    if (n === 0) return

    if (this.islandParent.length < n) {
      this.islandParent = new Int32Array(n * 2)
      this.islandQuiet = new Uint8Array(n * 2)
      this.islandTimer = new Float64Array(n * 2)
    }
    const parent = this.islandParent
    const quiet = this.islandQuiet
    const timer = this.islandTimer

    for (let i = 0; i < n; i++) {
      parent[i] = i
      quiet[i] = 1
      timer[i] = Infinity
      bodies[i].islandIndex = i
    }

    // Union bodies that are genuinely touching, not merely inside each other's
    // speculative shell.
    for (let i = 0; i < this.contactCount; i++) {
      const c = this.contacts[i]
      if (!c.b || c.depth < -this.islandTouch(this.pairScale(c.a, c.b))) continue
      const ra = this.findRoot(c.a.islandIndex)
      const rb = this.findRoot(c.b.islandIndex)
      if (ra !== rb) parent[ra] = rb
    }

    // Per-body quiet accounting.
    for (let i = 0; i < n; i++) {
      const b = bodies[i]
      if (b.mode !== BodyMode.Dynamic || b.asleep) continue
      if (vlen(b.v) < T.sleepLinear && vlen(b.w) < T.sleepAngular) b.sleepTimer += dt
      else b.sleepTimer = 0
    }

    // Aggregate to islands. Anything grabbed or held keeps its island awake.
    for (let i = 0; i < n; i++) {
      const b = bodies[i]
      const r = this.findRoot(i)
      if (b.mode !== BodyMode.Dynamic) {
        quiet[r] = 0
        continue
      }
      if (b.asleep) continue
      if (b.sleepTimer < T.sleepDelay) quiet[r] = 0
      if (b.sleepTimer < timer[r]) timer[r] = b.sleepTimer
    }

    // Freeze whole islands together.
    for (let i = 0; i < n; i++) {
      const b = bodies[i]
      if (b.mode !== BodyMode.Dynamic || b.asleep) continue
      if (quiet[this.findRoot(i)] === 1) b.sleep()
    }
  }

  // ---- grab lifecycle -----------------------------------------------------

  /** Begin dragging `body` from a world-space pinch point on its surface. */
  beginGrab(body: Body, worldPinch: V3): void {
    const rel = vset(_tmp1, worldPinch.x - body.p.x, worldPinch.y - body.p.y, worldPinch.z - body.p.z)
    qRotInv(body.grabLocal, body.q, rel)
    vcopy(body.grabTarget, worldPinch)
    body.mode = BodyMode.Grabbed
    body.wake()
  }

  updateGrab(body: Body, worldTarget: V3): void {
    vcopy(body.grabTarget, worldTarget)
    body.wake()
  }

  /**
   * Let go. No placement, no alignment, no snapping — the card simply keeps the
   * velocity it already had from following the cursor, and falls.
   */
  endGrab(body: Body): void {
    const T = this.tuning
    body.mode = BodyMode.Dynamic
    body.v.x *= T.throwGain
    body.v.y *= T.throwGain
    body.v.z *= T.throwGain
    clampV(body.v, T.maxThrowSpeed)
    body.wake()
  }

  // ---- networking hooks ---------------------------------------------------
  //
  // Deterministic fixed steps mean a host can drive the sim and stream state.
  // 14 floats per body: position, orientation, linear and angular velocity.

  static readonly SNAPSHOT_STRIDE = 15

  serialize(out?: Float64Array): Float64Array {
    const stride = World.SNAPSHOT_STRIDE
    const buf = out && out.length >= this.bodies.length * stride ? out : new Float64Array(this.bodies.length * stride)
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]
      const o = i * stride
      buf[o] = b.id
      buf[o + 1] = b.p.x
      buf[o + 2] = b.p.y
      buf[o + 3] = b.p.z
      buf[o + 4] = b.q.x
      buf[o + 5] = b.q.y
      buf[o + 6] = b.q.z
      buf[o + 7] = b.q.w
      buf[o + 8] = b.v.x
      buf[o + 9] = b.v.y
      buf[o + 10] = b.v.z
      buf[o + 11] = b.w.x
      buf[o + 12] = b.w.y
      buf[o + 13] = b.w.z
      buf[o + 14] = b.asleep ? 1 : 0
    }
    return buf
  }

  applySnapshot(buf: Float64Array): void {
    const stride = World.SNAPSHOT_STRIDE
    const count = Math.floor(buf.length / stride)
    for (let i = 0; i < count; i++) {
      const o = i * stride
      const body = this.bodies.find((b) => b.id === buf[o])
      if (!body) continue
      vset(body.p, buf[o + 1], buf[o + 2], buf[o + 3])
      body.q.x = buf[o + 4]
      body.q.y = buf[o + 5]
      body.q.z = buf[o + 6]
      body.q.w = buf[o + 7]
      vset(body.v, buf[o + 8], buf[o + 9], buf[o + 10])
      vset(body.w, buf[o + 11], buf[o + 12], buf[o + 13])
      vcopy(body.prevP, body.p)
      body.prevQ.x = body.q.x
      body.prevQ.y = body.q.y
      body.prevQ.z = body.q.z
      body.prevQ.w = body.q.w
      // Sleep state is part of the state: a client that wakes everything back
      // up will immediately drift away from the host.
      if (buf[o + 14] > 0.5) body.sleep()
      else body.wake()
    }
  }

  /** Cheap state digest, for verifying that clients haven't diverged. */
  checksum(): number {
    let h = 2166136261
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]
      h = mixFloat(h, b.p.x)
      h = mixFloat(h, b.p.y)
      h = mixFloat(h, b.p.z)
      h = mixFloat(h, b.q.x)
      h = mixFloat(h, b.q.y)
      h = mixFloat(h, b.q.z)
      h = mixFloat(h, b.q.w)
    }
    return h >>> 0
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const UNIT_Z: V3 = { x: 0, y: 0, z: 1 }
const _grabScratch = v3()
const _grabScratch2 = v3()

/** Inverse mass as the solver sees it: a sleeping body is infinitely heavy. */
function invMassOf(b: Body): number {
  return b.asleep ? 0 : b.invMass
}

function clampV(v: V3, max: number): void {
  const l2 = v.x * v.x + v.y * v.y + v.z * v.z
  if (l2 > max * max) {
    const s = max / Math.sqrt(l2)
    v.x *= s
    v.y *= s
    v.z *= s
  }
}

/** Any orthonormal pair perpendicular to `n`, chosen branch-stably. */
function buildBasis(n: V3, t1: V3, t2: V3): void {
  if (Math.abs(n.x) >= 0.5773502691896258) {
    vset(t1, n.y, -n.x, 0)
  } else {
    vset(t1, 0, n.z, -n.y)
  }
  const l = vlen(t1)
  if (l > 1e-12) {
    const inv = 1 / l
    t1.x *= inv
    t1.y *= inv
    t1.z *= inv
  } else {
    vset(t1, 1, 0, 0)
  }
  vcross(t2, n, t1)
}

function mixFloat(h: number, f: number): number {
  // Quantise before hashing so last-bit noise doesn't dominate the digest.
  const q = Math.round(f * 1e6) | 0
  h ^= q
  h = Math.imul(h, 16777619)
  return h
}

// `performance` exists in browsers and in modern Node, so no node typings are
// needed; fall back to Date only for exotic hosts.
const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()
