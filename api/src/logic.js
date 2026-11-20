// Pure rules: what state is each chamber in, and what may the public see.
import crypto from 'node:crypto';

/**
 * A chamber's status is worked out, never typed by hand at drop time:
 *  locked / archived / dormant  -> as written in chambers.json
 *  live + goesLiveAt in future  -> countdown
 *  live + everything sold       -> soldout
 *  live + nothing to sell yet   -> dormant
 */
export function chamberStatus(ch, agg, now) {
  if (ch.status !== 'live') return ch.status;
  if (ch.goesLiveAt && Date.parse(ch.goesLiveAt) > now) return 'countdown';
  if (agg.total === 0) return 'dormant';
  return agg.remaining <= 0 ? 'soldout' : 'live';
}

export function unlockToken(secret) {
  return crypto.createHmac('sha256', secret || 'unset').update('chamber-unlock-v1').digest('hex').slice(0, 32);
}

export function isUnlocked(secret, token) {
  if (!secret || typeof token !== 'string' || token.length !== 32) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(unlockToken(secret)));
}

export function buildState({ cfg, db, now, unlocked = false, online = 0, checkout = false }) {
  const stock = db.stockMap();
  const left = (pid, size) => {
    const r = stock.get(`${pid}|${size}`);
    return r ? Math.max(0, r.total - r.sold - r.reserved) : 0;
  };
  const total = (pid, size) => stock.get(`${pid}|${size}`)?.total ?? 0;

  const sealed = new Set(); // every piece paid for (not merely held in an open checkout)
  const chambers = cfg.chambers.map((ch) => {
    const agg = { total: 0, remaining: 0, sold: 0 };
    for (const p of cfg.products) {
      if (p.chamberId !== ch.id) continue;
      for (const s of p.sizes) {
        const r = stock.get(`${p.id}|${s.size}`);
        agg.total += total(p.id, s.size);
        agg.remaining += left(p.id, s.size);
        agg.sold += r ? Math.min(r.total, r.sold) : 0;
      }
    }
    if (agg.total > 0 && agg.sold >= agg.total) sealed.add(ch.id);
    return {
      id: ch.id, numeral: ch.numeral, name: ch.name, frame: ch.frame, lon: ch.lon ?? 0, lat: ch.lat ?? 0,
      status: chamberStatus(ch, agg, now), goesLiveAt: ch.goesLiveAt || null,
      scrollLine: ch.scrollLine || '', plate: ch.plate || null, total: agg.total, remaining: agg.remaining,
    };
  });

  const byId = new Map(chambers.map((c) => [c.id, c]));
  const visible = (c) => c.status === 'live' || c.status === 'soldout' || (c.status === 'locked' && unlocked);
  const products = cfg.products
    .filter((p) => visible(byId.get(p.chamberId)))
    .map((p) => ({
      id: p.id, chamberId: p.chamberId, name: p.name, description: p.description || '',
      priceCents: p.priceCents, images: p.images || [],
      sizes: p.sizes.map((s) => ({ size: s.size, remaining: left(p.id, s.size) })),
    }));

  const state = { scene: cfg.scene, lore: cfg.lore, chambers, products, souls: db.souls(), now, online, checkout, unlocked };
  // Not enumerable, so it never reaches the browser in JSON.
  Object.defineProperty(state, 'sealed', { value: sealed, enumerable: false });
  return state;
}

/** Clean up a cart sent by a browser. Returns null if it is not a sane cart. */
export function normalizeItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return null;
  const merged = new Map();
  for (const it of raw) {
    if (!it || typeof it.productId !== 'string' || typeof it.size !== 'string') return null;
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 5) return null;
    const key = `${it.productId}|${it.size}`;
    const prev = merged.get(key);
    merged.set(key, { productId: it.productId, size: it.size, qty: Math.min(5, (prev?.qty || 0) + qty) });
  }
  return [...merged.values()];
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const money = (cents) => `$${(cents / 100).toFixed(2)}`;
