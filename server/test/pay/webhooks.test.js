// The payment webhook route: raw body, statuses, dedupe through webhook_events; the mock provider end to end. Owner: pay.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Stripe from 'stripe';
import { createDb, migrate } from '../../db.js';
import { loadPayments } from '../../payments/registry.js';
import { create as createMock, mockEvent, signMockBody, MOCK_SIGNATURE_HEADER } from '../../payments/mock.js';
import paymentWebhooks from '../../routes/webhooks-payment.js';
import mockPay from '../../routes/mock-pay.js';
import { AppError } from '../../lib/errors.js';
import { config, quiet, order, payment, serve, recordWebhookOnce, stripeStub, LIVE_ENV } from './helpers.js';
import { session, event } from '../fixtures/pay/stripe-events.js';
import { callback, EXPECTED_HMAC } from '../fixtures/pay/paymob-callback.js';

async function setup(env = {}, { handle, deps = {} } = {}) {
  const cfg = config(env);
  const db = createDb('sqlite::memory:');
  await migrate(db);
  const ctx = { config: cfg, db, log: quiet, payments: loadPayments(cfg, { log: quiet, ...deps }) };
  const handled = [];
  const seams = { recordWebhookOnce, handlePaymentEvent: async (c, id, e) => { handled.push({ id, e }); if (handle) await handle(id, e); } };
  const s = await serve(ctx, { webhooks: paymentWebhooks(ctx, seams), mockPay: mockPay(ctx) });
  const rows = () => db('webhook_events').orderBy('id');
  return { ...s, ctx, db, handled, rows, close: async () => { await s.close(); await db.destroy(); } };
}
const stripePost = (url, id, evt, secret) => {
  const payload = JSON.stringify(evt);
  return fetch(`${url}/api/webhooks/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }) }, body: payload });
};

test('webhook route: Stripe event over HTTP is verified on the raw body, handled once, and a duplicate does no work', async () => {
  const s = await setup();
  try {
    const evt = event('checkout.session.completed', session());
    const first = await stripePost(s.url, 'stripe_es', evt, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });
    assert.equal(s.handled.length, 1);
    assert.equal(s.handled[0].id, 'stripe_es');
    assert.equal(s.handled[0].e.type, 'payment.succeeded');
    const again = await stripePost(s.url, 'stripe_es', evt, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET); // a retry carries a new signature, same event id
    assert.equal(again.status, 200);
    assert.equal(s.handled.length, 1);
    const rows = await s.rows();
    assert.equal(rows.length, 1);
    assert.deepEqual({ source: rows[0].source, event_id: rows[0].event_id, type: rows[0].type, status: rows[0].status }, { source: 'pay:stripe_es', event_id: evt.id, type: 'payment.succeeded', status: 'processed' });
  } finally { await s.close(); }
});

test('webhook route: wrong account, tampering and unknown providers', async () => {
  const s = await setup();
  try {
    const evt = event('checkout.session.completed', session());
    const wrong = await stripePost(s.url, 'stripe_ae', evt, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET); // ES event sent to the AE endpoint
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error.code, 'WEBHOOK_SIGNATURE');
    const payload = JSON.stringify(evt);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET });
    const tampered = await fetch(`${s.url}/api/webhooks/stripe_es`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header }, body: payload.replace('8399', '1') });
    assert.equal(tampered.status, 400);
    const empty = await fetch(`${s.url}/api/webhooks/stripe_es`, { method: 'POST' });
    assert.equal(empty.status, 400);
    for (const id of ['nope', 'mock', 'saudi', 'cod']) assert.equal((await fetch(`${s.url}/api/webhooks/${id}`, { method: 'POST', body: '{}' })).status, 404, id);
    assert.equal(s.handled.length, 0);
    assert.equal((await s.rows()).length, 0);
  } finally { await s.close(); }
});

test('webhook route: the same event id on the two Stripe accounts is two events', async () => {
  const s = await setup();
  try {
    const evt = event('checkout.session.completed', session());
    assert.equal((await stripePost(s.url, 'stripe_es', evt, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET)).status, 200);
    assert.equal((await stripePost(s.url, 'stripe_ae', evt, LIVE_ENV.STRIPE_AE_WEBHOOK_SECRET)).status, 200);
    assert.deepEqual((await s.rows()).map((r) => r.source), ['pay:stripe_es', 'pay:stripe_ae']);
    assert.equal(s.handled.length, 2);
  } finally { await s.close(); }
});

test('webhook route: a failing handler answers 500, the row is failed, and the retry is processed', async () => {
  let fail = true;
  const s = await setup({}, { handle: async () => { if (fail) throw new Error('database is busy'); } });
  try {
    const evt = event('checkout.session.completed', session());
    const first = await stripePost(s.url, 'stripe_es', evt, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET);
    assert.equal(first.status, 500);
    assert.deepEqual(await first.json(), { error: { code: 'INTERNAL', message: 'Something went wrong' } }); // no internals leak
    assert.equal((await s.rows())[0].status, 'failed');
    fail = false;
    assert.equal((await stripePost(s.url, 'stripe_es', evt, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET)).status, 200);
    assert.equal(s.handled.length, 2);
    assert.equal((await s.rows())[0].status, 'processed');
    assert.equal((await stripePost(s.url, 'stripe_es', evt, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET)).status, 200);
    assert.equal(s.handled.length, 2);
  } finally { await s.close(); }
});

test('webhook route: ignored events are recorded as ignored; a provider outage while mapping answers 500', async () => {
  const stub = stripeStub({ list: () => { throw Object.assign(new Error('down'), { type: 'StripeConnectionError' }); } });
  const s = await setup({}, { deps: { stripeClients: { stripe_es: stub } } });
  try {
    assert.equal((await stripePost(s.url, 'stripe_es', event('customer.created', { id: 'cus_x' }), LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET)).status, 200);
    assert.equal((await s.rows())[0].status, 'ignored');
    const failed = event('payment_intent.payment_failed', { id: 'pi_1', amount: 1, currency: 'eur', metadata: { order_public_id: 'TCD-261112-AB2C' } });
    assert.equal((await stripePost(s.url, 'stripe_es', failed, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET)).status, 500);
    assert.equal((await s.rows()).length, 1);
  } finally { await s.close(); }
});

test('webhook route: Paymob callback with its HMAC in the query string; duplicate deduped', async () => {
  const s = await setup();
  try {
    const send = (hmac) => fetch(`${s.url}/api/webhooks/paymob?hmac=${hmac}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(callback()) });
    assert.equal((await send(EXPECTED_HMAC)).status, 200);
    assert.equal((await send(EXPECTED_HMAC)).status, 200);
    assert.equal(s.handled.length, 1);
    assert.deepEqual({ id: s.handled[0].id, type: s.handled[0].e.type, ref: s.handled[0].e.providerRef }, { id: 'paymob', type: 'payment.succeeded', ref: '217503754' });
    assert.equal((await send('00'.repeat(64))).status, 400);
    assert.deepEqual((await s.rows()).map((r) => [r.source, r.event_id]), [['pay:paymob', 'txn:192036465:paid']]);
  } finally { await s.close(); }
});

