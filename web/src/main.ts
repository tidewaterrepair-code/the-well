// Boot, the render loop, and how the sphere moves under your finger.
import '@fontsource/cinzel/latin-400.css';
import '@fontsource/cormorant-garamond/latin-400.css';
import './style.css';
import type { Chamber, State, View } from './types';
import { TAU, clamp, ease, lerp, mod, pad3, store } from './types';
import { createRenderer } from './gl';
import { Ring } from './ring';
import { Fx } from './fx';
import { Sound } from './audio';
import { UI, type CartLine } from './ui';

const DEMO = import.meta.env.VITE_DEMO === '1';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const stage = document.getElementById('stage')!;
const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const still = document.getElementById('still') as HTMLImageElement;

let state: State;
let ring: Ring;
let clockOffset = 0;
let unlock = store.get<string>('well.unlock', '');
const renderer = createRenderer(glCanvas);
const fx = new Fx(document.getElementById('fx') as HTMLCanvasElement);
const sound = new Sound();
let demo: typeof import('./demo') | null = null;

// ---------------------------------------------------------------- server talk
const headers = () => ({ 'content-type': 'application/json', ...(unlock ? { 'x-unlock': unlock } : {}) });

async function fetchState(): Promise<State> {
  if (DEMO) {
    demo ??= await import('./demo');
    return demo.demoState();
  }
  const r = await fetch('api/state', { headers: headers(), cache: 'no-store' });
  if (!r.ok) throw new Error(`state ${r.status}`);
  return r.json();
}

async function refresh() {
  try {
    state = await fetchState();
    clockOffset = state.now - Date.now();
    online = Math.max(online, state.online);
    ui.refresh();
  } catch { /* keep showing what we have; the next poll will try again */ }
}

