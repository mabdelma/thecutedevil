// Orders service. Owner: core. Contract: web/COMMERCE_ARCH.md sections b and g.
// The ONLY module that writes orders.status and fulfilments.status. Every change runs inside a transaction,
// is checked against the transition tables (orders/states.js), is guarded by `WHERE status = <from>` so two
// writers cannot both win, and leaves an order_events row.
// Rule for SQLite (one connection): inside a transaction use only `trx`, and never call a supplier or a
// payment provider while a transaction is open.
import { AppError } from '../lib/errors.js';
import { fromJson, insertedId, isUniqueViolation, toJson } from '../db.js';
import { checkoutKey, orderLinkToken, publicId as newPublicId, safeEqual, sha256 } from '../lib/ids.js';
import { enqueue } from '../jobs/queue.js';
import { queueEmail } from '../email/send.js';
import { route } from '../routing/engine.js';
import { assertFulfilmentTransition, assertOrderTransition, canPaymentStatusGo, deriveOrderStatus, orderPath } from './states.js';

export const ORDER_TTL_MS = 60 * 60 * 1000; // an unpaid order expires after 60 minutes
export const nowOf = (ctx) => (typeof ctx.now === 'function' ? ctx.now() : Date.now());

const camel = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase()), v]));

/* ---- events, transitions, attention ------------------------------------------------------------- */

export async function addEvent(trx, ctx, orderId, type, { from = null, to = null, message = null } = {}) {
  await trx('order_events').insert({ order_id: orderId, type, from_status: from, to_status: to, message: message ? String(message).slice(0, 500) : null, created_at: nowOf(ctx) });
}

/** Move an order to `to`. Throws ILLEGAL_TRANSITION, or CONFLICT when someone else moved it first. */
export async function transitionOrder(trx, ctx, order, to, { message = null, patch = {} } = {}) {
  assertOrderTransition(order.status, to);
  const at = nowOf(ctx);
  const changed = await trx('orders').where({ id: order.id, status: order.status }).update({ ...patch, status: to, updated_at: at });
  if (changed !== 1) throw new AppError('CONFLICT', 409, `order ${order.public_id} changed while it was being updated`);
  await addEvent(trx, ctx, order.id, 'status_changed', { from: order.status, to, message });
  ctx.log.info('order.status', { order: order.public_id, from: order.status, to });
  return { ...order, ...patch, status: to, updated_at: at };
}

/** Move a fulfilment to `to` (with optional column changes). Same guarantees as transitionOrder. */
export async function transitionFulfilment(trx, ctx, fulfilment, to, { message = null, patch = {} } = {}) {
  assertFulfilmentTransition(fulfilment.status, to);
  const at = nowOf(ctx);
  const changed = await trx('fulfilments').where({ id: fulfilment.id, status: fulfilment.status }).update({ ...patch, status: to, updated_at: at });
  if (changed !== 1) throw new AppError('CONFLICT', 409, `fulfilment ${fulfilment.id} changed while it was being updated`);
  await addEvent(trx, ctx, fulfilment.order_id, 'fulfilment', { from: fulfilment.status, to, message: message || `parcel ${fulfilment.seq}` });
  ctx.log.info('fulfilment.status', { fulfilment: fulfilment.id, from: fulfilment.status, to });
  return { ...fulfilment, ...patch, status: to, updated_at: at };
}

/** Park an order for a human: flag it, record why, and queue ONE owner alert per (order, reason). */
export async function raiseAttention(trx, ctx, order, reason, message = '') {
  const at = nowOf(ctx);
  await trx('orders').where({ id: order.id }).update({ needs_attention: true, attention_reason: String(reason).slice(0, 191), updated_at: at });
  await addEvent(trx, ctx, order.id, 'alert', { message: `${reason}${message ? `: ${message}` : ''}` });
  await enqueue(trx, { type: 'owner.alert', payload: { orderId: order.id, reason, message: String(message || '').slice(0, 300) }, idemKey: `owner.alert:${order.id}:${reason}`.slice(0, 120) }, at);
  ctx.log.warn('order.attention', { order: order.public_id, reason });
}

/* ---- creating an order ---------------------------------------------------------------------------- */

