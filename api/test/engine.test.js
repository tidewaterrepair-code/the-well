// Run with: npm test   (inside api/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadEnv, validateConfig } from '../src/config.js';
import { chamberStatus, normalizeItems } from '../src/logic.js';

const baseConfig = () => ({
  scene: { ring: { frames: 72 }, sigils: [] },
  lore: {},
  chambers: [
    { id: 'iv', numeral: 'IV', name: 'THE RECKONING', frame: 2, status: 'live' },
    { id: 'iii', numeral: 'III', name: 'THE OFFERING', frame: 40, status: 'live', goesLiveAt: '2030-01-01T00:00:00Z' },
    { id: 'v', numeral: 'V', name: 'THE ASCENT', frame: 54, status: 'locked' },
  ],
  products: [
    { id: 'tee', chamberId: 'iv', name: 'TEE', priceCents: 3800, images: [], sizes: [{ size: 'M', limit: 2, yoycolSku: 'Y-M' }, { size: 'L', limit: 1, yoycolSku: 'Y-L' }] },
    { id: 'later', chamberId: 'iii', name: 'LATER', priceCents: 4000, images: [], sizes: [{ size: 'M', limit: 5 }] },
    { id: 'secret', chamberId: 'v', name: 'SECRET', priceCents: 5000, images: [], sizes: [{ size: 'M', limit: 5 }] },
  ],
});

function fakeStripe() {
  const sessions = new Map();
  let n = 0;
  return {
    sessions,
    checkout: {
      sessions: {
        async create(params) {
          const id = `cs_test_${++n}`;
          const s = { id, url: `https://stripe.test/${id}`, status: 'open', payment_status: 'unpaid', params, metadata: params.metadata };
          sessions.set(id, s);
          return s;
        },
        async retrieve(id) { return sessions.get(id); },
        async expire(id) { sessions.get(id).status = 'expired'; return sessions.get(id); },
      },
    },
    webhooks: {
      constructEvent(raw, sig) {
        if (sig !== 'good') throw new Error('bad signature');
        return JSON.parse(raw.toString());
      },
    },
  };
}

async function setup(envOver = {}, cfg = baseConfig()) {
  let now = Date.parse('2026-11-09T12:00:00Z');
  const events = [];
  const env = { ...loadEnv({}), stripeWebhookSecret: 'whsec', appSecret: 'secret', adminPassword: 'pw', sigilSequence: ['a', 'b', 'c'], sigilRewardCode: 'ASCEND', webDir: '/nonexistent', eventsWebhook: 'http://n8n.test/hook', ...envOver };
  const db = openDb(':memory:');
  const stripe = fakeStripe();
  const built = await buildApp({
    env, db, stripe, getConfig: () => cfg, clock: () => now,
    fetchImpl: async (url, init) => { events.push(JSON.parse(init.body)); return { ok: true }; },
  });
  const post = (url, body, headers = {}) => built.app.inject({ method: 'POST', url, payload: body, headers });
  const paid = (sessionId, id = `evt_${sessionId}`) => post('/api/stripe/webhook', {
    id, type: 'checkout.session.completed',
    data: { object: { id: sessionId, payment_status: 'paid', amount_total: 4495, customer_details: { email: 'a@b.co', phone: '555' }, collected_information: { shipping_details: { name: 'A Soul', address: { line1: '1 Well Rd', city: 'Virginia Beach', state: 'VA', postal_code: '23455', country: 'US' } } } } },
  }, { 'stripe-signature': 'good' });
  const state = async (headers = {}) => (await built.app.inject({ url: '/api/state', headers })).json();
  return { ...built, db, stripe, env, events, post, paid, state, tick: (ms) => { now += ms; } };
}

const left = (st, pid, size) => st.products.find((p) => p.id === pid).sizes.find((s) => s.size === size).remaining;

test('chamber status is derived from date and stock', () => {
  const t = Date.parse('2026-01-01');
  assert.equal(chamberStatus({ status: 'live' }, { total: 5, remaining: 5 }, t), 'live');
  assert.equal(chamberStatus({ status: 'live' }, { total: 5, remaining: 0 }, t), 'soldout');
  assert.equal(chamberStatus({ status: 'live', goesLiveAt: '2026-02-01' }, { total: 5, remaining: 5 }, t), 'countdown');
  assert.equal(chamberStatus({ status: 'live' }, { total: 0, remaining: 0 }, t), 'dormant');
  assert.equal(chamberStatus({ status: 'locked' }, { total: 5, remaining: 5 }, t), 'locked');
});