let online = 1;
function listenPresence() {
  if (DEMO) return;
  let wait = 2000;
  const open = () => {
    const base = location.pathname.replace(/[^/]*$/, '');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}ws/presence`);
    ws.onmessage = (e) => {
      wait = 2000;
      try {
        const m = JSON.parse(e.data);
        online = m.online || 1;
        if (typeof m.souls === 'number' && m.souls !== state.souls.length) void refresh(); // someone just bought: light their lantern now
      } catch { /* ignore */ }
    };
    ws.onclose = () => { setTimeout(open, wait); wait = Math.min(60000, wait * 2); };
    ws.onerror = () => ws.close();
  };
  open();
}

// ---------------------------------------------------------------- view + motion
const view: View = { w: 0, h: 0, phone: false, cx: 0, cy: 0, R: 1, pos: 0, px: 0, py: 0, t: 0, life: 1, shaft: 0.2, night: 0, dim: 0, flick: reduced ? 0 : 1 };
const base = { cx: 0, cy: 0, R: 1 };
let dpr = 1;
let zoom = 1, zoomTarget = 1;
let vel = 0;                       // frames per second
let target: number | null = null;  // frame we are gliding to
let dragging = false;
let pendingEnter = false;
let pendingProduct: string | undefined;
let current: Chamber | null = null;
let dive = 0, diveTarget = 0;
let diveCh: Chamber | null = null;
let ptrX = 0, ptrY = 0;

function layout() {
  view.w = innerWidth;
  view.h = innerHeight;
  view.phone = view.w < 768;
  if (view.phone) { base.cx = view.w / 2; base.cy = view.h * 0.39; base.R = Math.min(view.w * 0.49, view.h * 0.29); }
  else { base.cx = view.w / 2; base.cy = view.h * 0.53; base.R = Math.min(view.h * 0.4, view.w * 0.27); }
  renderer?.resize(view.w, view.h, dpr);
  fx.resize(view.w, view.h, dpr);
}

const onSphere = () => state.chambers.filter((c) => c.status !== 'archived');
const frames = () => state.scene.ring.frames;
function delta(from: number, to: number) {
  let d = mod(to - from, frames());
  if (d > frames() / 2) d -= frames();
  return d;
}
function nearestChamber(p: number): Chamber | null {
  let best: Chamber | null = null, bd = 1e9;
  for (const c of onSphere()) { const d = Math.abs(delta(p, c.frame)); if (d < bd) { bd = d; best = c; } }
  return best;
}

function goTo(id: string, thenEnter = false) {
  const c = state.chambers.find((x) => x.id === id);
  if (!c) return;
  if (ui.vaultCh) leave();
  pendingEnter = thenEnter;
  vel = 0;
  target = view.pos + delta(view.pos, c.frame);
  if (Math.abs(target - view.pos) < 0.02) arrive();
}

function arrive() {
  if (target !== null) view.pos = target;
  target = null;
  vel = 0;
  current = nearestChamber(view.pos);
  ui.setCurrent(current);
  if (pendingEnter) { pendingEnter = false; enter(); }
}

function enter() {
  if (target !== null) { pendingEnter = true; return; }
  const c = current ?? nearestChamber(view.pos);
  if (!c) return;
  if (Math.abs(delta(view.pos, c.frame)) > 0.05) return goTo(c.id, true);
  sound.thud();
  diveCh = c;
  diveTarget = 1;
  ui.showVault(c, pendingProduct);
  pendingProduct = undefined;
}

function leave() {
  diveTarget = 0;
  ui.hideVault();
}

function explore() {
  const list = [...onSphere()].sort((a, b) => a.frame - b.frame);
  if (!list.length) return;
  const i = list.findIndex((c) => c.id === current?.id);
  goTo(list[(i + 1) % list.length].id);
}

// ---------------------------------------------------------------- shop actions
async function checkout(items: CartLine[]) {
  if (!items.length) return;
  if (DEMO) return ui.toast('THIS IS THE DEMO. ON YOUR SERVER THIS BUTTON OPENS STRIPE CHECKOUT.', 5200);
  try {
    const r = await fetch('api/checkout', { method: 'POST', headers: headers(), body: JSON.stringify({ items }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.url) { location.href = j.url; return; }
    if (r.status === 409) {
      ui.removeLines(j.items || []);
      await refresh();
      ui.toast('THE WELL TOOK IT FIRST. THAT PIECE IS GONE AND HAS LEFT YOUR CART.', 6000);
    } else if (r.status === 503) ui.toast('CHECKOUT IS NOT OPEN YET.');
    else if (r.status === 429) ui.toast('TOO FAST. WAIT A MOMENT, THEN TRY AGAIN.');
    else ui.toast('THE WELL DID NOT ANSWER. NOTHING WAS CHARGED. TRY AGAIN.');
  } catch {
    ui.toast('NO CONNECTION. NOTHING WAS CHARGED. TRY AGAIN.');
  }
}

async function signup(email: string, chamberId: string) {
  if (DEMO) return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  try {
    return (await fetch('api/notify', { method: 'POST', headers: headers(), body: JSON.stringify({ email, chamberId }) })).ok;
  } catch { return false; }
}

const sigilTaps: string[] = [];
async function sigilTap(id: string) {
  if (fx.sigilHits.has(id) || state.unlocked) return;
  fx.sigilHits.add(id);
  sigilTaps.push(id);
  if (sigilTaps.length < state.scene.sigils.length) return;
  const sequence = sigilTaps.splice(0);
  let res: { unlocked?: boolean; token?: string; code?: string | null } = {};
  try {
    if (DEMO) res = { unlocked: sequence.join() === 'a,b,c', token: 'demo', code: 'ASCEND' };
    else res = await (await fetch('api/sigil', { method: 'POST', headers: headers(), body: JSON.stringify({ sequence }) })).json();
  } catch { /* treated as a miss */ }
  if (res.unlocked && res.token) {
    unlock = res.token;
    store.set('well.unlock', unlock);
    demo?.demoUnlock();
    ui.flash();
    sound.thud();
    await refresh();
    ui.toast(`${state.lore.unlockLine || 'THE SEAL BREAKS.'}${res.code ? ` CODE: ${res.code}` : ''}`, 9000);
    const locked = state.chambers.find((c) => c.status === 'locked');
    if (locked) goTo(locked.id, true);
  } else {
    ui.toast('THE WELL DOES NOT KNOW THAT ORDER.', 2600);
    setTimeout(() => fx.sigilHits.clear(), 900);
  }
}

const ui = new UI({
  state: () => state,
  current: () => current,
  clockOffset: () => clockOffset,
  goTo, enter, leave, explore, checkout, signup,
  toggleSound: () => sound.toggle(),
});

// ---------------------------------------------------------------- input
function bindInput() {
  let lastX = 0, lastT = 0, moved = 0, downX = 0, downY = 0, pid = -1;
  stage.addEventListener('pointerdown', (e) => {
    if (pid !== -1) return;
    pid = e.pointerId;
    stage.setPointerCapture(pid);
    dragging = !ui.vaultCh;
    stage.classList.toggle('grab', dragging);
    lastX = downX = e.clientX; downY = e.clientY; lastT = performance.now(); moved = 0;
    if (dragging) { target = null; vel = 0; pendingEnter = false; }
    askForTilt();
  });
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') { ptrX = (e.clientX / view.w - 0.5) * 2; ptrY = (e.clientY / view.h - 0.5) * 2; }
    if (e.pointerId !== pid) {
      if (e.pointerType === 'mouse') hoverSoul(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - lastX;
    const now = performance.now();
    moved += Math.abs(dx) + Math.abs(e.clientY - downY) * 0.02;
    if (dragging) {
      const df = (-state.scene.ring.dir * dx / view.R) * (frames() / TAU);
      view.pos += df;
      const inst = df / Math.max(0.004, (now - lastT) / 1000);
      vel = lerp(vel, inst, 0.35);
    }
    lastX = e.clientX; lastT = now;
  });
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    pid = -1;
    stage.classList.remove('grab');
    const wasDrag = dragging;
    dragging = false;
    if (moved < 7 && Math.hypot(e.clientX - downX, e.clientY - downY) < 9) { vel = 0; tap(e.clientX, e.clientY); if (wasDrag && target === null && !ui.vaultCh) settle(); return; }
    if (!wasDrag) return;
    if (performance.now() - lastT > 90) vel = 0;
    vel = clamp(vel, -90, 90);
    if (Math.abs(vel) < 3 || reduced) settle();
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); if (!ui.vaultCh) zoomTarget = clamp(zoomTarget - e.deltaY * 0.0012, 1, 1.45); }, { passive: false });
  addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const list = [...onSphere()].sort((a, b) => a.frame - b.frame);
    const i = list.findIndex((c) => c.id === (current?.id));
    goTo(list[mod(i + (e.key === 'ArrowRight' ? 1 : -1), list.length)].id);
  });
  addEventListener('resize', layout);
}

function settle() {
  const c = nearestChamber(view.pos + vel * 0.3);
  vel = 0;
  if (!c) return;
  target = view.pos + delta(view.pos, c.frame);
  if (Math.abs(target - view.pos) < 0.02) arrive();
}

function tap(x: number, y: number) {
  if (ui.vaultCh) return leave();
  const sg = fx.sigilSpots.find((s) => Math.hypot(s.x - x, s.y - y) < 26);
  if (sg) return void sigilTap(sg.id);
  const soul = fx.soulSpots.find((s) => Math.hypot(s.x - x, s.y - y) < 16);
  if (soul) return ui.tip(x, y, `SOUL ${pad3(soul.n)}`);
  if (Math.hypot(x - view.cx, y - view.cy) < view.R * 0.9 && target === null) enter();
}

function hoverSoul(x: number, y: number) {
  const soul = fx.soulSpots.find((s) => Math.hypot(s.x - x, s.y - y) < 10);
  if (soul) ui.tip(x, y, `SOUL ${pad3(soul.n)}`);
}

let tiltAsked = false;
function askForTilt() {
  if (tiltAsked || reduced) return;
  tiltAsked = true;
  const D = (window as any).DeviceOrientationEvent;
  if (!D) return;
  const listen = () => addEventListener('deviceorientation', (e: DeviceOrientationEvent) => {
    if (e.gamma == null || e.beta == null) return;
    ptrX = clamp(e.gamma / 28, -1, 1);
    ptrY = clamp((e.beta - 50) / 28, -1, 1);
  });
  try {
    if (typeof D.requestPermission === 'function') D.requestPermission().then((r: string) => r === 'granted' && listen()).catch(() => {});
    else listen();
  } catch { /* no tilt here; the mouse or nothing drives parallax */ }
}

// ---------------------------------------------------------------- the loop
function etHour() {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(Date.now() + clockOffset)) % 24; } catch { return 12; }
}
function power(c: Chamber) {
  if (c.status !== 'countdown' || !c.goesLiveAt) return 0;
  const hours = (Date.parse(c.goesLiveAt) - (Date.now() + clockOffset)) / 3600_000;
  return clamp(1 - hours / 48, 0, 1);
}

const plates = new Map<string, HTMLImageElement | null>();
let plateMix = 0;
/** A chamber's optional high-resolution still. Loads the first time it is needed. */
function plateFor(c: Chamber): HTMLImageElement | null {
  if (!c.plate) return null;
  if (!plates.has(c.id)) {
    plates.set(c.id, null);
    const img = new Image();
    img.onload = () => plates.set(c.id, img);
    img.src = `${c.plate}?v=${state.scene.ring.version}`;
  }
  return plates.get(c.id) ?? null;
}

let last = 0, slowFrames = 0, counted = 0, lastSpeedPos = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;
  view.t += dt;

  // glide / coast
  if (!dragging) {
    if (target !== null) {
      view.pos += (target - view.pos) * (reduced ? 1 : 1 - Math.exp(-dt / 0.2));
      if (Math.abs(target - view.pos) < 0.015) arrive();
    } else if (vel !== 0) {
      view.pos += vel * dt;
      vel *= Math.exp(-dt / 0.38);
      if (Math.abs(vel) < 3) settle();
    }
  }
  sound.turning((view.pos - lastSpeedPos) / dt);
  lastSpeedPos = view.pos;

  // where the sphere sits: resting, zoomed, or pushed in on a chamber
  zoom = lerp(zoom, zoomTarget, 1 - Math.exp(-dt * 8));
  dive = diveTarget > dive ? Math.min(1, dive + dt / (reduced ? 0.01 : 0.85)) : Math.max(0, dive - dt / (reduced ? 0.01 : 0.6));
  const breathe = reduced ? 1 : 1 + 0.008 * Math.sin((view.t * TAU) / 8);
  let R = base.R * zoom * breathe, cx = base.cx, cy = base.cy;
  if (dive > 0 && diveCh) {
    const e = ease(dive);
    const R1 = base.R * (view.phone ? 1.22 : 1.32);
    const lon = (diveCh.lon * Math.PI) / 180, lat = (diveCh.lat * Math.PI) / 180;
    const sx = view.phone ? view.w * 0.5 : view.w * 0.36, sy = view.phone ? view.h * 0.2 : view.h * 0.5;
    cx = lerp(cx, sx - Math.sin(lon) * Math.cos(lat) * R1, e);
    cy = lerp(cy, sy + Math.sin(lat) * R1, e);
    R = lerp(R, R1, e);
    view.dim = 0.32 * e;
  } else view.dim = 0;
  view.cx = cx; view.cy = cy; view.R = R;
  view.px = lerp(view.px, ptrX, 1 - Math.exp(-dt * 5));
  view.py = lerp(view.py, ptrY, 1 - Math.exp(-dt * 5));

  // how alive the machine looks
  const near = nearestChamber(view.pos);
  const maxPower = Math.max(0, ...state.chambers.map(power));
  let lifeT = 0.5;
  if (near) lifeT = { live: 0.35 + 0.65 * (near.total ? near.remaining / near.total : 1), soldout: 0.05, dormant: 0.3, locked: 0.2, countdown: 0.28 + 0.6 * power(near), archived: 0.1 }[near.status];
  view.life = lerp(view.life, lifeT, 1 - Math.exp(-dt * 1.6));
  view.shaft = lerp(view.shaft, 0.2 + 1.3 * maxPower, 1 - Math.exp(-dt * 1.5));
  const h = etHour();
  view.night = lerp(view.night, h < 4 ? 1 : 0, 1 - Math.exp(-dt));

  // draw
  const n = frames();
  const i0 = Math.floor(view.pos);
  const a = ring.nearest(i0), b = ring.nearest(i0 + 1);
  const ia = ring.imgs[a], ib = ring.imgs[b];
  const { sphere, aspect } = state.scene.ring;
  // At rest on a chamber that has a sharp still ("plate"), fade from the ring frame to it.
  const resting = !dragging && target === null && vel === 0 && current !== null && Math.abs(delta(view.pos, current.frame)) < 0.02;
  const plate = resting ? plateFor(current!) : null;
  plateMix = plate ? Math.min(1, plateMix + dt / 0.6) : 0;
  if (ia && ib) {
    if (renderer && plate) {
      renderer.setFrames(ia, plate, a, 10000 + state.chambers.indexOf(current!));
      renderer.draw(view, ease(plateMix), sphere, aspect);
    } else if (renderer) {
      renderer.setFrames(ia, ib, a, b);
      renderer.draw(view, a === mod(i0, n) && b === mod(i0 + 1, n) ? view.pos - i0 : 0, sphere, aspect);
    } else {
      const H = R / sphere.r, W = H * aspect;
      const src = (view.pos - i0 < 0.5 ? ia : ib).src;
      if (still.src !== src) still.src = src;
      still.hidden = false;
      still.style.cssText = `width:${W}px;height:${H}px;left:${cx - sphere.cx * W}px;top:${cy - sphere.cy * H}px;opacity:${1 - view.dim}`;
    }
  }
  fx.draw(view, state, online, reduced, dt);
  ui.place(view, near?.id ?? null);

  // slow phone? trade resolution and sparks for smoothness
  if (counted < 150 && view.t > 1.5) {
    counted++;
    if (dt > 0.03) slowFrames++;
    if (counted === 150 && slowFrames > 45) { dpr = 1; fx.sparkCount = 20; layout(); }
  }
}

function pickTagline() {
  const L = state.lore;
  let visits = store.get<number>('well.visits', 0);
  let counted = false;
  try { counted = sessionStorage.getItem('well.seen') === '1'; sessionStorage.setItem('well.seen', '1'); } catch { /* fine */ }
  if (!counted) { visits += 1; store.set('well.visits', visits); }
  const night: string[] = L.afterMidnightLines || [];
  const back: string[] = L.returnVisitLines || [];
  if (etHour() < 4 && night.length) return night[new Date().getDate() % night.length];
  if (visits > 1 && back.length) return back[(visits - 2) % back.length];
  return (L.taglines || [])[0] || '';
}

async function boot() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  for (let wait = 1500; ; wait = Math.min(15000, wait * 1.6)) {
    try { state = await fetchState(); break; } catch {
      document.querySelector('#veil p')!.textContent = 'THE WELL IS SILENT. LISTENING AGAIN.';
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  clockOffset = state.now - Date.now();
  online = state.online || 1;
  if (!renderer) glCanvas.hidden = true;
  if (DEMO) document.querySelectorAll<HTMLAnchorElement>('a[href="shop"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); ui.toast('THE PLAIN SHOP PAGE LIVES ON YOUR SERVER, NOT IN THIS DEMO.'); }));

  const q = new URLSearchParams(location.search);
  const wanted = state.chambers.find((c) => c.id === q.get('c'));
  const soulN = Number(q.get('soul')) || 0;
  const live = onSphere().filter((c) => c.status === 'live').sort((a, b) => b.remaining - a.remaining);
  current = wanted || live[0] || onSphere()[0] || null;
  view.pos = current?.frame ?? 0;
  if (soulN && state.souls.some((s) => s.n === soulN)) {
    fx.highlightSoul = soulN;
    view.pos = Math.round(Fx.soulPlace(soulN, frames()).frame);
    setTimeout(() => { fx.highlightSoul = 0; settle(); }, 9000);
  }
  layout();
  ui.refresh();
  ui.setTagline(pickTagline());

  ring = new Ring(state.scene, (base.R / state.scene.ring.sphere.r) * state.scene.ring.aspect * dpr);
  await ring.load(view.pos, (f) => ui.progress(f));
  bindInput();
  requestAnimationFrame(frame);
  document.getElementById('veil')!.classList.add('gone');
  if (DEMO) ui.toast('DEMO: PLACEHOLDER ART AND PRETEND STOCK. DRAG THE SPHERE.', 5200);
  if (soulN && fx.highlightSoul) ui.toast(`SOUL ${pad3(soulN)} BURNS HERE.`, 6000);
  if (wanted && q.get('p')) { pendingProduct = q.get('p')!; setTimeout(enter, 900); }

  listenPresence();
  setInterval(() => { if (!document.hidden) void refresh(); }, DEMO ? 5000 : 30000);
  if (DEMO) setInterval(() => { if (!document.hidden) { demo!.demoAddSoul(); void refresh(); } }, 24000);
}

void boot();
