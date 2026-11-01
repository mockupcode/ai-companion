// Small motion toolkit: everything that moves goes through damping or springs so the
// robot never snaps between poses.

export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Frame-rate independent exponential approach toward a target.
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

// Cheap smooth 1D noise in roughly [-1, 1] for idle fidgets.
export function noise(t, seed = 0) {
  return (
    Math.sin(t * 1.0 + seed * 1.7) * 0.5 +
    Math.sin(t * 1.618 + seed * 3.1) * 0.3 +
    Math.sin(t * 2.718 + seed * 5.3) * 0.2
  );
}

// Damped harmonic oscillator. Low damping gives the jelly-like overshoot.
export class Spring {
  constructor(value = 0, stiffness = 120, damping = 12) {
    this.value = value;
    this.target = value;
    this.vel = 0;
    this.k = stiffness;
    this.c = damping;
  }

  update(dt) {
    // Sub-step so stiff springs stay stable on slow frames.
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vel += (this.k * (this.target - this.value) - this.c * this.vel) * h;
      this.value += this.vel * h;
    }
    return this.value;
  }
}
