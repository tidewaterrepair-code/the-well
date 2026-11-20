// Loads settings (.env) and the JSON files in config/. The JSON files are
// re-read automatically when they change, so editing a drop needs no restart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

export function loadEnv(e = process.env) {
  const int = (k, d) => (e[k] !== undefined && e[k] !== '' ? parseInt(e[k], 10) : d);
  const bool = (k) => /^(1|true|yes)$/i.test(e[k] || '');
  const list = (k, d) => (e[k] || d).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    port: int('PORT', 8787),
    host: e.HOST || '0.0.0.0',
    publicUrl: (e.PUBLIC_URL || 'http://localhost:8787').replace(/\/$/, ''),
    configDir: e.CONFIG_DIR || path.join(root, 'config'),
    dataDir: e.DATA_DIR || path.join(root, 'data'),
    webDir: e.WEB_DIR || path.join(root, 'web', 'dist'),
    appSecret: e.APP_SECRET || '',
    stripeKey: e.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET || '',
    stripeTax: bool('STRIPE_TAX'),
    shippingCents: int('SHIPPING_CENTS', 695),
    freeShippingOverCents: int('FREE_SHIPPING_OVER_CENTS', 0),
    shipCountries: list('SHIP_COUNTRIES', 'US'),
    adminUser: e.ADMIN_USER || 'keeper',
    adminPassword: e.ADMIN_PASSWORD || '',
    previewPassword: e.PREVIEW_PASSWORD || '',
    eventsWebhook: e.N8N_EVENTS_WEBHOOK || '',
    eventsSecret: e.EVENTS_SECRET || '',
    sigilSequence: list('SIGIL_SEQUENCE', ''),
    sigilRewardCode: e.SIGIL_REWARD_CODE || '',
    fulfillmentMode: (e.FULFILLMENT_MODE || 'manual').toLowerCase(), // manual | dryrun | yoycol
    yoycolApiKey: e.YOYCOL_API_KEY || '',
    yoycolApiSecret: e.YOYCOL_API_SECRET || '',
    yoycolBaseUrl: e.YOYCOL_BASE_URL || '',
  };
}

const FILES = ['scene', 'chambers', 'products', 'lore'];
const CHAMBER_STATUS = ['live', 'dormant', 'locked', 'archived'];

export function validateConfig(cfg) {
  const errs = [];
  if (!Array.isArray(cfg.chambers) || !cfg.chambers.length) errs.push('chambers.json must be a non-empty list');
  const ids = new Set();
  for (const c of cfg.chambers || []) {
    if (!c.id || ids.has(c.id)) errs.push(`chamber id missing or repeated: ${c.id}`);
    ids.add(c.id);
    if (!CHAMBER_STATUS.includes(c.status)) errs.push(`chamber ${c.id}: status must be one of ${CHAMBER_STATUS.join(', ')}`);
    if (typeof c.frame !== 'number') errs.push(`chamber ${c.id}: "frame" must be a number`);
    if (c.goesLiveAt && Number.isNaN(Date.parse(c.goesLiveAt))) errs.push(`chamber ${c.id}: goesLiveAt is not a valid date`);
  }
  const pids = new Set();
  for (const p of cfg.products || []) {
    if (!p.id || pids.has(p.id)) errs.push(`product id missing or repeated: ${p.id}`);
    pids.add(p.id);
    if (!ids.has(p.chamberId)) errs.push(`product ${p.id}: chamberId "${p.chamberId}" is not a chamber`);
    if (!Number.isInteger(p.priceCents) || p.priceCents < 50) errs.push(`product ${p.id}: priceCents must be a whole number of cents (e.g. 3800)`);
    if (!Array.isArray(p.sizes) || !p.sizes.length) errs.push(`product ${p.id}: needs at least one size`);
    for (const s of p.sizes || []) {
      if (!s.size || !Number.isInteger(s.limit) || s.limit < 0) errs.push(`product ${p.id}: each size needs "size" and a whole-number "limit"`);
    }
  }
  if (!cfg.scene?.ring?.frames) errs.push('scene.json: ring.frames is required');
  return errs;
}

export function createConfigLoader(dir) {
  let cache = null;
  let stamp = '';
  const read = () => {
    const out = {};
    for (const f of FILES) out[f] = JSON.parse(fs.readFileSync(path.join(dir, `${f}.json`), 'utf8'));
    return out;
  };
  const mtimes = () => FILES.map((f) => fs.statSync(path.join(dir, `${f}.json`)).mtimeMs).join('|');
  return function getConfig() {
    const now = mtimes();
    if (cache && now === stamp) return cache;
    try {
      const next = read();
      const errs = validateConfig(next);
      if (errs.length) throw new Error(errs.join('; '));
      cache = next;
      stamp = now;
    } catch (err) {
      if (!cache) throw new Error(`config is invalid: ${err.message}`);
      // Keep serving the last good config; a bad edit must never take the store down.
      console.error(`[config] ignoring bad edit: ${err.message}`);
      stamp = now;
    }
    return cache;
  };
}
