// Sequence g.4: cancel and refund before production. Owner: core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../lib/errors.js';
import { cancelOrder } from '../orders/service.js';
import { startCoreServer, paidOrder, placeOrder, deliverPayment, deliverSupplier, orderRow, paymentOf, fulfilmentsOf, mails } from './core-fakes.js';

const cannot = (err) => err.code === 'CANNOT_CANCEL';

test('g.4 cancel a paid, submitted order: supplier cancelled, refund with an idempotency key, e-mail after the refund', async () => {
  const s = await startCoreServer();
  try {
    const { id, fulfilments: [f] } = await paidOrder(s);
    const result = await cancelOrder(s.ctx, id, { reason: 'customer asked' });
    assert.deepEqual(result, { ok: true, order: id, refund: 'queued', amount: 8399 });
    assert.deepEqual(s.sup.gelato.calls.cancel, [f.external_id]);
    let order = await orderRow(s, id);
    assert.deepEqual([order.status, order.payment_status, (await fulfilmentsOf(s, id))[0].status], ['cancelled', 'refund_pending', 'cancelled']);
    assert.equal(mails(s, 'order_cancelled').length, 0); // not before the money is back
    await s.tick();
    const payment = await paymentOf(s, id);
    assert.equal(s.pay.calls.refund.length, 1);
    assert.deepEqual([s.pay.calls.refund[0].amount, s.pay.calls.refund[0].idempotencyKey, s.pay.calls.refund[0].payment.providerRef], [8399, `refund:${payment.id}:8399`, payment.provider_ref]);
    order = await orderRow(s, id);
    assert.deepEqual([order.payment_status, payment.status, payment.refunded_amount], ['refunded', 'refunded', 8399]);
    await s.tick();
    const mail = mails(s, 'order_cancelled');
    assert.equal(mail.length, 1);
    assert.ok(mail[0].text.includes('€83.99'));
    // the provider's own refund webhook arrives too: nothing is counted or sent twice
    await deliverPayment(s, id, 'refund.succeeded', { amount: 8399 });
    await s.tick();
    assert.deepEqual([(await paymentOf(s, id)).refunded_amount, mails(s, 'order_cancelled').length, mails(s, 'refund_issued').length, s.pay.calls.refund.length], [8399, 1, 0, 1]);
    await assert.rejects(cancelOrder(s.ctx, id), cannot); // already cancelled
    await assert.rejects(cancelOrder(s.ctx, 'TCD-000000-XXXX'), (err) => err.code === 'NOT_FOUND');
    // the supplier later reports its own "cancelled": harmless
    await deliverSupplier(s, 'gelato', f.external_id);
    assert.equal((await orderRow(s, id)).status, 'cancelled');
  } finally { await s.close(); }
});

test('g.4 CANNOT_CANCEL: in production, shipped, or the supplier refuses → nothing changes', async () => {
  const s = await startCoreServer();
  try {
    const a = await paidOrder(s);
    s.sup.gelato.set(a.fulfilments[0].external_id, 'in_production');
    await deliverSupplier(s, 'gelato', a.fulfilments[0].external_id);
    assert.equal((await fulfilmentsOf(s, a.id))[0].status, 'in_production');
    await assert.rejects(cancelOrder(s.ctx, a.id), cannot);
    assert.deepEqual([(await orderRow(s, a.id)).status, (await orderRow(s, a.id)).payment_status, s.sup.gelato.calls.cancel.length], ['processing', 'paid', 0]);

    const b = await paidOrder(s);
    s.sup.gelato.refuseCancel = true;
    await assert.rejects(cancelOrder(s.ctx, b.id), (err) => cannot(err) && /refused/.test(err.message));
    assert.deepEqual([(await orderRow(s, b.id)).status, (await orderRow(s, b.id)).payment_status, (await fulfilmentsOf(s, b.id))[0].status], ['processing', 'paid', 'submitted']);
    s.sup.gelato.refuseCancel = false;
    s.sup.gelato.capabilities.cancel = false; // a supplier with no cancel API at all
    await assert.rejects(cancelOrder(s.ctx, b.id), cannot);
    assert.equal((await s.db('jobs').where({ type: 'payment.refund' }).count({ n: '*' }).first()).n, 0);
    assert.equal(s.pay.calls.refund.length, 0);
    s.sup.gelato.capabilities.cancel = true;

    const c = await paidOrder(s);
    s.sup.gelato.ship(c.fulfilments[0].external_id);
    await deliverSupplier(s, 'gelato', c.fulfilments[0].external_id);
    await assert.rejects(cancelOrder(s.ctx, c.id), cannot);
  } finally { await s.close(); }
});

