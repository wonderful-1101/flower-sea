/**
 * Preloads WebP frame sequences into ImageBitmaps for zero-latency scrubbing.
 * Also supports registering runtime-imported custom MP4 specimens.
 */

export class FrameStore {
  constructor() {
    /** @type {Array<Object>} */
    this.specimens = [];
    /** @type {Map<string, Array<ImageBitmap|HTMLImageElement>>} */
    this.framesById = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.loadingPromises = new Map();
  }

  async loadManifest(url = '/flowers.json') {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to load specimen manifest (${resp.status})`);
    }
    this.specimens = await resp.json();
    return this.specimens;
  }

  getSpecimens() {
    return this.specimens;
  }

  getSpecimen(id) {
    return this.specimens.find((s) => s.id === id) || null;
  }

  isLoaded(id) {
    const spec = this.getSpecimen(id);
    const frames = this.framesById.get(id);
    return Boolean(spec && frames && frames.length >= spec.frameCount && frames.every(Boolean));
  }

  getLoadProgress(id) {
    const spec = this.getSpecimen(id);
    const frames = this.framesById.get(id);
    if (!spec || !frames) return 0;
    const loaded = frames.reduce((acc, item) => acc + (item ? 1 : 0), 0);
    return loaded / Math.max(1, spec.frameCount);
  }

  /**
   * Preload all frames for a specimen using bounded HTTP concurrency.
   * @param {string} id
   * @param {(ratio: number) => void} [onProgress]
   */
  preloadSpecimen(id, onProgress) {
    if (this.loadingPromises.has(id)) {
      return this.loadingPromises.get(id);
    }

    const spec = this.getSpecimen(id);
    if (!spec) {
      return Promise.resolve();
    }

    const total = spec.frameCount;
    const slots = new Array(total).fill(null);
    this.framesById.set(id, slots);

    let completed = 0;
    let cursor = 0;
    const concurrency = 6;

    const loadSingleFrame = async (idx) => {
      const padded = String(idx).padStart(3, '0');
      const url = `${spec.frameDir}/frame_${padded}.webp`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Frame fetch failed: ${url}`);
      }
      const blob = await response.blob();
      slots[idx] = await createImageBitmap(blob);
      completed += 1;
      onProgress?.(completed / total);
    };

    const worker = async () => {
      while (cursor < total) {
        const idx = cursor;
        cursor += 1;
        await loadSingleFrame(idx);
      }
    };

    const promise = Promise.all(
      Array.from({ length: Math.min(concurrency, total) }, () => worker())
    ).then(() => {
      onProgress?.(1);
    });

    this.loadingPromises.set(id, promise);
    return promise;
  }

  /**
   * Return the closest loaded ImageBitmap for the given progress [0, 1].
   */
  getFrame(id, progress01) {
    const frames = this.framesById.get(id);
    if (!frames || frames.length === 0) return null;

    const clamped = Math.max(0, Math.min(1, progress01));
    const idx = Math.min(frames.length - 1, Math.round(clamped * (frames.length - 1)));
    if (frames[idx]) return frames[idx];

    // Fallback to nearest already-decoded frame while still preloading.
    for (let offset = 1; offset < frames.length; offset += 1) {
      if (idx - offset >= 0 && frames[idx - offset]) return frames[idx - offset];
      if (idx + offset < frames.length && frames[idx + offset]) return frames[idx + offset];
    }
    return null;
  }

  /**
   * Register a custom MP4 specimen imported by the user at runtime.
   */
  addCustomSpecimen(specimen, bitmaps) {
    this.specimens.push(specimen);
    this.framesById.set(specimen.id, bitmaps);
    this.loadingPromises.set(specimen.id, Promise.resolve());
    return specimen;
  }
}