/**
 * Insert the order, its items and the first payment row in one transaction. Idempotent on checkoutId:
 * a second call with the same id returns the first order ({ created: false }).
 * Nothing here comes from the browser except what validate.js cleaned; amounts come from the server quote.
 * @returns {Promise<{order: object, payment: object, created: boolean}>}
 */
export async function createOrder(ctx, { input, quote, internal, method, provider, token }) {
  const key = checkoutKey(input.checkoutId);
  const existing = await findByCheckout(ctx, input.checkoutId);
  if (existing) return { ...existing, created: false };
  const taxByKey = new Map(internal.tax.lines.map((l) => [l.key, l.amount]));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const at = nowOf(ctx);
    const public_id = newPublicId(at);
    try {
      return await ctx.db.transaction(async (trx) => {
        const orderId = insertedId(await trx('orders').insert({
          public_id, checkout_id: key, token_hash: sha256(token), status: 'pending_payment', payment_status: 'unpaid',
          country: input.country, region: input.region, currency: input.currency, lang: input.lang,
          email: input.customer.email, phone: input.customer.phone, ship_name: input.customer.name,
          ship_line1: input.address.line1, ship_line2: input.address.line2, ship_city: input.address.city,
          ship_state: input.address.state, ship_postcode: input.address.postcode, note: input.note,
          payment_method: method, payment_provider: provider, shipping_option: internal.shippingOption || 'standard',
          subtotal: quote.subtotal, shipping_total: quote.shipping, discount_total: 0, tax_total: quote.tax.amount,
          tax_included: quote.tax.included, tax_rate_bp: quote.tax.rateBp,
          tax_details: toJson({ labelKey: quote.tax.labelKey, shipping: internal.tax.shippingAmount, lines: internal.tax.lines, notices: internal.tax.notices }),
          total: quote.total, terms_accepted_at: at, expires_at: at + ORDER_TTL_MS, created_at: at, updated_at: at,
        }));
        await trx('order_items').insert(internal.lines.map((l) => ({
          order_id: orderId, product_id: l.productId, variant_key: l.variantKey, name: String(l.name).slice(0, 160), category: l.category,
          qty: l.qty, unit_price: l.unit, line_total: l.total, tax_amount: taxByKey.get(l.key) || 0, weight_g: l.weightG || 0,
          options: toJson(l.options || {}), personalisation: toJson(l.personalisation),
        })));
        const paymentId = insertedId(await trx('payments').insert({
          order_id: orderId, provider, method, status: 'created', amount: quote.total, currency: input.currency,
          idem_key: `checkout:${orderId}:1`, created_at: at, updated_at: at,
        }));
        await addEvent(trx, ctx, orderId, 'status_changed', { to: 'pending_payment' });
        ctx.log.info('order.created', { order: public_id, country: input.country, currency: input.currency, total: quote.total, method });
        return { order: await trx('orders').where({ id: orderId }).first(), payment: await trx('payments').where({ id: paymentId }).first(), created: true };
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await findByCheckout(ctx, input.checkoutId); // a double-submitted checkout: the other request won
      if (raced) return { ...raced, created: false };
      // otherwise the random public id collided: try another one
    }
  }
  throw new AppError('INTERNAL', 500, 'could not allocate an order id');
}

/** The order (and its latest payment row) created by this checkout UUID, or null. */
export async function findByCheckout(ctx, checkoutId) {
  const order = await ctx.db('orders').where({ checkout_id: checkoutKey(checkoutId) }).first();
  if (!order) return null;
  const payment = await ctx.db('payments').where({ order_id: order.id }).orderBy('id', 'desc').first();
  return { order, payment };
}

/** A further payment attempt on the same unpaid order (the earlier one failed or expired at the provider). */
export async function newPaymentAttempt(ctx, order) {
  return ctx.db.transaction(async (trx) => {
    const rows = await trx('payments').where({ order_id: order.id }).select('id');
    const at = nowOf(ctx);
    const id = insertedId(await trx('payments').insert({
      order_id: order.id, provider: order.payment_provider, method: order.payment_method, status: 'created', amount: order.total,
      currency: order.currency, idem_key: `checkout:${order.id}:${rows.length + 1}`, created_at: at, updated_at: at,
    }));
    return trx('payments').where({ id }).first();
  });
}

export const statusUrl = (ctx, order, token) => `${ctx.config.publicBaseUrl}/order?id=${encodeURIComponent(order.public_id)}&token=${encodeURIComponent(token)}`;

/** The status-page link for a customer e-mail, or '' when ORDER_LINK_SECRET is not set (then the e-mail has no link). */
export const emailStatusUrl = (ctx, order) => (ctx.config.orderLinkSecret && order && order.token_hash
  ? statusUrl(ctx, order, orderLinkToken(ctx.config.orderLinkSecret, order.public_id, order.token_hash)) : '');

/** What a payment provider receives (contract section d): camelCase rows, server-computed items, absolute URLs. */
export async function checkoutRequest(ctx, order, payment, token) {
  const items = await ctx.db('order_items').where({ order_id: order.id }).orderBy('id');
  const url = statusUrl(ctx, order, token);
  return {
    order: camel(order),
    items: items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unit_price, lineTotal: i.line_total })),
    shipping: { amount: order.shipping_total, labelKey: 'checkout.shipping' },
    payment: camel(payment),
    urls: { success: `${url}&paid=1`, cancel: `${ctx.config.publicBaseUrl}/checkout?cancelled=${encodeURIComponent(order.public_id)}` },
  };
}

