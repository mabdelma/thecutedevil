// The seam between webhook routes (pay, sup) and the orders service (core). Owner: core.
// Contract: web/COMMERCE_ARCH.md sections d and g.
//   const fresh = await recordWebhookOnce(ctx, { source, eventId, type, rawBody });
//   if (fresh) await handlePaymentEvent(ctx, providerId, event);      // or handleSupplierEvent
// A handler that throws marks the webhook_events row `failed`; the route answers 500, the sender retries, and
// recordWebhookOnce lets that repeat through. A row stuck in `received` (the process died mid-handler) is let
// through again after 5 minutes.
import { isUniqueViolation } from '../db.js';
import { sha256 } from '../lib/ids.js';
import { errorText } from '../lib/log.js';
import { queueEmail } from '../email/send.js';
import { addEvent, confirmOrder, nowOf, raiseAttention, recomputeOrderStatus, transitionFulfilment, transitionOrder } from './service.js';
import { canPaymentRowGo, fulfilmentPath } from './states.js';
import { runJobsInline } from '../jobs/runner.js';

const STALE_WEBHOOK_MS = 5 * 60 * 1000;
const INLINE_BUDGET_MS = 6 * 1000; // Stripe holds the customer's redirect for up to 10 s waiting for this webhook's answer

/**
 * Insert (source, eventId) into webhook_events. Resolves true when the caller must process the event:
 * the first time, after an earlier attempt failed, or after an earlier attempt died. False for a duplicate.
 * The body is never stored, only its SHA-256.
 * @param {object} ctx  { db, config, log }
 * @param {{source: string, eventId: string, type?: string, rawBody?: Buffer}} event
 * @returns {Promise<boolean>}
 */
