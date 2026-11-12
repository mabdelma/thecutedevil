// One handler per job type. Owner: core. Contract: web/COMMERCE_ARCH.md section g.
// A handler may run twice (a retry, or a re-run after the process died mid-job), so each one starts by
// reading the current state and does nothing when its work is already done.
import { ProviderError } from '../lib/errors.js';
import { fromJson } from '../db.js';
import { errorText } from '../lib/log.js';
import { isDoubtfulText } from '../lib/validate.js';
import { mappingFor } from '../routing/engine.js';
import { deliverEmail, queueEmail } from '../email/send.js';
import { enqueue, RetryLater } from './queue.js';
import { addEvent, nowOf, raiseAttention, recomputeOrderStatus, supplierFulfilment, transitionFulfilment, transitionOrder } from '../orders/service.js';
import { applyPaymentSucceeded, applyRefundSucceeded, syncFulfilment } from '../orders/events.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const SUBMIT_RETRY_MS = Object.freeze([1 * MIN, 5 * MIN, 15 * MIN]); // then the 4th failure moves on
export const POLL_MS = Object.freeze({ withWebhooks: 6 * HOUR, withoutWebhooks: 1 * HOUR, shipped: 24 * HOUR });
export const OVERDUE_MS = 10 * DAY;
export const ANONYMISE_AFTER_MS = 30 * DAY;
const STOP_POLLING_AFTER_MS = 45 * DAY;

const isRetryable = (err) => (err instanceof ProviderError ? err.retryable === true : !(err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError || err instanceof ReferenceError));
const camel = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase()), v]));
const pollDelay = (adapter) => (adapter?.capabilities?.webhooks ? POLL_MS.withWebhooks : POLL_MS.withoutWebhooks);

/* ---- fulfilment.submit -------------------------------------------------------------------------- */

/** No supplier can take it: park for a person and alert the owner. The customer is NOT refunded automatically. */
async function parkManual(ctx, fulfilmentId, reason, message) {
  await ctx.db.transaction(async (trx) => {
    const f = await trx('fulfilments').where({ id: fulfilmentId }).first();
    if (!f || !['pending', 'submitting'].includes(f.status)) return;
    const order = await trx('orders').where({ id: f.order_id }).first();
    await transitionFulfilment(trx, ctx, f, 'manual', { message: `parcel ${f.seq} needs a person (${reason})`, patch: { supplier: 'manual', last_error: String(message || reason).slice(0, 300), next_poll_at: null } });
    await raiseAttention(trx, ctx, order, reason, `parcel ${f.seq}${message ? `: ${message}` : ''}`);
  });
}

async function markSubmitted(ctx, fulfilmentId, externalId, adapter, result) {
  await ctx.db.transaction(async (trx) => {
    const f = await trx('fulfilments').where({ id: fulfilmentId }).first();
    if (!f || f.status !== 'submitting' || f.external_id !== externalId) return;
    const at = nowOf(ctx);
    const to = result.status === 'in_production' ? 'in_production' : 'submitted';
    await transitionFulfilment(trx, ctx, f, to, {
      message: `parcel ${f.seq} sent to the supplier`,
      patch: {
        supplier_order_ref: result.supplierOrderRef ? String(result.supplierOrderRef).slice(0, 100) : f.supplier_order_ref,
        ...(result.cost && Number.isInteger(result.cost.amount) ? { cost_amount: result.cost.amount, cost_currency: result.cost.currency } : {}),
        raw_status: result.rawStatus ? String(result.rawStatus).slice(0, 60) : to, last_error: null, submitted_at: at, next_poll_at: at + pollDelay(adapter),
      },
    });
    await recomputeOrderStatus(trx, ctx, f.order_id);
  });
}