test('cart input is validated', () => {
  assert.equal(normalizeItems([]), null);
  assert.equal(normalizeItems([{ productId: 'a', size: 'M', qty: 0 }]), null);
  assert.equal(normalizeItems([{ productId: 'a', size: 'M', qty: 99 }]), null);
  assert.deepEqual(normalizeItems([{ productId: 'a', size: 'M', qty: 1 }, { productId: 'a', size: 'M', qty: 2 }]), [{ productId: 'a', size: 'M', qty: 3 }]);
});

test('shipped config files are valid', async () => {
  const { createConfigLoader } = await import('../src/config.js');
  const cfg = createConfigLoader(new URL('../../config', import.meta.url).pathname)();
  assert.deepEqual(validateConfig(cfg), []);
});

test('state hides countdown and locked products and never leaks Yoycol SKUs', async () => {
  const t = await setup();
  const st = await t.state();
  assert.deepEqual(st.products.map((p) => p.id), ['tee']);
  assert.equal(JSON.stringify(st).includes('Y-M'), false);
  assert.equal(st.chambers.find((c) => c.id === 'iii').status, 'countdown');
});

test('checkout holds stock, payment turns it into a sale and a soul', async () => {
  const t = await setup();
  const res = await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 1 }] });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().url, /stripe\.test/);
  assert.equal(left(await t.state(), 'tee', 'M'), 1, 'one is held');

  const session = [...t.stripe.sessions.values()][0];
  assert.equal(session.params.line_items[0].price_data.unit_amount, 3800, 'price comes from the server');
  assert.equal(session.params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 695);

  assert.equal((await t.paid(session.id)).statusCode, 200);
  const st = await t.state();
  assert.equal(left(st, 'tee', 'M'), 1);
  assert.deepEqual(st.souls, [{ n: 1, c: 'iv' }]);
  const order = t.db.orderBySession(session.id);
  assert.equal(order.status, 'paid');
  assert.equal(order.ship_to.postalCode, '23455');
  assert.equal(t.events.find((e) => e.event === 'order.paid').data.items[0].yoycolSku, 'Y-M');

  // Stripe sometimes delivers twice: same event, and a different event for the same session.
  await t.paid(session.id);
  await t.paid(session.id, 'evt_other');
  assert.equal((await t.state()).souls.length, 1, 'still one soul');
  assert.equal(left(await t.state(), 'tee', 'M'), 1, 'stock not double counted');
});

test('the last shirt can only be held once', async () => {
  const t = await setup();
  const a = await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'L', qty: 1 }] });
  const b = await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'L', qty: 1 }] });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 409);
  assert.deepEqual(b.json(), { error: 'sold_out', items: [{ productId: 'tee', size: 'L' }] });
});

test('a mixed cart with one sold-out line holds nothing', async () => {
  const t = await setup();
  const res = await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 1 }, { productId: 'tee', size: 'L', qty: 2 }] });
  assert.equal(res.statusCode, 409);
  assert.equal(left(await t.state(), 'tee', 'M'), 2);
});

test('expired checkout puts stock back; sweep covers a missed webhook', async () => {
  const t = await setup();
  await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 2 }] });
  const [s1] = [...t.stripe.sessions.values()];
  await t.post('/api/stripe/webhook', { id: 'evt_x', type: 'checkout.session.expired', data: { object: { id: s1.id } } }, { 'stripe-signature': 'good' });
  assert.equal(left(await t.state(), 'tee', 'M'), 2);

  await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 1 }] });
  await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'L', qty: 1 }] });
  const [, s2, s3] = [...t.stripe.sessions.values()];
  s3.payment_status = 'paid'; // paid, but its webhook never arrived
  s3.customer_details = { email: 'late@b.co' };
  t.tick(36 * 60 * 1000);
  await t.commerce.sweep();
  const st = await t.state();
  assert.equal(left(st, 'tee', 'M'), 2, 'unpaid hold released');
  assert.equal(s2.status, 'expired');
  assert.equal(t.db.orderBySession(s3.id).status, 'paid', 'paid order recovered');
  assert.equal(st.souls.length, 1);
});

test('selling out seals the chamber and tells n8n', async () => {
  const t = await setup();
  t.watchChambers();
  for (const [size, qty] of [['M', 2], ['L', 1]]) {
    await t.post('/api/checkout', { items: [{ productId: 'tee', size, qty }] });
  }
  for (const s of t.stripe.sessions.values()) await t.paid(s.id);
  assert.equal((await t.state()).chambers.find((c) => c.id === 'iv').status, 'soldout');
  t.watchChambers();
  assert.ok(t.events.some((e) => e.event === 'chamber.sealed' && e.data.numeral === 'IV'));
});