/* ---- confirmation: payment → fulfilments -------------------------------------------------------- */

const routingLine = (item) => ({
  key: String(item.id), orderItemId: item.id, productId: item.product_id, variantKey: item.variant_key, category: item.category,
  qty: item.qty, personalisation: fromJson(item.personalisation, null),
});
export const destinationOf = (order) => ({ country: order.country, region: order.region, state: order.ship_state || '', postcode: order.ship_postcode || '', city: order.ship_city || '' });
const wholeOrNull = (n) => (Number.isFinite(n) ? Math.round(n) : null);

async function insertFulfilments(trx, ctx, order, routing) {
  const at = nowOf(ctx);
  const jobIds = [];
  let seq = 0;
  for (const f of routing.fulfilments) {
    seq += 1;
    const id = insertedId(await trx('fulfilments').insert({
      order_id: order.id, seq, supplier: f.supplier, candidates: toJson(f.candidates), candidate_index: 0, status: 'pending',
      external_id: `${order.public_id}-F${seq}-0`, shipping_method: f.quote?.shippingMethod ? String(f.quote.shippingMethod).slice(0, 40) : null,
      cost_amount: wholeOrNull(f.quote?.total), cost_currency: f.quote?.currency || null,
      eta_min_days: wholeOrNull(f.quote?.minDays), eta_max_days: wholeOrNull(f.quote?.maxDays), created_at: at, updated_at: at,
    }));
    await trx('order_items').where({ order_id: order.id }).whereIn('id', f.lineKeys.map(Number)).update({ fulfilment_id: id });
    await addEvent(trx, ctx, order.id, 'fulfilment', { to: 'pending', message: `parcel ${seq}` });
    jobIds.push(await enqueue(trx, { type: 'fulfilment.submit', payload: { fulfilmentId: id }, idemKey: `fulfilment.submit:${id}:0`, maxAttempts: 8 }, at));
  }
  return jobIds;
}

/**
 * A payment succeeded (or a COD order was accepted): mark the payment, confirm the order, create the fulfilments
 * and queue the supplier orders and the confirmation e-mail, all in ONE transaction. Safe to call twice: the
 * conditional payment update lets only the first caller through.
 * @returns {Promise<{outcome: 'confirmed'|'noop'|'attention', jobIds: number[]}>}
 */
