// Job queue and runner tests. Owner: core. Contract: section g (claim once, backoff, stale lock, idempotency key).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb, migrate } from '../db.js';
import { ProviderError } from '../lib/errors.js';
import { createLogger } from '../lib/log.js';
import { backoffMs, claim, complete, countDue, enqueue, fail, requeueStale, RetryLater, STALE_LOCK_MS } from '../jobs/queue.js';
import { runJob, startTimer, tick } from '../jobs/runner.js';
import { queueEmail, deliverEmail } from '../email/send.js';

const quiet = createLogger({ log() {}, info() {}, warn() {}, error() {} });
async function setup() {
  const db = createDb('sqlite::memory:');
  await migrate(db);
  let clock = 1_800_000_000_000;
  const ctx = { db, log: quiet, config: { mode: 'mock', ownerAlertEmail: 'owner@shop.test', smtp: null, publicBaseUrl: 'http://shop.test' }, outbox: [], now: () => clock };
  return { db, ctx, advance: (ms) => { clock += ms; }, now: () => clock, close: () => db.destroy() };
}
const job = (db, key) => db('jobs').where({ idem_key: key }).first();

test('enqueue: the idempotency key makes a duplicate a silent no-op, whatever state the first is in', async () => {
  const s = await setup();
  try {
    const id = await enqueue(s.db, { type: 'owner.alert', payload: { reason: 'A' }, idemKey: 'k1' }, s.now());
    assert.equal(await enqueue(s.db, { type: 'owner.alert', payload: { reason: 'B' }, idemKey: 'k1' }, s.now()), id);
    assert.equal((await s.db('jobs').count({ n: '*' }).first()).n, 1);
    assert.equal(JSON.parse((await job(s.db, 'k1')).payload).reason, 'A'); // the first one stays
    const claimed = await claim(s.ctx);
    await complete(s.ctx, claimed);
    await enqueue(s.db, { type: 'owner.alert', idemKey: 'k1' }, s.now()); // done jobs are not resurrected
    assert.equal((await job(s.db, 'k1')).status, 'done');
    assert.equal(await claim(s.ctx), null);
    await assert.rejects(enqueue(s.db, { type: 'nope', idemKey: 'k2' }, s.now()), /unknown job type/);
    await assert.rejects(enqueue(s.db, { type: 'owner.alert' }, s.now()), /idemKey/);
    // inside a transaction that rolls back, the job disappears with it
    await assert.rejects(s.db.transaction(async (trx) => { await enqueue(trx, { type: 'owner.alert', idemKey: 'k3' }, s.now()); throw new Error('rollback'); }), /rollback/);
    assert.equal(await job(s.db, 'k3'), undefined);
  } finally { await s.close(); }
});

test('claim: a job is claimed once, in run_after order, and only when due', async () => {
  const s = await setup();
  try {
    await enqueue(s.db, { type: 'owner.alert', idemKey: 'later', runAfter: s.now() + 60000 }, s.now());
    await enqueue(s.db, { type: 'owner.alert', idemKey: 'second', runAfter: s.now() - 10 }, s.now());
    await enqueue(s.db, { type: 'owner.alert', idemKey: 'first', runAfter: s.now() - 20 }, s.now());
    assert.equal(await countDue(s.ctx), 2);
    const [a, b, c] = await Promise.all([claim(s.ctx), claim(s.ctx), claim(s.ctx)]);
    assert.deepEqual([a, b, c].filter(Boolean).map((j) => j.idem_key).sort(), ['first', 'second']);
    assert.equal([a, b, c].filter(Boolean).length, 2); // never the same job twice, never the one that is not due
    assert.equal((await job(s.db, 'first')).status, 'running');
    assert.equal((await job(s.db, 'first')).attempts, 1);
    assert.equal(await claim(s.ctx), null);
    s.advance(60000);
    assert.equal((await claim(s.ctx)).idem_key, 'later');
    // the conditional UPDATE is the lock: a row somebody else already took is not handed out
    await enqueue(s.db, { type: 'owner.alert', idemKey: 'raced' }, s.now());
    const original = s.ctx.db;
    let stolen = false;
    s.ctx.db = new Proxy(original, { apply(target, thisArg, args) {
      const q = target(...args);
      if (args[0] === 'jobs' && !stolen) { const first = q.first.bind(q); q.first = async (...a) => { const row = await first(...a); if (row) { stolen = true; await target('jobs').where({ id: row.id }).update({ status: 'running' }); } return row; }; }
      return q;
    } });
    assert.equal(await claim(s.ctx), null);
    s.ctx.db = original;
  } finally { await s.close(); }
});

