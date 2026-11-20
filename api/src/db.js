// One small SQLite file holds stock, orders and souls. No database server to run.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stock(
  product_id TEXT NOT NULL, size TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0, sold INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(product_id, size));
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, stripe_session_id TEXT UNIQUE,
  status TEXT NOT NULL,                       -- pending | paid | expired
  fulfillment TEXT NOT NULL DEFAULT 'none',   -- none | queued | manual | dryrun | sent | shipped | attention
  items TEXT NOT NULL, amount_cents INTEGER, email TEXT, ship_to TEXT,
  soul_number INTEGER, yoycol_order_id TEXT, tracking TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL, paid_at INTEGER);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at);
CREATE TABLE IF NOT EXISTS souls(
  soul_number INTEGER PRIMARY KEY AUTOINCREMENT, chamber_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS signups(
  email TEXT NOT NULL, chamber_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(email, chamber_id));
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS stripe_events(id TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

export class SoldOutError extends Error {
  constructor(items) {
    super('sold out');
    this.items = items;
  }
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sql = new Database(file);
  sql.pragma('journal_mode = WAL');
  sql.pragma('busy_timeout = 5000');
  sql.exec(SCHEMA);

  const q = {
    upsertStock: sql.prepare(`INSERT INTO stock(product_id,size,total) VALUES(?,?,?)
      ON CONFLICT(product_id,size) DO UPDATE SET total=excluded.total`),
    allStock: sql.prepare('SELECT * FROM stock'),
    reserve: sql.prepare(`UPDATE stock SET reserved = reserved + @qty
      WHERE product_id=@productId AND size=@size AND total - sold - reserved >= @qty`),
    release: sql.prepare(`UPDATE stock SET reserved = MAX(0, reserved - @qty) WHERE product_id=@productId AND size=@size`),
    commit: sql.prepare(`UPDATE stock SET reserved = MAX(0, reserved - @qty), sold = sold + @qty WHERE product_id=@productId AND size=@size`),
    sellDirect: sql.prepare(`UPDATE stock SET sold = sold + @qty WHERE product_id=@productId AND size=@size`),
    insertOrder: sql.prepare(`INSERT INTO orders(id,status,items,created_at) VALUES(@id,'pending',@items,@createdAt)`),
    setSession: sql.prepare('UPDATE orders SET stripe_session_id=? WHERE id=?'),
    order: sql.prepare('SELECT * FROM orders WHERE id=?'),
    orderBySession: sql.prepare('SELECT * FROM orders WHERE stripe_session_id=?'),
    expirePending: sql.prepare(`UPDATE orders SET status='expired' WHERE id=? AND status='pending'`),
    markPaid: sql.prepare(`UPDATE orders SET status='paid', fulfillment='queued', paid_at=@paidAt, email=@email,
      ship_to=@shipTo, amount_cents=@amountCents, soul_number=@soulNumber, last_error=@note WHERE id=@id`),
    insertSoul: sql.prepare('INSERT INTO souls(chamber_id, created_at) VALUES(?,?)'),
    souls: sql.prepare('SELECT soul_number AS n, chamber_id AS c FROM souls ORDER BY soul_number'),
    stalePending: sql.prepare(`SELECT * FROM orders WHERE status='pending' AND created_at < ?`),
    queued: sql.prepare(`SELECT * FROM orders WHERE fulfillment='queued' AND next_attempt_at <= ? ORDER BY paid_at LIMIT 20`),
    sent: sql.prepare(`SELECT * FROM orders WHERE fulfillment='sent' AND yoycol_order_id IS NOT NULL LIMIT 100`),
    recent: sql.prepare(`SELECT * FROM orders WHERE status != 'expired' ORDER BY created_at DESC LIMIT ?`),
    setFulfillment: sql.prepare(`UPDATE orders SET fulfillment=@fulfillment, yoycol_order_id=COALESCE(@yoycolOrderId, yoycol_order_id),
      tracking=COALESCE(@tracking, tracking), attempts=@attempts, next_attempt_at=@nextAttemptAt, last_error=@lastError WHERE id=@id`),
    signup: sql.prepare('INSERT OR IGNORE INTO signups(email,chamber_id,created_at) VALUES(?,?,?)'),
    kvGet: sql.prepare('SELECT v FROM kv WHERE k=?'),
    kvSet: sql.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
    seenEvent: sql.prepare('INSERT OR IGNORE INTO stripe_events(id,at) VALUES(?,?)'),
    forgetEvent: sql.prepare('DELETE FROM stripe_events WHERE id=?'),
  };

  const parse = (o) => o && { ...o, items: JSON.parse(o.items), ship_to: o.ship_to ? JSON.parse(o.ship_to) : null };

  const db = {
    sql,
    /** Make stock totals match products.json. Never touches what is already sold. */
    syncStock(products) {
      sql.transaction(() => {
        for (const p of products) for (const s of p.sizes) q.upsertStock.run(p.id, s.size, s.limit);
      })();
    },
    stockMap() {
      const m = new Map();
      for (const r of q.allStock.all()) m.set(`${r.product_id}|${r.size}`, r);
      return m;
    },
    /** Hold items for a shopper. All or nothing: throws SoldOutError listing what ran out. */
    reserve: sql.transaction((items) => {
      const out = items.filter((it) => q.reserve.run(it).changes === 0);
      if (out.length) throw new SoldOutError(out.map(({ productId, size }) => ({ productId, size })));
    }),
    release: sql.transaction((items) => items.forEach((it) => q.release.run(it))),
    createOrder(id, items, createdAt) {
      q.insertOrder.run({ id, items: JSON.stringify(items), createdAt });
    },
    setSession: (id, sessionId) => q.setSession.run(sessionId, id),
    order: (id) => parse(q.order.get(id)),
    orderBySession: (sid) => parse(q.orderBySession.get(sid)),
    /** Give up on an unpaid order and put its items back on the shelf. */
    expire: sql.transaction((order) => {
      if (q.expirePending.run(order.id).changes) order.items.forEach((it) => q.release.run(it));
    }),
    /** Turn a held order into a sale and mint its soul. Safe to call twice. */
    markPaid: sql.transaction((order, { paidAt, email, shipTo, amountCents, chamberId }) => {
      const fresh = q.order.get(order.id);
      if (!fresh || fresh.status === 'paid') return null;
      const late = fresh.status === 'expired'; // paid after we released the hold
      order.items.forEach((it) => (late ? q.sellDirect : q.commit).run(it));
      const soulNumber = Number(q.insertSoul.run(chamberId, paidAt).lastInsertRowid);
      q.markPaid.run({
        id: order.id, paidAt, email, shipTo: JSON.stringify(shipTo), amountCents, soulNumber,
        note: late ? 'Paid after its hold expired: check stock was not oversold.' : null,
      });
      return soulNumber;
    }),
    souls: () => q.souls.all(),
    stalePending: (before) => q.stalePending.all(before).map(parse),
    queued: (now) => q.queued.all(now).map(parse),
    sent: () => q.sent.all().map(parse),
    recent: (n = 200) => q.recent.all(n).map(parse),
    setFulfillment(order, patch) {
      q.setFulfillment.run({
        id: order.id, fulfillment: order.fulfillment, yoycolOrderId: null, tracking: null,
        attempts: order.attempts, nextAttemptAt: order.next_attempt_at, lastError: null, ...patch,
      });
    },
    signup: (email, chamberId, at) => q.signup.run(email, chamberId, at).changes > 0,
    kvGet: (k) => q.kvGet.get(k)?.v ?? null,
    kvSet: (k, v) => q.kvSet.run(k, v),
    /** True the first time a Stripe event id is seen. */
    firstTime: (eventId, at) => q.seenEvent.run(eventId, at).changes > 0,
    forgetEvent: (eventId) => q.forgetEvent.run(eventId),
    async backup(dir, keep = 14) {
      fs.mkdirSync(dir, { recursive: true });
      const name = `engine-${new Date().toISOString().slice(0, 10)}.db`;
      await sql.backup(path.join(dir, name));
      const old = fs.readdirSync(dir).filter((f) => /^engine-.*\.db$/.test(f)).sort().slice(0, -keep);
      old.forEach((f) => fs.rmSync(path.join(dir, f)));
      return name;
    },
  };
  return db;
}