test('webhook rejects a bad signature; checkout rejects closed chambers and junk', async () => {
  const t = await setup();
  assert.equal((await t.post('/api/stripe/webhook', { id: 'x' }, { 'stripe-signature': 'forged' })).statusCode, 400);
  assert.equal((await t.post('/api/checkout', { items: [{ productId: 'later', size: 'M', qty: 1 }] })).statusCode, 409);
  assert.equal((await t.post('/api/checkout', { items: [{ productId: 'secret', size: 'M', qty: 1 }] })).statusCode, 409);
  assert.equal((await t.post('/api/checkout', { items: 'nope' })).statusCode, 400);
});

test('the sigil sequence unlocks Chamber V', async () => {
  const t = await setup();
  assert.deepEqual((await t.post('/api/sigil', { sequence: ['c', 'b', 'a'] })).json(), { unlocked: false });
  const win = (await t.post('/api/sigil', { sequence: ['a', 'b', 'c'] })).json();
  assert.equal(win.unlocked, true);
  assert.equal(win.code, 'ASCEND');
  const st = await t.state({ 'x-unlock': win.token });
  assert.ok(st.products.some((p) => p.id === 'secret'));
  const res = await t.post('/api/checkout', { items: [{ productId: 'secret', size: 'M', qty: 1 }] }, { 'x-unlock': win.token });
  assert.equal(res.statusCode, 200);
  for (let i = 0; i < 4; i++) await t.post('/api/sigil', { sequence: ['x'] });
  assert.equal((await t.post('/api/sigil', { sequence: ['x'] })).statusCode, 429, 'guessing is rate limited');
});

test('manual fulfillment parks the order for the keeper; admin can mark it shipped', async () => {
  const t = await setup();
  await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 1 }] });
  const [s] = [...t.stripe.sessions.values()];
  await t.paid(s.id);
  await t.fulfillment.tick();
  const order = t.db.orderBySession(s.id);
  assert.equal(order.fulfillment, 'manual');

  const auth = { authorization: `Basic ${Buffer.from('keeper:pw').toString('base64')}` };
  assert.equal((await t.app.inject({ url: '/admin' })).statusCode, 401);
  const page = await t.app.inject({ url: '/admin', headers: auth });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /1 Well Rd/);
  const res = await t.app.inject({ method: 'POST', url: `/admin/orders/${order.id}`, headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=shipped&value=1Z999' });
  assert.equal(res.statusCode, 303);
  assert.equal(t.db.order(order.id).fulfillment, 'shipped');
  assert.equal(t.events.find((e) => e.event === 'order.shipped').data.tracking, '1Z999');
});

test('yoycol mode retries, then asks for attention while the adapter is unwired', async () => {
  const t = await setup({ fulfillmentMode: 'yoycol' });
  await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 1 }] });
  const [s] = [...t.stripe.sessions.values()];
  await t.paid(s.id);
  for (let i = 0; i < 3; i++) { await t.fulfillment.tick(); t.tick(11 * 60 * 1000); }
  assert.equal(t.db.orderBySession(s.id).fulfillment, 'attention');
  assert.ok(t.events.some((e) => e.event === 'order.attention'));
});

test('preview password guards the site but lets Stripe and health checks through', async () => {
  const t = await setup({ previewPassword: 'peek' });
  assert.equal((await t.app.inject({ url: '/api/state' })).statusCode, 401);
  assert.equal((await t.app.inject({ url: '/api/health' })).statusCode, 200);
  assert.equal((await t.post('/api/stripe/webhook', { id: 'x' }, { 'stripe-signature': 'forged' })).statusCode, 400);
  const auth = { authorization: `Basic ${Buffer.from('well:peek').toString('base64')}` };
  assert.equal((await t.app.inject({ url: '/api/state', headers: auth })).statusCode, 200);
  assert.equal((await t.app.inject({ url: '/admin', headers: auth })).statusCode, 401, 'preview password is not the admin password');
});

test('thanks page shows the soul number; shop lists live products; signup is stored once', async () => {
  const t = await setup();
  await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 1 }] });
  const [s] = [...t.stripe.sessions.values()];
  assert.match((await t.app.inject({ url: `/thanks?session_id=${s.id}` })).body, /is counting/);
  await t.paid(s.id);
  assert.match((await t.app.inject({ url: `/thanks?session_id=${s.id}` })).body, /Soul 001/);
  const shop = (await t.app.inject({ url: '/shop' })).body;
  assert.match(shop, /TEE/);
  assert.doesNotMatch(shop, /SECRET|LATER/);
  assert.equal((await t.post('/api/notify', { email: 'x@y.co', chamberId: 'iii' })).statusCode, 200);
  await t.post('/api/notify', { email: 'x@y.co', chamberId: 'iii' });
  assert.equal(t.events.filter((e) => e.event === 'signup.created').length, 1);
  assert.equal((await t.post('/api/notify', { email: 'nope', chamberId: 'iii' })).statusCode, 400);
});

