// Entry point: read settings, open the database, start the server and its timers.
import path from 'node:path';
import Stripe from 'stripe';
import { loadEnv, createConfigLoader } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';

const env = loadEnv();
const getConfig = createConfigLoader(env.configDir);
getConfig(); // fail loudly at boot if config/ is broken
const db = openDb(path.join(env.dataDir, 'engine.db'));
const stripe = env.stripeKey ? new Stripe(env.stripeKey, { maxNetworkRetries: 2, appInfo: { name: 'reckoning-engine' } }) : null;

const warn = (m) => console.warn(`[setup] ${m}`);
if (!stripe) warn('STRIPE_SECRET_KEY is empty: the site runs, checkout is off.');
else if (!env.stripeWebhookSecret) warn('STRIPE_WEBHOOK_SECRET is empty: payments will not turn into orders until it is set.');
if (stripe && env.stripeKey.startsWith('sk_live_') && env.previewPassword) warn('Live Stripe key with the preview password still on.');
if (!env.appSecret) warn('APP_SECRET is empty: the sigil hunt is disabled.');
if (!env.adminPassword) warn('ADMIN_PASSWORD is empty: /admin is disabled.');
if (!env.eventsWebhook) warn('N8N_EVENTS_WEBHOOK is empty: no alerts or posts will be sent.');

const { app, commerce, fulfillment, watchChambers, syncStock } = await buildApp({ env, db, stripe, getConfig, logger: { level: 'warn' } });

const every = (ms, name, fn) => {
  const run = async () => { try { await fn(); } catch (err) { console.error(`[${name}] ${err.stack || err}`); } };
  setInterval(run, ms).unref();
  setTimeout(run, 2000).unref();
};
every(60_000, 'sweep', () => commerce.sweep());
every(60_000, 'fulfillment', () => fulfillment.tick());
every(60 * 60_000, 'tracking', () => fulfillment.pollTracking());
every(30_000, 'chambers', () => { syncStock(); watchChambers(); });
every(24 * 60 * 60_000, 'backup', async () => console.log(`[backup] wrote ${await db.backup(path.join(env.dataDir, 'backups'))}`));

await app.listen({ port: env.port, host: env.host });
console.log(`The Reckoning Engine is listening on :${env.port} (${stripe ? (env.stripeKey.startsWith('sk_live_') ? 'LIVE payments' : 'test payments') : 'checkout off'}, fulfillment: ${env.fulfillmentMode})`);

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await app.close(); db.sql.close(); process.exit(0); });
