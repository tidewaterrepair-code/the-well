// Server-rendered pages: /shop (plain grid, good for Google and people in a hurry),
// /thanks (after payment) and /admin (orders).
import { esc, money } from './logic.js';

const shell = (title, body, extraHead = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${extraHead}
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#050506;color:#e8e2d6;font-family:Georgia,'Times New Roman',serif;line-height:1.5}
a{color:inherit}
header{padding:28px 20px 8px;text-align:center}
header a{text-decoration:none;letter-spacing:.42em;font-size:20px}
header p{margin:6px 0 0;letter-spacing:.3em;font-size:10px;color:#8d877c}
main{max-width:1080px;margin:0 auto;padding:20px}
h1{font-weight:400;letter-spacing:.2em;font-size:22px;text-transform:uppercase;text-align:center;margin:24px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px}
.card{border:1px solid #2a2824;padding:14px;text-decoration:none;display:block}
.card img{width:100%;aspect-ratio:1;object-fit:cover;background:#0d0d0f;display:block}
.card h2{font-weight:400;font-size:15px;letter-spacing:.14em;text-transform:uppercase;margin:12px 0 4px}
.muted{color:#8d877c;font-size:13px}
.big{font-size:clamp(28px,7vw,54px);letter-spacing:.16em;text-transform:uppercase;text-align:center;margin:18vh 0 12px;font-weight:400}
.center{text-align:center}
.btn{display:inline-block;border:1px solid #e8e2d6;padding:12px 22px;letter-spacing:.24em;font-size:12px;text-transform:uppercase;text-decoration:none;margin-top:24px}
table{border-collapse:collapse;width:100%;font:13px/1.4 system-ui,sans-serif}
td,th{border-bottom:1px solid #2a2824;padding:8px 6px;text-align:left;vertical-align:top}
input,button,textarea{font:inherit;background:#0d0d0f;color:inherit;border:1px solid #3a3731;padding:5px 8px}
button{cursor:pointer}
pre{white-space:pre-wrap;margin:0;font:12px/1.4 ui-monospace,monospace}
.tag{display:inline-block;padding:1px 7px;border:1px solid #3a3731;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.tag.attention{border-color:#c0392b;color:#ff8a7a}.tag.manual,.tag.queued{border-color:#b8860b;color:#e9c46a}
</style></head><body>
<header><a href="/">THE BLACK WELL</a><p>DESCEND / WEAR / BELONG</p></header>
<main>${body}</main></body></html>`;

export function shopPage(state, publicUrl) {
  const chambers = new Map(state.chambers.map((c) => [c.id, c]));
  const live = state.products.filter((p) => chambers.get(p.chamberId)?.status === 'live');
  const cards = live.map((p) => {
    const left = p.sizes.reduce((n, s) => n + s.remaining, 0);
    const ch = chambers.get(p.chamberId);
    return `<a class="card" href="/?c=${esc(ch.id)}&p=${esc(p.id)}">
      ${p.images[0] ? `<img src="${esc(p.images[0])}" alt="${esc(p.name)}" loading="lazy">` : ''}
      <h2>${esc(p.name)}</h2>
      <div>${money(p.priceCents)}</div>
      <div class="muted">Chamber ${esc(ch.numeral)} &middot; ${left > 0 ? `${left} remain` : 'Sealed'}</div></a>`;
  }).join('');
  const ld = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    itemListElement: live.map((p, i) => ({
      '@type': 'ListItem', position: i + 1,
      item: {
        '@type': 'Product', name: p.name, description: p.description,
        image: p.images.map((u) => new URL(u, `${publicUrl}/`).href),
        offers: { '@type': 'Offer', priceCurrency: 'USD', price: (p.priceCents / 100).toFixed(2), availability: p.sizes.some((s) => s.remaining > 0) ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut', url: `${publicUrl}/?c=${p.chamberId}&p=${p.id}` },
      },
    })),
  };
  const head = `<meta name="description" content="Every piece currently offered by The Black Well."><script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  const body = `<h1>What the Well offers</h1>${cards ? `<div class="grid">${cards}</div>` : `<p class="center muted">${esc(state.lore.nothingLive || 'NOTHING IS OFFERED. THE WELL WAITS.')}</p>`}
    <p class="center"><a class="btn" href="/">Enter the Engine</a></p>`;
  return shell('Shop | The Black Well', body, head);
}

export function thanksPage(order, lore) {
  if (order?.status === 'paid') {
    const n = String(order.soul_number).padStart(3, '0');
    return shell(`Soul ${n} | The Black Well`, `
      <p class="big">Soul ${n}<br>has descended</p>
      <p class="center muted">${esc(lore.thanksLine || 'THE WELL KEEPS WHAT IT IS GIVEN.')}</p>
      <p class="center">A receipt is on its way to ${esc(order.email || 'your email')}. A lantern now burns for you on the Engine.</p>
      <p class="center"><a class="btn" href="/?soul=${order.soul_number}">Find your lantern</a></p>
      <script>try{localStorage.removeItem('well.cart')}catch(e){}</script>`);
  }
  // Paid on Stripe but the webhook has not landed yet: wait and look again.
  return shell('The Well is counting', `
    <p class="big">The Well<br>is counting</p>
    <p class="center muted">Your payment is being confirmed. This page will update on its own.</p>
    <script>setTimeout(function(){location.reload()},3000)</script>`);
}

const when = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }) : '');

export function adminPage({ orders, stock, describe, mode, yoycolReady }) {
  const rows = orders.map((o) => {
    const items = describe(o.items);
    const a = o.ship_to || {};
    const block = [
      a.name, a.line1, a.line2, `${a.city || ''}, ${a.state || ''} ${a.postalCode || ''}`, a.country, a.phone, o.email, '',
      ...items.map((i) => `${i.qty} x ${i.name} / ${i.size}${i.yoycolSku ? ` [${i.yoycolSku}]` : ''}`),
    ].filter((l) => l !== undefined && l !== null && l !== '').join('\n');
    const act = (action, label, field) => `<form method="post" action="/admin/orders/${esc(o.id)}" style="display:flex;gap:4px;margin:3px 0">
      <input type="hidden" name="action" value="${action}">${field ? `<input name="value" placeholder="${field}" size="14" required>` : ''}<button>${label}</button></form>`;
    return `<tr>
      <td>${o.soul_number ? `SOUL ${String(o.soul_number).padStart(3, '0')}` : '-'}<br><span class="muted">${when(o.paid_at || o.created_at)}</span></td>
      <td><span class="tag ${esc(o.status)}">${esc(o.status)}</span> <span class="tag ${esc(o.fulfillment)}">${esc(o.fulfillment)}</span>
        ${o.last_error ? `<div class="muted" style="color:#ff8a7a">${esc(o.last_error)}</div>` : ''}
        ${o.yoycol_order_id ? `<div class="muted">Yoycol: ${esc(o.yoycol_order_id)}</div>` : ''}${o.tracking ? `<div class="muted">Tracking: ${esc(o.tracking)}</div>` : ''}</td>
      <td><pre>${esc(block)}</pre>${o.status === 'paid' ? `<button type="button" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent);this.textContent='Copied'">Copy for Yoycol</button>` : ''}</td>
      <td>${o.amount_cents != null ? money(o.amount_cents) : ''}</td>
      <td>${o.status === 'paid' ? `${['manual', 'dryrun', 'attention', 'queued'].includes(o.fulfillment) ? act('placed', 'Placed in Yoycol', 'Yoycol order #') : ''}
        ${o.fulfillment !== 'shipped' ? act('shipped', 'Mark shipped', 'Tracking #') : ''}
        ${['attention', 'dryrun', 'manual'].includes(o.fulfillment) && mode === 'yoycol' ? act('retry', 'Send again') : ''}` : ''}</td></tr>`;
  }).join('');
  const stockRows = stock.map((s) => `<tr><td>${esc(s.product_id)}</td><td>${esc(s.size)}</td><td>${s.total}</td><td>${s.sold}</td><td>${s.reserved}</td><td>${Math.max(0, s.total - s.sold - s.reserved)}</td></tr>`).join('');
  return shell('Orders | The Black Well', `
    <h1>Orders</h1>
    <p class="muted">Fulfillment mode: <b>${esc(mode)}</b>${mode === 'yoycol' && !yoycolReady ? ' (adapter not wired yet: orders will land in "attention")' : ''}. "manual" means: copy the block, place it in Yoycol, then record the Yoycol order number here.</p>
    <table><tr><th>Soul</th><th>Status</th><th>Ship to / items</th><th>Total</th><th>Actions</th></tr>${rows || '<tr><td colspan="5" class="muted">No orders yet.</td></tr>'}</table>
    <h1>Stock</h1>
    <table><tr><th>Product</th><th>Size</th><th>Limit</th><th>Sold</th><th>Held</th><th>Left</th></tr>${stockRows}</table>
    <p class="muted">Limits come from config/products.json. Raise a limit there to restock.</p>`);
}