test('the last pieces sitting in an open checkout do not announce a seal; paying for them does', async () => {
  const t = await setup();
  t.watchChambers();
  await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 2 }, { productId: 'tee', size: 'L', qty: 1 }] });
  assert.equal((await t.state()).chambers.find((c) => c.id === 'iv').status, 'soldout', 'nothing left to buy while held');
  t.watchChambers();
  assert.equal(t.events.filter((e) => e.event === 'chamber.sealed').length, 0, 'no public SEALED post for a hold');
  const [s] = [...t.stripe.sessions.values()];
  await t.paid(s.id);
  t.watchChambers();
  t.watchChambers();
  assert.equal(t.events.filter((e) => e.event === 'chamber.sealed').length, 1, 'sealed exactly once, when paid');
});

test('coming back from Stripe releases the hold at once; a paid order is never released', async () => {
  const t = await setup();
  const first = (await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'L', qty: 1 }] })).json();
  assert.match(first.orderId, /^[0-9a-f-]{36}$/);
  const [s1] = [...t.stripe.sessions.values()];
  assert.match(s1.params.cancel_url, new RegExp(`released=${first.orderId}$`));
  assert.equal(left(await t.state(), 'tee', 'L'), 0);
  assert.deepEqual((await t.post('/api/checkout/cancel', { orderId: first.orderId })).json(), { released: true });
  assert.equal(s1.status, 'expired', 'the Stripe page can no longer be paid');
  assert.equal(left(await t.state(), 'tee', 'L'), 1, 'back on sale');
  assert.deepEqual((await t.post('/api/checkout/cancel', { orderId: first.orderId })).json(), { released: false }, 'twice is harmless');
  assert.deepEqual((await t.post('/api/checkout/cancel', { orderId: 'junk' })).json(), { released: false });

  const second = (await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'L', qty: 1 }] })).json();
  const s2 = [...t.stripe.sessions.values()][1];
  s2.payment_status = 'paid'; s2.status = 'complete'; s2.customer_details = { email: 'p@b.co' };
  assert.deepEqual((await t.post('/api/checkout/cancel', { orderId: second.orderId })).json(), { released: false });
  assert.equal(t.db.order(second.orderId).status, 'paid', 'a late cancel on a paid checkout settles it instead');
  assert.equal(left(await t.state(), 'tee', 'L'), 0);
});

test('a second checkout from the same shopper replaces their own earlier hold', async () => {
  const t = await setup();
  const a = (await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'L', qty: 1 }] })).json();
  const blocked = await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'L', qty: 1 }] });
  assert.equal(blocked.statusCode, 409, 'a stranger cannot take the held piece');
  const b = await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'L', qty: 1 }], replaces: a.orderId });
  assert.equal(b.statusCode, 200, 'the holder can start again');
  assert.equal(t.db.order(a.orderId).status, 'expired');
});

test('a webhook that fails halfway is not marked as handled, so the retry works', async () => {
  const t = await setup();
  await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 1 }] });
  const [s] = [...t.stripe.sessions.values()];
  const realPaid = t.db.markPaid;
  t.db.markPaid = () => { throw new Error('disk hiccup'); };
  const orig = console.error; console.error = () => {};
  assert.equal((await t.paid(s.id)).statusCode, 500);
  console.error = orig;
  t.db.markPaid = realPaid;
  assert.equal((await t.paid(s.id)).statusCode, 200);
  assert.equal(t.db.orderBySession(s.id).status, 'paid');
});

test('admin refuses a form posted from another site or an opaque origin', async () => {
  const t = await setup();
  await t.post('/api/checkout', { items: [{ productId: 'tee', size: 'M', qty: 1 }] });
  const [s] = [...t.stripe.sessions.values()];
  await t.paid(s.id);
  const order = t.db.orderBySession(s.id);
  const auth = { authorization: `Basic ${Buffer.from('keeper:pw').toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' };
  for (const origin of ['null', 'https://evil.example']) {
    const res = await t.app.inject({ method: 'POST', url: `/admin/orders/${order.id}`, headers: { ...auth, origin }, payload: 'action=shipped&value=X' });
    assert.equal(res.statusCode, 403);
  }
  assert.notEqual(t.db.order(order.id).fulfillment, 'shipped');
});
