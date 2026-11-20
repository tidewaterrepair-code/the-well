// Demo build only (npm run build:demo). A pretend server so the Engine can be
// shown anywhere with no API: every chamber state, fake stock, fake souls.
// The real build never includes this file.
import scene from '../../config/scene.json';
import lore from '../../config/lore.json';
import chambers from '../../config/chambers.json';
import products from '../../config/products.json';
import type { Chamber, Product, State } from './types';

const HOUR = 3600_000;
const start = Date.now();

const extra: Product[] = [
  { id: 'bury-what-breaks', chamberId: 'i', name: "BURY WHAT BREAKS YOU", description: 'What is buried does not grow back. That is the point.', priceCents: 4200, images: ['img/products/placeholder-2.svg'], sizes: [{ size: 'S', remaining: 0 }, { size: 'M', remaining: 1 }, { size: 'L', remaining: 2 }, { size: 'XL', remaining: 0 }, { size: '2XL', remaining: 0 }] },
  { id: 'stay-buried', chamberId: 'ii', name: 'STAY BURIED', description: 'The first drop. Sealed the night it opened.', priceCents: 3800, images: ['img/products/placeholder-1.svg'], sizes: ['S', 'M', 'L', 'XL', '2XL'].map((size) => ({ size, remaining: 0 })) },
];

let souls = Array.from({ length: 46 }, (_, i) => ({ n: i + 1, c: 'iv' }));
let unlocked = false;

export function demoUnlock() { unlocked = true; }
export function demoAddSoul() { souls = [...souls, { n: souls.length + 1, c: 'iv' }]; }

export function demoState(): State {
  const status: Record<string, Chamber['status']> = { i: 'live', ii: 'soldout', iii: 'countdown', iv: 'live', v: 'locked' };
  const real: Product[] = (products as any[]).map((p, k) => ({
    id: p.id, chamberId: p.chamberId, name: p.name, description: p.description, priceCents: p.priceCents, images: p.images,
    sizes: p.sizes.map((s: any, i: number) => ({ size: s.size, remaining: [[6, 9, 4, 0, 3], [2, 5, 7, 6, 0]][k % 2][i % 5] })),
  }));
  const secret: Product[] = unlocked ? [{ id: 'the-ascent', chamberId: 'v', name: 'THE KEEPER', description: 'Not sold. Found. For those who looked where the light does not reach.', priceCents: 5400, images: ['img/products/placeholder-1.svg'], sizes: ['S', 'M', 'L', 'XL', '2XL'].map((size) => ({ size, remaining: 3 })) }] : [];
  const all = [...real, ...extra, ...secret];
  return {
    scene: scene as State['scene'],
    lore: { ...lore, taglines: [lore.taglines[0], 'DEMO BUILD · PLACEHOLDER FRAMES'] },
    chambers: (chambers as any[]).map((c) => {
      const mine = all.filter((p) => p.chamberId === c.id);
      const remaining = mine.reduce((n, p) => n + p.sizes.reduce((m, z) => m + z.remaining, 0), 0);
      return {
        id: c.id, numeral: c.numeral, name: c.name, frame: c.frame, lon: c.lon ?? 0, lat: c.lat ?? 0, scrollLine: c.scrollLine,
        status: status[c.id] ?? 'dormant',
        goesLiveAt: c.id === 'iii' ? new Date(start + 9 * HOUR + 14 * 60_000).toISOString() : null,
        total: mine.length * 50, remaining,
      };
    }),
    products: all,
    souls,
    now: Date.now(), online: 9 + Math.round(3 * Math.sin(Date.now() / 20000)), checkout: false, unlocked, demo: true,
  };
}
