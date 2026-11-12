// Sequence g.3: cash on delivery (Egypt). Owner: core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../lib/errors.js';
import { startCoreServer, placeOrder, deliverSupplier, orderRow, paymentOf, fulfilmentsOf, mails } from './core-fakes.js';

const EG = {
  country: 'EG', paymentMethod: 'cod', lang: 'ar', items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' } }, { id: 'nice-guy-long-story-tee', qty: 2, options: { size: 'L' } }],
  customer: { name: 'Test Person', email: 'buyer@example.test', phone: '+201000000000' }, address: { line1: '12 Tahrir Street', city: 'Banha' },
};

test('g.3 COD: offered only where a provider and a cash-collecting supplier exist; confirmed at once; collected on delivery', async () => {
  const s = await startCoreServer();
  try {
    const quote = (await s.api('/api/quote', { method: 'POST', body: { country: 'EG', items: EG.items } })).body;
    assert.deepEqual(quote.paymentMethods, [{ method: 'card', provider: 'fakepay' }, { method: 'cod', provider: 'cod' }]);
    assert.deepEqual([quote.currency, quote.subtotal, quote.shipping, quote.total], ['EGP', 249900 + 2 * 110900, 0, 471700]); // over the free-shipping line
    assert.equal(quote.tax.amount, Math.round((471700 * 1400) / 11400));
    assert.deepEqual((await s.api('/api/quote', { method: 'POST', body: { country: 'ES', items: [EG.items[0]] } })).body.paymentMethods, [{ method: 'card', provider: 'fakepay' }]);
    const cfg = (await s.api('/api/config')).body;
    assert.deepEqual(cfg.countries.find((c) => c.code === 'EG'), { code: 'EG', region: 'EG', currency: 'EGP', methods: ['card', 'cod'] });
    assert.deepEqual(cfg.countries.find((c) => c.code === 'ES').methods, ['card']);

    const res = await placeOrder(s, EG);
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.payment, { kind: 'confirmed' });
    const order = await orderRow(s, res.body.orderId);
    const payment = await paymentOf(s, res.body.orderId);
    assert.deepEqual([order.status, order.payment_status, order.payment_method, order.payment_provider, payment.status, payment.provider_ref], ['processing', 'cod_due', 'cod', 'cod', 'cod_due', `cod_${res.body.orderId}`]);
    const [f] = await fulfilmentsOf(s, res.body.orderId);
    assert.deepEqual([f.supplier, f.status], ['printlet', 'submitted']);
    const sent = s.sup.printlet.calls.createOrder[0];
    assert.deepEqual(sent.cod, { amount: 471700, currency: 'EGP' }); // what the courier must collect = the order total
    assert.equal(sent.recipient.phone, '+201000000000');
    const mail = mails(s, 'order_confirmed');
    assert.equal(mail.length, 1);
    assert.ok(mail[0].html.includes('dir="rtl"')); // Arabic customer
    // repeats change nothing
    const again = await s.api('/api/checkout', { method: 'POST', body: res.request });
    assert.deepEqual([again.body.orderId, again.body.payment], [res.body.orderId, { kind: 'confirmed' }]);
    assert.equal(s.sup.printlet.calls.createOrder.length, 1);

    s.sup.printlet.ship(f.external_id);
    await deliverSupplier(s, 'printlet', f.external_id);
    assert.deepEqual([(await orderRow(s, res.body.orderId)).status, (await orderRow(s, res.body.orderId)).payment_status], ['shipped', 'cod_due']);
    s.sup.printlet.ship(f.external_id, { delivered: true });
    await deliverSupplier(s, 'printlet', f.external_id);
    const done = await orderRow(s, res.body.orderId);
    assert.deepEqual([done.status, done.payment_status, (await paymentOf(s, res.body.orderId)).status], ['delivered', 'cod_collected', 'cod_collected']);
    assert.equal(s.codPay.calls.refund.length + s.pay.calls.refund.length, 0);
  } finally { await s.close(); }
});

test('g.3 COD is not offered when the supplier cannot collect cash, and a COD order never moves to one that cannot', async () => {
  const s = await startCoreServer();
  try {
    // phone is required for COD
    const noPhone = await placeOrder(s, { ...EG, customer: { name: 'Test Person', email: 'buyer@example.test' }, expectedTotal: 471700 });
    assert.deepEqual([noPhone.status, noPhone.body.error.fields], [400, { 'customer.phone': 'required' }]);
    // the only supplier fails for good: no COD-capable candidate is left → manual, never a card-only supplier
    s.sup.printlet.failures.push(new ProviderError('PRINTLET_UNVERIFIED', 'unverified', { retryable: false }));
    const res = await placeOrder(s, EG);
    assert.deepEqual(res.body.payment, { kind: 'confirmed' });
    const [f] = await fulfilmentsOf(s, res.body.orderId);
    assert.deepEqual([f.supplier, f.status], ['manual', 'manual']);
    const order = await orderRow(s, res.body.orderId);
    assert.deepEqual([order.status, order.payment_status, order.needs_attention], ['confirmed', 'cod_due', 1]);
    // printlet loses its cash service: COD disappears from the quote and checkout refuses it
    s.sup.printlet.capabilities.cod = false;
    const quote = (await s.api('/api/quote', { method: 'POST', body: { country: 'EG', items: EG.items, paymentMethod: 'cod' } })).body;
    assert.deepEqual(quote.paymentMethods, [{ method: 'card', provider: 'fakepay' }]);
    assert.deepEqual(quote.unavailable, []); // still buyable by card
    const refused = await placeOrder(s, EG);
    assert.deepEqual([refused.status, refused.body.error.code], [422, 'PAYMENT_METHOD_UNAVAILABLE']);
  } finally { await s.close(); }
});