export async function confirmOrder(ctx, { paymentId, providerPaymentRef = null, rawStatus = null }) {
  const payment0 = await ctx.db('payments').where({ id: paymentId }).first();
  if (!payment0) return { outcome: 'noop', jobIds: [] };
  const order0 = await ctx.db('orders').where({ id: payment0.order_id }).first();
  const cod = order0.payment_method === 'cod';
  let routing = null;
  if (['pending_payment', 'expired'].includes(order0.status)) {
    const items = await ctx.db('order_items').where({ order_id: order0.id }).orderBy('id');
    routing = await route(items.map(routingLine), destinationOf(order0), ctx, { postPayment: true, cod }); // network: before the transaction
  }
  return ctx.db.transaction(async (trx) => {
    const at = nowOf(ctx);
    const claimed = await trx('payments').where({ id: paymentId }).whereIn('status', cod ? ['created'] : ['created', 'pending', 'failed', 'expired']).update({
      status: cod ? 'cod_due' : 'succeeded', ...(providerPaymentRef ? { provider_payment_ref: String(providerPaymentRef).slice(0, 191) } : {}),
      raw_status: rawStatus ? String(rawStatus).slice(0, 60) : payment0.raw_status, last_error: null, updated_at: at,
    });
    if (claimed !== 1) return { outcome: 'noop', jobIds: [] }; // a duplicate event: someone already did this
    const order = await trx('orders').where({ id: payment0.order_id }).first();
    await addEvent(trx, ctx, order.id, 'payment', { message: cod ? 'cash on delivery accepted' : `payment succeeded (${payment0.provider})` });
    if (!['pending_payment', 'expired'].includes(order.status) || !routing) {
      // money arrived for an order that is cancelled or already paid by another attempt: a person must refund it
      if (!cod && order.payment_status === 'unpaid') await trx('orders').where({ id: order.id }).update({ payment_status: 'paid', updated_at: at });
      await raiseAttention(trx, ctx, order, order.status === 'cancelled' ? 'PAID_AFTER_CANCEL' : 'DUPLICATE_PAYMENT', `payment ${paymentId} succeeded while the order was ${order.status}`);
      return { outcome: 'attention', jobIds: [] };
    }
    const confirmed = await transitionOrder(trx, ctx, order, 'confirmed', {
      message: order.status === 'expired' ? 'late payment re-opened the order' : null,
      patch: { payment_status: cod ? 'cod_due' : 'paid', confirmed_at: at, expires_at: null },
    });
    const jobIds = await insertFulfilments(trx, ctx, confirmed, routing);
    jobIds.push(await queueEmail(trx, ctx, { orderId: order.id, template: 'order_confirmed', lang: order.lang, to: order.email, idemKey: `order_confirmed:${order.id}` }));
    return { outcome: 'confirmed', jobIds: jobIds.filter(Boolean) };
  });
}

/** What a supplier adapter receives for createOrder (contract section d). Mapping is resolved by the caller. */
export function supplierFulfilment(order, fulfilment, items, mappingOf) {
  const cod = order.payment_method === 'cod'
    ? { amount: items.reduce((n, i) => n + i.line_total, 0) + (fulfilment.seq === 1 ? order.shipping_total : 0) + (order.tax_included ? 0 : items.reduce((n, i) => n + i.tax_amount, 0)), currency: order.currency }
    : null;
  return {
    id: fulfilment.id, externalId: fulfilment.external_id, orderPublicId: order.public_id,
    lines: items.map((i) => ({ ...routingLine(i), mapping: mappingOf(i) })),
    shippingMethod: fulfilment.shipping_method || 'standard', currency: order.currency, lang: order.lang,
    recipient: {
      name: order.ship_name, line1: order.ship_line1, line2: order.ship_line2 || '', city: order.ship_city, state: order.ship_state || '',
      postcode: order.ship_postcode || '', country: order.country, phone: order.phone || '', email: order.email,
    },
    cod,
  };
}

/* ---- derived order status ----------------------------------------------------------------------- */

/**
 * Bring orders.status in line with the fulfilments (processing / partially_shipped / shipped / delivered) and
 * mark a COD order collected once everything is delivered. Call inside the transaction that changed a fulfilment.
 */
export async function recomputeOrderStatus(trx, ctx, orderId) {
  let order = await trx('orders').where({ id: orderId }).first();
  if (!order) return null;
  const fulfilments = await trx('fulfilments').where({ order_id: orderId }).select('status');
  const target = deriveOrderStatus(fulfilments.map((f) => f.status));
  if (target) for (const step of orderPath(order.status, target)) order = await transitionOrder(trx, ctx, order, step);
  if (target === 'delivered' && order.status === 'delivered' && order.payment_status === 'cod_due' && canPaymentStatusGo('cod_due', 'cod_collected')) {
    const at = nowOf(ctx);
    await trx('orders').where({ id: order.id, payment_status: 'cod_due' }).update({ payment_status: 'cod_collected', updated_at: at });
    await trx('payments').where({ order_id: order.id, status: 'cod_due' }).update({ status: 'cod_collected', updated_at: at });
    await addEvent(trx, ctx, order.id, 'payment', { message: 'cash collected on delivery' });
    order = { ...order, payment_status: 'cod_collected' };
  }
  return order;
}