test('fail: backoff 1, 5, 15, 60 minutes, then dead at max_attempts; a custom delay; dead at once', async () => {
  const s = await setup();
  try {
    assert.deepEqual([1, 2, 3, 4, 5, 99].map(backoffMs), [60000, 300000, 900000, 3600000, 3600000, 3600000]);
    await enqueue(s.db, { type: 'owner.alert', idemKey: 'k', maxAttempts: 3 }, s.now());
    let j = await claim(s.ctx);
    assert.equal(await fail(s.ctx, j, new Error('net down for a@b.test')), 'queued');
    let row = await job(s.db, 'k');
    assert.deepEqual([row.status, Number(row.run_after) - s.now(), row.locked_at], ['queued', 60000, null]);
    assert.ok(!row.last_error.includes('a@b.test')); // errors are scrubbed before they are stored
    assert.equal(await claim(s.ctx), null); // not due yet
    s.advance(60000);
    j = await claim(s.ctx);
    assert.equal(j.attempts, 2);
    await fail(s.ctx, j, new Error('again'));
    assert.equal(Number((await job(s.db, 'k')).run_after) - s.now(), 300000);
    s.advance(300000);
    j = await claim(s.ctx);
    assert.equal(await fail(s.ctx, j, new Error('third')), 'dead');
    assert.equal((await job(s.db, 'k')).status, 'dead');
    s.advance(10 * 3600000);
    assert.equal(await claim(s.ctx), null); // dead stays dead
    await enqueue(s.db, { type: 'owner.alert', idemKey: 'custom' }, s.now());
    j = await claim(s.ctx);
    await fail(s.ctx, j, new Error('x'), { delayMs: 1234 });
    assert.equal(Number((await job(s.db, 'custom')).run_after) - s.now(), 1234);
    s.advance(1234);
    j = await claim(s.ctx);
    assert.equal(await fail(s.ctx, j, new Error('x'), { dead: true }), 'dead');
  } finally { await s.close(); }
});

test('stale lock: a job whose runner died is re-queued after 5 minutes and runs again (crash-safe)', async () => {
  const s = await setup();
  try {
    await enqueue(s.db, { type: 'owner.alert', payload: { reason: 'CRASH_TEST' }, idemKey: 'crash', maxAttempts: 2 }, s.now());
    const j = await claim(s.ctx); // …and the process dies here
    assert.equal(j.status, 'running');
    s.advance(STALE_LOCK_MS - 1000);
    assert.equal(await requeueStale(s.ctx), 0); // maybe it is just slow
    s.advance(2000);
    assert.equal(await requeueStale(s.ctx), 1);
    assert.equal((await job(s.db, 'crash')).status, 'queued');
    const result = await tick(s.ctx, { budgetMs: 5000 });
    assert.ok(result.ran >= 1 && result.failed === 0);
    assert.equal((await job(s.db, 'crash')).status, 'done');
    assert.equal((await job(s.db, 'crash')).attempts, 2);
    assert.equal(s.ctx.outbox.filter((m) => m.template === 'owner_alert').length, 1); // the work happened once
    // a job that already used all its attempts and died mid-run goes to dead, not round again
    await enqueue(s.db, { type: 'owner.alert', idemKey: 'crash2', maxAttempts: 1 }, s.now());
    await claim(s.ctx);
    s.advance(STALE_LOCK_MS + 1);
    await requeueStale(s.ctx);
    assert.equal((await job(s.db, 'crash2')).status, 'dead');
  } finally { await s.close(); }
});

test('runner: done / retry with backoff / RetryLater delay / non-retryable → dead + one owner alert', async () => {
  const s = await setup();
  try {
    // email.send for a row that does not exist completes quietly
    await enqueue(s.db, { type: 'email.send', payload: { emailLogId: 999 }, idemKey: 'e1' }, s.now());
    assert.equal(await runJob(s.ctx, await claim(s.ctx)), 'done');
    // a handler that throws a plain error is retried with backoff
    await enqueue(s.db, { type: 'payment.refund', payload: { paymentId: 1, amount: 1 }, idemKey: 'r1' }, s.now());
    const original = s.ctx.db;
    let boom = new Error('database hiccup');
    s.ctx.db = new Proxy(original, { apply(target, thisArg, args) { if (args[0] === 'payments' && boom) throw boom; return target(...args); }, get: (target, prop) => target[prop] });
    assert.equal(await runJob(s.ctx, await claim(s.ctx)), 'queued');
    assert.equal(Number((await job(original, 'r1')).run_after) - s.now(), 60000);
    s.advance(60000);
    boom = new RetryLater(7777, 'not yet');
    assert.equal(await runJob(s.ctx, await claim(s.ctx)), 'queued');
    assert.equal(Number((await job(original, 'r1')).run_after) - s.now(), 7777);
    s.advance(7777);
    boom = new ProviderError('CARD_GONE', 'cannot ever work', { retryable: false });
    assert.equal(await runJob(s.ctx, await claim(s.ctx)), 'dead');
    s.ctx.db = original;
    const alerts = await s.db('jobs').where({ type: 'owner.alert' });
    assert.equal(alerts.length, 1);
    assert.ok(JSON.parse(alerts[0].payload).message.includes('payment.refund'));
  } finally { await s.close(); }
});

