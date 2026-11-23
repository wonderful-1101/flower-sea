/**
 * JARDIN — Dutch Oil-Painting Angled Flower Tapestry Engine.
 * Key UX guarantees:
 * 1. Dense multi-row angled flowers overlapping edge-to-edge over a 2K oil foliage backdrop.
 * 2. Default 'realtime' mode immediately begins smoothly closing flowers (~1.0s) the moment
 *    the hand/cursor moves away — moving from bottom-left to top-right closes bottom-left automatically!
 * 3. Measures spatial distance to each flower's true blossom head `(headX, headY)` and pivots wind/sway from stem base.
 */

import { ChiaroscuroParticles } from './particles.js';
import { generateOilTapestry } from './tapestryLayout.js';

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function createLinenCanvasPattern(ctx) {
  const tile = document.createElement('canvas');
  tile.width = 96;
  tile.height = 96;
  const tctx = tile.getContext('2d');
  const imgData = tctx.createImageData(96, 96);
  const d = imgData.data;

  for (let y = 0; y < 96; y += 1) {
    for (let x = 0; x < 96; x += 1) {
      const idx = (y * 96 + x) * 4;
      const weave = (Math.sin(x * 1.4) + Math.sin(y * 1.4)) * 0.5;
      const tone = weave > 0 ? 255 : 0;
      d[idx] = tone;
      d[idx + 1] = tone;
      d[idx + 2] = tone;
      d[idx + 3] = Math.round(Math.abs(weave) * 9);
    }
  }
  tctx.putImageData(imgData, 0, 0);
  return ctx.createPattern(tile, 'repeat');
}

export class TapestryEngine {
  constructor({ canvas, spriteStore, onStats }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.spriteStore = spriteStore;
    this.onStats = onStats;

    this.particles = new ChiaroscuroParticles(180);
    this.linenPattern = createLinenCanvasPattern(this.ctx);

    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.flowers = [];
    this.density = 96;
    this.radius = 270;
    this.closeDurationSec = 1.0; // Total natural close feel when hand leaves
    this.responseMode = 'realtime'; // 'realtime' (default) | 'brief' | 'paint'
    this.gestureMode = 'position-openness'; // 'position-openness' | 'position-only'
    this.seed = 20261123;

    this.handAttractors = [];
    this.pointerAttractor = null;
    this.prevPointer = null;

    this.rafId = null;
    this.lastFrameTime = performance.now();
    this.lastStatsEmit = 0;
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.relayout(false);
  }

  relayout(newSeed = true) {
    if (newSeed) {
      this.seed = (this.seed + 7919) >>> 0;
    }
    const oldBlooms = !newSeed ? this.flowers.map((f) => f.bloom) : [];
    const responsiveTarget = Math.round(
      this.density * Math.min(1.25, Math.max(0.55, (this.width * this.height) / (1440 * 900)))
    );
    this.flowers = generateOilTapestry({
      width: this.width,
      height: this.height,
      speciesList: this.spriteStore.getSpecies(),
      targetCount: Math.max(36, responsiveTarget),
      seed: this.seed,
    });
    if (!newSeed && oldBlooms.length === this.flowers.length) {
      this.flowers.forEach((f, idx) => {
        f.bloom = oldBlooms[idx];
      });
    }
    this.emitStats(true);
  }

  setDensity(count) {
    this.density = count;
    this.relayout(false);
  }

  setResponseMode(mode) {
    this.responseMode = mode;
    if (mode === 'realtime') {
      for (const f of this.flowers) {
        f.lingerTimer = 0;
      }
    }
  }

  setGestureMode(mode) {
    this.gestureMode = mode;
  }

  setRadius(radiusPx) {
    this.radius = radiusPx;
  }

  setCloseDuration(sec) {
    this.closeDurationSec = sec;
  }

  setHandAttractors(attractors) {
    this.handAttractors = attractors;
  }

  setPointerAttractor(attractor) {
    if (attractor && this.prevPointer) {
      attractor.vx = (attractor.x - this.prevPointer.x) * 24;
      attractor.vy = (attractor.y - this.prevPointer.y) * 24;
    }
    this.pointerAttractor = attractor;
    this.prevPointer = attractor ? { x: attractor.x, y: attractor.y } : null;
  }

  bloomAll() {
    for (const f of this.flowers) {
      f.peakTarget = 1;
      f.lingerTimer = this.responseMode === 'brief' ? 0.7 : 0;
    }
    this.manualHoldAll = true;
  }

  closeAll() {
    this.manualHoldAll = false;
    for (const f of this.flowers) {
      f.peakTarget = 0;
      f.lingerTimer = 0;
    }
  }

