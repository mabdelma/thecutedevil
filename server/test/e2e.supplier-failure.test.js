// Sequence g.2: the customer paid and the supplier call fails. Owner: core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../lib/errors.js';
import { setManualFulfilment } from '../orders/service.js';
import { startCoreServer, paidOrder, orderRow, fulfilmentsOf, mails } from './core-fakes.js';

const MIN = 60 * 1000;
const retryable = () => new ProviderError('SUPPLIER_TIMEOUT', 'timeout', { retryable: true });
const fatal = () => new ProviderError('VARIANT_DISCONTINUED', 'no such variant', { retryable: false });
const one = async (s, id) => (await fulfilmentsOf(s, id))[0];

test('g.2 retryable errors: retried after 1, 5 and 15 minutes with the same external id, then the next candidate', async () => {
  const s = await startCoreServer();
  try {
    s.sup.gelato.failures.push(retryable(), retryable(), retryable(), retryable());
    const { id } = await paidOrder(s);
    let f = await one(s, id);
    assert.deepEqual([f.supplier, f.status, f.submit_attempts], ['gelato', 'pending', 1]);
    assert.equal((await orderRow(s, id)).status, 'confirmed'); // paid, not yet with a supplier
    assert.equal(mails(s, 'order_confirmed').length, 1); // the customer still gets the confirmation
    const job = () => s.db('jobs').where({ idem_key: `fulfilment.submit:${f.id}:0` }).first();
    assert.equal(Number((await job()).run_after) - s.now(), 1 * MIN);
    await s.tick();
    assert.equal(s.sup.gelato.calls.createOrder.length, 1); // not due yet: repeated ticks do not hammer the supplier
    s.advance(1 * MIN);
    await s.tick();
    assert.deepEqual([(await one(s, id)).submit_attempts, Number((await job()).run_after) - s.now()], [2, 5 * MIN]);
    s.advance(5 * MIN);
    await s.tick();
    assert.deepEqual([(await one(s, id)).submit_attempts, Number((await job()).run_after) - s.now()], [3, 15 * MIN]);
    assert.deepEqual(new Set(s.sup.gelato.calls.createOrder.map((c) => c.externalId)), new Set([`${id}-F1-0`])); // every retry reuses the id
    s.advance(15 * MIN);
    await s.tick(); // fourth failure → printful, with a NEW external id; the queued job runs in the same tick
    f = await one(s, id);
    assert.deepEqual([f.supplier, f.status, f.candidate_index, f.external_id, f.submit_attempts], ['printful', 'submitted', 1, `${id}-F1-1`, 0]);
    assert.equal(s.sup.gelato.calls.createOrder.length, 4);
    assert.equal(s.sup.printful.calls.createOrder[0].externalId, `${id}-F1-1`);
    assert.equal(s.sup.printful.calls.createOrder[0].lines[0].mapping.supplier, 'printful');
    assert.equal((await orderRow(s, id)).status, 'processing');
    assert.equal((await orderRow(s, id)).needs_attention, 0);
  } finally { await s.close(); }
});

test('g.2 non-retryable error: straight to the next candidate; none left → manual, flagged, owner alerted, no refund', async () => {
  const s = await startCoreServer();
  try {
    s.sup.gelato.failures.push(fatal());
    s.sup.printful.failures.push(fatal());
    s.sup.printify.failures.push(fatal());
    const { id } = await paidOrder(s);
    await s.tick();
    const f = await one(s, id);
    assert.deepEqual([f.supplier, f.status, f.candidate_index], ['manual', 'manual', 2]);
    assert.deepEqual([s.sup.gelato.calls.createOrder.length, s.sup.printful.calls.createOrder.length, s.sup.printify.calls.createOrder.length], [1, 1, 1]);
    const order = await orderRow(s, id);
    assert.deepEqual([order.status, order.payment_status, order.needs_attention, order.attention_reason], ['confirmed', 'paid', 1, 'NO_SUPPLIER_LEFT']);
    assert.equal(s.pay.calls.refund.length, 0); // a person decides
    const alert = mails(s, 'owner_alert');
    assert.equal(alert.length, 1);
    assert.deepEqual([alert[0].to, alert[0].lang], ['owner@shop.test', 'en']);
    assert.ok(alert[0].subject.includes(id) && alert[0].text.includes('NO_SUPPLIER_LEFT'));
    assert.ok(!alert[0].text.includes('buyer@example.test') && !alert[0].text.includes('Calle Falsa'));
    for (let i = 0; i < 3; i += 1) await s.tick();
    assert.equal(mails(s, 'owner_alert').length, 1); // one alert per order and reason
    // a person orders it by hand and closes the parcel with the script's function
    await assert.rejects(setManualFulfilment(s.ctx, id, 1, { status: 'delivered' }), (err) => err.code === 'ILLEGAL_TRANSITION');
    await assert.rejects(setManualFulfilment(s.ctx, id, 2, { status: 'shipped' }), (err) => err.code === 'NOT_FOUND');
    await assert.rejects(setManualFulfilment(s.ctx, id, 1, { status: 'shipped', url: 'javascript:1' }), (err) => err.code === 'VALIDATION');
    let done = await setManualFulfilment(s.ctx, id, 1, { status: 'submitted', ref: 'HAND-1' });
    assert.deepEqual([done.status, done.orderStatus], ['submitted', 'processing']);
    assert.equal((await orderRow(s, id)).needs_attention, 0);
    done = await setManualFulfilment(s.ctx, id, 1, { status: 'shipped', carrier: 'Correos', tracking: 'PK123', url: 'https://correos.test/PK123' });
    assert.equal(done.orderStatus, 'shipped');
    await s.tick();
    const shipped = mails(s, 'shipped');
    assert.equal(shipped.length, 1);
    assert.ok(shipped[0].text.includes('Correos PK123') && shipped[0].text.includes('https://correos.test/PK123'));
    assert.equal((await setManualFulfilment(s.ctx, id, 1, { status: 'delivered' })).orderStatus, 'delivered');
  } finally { await s.close(); }
});