/** Move to the next candidate (new external id, attempts reset) or, when none is left, to `manual`. */
async function advanceCandidate(ctx, fulfilmentId, order, err) {
  const moved = await ctx.db.transaction(async (trx) => {
    const f = await trx('fulfilments').where({ id: fulfilmentId }).first();
    if (!f || !['pending', 'submitting'].includes(f.status)) return true;
    const candidates = fromJson(f.candidates, []);
    const cod = order.payment_method === 'cod';
    let index = f.candidate_index + 1;
    while (index < candidates.length) {
      const next = ctx.suppliers.get(candidates[index]);
      if (candidates[index] !== 'manual' && next && (!cod || next.capabilities.cod)) break;
      index += 1;
    }
    if (index >= candidates.length) return false;
    const at = nowOf(ctx);
    const patch = { supplier: candidates[index], candidate_index: index, external_id: `${order.public_id}-F${f.seq}-${index}`, submit_attempts: 0, supplier_order_ref: null, last_error: errorText(err), updated_at: at };
    if (f.status === 'submitting') await transitionFulfilment(trx, ctx, f, 'pending', { message: `parcel ${f.seq} moved to the next supplier`, patch });
    else await trx('fulfilments').where({ id: f.id, status: 'pending' }).update(patch);
    await enqueue(trx, { type: 'fulfilment.submit', payload: { fulfilmentId: f.id }, idemKey: `fulfilment.submit:${f.id}:${index}`, maxAttempts: 8 }, at);
    ctx.log.warn('fulfilment.reroute', { fulfilment: f.id, from: f.supplier, to: candidates[index] });
    return true;
  });
  if (!moved) await parkManual(ctx, fulfilmentId, 'NO_SUPPLIER_LEFT', errorText(err));
}

async function submitFulfilment(ctx, { fulfilmentId }) {
  let f = await ctx.db('fulfilments').where({ id: fulfilmentId }).first();
  if (!f || !['pending', 'submitting'].includes(f.status)) return; // done already, cancelled, or parked
  const order = await ctx.db('orders').where({ id: f.order_id }).first();
  if (!order || !['confirmed', 'processing', 'partially_shipped', 'shipped'].includes(order.status)) return;
  if (f.supplier === 'manual') return parkManual(ctx, f.id, 'MANUAL_FULFILMENT', 'the routing table names "manual" (or nobody else could take it)');
  const items = await ctx.db('order_items').where({ fulfilment_id: f.id }).orderBy('id');
  const texts = items.flatMap((i) => Object.values(fromJson(i.personalisation, null) || {}));
  if (texts.some(isDoubtfulText)) return parkManual(ctx, f.id, 'PERSONALISATION_REVIEW', 'a personalisation text needs a look before production');

  const adapter = ctx.suppliers.get(f.supplier);
  if (!adapter) return advanceCandidate(ctx, f.id, order, new ProviderError('SUPPLIER_NOT_LOADED', `supplier ${f.supplier} is not configured`));
  if (f.status === 'pending') {
    f = await ctx.db.transaction(async (trx) => {
      const current = await trx('fulfilments').where({ id: f.id }).first();
      return current.status === 'pending' ? transitionFulfilment(trx, ctx, current, 'submitting', { message: `parcel ${current.seq} is being sent to the supplier` }) : current;
    });
    if (f.status !== 'submitting') return;
  }
  // From here a crash leaves the row in `submitting`: the re-run calls createOrder again with the SAME
  // external id, and the adapter answers with the order that already exists (contract section d).
  const payload = supplierFulfilment(order, f, items, (i) => mappingFor(ctx, f.supplier, i.product_id, i.variant_key, { region: order.region }));
  let result;
  try {
    result = await adapter.createOrder(payload);
    if (!result || !['submitted', 'in_production'].includes(result.status)) throw new ProviderError('SUPPLIER_BAD_ANSWER', 'createOrder returned no usable status');
  } catch (err) {
    const attempts = f.submit_attempts + 1;
    ctx.log.warn('fulfilment.submit.failed', { fulfilment: f.id, supplier: f.supplier, attempt: attempts, error: errorText(err) });
    if (isRetryable(err) && attempts <= SUBMIT_RETRY_MS.length) {
      await ctx.db.transaction(async (trx) => {
        const current = await trx('fulfilments').where({ id: f.id }).first();
        if (current.status === 'submitting') await transitionFulfilment(trx, ctx, current, 'pending', { message: `parcel ${f.seq}: supplier did not answer, will retry`, patch: { submit_attempts: attempts, last_error: errorText(err) } });
      });
      throw new RetryLater(SUBMIT_RETRY_MS[attempts - 1], errorText(err));
    }
    // Final failure on this supplier. Did the order get through after all? Then adopt it instead of ordering twice.
    let existing = null;
    try { existing = await adapter.getOrder({ supplierOrderRef: null, externalId: f.external_id }); } catch (inner) { existing = null; }
    if (existing && !['failed', 'cancelled'].includes(existing.status)) {
      await markSubmitted(ctx, f.id, f.external_id, adapter, { status: existing.status === 'submitted' ? 'submitted' : 'in_production', supplierOrderRef: existing.supplierOrderRef || null, rawStatus: existing.rawStatus });
      await syncFulfilment(ctx, f.id).catch(() => null);
      return undefined;
    }
    return advanceCandidate(ctx, f.id, order, err);
  }
  await markSubmitted(ctx, f.id, f.external_id, adapter, result);
  return undefined;
}

