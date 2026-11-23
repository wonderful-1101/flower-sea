/**
 * Generates a natural 3-layer full-viewport sea of flowers using seeded Bridson
 * Poisson Disk Sampling plus explicit quadrant & corner coverage guarantees.
 */

function createRng(seed = 20261123) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pickWeightedSpecies(speciesList, rng) {
  const total = speciesList.reduce((acc, s) => acc + (s.weight || 1), 0);
  let roll = rng() * total;
  for (const sp of speciesList) {
    roll -= sp.weight || 1;
    if (roll <= 0) return sp;
  }
  return speciesList[0];
}

function poissonDiskPoints(width, height, minDist, rng, k = 28) {
  const cellSize = minDist / Math.SQRT2;
  const cols = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));
  const grid = new Array(cols * rows).fill(-1);
  const points = [];
  const active = [];

  const insert = (x, y) => {
    const idx = points.length;
    points.push({ x, y });
    active.push(idx);
    const gx = Math.min(cols - 1, Math.max(0, Math.floor(x / cellSize)));
    const gy = Math.min(rows - 1, Math.max(0, Math.floor(y / cellSize)));
    grid[gy * cols + gx] = idx;
  };

  // Seed across the 4 quadrants + center so every corner (especially top-right) starts lush.
  const seeds = [
    [width * 0.82, height * 0.22],
    [width * 0.18, height * 0.22],
    [width * 0.82, height * 0.78],
    [width * 0.18, height * 0.78],
    [width * 0.50, height * 0.50],
  ];
  for (const [sx, sy] of seeds) {
    insert(
      Math.max(16, Math.min(width - 16, sx + (rng() - 0.5) * 40)),
      Math.max(16, Math.min(height - 16, sy + (rng() - 0.5) * 40))
    );
  }

  while (active.length > 0) {
    const activePos = Math.floor(rng() * active.length);
    const origin = points[active[activePos]];
    let found = false;

    for (let i = 0; i < k; i += 1) {
      const angle = rng() * Math.PI * 2;
      const radius = minDist * (1 + rng());
      const nx = origin.x + Math.cos(angle) * radius;
      const ny = origin.y + Math.sin(angle) * radius;

      if (nx < 24 || nx > width - 24 || ny < 24 || ny > height - 24) continue;

      const gx = Math.floor(nx / cellSize);
      const gy = Math.floor(ny / cellSize);
      let ok = true;

      for (let yy = Math.max(0, gy - 2); yy <= Math.min(rows - 1, gy + 2) && ok; yy += 1) {
        for (let xx = Math.max(0, gx - 2); xx <= Math.min(cols - 1, gx + 2); xx += 1) {
          const neighborIdx = grid[yy * cols + xx];
          if (neighborIdx !== -1) {
            const p = points[neighborIdx];
            if (Math.hypot(p.x - nx, p.y - ny) < minDist) {
              ok = false;
              break;
            }
          }
        }
      }

      if (ok) {
        insert(nx, ny);
        found = true;
        break;
      }
    }

    if (!found) {
      active.splice(activePos, 1);
    }
  }

  return points;
}

export function generateFlowerField({
  width,
  height,
  speciesList,
  targetCount = 68,
  seed = 20261123,
}) {
  if (!speciesList.length || width < 60 || height < 60) return [];

  const rng = createRng(seed);
  const padX = Math.max(46, Math.min(82, width * 0.045));
  const padY = Math.max(54, Math.min(86, height * 0.065));
  const usableW = Math.max(200, width - padX * 2);
  const usableH = Math.max(200, height - padY * 2);

  // Estimate spacing so Poisson disk yields slightly above targetCount, then trim evenly.
  const area = usableW * usableH;
  const minDist = Math.max(66, Math.sqrt(area / (targetCount * 1.42)));
  let pts = poissonDiskPoints(usableW, usableH, minDist, rng);

  // Ensure corner pockets (top-right, top-left, bottom-left, bottom-right) have at least 4 flowers.
  const corners = [
    { xMin: usableW * 0.72, xMax: usableW, yMin: 0, yMax: usableH * 0.34 },
    { xMin: 0, xMax: usableW * 0.28, yMin: 0, yMax: usableH * 0.34 },
    { xMin: 0, xMax: usableW * 0.28, yMin: usableH * 0.66, yMax: usableH },
    { xMin: usableW * 0.72, xMax: usableW, yMin: usableH * 0.66, yMax: usableH },
  ];
  for (const box of corners) {
    const inside = pts.filter(
      (p) => p.x >= box.xMin && p.x <= box.xMax && p.y >= box.yMin && p.y <= box.yMax
    );
    for (let missing = Math.max(0, 4 - inside.length); missing > 0; missing -= 1) {
      pts.push({
        x: box.xMin + (box.xMax - box.xMin) * (0.15 + rng() * 0.7),
        y: box.yMin + (box.yMax - box.yMin) * (0.15 + rng() * 0.7),
      });
    }
  }

  // Shuffle deterministically before trimming if oversampled.
  for (let i = pts.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  if (pts.length > targetCount) {
    pts = pts.slice(0, targetCount);
  }

  const baseUnit = Math.max(106, Math.min(182, Math.sqrt(area / Math.max(24, targetCount)) * 1.24));

  const flowers = pts.map((pt, idx) => {
    const roll = rng();
    const layer = roll < 0.42 ? 0 : roll < 0.80 ? 1 : 2;
    const scaleRange =
      layer === 0 ? [0.64, 0.82] : layer === 1 ? [0.84, 1.04] : [1.06, 1.26];
    const scale = scaleRange[0] + rng() * (scaleRange[1] - scaleRange[0]);
    const species = pickWeightedSpecies(speciesList, rng);

    return {
      id: idx,
      speciesId: species.id,
      pollenColor: species.pollenColor || '#E8B0BA',
      x: padX + pt.x,
      y: padY + pt.y,
      baseSize: baseUnit * scale,
      layer,
      baseAngle: rng() * Math.PI * 2,
      swayPhase: rng() * Math.PI * 2,
      swaySpeed: 0.75 + rng() * 0.55,
      bloom: 0,
      peakTarget: 0,
      lingerTimer: 0,
      baseLinger: 1.5 + rng() * 0.85,
      closeRate: 0.22 + rng() * 0.14,
      pushX: 0,
      pushY: 0,
      pushAngle: 0,
      pollenCooldown: 0,
    };
  });

  // Sort back-to-front by layer, then y for natural depth overlap.
  flowers.sort((a, b) => (a.layer - b.layer) || (a.y - b.y));
  return flowers;
}