test('tick: housekeeping is enqueued once per window however often it is called; the budget stops the loop', async () => {
  const s = await setup();
  try {
    const first = await tick(s.ctx, { budgetMs: 5000 });
    assert.equal(first.ok, true);
    assert.deepEqual([first.failed, first.remaining], [0, 0]);
    const before = (await s.db('jobs').count({ n: '*' }).first()).n;
    for (let i = 0; i < 5; i += 1) await tick(s.ctx, { budgetMs: 5000 });
    assert.equal((await s.db('jobs').count({ n: '*' }).first()).n, before); // repeated ticks add nothing
    assert.equal((await s.db('jobs').where({ type: 'orders.expire' }).count({ n: '*' }).first()).n, 1);
    s.advance(5 * 60 * 1000);
    await tick(s.ctx, { budgetMs: 5000 });
    assert.equal((await s.db('jobs').where({ type: 'orders.expire' }).count({ n: '*' }).first()).n, 2); // next 5-minute window
    for (let i = 0; i < 4; i += 1) await enqueue(s.db, { type: 'owner.alert', payload: { reason: `R${i}` }, idemKey: `b${i}` }, s.now());
    const none = await tick(s.ctx, { budgetMs: 0, housekeeping: false });
    assert.deepEqual([none.ran, none.remaining], [0, 4]); // no budget: nothing claimed, everything still queued
    const only = await tick(s.ctx, { budgetMs: 5000, only: [(await job(s.db, 'b2')).id], housekeeping: false });
    assert.equal(only.ran, 1);
    assert.equal((await job(s.db, 'b2')).status, 'done');
    assert.equal((await job(s.db, 'b1')).status, 'queued');
    const stop = startTimer(s.ctx, { intervalMs: 3600000 });
    stop();
  } finally { await s.close(); }
});

test('e-mail log: one row and one message per idempotency key; no SMTP in live mode = skipped; SMTP errors retry', async () => {
  const s = await setup();
  try {
    await queueEmail(s.db, s.ctx, { template: 'owner_alert', to: 'owner@shop.test', idemKey: 'm1', vars: { alert: { reason: 'X' } } });
    await queueEmail(s.db, s.ctx, { template: 'owner_alert', to: 'owner@shop.test', idemKey: 'm1', vars: { alert: { reason: 'Y' } } });
    assert.equal((await s.db('email_log').count({ n: '*' }).first()).n, 1);
    assert.equal((await s.db('jobs').where({ type: 'email.send' }).count({ n: '*' }).first()).n, 1);
    await tick(s.ctx, { budgetMs: 5000, housekeeping: false });
    assert.equal(s.ctx.outbox.length, 1);
    assert.ok(s.ctx.outbox[0].subject.includes('X'));
    const row = await s.db('email_log').first();
    assert.deepEqual([row.status, row.message_id], ['sent', `mock-${row.id}`]);
    assert.equal(await deliverEmail(s.ctx, row.id), 'sent'); // a re-run job does not send again
    assert.equal(s.ctx.outbox.length, 1);
    // live mode without SMTP: logged as skipped, nothing sent, the job is done (not retried for ever)
    const live = { ...s.ctx, config: { ...s.ctx.config, mode: 'live' }, outbox: [] };
    await queueEmail(s.db, live, { template: 'owner_alert', to: 'owner@shop.test', idemKey: 'm2', vars: { alert: { reason: 'Z' } } });
    await tick(live, { budgetMs: 5000, housekeeping: false });
    assert.equal((await s.db('email_log').where({ idem_key: 'm2' }).first()).status, 'skipped');
    assert.equal(live.outbox.length, 0);
    // live mode with a transport: sent through it; a transport error marks the row failed and the job retries
    const sent = [];
    const smtp = { ...live, config: { ...live.config, smtp: { from: 'shop@shop.test' } }, mailer: { sendMail: async (m) => { if (sent.length === 0) { sent.push('fail'); throw new Error('421 try later'); } sent.push(m); return { messageId: '<id-1>' }; } } };
    await queueEmail(s.db, smtp, { template: 'owner_alert', to: 'owner@shop.test', idemKey: 'm3', vars: { alert: { reason: 'W' } } });
    const failed = await tick(smtp, { budgetMs: 5000, housekeeping: false });
    assert.equal(failed.failed, 1);
    assert.equal((await s.db('email_log').where({ idem_key: 'm3' }).first()).status, 'failed');
    s.advance(60000);
    await tick(smtp, { budgetMs: 5000, housekeeping: false });
    const done = await s.db('email_log').where({ idem_key: 'm3' }).first();
    assert.deepEqual([done.status, done.message_id], ['sent', '<id-1>']);
    assert.deepEqual([sent[1].from, sent[1].to], ['shop@shop.test', 'owner@shop.test']);
  } finally { await s.close(); }
});