/* ---- the customer's order page ------------------------------------------------------------------ */

const itemKey = (item) => {
  const p = fromJson(item.personalisation, null);
  return [item.product_id, ...(item.variant_key === 'default' ? [] : [item.variant_key]), ...(p ? Object.entries(p).map(([k, v]) => `@${k}=${v}`) : [])].join('|');
};

/**
 * The order as the customer may see it. → view | null. A wrong id and a wrong token are the same null.
 * Never returns e-mail, phone or street address.
 */
export async function getOrderView(ctx, publicId, token) {
  if (typeof publicId !== 'string' || typeof token !== 'string' || !/^TCD-\d{6}-[A-Z0-9]{4}$/.test(publicId) || token.length < 32 || token.length > 128) return null;
  const order = await ctx.db('orders').where({ public_id: publicId }).first();
  const supplied = sha256(token);
  if (!order) { safeEqual(supplied, supplied); return null; }
  // two keys open the page: the checkout token (shown once to the browser) and the token of the e-mail link
  const viaCheckout = safeEqual(supplied, order.token_hash);
  const viaEmail = Boolean(ctx.config.orderLinkSecret) && safeEqual(token, orderLinkToken(ctx.config.orderLinkSecret, order.public_id, order.token_hash));
  if (!viaCheckout && !viaEmail) return null;
  const [items, fulfilments, shipments, events] = await Promise.all([
    ctx.db('order_items').where({ order_id: order.id }).orderBy('id'),
    ctx.db('fulfilments').where({ order_id: order.id }).orderBy('seq'),
    ctx.db('shipments').where({ order_id: order.id }).orderBy('id'),
    ctx.db('order_events').where({ order_id: order.id }).whereIn('type', ['status_changed', 'fulfilment']).orderBy('created_at').orderBy('id'),
  ]);
  return {
    id: order.public_id, status: order.status, paymentStatus: order.payment_status, paymentMethod: order.payment_method,
    createdAt: Number(order.created_at), currency: order.currency, lang: order.lang,
    items: items.map((i) => ({ id: i.product_id, name: i.name, options: fromJson(i.options, {}), personalisation: fromJson(i.personalisation, null), qty: i.qty, unit: i.unit_price, total: i.line_total })),
    subtotal: order.subtotal, shipping: order.shipping_total,
    tax: { included: Boolean(order.tax_included), amount: order.tax_total, rateBp: order.tax_rate_bp },
    total: order.total,
    shipTo: { city: order.ship_city, country: order.country },
    fulfilments: fulfilments.map((f, index) => ({
      index, status: f.status === 'submitting' ? 'pending' : f.status === 'manual' ? 'pending' : f.status,
      itemKeys: items.filter((i) => i.fulfilment_id === f.id).map(itemKey),
      etaMinDays: f.eta_min_days, etaMaxDays: f.eta_max_days,
      shipments: shipments.filter((s) => s.fulfilment_id === f.id).map((s) => ({
        carrier: s.carrier, trackingNumber: s.tracking_number, trackingUrl: s.tracking_url,
        shippedAt: s.shipped_at == null ? null : Number(s.shipped_at), deliveredAt: s.delivered_at == null ? null : Number(s.delivered_at),
      })),
    })),
    timeline: events.filter((e) => e.type === 'status_changed' || ['shipped', 'delivered'].includes(e.to_status))
      .map((e) => ({ type: e.type === 'status_changed' ? 'order' : 'fulfilment', status: e.to_status, at: Number(e.created_at) })),
  };
}

/* ---- cancel and refund (scripts/cancel-order.js) -------------------------------------------------- */

