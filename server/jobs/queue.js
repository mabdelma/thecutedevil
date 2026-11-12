// Job queue as a database table (no Redis, no workers). Owner: core. Contract: section g.
// Every job has an idempotency key: enqueueing the same key twice is a silent no-op, whatever state the first is in.
import { toJson, fromJson } from '../db.js';
import { errorText } from '../lib/log.js';

export const JOB_TYPES = Object.freeze(['fulfilment.submit', 'fulfilment.poll', 'email.send', 'payment.refund', 'orders.expire', 'orders.anonymise', 'owner.alert']);
export const STALE_LOCK_MS = 5 * 60 * 1000;
export const BACKOFF_MS = Object.freeze([60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3]);

/** Delay before retry number `attempts` (1-based): 1, 5, 15, then 60 minutes. */
export const backoffMs = (attempts) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];

/** A handler throws this to be run again after `delayMs` without it counting as a crash. */
export class RetryLater extends Error {
  constructor(delayMs, message = 'retry later') { super(message); this.name = 'RetryLater'; this.delayMs = delayMs; }
}

const nowOf = (ctx) => (typeof ctx.now === 'function' ? ctx.now() : Date.now());

/**
 * @param {object} q     Knex instance or transaction (use the transaction so the job commits with the state change)
 * @param {{type: string, payload?: object, idemKey: string, runAfter?: number, maxAttempts?: number}} job
 * @param {number} at    current time (epoch ms)
 * @returns {Promise<number|null>} the job id (existing or new)
 */
export async function enqueue(q, job, at) {
  if (!JOB_TYPES.includes(job.type)) throw new Error(`unknown job type ${job.type}`);
  if (!job.idemKey || job.idemKey.length > 120) throw new Error('job needs an idemKey of at most 120 characters');
  await q('jobs').insert({
    type: job.type, payload: toJson(job.payload || {}), status: 'queued', attempts: 0, max_attempts: job.maxAttempts || 5,
    run_after: job.runAfter ?? at, idem_key: job.idemKey, created_at: at, updated_at: at,
  }).onConflict('idem_key').ignore();
  const row = await q('jobs').where({ idem_key: job.idemKey }).first('id');
  return row ? row.id : null;
}

/** Put back jobs whose runner died: `running` with a lock older than 5 minutes. Out of attempts → dead. */
export async function requeueStale(ctx) {
  const at = nowOf(ctx);
  const stale = await ctx.db('jobs').where({ status: 'running' }).where('locked_at', '<', at - STALE_LOCK_MS).select('id', 'attempts', 'max_attempts');
  let count = 0;
  for (const job of stale) {
    const dead = job.attempts >= job.max_attempts;
    count += await ctx.db('jobs').where({ id: job.id, status: 'running' }).update({
      status: dead ? 'dead' : 'queued', locked_at: null, last_error: 'stale lock: the runner stopped mid-job', updated_at: at,
    });
  }
  return count;
}

/**
 * Claim one due job. The conditional UPDATE is the lock: only one caller sees `1 row changed`.
 * @param {{only?: number[]}} [options]  restrict to these job ids (inline run after a webhook)
 * @returns {Promise<object|null>} the job with `payload` parsed
 */
export async function claim(ctx, options = {}) {
  const at = nowOf(ctx);
  for (let tries = 0; tries < 5; tries += 1) {
    const query = ctx.db('jobs').where({ status: 'queued' }).where('run_after', '<=', at).orderBy('run_after').orderBy('id').first();
    if (options.only) query.whereIn('id', options.only);
    if (options.skip && options.skip.length) query.whereNotIn('id', options.skip);
    const job = await query;
    if (!job) return null;
    const changed = await ctx.db('jobs').where({ id: job.id, status: 'queued' }).update({ status: 'running', locked_at: at, attempts: job.attempts + 1, updated_at: at });
    if (changed === 1) return { ...job, status: 'running', attempts: job.attempts + 1, locked_at: at, payload: fromJson(job.payload, {}) };
  }
  return null;
}

export async function complete(ctx, job) {
  const at = nowOf(ctx);
  return ctx.db('jobs').where({ id: job.id, status: 'running' }).update({ status: 'done', locked_at: null, last_error: null, updated_at: at });
}

/**
 * Record a failure. Re-queued with backoff until max_attempts, then `dead`.
 * @param {{delayMs?: number, dead?: boolean}} [options]  dead: true = never retry (an error a retry cannot fix)
 * @returns {Promise<'queued'|'dead'>}
 */
export async function fail(ctx, job, err, options = {}) {
  const at = nowOf(ctx);
  const dead = options.dead === true || job.attempts >= job.max_attempts;
  await ctx.db('jobs').where({ id: job.id, status: 'running' }).update({
    status: dead ? 'dead' : 'queued', locked_at: null, last_error: errorText(err),
    run_after: dead ? job.run_after : at + (options.delayMs ?? backoffMs(job.attempts)), updated_at: at,
  });
  return dead ? 'dead' : 'queued';
}

export async function countDue(ctx) {
  const row = await ctx.db('jobs').where({ status: 'queued' }).where('run_after', '<=', nowOf(ctx)).count({ n: '*' }).first();
  return Number(row?.n || 0);
}