/* ---- fulfilment.poll ----------------------------------------------------------------------------- */

async function pollFulfilment(ctx, { fulfilmentId }) {
  const f = await ctx.db('fulfilments').where({ id: fulfilmentId }).first();
  if (!f || !['submitted', 'in_production', 'shipped'].includes(f.status)) return;
  const adapter = ctx.suppliers.get(f.supplier);
  try { await syncFulfilment(ctx, f.id); } catch (err) { ctx.log.warn('fulfilment.poll.failed', { fulfilment: f.id, supplier: f.supplier, error: errorText(err) }); }
  const at = nowOf(ctx);
  await ctx.db.transaction(async (trx) => {
    const after = await trx('fulfilments').where({ id: f.id }).first();
    if (!['submitted', 'in_production', 'shipped'].includes(after.status)) return;
    const age = at - Number(after.submitted_at || after.created_at);
    const next = after.status === 'shipped' ? (age > STOP_POLLING_AFTER_MS ? null : at + POLL_MS.shipped) : at + pollDelay(adapter);
    await trx('fulfilments').where({ id: f.id }).update({ next_poll_at: next, updated_at: at });
    if (after.status !== 'shipped' && age >= OVERDUE_MS) {
      const order = await trx('orders').where({ id: after.order_id }).first();
      await raiseAttention(trx, ctx, order, 'FULFILMENT_OVERDUE', `parcel ${after.seq} (${after.supplier}) has been open for ${Math.floor(age / DAY)} days`);
    }
  });
}

/* ---- payment.refund ------------------------------------------------------------------------------ */

async function refundPayment(ctx, { paymentId, amount, reason }) {
  const payment = await ctx.db('payments').where({ id: paymentId }).first();
  if (!payment || !['succeeded', 'partially_refunded'].includes(payment.status)) return;
  if (!Number.isInteger(amount) || amount <= 0 || amount > payment.amount - payment.refunded_amount) return;
  const order = await ctx.db('orders').where({ id: payment.order_id }).first();
  const attention = (message) => ctx.db.transaction((trx) => raiseAttention(trx, ctx, order, 'REFUND_FAILED', message));
  const provider = ctx.payments.get(payment.provider);
  if (!provider) return attention(`payment provider ${payment.provider} is not configured: refund ${amount} ${payment.currency} by hand`);
  let result;
  try {
    result = await provider.refund({ payment: camel(payment), amount, reason: reason || 'requested', idempotencyKey: `refund:${payment.id}:${amount}` });
  } catch (err) {
    if (isRetryable(err)) throw err; // the queue retries with backoff; the provider's idempotency key makes that safe
    await ctx.db('payments').where({ id: payment.id }).update({ last_error: errorText(err), updated_at: nowOf(ctx) });
    return attention(`refund of ${amount} ${payment.currency} was refused (${err.code || 'error'}): refund it in the provider dashboard`);
  }
  if (result && result.status === 'succeeded') return applyRefundSucceeded(ctx, payment, { amount: payment.refunded_amount + amount, ownRefundRef: result.refundRef || null });
  await ctx.db.transaction((trx) => addEvent(trx, ctx, order.id, 'payment', { message: 'refund requested, waiting for the provider' }));
  return undefined;
}