/**
 * Cancel an order before production and queue the refund. Section g.4.
 * Fulfilments in `pending` / `manual` are cancelled directly, `submitted` ones through the supplier. If any is
 * being submitted, in production or later, or a supplier cannot or will not cancel: CANNOT_CANCEL.
 * @returns {Promise<{ok: true, order: string, refund: 'queued'|'none', amount: number}>}
 */
export async function cancelOrder(ctx, publicId, { reason = 'requested' } = {}) {
  const order = await ctx.db('orders').where({ public_id: publicId }).first();
  if (!order) throw new AppError('NOT_FOUND', 404, `no order ${publicId}`);
  const refuse = (why) => new AppError('CANNOT_CANCEL', 409, why);
  if (order.status === 'cancelled') throw refuse('the order is already cancelled');
  if (!['pending_payment', 'confirmed', 'processing'].includes(order.status)) throw refuse(`the order is ${order.status}`);

  const fulfilments = (await ctx.db('fulfilments').where({ order_id: order.id }).orderBy('seq')).filter((f) => f.status !== 'cancelled');
  const late = fulfilments.find((f) => !['pending', 'manual', 'submitted'].includes(f.status));
  if (late) throw refuse(`parcel ${late.seq} is ${late.status}${late.status === 'submitting' ? ' (being sent to the supplier right now: try again in a few minutes)' : ''}`);
  const atSupplier = fulfilments.filter((f) => f.status === 'submitted');
  for (const f of atSupplier) {
    const adapter = ctx.suppliers.get(f.supplier);
    if (!adapter || !adapter.capabilities.cancel) throw refuse(`supplier ${f.supplier} cannot cancel parcel ${f.seq} through the API: cancel it in the supplier dashboard, then run scripts/fulfilment-set.js`);
  }
  // Ask the suppliers first (network, no transaction open). Nothing is changed here unless every one agrees…
  const cancelledAtSupplier = [];
  let refusal = null;
  for (const f of atSupplier) {
    let answer;
    try { answer = await ctx.suppliers.get(f.supplier).cancel({ supplierOrderRef: f.supplier_order_ref, externalId: f.external_id }); }
    catch (err) { answer = { cancelled: false, reason: err.code || 'supplier error' }; }
    if (answer && answer.cancelled) cancelledAtSupplier.push(f); else { refusal = { f, reason: answer?.reason || 'refused' }; break; }
  }

  return ctx.db.transaction(async (trx) => {
    const at = nowOf(ctx);
    if (refusal) {
      // …but a supplier-side cancellation cannot be undone, so what was cancelled there is recorded truthfully.
      for (const f of cancelledAtSupplier) await transitionFulfilment(trx, ctx, f, 'cancelled', { message: `parcel ${f.seq} cancelled at the supplier` });
      if (cancelledAtSupplier.length) await raiseAttention(trx, ctx, order, 'CANCEL_PARTIAL', `parcel ${refusal.f.seq} could not be cancelled (${refusal.reason}); ${cancelledAtSupplier.length} other parcel(s) were`);
      return { refused: `supplier ${refusal.f.supplier} refused to cancel parcel ${refusal.f.seq}: ${refusal.reason}` };
    }
    const fresh = await trx('orders').where({ id: order.id }).first();
    for (const f of fulfilments) {
      const current = await trx('fulfilments').where({ id: f.id }).first();
      if (current.status !== f.status) throw refuse(`parcel ${f.seq} changed to ${current.status} meanwhile: run the command again`);
      await transitionFulfilment(trx, ctx, current, 'cancelled', { message: `parcel ${f.seq} cancelled` });
    }
    const paid = await trx('payments').where({ order_id: order.id }).whereIn('status', ['succeeded', 'partially_refunded']).orderBy('id', 'desc').first();
    const amount = paid ? paid.amount - paid.refunded_amount : 0;
    const refund = Boolean(paid) && amount > 0 && ['paid', 'partially_refunded'].includes(fresh.payment_status);
    await transitionOrder(trx, ctx, fresh, 'cancelled', { message: String(reason).slice(0, 200), patch: { expires_at: null, ...(refund ? { payment_status: 'refund_pending' } : {}) } });
    await trx('payments').where({ order_id: order.id }).whereIn('status', ['created', 'pending']).update({ status: 'expired', updated_at: at });
    if (refund) {
      await enqueue(trx, { type: 'payment.refund', payload: { orderId: order.id, paymentId: paid.id, amount, reason: String(reason).slice(0, 200) }, idemKey: `refund:${paid.id}:${amount}`, maxAttempts: 6 }, at);
    } else if (fresh.status !== 'pending_payment') {
      await queueEmail(trx, ctx, { orderId: order.id, template: 'order_cancelled', lang: order.lang, to: order.email, idemKey: `order_cancelled:${order.id}`, vars: { amount: 0 } });
    }
    return { ok: true, order: order.public_id, refund: refund ? 'queued' : 'none', amount: refund ? amount : 0 };
  }).then((result) => {
    if (result.refused) throw refuse(result.refused);
    return result;
  });
}

