/**
 * Adaptive 1-Euro low-pass filters for smooth, low-latency hand coordinates and openness.
 */

function alphaForCutoff(dt, cutoff) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  constructor(minCutoff = 1.4, beta = 0.08, dCutoff = 1.0) {
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

export class PointOneEuroFilter {
  constructor(minCutoff = 1.8, beta = 0.25, dCutoff = 1.0) {
    this.xFilter = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.yFilter = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  reset() {
    this.xFilter.reset();
    this.yFilter.reset();
  }

  filter(x, y, timestampMs) {
    return {
      x: this.xFilter.filter(x, timestampMs),
      y: this.yFilter.filter(y, timestampMs),
    };
  }
}