test('webhook route: refuses to verify when a JSON parser consumed the body first', async () => {
  const cfg = config();
  const ctx = { config: cfg, db: null, log: quiet, payments: loadPayments(cfg, { log: quiet }) };
  const app = express();
  app.use(express.json()); // the wrong order on purpose
  app.use('/api/webhooks', paymentWebhooks(ctx, { recordWebhookOnce: async () => true, handlePaymentEvent: async () => { throw new Error('must not run'); } }));
  const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  try {
    const res = await stripePost(`http://127.0.0.1:${server.address().port}`, 'stripe_es', event('checkout.session.completed', session()), LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET);
    assert.equal(res.status, 500);
  } finally { await new Promise((ok) => server.close(ok)); }
});

/* ---- mock provider ----------------------------------------------------------------------------- */

const MOCK = { COMMERCE_MODE: 'mock', PUBLIC_BASE_URL: 'https://shop.example' };
const mockUrls = { success: 'https://shop.example/order?id=TCD-261112-AB2C&token=t&paid=1', cancel: 'https://shop.example/checkout?cancelled=TCD-261112-AB2C' };
const checkout = (s, over = {}) => s.ctx.payments.get('mock').createCheckout({ order: order(), items: [], shipping: { amount: 0 }, payment: payment(over), urls: mockUrls });
const press = (s, url, outcome) => fetch(s.url + url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `outcome=${outcome}` });

