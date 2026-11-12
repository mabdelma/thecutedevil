// Express app factory. Owner: core. Contract: web/COMMERCE_ARCH.md sections f and j.
// Serves /api and the built static site (dist/). With no env configured, commerce is off:
// GET /api/config says so and the front end keeps its WhatsApp checkout.
import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './lib/errors.js';
import { createLimiter } from './lib/ratelimit.js';
import { createLogger, errorText } from './lib/log.js';
import { createCatalogue } from './catalogue/index.js';
import publicRoutes, { publicConfig } from './routes/public.js';
import cronRoutes from './routes/cron.js';
import adminRoutes from './routes/admin.js';

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
/** The commerce pages carry one small inline boot script (theme and language before first paint). It is allowed by
    its SHA-256, read from the built file, so the policy stays "self only" and the browser console stays clean. */
function cspFor(file) {
  let hashes = [];
  try {
    const html = readFileSync(file, 'utf8');
    hashes = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi), (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  } catch (err) { hashes = []; }
  return hashes.length ? `${CSP}; script-src 'self' ${Array.from(new Set(hashes)).join(' ')}` : CSP;
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export { publicConfig };

/**
 * @param {{config: object, db: object|null, payments: object, suppliers: object, log?: object, distDir?: string}} ctx
 */
export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Hostinger terminates TLS in front of the Node process
  app.locals.ctx = ctx;

  // createApp(ctx) also works with a bare { config, db, payments, suppliers } (tests of other roles)
  ctx.log = ctx.log && typeof ctx.log.info === 'function' && typeof ctx.log.warn === 'function' && typeof ctx.log.error === 'function' ? ctx.log : createLogger(ctx.log || console);
  ctx.limiter ||= createLimiter();
  ctx.catalogue ||= createCatalogue();
  ctx.outbox ||= [];
  if (typeof ctx.now !== 'function') ctx.now = Date.now;
  const routers = ctx.routers || {};

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  /* ---- /api ------------------------------------------------------------------------------
     Mount order matters. The webhook routers (pay: routes/webhooks-payment.js, sup: routes/webhooks-supplier.js)
     need the RAW body to check signatures, so they come BEFORE express.json(). They are loaded by index.js
     (ctx.routers); a router that is missing leaves its path answering 404 and turns commerce off.
     Webhooks are not rate-limited (the signature is the gate) but are capped at 1 MB. */
  const api = express.Router();
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  const raw = express.raw({ type: () => true, limit: '1mb' });
  if (routers.supplierWebhooks) api.use('/webhooks/supplier', raw, routers.supplierWebhooks(ctx));
  if (routers.paymentWebhooks) api.use('/webhooks', raw, routers.paymentWebhooks(ctx));
  api.use(express.json({ limit: '100kb' }));
  if (routers.mockPay && ctx.config.mode === 'mock') api.use('/mock/pay', routers.mockPay(ctx));
  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use('/cron', cronRoutes(ctx));
  api.use('/admin', adminRoutes(ctx));
  api.use(publicRoutes(ctx));
  api.use((req, res, next) => next(new AppError('NOT_FOUND', 404, 'No such endpoint')));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    const known = err instanceof AppError;
    const status = known ? err.status : err.type === 'entity.parse.failed' ? 400 : err.type === 'entity.too.large' ? 413 : 500;
    const code = known ? err.code : status === 500 ? 'INTERNAL' : 'VALIDATION';
    // one line, codes only: never the body, never an address
    if (status >= 500) ctx.log.error('api.error', { method: req.method, path: req.baseUrl + (req.route?.path || ''), code, error: errorText(err) });
    const body = { error: { code, message: status >= 500 && !known ? 'Something went wrong' : err.message, ...(known && err.fields ? { fields: err.fields } : {}) } };
    if (known && err.code === 'PRICE_CHANGED' && err.details?.quote) body.quote = err.details.quote; // section f: the body carries a fresh quote
    res.status(status).json(body);
  });
  app.use('/api', api);

  /* ---- static site -------------------------------------------------------------------------
     dist/ is the Vite build. `extensions: ['html']` gives clean URLs (/shop → shop.html).
     Hashed files under /assets are immutable; HTML is always revalidated. */
  const dist = ctx.distDir || join(ROOT, 'dist');
  if (existsSync(dist)) {
    const cspByFile = new Map(); // built file → its policy (computed once per process)
    app.use(express.static(dist, {
      extensions: ['html'],
      setHeaders(res, file) {
        res.set('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
        if (/[\\/](checkout|order)\.html$/.test(file)) { // the commerce pages: only our own origin, and no referrer (the order link carries a token)
          res.set('Content-Security-Policy', cspByFile.get(file) || cspByFile.set(file, cspFor(file)).get(file));
          res.set('Referrer-Policy', 'no-referrer');
        }
      },
    }));
    // 404.html is built with relative asset URLs (Vite base './'), so <base href="/"> keeps it working on nested paths.
    const notFound = join(dist, '404.html');
    const notFoundHtml = existsSync(notFound) ? readFileSync(notFound, 'utf8').replace(/<head>/i, '<head><base href="/">') : '';
    app.use((req, res) => {
      if (notFoundHtml) res.status(404).type('html').send(notFoundHtml);
      else res.status(404).type('text').send('Not found');
    });
  } else {
    app.use((req, res) => res.status(404).type('text').send('Not found (run `npm run build` to create dist/)'));
  }
  return app;
}
