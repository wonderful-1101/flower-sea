/**
 * Generates a brimming, multi-row Dutch Golden Age botanical oil tapestry.
 * Flowers sit in staggered back-to-front depth rows sorted by stem base `baseY`,
 * ensuring stems naturally tuck behind foreground blossoms with zero floating cutouts.
 */

function createRng(seed = 20261123) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pickDiverseSpecies(speciesList, placed, x, baseY, rng) {
  // Penalize species that already appear close by so every hand-sized area feels lush & varied.
  const weights = speciesList.map((sp) => {
    let penalty = 1.0;
    for (let i = placed.length - 1; i >= Math.max(0, placed.length - 18); i -= 1) {
      const other = placed[i];
      if (other.speciesId === sp.id) {
        const d = Math.hypot(other.x - x, other.baseY - baseY);
        if (d < 220) {
          penalty *= 0.12;
        }
      }
    }
    return (sp.weight || 1.0) * penalty;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < speciesList.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return speciesList[i];
  }
  return speciesList[0];
}

export function generateOilTapestry({
  width,
  height,
  speciesList,
  targetCount = 96,
  seed = 20261123,
}) {
  if (!speciesList.length || width < 80 || height < 80) return [];

  const rng = createRng(seed);
  const rows = Math.max(5, Math.min(8, Math.round(Math.sqrt(targetCount * (height / Math.max(1, width)) * 0.65))));
  const baseUnit = Math.max(170, Math.min(265, Math.sqrt((width * height) / Math.max(36, targetCount)) * 1.72));

  // Build row counts slightly denser toward midground and foreground.
  const perRowBase = Math.max(6, Math.round(targetCount / rows));
  const placed = [];

  for (let r = 0; r < rows; r += 1) {
    const rowNorm = rows > 1 ? r / (rows - 1) : 0.5;
    // Start heads near top edge (~14% down) and push bottom row bases slightly below bottom edge (108%).
    const rowBaseY = height * (0.20 + rowNorm * 0.88);
    const cols = Math.max(5, perRowBase + (r % 2 === 0 ? 1 : -1) + (r === rows - 1 ? 1 : 0));
    const depthScale = 0.80 + rowNorm * 0.44;
    const depthShade = (1 - rowNorm) * 0.22;

    for (let c = 0; c < cols; c += 1) {
      // Stagger alternate rows and allow generous horizontal bleed (-3%..103%) so corners stay packed.
      const stagger = r % 2 === 1 ? 0.5 / cols : 0;
      const u = (c + 0.5) / cols + stagger - 0.5 / (cols * 2);
      const x = width * (-0.02 + u * 1.04) + (rng() - 0.5) * (width / cols) * 0.42;
      const baseY = rowBaseY + (rng() - 0.5) * (height / rows) * 0.36;

      const sp = pickDiverseSpecies(speciesList, placed, x, baseY, rng);
      const size = baseUnit * depthScale * (0.90 + rng() * 0.22);
      const flipX = rng() < 0.5 ? 1 : -1;
      const baseLean = (rng() - 0.5) * 0.46; // gentle +/- 13 deg upright/angled grace

      const headYRatio = sp.headYRatio ?? 0.40;
      const stemBottomRatio = sp.stemBottomRatio ?? 0.96;
      const stemOffset = size * (stemBottomRatio - headYRatio);
      const headX = x + Math.sin(baseLean) * stemOffset;
      const headY = baseY - Math.cos(baseLean) * stemOffset;

      placed.push({
        id: placed.length,
        speciesId: sp.id,
        pollenColor: sp.pollenColor || '#F2C5D0',
        stemBottomRatio,
        headYRatio,
        x,
        baseY,
        headX,
        headY,
        size,
        row: r,
        flipX,
        baseLean,
        depthShade,
        swayPhase: rng() * Math.PI * 2,
        swaySpeed: 0.70 + rng() * 0.45,
        bloom: 0,
        peakTarget: 0,
        lingerTimer: 0,
        pushLean: 0,
        pollenCooldown: 0,
      });
    }
  }

  // Strictly sort back-to-front by stem base Y so foreground blossoms naturally cover rear stems.
  placed.sort((a, b) => a.baseY - b.baseY);
  return placed;
}
