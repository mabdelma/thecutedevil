// The whole journey over HTTP in mock mode with the REAL registries (mock payment provider from `pay`, mock
// supplier from `sup`): checkout → mock pay page → signed webhook → supplier order → supplier webhook → shipped.
// Owner: core. Skipped (not failed) while the other roles' mock modules are not there yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './harness.js';
import { checkoutBody } from './core-fakes.js';

const form = (fields) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), redirect: 'manual' });
const absolute = (s, url) => (url.startsWith('/') ? s.url + url : url.replace(/^https?:\/\/[^/]+/, s.url));
const tick = (s) => { s.ctx.limiter.reset(); return s.api('/api/cron/tick', { method: 'POST', headers: { Authorization: 'Bearer test-cron' } }); };

async function ready(t, s) {
  const missing = [!s.ctx.payments.get('mock') && 'payments/mock', !s.ctx.suppliers.get('mock') && 'suppliers/mock', ...(s.ctx.routersMissing || [])].filter(Boolean);
  if (missing.length) { t.skip(`waiting for other roles: ${missing.join(', ')}`); return false; }
  return true;
}

async function checkoutAndPay(s, overrides = {}, outcome = 'pay') {
  const body = checkoutBody(overrides);
  const quote = await s.api('/api/quote', { method: 'POST', body: { country: body.country, items: body.items } });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  const res = await s.api('/api/checkout', { method: 'POST', body: { ...body, expectedTotal: quote.body.total } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.payment.kind, 'redirect');
  const payPage = absolute(s, res.body.payment.url);
  const shown = await fetch(payPage);
  assert.equal(shown.status, 200);
  const paid = await fetch(payPage, form({ outcome }));
  assert.equal(paid.status, 303);
  return { ...res.body, location: paid.headers.get('location'), body };
}

test('mock mode end to end: add to bag → checkout → mock pay → status page → shipped', async (t) => {
  const s = await startTestServer();
  try {
    if (!(await ready(t, s))) return;
    const cfg = (await s.api('/api/config')).body;
    assert.deepEqual([cfg.enabled, cfg.mode], [true, 'mock']);
    assert.ok(cfg.countries.some((c) => c.code === 'ES'));

    const order = await checkoutAndPay(s, { lang: 'ar' });
    assert.ok(order.location.includes(`id=${order.orderId}`) && order.location.includes('paid=1')); // back to the status page
    const view = async () => (await s.api(`/api/orders/${order.orderId}?token=${order.token}`)).body;
    let v = await view();
    assert.deepEqual([v.status, v.paymentStatus, v.fulfilments.length, v.fulfilments[0].status], ['processing', 'paid', 1, 'submitted']);
    assert.equal(s.ctx.outbox.filter((m) => m.template === 'order_confirmed').length, 1);
    assert.ok(s.ctx.outbox[0].html.includes('dir="rtl"'));

    // paying the same link again (double click, browser back) is harmless
    const again = await fetch(absolute(s, order.payment.url), form({ outcome: 'pay' }));
    assert.ok([303, 400, 409].includes(again.status));
    await tick(s);
    assert.equal((await s.db('fulfilments').count({ n: '*' }).first()).n, 1);
    assert.equal(s.ctx.outbox.filter((m) => m.template === 'order_confirmed').length, 1);

    // the supplier ships: its webhook is only a signal, core reads the real state
    const f = await s.db('fulfilments').first();
    assert.deepEqual([f.supplier, f.external_id], ['mock', `${order.orderId}-F1-0`]);
    const hook = JSON.stringify({ id: 'evt-ship-1', action: 'ship', externalId: f.external_id });
    const shipped = await s.api('/api/webhooks/supplier/mock?key=mock', { method: 'POST', body: hook, headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual([shipped.status, shipped.body], [200, { ok: true }]);
    assert.equal((await s.api('/api/webhooks/supplier/mock?key=mock', { method: 'POST', body: hook, headers: { 'Content-Type': 'application/json' } })).status, 200); // duplicate delivery
    assert.equal((await s.api('/api/webhooks/supplier/mock?key=wrong', { method: 'POST', body: hook, headers: { 'Content-Type': 'application/json' } })).status, 400);
    await tick(s);
    v = await view();
    assert.deepEqual([v.status, v.fulfilments[0].status, v.fulfilments[0].shipments.length, v.fulfilments[0].shipments[0].trackingNumber], ['shipped', 'shipped', 1, 'MOCK123']);
    const mail = s.ctx.outbox.filter((m) => m.template === 'shipped');
    assert.equal(mail.length, 1);
    assert.ok(mail[0].text.includes('MOCK123'));
  } finally { await s.close(); }
});

test('mock mode: a declined payment leaves the order unpaid; a bad webhook signature is refused', async (t) => {
  const s = await startTestServer();
  try {
    if (!(await ready(t, s))) return;
    const order = await checkoutAndPay(s, {}, 'fail');
    assert.ok(order.location.includes(`cancelled=${order.orderId}`));
    const row = await s.db('orders').where({ public_id: order.orderId }).first();
    assert.deepEqual([row.status, row.payment_status], ['pending_payment', 'unpaid']);
    assert.equal((await s.db('fulfilments').count({ n: '*' }).first()).n, 0);
    const forged = await s.api('/api/webhooks/mock', { method: 'POST', body: JSON.stringify({ type: 'payment.succeeded' }), headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual([forged.status, forged.body.error.code], [400, 'WEBHOOK_SIGNATURE']);
    assert.equal((await s.api('/api/webhooks/nope', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await s.db('orders').where({ public_id: order.orderId }).first()).status, 'pending_payment');
  } finally { await s.close(); }
});

test('mock mode: the mock supplier fails (FAIL = retry, REJECT = refuse) → retries, then a person', async (t) => {
  const s = await startTestServer();
  try {
    if (!(await ready(t, s))) return;
    let clock = Date.now();
    s.ctx.now = () => clock;
    const items = (name) => [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' }, personalisation: { name } }];
    const rejected = await checkoutAndPay(s, { items: items('REJECT') });
    await tick(s);
    let f = await s.db('fulfilments').where({ external_id: `${rejected.orderId}-F1-0` }).first();
    let o = await s.db('orders').where({ public_id: rejected.orderId }).first();
    assert.deepEqual([f.status, f.supplier, o.status, o.payment_status, o.needs_attention], ['manual', 'manual', 'confirmed', 'paid', 1]);

    const flaky = await checkoutAndPay(s, { items: items('FAIL') });
    f = await s.db('fulfilments').where({ external_id: `${flaky.orderId}-F1-0` }).first();
    assert.deepEqual([f.status, f.submit_attempts], ['pending', 1]);
    for (const minutes of [1, 5, 15]) { clock += minutes * 60 * 1000; await tick(s); }
    f = await s.db('fulfilments').where({ id: f.id }).first();
    o = await s.db('orders').where({ public_id: flaky.orderId }).first();
    assert.deepEqual([f.status, o.needs_attention, o.attention_reason], ['manual', 1, 'NO_SUPPLIER_LEFT']);
  } finally { await s.close(); }
});
