// Read-only admin view behind HTTP Basic. Owner: core. Contract: section f.
// 404 when ADMIN_USER / ADMIN_PASS are unset. 30 requests a minute; 5 wrong logins block the IP for 15 minutes.
import express from 'express';
import { AppError } from '../lib/errors.js';
import { fromJson } from '../db.js';
import { safeEqual } from '../lib/ids.js';
import { clientIp, rateLimit } from '../lib/ratelimit.js';
import { ORDER_STATUSES } from '../orders/states.js';

const BLOCK_MS = 15 * 60 * 1000;
const camel = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase()), v]));
const HIDDEN = ['token_hash', 'checkout_id'];
const publicRow = (row, json = []) => {
  const out = camel(Object.fromEntries(Object.entries(row).filter(([k]) => !HIDDEN.includes(k))));
  for (const key of json) if (key in out) out[key] = fromJson(out[key], null);
  return out;
};

export default function adminRoutes(ctx) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!ctx.config.admin || !ctx.db) return next(new AppError('NOT_FOUND', 404, 'No such endpoint'));
    return next();
  });
  router.use(rateLimit(ctx.limiter, 'admin', 30, 60 * 1000));
  router.use((req, res, next) => {
    const ip = clientIp(req);
    if (ctx.limiter.blockedFor('admin-login', ip) > 0) return next(new AppError('RATE_LIMITED', 429, 'Too many failed logins. Try again later.'));
    const header = String(req.get('authorization') || '');
    let user = '';
    let pass = '';
    if (header.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const at = decoded.indexOf(':');
      if (at >= 0) { user = decoded.slice(0, at); pass = decoded.slice(at + 1); }
    }
    const userOk = safeEqual(user, ctx.config.admin.user);
    const passOk = safeEqual(pass, ctx.config.admin.pass);
    if (userOk && passOk) { ctx.limiter.clear('admin-fail', ip); return next(); }
    if (header) {
      const fails = ctx.limiter.hit('admin-fail', ip, 5, BLOCK_MS);
      if (fails.remaining === 0) { ctx.limiter.block('admin-login', ip, BLOCK_MS); ctx.log.warn('admin.blocked', { reason: 'failed_logins' }); }
    }
    res.set('WWW-Authenticate', 'Basic realm="The Cute Devil admin", charset="UTF-8"');
    return next(new AppError('UNAUTHORIZED', 401, 'Unauthorized'));
  });

  router.get('/orders', async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const query = ctx.db('orders').orderBy('id', 'desc').limit(limit);
    if (typeof req.query.status === 'string' && ORDER_STATUSES.includes(req.query.status)) query.where({ status: req.query.status });
    if (req.query.attention === '1') query.where({ needs_attention: true });
    const before = Number.parseInt(req.query.before, 10);
    if (Number.isInteger(before) && before > 0) query.where('id', '<', before);
    const rows = await query.select('id', 'public_id', 'status', 'payment_status', 'needs_attention', 'attention_reason', 'country', 'currency', 'total', 'payment_method', 'payment_provider', 'email', 'created_at', 'updated_at');
    res.json({ orders: rows.map((r) => ({ ...publicRow(r), needsAttention: Boolean(r.needs_attention) })), nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
  });

  router.get('/orders/:publicId', async (req, res) => {
    const order = await ctx.db('orders').where({ public_id: String(req.params.publicId) }).first();
    if (!order) throw new AppError('NOT_FOUND', 404, 'Order not found');
    const of = (table, order_by = 'id') => ctx.db(table).where({ order_id: order.id }).orderBy(order_by);
    const [items, payments, fulfilments, shipments, events, emails] = [await of('order_items'), await of('payments'), await of('fulfilments', 'seq'), await of('shipments'), await of('order_events'), await of('email_log')];
    res.json({
      order: publicRow(order, ['taxDetails']),
      items: items.map((r) => publicRow(r, ['options', 'personalisation'])),
      payments: payments.map((r) => { const p = publicRow(r); delete p.redirectUrl; return p; }),
      fulfilments: fulfilments.map((r) => publicRow(r, ['candidates'])),
      shipments: shipments.map((r) => publicRow(r)),
      events: events.map((r) => publicRow(r)),
      emails: emails.map((r) => publicRow(r, ['vars'])),
    });
  });

  router.get('/jobs', async (req, res) => {
    const status = ['queued', 'running', 'done', 'dead'].includes(req.query.status) ? req.query.status : 'dead';
    const rows = await ctx.db('jobs').where({ status }).orderBy('id', 'desc').limit(100);
    res.json({ jobs: rows.map((r) => publicRow(r, ['payload'])) });
  });

  return router;
}
