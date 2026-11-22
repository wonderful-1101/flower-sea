/**
 * Real-time canvas renderer and spatial blooming force-field engine for FLORA FIELD.
 */

import { generateFlowerField } from './fieldLayout.js';
import { PollenSystem } from './particles.js';

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function createPaperGrainPattern(ctx) {
  const tile = document.createElement('canvas');
  tile.width = 128;
  tile.height = 128;
  const tctx = tile.getContext('2d');
  const imgData = tctx.createImageData(128, 128);
  const data = imgData.data;

  // Deterministic subtle paper texture.
  let seed = 918273;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < data.length; i += 4) {
    const v = 236 + Math.floor((rand() - 0.5) * 14);
    data[i] = v;
    data[i + 1] = v - 3;
    data[i + 2] = v - 9;
    data[i + 3] = 28;
  }
  tctx.putImageData(imgData, 0, 0);
  return ctx.createPattern(tile, 'repeat');
}

export class FieldEngine {
  constructor({ canvas, spriteStore, onStats }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.spriteStore = spriteStore;
    this.onStats = onStats;

    this.pollen = new PollenSystem(200);
    this.paperPattern = createPaperGrainPattern(this.ctx);

    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.flowers = [];
    this.density = 68;
    this.radius = 250;
    this.lingerScale = 1.0; // multiplier on baseLinger (1.5-2.3s)
    this.hoverMode = 'linger'; // 'linger' | 'spotlight' | 'paint'
    this.gestureMode = 'position-openness'; // 'position-openness' | 'position-only'
    this.seed = 20261123;

    // Active spatial attractors from mediaPipe hands and/or mouse pointer.
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
    // Preserve bloomed state lightly if resizing same seed, or start fresh on newSeed.
    const oldBlooms = !newSeed ? this.flowers.map((f) => f.bloom) : [];
    const responsiveTarget = Math.round(
      this.density * Math.min(1.25, Math.max(0.55, (this.width * this.height) / (1440 * 900)))
    );
    this.flowers = generateFlowerField({
      width: this.width,
      height: this.height,
      speciesList: this.spriteStore.getSpecies(),
      targetCount: Math.max(24, responsiveTarget),
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

  setHoverMode(mode) {
    this.hoverMode = mode;
  }

  setGestureMode(mode) {
    this.gestureMode = mode;
  }

  setRadius(radiusPx) {
    this.radius = radiusPx;
  }

  setLingerScale(scale) {
    this.lingerScale = scale;
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
      f.lingerTimer = f.baseLinger * this.lingerScale;
    }
  }

  closeAll() {
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
    for (const h of this.handAttractors) {
      list.push(h);
    }
    if (this.pointerAttractor) {
      list.push(this.pointerAttractor);
    }
    return list;
  }

  update(dt, timeSec) {
    const attractors = this.getActiveAttractors();
    const radius = this.radius;

    for (const f of this.flowers) {
      let maxInfluence = 0;
      let forceOpenTarget = 0;
      let activeFold = false;
      let pushX = 0;
      let pushY = 0;
      let pushAngle = 0;

      for (const att of attractors) {
        const dx = f.x - att.x;
        const dy = f.y - att.y;
        const dist = Math.hypot(dx, dy);

        if (dist < radius) {
          const falloff = 1 - smoothstep(0, radius, dist);
          if (falloff > maxInfluence) {
            maxInfluence = falloff;
          }

          // Determine desired openness inside the aura.
          const effectiveOpen =
            this.gestureMode === 'position-only' ? 1.0 : att.openness;

          if (this.gestureMode === 'position-openness' && effectiveOpen < 0.24) {
            // Closed fist inside the region actively folds nearby flowers back!
            activeFold = true;
          } else {
            // Boost inner core slightly so hovered flowers open lushly to 100%.
            const target = Math.min(1, falloff * 1.18) * effectiveOpen;
            if (target > forceOpenTarget) {
              forceOpenTarget = target;
            }
          }

          // Gentle physical brush displacement as hand/cursor sweeps past.
          const vx = att.vx || 0;
          const vy = att.vy || 0;
          const speed = Math.min(1, Math.hypot(vx, vy) / 480);
          if (dist > 4) {
            const nx = dx / dist;
            const ny = dy / dist;
            pushX += (nx * 9 + vx * 0.015) * falloff * (0.4 + speed);
            pushY += (ny * 9 + vy * 0.015) * falloff * (0.4 + speed);
            pushAngle += ((vx * ny - vy * nx) * 0.00025) * falloff;
          }
        }
      }

      // Spring-damp physical brush displacement.
      const pushLerp = 1 - Math.exp(-8 * dt);
      f.pushX += (pushX - f.pushX) * pushLerp;
      f.pushY += (pushY - f.pushY) * pushLerp;
      f.pushAngle += (pushAngle - f.pushAngle) * pushLerp;

      const prevBloom = f.bloom;

      if (activeFold && maxInfluence > 0.15) {
        // Closed fist actively folds flowers back regardless of hover mode.
        f.lingerTimer = 0;
        f.peakTarget = Math.min(f.peakTarget, 1 - maxInfluence);
        const foldBlend = 1 - Math.exp(-(3.4 * maxInfluence + 1.0) * dt);
        f.bloom += (0 - f.bloom) * foldBlend;
      } else if (this.hoverMode === 'spotlight') {
        const target = forceOpenTarget;
        const speed = target > f.bloom ? 4.8 : 2.1;
        f.bloom += (target - f.bloom) * (1 - Math.exp(-speed * dt));
      } else if (this.hoverMode === 'paint') {
        if (forceOpenTarget > f.peakTarget) {
          f.peakTarget = forceOpenTarget;
        }
        const blend = 1 - Math.exp(-4.8 * dt);
        f.bloom += (f.peakTarget - f.bloom) * blend;
      } else {
        // Default: 'linger' (拖尾余韵)
        if (forceOpenTarget > 0.05) {
          if (forceOpenTarget >= f.peakTarget) {
            f.peakTarget = forceOpenTarget;
          }
          // Refresh linger timer proportional to influence so moving past leaves a trail.
          f.lingerTimer = Math.max(f.lingerTimer, f.baseLinger * this.lingerScale * Math.min(1, maxInfluence * 1.4));
        } else if (f.lingerTimer > 0) {
          f.lingerTimer = Math.max(0, f.lingerTimer - dt);
        }

        if (f.lingerTimer > 0 || forceOpenTarget > 0.05) {
          const target = Math.max(f.peakTarget, forceOpenTarget);
          const blend = 1 - Math.exp(-4.8 * dt);
          f.bloom += (target - f.bloom) * blend;
        } else {
          f.peakTarget = Math.max(0, f.peakTarget - f.closeRate * dt);
          f.bloom = Math.max(0, f.bloom - f.closeRate * dt);
        }
      }

      f.bloom = Math.max(0, Math.min(1, f.bloom));

      // Emit delicate pollen when a flower actively blooms open.
      f.pollenCooldown = Math.max(0, f.pollenCooldown - dt);
      const deltaBloom = f.bloom - prevBloom;
      if (deltaBloom > 0.008 && f.bloom > 0.28 && f.pollenCooldown <= 0) {
        const att = attractors[0];
        this.pollen.emit(f.x, f.y, f.pollenColor, 1, att?.vx || 0, att?.vy || 0);
        f.pollenCooldown = 0.22 + Math.random() * 0.25;
      }
    }

    this.pollen.update(dt, timeSec);
  }

  draw(timeSec) {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Warm matte gallery paper backdrop + subtle fine-art rag grain.
    ctx.fillStyle = '#F4F1EA';
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.paperPattern) {
      ctx.fillStyle = this.paperPattern;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // Draw flowers back-to-front by layer.
    for (const f of this.flowers) {
      const sprite = this.spriteStore.getFrame(f.speciesId, f.bloom);
      if (!sprite) continue;

      const windAngle = Math.sin(timeSec * f.swaySpeed + f.swayPhase) * 0.045;
      const windX = Math.cos(timeSec * 0.7 + f.swayPhase) * (1.2 + f.bloom * 1.4);
      const windY = Math.sin(timeSec * 0.55 + f.swayPhase) * (0.9 + f.bloom * 1.0);

      const drawX = f.x + f.pushX + windX;
      const drawY = f.y + f.pushY + windY;
      const size = f.baseSize * (0.94 + 0.08 * f.bloom);
      const rot = f.baseAngle + windAngle + f.pushAngle;

      // Soft botanical contact shadow beneath each flower (fast gradient ellipse).
      const shadowRadius = size * (0.20 + 0.16 * f.bloom);
      const grad = ctx.createRadialGradient(
        drawX + 4,
        drawY + 7,
        shadowRadius * 0.15,
        drawX + 4,
        drawY + 7,
        shadowRadius
      );
      grad.addColorStop(0, `rgba(60, 52, 42, ${0.10 + 0.05 * f.bloom})`);
      grad.addColorStop(1, 'rgba(60, 52, 42, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(drawX + 4, drawY + 7, shadowRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.translate(drawX, drawY);
      ctx.rotate(rot);
      ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
      ctx.restore();
    }

    // Pollen motes gently floating above the canopy.
    this.pollen.draw(ctx);

    // Subtle spatial aura rings showing active hand / pointer bloom region.
    const attractors = this.getActiveAttractors();
    for (const att of attractors) {
      const openFactor = this.gestureMode === 'position-only' ? 1.0 : att.openness;
      const visualR = this.radius * (0.45 + 0.55 * openFactor);
      const isFolding = this.gestureMode === 'position-openness' && openFactor < 0.24;

      const aura = ctx.createRadialGradient(att.x, att.y, 0, att.x, att.y, visualR);
      if (isFolding) {
        aura.addColorStop(0, 'rgba(130, 122, 112, 0.10)');
        aura.addColorStop(1, 'rgba(130, 122, 112, 0)');
      } else {
        aura.addColorStop(0, 'rgba(235, 198, 132, 0.13)');
        aura.addColorStop(0.65, 'rgba(235, 198, 132, 0.04)');
        aura.addColorStop(1, 'rgba(235, 198, 132, 0)');
      }
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(att.x, att.y, visualR, 0, Math.PI * 2);
      ctx.fill();

      // Minimal hairline ring + subtle center reticle.
      ctx.strokeStyle = isFolding ? 'rgba(60, 55, 50, 0.22)' : 'rgba(182, 146, 94, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(att.x, att.y, visualR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = isFolding ? 'rgba(60, 55, 50, 0.45)' : 'rgba(176, 138, 86, 0.6)';
      ctx.beginPath();
      ctx.arc(att.x, att.y, 3.2, 0, Math.PI * 2);
      ctx.fill();

      if (att.label) {
        ctx.font = '500 10px Inter, sans-serif';
        ctx.fillStyle = 'rgba(42, 39, 34, 0.58)';
        ctx.fillText(att.label, att.x + 8, att.y - 8);
      }
    }

    ctx.restore();
  }

  emitStats(force = false) {
    const now = performance.now();
    if (!force && now - this.lastStatsEmit < 120) return;
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
