export type Status = 'live' | 'countdown' | 'soldout' | 'locked' | 'archived' | 'dormant';

export interface Chamber {
  id: string; numeral: string; name: string;
  frame: number; lon: number; lat: number;
  status: Status; goesLiveAt: string | null; scrollLine: string; plate?: string | null;
  total: number; remaining: number;
}
export interface Product {
  id: string; chamberId: string; name: string; description: string;
  priceCents: number; images: string[];
  sizes: { size: string; remaining: number }[];
}
export interface Scene {
  ring: { frames: number; sizes: number[]; ext: string; aspect: number; version: string; dir: number; sphere: { cx: number; cy: number; r: number } };
  sigils: { id: string; frame: number; lat: number }[];
}
export interface State {
  scene: Scene; lore: Record<string, any>;
  chambers: Chamber[]; products: Product[];
  souls: { n: number; c: string }[];
  now: number; online: number; checkout: boolean; unlocked: boolean;
  demo?: boolean;
}

/** Everything the renderers need to know about where the sphere is on screen. */
export interface View {
  w: number; h: number; phone: boolean;
  cx: number; cy: number; R: number;      // sphere centre and radius, CSS px
  pos: number;                            // ring position in frames (unbounded float)
  px: number; py: number;                 // smoothed pointer / tilt, -1..1
  t: number;                              // seconds
  life: number; shaft: number; night: number; dim: number; flick: number;
}

export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = (t: number) => t * t * (3 - 2 * t);
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const money = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
export const pad3 = (n: number) => String(n).padStart(3, '0');
export const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Where a point on the sphere's surface lands on screen. z > 0 means it faces the viewer. */
export function project(v: View, frames: number, dir: number, frame: number, lonDeg: number, latDeg: number) {
  let a = (lonDeg * Math.PI) / 180 + (TAU * dir * (frame - v.pos)) / frames;
  a = Math.atan2(Math.sin(a), Math.cos(a));
  const lat = (latDeg * Math.PI) / 180;
  const z = Math.cos(a) * Math.cos(lat);
  const par = 0.012 + 0.05 * Math.max(0, z); // matches the shader's parallax
  return {
    x: v.cx + v.R * (Math.sin(a) * Math.cos(lat) + v.px * par),
    y: v.cy + v.R * (-Math.sin(lat) + v.py * par),
    z,
  };
}

/** Stable pseudo-random 0..1 from an integer, so soul #47 always burns in the same place. */
export function hash01(n: number, salt = 0) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d); x ^= x >>> 12; x = Math.imul(x, 0x297a2d39); x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

export const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
