/**
 * Spring integrators for card motion.
 *
 * Two things matter here for feel:
 *
 *  1. Fixed-step accumulation. A spring integrated with a variable `dt` changes
 *     effective stiffness when the frame rate changes — cards behave one way on
 *     a 144 Hz monitor and another on a 60 Hz one, and a single long frame can
 *     blow the integration up. We accumulate into fixed 1/120 s substeps so the
 *     behaviour is identical everywhere. That matters doubly in multiplayer:
 *     everyone should see the same throw.
 *  2. Semi-implicit Euler (velocity updated before position). Stable at the
 *     stiffnesses that make cards feel snappy; explicit Euler is not.
 */

const SUBSTEP = 1 / 120
const MAX_SUBSTEPS = 8

export class Spring {
  value: number
  target: number
  velocity = 0
  stiffness: number
  damping: number

  private accumulator = 0

  constructor(value = 0, stiffness = 180, damping = 18) {
    this.value = value
    this.target = value
    this.stiffness = stiffness
    this.damping = damping
  }

  /** Teleport — no motion, no residual velocity. */
  set(v: number) {
    this.value = v
    this.target = v
    this.velocity = 0
    this.accumulator = 0
  }

  /** Kick the spring without moving it. Used for landing bounces and throws. */
  impulse(v: number) {
    this.velocity += v
  }

  /** Critical damping for the current stiffness — fastest settle, no overshoot. */
  critical() {
    this.damping = 2 * Math.sqrt(this.stiffness)
  }

  step(dt: number): number {
    this.accumulator += dt
    let steps = 0
    while (this.accumulator >= SUBSTEP && steps < MAX_SUBSTEPS) {
      const a = -this.stiffness * (this.value - this.target) - this.damping * this.velocity
      this.velocity += a * SUBSTEP
      this.value += this.velocity * SUBSTEP
      this.accumulator -= SUBSTEP
      steps++
    }
    // A very long frame (tab restored from the background) would otherwise queue
    // hundreds of substeps and detonate the simulation.
    if (steps === MAX_SUBSTEPS) this.accumulator = 0
    return this.value
  }

  stepTo(target: number, dt: number): number {
    this.target = target
    return this.step(dt)
  }

  get settled(): boolean {
    return Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-3
  }
}

/** Three independent springs sharing one tuning — a position or an euler triple. */
export class Spring3 {
  readonly x: Spring
  readonly y: Spring
  readonly z: Spring

  constructor(stiffness = 220, damping = 24) {
    this.x = new Spring(0, stiffness, damping)
    this.y = new Spring(0, stiffness, damping)
    this.z = new Spring(0, stiffness, damping)
  }

  set(x: number, y: number, z: number) {
    this.x.set(x)
    this.y.set(y)
    this.z.set(z)
  }

  target(x: number, y: number, z: number) {
    this.x.target = x
    this.y.target = y
    this.z.target = z
  }

  tune(stiffness: number, damping: number) {
    this.x.stiffness = stiffness
    this.x.damping = damping
    this.y.stiffness = stiffness
    this.y.damping = damping
    this.z.stiffness = stiffness
    this.z.damping = damping
  }

  impulse(x: number, y: number, z: number) {
    this.x.impulse(x)
    this.y.impulse(y)
    this.z.impulse(z)
  }

  step(dt: number) {
    this.x.step(dt)
    this.y.step(dt)
    this.z.step(dt)
  }

  get settled(): boolean {
    return this.x.settled && this.y.settled && this.z.settled
  }
}

/** Frame-rate independent exponential smoothing. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt)
}

/** Shortest-arc angular damping — avoids the 359°→1° spin. */
export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  const TAU = Math.PI * 2
  const d = ((target - current + Math.PI) % TAU + TAU) % TAU - Math.PI
  return current + d * (1 - Math.exp(-rate * dt))
}
