// Sequence g.1 (card, happy path) and g.6 (duplicates), plus the checkout rules of section f. Owner: core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../lib/errors.js';
import { sha256 } from '../lib/ids.js';
import { recordWebhookOnce, handlePaymentEvent } from '../orders/events.js';
import { startCoreServer, checkoutBody, placeOrder, deliverPayment, orderRow, paymentOf, fulfilmentsOf, mails } from './core-fakes.js';

const post = (s, path, body) => s.api(path, { method: 'POST', body });

test('g.1 card happy path: checkout → provider → webhook → supplier order → e-mail → status page', async () => {
  const s = await startCoreServer();
  try {
    const quote = (await post(s, '/api/quote', { country: 'ES', items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' } }] })).body;
    assert.deepEqual({ currency: quote.currency, subtotal: quote.subtotal, shipping: quote.shipping, total: quote.total, tax: quote.tax }, { currency: 'EUR', subtotal: 7900, shipping: 499, total: 8399, tax: { included: true, rateBp: 2100, amount: 1458, labelKey: 'checkout.tax.vatIncluded' } });
    assert.deepEqual(quote.paymentMethods, [{ method: 'card', provider: 'fakepay' }]);
    assert.ok(!JSON.stringify(quote).match(/printful|gelato|printify/), 'supplier ids never reach the browser');

    const res = await post(s, '/api/checkout', checkoutBody({ expectedTotal: quote.total }));
    assert.equal(res.status, 201);
    assert.match(res.body.orderId, /^TCD-\d{6}-[A-Z0-9]{4}$/);
    assert.match(res.body.token, /^[0-9a-f]{64}$/);
    assert.equal(res.body.statusUrl, `http://127.0.0.1:3000/order?id=${res.body.orderId}&token=${res.body.token}`);
    assert.equal(res.body.payment.kind, 'redirect');
    assert.equal(res.headers.get('cache-control'), 'no-store');

    let order = await orderRow(s, res.body.orderId);
    assert.deepEqual([order.status, order.payment_status, order.total, order.currency, order.region], ['pending_payment', 'unpaid', 8399, 'EUR', 'EU']);
    assert.equal(order.token_hash, sha256(res.body.token)); // only the hash is stored
    assert.ok(!JSON.stringify(order).includes(res.body.token));
    assert.equal(Number(order.expires_at) - Number(order.created_at), 60 * 60 * 1000);
    let payment = await paymentOf(s, res.body.orderId);
    assert.deepEqual([payment.status, payment.amount, payment.idem_key], ['pending', 8399, `checkout:${order.id}:1`]);
    assert.equal((await fulfilmentsOf(s, res.body.orderId)).length, 0); // nothing is ordered before the money arrives

    const sent = s.pay.calls.createCheckout[0];
    assert.deepEqual([sent.order.publicId, sent.order.total, sent.order.currency, sent.payment.amount, sent.payment.idemKey], [res.body.orderId, 8399, 'EUR', 8399, payment.idem_key]);
    assert.deepEqual(sent.items, [{ name: "halo's off hoodie", qty: 1, unitPrice: 7900, lineTotal: 7900 }]);
    assert.equal(sent.shipping.amount, 499);
    assert.equal(sent.urls.success, `${res.body.statusUrl}&paid=1`);
    assert.equal(sent.urls.cancel, `http://127.0.0.1:3000/checkout?cancelled=${res.body.orderId}`);

    const { fresh, event } = await deliverPayment(s, res.body.orderId);
    assert.equal(fresh, true);
    order = await orderRow(s, res.body.orderId);
    payment = await paymentOf(s, res.body.orderId);
    assert.deepEqual([order.status, order.payment_status, payment.status, order.expires_at], ['processing', 'paid', 'succeeded', null]);
    const [f] = await fulfilmentsOf(s, res.body.orderId);
    assert.deepEqual([f.supplier, f.status, f.external_id, f.candidate_index], ['gelato', 'submitted', `${res.body.orderId}-F1-0`, 0]);
    assert.deepEqual(JSON.parse(f.candidates), ['gelato', 'printful', 'printify']); // cheaper of the first tier, then the rest
    assert.ok(f.next_poll_at > s.now());
    const supplierOrder = s.sup.gelato.calls.createOrder[0];
    assert.deepEqual([supplierOrder.externalId, supplierOrder.orderPublicId, supplierOrder.cod], [f.external_id, res.body.orderId, null]);
    assert.deepEqual(supplierOrder.recipient, { name: 'Test Person', line1: 'Calle Falsa 123', line2: '', city: 'Valladolid', state: '', postcode: '47001', country: 'ES', phone: '+34600000000', email: 'buyer@example.test' });
    assert.deepEqual([supplierOrder.lines[0].productId, supplierOrder.lines[0].variantKey, supplierOrder.lines[0].qty, supplierOrder.lines[0].mapping.supplier], ['halos-off-hoodie', 'size=M', 1, 'gelato']);
    assert.equal(mails(s, 'order_confirmed').length, 1); // finished inside the webhook, no tick needed
    assert.equal(mails(s)[0].to, 'buyer@example.test');

    const view = await s.api(`/api/orders/${res.body.orderId}?token=${res.body.token}`);
    assert.equal(view.status, 200);
    assert.deepEqual([view.body.status, view.body.paymentStatus, view.body.total, view.body.fulfilments[0].status], ['processing', 'paid', 8399, 'submitted']);
    assert.deepEqual(view.body.shipTo, { city: 'Valladolid', country: 'ES' });
    assert.deepEqual(view.body.fulfilments[0].itemKeys, ['halos-off-hoodie|size=M']);
    assert.deepEqual(view.body.timeline.map((e) => e.status), ['pending_payment', 'confirmed', 'processing']);
    const text = JSON.stringify(view.body);
    for (const secret of ['buyer@example.test', '+34600000000', 'Calle Falsa', '47001', 'gelato', 'Test Person']) assert.ok(!text.includes(secret), secret);
    assert.equal(view.headers.get('referrer-policy'), 'no-referrer');

    // g.6: the same event again is recognised and does no work…
    assert.equal((await deliverPayment(s, res.body.orderId, 'payment.succeeded', {}, event)).fresh, false);
    // …and even a replay that slips past the dedupe table (a new event id) changes nothing
    await deliverPayment(s, res.body.orderId);
    await handlePaymentEvent(s.ctx, 'fakepay', event);
    await s.tick();
    assert.equal(s.sup.gelato.calls.createOrder.length, 1);
    assert.equal((await fulfilmentsOf(s, res.body.orderId)).length, 1);
    assert.equal(mails(s, 'order_confirmed').length, 1);
    assert.equal((await orderRow(s, res.body.orderId)).needs_attention, 0);
    const hooks = await s.db('webhook_events').where({ source: 'pay:fakepay' });
    assert.ok(hooks.every((h) => h.status === 'processed' && h.payload_hash.length === 64));
  } finally { await s.close(); }
});

test('checkout is idempotent on checkoutId: repeats and double submits give one order and the same payment page', async () => {
  const s = await startCoreServer();
  try {
    const body = checkoutBody();
    const first = await post(s, '/api/checkout', body);
    const again = await post(s, '/api/checkout', body);
    assert.equal(again.status, 201);
    assert.deepEqual(again.body, first.body); // same order, same token, same redirect URL
    assert.equal(s.pay.calls.createCheckout.length, 1);
    // even with different contents: the id decides, nothing is overwritten
    const changed = await post(s, '/api/checkout', { ...body, items: [{ id: 'horns-down-cap', qty: 3, options: {} }], expectedTotal: 1 });
    assert.deepEqual(changed.body, first.body);
    // a true double submit: both requests in flight together
    const twin = checkoutBody();
    const [a, b] = await Promise.all([post(s, '/api/checkout', twin), post(s, '/api/checkout', twin)]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.equal(a.body.orderId, b.body.orderId);
    assert.equal(a.body.payment.url, b.body.payment.url);
    assert.equal((await s.db('orders').count({ n: '*' }).first()).n, 2);
    assert.equal((await s.db('payments').count({ n: '*' }).first()).n, 2);
    // after payment the repeat says "confirmed" and does not open a second payment
    await deliverPayment(s, first.body.orderId);
    const paid = await post(s, '/api/checkout', body);
    assert.deepEqual([paid.status, paid.body.orderId, paid.body.payment], [201, first.body.orderId, { kind: 'confirmed' }]);
    assert.equal(s.pay.calls.createCheckout.length, 2); // one per order, never more
    assert.ok(!JSON.stringify(await orderRow(s, first.body.orderId)).includes(body.checkoutId)); // the browser's id is stored hashed
  } finally { await s.close(); }
});

test('the server never trusts client prices: tampering, stale totals, unavailable items, wrong method', async () => {
  const s = await startCoreServer();
  try {
    // a client that sends its own prices gets the server's numbers back
    const q = await post(s, '/api/quote', { country: 'ES', currency: 'EGP', items: [{ id: 'halos-off-hoodie', qty: 2, options: { size: 'M' }, unit: 1, price: 1, total: 1 }], total: 2, shipping: 0 });
    assert.deepEqual([q.body.currency, q.body.lines[0].unit, q.body.subtotal, q.body.shipping, q.body.total], ['EUR', 7900, 15800, 0, 15800]); // free shipping from 90.00
    const cheat = await post(s, '/api/checkout', checkoutBody({ expectedTotal: 100 }));
    assert.equal(cheat.status, 409);
    assert.equal(cheat.body.error.code, 'PRICE_CHANGED');
    assert.equal(cheat.body.quote.total, 8399); // a fresh quote comes with the refusal
    assert.equal((await s.db('orders').count({ n: '*' }).first()).n, 0);
    // personalisation surcharge is added by the server
    const p = await post(s, '/api/quote', { country: 'ES', items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' }, personalisation: { name: 'ALEX' } }] });
    assert.deepEqual([p.body.lines[0].key, p.body.lines[0].unit], ['halos-off-hoodie|size=M|@name=ALEX', 8400]);
    // Canada: prices exclude tax, duties notice
    const ca = await post(s, '/api/quote', { country: 'CA', items: [{ id: 'horns-down-cap', qty: 1, options: {} }] });
    assert.deepEqual([ca.body.currency, ca.body.subtotal, ca.body.shipping, ca.body.total, ca.body.tax.included, ca.body.notices], ['CAD', 4400, 899, 5299, false, ['checkout.notice.dutiesMayApply']]);
    // perfume is never sold online; a "soon" product neither
    const mixed = await post(s, '/api/quote', { country: 'ES', items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' } }, { id: 'secret-no-1', qty: 1, options: { volume: '50 ml' } }, { id: 'two-sides-socks', qty: 1, options: { size: '36-40' } }] });
    assert.deepEqual(mixed.body.unavailable, [{ key: 'secret-no-1|volume=50 ml', reason: 'NOT_FOR_SALE' }, { key: 'two-sides-socks|size=36-40', reason: 'NOT_FOR_SALE' }]);
    assert.equal(mixed.body.total, 8399); // only what can be sold is priced
    const refuse = await post(s, '/api/checkout', checkoutBody({ items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' } }, { id: 'secret-no-1', qty: 1, options: { volume: '50 ml' } }] }));
    assert.deepEqual([refuse.status, refuse.body.error.code, refuse.body.error.fields], [422, 'ITEM_UNAVAILABLE', ['secret-no-1|volume=50 ml']]);
    // a supplier that cannot make it → unavailable for that region
    for (const id of ['printful', 'gelato', 'printify']) s.sup[id].unavailable.add('horns-down-cap');
    const gone = await post(s, '/api/quote', { country: 'ES', items: [{ id: 'horns-down-cap', qty: 1, options: {} }] });
    assert.deepEqual(gone.body.unavailable, [{ key: 'horns-down-cap', reason: 'NOT_AVAILABLE_IN_REGION' }]);
    assert.deepEqual([gone.body.total, gone.body.paymentMethods], [0, []]);
    // errors of section f
    assert.equal((await post(s, '/api/quote', { country: 'BR', items: [{ id: 'horns-down-cap', qty: 1, options: {} }] })).body.error.code, 'MARKET_NOT_SERVED');
    assert.equal((await post(s, '/api/quote', { country: 'US', items: [{ id: 'horns-down-cap', qty: 1, options: {} }] })).status, 422); // US is behind a flag
    assert.equal((await post(s, '/api/quote', { country: 'ES', items: [] })).body.error.code, 'CART_EMPTY');
    const bad = await post(s, '/api/quote', { country: 'ES', items: [{ id: 'nope', qty: 1 }] });
    assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.fields], [400, 'VALIDATION', { 'items.0.id': 'unknown' }]);
    const cod = await post(s, '/api/checkout', checkoutBody({ paymentMethod: 'cod' }));
    assert.deepEqual([cod.status, cod.body.error.code], [422, 'PAYMENT_METHOD_UNAVAILABLE']); // no cash on delivery in Spain
    const ship = await post(s, '/api/checkout', checkoutBody({ shippingOption: 'teleport' }));
    assert.deepEqual([ship.status, ship.body.error.fields], [400, { shippingOption: 'unknown' }]);
    assert.equal((await post(s, '/api/checkout', checkoutBody({ acceptTerms: false }))).status, 400);
    assert.equal((await s.db('orders').count({ n: '*' }).first()).n, 0);
    const malformed = await s.api('/api/quote', { method: 'POST', body: '{nope', headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual([malformed.status, malformed.body.error.code], [400, 'VALIDATION']);
    const huge = await s.api('/api/quote', { method: 'POST', body: JSON.stringify({ country: 'ES', pad: 'x'.repeat(120000) }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(huge.status, 413);
  } finally { await s.close(); }
});

test('payment provider down: 502, the order stays unpaid, and the same checkoutId retries cleanly', async () => {
  const s = await startCoreServer();
  try {
    s.pay.failCheckout = new ProviderError('STRIPE_DOWN', 'connect ETIMEDOUT sk_live_abcdef', { retryable: true });
    const body = checkoutBody();
    const down = await post(s, '/api/checkout', body);
    assert.deepEqual([down.status, down.body.error.code], [502, 'PAYMENT_PROVIDER_ERROR']);
    assert.ok(!JSON.stringify(down.body).includes('sk_live'));
    const order = await s.db('orders').first();
    let payment = await s.db('payments').first();
    assert.deepEqual([order.status, payment.status], ['pending_payment', 'created']);
    assert.ok(!payment.last_error.includes('sk_live_abcdef'));
    const retry = await post(s, '/api/checkout', body);
    assert.deepEqual([retry.status, retry.body.orderId, retry.body.payment.kind], [201, order.public_id, 'redirect']);
    assert.equal((await s.db('orders').count({ n: '*' }).first()).n, 1);
    assert.equal((await s.db('payments').count({ n: '*' }).first()).n, 1);
    assert.equal(s.pay.calls.createCheckout[1].payment.idemKey, s.pay.calls.createCheckout[0].payment.idemKey); // same idempotency key at the provider
    // the payment failed at the provider: the same checkout opens a NEW attempt with a new key
    await deliverPayment(s, order.public_id, 'payment.failed');
    assert.equal((await orderRow(s, order.public_id)).status, 'pending_payment');
    const third = await post(s, '/api/checkout', body);
    assert.equal(third.body.orderId, order.public_id);
    payment = await paymentOf(s, order.public_id);
    assert.deepEqual([payment.idem_key, payment.status], [`checkout:${order.id}:2`, 'pending']);
    assert.notEqual(third.body.payment.url, retry.body.payment.url);
    // a provider that answers "confirmed" for a card must never confirm an unpaid order
    s.pay.createCheckout = async () => ({ kind: 'confirmed', providerRef: 'x' });
    const wrong = await post(s, '/api/checkout', checkoutBody());
    assert.equal(wrong.status, 502);
    assert.equal((await s.db('orders').where({ status: 'confirmed' }).count({ n: '*' }).first()).n, 0);
  } finally { await s.close(); }
});

test('webhook checks: wrong amount or currency never confirms; unknown references are ignored; failures are retried', async () => {
  const s = await startCoreServer();
  try {
    const a = await placeOrder(s);
    await deliverPayment(s, a.body.orderId, 'payment.succeeded', { amount: 100 });
    let order = await orderRow(s, a.body.orderId);
    assert.deepEqual([order.status, order.payment_status, order.needs_attention, order.attention_reason], ['pending_payment', 'unpaid', 1, 'PAYMENT_AMOUNT_MISMATCH']);
    assert.equal((await fulfilmentsOf(s, a.body.orderId)).length, 0);
    await s.tick();
    assert.equal(mails(s, 'owner_alert').length, 1);
    assert.ok(mails(s, 'owner_alert')[0].subject.includes('PAYMENT_AMOUNT_MISMATCH'));
    assert.equal(mails(s, 'owner_alert')[0].to, 'owner@shop.test');
    const b = await placeOrder(s);
    await deliverPayment(s, b.body.orderId, 'payment.succeeded', { currency: 'USD' });
    assert.equal((await orderRow(s, b.body.orderId)).status, 'pending_payment');
    // an event for a session that is not ours
    const stray = { eventId: 'evt_stray', type: 'payment.succeeded', providerRef: 'sess_unknown', amount: 1, currency: 'EUR', occurredAt: Date.now() };
    assert.equal(await recordWebhookOnce(s.ctx, { source: 'pay:fakepay', eventId: stray.eventId, type: stray.type, rawBody: Buffer.from('{}') }), true);
    await handlePaymentEvent(s.ctx, 'fakepay', stray);
    assert.equal((await s.db('webhook_events').where({ event_id: 'evt_stray' }).first()).status, 'ignored');
    await handlePaymentEvent(s.ctx, 'fakepay', { eventId: 'evt_ign', type: 'ignored' });
    // dedupe table: duplicate → false; a failed one is let through again; so is one stuck in `received` for 5 minutes
    const hook = { source: 'pay:fakepay', eventId: 'evt_dup', type: 'payment.succeeded', rawBody: Buffer.from('body') };
    assert.equal(await recordWebhookOnce(s.ctx, hook), true);
    assert.equal(await recordWebhookOnce(s.ctx, hook), false);
    const row = await s.db('webhook_events').where({ event_id: 'evt_dup' }).first();
    assert.equal(row.payload_hash, sha256(Buffer.from('body'))); // the body itself is not stored
    s.advance(5 * 60 * 1000 + 1);
    assert.equal(await recordWebhookOnce(s.ctx, hook), true); // the first handler died mid-way
    assert.equal(await recordWebhookOnce(s.ctx, hook), false);
    // a handler that throws marks the row failed and rethrows, so the route answers 500 and the provider retries
    const c = await placeOrder(s);
    const payment = await paymentOf(s, c.body.orderId);
    const ev = s.pay.event('payment.succeeded', payment);
    const realRoute = s.sup.gelato.isAvailable;
    const brokenDb = s.ctx.db;
    s.ctx.suppliers.get = () => { throw new Error('registry exploded'); };
    assert.equal(await recordWebhookOnce(s.ctx, { source: 'pay:fakepay', eventId: ev.eventId, type: ev.type }), true);
    await assert.rejects(handlePaymentEvent(s.ctx, 'fakepay', ev), /registry exploded/);
    assert.equal((await s.db('webhook_events').where({ event_id: ev.eventId }).first()).status, 'failed');
    assert.equal((await orderRow(s, c.body.orderId)).status, 'pending_payment'); // nothing half-done
    delete s.ctx.suppliers.get;
    s.ctx.suppliers.get = (id) => s.sup[id] || null;
    assert.equal(await recordWebhookOnce(s.ctx, { source: 'pay:fakepay', eventId: ev.eventId, type: ev.type }), true); // the retry is processed
    await handlePaymentEvent(s.ctx, 'fakepay', ev);
    assert.equal((await orderRow(s, c.body.orderId)).status, 'processing');
    assert.equal((await s.db('webhook_events').where({ event_id: ev.eventId }).first()).status, 'processed');
    assert.ok(realRoute && brokenDb);
  } finally { await s.close(); }
});
