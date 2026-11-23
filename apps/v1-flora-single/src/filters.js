/**
 * 1-Euro adaptive low-pass filter and deadzone bloom stabilizer.
 * Prevents micro-jitter drift ("手停住了但花还在继续开") while keeping fast motion responsive.
 */

function alphaForCutoff(dt, cutoff) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  /**
   * @param {number} minCutoff Minimum cutoff frequency (Hz); lower = steadier at rest.
   * @param {number} beta Speed coefficient; higher = less lag during quick motion.
   * @param {number} dCutoff Derivative cutoff frequency (Hz).
   */
  constructor(minCutoff = 1.2, beta = 0.08, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  reset(value = null) {
    this.xPrev = value;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  filter(value, timestampMs) {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = value;
      this.tPrev = timestampMs;
      return value;
    }

    const dt = Math.max((timestampMs - this.tPrev) / 1000, 1 / 120);
    this.tPrev = timestampMs;

    const dx = (value - this.xPrev) / dt;
    const edx = this.dxPrev + alphaForCutoff(dt, this.dCutoff) * (dx - this.dxPrev);
    this.dxPrev = edx;

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const filtered = this.xPrev + alphaForCutoff(dt, cutoff) * (value - this.xPrev);
    this.xPrev = filtered;
    return filtered;
  }
}

export class BloomStabilizer {
  /**
   * Smoothly stabilizes target bloom progress [0, 1] with deadzone hysteresis
   * and exact resting snap so stationary hands stop blooming immediately.
   */
  constructor({ deadzone = 0.015, responsiveness = 11.5 } = {}) {
    this.deadzone = deadzone;
    this.responsiveness = responsiveness;
    this.euro = new OneEuroFilter(1.2, 0.08, 1.0);
    this.target = 0;
    this.current = 0;
  }

  setImmediate(progress01) {
    const clamped = Math.max(0, Math.min(1, progress01));
    this.euro.reset(clamped);
    this.target = clamped;
    this.current = clamped;
    return clamped;
  }

  setTargetImmediate(progress01) {
    const clamped = Math.max(0, Math.min(1, progress01));
    this.euro.reset(clamped);
    this.target = clamped;
  }

  /**
   * Feed a raw normalized pinch metric in [0, 1] from the gesture detector.
   */
  pushGestureSample(rawProgress01, timestampMs) {
    const clamped = Math.max(0, Math.min(1, rawProgress01));
    const filtered = this.euro.filter(clamped, timestampMs);

    // Deadzone keeps stationary hand noise from creeping forward; allow clean endpoint lock at 0 or 1.
    const nearEdge = filtered <= 0.01 || filtered >= 0.99;
    if (nearEdge || Math.abs(filtered - this.target) >= this.deadzone) {
      this.target = filtered;
    }
    return this.target;
  }

  /**
   * Advance the damped display progress toward target over dtSeconds.
   */
  step(dtSeconds) {
    const diff = this.target - this.current;
    if (Math.abs(diff) < 0.002) {
      this.current = this.target;
      return this.current;
    }
    const dt = Math.min(Math.max(dtSeconds, 0), 0.1);
    const blend = 1 - Math.exp(-this.responsiveness * dt);
    this.current += diff * blend;
    if (Math.abs(this.target - this.current) < 0.002) {
      this.current = this.target;
    }
    return this.current;
  }
}
