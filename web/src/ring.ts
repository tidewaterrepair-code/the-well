// The ring: N frames of the sphere turning once. Loads coarse-to-fine so the
// sphere can spin within a moment, then fills in the in-between frames.
import type { Scene } from './types';
import { mod } from './types';

export class Ring {
  readonly n: number;
  readonly imgs: (HTMLImageElement | null)[];
  private size: number;
  loadedCount = 0;

  constructor(private scene: Scene, needWidth: number) {
    this.n = scene.ring.frames;
    this.imgs = new Array(this.n).fill(null);
    const sizes = [...scene.ring.sizes].sort((a, b) => a - b);
    this.size = sizes.find((s) => s >= needWidth * 0.8) ?? sizes[sizes.length - 1];
  }

  url(i: number) {
    const r = this.scene.ring;
    return `frames/${this.size}/${String(mod(i, this.n) + 1).padStart(3, '0')}.${r.ext}?v=${r.version}`;
  }

  private loadOne(i: number): Promise<void> {
    return new Promise((done) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { this.imgs[i] = img; this.loadedCount++; done(); };
      img.onerror = () => done();
      img.src = this.url(i);
    });
  }

  /** Resolves once frame `start` is ready; keeps loading the rest in the background. */
  async load(start: number, onProgress: (fraction: number) => void): Promise<void> {
    start = mod(Math.round(start), this.n);
    await this.loadOne(start);
    onProgress(1 / this.n);
    const order: number[] = [];
    const seen = new Set([start]);
    for (const stride of [8, 4, 2, 1]) {
      for (let k = 0; k < this.n; k += stride) {
        // fan out from the starting frame so its neighbours arrive first
        const half = Math.ceil(k / 2) * (k % 2 ? 1 : -1);
        const i = mod(start + (stride === 1 ? half : k), this.n);
        if (!seen.has(i)) { seen.add(i); order.push(i); }
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < order.length) {
        await this.loadOne(order[next++]);
        onProgress(this.loadedCount / this.n);
      }
    };
    void Promise.all(Array.from({ length: 6 }, worker));
  }

  /** The closest frame that has finished loading (searching outward from i). */
  nearest(i: number): number {
    i = mod(i, this.n);
    for (let d = 0; d <= this.n / 2; d++) {
      if (this.imgs[mod(i + d, this.n)]) return mod(i + d, this.n);
      if (this.imgs[mod(i - d, this.n)]) return mod(i - d, this.n);
    }
    return i;
  }
}
