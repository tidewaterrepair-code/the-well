// Yoycol API adapter.
//
// STATUS: NOT WIRED YET. Yoycol's API reference (https://www.yoycol.com/api/2025/redoc)
// could not be read when this file was written, so nothing here guesses at their
// endpoints. Until it is finished, keep FULFILLMENT_MODE=manual (orders show up in
// /admin with a copy-ready block) or dryrun.
//
// To finish it, give Claude Code the "Yoycol adapter" prompt in docs/PROMPTS.md.
// The rest of the app only needs these two functions to keep this exact shape:
//
//   createOrder(payload) -> { id }
//     payload = { reference, soulNumber, email,
//                 shipTo: { name, phone, line1, line2, city, state, postalCode, country },
//                 items:  [{ productId, size, qty, name, yoycolSku }] }
//     Must be idempotent on payload.reference: a retry must not create a second order.
//
//   getOrder(id) -> { status, tracking, trackingUrl }   (tracking is '' until it ships)

export function createYoycol(env) {
  const notReady = () => {
    throw new Error('Yoycol API adapter is not wired yet. Use FULFILLMENT_MODE=manual, or finish api/src/yoycol.js (see docs/PROMPTS.md).');
  };
  return {
    ready: false,
    hasKey: Boolean(env.yoycolApiKey),
    async createOrder(_payload) { return notReady(); },
    async getOrder(_id) { return notReady(); },
  };
}
