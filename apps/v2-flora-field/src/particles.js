/**
 * Lightweight golden & petal-tinted pollen motes emitted when flowers bloom or hands sweep through.
 */

export class PollenSystem {
  constructor(maxParticles = 180) {
    this.maxParticles = maxParticles;
    this.particles = [];
  }

  emit(x, y, color = '#E8B0BA', count = 1, vxBias = 0, vyBias = 0) {
    for (let i = 0; i < count; i += 1) {
      if (this.particles.length >= this.maxParticles) {
        this.particles.shift();
      }
      const angle = Math.random() * Math.PI * 2;
      const speed = 10 + Math.random() * 26;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 28,
        y: y + (Math.random() - 0.5) * 28,
        vx: Math.cos(angle) * speed + vxBias * 0.15,
        vy: Math.sin(angle) * speed - 8 + vyBias * 0.15,
        radius: 1.4 + Math.random() * 2.2,
        life: 0,
        maxLife: 1.4 + Math.random() * 1.4,
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
      const breezeX = Math.sin(timeSec * 1.3 + p.phase) * 10;
      const breezeY = Math.cos(timeSec * 0.9 + p.phase) * 6 - 6;
      p.x += (p.vx + breezeX) * dt;
      p.y += (p.vy + breezeY) * dt;
      p.vx *= Math.exp(-1.5 * dt);
      p.vy *= Math.exp(-1.5 * dt);
    }
  }

  draw(ctx) {
    if (this.particles.length === 0) return;
    ctx.save();
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      const alpha = Math.sin(t * Math.PI) * 0.65;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