test('mock: created only in mock mode; cod confirms at once; refund succeeds; signature checked', async () => {
  assert.equal(createMock(config(), {}), null);
  const mock = createMock(config(MOCK), { now: () => 5 });
  assert.deepEqual(await mock.createCheckout({ order: order(), payment: payment({ method: 'cod' }), urls: mockUrls }).then((r) => r.kind), 'confirmed');
  const a = await mock.createCheckout({ order: order(), payment: payment(), urls: mockUrls });
  const b = await mock.createCheckout({ order: order(), payment: payment(), urls: mockUrls });
  assert.equal(a.url, b.url); // same idemKey → same session
  assert.equal(a.expiresAt, 5 + 31 * 60 * 1000);
  assert.match(a.url, /^\/api\/mock\/pay\/7\?/);
  const r1 = await mock.refund({ payment: {}, amount: 100, reason: '', idempotencyKey: 'refund:7:100' });
  assert.deepEqual(r1, await mock.refund({ payment: {}, amount: 100, reason: '', idempotencyKey: 'refund:7:100' }));
  assert.equal(r1.status, 'succeeded');
  const body = Buffer.from(JSON.stringify(mockEvent({ providerRef: a.providerRef, outcome: 'pay', amount: 8399, currency: 'EUR', occurredAt: 9 })));
  await assert.rejects(mock.parseWebhook({ rawBody: body, headers: { [MOCK_SIGNATURE_HEADER]: 'ab'.repeat(32) }, query: {} }), (e) => e instanceof AppError && e.code === 'WEBHOOK_SIGNATURE');
  await assert.rejects(mock.parseWebhook({ rawBody: body, headers: {}, query: {} }), (e) => e.code === 'WEBHOOK_SIGNATURE');
  const [evt] = await mock.parseWebhook({ rawBody: body, headers: { [MOCK_SIGNATURE_HEADER]: signMockBody(body) }, query: {} });
  assert.deepEqual(evt, { eventId: `mockevt_${a.providerRef}_payment.succeeded`, type: 'payment.succeeded', providerRef: a.providerRef, providerPaymentRef: `mockpay_${a.providerRef}`, amount: 8399, currency: 'EUR', occurredAt: 9 });
});

test('mock end to end: pay page → "pay" → signed webhook on the same route → payment.succeeded → browser sent to the success URL', async () => {
  const s = await setup(MOCK);
  try {
    const out = await checkout(s);
    assert.equal(out.kind, 'redirect');
    assert.equal((await s.ctx.payments.get('mock').getPayment(out.providerRef)).status, 'pending');
    const page = await fetch(s.url + out.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="mock-pay"/);
    assert.match(html, /id="mock-fail"/);
    assert.match(html, /83\.99 EUR/);
    assert.match(html, /TCD-261112-AB2C/);
    assert.doesNotMatch(html, /<script/i);

    const res = await press(s, out.url, 'pay');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), mockUrls.success);
    assert.equal(s.handled.length, 1);
    assert.deepEqual({ id: s.handled[0].id, type: s.handled[0].e.type, ref: s.handled[0].e.providerRef, amount: s.handled[0].e.amount, currency: s.handled[0].e.currency }, { id: 'mock', type: 'payment.succeeded', ref: out.providerRef, amount: 8399, currency: 'EUR' });
    const rows = await s.rows();
    assert.deepEqual(rows.map((r) => [r.source, r.status]), [['pay:mock', 'processed']]);
    assert.deepEqual(await s.ctx.payments.get('mock').getPayment(out.providerRef), { status: 'succeeded', providerPaymentRef: `mockpay_${out.providerRef}`, amount: 8399, currency: 'EUR' });

    assert.equal((await press(s, out.url, 'pay')).status, 303); // double click: deduped
    assert.equal(s.handled.length, 1);
  } finally { await s.close(); }
});

test('mock end to end: "fail" delivers payment.failed and returns to the cancel URL', async () => {
  const s = await setup(MOCK);
  try {
    const out = await checkout(s, { id: 8, idemKey: 'checkout:8:1' });
    const res = await press(s, out.url, 'fail');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), mockUrls.cancel);
    assert.equal(s.handled[0].e.type, 'payment.failed');
    assert.equal((await s.ctx.payments.get('mock').getPayment(out.providerRef)).status, 'failed');
  } finally { await s.close(); }
});

test('mock pay page: forged links, foreign return URLs, a failing webhook and non-mock mode', async () => {
  const s = await setup(MOCK, { handle: async (id, e) => { if (e.providerRef.endsWith('boom')) throw new Error('x'); } });
  try {
    const out = await checkout(s);
    assert.equal((await fetch(s.url + out.url.replace('amount=8399', 'amount=1'))).status, 400); // amount is signed
    assert.equal((await press(s, out.url.replace(/sig=[0-9a-f]+/, 'sig=00'), 'pay')).status, 400);
    assert.equal((await fetch(s.url + out.url.replace('/pay/7?', '/pay/8?'))).status, 400);
    assert.equal(s.handled.length, 0);
    const away = await s.ctx.payments.get('mock').createCheckout({ order: order(), payment: payment({ id: 9, idemKey: 'checkout:9:1' }), urls: { success: 'https://evil.example/x', cancel: '//evil.example' } });
    assert.equal((await press(s, away.url, 'pay')).headers.get('location'), '/');
    assert.equal((await press(s, away.url, 'fail')).headers.get('location'), '/');
  } finally { await s.close(); }
  const live = await setup(); // live mode: the page does not exist
  try {
    assert.equal((await fetch(`${live.url}/api/mock/pay/7?id=7`)).status, 404);
  } finally { await live.close(); }
});
