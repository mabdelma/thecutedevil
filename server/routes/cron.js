// POST /api/cron/tick: the host's cron drains the job queue. Owner: core. Contract: sections f and g.
// Hostinger cron: curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://thecutedevil.com/api/cron/tick
import express from 'express';
import { AppError } from '../lib/errors.js';
import { safeEqual } from '../lib/ids.js';
import { rateLimit } from '../lib/ratelimit.js';
import { CRON_BUDGET_MS, tick } from '../jobs/runner.js';

export default function cronRoutes(ctx) {
  const router = express.Router();
  let running = null; // overlapping cron calls share one run instead of piling up
  router.post('/tick', rateLimit(ctx.limiter, 'cron', 10, 60 * 1000), async (req, res) => {
    const secret = ctx.config.cronSecret;
    if (!secret || !ctx.db) throw new AppError('NOT_FOUND', 404, 'No such endpoint');
    const header = String(req.get('authorization') || '');
    const given = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : typeof req.query.secret === 'string' ? req.query.secret : '';
    if (!given || !safeEqual(given, secret)) throw new AppError('UNAUTHORIZED', 401, 'Unauthorized');
    if (!running) running = tick(ctx, { budgetMs: ctx.cronBudgetMs ?? CRON_BUDGET_MS }).finally(() => { running = null; });
    res.json(await running);
  });
  return router;
}
