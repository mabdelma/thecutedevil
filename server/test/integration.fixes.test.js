// Integration fixes (see "Integration notes" in web/COMMERCE_ARCH.md): the order-status link in customer e-mails,
// the shipping option priced by POST /api/quote, and per-refund amounts counted once each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutBody, deliverPayment, mails, orderRow, paidOrder, paymentOf, startCoreServer } from './core-fakes.js';
import { loadConfig } from '../config.js';
import { orderLinkToken } from '../lib/ids.js';

test('e-mail status link: present in customer e-mails, opens the order, is never stored, and dies with a wrong key', async () => {
  const s = await startCoreServer();
  try {
    const order = await paidOrder(s);
    await s.tick();
    const mail = mails(s, 'order_confirmed')[0];
    const link = /\/order\?id=([A-Z0-9-]+)&token=([0-9a-f]{64})/.exec(mail.text);
    assert.ok(link, 'the confirmation e-mail carries the status link');
    assert.ok(mail.html.includes(`/order?id=${order.id}&amp;token=${link[2]}`));
    assert.equal(link[1], order.id);
    assert.notEqual(link[2], order.token, 'the e-mail link has its own token');
    assert.equal((await s.api(`/api/orders/${order.id}?token=${link[2]}`)).status, 200);
    assert.equal((await s.api(`/api/orders/${order.id}?token=${order.token}`)).status, 200);
    const wrong = orderLinkToken('another-key-another-key-another-key', order.id, (await orderRow(s, order.id)).token_hash);
    assert.equal((await s.api(`/api/orders/${order.id}?token=${wrong}`)).status, 404);
    // nothing that opens the page is in the database
    const dump = JSON.stringify([await s.db('orders'), await s.db('email_log'), await s.db('jobs'), await s.db('order_events')]);
    assert.ok(!dump.includes(link[2]) && !dump.includes(order.token));
  } finally { await s.close(); }
});

test('e-mail status link: needs ORDER_LINK_SECRET (32+ characters) outside mock mode', () => {
  const live = { COMMERCE_MODE: 'live', DATABASE_URL: 'sqlite::memory:', PUBLIC_BASE_URL: 'https://example.com' };
  assert.equal(loadConfig(live).orderLinkSecret, '');
  assert.equal(loadConfig({ ...live, ORDER_LINK_SECRET: 'short' }).orderLinkSecret, '');
  assert.equal(loadConfig({ ...live, ORDER_LINK_SECRET: 'x'.repeat(32) }).orderLinkSecret, 'x'.repeat(32));
  assert.ok(loadConfig({ COMMERCE_MODE: 'mock' }).orderLinkSecret.length >= 32);
  assert.equal(loadConfig({}).orderLinkSecret, '');
});

test('quote: the chosen shipping option is an input, and the answer says which option the total is for', async () => {
  const rates = { EU: { EUR: { base: 499, perExtraItem: 150, freeFrom: 9000 } } };
  const s = await startCoreServer({ overrides: { shippingRates: rates } });
  try {
    const { items, country } = checkoutBody();
    const plain = (await s.api('/api/quote', { method: 'POST', body: { country, items } })).body;
    assert.equal(plain.shippingOption, 'standard');
    assert.equal(plain.total, plain.subtotal + plain.shipping);
    const chosen = (await s.api('/api/quote', { method: 'POST', body: { country, items, shippingOption: 'standard' } })).body;
    assert.deepEqual([chosen.shippingOption, chosen.total], ['standard', plain.total]);
    // an option the server does not have is not an error at quote time: the first one is priced and named…
    const unknown = (await s.api('/api/quote', { method: 'POST', body: { country, items, shippingOption: 'teleport' } })).body;
    assert.deepEqual([unknown.shippingOption, unknown.total], ['standard', plain.total]);
    // …but checkout refuses it, and refuses a total that is not the server's
    const bad = await s.api('/api/checkout', { method: 'POST', body: checkoutBody({ shippingOption: 'teleport', expectedTotal: plain.total }) });
    assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.fields], [400, 'VALIDATION', { shippingOption: 'unknown' }]);
    const off = await s.api('/api/checkout', { method: 'POST', body: checkoutBody({ expectedTotal: plain.total - 1 }) });
    assert.deepEqual([off.status, off.body.error.code, off.body.quote.total, off.body.quote.shippingOption], [409, 'PRICE_CHANGED', plain.total, 'standard']);
  } finally { await s.close(); }
});

test('refunds without a running total: separate refunds add up, each refund id counts once', async () => {
  const s = await startCoreServer();
  try {
    const live = await paidOrder(s);
    const amount = (await paymentOf(s, live.id)).amount;
    await deliverPayment(s, live.id, 'refund.succeeded', { amount: 1000, refundRef: 'r1' });
    await deliverPayment(s, live.id, 'refund.succeeded', { amount: 1000, refundRef: 'r1' }); // the same refund, told twice
    assert.equal((await paymentOf(s, live.id)).refunded_amount, 1000);
    await deliverPayment(s, live.id, 'refund.succeeded', { amount: 2000, refundRef: 'r2' }); // a second, different refund
    let p = await paymentOf(s, live.id);
    assert.deepEqual([p.status, p.refunded_amount], ['partially_refunded', 3000]);
    await deliverPayment(s, live.id, 'refund.succeeded', { amount: amount - 3000, refundRef: 'r3' });
    p = await paymentOf(s, live.id);
    assert.deepEqual([p.status, p.refunded_amount, (await orderRow(s, live.id)).payment_status], ['refunded', amount, 'refunded']);
    // never past the payment amount
    await deliverPayment(s, live.id, 'refund.succeeded', { amount: 500, refundRef: 'r4' });
    assert.equal((await paymentOf(s, live.id)).refunded_amount, amount);
  } finally { await s.close(); }
});
