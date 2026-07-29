/** Critically-damped spring for smooth, physical motion. */
export class Spring {
  value: number
  center: number
  velocity = 0
  stiffness: number
  damping: number

  constructor(value = 0, stiffness = 180, damping = 18) {
    this.value = value
    this.center = value
    this.stiffness = stiffness
    this.damping = damping
  }

  set(v: number) {
    this.value = v
    this.center = v
    this.velocity = 0
  }

  animate(dt: number): number {
    const clamped = Math.min(dt, 1 / 20)
    const force = -this.stiffness * (this.value - this.center) - this.damping * this.velocity
    this.velocity += force * clamped
    this.value += this.velocity * clamped
    return this.value
  }

  animateTo(center: number, dt: number): number {
    this.center = center
    return this.animate(dt)
  }
}
