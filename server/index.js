// Entry point: `npm start` → node server/index.js. Owner: core.
// One long-lived process (Hostinger "Node.js web app"): Express serves dist/ and /api, and an in-process timer
// drains the job queue between cron calls.
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { createApp } from './app.js';
import { createLogger, errorText } from './lib/log.js';
import { createLimiter } from './lib/ratelimit.js';
import { createCatalogue, validateCatalogue } from './catalogue/index.js';
import { rulesOf } from './routing/engine.js';
import { startTimer } from './jobs/runner.js';

const emptyRegistry = () => ({ get: () => null, has: () => false, list: () => [], forDestination: () => [] });

/** Load a module owned by another role. A missing or broken one is logged and leaves that part switched off. */
async function optional(path, log, what) {
  try { return await import(path); } catch (err) { log.error(`boot.${what}_unavailable`, { error: errorText(err) }); return null; }
}

/**
 * Build ctx: config → database (migrated) → registries → catalogue check. Used by start() and by the scripts.
 * Tests may inject { payments, suppliers, mapping, rules, now, routers }.
 * @returns {Promise<object>} ctx = { config, db, log, payments, suppliers, catalogue, limiter, outbox, now, … }
 */
export async function createContext(options = {}) {
  const log = createLogger(options.log || console);
  const config = loadConfig(options.env || process.env);
  for (const problem of config.problems || []) log.error('boot.config', { problem });
  const db = createDb(config.databaseUrl);
  if (db) await migrate(db); // Hostinger has no deploy hook: the schema is brought up to date on every boot
  const ctx = {
    config, db, log, distDir: options.distDir, now: options.now || Date.now, outbox: [], limiter: createLimiter(),
    catalogue: options.catalogue || createCatalogue(), mapping: options.mapping, rules: options.rules,
    shippingRates: options.shippingRates, taxRules: options.taxRules, emailStrings: options.emailStrings, mailer: options.mailer,
  };
  ctx.suppliers = options.suppliers || (await optional('./suppliers/registry.js', log, 'suppliers'))?.loadSuppliers(config, { log }) || emptyRegistry();
  ctx.payments = options.payments || (await optional('./payments/registry.js', log, 'payments'))?.loadPayments(config, { log, suppliers: ctx.suppliers }) || emptyRegistry(); // `cod` needs to know which suppliers collect cash

  if (config.mode !== 'off') {
    const mapping = ctx.mapping || (await optional('./catalogue/mapping.js', log, 'mapping'))?.mapping || {};
    ctx.catalogueCheck = options.catalogue ? { ok: true, errors: [], warnings: [] }
      : validateCatalogue({ mapping, rules: rulesOf(ctx), mockSuppliers: config.mode === 'mock' || Boolean(options.suppliers) });
    for (const warning of ctx.catalogueCheck.warnings) log.warn('boot.catalogue', { warning });
    for (const error of ctx.catalogueCheck.errors.slice(0, 20)) log.error('boot.catalogue', { error });
    if (!ctx.catalogueCheck.ok) log.error('boot.commerce_off', { reason: 'catalogue_invalid', errors: ctx.catalogueCheck.errors.length });
  }
  return ctx;
}

/** The routers owned by `pay` and `sup`. A missing one is reported in ctx.routersMissing (commerce then stays off). */
async function loadRouters(ctx, given) {
  if (given) { ctx.routers = given; ctx.routersMissing = []; return; }
  ctx.routers = {};
  ctx.routersMissing = [];
  if (ctx.config.mode === 'off') return;
  const wanted = [['paymentWebhooks', './routes/webhooks-payment.js', true], ['supplierWebhooks', './routes/webhooks-supplier.js', true], ['mockPay', './routes/mock-pay.js', ctx.config.mode === 'mock']];
  for (const [name, path, needed] of wanted) {
    if (!needed) continue;
    const mod = await optional(path, ctx.log, name);
    if (mod && typeof mod.default === 'function') ctx.routers[name] = mod.default; else ctx.routersMissing.push(name);
  }
}

/**
 * Build everything and listen. Tests call this with their own env and port 0.
 * @param {{env?: object, port?: number, host?: string, distDir?: string, log?: object, timer?: boolean,
 *          payments?: object, suppliers?: object, mapping?: object, rules?: object, routers?: object, now?: Function}} [options]
 * @returns {Promise<{app, server, ctx, url: string, close: () => Promise<void>}>}
 */
export async function start(options = {}) {
  const ctx = await createContext(options);
  await loadRouters(ctx, options.routers);
  const { config, db } = ctx;
  const app = createApp(ctx);
  const port = options.port ?? config.port;
  const host = options.host || config.host;
  const server = await new Promise((ok, fail) => {
    const s = app.listen(port, host, () => ok(s));
    s.once('error', fail);
  });
  const stopTimer = db && options.timer !== false ? startTimer(ctx) : () => {};
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    stopTimer();
    server.closeIdleConnections?.();
    await new Promise((ok) => server.close(ok));
    if (db) await db.destroy();
  };
  return { app, server, ctx, url, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const running = await start();
  const { config, payments, suppliers } = running.ctx;
  console.log(`[tcd] listening on ${running.server.address().port} · commerce ${config.mode} · payments [${payments.list().map((p) => p.id).join(', ')}] · suppliers [${suppliers.list().map((s) => s.id).join(', ')}]`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => running.close().finally(() => process.exit(0)));
}
