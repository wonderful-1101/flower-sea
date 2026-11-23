/**
 * Preloads the 2K foliage oil-painting backdrop and all 5 angled botanical sprite sequences.
 */

export class SpriteStore {
  constructor() {
    /** @type {Array<Object>} */
    this.species = [];
    /** @type {Map<string, Array<ImageBitmap>>} */
    this.framesBySpecies = new Map();
    /** @type {ImageBitmap|null} */
    this.backdrop = null;
    this.ready = false;
  }

  async loadAll(manifestUrl = '/species.json', onProgress) {
    const [resp, bgResp] = await Promise.all([
      fetch(manifestUrl),
      fetch('/bg-foliage.webp'),
    ]);
    if (!resp.ok) {
      throw new Error(`无法加载花卉配置 (${resp.status})`);
    }
    if (!bgResp.ok) {
      throw new Error(`无法加载油画底图 (${bgResp.status})`);
    }

    this.species = await resp.json();
    const bgBlob = await bgResp.blob();
    this.backdrop = await createImageBitmap(bgBlob);

    const jobs = [];
    for (const sp of this.species) {
      const slots = new Array(sp.frameCount).fill(null);
      this.framesBySpecies.set(sp.id, slots);
      for (let i = 0; i < sp.frameCount; i += 1) {
        jobs.push({ sp, idx: i, slots });
      }
    }

    const total = jobs.length;
    let completed = 0;
    let cursor = 0;
    const concurrency = 8;

    const worker = async () => {
      while (cursor < total) {
        const job = jobs[cursor];
        cursor += 1;
        const padded = String(job.idx).padStart(3, '0');
        const url = `${job.sp.frameDir}/frame_${padded}.webp`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`加载花朵贴图失败: ${url}`);
        }
        const blob = await res.blob();
        job.slots[job.idx] = await createImageBitmap(blob);
        completed += 1;
        onProgress?.(completed / Math.max(1, total));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, total) }, () => worker())
    );

    this.ready = true;
    onProgress?.(1);
    return this.species;
  }

  getBackdrop() {
    return this.backdrop;
  }

  getSpecies() {
    return this.species;
  }

  getFrame(speciesId, bloom01) {
    const frames = this.framesBySpecies.get(speciesId);
    if (!frames || frames.length === 0) return null;
    const clamped = Math.max(0, Math.min(1, bloom01));
    const idx = Math.min(frames.length - 1, Math.round(clamped * (frames.length - 1)));
    return frames[idx] || null;
  }
}
