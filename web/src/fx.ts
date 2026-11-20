// The living layer drawn over the sphere: one lantern per buyer (a "soul"),
// faint drifting lights for everyone on the site right now, hidden sigils, sparks.
import type { State, View } from './types';
import { TAU, hash01, project } from './types';

interface Spark { x: number; y: number; vx: number; vy: number; life: number; warm: boolean }

export class Fx {
  private g: CanvasRenderingContext2D;
  private dpr = 1;
  private sparks: Spark[] = [];
  private born = new Map<number, number>();   // soul number -> time it first appeared
  private known = new Set<number>();
  private primed = false;
  sparkCount = 60;
  highlightSoul = 0;
  sigilHits = new Set<string>();
  /** Screen positions from the last draw, for tap testing. */
  soulSpots: { n: number; x: number; y: number }[] = [];
  sigilSpots: { id: string; x: number; y: number }[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!;
  }

  resize(w: number, h: number, dpr: number) {
    this.dpr = Math.min(dpr, 1.5);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  static soulPlace(n: number, frames: number) {
    return { frame: hash01(n, 1) * frames, lat: (hash01(n, 2) - 0.5) * 116 };
  }

  private glow(x: number, y: number, r: number, rgb: string, a: number) {
    const g = this.g;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${rgb},${a})`);
    grad.addColorStop(0.35, `rgba(${rgb},${a * 0.35})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  draw(v: View, s: State, online: number, reduced: boolean, dt: number) {
    const g = this.g;
    const { frames, dir } = s.scene.ring;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, v.w, v.h);
    g.globalCompositeOperation = 'lighter';
    const fade = 1 - v.dim * 1.6;
    if (fade <= 0.02) { this.soulSpots = []; this.sigilSpots = []; return; }

    // Sparks drifting up off the machine, and dust in the void.
    if (!reduced) {
      while (this.sparks.length < this.sparkCount) {
        const warm = Math.random() < 0.55;
        const a = Math.random() * TAU;
        const rad = warm ? v.R * (0.2 + Math.random() * 0.85) : Math.max(v.w, v.h) * Math.random();
        this.sparks.push({
          x: v.cx + Math.cos(a) * rad, y: v.cy + Math.sin(a) * rad * (warm ? 0.9 : 1),
          vx: (Math.random() - 0.5) * 6, vy: warm ? -(4 + Math.random() * 10) : (Math.random() - 0.5) * 3,
          life: Math.random(), warm,
        });
      }
      if (this.sparks.length > this.sparkCount) this.sparks.length = this.sparkCount;
      for (const p of this.sparks) {
        p.life += dt * (p.warm ? 0.16 : 0.05);
        p.x += p.vx * dt + v.px * dt * (p.warm ? 4 : 1.5);
        p.y += p.vy * dt;
        if (p.life >= 1) { p.life = 0; const a = Math.random() * TAU; const rad = p.warm ? v.R * (0.2 + Math.random() * 0.85) : Math.max(v.w, v.h) * Math.random(); p.x = v.cx + Math.cos(a) * rad; p.y = v.cy + Math.sin(a) * rad; }
        const al = Math.sin(p.life * Math.PI) * (p.warm ? 0.5 * v.life : 0.18) * fade;
        g.fillStyle = p.warm ? `rgba(255,170,90,${al})` : `rgba(190,205,235,${al})`;
        g.fillRect(p.x, p.y, p.warm ? 1.6 : 1.2, p.warm ? 1.6 : 1.2);
      }
    }

    // Everyone else who is here right now: cold lights circling at a distance.
    const others = Math.min(50, Math.max(0, online - 1));
    for (let i = 0; i < others; i++) {
      const sp = 0.012 + hash01(i, 7) * 0.02;
      const a = hash01(i, 8) * TAU + v.t * sp * (hash01(i, 9) > 0.5 ? 1 : -1);
      const rad = v.R * (1.22 + hash01(i, 10) * 0.75);
      const x = v.cx + Math.cos(a) * rad * 1.12;
      const y = v.cy + Math.sin(a) * rad * 0.62;
      const behind = Math.sin(a) < 0 && Math.hypot((x - v.cx) / v.R, (y - v.cy) / v.R) < 1;
      if (!behind) this.glow(x, y, 7, '170,195,255', 0.2 * fade * (0.6 + 0.4 * Math.sin(v.t * 0.8 + i)));
    }

    // Souls: one warm lantern per order, fixed to the sphere's surface.
    if (!this.primed) { s.souls.forEach((x) => this.known.add(x.n)); this.primed = true; }
    this.soulSpots = [];
    for (const soul of s.souls) {
      if (!this.known.has(soul.n)) { this.known.add(soul.n); this.born.set(soul.n, v.t); }
      const pl = Fx.soulPlace(soul.n, frames);
      const p = project(v, frames, dir, pl.frame, 0, pl.lat);
      if (p.z < 0.08) continue;
      const age = this.born.has(soul.n) ? v.t - this.born.get(soul.n)! : 99;
      const flare = age < 6 ? 1 + 5 * Math.exp(-age * 0.9) : 1;
      const pick = soul.n === this.highlightSoul ? 2.6 + Math.sin(v.t * 4) * 0.8 : 1;
      const tw = reduced ? 1 : 0.8 + 0.2 * Math.sin(v.t * (1.5 + hash01(soul.n, 3) * 2) + soul.n);
      const size = Math.max(3.5, v.R * 0.022) * (0.6 + 0.4 * p.z) * Math.min(3, flare) * Math.min(2, pick);
      this.glow(p.x, p.y, size * 2.4, '255,196,120', Math.min(1, 0.75 * p.z * tw * fade * Math.min(2, flare) * pick));
      this.soulSpots.push({ n: soul.n, x: p.x, y: p.y });
    }

    // Sigils: nearly invisible marks. Three, tapped in the right order, break a seal.
    this.sigilSpots = [];
    g.globalCompositeOperation = 'source-over';
    for (const sg of s.scene.sigils || []) {
      const p = project(v, frames, dir, sg.frame, 0, sg.lat);
      if (p.z < 0.25) continue;
      const hit = this.sigilHits.has(sg.id);
      const r = Math.max(5, v.R * 0.024);
      g.strokeStyle = hit ? `rgba(255,214,150,${0.95 * fade})` : `rgba(232,226,214,${(0.16 + 0.05 * Math.sin(v.t * 0.9 + sg.frame)) * p.z * fade})`;
      g.lineWidth = hit ? 1.6 : 1;
      g.beginPath();
      g.moveTo(p.x, p.y - r); g.lineTo(p.x, p.y + r);
      g.moveTo(p.x - r * 0.6, p.y - r * 0.35); g.lineTo(p.x + r * 0.6, p.y - r * 0.35);
      g.moveTo(p.x - r * 0.45, p.y + r * 0.5); g.lineTo(p.x, p.y + r); g.lineTo(p.x + r * 0.45, p.y + r * 0.5);
      g.stroke();
      if (hit) { g.globalCompositeOperation = 'lighter'; this.glow(p.x, p.y, r * 2.5, '255,196,120', 0.35 * fade); g.globalCompositeOperation = 'source-over'; }
      this.sigilSpots.push({ id: sg.id, x: p.x, y: p.y });
    }
  }
}
