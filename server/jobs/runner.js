// Job runner. Owner: core. Contract: web/COMMERCE_ARCH.md section g.
// No workers on the host: jobs run (1) inline right after a webhook, (2) on an in-process timer every 30 s,
// (3) when cron calls POST /api/cron/tick. All three go through tick(), and a job is only ever run by the
// caller whose conditional UPDATE claimed it.
import { ProviderError } from '../lib/errors.js';
import { errorText } from '../lib/log.js';
import { claim, complete, countDue, enqueue, fail, requeueStale, RetryLater } from './queue.js';
import { handlers } from './handlers.js';

export const TIMER_INTERVAL_MS = 30 * 1000;
export const TIMER_BUDGET_MS = 20 * 1000;
export const CRON_BUDGET_MS = 50 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const nowOf = (ctx) => (typeof ctx.now === 'function' ? ctx.now() : Date.now());

/** Recurring work, keyed per time window so that any number of ticks enqueue it once. */
async function housekeeping(ctx) {
  const at = nowOf(ctx);
  await requeueStale(ctx);
  await enqueue(ctx.db, { type: 'orders.expire', idemKey: `orders.expire:${Math.floor(at / (5 * 60 * 1000))}`, maxAttempts: 2 }, at);
  await enqueue(ctx.db, { type: 'orders.anonymise', idemKey: `orders.anonymise:${Math.floor(at / DAY)}`, maxAttempts: 2 }, at);
  const due = await ctx.db('fulfilments').whereIn('status', ['submitted', 'in_production', 'shipped']).whereNotNull('next_poll_at').where('next_poll_at', '<=', at).orderBy('next_poll_at').limit(50).select('id', 'next_poll_at');
  for (const f of due) await enqueue(ctx.db, { type: 'fulfilment.poll', payload: { fulfilmentId: f.id }, idemKey: `fulfilment.poll:${f.id}:${f.next_poll_at}`, maxAttempts: 2 }, at);
  // finished jobs are only history: keep a month
  await ctx.db('jobs').where({ status: 'done' }).where('updated_at', '<', at - 30 * DAY).del();
}

/** Run one claimed job to an outcome. → 'done' | 'queued' | 'dead' */
export async function runJob(ctx, job) {
  const handler = handlers[job.type];
  try {
    if (!handler) throw new ProviderError('UNKNOWN_JOB_TYPE', `no handler for ${job.type}`);
    await handler(ctx, job.payload || {}, job);
    await complete(ctx, job);
    return 'done';
  } catch (err) {
    const never = err instanceof ProviderError && err.retryable === false;
    const outcome = await fail(ctx, job, err, { delayMs: err instanceof RetryLater ? err.delayMs : undefined, dead: never });
    ctx.log[outcome === 'dead' ? 'error' : 'warn']('job.failed', { job: job.id, type: job.type, attempt: job.attempts, outcome, error: errorText(err) });
    if (outcome === 'dead' && job.type !== 'owner.alert' && job.type !== 'email.send') {
      const orderId = Number.isInteger(job.payload?.orderId) ? job.payload.orderId : null;
      await enqueue(ctx.db, { type: 'owner.alert', payload: { orderId, reason: 'JOB_DEAD', message: `job ${job.id} (${job.type}) gave up after ${job.attempts} attempt(s): ${errorText(err)}` }, idemKey: `owner.alert:job:${job.id}` }, nowOf(ctx));
    }
    return outcome;
  }
}

/**
 * Work through due jobs until none is left or the budget is spent.
 * @param {{budgetMs?: number, only?: number[], housekeeping?: boolean}} [options]
 * @returns {Promise<{ok: boolean, ran: number, failed: number, remaining: number, tookMs: number}>}
 */
export async function tick(ctx, options = {}) {
  const started = Date.now(); // the budget is real time, whatever the injected clock says
  const budgetMs = options.budgetMs ?? TIMER_BUDGET_MS;
  let ran = 0;
  let failed = 0;
  if (!ctx.db) return { ok: true, ran, failed, remaining: 0, tookMs: 0 };
  if (options.housekeeping !== false) await housekeeping(ctx);
  while (Date.now() - started < budgetMs) {
    const job = await claim(ctx, { only: options.only });
    if (!job) break;
    const outcome = await runJob(ctx, job);
    ran += 1;
    if (outcome !== 'done') failed += 1;
  }
  const remaining = options.only ? 0 : await countDue(ctx);
  return { ok: true, ran, failed, remaining, tookMs: Date.now() - started };
}

/** Run just these jobs now (after a webhook), so the usual order finishes inside the request. */
export const runJobsInline = (ctx, jobIds, budgetMs = 10 * 1000) => tick(ctx, { budgetMs, only: jobIds, housekeeping: false });

/** In-process drain: every 30 s, 20 s budget, never two at once, never keeps the process alive. → stop() */
export function startTimer(ctx, { intervalMs = TIMER_INTERVAL_MS, budgetMs = TIMER_BUDGET_MS } = {}) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(ctx, { budgetMs }); } catch (err) { ctx.log.error('tick.failed', { error: errorText(err) }); } finally { busy = false; }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
