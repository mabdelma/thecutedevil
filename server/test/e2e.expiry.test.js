// Sequence g.7: abandoned orders, late payments, anonymisation. Owner: core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../lib/errors.js';
import { startCoreServer, placeOrder, deliverPayment, orderRow, paymentOf, fulfilmentsOf, mails } from './core-fakes.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

test('g.7 an unpaid order expires after 60 minutes, silently; a payment that arrives late re-opens it', async () => {
  const s = await startCoreServer();
  try {
    const res = await placeOrder(s);
    const id = res.body.orderId;
    s.advance(59 * MIN);
    await s.tick();
    assert.equal((await orderRow(s, id)).status, 'pending_payment');
    s.advance(6 * MIN); // the next 5-minute window after the deadline
    await s.tick();
    assert.deepEqual([(await orderRow(s, id)).status, (await paymentOf(s, id)).status], ['expired', 'expired']);
    assert.deepEqual(s.pay.calls.getPayment, [(await paymentOf(s, id)).provider_ref]); // the provider was asked first
    assert.equal(mails(s).length, 0); // no e-mail for an abandoned bag
    assert.equal((await fulfilmentsOf(s, id)).length, 0);
    for (let i = 0; i < 3; i += 1) await s.tick();
    assert.equal((await s.db('order_events').where({ to_status: 'expired' }).count({ n: '*' }).first()).n, 1);
    // the same checkout id cannot be revived by the browser…
    const again = await s.api('/api/checkout', { method: 'POST', body: res.request });
    assert.deepEqual([again.status, again.body.error.code], [409, 'ORDER_CLOSED']);
    // …but real money can: the provider's late webhook confirms the expired order
    await deliverPayment(s, id);
    const order = await orderRow(s, id);
    assert.deepEqual([order.status, order.payment_status, (await fulfilmentsOf(s, id))[0].status], ['processing', 'paid', 'submitted']);
    assert.equal(mails(s, 'order_confirmed').length, 1);
  } finally { await s.close(); }
});

test('g.7 the webhook never came: the expiry job asks the provider and confirms a paid order instead of expiring it', async () => {
  const s = await startCoreServer();
  try {
    const paid = await placeOrder(s);
    const unknown = await placeOrder(s);
    const pPaid = await paymentOf(s, paid.body.orderId);
    Object.assign(s.pay.remote.get(pPaid.provider_ref), { status: 'succeeded', providerPaymentRef: 'pi_late' });
    const realGet = s.pay.getPayment;
    const pUnknown = await paymentOf(s, unknown.body.orderId);
    s.pay.getPayment = async (ref) => { if (ref === pUnknown.provider_ref) throw new ProviderError('NETWORK', 'timeout', { retryable: true }); return realGet(ref); };
    s.advance(65 * MIN);
    await s.tick();
    await s.tick();
    const order = await orderRow(s, paid.body.orderId);
    assert.deepEqual([order.status, order.payment_status, (await paymentOf(s, paid.body.orderId)).provider_payment_ref], ['processing', 'paid', 'pi_late']);
    assert.equal((await fulfilmentsOf(s, paid.body.orderId))[0].status, 'submitted');
    assert.equal(mails(s, 'order_confirmed').length, 1);
    // while the provider cannot be reached the other order is NOT expired (it may have been paid)
    assert.equal((await orderRow(s, unknown.body.orderId)).status, 'pending_payment');
    s.pay.getPayment = realGet;
    s.advance(5 * MIN);
    await s.tick();
    assert.equal((await orderRow(s, unknown.body.orderId)).status, 'expired');
    // a wrong amount at the provider is never confirmed by this path either
    const odd = await placeOrder(s);
    Object.assign(s.pay.remote.get((await paymentOf(s, odd.body.orderId)).provider_ref), { status: 'succeeded', amount: 1 });
    s.advance(65 * MIN);
    await s.tick();
    const o = await orderRow(s, odd.body.orderId);
    assert.deepEqual([o.payment_status, o.attention_reason], ['unpaid', 'PAYMENT_AMOUNT_MISMATCH']);
    // the provider's own "expired" event closes the order early
    const early = await placeOrder(s);
    await deliverPayment(s, early.body.orderId, 'payment.expired');
    assert.deepEqual([(await orderRow(s, early.body.orderId)).status, (await paymentOf(s, early.body.orderId)).status], ['expired', 'expired']);
  } finally { await s.close(); }
});

test('g.7 expired orders are anonymised after 30 days; paid orders are left alone', async () => {
  const s = await startCoreServer();
  try {
    const dead = await placeOrder(s, { note: 'ring the bell', items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' }, personalisation: { name: 'ALEX' } }] });
    const kept = await placeOrder(s);
    await deliverPayment(s, kept.body.orderId);
    s.advance(65 * MIN);
    await s.tick();
    s.advance(29 * DAY);
    await s.tick();
    assert.equal((await orderRow(s, dead.body.orderId)).email, 'buyer@example.test');
    s.advance(2 * DAY);
    await s.tick();
    const o = await orderRow(s, dead.body.orderId);
    assert.deepEqual([o.email, o.phone, o.ship_name, o.ship_line1, o.ship_city, o.ship_postcode, o.note], ['', null, '', '', '', null, null]);
    assert.ok(Number(o.anonymised_at) > 0);
    assert.equal((await s.db('order_items').where({ order_id: o.id }).first()).personalisation, null);
    assert.deepEqual([o.status, o.total, o.country], ['expired', 8899, 'ES']); // the bookkeeping stays
    const k = await orderRow(s, kept.body.orderId);
    assert.deepEqual([k.email, k.anonymised_at], ['buyer@example.test', null]);
    const view = await s.api(`/api/orders/${dead.body.orderId}?token=${dead.body.token}`);
    assert.deepEqual([view.status, view.body.status, view.body.shipTo.city], [200, 'expired', '']);
  } finally { await s.close(); }
});
