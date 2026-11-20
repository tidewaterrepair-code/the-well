// Builds the web server. Everything it needs is passed in, so tests can run it
// with a fake Stripe and an in-memory database.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import fastifyWebsocket from '@fastify/websocket';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildState, isUnlocked, unlockToken, normalizeItems } from './logic.js';
import { createCommerce } from './commerce.js';
import { createFulfillment } from './fulfillment.js';
import { shopPage, thanksPage, adminPage } from './pages.js';

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

function basicAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const raw = Buffer.from(h.slice(6), 'base64').toString();
  const i = raw.indexOf(':');
  return i < 0 ? null : { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}

/** Small in-memory limiter: at most `max` hits per `windowMs` per key. */
function limiter(max, windowMs, clock) {
  const hits = new Map();
  return (key) => {
    const now = clock();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return true;
  };
}

export async function buildApp({ env, db, stripe = null, getConfig, clock = Date.now, fetchImpl = fetch, logger = false }) {
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 256 * 1024 });

  // ---- events out to n8n (alerts, posts, emails). Never blocks or breaks a sale.
  function notify(event, data) {
    if (!env.eventsWebhook) return;
    fetchImpl(env.eventsWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(env.eventsSecret ? { 'x-engine-secret': env.eventsSecret } : {}) },
      body: JSON.stringify({ event, data, at: new Date(clock()).toISOString() }),
      signal: AbortSignal.timeout(8000),
    }).catch((err) => console.error(`[notify] ${event} not delivered: ${err.message}`));
  }

  const commerce = createCommerce({ env, db, stripe, getConfig, notify, clock });
  const fulfillment = createFulfillment({ env, db, notify, clock, describe: commerce.describe });
  db.syncStock(getConfig().products);

  // ---- body parsing: keep the raw bytes so Stripe's signature can be checked
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body;
    try { done(null, body.length ? JSON.parse(body.toString()) : {}); } catch (err) { err.statusCode = 400; done(err); }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });

  await app.register(fastifyCompress, { threshold: 1024 });
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 } });

  // ---- preview password: keeps strangers out before launch. Stripe and health checks pass through.
  const openPaths = ['/api/stripe/webhook', '/api/health'];
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    const url = req.url.split('?')[0];
    const admin = url === '/admin' || url.startsWith('/admin/');
    if (!admin && (!env.previewPassword || openPaths.includes(url))) return;
    const cred = basicAuth(req);
    const okAdmin = cred && env.adminPassword && cred.user === env.adminUser && safeEqual(cred.pass, env.adminPassword);
    const okPreview = cred && env.previewPassword && safeEqual(cred.pass, env.previewPassword);
    if (admin ? okAdmin : okAdmin || okPreview) return;
    if (admin && !env.adminPassword) return reply.code(503).type('text/plain').send('Set ADMIN_PASSWORD in .env to use /admin.');
    return reply.code(401).header('www-authenticate', `Basic realm="${admin ? 'Keeper' : 'The Black Well'}", charset="UTF-8"`).type('text/plain').send('The Well is not open to you.');
  });

  // ---- presence: how many people are on the site right now
  const sockets = new Set();
  const online = () => sockets.size;
  app.get('/ws/presence', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ online: online() }));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  const presenceTimer = setInterval(() => {
    const msg = JSON.stringify({ online: online(), souls: db.souls().length });
    for (const s of sockets) { try { s.send(msg); } catch { sockets.delete(s); } }
  }, 5000);
  presenceTimer.unref();
  app.addHook('onClose', async () => clearInterval(presenceTimer));

  const unlockedFor = (req) => isUnlocked(env.appSecret, req.headers['x-unlock']);
  const stateFor = (req) => buildState({ cfg: getConfig(), db, now: clock(), unlocked: unlockedFor(req), online: online(), checkout: Boolean(stripe) });

  // ---- public API
  app.get('/api/health', async () => ({ ok: true, at: clock(), checkout: Boolean(stripe), fulfillment: env.fulfillmentMode }));

  app.get('/api/state', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return stateFor(req);
  });

  const checkoutLimit = limiter(12, 60_000, clock);
  app.post('/api/checkout', async (req, reply) => {
    if (!checkoutLimit(req.ip)) return reply.code(429).send({ error: 'slow_down' });
    const items = normalizeItems(req.body?.items);
    if (!items) return reply.code(400).send({ error: 'bad_cart' });
    const out = await commerce.startCheckout(items, { unlocked: unlockedFor(req) });
    if (out.error) return reply.code(out.status).send({ error: out.error, items: out.items });
    return { url: out.url };
  });

  app.post('/api/stripe/webhook', async (req, reply) => {
    if (!stripe || !env.stripeWebhookSecret) return reply.code(503).send({ error: 'webhook_not_configured' });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], env.stripeWebhookSecret);
    } catch (err) {
      return reply.code(400).send({ error: 'bad_signature' });
    }
    commerce.handleEvent(event);
    return { received: true };
  });

  const sigilLimit = limiter(5, 60 * 60_000, clock);
  app.post('/api/sigil', async (req, reply) => {
    if (!env.sigilSequence.length || !env.appSecret) return reply.code(404).send({ error: 'no_sigils' });
    if (!sigilLimit(req.ip)) return reply.code(429).send({ error: 'the_well_is_patient' });
    const seq = Array.isArray(req.body?.sequence) ? req.body.sequence.map(String) : [];
    const ok = seq.length === env.sigilSequence.length && seq.every((s, i) => s === env.sigilSequence[i]);
    if (!ok) return { unlocked: false };
    return { unlocked: true, token: unlockToken(env.appSecret), code: env.sigilRewardCode || null };
  });

  const signupLimit = limiter(6, 60 * 60_000, clock);
  app.post('/api/notify', async (req, reply) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const chamberId = String(req.body?.chamberId || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return reply.code(400).send({ error: 'bad_email' });
    if (!getConfig().chambers.some((c) => c.id === chamberId)) return reply.code(400).send({ error: 'bad_chamber' });
    if (!signupLimit(req.ip)) return reply.code(429).send({ error: 'slow_down' });
    if (db.signup(email, chamberId, clock())) notify('signup.created', { email, chamberId });
    return { ok: true };
  });

  // ---- pages
  app.get('/shop', async (req, reply) => reply.type('text/html').send(shopPage(stateFor(req), env.publicUrl)));
  app.get('/thanks', async (req, reply) => {
    const order = req.query.session_id ? db.orderBySession(String(req.query.session_id)) : null;
    return reply.header('cache-control', 'no-store').type('text/html').send(thanksPage(order, getConfig().lore));
  });

  // ---- admin (always behind ADMIN_USER / ADMIN_PASSWORD)
  app.get('/admin', async (req, reply) => reply.header('cache-control', 'no-store').type('text/html').send(adminPage({
    orders: db.recent(), stock: [...db.stockMap().values()], describe: commerce.describe, mode: env.fulfillmentMode, yoycolReady: false,
  })));
  app.post('/admin/orders/:id', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return reply.code(403).send('cross-site request refused');
    const order = db.order(req.params.id);
    if (!order || order.status !== 'paid') return reply.code(404).send('no such paid order');
    const { action, value = '' } = req.body || {};
    if (action === 'placed') db.setFulfillment(order, { fulfillment: 'sent', yoycolOrderId: value.trim().slice(0, 80) });
    else if (action === 'shipped') fulfillment.markShipped(order, value.trim().slice(0, 80));
    else if (action === 'retry') db.setFulfillment(order, { fulfillment: 'queued', attempts: 0, nextAttemptAt: 0 });
    else return reply.code(400).send('unknown action');
    return reply.redirect('/admin', 303);
  });

  // ---- the site itself
  if (fs.existsSync(env.webDir)) {
    await app.register(fastifyStatic, {
      root: env.webDir,
      setHeaders(reply, file) {
        if (/[\\/]assets[\\/]/.test(file)) reply.header('cache-control', 'public, max-age=31536000, immutable');
        else if (/[\\/](frames|img|fonts)[\\/]/.test(file)) reply.header('cache-control', 'public, max-age=2592000');
        else reply.header('cache-control', 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => reply.code(404).type('text/plain').send('Nothing rests here.'));

  // ---- chamber watcher: tells n8n when a chamber opens or seals
  function watchChambers() {
    const now = Object.fromEntries(buildState({ cfg: getConfig(), db, now: clock() }).chambers.map((c) => [c.id, c.status]));
    const before = JSON.parse(db.kvGet('chamber_status') || 'null');
    if (before) {
      for (const c of getConfig().chambers) {
        const data = { chamberId: c.id, numeral: c.numeral, name: c.name };
        if (now[c.id] === 'live' && before[c.id] === 'countdown') notify('chamber.opened', data);
        if (now[c.id] === 'soldout' && before[c.id] === 'live') notify('chamber.sealed', data);
      }
    }
    db.kvSet('chamber_status', JSON.stringify(now));
  }

  return { app, commerce, fulfillment, notify, watchChambers, syncStock: () => db.syncStock(getConfig().products) };
}