export async function recordWebhookOnce(ctx, event) {
  const at = nowOf(ctx);
  const source = String(event.source || '').slice(0, 32);
  const eventId = String(event.eventId || '');
  if (!source || !eventId) throw new Error('recordWebhookOnce needs a source and an eventId');
  const id = eventId.length > 191 ? `sha256:${sha256(eventId)}` : eventId;
  const payload_hash = event.rawBody == null ? null : sha256(event.rawBody);
  try {
    await ctx.db('webhook_events').insert({ source, event_id: id, type: event.type ? String(event.type).slice(0, 80) : null, status: 'received', payload_hash, received_at: at });
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const retried = await ctx.db('webhook_events').where({ source, event_id: id })
    .where((q) => q.where({ status: 'failed' }).orWhere((s) => s.where({ status: 'received' }).where('received_at', '<', at - STALE_WEBHOOK_MS)))
    .update({ status: 'received', received_at: at, last_error: null });
  return retried === 1;
}

async function markWebhook(ctx, source, eventId, status, err = null) {
  if (!eventId) return;
  const id = String(eventId).length > 191 ? `sha256:${sha256(String(eventId))}` : String(eventId);
  await ctx.db('webhook_events').where({ source, event_id: id }).update({ status, last_error: err ? errorText(err) : null, processed_at: nowOf(ctx) });
}

async function guarded(ctx, source, event, work) {
  try {
    const status = await work();
    await markWebhook(ctx, source, event.eventId, status || 'processed');
  } catch (err) {
    ctx.log.error('webhook.failed', { source, type: event.type, error: errorText(err) });
    try { await markWebhook(ctx, source, event.eventId, 'failed', err); } catch (inner) { /* the original error matters more */ }
    throw err;
  }
}

async function findPayment(ctx, providerId, event) {
  if (event.providerRef) {
    const row = await ctx.db('payments').where({ provider: providerId, provider_ref: String(event.providerRef) }).first();
    if (row) return row;
  }
  if (event.providerPaymentRef) return ctx.db('payments').where({ provider: providerId, provider_payment_ref: String(event.providerPaymentRef) }).first();
  return null;
}

/**
 * A provider says the money arrived. Checks the amount and currency against OUR payment row before anything else.
 * Also used by the expiry job when the provider answers `succeeded` for an order whose webhook never came.
 * @returns {Promise<'processed'|'ignored'>}
 */
export async function applyPaymentSucceeded(ctx, payment, { amount, currency, providerPaymentRef, inline = true } = {}) {
  const order = await ctx.db('orders').where({ id: payment.order_id }).first();
  if (!Number.isInteger(amount) || amount !== payment.amount || String(currency || '').toUpperCase() !== payment.currency) {
    await ctx.db.transaction(async (trx) => {
      await trx('payments').where({ id: payment.id }).update({ raw_status: 'amount_mismatch', last_error: `expected ${payment.amount} ${payment.currency}, provider reported ${amount} ${String(currency || '').toUpperCase()}`.slice(0, 300), updated_at: nowOf(ctx) });
      await raiseAttention(trx, ctx, order, 'PAYMENT_AMOUNT_MISMATCH', `payment ${payment.id}: expected ${payment.amount} ${payment.currency}, provider reported ${amount} ${String(currency || '').toUpperCase()}`);
    });
    return 'processed'; // not confirmed; a person decides. Retrying the webhook would not change the amount.
  }
  const { outcome, jobIds } = await confirmOrder(ctx, { paymentId: payment.id, providerPaymentRef, rawStatus: 'succeeded' });
  if (outcome === 'confirmed' && inline && jobIds.length) {
    // the usual case finishes inside the webhook; anything left over is picked up by the next tick
    try { await runJobsInline(ctx, jobIds, INLINE_BUDGET_MS); } catch (err) { ctx.log.warn('inline.jobs', { error: errorText(err) }); }
  }
  return 'processed';
}

async function applyPaymentClosed(ctx, payment, to) {
  await ctx.db.transaction(async (trx) => {
    const current = await trx('payments').where({ id: payment.id }).first();
    if (!['created', 'pending'].includes(current.status) || !canPaymentRowGo(current.status, to)) return;
    await trx('payments').where({ id: payment.id, status: current.status }).update({ status: to, raw_status: to, updated_at: nowOf(ctx) });
    const order = await trx('orders').where({ id: payment.order_id }).first();
    await addEvent(trx, ctx, order.id, 'payment', { message: `payment ${to}` });
    if (to === 'expired' && order.status === 'pending_payment') {
      const live = await trx('payments').where({ order_id: order.id }).whereIn('status', ['created', 'pending']).first('id');
      if (!live) await transitionOrder(trx, ctx, order, 'expired', { message: 'payment session expired' });
    }
  });
}

/** Remember one refund by the provider's own id (a row in webhook_events, source `refund:<provider>`). → true the first time. */
async function noteRefund(trx, ctx, provider, refundRef) {
  const key = { source: `refund:${provider}`.slice(0, 32), event_id: String(refundRef).slice(0, 191) };
  if (await trx('webhook_events').where(key).first('id')) return false;
  const at = nowOf(ctx);
  await trx('webhook_events').insert({ ...key, type: 'refund', status: 'processed', received_at: at, processed_at: at });
  return true;
}

/**
 * A refund reached the customer. Idempotent: the refunded total only ever grows, and never past the payment amount.
 * `event.amount` is the amount of ONE refund ("Payments notes"). Three cases:
 *   - `totalRefunded` (Stripe): the provider's running total wins;
 *   - `refundRef` without a total (Paymob): separate refunds are added up, each one counted once by its id;
 *   - neither: the single amount is NOT added to what we hold (our own refund job and its webhook describe the same refund).
 * `event.ownRefundRef` is set by the `payment.refund` job, whose `amount` is already the new total: the id is
 * remembered so that the provider's webhook for that same refund is not added a second time.
 */
async function applyRefundSucceeded(ctx, payment, event) {
  await ctx.db.transaction(async (trx) => {
    const current = await trx('payments').where({ id: payment.id }).first();
    if (!['succeeded', 'partially_refunded', 'refunded'].includes(current.status)) return;
    const hasTotal = Number.isInteger(event.totalRefunded) && event.totalRefunded > 0;
    const hasAmount = Number.isInteger(event.amount) && event.amount > 0;
    if (event.ownRefundRef) await noteRefund(trx, ctx, current.provider, event.ownRefundRef);
    let reported;
    if (hasTotal) reported = event.totalRefunded;
    else if (event.refundRef && hasAmount) reported = (await noteRefund(trx, ctx, current.provider, event.refundRef)) ? current.refunded_amount + event.amount : current.refunded_amount;
    else reported = hasAmount ? event.amount : current.amount;
    const refunded = Math.min(current.amount, Math.max(current.refunded_amount, reported));
    if (refunded === current.refunded_amount && current.status !== 'succeeded') return; // a replay
    const full = refunded >= current.amount;
    const at = nowOf(ctx);
    await trx('payments').where({ id: current.id }).update({ refunded_amount: refunded, status: full ? 'refunded' : 'partially_refunded', updated_at: at });
    const order = await trx('orders').where({ id: current.order_id }).first();
    if (['paid', 'refund_pending', 'partially_refunded'].includes(order.payment_status)) {
      await trx('orders').where({ id: order.id }).update({ payment_status: full ? 'refunded' : 'partially_refunded', updated_at: at });
    }
    await addEvent(trx, ctx, order.id, 'payment', { message: `refunded ${refunded} of ${current.amount} ${current.currency}` });
    await queueEmail(trx, ctx, order.status === 'cancelled'
      ? { orderId: order.id, template: 'order_cancelled', lang: order.lang, to: order.email, idemKey: `order_cancelled:${order.id}`, vars: { amount: refunded } }
      : { orderId: order.id, template: 'refund_issued', lang: order.lang, to: order.email, idemKey: `refund_issued:${current.id}:${refunded}`, vars: { amount: refunded } });
  });
}
export { applyRefundSucceeded };

/**
 * Apply one PaymentEvent (see payments/interface.js) to payments + orders and enqueue follow-up jobs.
 * Idempotent: every branch is guarded by the current row status, so a replay changes nothing.
 */
export async function handlePaymentEvent(ctx, providerId, event) {
  const source = `pay:${providerId}`;
  return guarded(ctx, source, event, async () => {
    if (!event || event.type === 'ignored') return 'ignored';
    const payment = await findPayment(ctx, providerId, event);
    if (!payment) {
      ctx.log.warn('payment.event.unknown', { provider: providerId, type: event.type });
      return 'ignored'; // not one of ours (or lost): the expiry job double-checks open orders with the provider
    }
    if (event.type === 'payment.succeeded') return applyPaymentSucceeded(ctx, payment, event);
    if (event.type === 'payment.failed') { await applyPaymentClosed(ctx, payment, 'failed'); return 'processed'; }
    if (event.type === 'payment.expired') { await applyPaymentClosed(ctx, payment, 'expired'); return 'processed'; }
    if (event.type === 'refund.succeeded') { await applyRefundSucceeded(ctx, payment, event); return 'processed'; }
    if (event.type === 'refund.failed') {
      await ctx.db.transaction(async (trx) => {
        const order = await trx('orders').where({ id: payment.order_id }).first();
        await raiseAttention(trx, ctx, order, 'REFUND_FAILED', `the provider could not refund payment ${payment.id}`);
      });
      return 'processed';
    }
    return 'ignored';
  });
}

/**
 * Read the real state from the supplier and apply it: shipments, fulfilment status, order status, e-mails.
 * Used by supplier webhooks and by the `fulfilment.poll` job. Idempotent.
 * @returns {Promise<string|null>} the supplier status that was applied, or null when there was nothing to read
 */
export async function syncFulfilment(ctx, fulfilmentId) {
  const before = await ctx.db('fulfilments').where({ id: fulfilmentId }).first();
  if (!before || !['submitted', 'in_production', 'shipped'].includes(before.status)) return null;
  const adapter = ctx.suppliers.get(before.supplier);
  if (!adapter) return null;
  const state = await adapter.getOrder({ supplierOrderRef: before.supplier_order_ref, externalId: before.external_id }); // network: no transaction open
  if (!state) return null;
  await ctx.db.transaction(async (trx) => {
    const at = nowOf(ctx);
    let f = await trx('fulfilments').where({ id: fulfilmentId }).first();
    if (f.supplier !== before.supplier || f.external_id !== before.external_id) return; // rerouted meanwhile
    const order = await trx('orders').where({ id: f.order_id }).first();
    if (state.rawStatus && state.rawStatus !== f.raw_status) await trx('fulfilments').where({ id: f.id }).update({ raw_status: String(state.rawStatus).slice(0, 60), updated_at: at });

    for (const s of Array.isArray(state.shipments) ? state.shipments : []) {
      const ref = String(s.ref || s.trackingNumber || 'default').slice(0, 100);
      const fields = {
        status: s.deliveredAt ? 'delivered' : 'shipped', carrier: s.carrier ? String(s.carrier).slice(0, 80) : null,
        tracking_number: s.trackingNumber ? String(s.trackingNumber).slice(0, 100) : null,
        tracking_url: s.trackingUrl && /^https?:\/\//i.test(s.trackingUrl) ? String(s.trackingUrl).slice(0, 500) : null,
        shipped_at: s.shippedAt || at, delivered_at: s.deliveredAt || null, updated_at: at,
      };
      let row = await trx('shipments').where({ fulfilment_id: f.id, supplier_shipment_ref: ref }).first();
      if (row) {
        await trx('shipments').where({ id: row.id }).update({ ...fields, shipped_at: row.shipped_at || fields.shipped_at });
      } else {
        await trx('shipments').insert({ order_id: f.order_id, fulfilment_id: f.id, supplier_shipment_ref: ref, ...fields, created_at: at });
        row = await trx('shipments').where({ fulfilment_id: f.id, supplier_shipment_ref: ref }).first();
        await addEvent(trx, ctx, f.order_id, 'shipment', { message: `parcel ${f.seq} shipped` });
      }
      // one e-mail per shipment, whatever the number of webhooks and polls that report it
      await queueEmail(trx, ctx, { orderId: f.order_id, template: 'shipped', lang: order.lang, to: order.email, idemKey: `shipped:shipment:${row.id}`, vars: { shipmentId: row.id } });
    }

    if (['submitted', 'in_production', 'shipped', 'delivered'].includes(state.status)) {
      for (const step of fulfilmentPath(f.status, state.status)) f = await transitionFulfilment(trx, ctx, f, step, { message: `parcel ${f.seq}`, patch: step === 'delivered' ? { next_poll_at: null } : {} });
    } else if (state.status === 'cancelled' && ['submitted', 'in_production'].includes(f.status)) {
      // the supplier cancelled a paid parcel on its own: park it for a person instead of losing it
      f = await transitionFulfilment(trx, ctx, f, 'manual', { message: `parcel ${f.seq} was cancelled by the supplier`, patch: { last_error: 'cancelled by supplier', next_poll_at: null } });
      await raiseAttention(trx, ctx, order, 'SUPPLIER_CANCELLED', `parcel ${f.seq} (${before.supplier})`);
    } else if (state.status === 'failed' || state.status === 'on_hold') {
      await trx('fulfilments').where({ id: f.id }).update({ last_error: String(state.problem || state.status).slice(0, 300), updated_at: at });
      await raiseAttention(trx, ctx, order, state.status === 'failed' ? 'SUPPLIER_FAILED' : 'SUPPLIER_ON_HOLD', `parcel ${f.seq} (${before.supplier})${state.problem ? `: ${String(state.problem).slice(0, 200)}` : ''}`);
    }
    await recomputeOrderStatus(trx, ctx, f.order_id);
  });
  return state.status;
}

/** Apply one SupplierEvent: the event is only a signal; the real state comes from adapter.getOrder(). */
export async function handleSupplierEvent(ctx, supplierId, event) {
  const source = `sup:${supplierId}`;
  return guarded(ctx, source, event, async () => {
    if (!event || event.type !== 'order.updated') return 'ignored';
    let fulfilment = null;
    if (event.externalId) fulfilment = await ctx.db('fulfilments').where({ external_id: String(event.externalId) }).first();
    if (!fulfilment && event.supplierOrderRef) fulfilment = await ctx.db('fulfilments').where({ supplier: supplierId, supplier_order_ref: String(event.supplierOrderRef) }).first();
    if (!fulfilment || fulfilment.supplier !== supplierId) return 'ignored';
    await syncFulfilment(ctx, fulfilment.id);
    const jobs = await ctx.db('jobs').where({ status: 'queued', type: 'email.send' }).where('created_at', '>=', nowOf(ctx) - 60000).select('id');
    if (jobs.length) { try { await runJobsInline(ctx, jobs.map((j) => j.id), INLINE_BUDGET_MS); } catch (err) { ctx.log.warn('inline.jobs', { error: errorText(err) }); } }
    return 'processed';
  });
}