  start() {
    if (this.rafId !== null) return;
    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  getActiveAttractors() {
    const list = [];
    for (const h of this.handAttractors) list.push(h);
    if (this.pointerAttractor) list.push(this.pointerAttractor);
    return list;
  }

  update(dt, timeSec) {
    const attractors = this.getActiveAttractors();
    if (attractors.length > 0) {
      this.manualHoldAll = false;
    }
    const radius = this.radius;
    const tauOpen = 0.19;
    // Map closeDurationSec (~0.4..2.0s) to exponential time constant tauClose (~0.34s at 1.0s).
    const tauClose = Math.max(0.12, this.closeDurationSec * 0.34);

    for (const f of this.flowers) {
      let maxInfluence = 0;
      let forceOpenTarget = 0;
      let activeFold = false;
      let pushLean = 0;

      for (const att of attractors) {
        const dx = f.headX - att.x;
        const dy = f.headY - att.y;
        const dist = Math.hypot(dx, dy);

        if (dist < radius) {
          const falloff = 1 - smoothstep(0, radius, dist);
          if (falloff > maxInfluence) maxInfluence = falloff;

          const effectiveOpen =
            this.gestureMode === 'position-only' ? 1.0 : att.openness;

          if (this.gestureMode === 'position-openness' && effectiveOpen < 0.24) {
            activeFold = true;
          } else {
            const target = Math.min(1, falloff * 1.25) * effectiveOpen;
            if (target > forceOpenTarget) forceOpenTarget = target;
          }

          // Subtle physical stem tilt away from sweeping hand/cursor.
          const vx = att.vx || 0;
          const dirX = dist > 4 ? dx / dist : 0;
          pushLean += (dirX * 0.055 + Math.max(-1, Math.min(1, vx / 900)) * 0.06) * falloff;
        }
      }

      const leanLerp = 1 - Math.exp(-8 * dt);
      f.pushLean += (pushLean - f.pushLean) * leanLerp;

      const prevBloom = f.bloom;

      if (this.manualHoldAll) {
        f.bloom += (1 - f.bloom) * (1 - Math.exp(-dt / tauOpen));
      } else if (activeFold && maxInfluence > 0.12) {
        f.lingerTimer = 0;
        f.peakTarget = Math.min(f.peakTarget, 1 - maxInfluence);
        f.bloom += (0 - f.bloom) * (1 - Math.exp(-dt / 0.15));
      } else if (this.responseMode === 'paint') {
        if (forceOpenTarget > f.peakTarget) {
          f.peakTarget = forceOpenTarget;
        }
        f.bloom += (f.peakTarget - f.bloom) * (1 - Math.exp(-dt / tauOpen));
      } else if (this.responseMode === 'brief') {
        if (forceOpenTarget > 0.05) {
          if (forceOpenTarget >= f.peakTarget) f.peakTarget = forceOpenTarget;
          f.lingerTimer = Math.max(f.lingerTimer, 0.72 * Math.min(1, maxInfluence * 1.3));
        } else if (f.lingerTimer > 0) {
          f.lingerTimer = Math.max(0, f.lingerTimer - dt);
        }
        if (f.lingerTimer > 0 || forceOpenTarget > 0.05) {
          const target = Math.max(f.peakTarget, forceOpenTarget);
          f.bloom += (target - f.bloom) * (1 - Math.exp(-dt / tauOpen));
        } else {
          f.peakTarget = Math.max(0, f.peakTarget - dt / this.closeDurationSec);
          f.bloom += (0 - f.bloom) * (1 - Math.exp(-dt / tauClose));
          if (f.bloom < 0.008) f.bloom = 0;
        }
      } else {
        // Default: 'realtime' — immediate bloom under hand, immediate smooth auto-close as hand leaves!
        const target = forceOpenTarget;
        const tau = target >= f.bloom ? tauOpen : tauClose;
        f.bloom += (target - f.bloom) * (1 - Math.exp(-dt / tau));
        if (target === 0 && f.bloom < 0.008) {
          f.bloom = 0;
        }
      }

      f.bloom = Math.max(0, Math.min(1, f.bloom));

      f.pollenCooldown = Math.max(0, f.pollenCooldown - dt);
      if (f.bloom - prevBloom > 0.01 && f.bloom > 0.28 && f.pollenCooldown <= 0) {
        const att = attractors[0];
        this.particles.emit(f.headX, f.headY, f.pollenColor, 1, att?.vx || 0, att?.vy || 0);
        f.pollenCooldown = 0.25 + Math.random() * 0.25;
      }
    }

    this.particles.update(dt, timeSec);
  }

  drawBackdropCover(ctx) {
    const bg = this.spriteStore.getBackdrop();
    if (!bg) {
      ctx.fillStyle = '#141B15';
      ctx.fillRect(0, 0, this.width, this.height);
      return;
    }
    const imgAspect = bg.width / bg.height;
    const vpAspect = this.width / this.height;
    let drawW = this.width;
    let drawH = this.height;
    let ox = 0;
    let oy = 0;

    if (vpAspect > imgAspect) {
      drawH = this.width / imgAspect;
      oy = (this.height - drawH) / 2;
    } else {
      drawW = this.height * imgAspect;
      ox = (this.width - drawW) / 2;
    }
    ctx.drawImage(bg, ox, oy, drawW, drawH);

    // Velvet chiaroscuro base glaze so foreground flowers pop with museum depth.
    ctx.fillStyle = 'rgba(12, 17, 13, 0.28)';
    ctx.fillRect(0, 0, this.width, this.height);
  }

  draw(timeSec) {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    this.drawBackdropCover(ctx);

    // Draw overlapping angled stems back-to-front by baseY.
    for (const f of this.flowers) {
      const sprite = this.spriteStore.getFrame(f.speciesId, f.bloom);
      if (!sprite) continue;

      const wind = Math.sin(timeSec * f.swaySpeed + f.swayPhase) * 0.026;
      const angle = f.baseLean + wind + f.pushLean;
      const drawW = f.size;
      const drawH = f.size;
      const anchorY = drawH * f.stemBottomRatio;

      ctx.save();
      ctx.translate(f.x, f.baseY);
      ctx.rotate(angle);
      ctx.scale(f.flipX, 1);

      // Subtle atmospheric depth dimming on far back rows.
      if (f.depthShade > 0.02 && f.bloom < 0.7) {
        ctx.globalAlpha = 1 - f.depthShade * (1 - f.bloom) * 0.45;
      }

      ctx.drawImage(sprite, -drawW / 2, -anchorY, drawW, drawH);
      ctx.restore();
    }

    // Rembrandt warm-gold gallery sunbeam & subtle edge vignette.
    const attractors = this.getActiveAttractors();
    if (attractors.length > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (const att of attractors) {
        const openFactor = this.gestureMode === 'position-only' ? 1.0 : att.openness;
        if (this.gestureMode === 'position-openness' && openFactor < 0.24) continue;
        const beamR = this.radius * (0.65 + 0.45 * openFactor);
        const beam = ctx.createRadialGradient(att.x, att.y, 0, att.x, att.y, beamR);
        beam.addColorStop(0, `rgba(255, 224, 162, ${0.22 * openFactor})`);
        beam.addColorStop(0.55, `rgba(232, 186, 114, ${0.09 * openFactor})`);
        beam.addColorStop(1, 'rgba(232, 186, 114, 0)');
        ctx.fillStyle = beam;
        ctx.beginPath();
        ctx.arc(att.x, att.y, beamR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Golden floating pollen motes.
    this.particles.draw(ctx);

    // Subtle museum edge vignette + fine classical linen glaze.
    const vig = ctx.createRadialGradient(
      this.width * 0.5,
      this.height * 0.46,
      Math.min(this.width, this.height) * 0.35,
      this.width * 0.5,
      this.height * 0.5,
      Math.hypot(this.width, this.height) * 0.62
    );
    vig.addColorStop(0, 'rgba(8, 12, 9, 0)');
    vig.addColorStop(1, 'rgba(8, 12, 9, 0.36)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, this.width, this.height);

    if (this.linenPattern) {
      ctx.fillStyle = this.linenPattern;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // Delicate antique-gold hairline reticle showing hand/pointer spatial aura.
    for (const att of attractors) {
      const openFactor = this.gestureMode === 'position-only' ? 1.0 : att.openness;
      const isFolding = this.gestureMode === 'position-openness' && openFactor < 0.24;
      const ringR = this.radius * (0.42 + 0.58 * openFactor);

      ctx.strokeStyle = isFolding
        ? 'rgba(220, 214, 200, 0.26)'
        : 'rgba(238, 204, 140, 0.34)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(att.x, att.y, ringR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = isFolding
        ? 'rgba(220, 214, 200, 0.55)'
        : 'rgba(245, 216, 158, 0.78)';
      ctx.beginPath();
      ctx.arc(att.x, att.y, 3.2, 0, Math.PI * 2);
      ctx.fill();

      if (att.label) {
        ctx.font = '500 10px Inter, sans-serif';
        ctx.fillStyle = 'rgba(245, 238, 224, 0.78)';
        ctx.fillText(att.label, att.x + 8, att.y - 8);
      }
    }

    ctx.restore();
  }

  emitStats(force = false) {
    const now = performance.now();
    if (!force && now - this.lastStatsEmit < 100) return;
    this.lastStatsEmit = now;

    let bloomedCount = 0;
    for (const f of this.flowers) {
      if (f.bloom >= 0.45) bloomedCount += 1;
    }
    this.onStats?.({
      bloomedCount,
      totalCount: this.flowers.length,
    });
  }

  loop = (now) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    const timeSec = now / 1000;

    this.update(dt, timeSec);
    this.draw(timeSec);
    this.emitStats(false);

    this.rafId = requestAnimationFrame(this.loop);
  };
}