/* ---- a person closes a `manual` fulfilment (scripts/fulfilment-set.js) ----------------------------- */

/**
 * Record what a person did with a parked parcel: ordered it by hand (`submitted`), sent it (`shipped`, with
 * tracking), saw it arrive (`delivered`) or gave up on it (`cancelled`). Only parcels whose supplier is `manual`.
 * @param {{status: 'submitted'|'shipped'|'delivered'|'cancelled', tracking?: string, carrier?: string, url?: string, ref?: string}} change
 */
export async function setManualFulfilment(ctx, publicId, seq, change) {
  if (!['submitted', 'shipped', 'delivered', 'cancelled'].includes(change.status)) throw new AppError('VALIDATION', 400, 'status must be submitted, shipped, delivered or cancelled');
  if (change.url && !/^https?:\/\/\S+$/i.test(change.url)) throw new AppError('VALIDATION', 400, 'the tracking URL must start with http:// or https://');
  return ctx.db.transaction(async (trx) => {
    const order = await trx('orders').where({ public_id: publicId }).first();
    if (!order) throw new AppError('NOT_FOUND', 404, `no order ${publicId}`);
    let f = await trx('fulfilments').where({ order_id: order.id, seq: Number(seq) }).first();
    if (!f) throw new AppError('NOT_FOUND', 404, `order ${publicId} has no parcel ${seq}`);
    if (f.supplier !== 'manual') throw new AppError('CONFLICT', 409, `parcel ${seq} belongs to supplier ${f.supplier}, not to a person`);
    const at = nowOf(ctx);
    f = await transitionFulfilment(trx, ctx, f, change.status, {
      message: `parcel ${f.seq} set to ${change.status} by hand`,
      patch: { ...(change.status === 'submitted' ? { submitted_at: at, supplier_order_ref: change.ref ? String(change.ref).slice(0, 100) : f.supplier_order_ref } : {}), next_poll_at: null, last_error: null },
    });
    if (change.status === 'shipped') {
      const ref = String(change.ref || change.tracking || 'manual').slice(0, 100);
      await trx('shipments').insert({
        order_id: order.id, fulfilment_id: f.id, supplier_shipment_ref: ref, status: 'shipped', carrier: change.carrier ? String(change.carrier).slice(0, 80) : null,
        tracking_number: change.tracking ? String(change.tracking).slice(0, 100) : null, tracking_url: change.url ? String(change.url).slice(0, 500) : null,
        shipped_at: at, created_at: at, updated_at: at,
      }).onConflict(['fulfilment_id', 'supplier_shipment_ref']).ignore();
      const shipment = await trx('shipments').where({ fulfilment_id: f.id, supplier_shipment_ref: ref }).first();
      await queueEmail(trx, ctx, { orderId: order.id, template: 'shipped', lang: order.lang, to: order.email, idemKey: `shipped:shipment:${shipment.id}`, vars: { shipmentId: shipment.id } });
    }
    if (change.status === 'delivered') await trx('shipments').where({ fulfilment_id: f.id }).whereNull('delivered_at').update({ status: 'delivered', delivered_at: at, updated_at: at });
    const parked = await trx('fulfilments').where({ order_id: order.id, status: 'manual' }).first('id');
    if (!parked) await trx('orders').where({ id: order.id }).update({ needs_attention: false, updated_at: at });
    const after = await recomputeOrderStatus(trx, ctx, order.id);
    return { ok: true, order: order.public_id, parcel: f.seq, status: f.status, orderStatus: after.status };
  });
}
