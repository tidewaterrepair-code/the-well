// Everything made of words and buttons: top bar, chamber hotspots, the product
// vault, the cart, and the slide-in sheets. All text comes from the server's state.
import type { Chamber, Product, State, View } from './types';
import { clamp, esc, money, pad3, project, store } from './types';

export interface CartLine { productId: string; size: string; qty: number }

export interface Host {
  state(): State;
  current(): Chamber | null;
  clockOffset(): number;
  goTo(id: string, thenEnter?: boolean): void;
  enter(): void;
  leave(): void;
  explore(): void;
  checkout(items: CartLine[]): Promise<void>;
  signup(email: string, chamberId: string): Promise<boolean>;
  toggleSound(): boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function countdownText(ms: number) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  return d > 0 ? `${d}D ${hms}` : hms;
}

export class UI {
  cart: CartLine[] = store.get<CartLine[]>('well.cart', []);
  vaultCh: Chamber | null = null;
  private pi = 0; private ii = 0; private size = '';
  private spots = new Map<string, HTMLElement>();
  private toastTimer = 0; private tipTimer = 0;
  private busy = false;

  constructor(private host: Host) {
    document.addEventListener('click', (e) => this.onClick(e));
    document.addEventListener('submit', (e) => this.onSubmit(e));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeAll(); });
    setInterval(() => this.tickClocks(), 1000);
  }

  // ---------------------------------------------------------------- static text
  refresh() {
    const s = this.host.state();
    const L = s.lore;
    $('masthead').textContent = L.masthead || 'THE BLACK WELL';
    $('creed').textContent = L.creed || '';
    $('title').innerHTML = esc(L.title || '').replace(/^(THE)\s/i, '$1<br>');
    $('subtitle').textContent = L.subtitle || '';
    $('intro').textContent = L.intro || '';
    $('footer').textContent = L.footer || '';
    $('tagR').textContent = (L.taglines || [])[1] || '';
    $('soulCount').textContent = String(s.souls.length);
    $('onlineLine').textContent = s.online > 1 ? `${s.online} ARE HERE NOW` : '';

    // cart may hold things that have since sold out or left the store
    const valid = (l: CartLine) => s.products.some((p) => p.id === l.productId && p.sizes.some((z) => z.size === l.size));
    if (s.products.length && this.cart.some((l) => !valid(l))) { this.cart = this.cart.filter(valid); this.saveCart(); }
    this.cartCount();

    const onSphere = s.chambers.filter((c) => c.status !== 'archived');
    const box = $('spots');
    for (const [id, el] of this.spots) if (!onSphere.some((c) => c.id === id)) { el.remove(); this.spots.delete(id); }
    for (const c of onSphere) {
      let el = this.spots.get(c.id);
      if (!el) {
        el = document.createElement('button');
        el.dataset.spot = c.id;
        box.appendChild(el);
        this.spots.set(c.id, el);
      }
      el.className = `spot s-${c.status}`;
      el.setAttribute('aria-label', `Chamber ${c.numeral}, ${c.name}, ${c.status}`);
      el.innerHTML = `<i class="ring"></i><span><small>CHAMBER ${esc(c.numeral)}</small><b>${esc(c.status === 'locked' ? '· · ·' : c.name)}</b></span>`;
    }
    $('chips').innerHTML = onSphere.map((c) => `<button data-chip="${esc(c.id)}" class="s-${c.status}" aria-label="Chamber ${esc(c.numeral)}">${esc(c.numeral)}</button>`).join('');
    this.setCurrent(this.host.current());
    if (this.vaultCh) {
      this.vaultCh = s.chambers.find((c) => c.id === this.vaultCh!.id) || null;
      this.renderVault();
    }
    if ($('cart').classList.contains('open')) this.renderCart();
  }

  setTagline(text: string) {
    const el = $('tagL');
    if (el.textContent === text) return;
    el.style.opacity = '0';
    setTimeout(() => { el.textContent = text; el.style.opacity = '1'; }, 400);
  }

  setCurrent(c: Chamber | null) {
    document.querySelectorAll<HTMLElement>('[data-chip]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.chip === c?.id)));
    if (!c) return;
    const L = this.host.state().lore;
    const line = { live: c.scrollLine, soldout: L.soldOutLine, countdown: L.countdownLine, locked: L.lockedLine, dormant: L.dormantLine, archived: '' }[c.status] || '';
    $('phoneLine').innerHTML = `<span>CHAMBER ${esc(c.numeral)} &middot; ${esc(c.status === 'locked' ? '· · ·' : c.name)}<br>${esc(line)}</span>`;
    const btn = $('enterBtn');
    btn.classList.toggle('live', c.status === 'live');
    btn.dataset.status = c.status;
    this.tickClocks();
  }

  private tickClocks() {
    const c = this.host.current();
    const now = Date.now() + this.host.clockOffset();
    const left = (ch: Chamber) => (ch.goesLiveAt ? Date.parse(ch.goesLiveAt) - now : 0);
    if (c) {
      const label = { live: `ENTER CHAMBER ${c.numeral}`, soldout: 'SEALED · LOOK INSIDE', countdown: `OPENS IN ${countdownText(left(c))}`, locked: 'SEALED', dormant: 'DORMANT', archived: '' }[c.status];
      if ($('enterBtn').textContent !== label) $('enterBtn').textContent = label;
    }
    const big = document.querySelector<HTMLElement>('#vault [data-clock]');
    if (big && this.vaultCh) big.textContent = countdownText(left(this.vaultCh));
  }

  /** Called every frame: pin each hotspot to its place on the turning sphere. */
  place(v: View, near: string | null) {
    const s = this.host.state();
    const { frames, dir } = s.scene.ring;
    for (const c of s.chambers) {
      const el = this.spots.get(c.id);
      if (!el) continue;
      const p = project(v, frames, dir, c.frame, c.lon, c.lat);
      const mine = c.id === near;
      const o = clamp((p.z - 0.42) / 0.3, 0, 1) * clamp(1 - v.dim * 4, 0, 1) * (mine ? 1 : 0.45);
      el.classList.toggle('near', mine);
      el.style.opacity = o.toFixed(2);
      el.style.pointerEvents = o > 0.5 ? 'auto' : 'none';
      el.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
    }
  }

  progress(f: number) {
    $('loadbar').style.width = `${Math.round(f * 100)}%`;
    if (f >= 0.999) $('loadbar').parentElement!.classList.add('done');
  }

  toast(msg: string, ms = 4200) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('on'), ms);
  }

  tip(x: number, y: number, text: string) {
    const el = $('tip');
    el.textContent = text;
    el.style.transform = `translate(${Math.min(x + 12, innerWidth - 110)}px,${Math.max(8, y - 30)}px)`;
    el.classList.add('on');
    clearTimeout(this.tipTimer);
    this.tipTimer = window.setTimeout(() => el.classList.remove('on'), 1800);
  }

  flash() {
    const hud = $('hud');
    hud.classList.remove('flash');
    void hud.offsetWidth;
    hud.classList.add('flash');
  }

  // ---------------------------------------------------------------- vault
  showVault(c: Chamber, productId?: string) {
    this.vaultCh = c;
    const prods = this.productsOf(c);
    this.pi = Math.max(0, prods.findIndex((p) => p.id === productId));
    this.ii = 0;
    this.size = '';
    const el = $('vault');
    el.hidden = false;
    this.renderVault();
    requestAnimationFrame(() => el.classList.add('open'));
    document.querySelector('.phonebar')?.classList.add('away');
  }

  hideVault() {
    this.vaultCh = null;
    const el = $('vault');
    el.classList.remove('open');
    setTimeout(() => { if (!this.vaultCh) el.hidden = true; }, 460);
    document.querySelector('.phonebar')?.classList.remove('away');
  }

  private productsOf(c: Chamber): Product[] {
    return this.host.state().products.filter((p) => p.chamberId === c.id);
  }

  private renderVault() {
    const c = this.vaultCh;
    if (!c) return this.hideVault();
    const s = this.host.state();
    const L = s.lore;
    const prods = this.productsOf(c);
    const head = `<button class="x" data-close aria-label="Close">&times;</button>
      <div class="v-head"><small>CHAMBER ${esc(c.numeral)}</small><b>${esc(c.status === 'locked' && !s.unlocked ? '· · ·' : c.name)}</b></div>`;
    const canBuy = c.status === 'live' || (c.status === 'locked' && s.unlocked);
    let body: string;

    if (prods.length && (canBuy || c.status === 'soldout')) {
      this.pi = clamp(this.pi, 0, prods.length - 1);
      const p = prods[this.pi];
      this.ii = clamp(this.ii, 0, Math.max(0, p.images.length - 1));
      const left = p.sizes.reduce((n, z) => n + z.remaining, 0);
      if (this.size && !(p.sizes.find((z) => z.size === this.size)?.remaining)) this.size = '';
      const gone = !canBuy || left === 0;
      body = `<p class="v-kicker">PRODUCT VAULT</p>
        <div class="v-body">
          <div class="v-img">${p.images.length ? `<img src="${esc(p.images[this.ii])}" alt="${esc(p.name)}">` : ''}
            ${p.images.length > 1 ? `<button class="nav prev" data-img="-1" aria-label="Previous photo">&lsaquo;</button><button class="nav next" data-img="1" aria-label="Next photo">&rsaquo;</button><span class="count">${this.ii + 1} / ${p.images.length}</span>` : ''}</div>
          <h3 class="v-name">${esc(p.name)}</h3>
          <p class="v-desc">${esc(p.description)}</p>
          <div class="v-row"><span class="v-price">${money(p.priceCents)}</span><span class="v-left">${gone ? 'SEALED' : left <= 12 ? `ONLY ${left} REMAIN` : 'LIMITED'}</span></div>
        </div>
        <div class="v-buy">
          <div class="sizes" role="group" aria-label="Size">${p.sizes.map((z) => `<button data-size="${esc(z.size)}" aria-pressed="${this.size === z.size}" ${z.remaining > 0 && canBuy ? '' : 'disabled'}>${esc(z.size)}</button>`).join('')}</div>
          <button class="btn solid" data-add ${gone ? 'disabled' : ''}>${gone ? esc(L.soldOutLine || 'SEALED') : this.size ? 'ADD TO CART' : 'CHOOSE A SIZE'}</button>
        </div>
        ${prods.length > 1 ? `<div class="v-others">${prods.map((q, i) => `<button data-prod="${i}" aria-current="${i === this.pi}">${esc(q.name)}</button>`).join('')}</div>` : ''}`;
    } else if (c.status === 'countdown') {
      body = `<div class="v-state"><p class="big" data-clock>--:--:--</p><p>${esc(L.countdownLine || '')}</p>
        <form data-signup><input type="email" name="email" placeholder="you@example.com" autocomplete="email" required aria-label="Email"><button class="btn solid">WAKE ME</button></form></div>`;
    } else {
      const line = { locked: L.lockedLine, soldout: L.soldOutLine, dormant: L.dormantLine }[c.status as 'locked'] || c.scrollLine;
      body = `<div class="v-state"><p>${esc(line || '')}</p></div>`;
    }
    $('vault').innerHTML = head + body;
    this.tickClocks();
  }

  // ---------------------------------------------------------------- cart
  private saveCart() { store.set('well.cart', this.cart); }
  private cartCount() {
    const n = this.cart.reduce((a, l) => a + l.qty, 0);
    $('cartBtn').textContent = `${this.host.state().lore.cartLabel || 'CART'} (${n})`;
  }

  private addToCart(p: Product, size: string) {
    const max = Math.min(5, p.sizes.find((z) => z.size === size)?.remaining ?? 0);
    const line = this.cart.find((l) => l.productId === p.id && l.size === size);
    if (line) line.qty = Math.min(max, line.qty + 1);
    else if (max > 0) this.cart.push({ productId: p.id, size, qty: 1 });
    this.saveCart();
    this.cartCount();
    this.openCart();
  }

  removeLines(items: { productId: string; size: string }[]) {
    this.cart = this.cart.filter((l) => !items.some((i) => i.productId === l.productId && i.size === l.size));
    this.saveCart();
    this.cartCount();
    this.renderCart();
  }

  openCart() {
    const el = $('cart');
    el.hidden = false;
    this.renderCart();
    requestAnimationFrame(() => el.classList.add('open'));
  }

  private renderCart() {
    const s = this.host.state();
    let subtotal = 0;
    const lines = this.cart.map((l, i) => {
      const p = s.products.find((x) => x.id === l.productId);
      if (!p) return '';
      subtotal += p.priceCents * l.qty;
      return `<div class="line">${p.images[0] ? `<img src="${esc(p.images[0])}" alt="">` : '<span></span>'}
        <div><b>${esc(p.name)}</b><small>SIZE ${esc(l.size)} &middot; ${money(p.priceCents)}</small></div>
        <div class="qty"><button data-qty="${i}:-1" aria-label="One fewer">&minus;</button><span>${l.qty}</span><button data-qty="${i}:1" aria-label="One more">+</button></div></div>`;
    }).join('');
    $('cart').innerHTML = `<button class="x" data-close aria-label="Close">&times;</button><h3>${esc(s.lore.cartLabel || 'CART')}</h3>
      ${lines || `<p class="empty">NOTHING HAS BEEN CHOSEN.</p>`}
      ${lines ? `<div class="cart-foot"><div class="v-row"><span>SUBTOTAL</span><span class="v-price">${money(subtotal)}</span></div>
        <small>SHIPPING AND TAX ARE SHOWN AT CHECKOUT. YOUR PIECES ARE HELD FOR 30 MINUTES ONCE YOU CONTINUE.</small>
        <button class="btn solid" data-checkout ${this.busy ? 'disabled' : ''}>${this.busy ? 'OPENING' : 'CHECKOUT'}</button></div>` : ''}`;
  }

  // ---------------------------------------------------------------- sheets
  private openSheet(kind: string) {
    const s = this.host.state();
    const L = s.lore;
    let html = '';
    if (kind === 'lore') {
      html = `<h3>LORE</h3><p class="sheet-body">${esc(L.intro || '')}</p>
        ${s.chambers.map((c) => (c.scrollLine && c.status !== 'locked' ? `<p class="law">${esc(c.numeral)} &middot; ${esc(c.scrollLine)}</p>` : '')).join('')}`;
    } else {
      const archive = kind === 'archive';
      const list = s.chambers.filter((c) => (archive ? c.status === 'soldout' || c.status === 'archived' : c.status !== 'archived'));
      html = `<h3>${archive ? 'ARCHIVE' : 'CHAMBERS'}</h3><div class="sheet-list">${list.map((c) => {
        const inner = `<span>${esc(c.numeral)} &middot; ${esc(c.status === 'locked' ? '· · ·' : c.name)}</span><small>${esc({ live: `${c.remaining} REMAIN`, soldout: 'SEALED', countdown: 'COUNTING', locked: 'SEALED', dormant: 'DORMANT', archived: 'GONE' }[c.status])}</small>`;
        return c.status === 'archived' ? `<div>${inner}</div>` : `<button data-go="${esc(c.id)}">${inner}</button>`;
      }).join('') || `<p class="empty">NOTHING HAS BEEN SEALED YET.</p>`}</div>`;
    }
    html += `<div class="sheet-links"><a href="shop">SHOP</a><button data-sheet="lore">LORE</button><button data-sheet="archive">ARCHIVE</button><button data-sound>SOUND</button>
      <a href="legal/shipping.html">SHIPPING</a><a href="legal/returns.html">RETURNS</a><a href="legal/privacy.html">PRIVACY</a></div>`;
    const el = $('sheet');
    el.innerHTML = `<button class="x" data-close aria-label="Close">&times;</button>${html}`;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
  }

  private closeDrawer(id: string) {
    const el = $(id);
    el.classList.remove('open');
    setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 420);
  }

  closeAll() {
    if ($('cart').classList.contains('open')) return this.closeDrawer('cart');
    if ($('sheet').classList.contains('open')) return this.closeDrawer('sheet');
    if (this.vaultCh) this.host.leave();
  }

  // ---------------------------------------------------------------- events
  private onClick(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button, a');
    if (!t) return;
    const d = t.dataset;
    const c = this.vaultCh;
    const prods = c ? this.productsOf(c) : [];
    if ('close' in d) {
      const host = t.parentElement!.id;
      if (host === 'vault') this.host.leave(); else this.closeDrawer(host);
    } else if (d.spot || d.chip) {
      const id = (d.spot || d.chip)!;
      if (this.host.current()?.id === id && d.spot) this.host.enter(); else this.host.goTo(id, Boolean(d.spot));
    } else if (d.go) { this.closeDrawer('sheet'); this.host.goTo(d.go, true); }
    else if (d.sheet) this.openSheet(d.sheet);
    else if (t.id === 'cartBtn') this.openCart();
    else if (t.id === 'enterBtn' || t.id === 'actEnter') this.host.enter();
    else if (t.id === 'actExplore') this.host.explore();
    else if (t.id === 'sound' || 'sound' in d) {
      const on = this.host.toggleSound();
      $('sound').textContent = on ? 'SOUND ON' : 'SOUND OFF';
      $('sound').setAttribute('aria-pressed', String(on));
      if ('sound' in d) t.textContent = on ? 'SOUND ON' : 'SOUND';
    } else if (d.size) { this.size = d.size; this.renderVault(); }
    else if (d.img) { const n = prods[this.pi]?.images.length || 1; this.ii = (this.ii + Number(d.img) + n) % n; this.renderVault(); }
    else if (d.prod) { this.pi = Number(d.prod); this.ii = 0; this.size = ''; this.renderVault(); }
    else if ('add' in d) {
      const p = prods[this.pi];
      if (!p) return;
      if (!this.size) return this.toast('CHOOSE A SIZE FIRST.', 2200);
      this.addToCart(p, this.size);
    } else if (d.qty) {
      const [i, step] = d.qty.split(':').map(Number);
      const l = this.cart[i];
      if (!l) return;
      const p = this.host.state().products.find((x) => x.id === l.productId);
      const max = Math.min(5, p?.sizes.find((z) => z.size === l.size)?.remaining ?? 5);
      l.qty += step;
      if (l.qty > max) { l.qty = max; this.toast(max >= 5 ? 'FIVE OF ONE PIECE IS THE LIMIT.' : `ONLY ${max} REMAIN IN THAT SIZE.`, 2400); }
      if (l.qty <= 0) this.cart.splice(i, 1);
      this.saveCart(); this.cartCount(); this.renderCart();
    } else if ('checkout' in d && !this.busy) {
      this.busy = true;
      this.renderCart();
      void this.host.checkout(this.cart).finally(() => { this.busy = false; if ($('cart').classList.contains('open')) this.renderCart(); });
    }
  }

  private onSubmit(e: Event) {
    const form = e.target as HTMLFormElement;
    if (!('signup' in form.dataset)) return;
    e.preventDefault();
    const email = String(new FormData(form).get('email') || '');
    const c = this.vaultCh;
    if (!c) return;
    void this.host.signup(email, c.id).then((ok) => {
      if (ok) form.outerHTML = '<p>THE WELL HAS YOUR NAME. IT WILL CALL.</p>';
      else this.toast('THAT ADDRESS DID NOT TAKE. TRY AGAIN.');
    });
  }
}
