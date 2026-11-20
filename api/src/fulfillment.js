// After payment: get the order to Yoycol.
//   manual  - you place it by hand in Yoycol; /admin shows a copy-ready block (default, always works)
//   dryrun  - logs exactly what WOULD be sent to Yoycol, sends nothing
//   yoycol  - sends through the Yoycol API adapter (src/yoycol.js)
import { createYoycol } from './yoycol.js';

const RETRY_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export function createFulfillment({ env, db, notify, clock, describe, adapter = createYoycol(env) }) {
  const payloadFor = (order) => ({
    reference: order.id,
    soulNumber: order.soul_number,
    email: order.email,
    shipTo: order.ship_to,
    items: describe(order.items),
  });

  async function tick() {
    for (const order of db.queued(clock())) {
      const payload = payloadFor(order);
      if (env.fulfillmentMode === 'manual') {
        db.setFulfillment(order, { fulfillment: 'manual' });
      } else if (env.fulfillmentMode === 'dryrun') {
        console.log('[fulfillment] DRY RUN, would send to Yoycol:\n' + JSON.stringify(payload, null, 2));
        db.setFulfillment(order, { fulfillment: 'dryrun' });
      } else {
        try {
          const missing = payload.items.filter((i) => !i.yoycolSku).map((i) => `${i.name} ${i.size}`);
          if (missing.length) throw new Error(`no yoycolSku in products.json for: ${missing.join(', ')}`);
          const { id } = await adapter.createOrder(payload);
          db.setFulfillment(order, { fulfillment: 'sent', yoycolOrderId: String(id) });
        } catch (err) {
          const attempts = order.attempts + 1;
          const failed = attempts >= MAX_ATTEMPTS;
          db.setFulfillment(order, {
            fulfillment: failed ? 'attention' : 'queued', attempts,
            nextAttemptAt: clock() + RETRY_MS, lastError: String(err.message).slice(0, 500),
          });
          if (failed) notify('order.attention', { orderId: order.id, soulNumber: order.soul_number, error: err.message });
        }
      }
    }
  }

  /** Ask Yoycol for tracking numbers on orders it has but has not shipped yet. */
  async function pollTracking() {
    if (env.fulfillmentMode !== 'yoycol') return;
    for (const order of db.sent()) {
      try {
        const { tracking, trackingUrl } = await adapter.getOrder(order.yoycol_order_id);
        if (tracking) markShipped(order, tracking, trackingUrl);
      } catch (err) {
        console.error(`[tracking] order ${order.id}: ${err.message}`);
      }
    }
  }

  function markShipped(order, tracking, trackingUrl = '') {
    db.setFulfillment(order, { fulfillment: 'shipped', tracking });
    notify('order.shipped', { orderId: order.id, soulNumber: order.soul_number, email: order.email, name: order.ship_to?.name, tracking, trackingUrl });
  }

  return { tick, pollTracking, markShipped, payloadFor };
}