test('g.4 unpaid and manual orders; refund failures; dashboard refunds', async () => {
  const s = await startCoreServer();
  try {
    // unpaid: cancelled, nothing to refund, no e-mail; a payment that still arrives is flagged for a person
    const unpaid = await placeOrder(s);
    assert.deepEqual(await cancelOrder(s.ctx, unpaid.body.orderId), { ok: true, order: unpaid.body.orderId, refund: 'none', amount: 0 });
    assert.equal((await orderRow(s, unpaid.body.orderId)).status, 'cancelled');
    await deliverPayment(s, unpaid.body.orderId);
    let o = await orderRow(s, unpaid.body.orderId);
    assert.deepEqual([o.status, o.payment_status, o.needs_attention, o.attention_reason], ['cancelled', 'paid', 1, 'PAID_AFTER_CANCEL']);
    assert.equal((await fulfilmentsOf(s, unpaid.body.orderId)).length, 0); // nothing is produced for a cancelled order

    // parked with a person (manual): cancelled directly, refunded
    for (const id of ['gelato', 'printful', 'printify']) s.sup[id].failures.push(new ProviderError('NOPE', 'no', { retryable: false }));
    const parked = await paidOrder(s);
    await s.tick(); // the reroutes after each refusal run on the queue
    assert.equal((await fulfilmentsOf(s, parked.id))[0].status, 'manual');
    assert.equal((await cancelOrder(s.ctx, parked.id)).refund, 'queued');

    // the refund call fails with a network error: retried with backoff under the same key, then succeeds
    s.pay.failRefund = new ProviderError('NETWORK', 'timeout', { retryable: true });
    let t = await s.tick();
    assert.ok(t.failed >= 1);
    assert.equal((await orderRow(s, parked.id)).payment_status, 'refund_pending');
    s.advance(60 * 1000);
    await s.tick();
    assert.equal((await orderRow(s, parked.id)).payment_status, 'refunded');
    assert.deepEqual(s.pay.calls.refund.map((r) => r.idempotencyKey), [s.pay.calls.refund[0].idempotencyKey, s.pay.calls.refund[0].idempotencyKey]);

    // the provider refuses for good: flagged, owner told, not retried for ever
    const refused = await paidOrder(s);
    s.pay.failRefund = new ProviderError('CHARGE_DISPUTED', 'cannot refund', { retryable: false });
    await cancelOrder(s.ctx, refused.id);
    await s.tick();
    o = await orderRow(s, refused.id);
    assert.deepEqual([o.status, o.payment_status, o.needs_attention, o.attention_reason], ['cancelled', 'refund_pending', 1, 'REFUND_FAILED']);
    assert.equal((await s.db('jobs').where({ type: 'payment.refund', status: 'queued' }).count({ n: '*' }).first()).n, 0);

    // a provider that answers "pending": finished by its refund webhook
    const slow = await paidOrder(s);
    s.pay.refundStatus = 'pending';
    await cancelOrder(s.ctx, slow.id);
    await s.tick();
    assert.equal((await orderRow(s, slow.id)).payment_status, 'refund_pending');
    await deliverPayment(s, slow.id, 'refund.succeeded', { amount: 8399 });
    assert.equal((await orderRow(s, slow.id)).payment_status, 'refunded');
    s.pay.refundStatus = 'succeeded';

    // a partial refund made in the provider's dashboard on a live order
    const live = await paidOrder(s);
    await deliverPayment(s, live.id, 'refund.succeeded', { amount: 1000 });
    await deliverPayment(s, live.id, 'refund.succeeded', { amount: 1000 }); // a second notification of the same refund
    let p = await paymentOf(s, live.id);
    assert.deepEqual([p.status, p.refunded_amount, (await orderRow(s, live.id)).payment_status, (await orderRow(s, live.id)).status], ['partially_refunded', 1000, 'partially_refunded', 'processing']);
    await s.tick();
    assert.equal(mails(s, 'refund_issued').length, 1);
    assert.ok(mails(s, 'refund_issued')[0].text.includes('€10.00'));
    await deliverPayment(s, live.id, 'refund.succeeded', { amount: 8399 });
    p = await paymentOf(s, live.id);
    assert.deepEqual([p.status, p.refunded_amount, (await orderRow(s, live.id)).payment_status], ['refunded', 8399, 'refunded']);
    await deliverPayment(s, live.id, 'refund.failed');
    assert.equal((await orderRow(s, live.id)).attention_reason, 'REFUND_FAILED');
  } finally { await s.close(); }
});
