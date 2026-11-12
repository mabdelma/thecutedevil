// Sequence g.5: the supplier ships (webhook and poll), split orders, alerts. Owner: core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCoreServer, paidOrder, deliverSupplier, orderRow, fulfilmentsOf, mails } from './core-fakes.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('g.5 split order: two parcels, one e-mail per shipment, partially_shipped → shipped → delivered', async () => {
  const s = await startCoreServer();
  try {
    s.sup.printful.unavailable.add('halos-off-hoodie'); // hoodie → gelato, cap → printful
    const quote = (await s.api('/api/quote', { method: 'POST', body: { country: 'ES', items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' } }, { id: 'horns-down-cap', qty: 1, options: {} }] } })).body;
    assert.equal(quote.fulfilments.length, 2);
    assert.deepEqual(quote.notices, ['checkout.notice.splitShipment']);
    assert.deepEqual(quote.lines.map((l) => l.fulfilment), [0, 1]);
    assert.equal(quote.shipping, 0); // one shipping price per order (free here: over 90.00), even when it splits
    const { id, token } = await paidOrder(s, { items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' } }, { id: 'horns-down-cap', qty: 1, options: {} }] });
    const [f1, f2] = await fulfilmentsOf(s, id);
    assert.deepEqual([[f1.seq, f1.supplier, f1.status, f1.external_id], [f2.seq, f2.supplier, f2.status, f2.external_id]], [[1, 'gelato', 'submitted', `${id}-F1-0`], [2, 'printful', 'submitted', `${id}-F2-0`]]);
    assert.ok(mails(s, 'order_confirmed')[0].text.includes('separate parcels'));

    s.sup.gelato.ship(f1.external_id);
    const first = await deliverSupplier(s, 'gelato', f1.external_id);
    assert.equal(first.fresh, true);
    assert.deepEqual([(await fulfilmentsOf(s, id)).map((f) => f.status), (await orderRow(s, id)).status], [['shipped', 'submitted'], 'partially_shipped']);
    let shipped = mails(s, 'shipped'); // sent inside the webhook
    assert.equal(shipped.length, 1);
    assert.ok(shipped[0].text.includes('DHL TRK-SHIP1') && shipped[0].text.includes('https://track.test/SHIP1') && shipped[0].text.includes('another parcel'));
    assert.ok(shipped[0].text.includes('hoodie') && !shipped[0].text.includes('cap')); // only what is in this parcel
    // the same webhook again, a different event for the same state, and a poll: still one shipment, one e-mail
    assert.equal((await deliverSupplier(s, 'gelato', f1.external_id, first.event)).fresh, false);
    await deliverSupplier(s, 'gelato', f1.external_id);
    s.advance(25 * HOUR);
    await s.tick();
    assert.equal((await s.db('shipments').count({ n: '*' }).first()).n, 1);
    assert.equal(mails(s, 'shipped').length, 1);

    s.sup.printful.ship(f2.external_id, { ref: 'SHIP2' });
    await deliverSupplier(s, 'printful', f2.external_id);
    assert.equal((await orderRow(s, id)).status, 'shipped');
    shipped = mails(s, 'shipped');
    assert.equal(shipped.length, 2);
    assert.ok(!shipped[1].text.includes('another parcel'));

    const view = (await s.api(`/api/orders/${id}?token=${token}`)).body;
    assert.deepEqual(view.fulfilments.map((f) => [f.index, f.status, f.itemKeys, f.shipments.length]), [[0, 'shipped', ['halos-off-hoodie|size=M'], 1], [1, 'shipped', ['horns-down-cap'], 1]]);
    assert.deepEqual(view.fulfilments[0].shipments[0], { carrier: 'DHL', trackingNumber: 'TRK-SHIP1', trackingUrl: 'https://track.test/SHIP1', shippedAt: 1700000000000, deliveredAt: null });
    assert.deepEqual(view.timeline.filter((e) => e.type === 'order').map((e) => e.status), ['pending_payment', 'confirmed', 'processing', 'partially_shipped', 'shipped']);

    s.sup.gelato.ship(f1.external_id, { delivered: true });
    s.sup.printful.ship(f2.external_id, { ref: 'SHIP2', delivered: true });
    await deliverSupplier(s, 'gelato', f1.external_id);
    assert.equal((await orderRow(s, id)).status, 'shipped'); // one parcel still on the road
    await deliverSupplier(s, 'printful', f2.external_id);
    assert.equal((await orderRow(s, id)).status, 'delivered');
    assert.equal((await s.db('shipments').where({ status: 'delivered' }).count({ n: '*' }).first()).n, 2);
    assert.equal(mails(s, 'shipped').length, 2);
    // events for things that are not ours are ignored
    const { recordWebhookOnce, handleSupplierEvent } = await import('../orders/events.js');
    for (const ev of [{ eventId: 'x1', type: 'order.updated', externalId: 'TCD-000000-XXXX-F1-0' }, { eventId: 'x2', type: 'stock.updated' }, { eventId: 'x3', type: 'order.updated', externalId: f1.external_id }]) {
      await recordWebhookOnce(s.ctx, { source: 'sup:printify', eventId: ev.eventId, type: ev.type });
      await handleSupplierEvent(s.ctx, 'printify', ev); // f1 belongs to gelato, not printify
    }
    assert.deepEqual((await s.db('webhook_events').where({ source: 'sup:printify' }).orderBy('id')).map((r) => r.status), ['ignored', 'ignored', 'ignored']);
  } finally { await s.close(); }
});

test('g.5 polling: every 6 hours with webhooks, every hour without; delivered straight from submitted', async () => {
  const s = await startCoreServer();
  try {
    const a = await paidOrder(s);
    const f = a.fulfilments[0];
    assert.equal(Number(f.next_poll_at) - s.now(), 6 * HOUR);
    s.sup.gelato.ship(f.external_id, { delivered: true }); // no webhook ever arrives
    s.advance(6 * HOUR - 1000);
    await s.tick();
    assert.equal((await fulfilmentsOf(s, a.id))[0].status, 'submitted'); // not due yet
    s.advance(1000);
    await s.tick();
    const after = (await fulfilmentsOf(s, a.id))[0];
    assert.deepEqual([after.status, after.next_poll_at, (await orderRow(s, a.id)).status], ['delivered', null, 'delivered']);
    await s.tick();
    assert.equal(mails(s, 'shipped').length, 1);

    s.sup.printful.capabilities.webhooks = false;
    s.sup.gelato.unavailable.add('halos-off-hoodie');
    const b = await paidOrder(s);
    assert.deepEqual([b.fulfilments[0].supplier, Number(b.fulfilments[0].next_poll_at) - s.now()], ['printful', 1 * HOUR]);
    // the supplier API is down during a poll: logged, the next poll is still scheduled
    const realGet = s.sup.printful.getOrder;
    s.sup.printful.getOrder = async () => { throw new Error('503'); };
    s.advance(HOUR);
    const t = await s.tick();
    assert.equal(t.failed, 0);
    assert.equal(Number((await fulfilmentsOf(s, b.id))[0].next_poll_at) - s.now(), HOUR);
    s.sup.printful.getOrder = realGet;
    s.sup.printful.set(b.fulfilments[0].external_id, 'in_production');
    s.advance(HOUR);
    await s.tick();
    assert.deepEqual([(await fulfilmentsOf(s, b.id))[0].status, (await orderRow(s, b.id)).status], ['in_production', 'processing']);
  } finally { await s.close(); }
});

test('g.5 alerts: supplier on hold or failed, supplier-side cancellation, and a parcel open for 10 days', async () => {
  const s = await startCoreServer();
  try {
    const a = await paidOrder(s);
    s.sup.gelato.set(a.fulfilments[0].external_id, 'on_hold', { problem: 'artwork too small' });
    await deliverSupplier(s, 'gelato', a.fulfilments[0].external_id);
    let o = await orderRow(s, a.id);
    assert.deepEqual([o.needs_attention, o.attention_reason, (await fulfilmentsOf(s, a.id))[0].status], [1, 'SUPPLIER_ON_HOLD', 'submitted']);
    await deliverSupplier(s, 'gelato', a.fulfilments[0].external_id);
    await s.tick();
    assert.equal(mails(s, 'owner_alert').length, 1); // once, however often the supplier repeats it
    assert.ok(mails(s, 'owner_alert')[0].text.includes('artwork too small'));

    const b = await paidOrder(s);
    s.sup.gelato.set(b.fulfilments[0].external_id, 'cancelled');
    await deliverSupplier(s, 'gelato', b.fulfilments[0].external_id);
    o = await orderRow(s, b.id);
    assert.deepEqual([o.status, o.payment_status, o.attention_reason, (await fulfilmentsOf(s, b.id))[0].status], ['processing', 'paid', 'SUPPLIER_CANCELLED', 'manual']); // parked, not lost

    const c = await paidOrder(s);
    s.advance(10 * DAY);
    await s.tick();
    o = await orderRow(s, c.id);
    assert.deepEqual([o.needs_attention, o.attention_reason], [1, 'FULFILMENT_OVERDUE']);
    s.advance(6 * HOUR);
    await s.tick();
    await s.tick();
    assert.equal(mails(s, 'owner_alert').filter((m) => m.subject.includes(c.id)).length, 1);
  } finally { await s.close(); }
});