/* ---- orders.expire / orders.anonymise ----------------------------------------------------------------- */

async function expireOrders(ctx) {
  const at = nowOf(ctx);
  const due = await ctx.db('orders').where({ status: 'pending_payment' }).where('expires_at', '<=', at).orderBy('expires_at').limit(50);
  for (const order of due) {
    const payment = await ctx.db('payments').where({ order_id: order.id }).orderBy('id', 'desc').first();
    const provider = payment ? ctx.payments.get(payment.provider) : null;
    if (payment && payment.provider_ref && provider && ['created', 'pending'].includes(payment.status)) {
      let remote;
      try { remote = await provider.getPayment(payment.provider_ref); }
      catch (err) {
        ctx.log.warn('orders.expire.check_failed', { order: order.public_id, error: errorText(err) });
        if (isRetryable(err) && at - Number(order.expires_at) < DAY) continue; // unknown: do not expire yet, ask again next round
        remote = null;
      }
      if (remote && remote.status === 'succeeded') { // the webhook never came: confirm now
        await applyPaymentSucceeded(ctx, payment, { amount: remote.amount, currency: remote.currency, providerPaymentRef: remote.providerPaymentRef, inline: false });
        continue;
      }
    }
    await ctx.db.transaction(async (trx) => {
      const current = await trx('orders').where({ id: order.id }).first();
      if (current.status !== 'pending_payment') return;
      await transitionOrder(trx, ctx, current, 'expired', { message: 'not paid in time' });
      await trx('payments').where({ order_id: order.id }).whereIn('status', ['created', 'pending']).update({ status: 'expired', updated_at: nowOf(ctx) });
    });
  }
}

async function anonymiseOrders(ctx) {
  const at = nowOf(ctx);
  const old = await ctx.db('orders').where({ status: 'expired' }).whereNull('anonymised_at').where('updated_at', '<', at - ANONYMISE_AFTER_MS).limit(200).select('id');
  for (const { id } of old) {
    await ctx.db.transaction(async (trx) => {
      const changed = await trx('orders').where({ id, status: 'expired' }).whereNull('anonymised_at').update({
        email: '', phone: null, ship_name: '', ship_line1: '', ship_line2: null, ship_city: '', ship_state: null, ship_postcode: null, note: null, anonymised_at: at,
      });
      if (changed !== 1) return;
      await trx('order_items').where({ order_id: id }).update({ personalisation: null });
      await trx('email_log').where({ order_id: id }).update({ to_email: '' });
    });
  }
  if (old.length) ctx.log.info('orders.anonymised', { count: old.length });
}

/* ---- owner.alert --------------------------------------------------------------------------------- */

async function ownerAlert(ctx, payload, job) {
  const to = ctx.config.ownerAlertEmail;
  ctx.log.warn('owner.alert', { orderId: payload.orderId || null, reason: payload.reason });
  if (!to) return; // nowhere to send: the log line above and orders.needs_attention are the record
  await queueEmail(ctx.db, ctx, {
    orderId: payload.orderId || null, template: 'owner_alert', lang: 'en', to, idemKey: `owner_alert:${job.idem_key}`.slice(0, 120),
    vars: { alert: { reason: payload.reason, message: payload.message || '' } },
  });
}

export const handlers = Object.freeze({
  'fulfilment.submit': submitFulfilment,
  'fulfilment.poll': pollFulfilment,
  'email.send': (ctx, payload) => deliverEmail(ctx, payload.emailLogId),
  'payment.refund': refundPayment,
  'orders.expire': expireOrders,
  'orders.anonymise': anonymiseOrders,
  'owner.alert': ownerAlert,
});
