export type Easing = (t: number) => number

export const easeOutCubic: Easing = (t) => 1 - (1 - t) ** 3
export const easeInOutCubic: Easing = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
export const easeOutBack: Easing = (t) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}
export const easeOutElastic: Easing = (t) => {
  if (t === 0 || t === 1) return t
  return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
}

type Tween = {
  elapsed: number
  duration: number
  easing: Easing
  onUpdate: (v: number) => void
  onComplete?: () => void
}

export class TweenManager {
  private tweens: Tween[] = []

  tween(
    durationSec: number,
    onUpdate: (v: number) => void,
    easing: Easing = easeOutCubic,
    onComplete?: () => void,
  ) {
    this.tweens.push({ elapsed: 0, duration: durationSec, easing, onUpdate, onComplete })
  }

  update(delta: number) {
    for (let i = this.tweens.length - 1; i >= 0; i -= 1) {
      const t = this.tweens[i]
      t.elapsed += delta
      const k = Math.min(t.elapsed / t.duration, 1)
      t.onUpdate(t.easing(k))
      if (k >= 1) {
        t.onComplete?.()
        this.tweens.splice(i, 1)
      }
    }
  }
}

/** Critically-damped-ish spring for addictive hover / settle motion (bg3d-inspired). */
export class Spring {
  value: number
  center: number
  velocity = 0
  stiffness: number
  damping: number
  mass: number

  constructor(value = 0, stiffness = 180, damping = 18, mass = 1) {
    this.value = value
    this.center = value
    this.stiffness = stiffness
    this.damping = damping
    this.mass = mass
  }

  set(value: number) {
    this.value = value
    this.center = value
    this.velocity = 0
  }

  animate(dt: number) {
    // Integrate in small fixed-ish steps. One large Euler step becomes visibly
    // unstable when a frame is delayed, which reads as a card "stutter".
    const clamped = Math.min(Math.max(dt, 0), 1 / 12)
    const steps = Math.max(1, Math.ceil(clamped / (1 / 120)))
    const step = clamped / steps
    for (let i = 0; i < steps; i += 1) {
      const force =
        -this.stiffness * (this.value - this.center) -
        this.damping * this.velocity
      this.velocity += (force / this.mass) * step
      this.value += this.velocity * step
    }
    return this.value
  }

  animateTo(center: number, dt: number) {
    this.center = center
    return this.animate(dt)
  }
}

export class Vec3Spring {
  x: Spring
  y: Spring
  z: Spring

  constructor(x = 0, y = 0, z = 0, stiffness = 160, damping = 16) {
    this.x = new Spring(x, stiffness, damping)
    this.y = new Spring(y, stiffness, damping)
    this.z = new Spring(z, stiffness, damping)
  }

  set(x: number, y: number, z: number) {
    this.x.set(x)
    this.y.set(y)
    this.z.set(z)
  }

  animateTo(x: number, y: number, z: number, dt: number) {
    return {
      x: this.x.animateTo(x, dt),
      y: this.y.animateTo(y, dt),
      z: this.z.animateTo(z, dt),
    }
  }
}
