// Money path: hold stock -> Stripe Checkout -> "they paid" webhook -> sale + soul.
import crypto from 'node:crypto';
import { SoldOutError } from './db.js';
import { buildState } from './logic.js';

const HOLD_MINUTES = 31; // Stripe's shortest allowed checkout window is 30 minutes
const SWEEP_AFTER_MS = 35 * 60 * 1000;

export function createCommerce({ env, db, stripe, getConfig, notify, clock }) {
  function shippingFor(subtotal) {
    const free = env.freeShippingOverCents > 0 && subtotal >= env.freeShippingOverCents;
    return { amount: free ? 0 : env.shippingCents, name: free ? 'Free shipping' : 'Standard shipping' };
  }

  /** Returns { url } or { error, status, items? }. Never trusts prices or stock from the browser. */
  async function startCheckout(items, { unlocked }) {
    if (!stripe) return { status: 503, error: 'checkout_offline' };
    const cfg = getConfig();
    const state = buildState({ cfg, db, now: clock(), unlocked });
    const chambers = new Map(state.chambers.map((c) => [c.id, c]));
    const products = new Map(cfg.products.map((p) => [p.id, p]));

    const bad = [];
    for (const it of items) {
      const p = products.get(it.productId);
      const ch = p && chambers.get(p.chamberId);
      const open = ch && (ch.status === 'live' || (ch.status === 'locked' && unlocked));
      if (!p || !open || !p.sizes.some((s) => s.size === it.size)) bad.push({ productId: it.productId, size: it.size });
    }
    if (bad.length) return { status: 409, error: 'unavailable', items: bad };

    try {
      db.reserve(items);
    } catch (err) {
      if (err instanceof SoldOutError) return { status: 409, error: 'sold_out', items: err.items };
      throw err;
    }

    const id = crypto.randomUUID();
    const now = clock();
    db.createOrder(id, items, now);
    const subtotal = items.reduce((n, it) => n + products.get(it.productId).priceCents * it.qty, 0);
    const ship = shippingFor(subtotal);
    const publicImages = !env.previewPassword; // Stripe cannot load images behind the preview password
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: id,
        metadata: { order_id: id },
        line_items: items.map((it) => {
          const p = products.get(it.productId);
          const images = publicImages ? (p.images || []).slice(0, 1).map((u) => new URL(u, `${env.publicUrl}/`).href) : [];
          return {
            quantity: it.qty,
            price_data: {
              currency: 'usd',
              unit_amount: p.priceCents,
              product_data: { name: `${p.name} / ${it.size}`, ...(images.length ? { images } : {}), metadata: { product_id: p.id, size: it.size } },
            },
          };
        }),
        shipping_address_collection: { allowed_countries: env.shipCountries },
        shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', display_name: ship.name, fixed_amount: { amount: ship.amount, currency: 'usd' } } }],
        phone_number_collection: { enabled: true },
        allow_promotion_codes: true,
        ...(env.stripeTax ? { automatic_tax: { enabled: true } } : {}),
        expires_at: Math.floor(now / 1000) + HOLD_MINUTES * 60,
        success_url: `${env.publicUrl}/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.publicUrl}/?c=${products.get(items[0].productId).chamberId}`,
      });
      db.setSession(id, session.id);
      return { url: session.url };
    } catch (err) {
      db.expire(db.order(id));
      console.error('[checkout] Stripe refused the session:', err.message);
      return { status: 502, error: 'stripe_error' };
    }
  }

  function shipToFrom(session) {
    // Newer Stripe API versions nest shipping under collected_information.
    const sd = session.collected_information?.shipping_details || session.shipping_details || {};
    const a = sd.address || session.customer_details?.address || {};
    return {
      name: sd.name || session.customer_details?.name || '',
      phone: session.customer_details?.phone || '',
      line1: a.line1 || '', line2: a.line2 || '', city: a.city || '',
      state: a.state || '', postalCode: a.postal_code || '', country: a.country || '',
    };
  }

  function settlePaid(session) {
    const order = db.orderBySession(session.id) || (session.metadata?.order_id && db.order(session.metadata.order_id));
    if (!order) return console.warn(`[webhook] paid session ${session.id} matches no order`);
    const cfg = getConfig();
    const chamberId = cfg.products.find((p) => p.id === order.items[0].productId)?.chamberId || cfg.chambers[0].id;
    const shipTo = shipToFrom(session);
    const email = session.customer_details?.email || '';
    const soulNumber = db.markPaid(order, { paidAt: clock(), email, shipTo, amountCents: session.amount_total ?? null, chamberId });
    if (soulNumber === null) return; // already handled
    notify('order.paid', { orderId: order.id, soulNumber, email, shipTo, items: describe(order.items), amountCents: session.amount_total });
  }

  function describe(items) {
    const products = new Map(getConfig().products.map((p) => [p.id, p]));
    return items.map((it) => {
      const p = products.get(it.productId);
      return { ...it, name: p?.name || it.productId, yoycolSku: p?.sizes.find((s) => s.size === it.size)?.yoycolSku || '' };
    });
  }

  /** Handle a verified Stripe event. Running the same event twice changes nothing. */
  function handleEvent(event) {
    if (!db.firstTime(event.id, clock())) return;
    const session = event.data?.object;
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') settlePaid(session);
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const order = db.orderBySession(session.id);
      if (order && order.status === 'pending') db.expire(order);
    }
  }

  /** Safety net for missed webhooks: ask Stripe about old unpaid orders, then release them. */
  async function sweep() {
    for (const order of db.stalePending(clock() - SWEEP_AFTER_MS)) {
      try {
        if (stripe && order.stripe_session_id) {
          const s = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
          if (s.payment_status === 'paid') { settlePaid(s); continue; }
          if (s.status === 'open') await stripe.checkout.sessions.expire(s.id).catch(() => {});
        }
        db.expire(order);
      } catch (err) {
        console.error(`[sweep] order ${order.id}: ${err.message}`);
      }
    }
  }

  return { startCheckout, handleEvent, sweep, describe };
}
