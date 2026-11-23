/**
 * Sunlit golden dust motes & occasional drifting petal flecks for the oil-painting tapestry.
 */

export class ChiaroscuroParticles {
  constructor(maxParticles = 180) {
    this.maxParticles = maxParticles;
    this.particles = [];
  }

  emit(x, y, color = '#F6D48F', count = 1, vxBias = 0, vyBias = 0) {
    for (let i = 0; i < count; i += 1) {
      if (this.particles.length >= this.maxParticles) {
        this.particles.shift();
      }
      const angle = Math.random() * Math.PI * 2;
      const speed = 8 + Math.random() * 24;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 34,
        y: y + (Math.random() - 0.5) * 34,
        vx: Math.cos(angle) * speed + vxBias * 0.14,
        vy: Math.sin(angle) * speed - 10 + vyBias * 0.14,
        radius: 1.3 + Math.random() * 2.1,
        life: 0,
        maxLife: 1.2 + Math.random() * 1.4,
        color,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  update(dt, timeSec) {
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
        continue;
      }
      const driftX = Math.sin(timeSec * 1.1 + p.phase) * 9;
      const driftY = Math.cos(timeSec * 0.8 + p.phase) * 5 - 8;
      p.x += (p.vx + driftX) * dt;
      p.y += (p.vy + driftY) * dt;
      p.vx *= Math.exp(-1.6 * dt);
      p.vy *= Math.exp(-1.6 * dt);
    }
  }

  draw(ctx) {
    if (this.particles.length === 0) return;
    ctx.save();
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      const alpha = Math.sin(t * Math.PI) * 0.72;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