test('g.2 the supplier answer was lost: the order exists there after all → adopted, never ordered twice', async () => {
  const s = await startCoreServer();
  try {
    s.sup.gelato.swallow = true; // createOrder stores the order, then the connection drops
    s.sup.gelato.failures.push(fatal());
    const { id } = await paidOrder(s);
    const f = await one(s, id);
    assert.deepEqual([f.supplier, f.status, f.candidate_index], ['gelato', 'submitted', 0]);
    assert.equal(s.sup.gelato.orders.size, 1);
    assert.equal(s.sup.printful.calls.createOrder.length, 0);
    assert.equal((await orderRow(s, id)).status, 'processing');
  } finally { await s.close(); }
});

test('crash between "submitting" and the answer: the re-run repeats createOrder with the same id and finishes', async () => {
  const s = await startCoreServer();
  try {
    // the state a killed process leaves behind: the supplier has the order, we never recorded the answer
    const { id } = await paidOrder(s);
    let f = await one(s, id);
    assert.equal(f.status, 'submitted');
    await s.db('fulfilments').where({ id: f.id }).update({ status: 'submitting', supplier_order_ref: null, submitted_at: null });
    await s.db('orders').where({ public_id: id }).update({ status: 'confirmed' });
    await s.db('jobs').where({ type: 'fulfilment.submit' }).update({ status: 'running', locked_at: s.now() - 10 * MIN });
    await s.tick(); // stale lock → re-queued → run again
    f = await one(s, id);
    assert.deepEqual([f.status, f.supplier, f.external_id], ['submitted', 'gelato', `${id}-F1-0`]);
    assert.equal(s.sup.gelato.orders.size, 1); // one order at the supplier
    assert.deepEqual(s.sup.gelato.calls.createOrder.map((c) => c.externalId), [`${id}-F1-0`, `${id}-F1-0`]);
    assert.equal((await orderRow(s, id)).status, 'processing');
  } finally { await s.close(); }
});

test('supplier not loaded, and doubtful personalisation text → next candidate / manual review', async () => {
  const s = await startCoreServer();
  try {
    // paid while gelato was configured; by the time the job runs its adapter is gone
    s.sup.gelato.failures.push(retryable());
    const a = await paidOrder(s);
    s.ctx.suppliers.get = (id) => (id === 'gelato' ? null : s.sup[id] || null);
    s.advance(MIN);
    await s.tick();
    assert.deepEqual([(await one(s, a.id)).supplier, (await one(s, a.id)).status], ['printful', 'submitted']);
    s.ctx.suppliers.get = (id) => s.sup[id] || null;

    const b = await paidOrder(s, { items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'L' }, personalisation: { name: 'Nike' } }] });
    const f = await one(s, b.id);
    assert.deepEqual([f.status, f.supplier], ['manual', 'manual']);
    assert.equal((await orderRow(s, b.id)).attention_reason, 'PERSONALISATION_REVIEW');
    assert.equal(s.sup.gelato.calls.createOrder.filter((c) => c.orderPublicId === b.id).length, 0); // never reached a supplier
    const ok = await paidOrder(s, { items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'L' }, personalisation: { name: 'ALEX' } }] });
    assert.equal((await one(s, ok.id)).status, 'submitted');
    assert.deepEqual(s.sup.gelato.calls.createOrder.find((c) => c.orderPublicId === ok.id).lines[0].personalisation, { name: 'ALEX' });
    assert.equal(ok.order.total, 8400 + 499);
  } finally { await s.close(); }
});

test('a paid line nobody can make any more goes to manual at confirmation', async () => {
  const s = await startCoreServer();
  try {
    const { placeOrder, deliverPayment } = await import('./core-fakes.js');
    const res = await placeOrder(s, { items: [{ id: 'horns-down-cap', qty: 1, options: {} }] });
    for (const id of ['printful', 'printify']) s.sup[id].unavailable.add('horns-down-cap'); // went out of stock while the customer was paying
    await deliverPayment(s, res.body.orderId);
    const f = await one(s, res.body.orderId);
    assert.deepEqual([f.supplier, f.status, JSON.parse(f.candidates)], ['manual', 'manual', ['manual']]);
    const order = await orderRow(s, res.body.orderId);
    assert.deepEqual([order.status, order.payment_status, order.needs_attention, order.attention_reason], ['confirmed', 'paid', 1, 'MANUAL_FULFILMENT']);
  } finally { await s.close(); }
});
