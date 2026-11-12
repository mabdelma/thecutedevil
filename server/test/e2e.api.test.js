// API surface tests: config, order access, cron, admin, rate limits, headers. Owner: core. Contract: sections f and l.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './harness.js';
import { startCoreServer, paidOrder, placeOrder } from './core-fakes.js';

const basic = (user, pass) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });
const ADMIN = basic('admin', 'test-admin');

test('commerce off: config says so, quote and checkout answer 503, cron and admin answer 404, the site still serves', async () => {
  const s = await startTestServer({ COMMERCE_MODE: '', DATABASE_URL: '', CRON_SECRET: '', ADMIN_USER: '', ADMIN_PASS: '' });
  try {
    const cfg = await s.api('/api/config');
    assert.deepEqual(cfg.body, { enabled: false, mode: 'off', countries: [], currencies: [], defaultCountry: null, flags: { us: false, uk: false }, whatsappFallback: true });
    for (const path of ['/api/quote', '/api/checkout']) {
      const r = await s.api(path, { method: 'POST', body: { country: 'ES', items: [{ id: 'horns-down-cap', qty: 1, options: {} }] } });
      assert.deepEqual([r.status, r.body.error.code], [503, 'COMMERCE_OFF'], path);
    }
    assert.equal((await s.api('/api/cron/tick', { method: 'POST', headers: { Authorization: 'Bearer x' } })).status, 404);
    assert.equal((await s.api('/api/admin/orders', { headers: ADMIN })).status, 404);
    assert.equal((await s.api('/api/orders/TCD-260101-ABCD?token=' + 'a'.repeat(64))).status, 404);
    assert.equal((await s.api('/api/health')).body.ok, true);
    assert.equal((await s.api('/api/webhooks/stripe_es', { method: 'POST', body: '{}' })).status, 404);
  } finally { await s.close(); }
});

test('commerce stays off when a piece is missing: no provider, no supplier, no webhook routes, invalid catalogue', async () => {
  const none = { get: () => null, has: () => false, list: () => [], forDestination: () => [] };
  const cases = [
    { payments: none },
    { suppliers: none },
    { routers: undefined, payments: undefined, suppliers: undefined, env: { COMMERCE_MODE: 'mock' }, patch: (ctx) => { ctx.routersMissing = ['paymentWebhooks']; } },
    { patch: (ctx) => { ctx.catalogueCheck = { ok: false, errors: ['x'], warnings: [] }; } },
  ];
  for (const c of cases) {
    const s = await startCoreServer({ overrides: Object.fromEntries(Object.entries(c).filter(([k, v]) => ['payments', 'suppliers'].includes(k) && v)) });
    try {
      if (c.patch) { c.patch(s.ctx); s.ctx.configCache = null; }
      const cfg = (await s.api('/api/config')).body;
      assert.deepEqual([cfg.enabled, cfg.mode, cfg.countries], [false, 'off', []]);
      assert.equal((await s.api('/api/quote', { method: 'POST', body: { country: 'ES', items: [{ id: 'horns-down-cap', qty: 1, options: {} }] } })).status, 503);
    } finally { await s.close(); }
  }
});

test('GET /api/config: only markets that are switched on, payable and routable; flags open US and UK', async () => {
  const s = await startCoreServer();
  try {
    const cfg = (await s.api('/api/config')).body;
    assert.deepEqual([cfg.enabled, cfg.mode, cfg.defaultCountry, cfg.flags, cfg.whatsappFallback], [true, 'mock', 'ES', { us: false, uk: false }, true]);
    const codes = cfg.countries.map((c) => c.code);
    assert.equal(codes.filter((c) => !['CA', 'EG'].includes(c)).length, 27); // the EU
    assert.ok(codes.includes('CA') && codes.includes('EG'));
    for (const closed of ['US', 'GB', 'AE', 'SA', 'KW']) assert.ok(!codes.includes(closed), closed); // flags off; Gulf cells are unconfirmed
    assert.deepEqual(cfg.currencies, ['EUR', 'CAD', 'EGP']);
    assert.deepEqual(cfg.countries.find((c) => c.code === 'ES'), { code: 'ES', region: 'EU', currency: 'EUR', methods: ['card'] });
  } finally { await s.close(); }
  const open = await startCoreServer({ env: { ENABLE_US: '1', ENABLE_UK: '1' } });
  try {
    const cfg = (await open.api('/api/config')).body;
    assert.deepEqual(cfg.flags, { us: true, uk: true });
    assert.deepEqual(cfg.countries.find((c) => c.code === 'US'), { code: 'US', region: 'US', currency: 'USD', methods: ['card'] });
    assert.deepEqual(cfg.countries.find((c) => c.code === 'GB'), { code: 'GB', region: 'UK', currency: 'GBP', methods: ['card'] });
    const q = await open.api('/api/quote', { method: 'POST', body: { country: 'US', items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' } }] } });
    assert.deepEqual([q.body.currency, q.body.total, q.body.tax.included], ['USD', 8900 + 599, false]);
  } finally { await open.close(); }
});

test('order page: 404 NOT_FOUND for a wrong id and a wrong token alike; rate limited', async () => {
  const s = await startCoreServer();
  try {
    const { id, token } = await paidOrder(s);
    assert.equal((await s.api(`/api/orders/${id}?token=${token}`)).status, 200);
    const wrongToken = await s.api(`/api/orders/${id}?token=${'0'.repeat(64)}`);
    const wrongId = await s.api(`/api/orders/TCD-000000-AAAA?token=${token}`);
    assert.equal(wrongToken.status, 404);
    assert.deepEqual(wrongToken.body, wrongId.body);
    assert.deepEqual(wrongToken.body, { error: { code: 'NOT_FOUND', message: 'Order not found' } });
    for (const bad of [`/api/orders/${id}`, `/api/orders/${id}?token=`, `/api/orders/${id}?token=short`, `/api/orders/${id}?token[]=${token}`, `/api/orders/${encodeURIComponent("x' OR 1=1 --")}?token=${token}`]) {
      assert.deepEqual((await s.api(bad)).body, wrongId.body, bad);
    }
    s.ctx.limiter.reset();
    let last;
    for (let i = 0; i < 31; i += 1) last = await s.api(`/api/orders/${id}?token=${token}`);
    assert.deepEqual([last.status, last.body.error.code], [429, 'RATE_LIMITED']);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  } finally { await s.close(); }
});

test('rate limits: quote 60 a minute, checkout 10 per 10 minutes', async () => {
  const s = await startCoreServer();
  try {
    const body = { country: 'ES', items: [{ id: 'horns-down-cap', qty: 1, options: {} }] };
    const quotes = await Promise.all(Array.from({ length: 61 }, () => s.api('/api/quote', { method: 'POST', body })));
    assert.equal(quotes.filter((r) => r.status === 200).length, 60);
    assert.equal(quotes.filter((r) => r.status === 429).length, 1);
    let last;
    for (let i = 0; i < 11; i += 1) last = await s.api('/api/checkout', { method: 'POST', body: {} });
    assert.deepEqual([last.status, last.body.error.code], [429, 'RATE_LIMITED']);
    assert.equal((await s.api('/api/config')).status, 200); // other endpoints are not affected
  } finally { await s.close(); }
});

test('cron tick: bearer or ?secret=, constant answers, 401 otherwise, rate limited', async () => {
  const s = await startCoreServer();
  try {
    assert.equal((await s.api('/api/cron/tick', { method: 'POST' })).status, 401);
    assert.equal((await s.api('/api/cron/tick', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await s.api('/api/cron/tick?secret=wrong', { method: 'POST' })).status, 401);
    assert.equal((await s.api('/api/cron/tick', { headers: { Authorization: 'Bearer test-cron' } })).status, 404); // GET is not the endpoint
    const ok = await s.api('/api/cron/tick', { method: 'POST', headers: { Authorization: 'Bearer test-cron' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body).sort(), ['failed', 'ok', 'ran', 'remaining', 'tookMs']);
    assert.deepEqual([ok.body.ok, ok.body.failed, ok.body.remaining], [true, 0, 0]);
    assert.equal((await s.api('/api/cron/tick?secret=test-cron', { method: 'POST' })).status, 200);
    s.ctx.limiter.reset();
    const many = await Promise.all(Array.from({ length: 12 }, () => s.api('/api/cron/tick', { method: 'POST', headers: { Authorization: 'Bearer test-cron' } })));
    assert.equal(many.filter((r) => r.status === 200).length, 10);
    assert.equal(many.filter((r) => r.status === 429).length, 2);
    assert.equal((await s.db('jobs').where({ type: 'orders.expire' }).count({ n: '*' }).first()).n, 1); // repeated ticks, one job
  } finally { await s.close(); }
});

test('admin: Basic auth, read-only lists, no token hashes, lock-out after 5 wrong logins', async () => {
  const s = await startCoreServer();
  try {
    const a = await paidOrder(s);
    const b = await placeOrder(s);
    await s.db('orders').where({ public_id: b.body.orderId }).update({ needs_attention: true, attention_reason: 'TEST' });
    const unauth = await s.api('/api/admin/orders');
    assert.equal(unauth.status, 401);
    assert.ok(unauth.headers.get('www-authenticate').startsWith('Basic'));
    const list = await s.api('/api/admin/orders', { headers: ADMIN });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.orders.map((o) => o.publicId), [b.body.orderId, a.id]);
    assert.deepEqual([list.body.orders[1].status, list.body.orders[1].paymentStatus, list.body.orders[1].total, list.body.nextBefore], ['processing', 'paid', 8399, null]);
    assert.ok(!JSON.stringify(list.body).includes('token'));
    assert.deepEqual((await s.api('/api/admin/orders?status=processing', { headers: ADMIN })).body.orders.map((o) => o.publicId), [a.id]);
    assert.deepEqual((await s.api('/api/admin/orders?attention=1', { headers: ADMIN })).body.orders.map((o) => o.publicId), [b.body.orderId]);
    const page = (await s.api('/api/admin/orders?limit=1', { headers: ADMIN })).body;
    assert.deepEqual([page.orders.length, page.nextBefore], [1, page.orders[0].id]);
    assert.deepEqual((await s.api(`/api/admin/orders?limit=1&before=${page.nextBefore}`, { headers: ADMIN })).body.orders.map((o) => o.publicId), [a.id]);
    const detail = (await s.api(`/api/admin/orders/${a.id}`, { headers: ADMIN })).body;
    assert.deepEqual(Object.keys(detail).sort(), ['emails', 'events', 'fulfilments', 'items', 'order', 'payments', 'shipments']);
    assert.deepEqual([detail.order.publicId, detail.items.length, detail.payments[0].status, detail.fulfilments[0].supplier, detail.fulfilments[0].candidates, detail.emails[0].template], [a.id, 1, 'succeeded', 'gelato', ['gelato', 'printful', 'printify'], 'order_confirmed']);
    assert.ok(!('tokenHash' in detail.order) && !('checkoutId' in detail.order));
    assert.equal((await s.api('/api/admin/orders/TCD-000000-AAAA', { headers: ADMIN })).status, 404);
    assert.deepEqual((await s.api('/api/admin/jobs?status=dead', { headers: ADMIN })).body, { jobs: [] });
    assert.ok((await s.api('/api/admin/jobs?status=done', { headers: ADMIN })).body.jobs.length >= 2);
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await s.api(`/api/admin/orders/${a.id}`, { method, headers: ADMIN })).status, 404, method); // read-only
    // lock-out
    for (let i = 0; i < 5; i += 1) assert.equal((await s.api('/api/admin/orders', { headers: basic('admin', `guess${i}`) })).status, 401);
    const blocked = await s.api('/api/admin/orders', { headers: ADMIN });
    assert.deepEqual([blocked.status, blocked.body.error.code], [429, 'RATE_LIMITED']); // even the right password, for 15 minutes
    s.ctx.limiter.reset();
    assert.equal((await s.api('/api/admin/orders', { headers: basic('admin', '') })).status, 401);
    assert.equal((await s.api('/api/admin/orders', { headers: basic('', 'test-admin') })).status, 401);
    assert.equal((await s.api('/api/admin/orders', { headers: ADMIN })).status, 200);
  } finally { await s.close(); }
  const noAdmin = await startCoreServer({ env: { ADMIN_USER: '', ADMIN_PASS: '', CRON_SECRET: '' } });
  try {
    assert.equal((await noAdmin.api('/api/admin/orders', { headers: ADMIN })).status, 404);
    assert.equal((await noAdmin.api('/api/cron/tick', { method: 'POST', headers: { Authorization: 'Bearer ' } })).status, 404);
  } finally { await noAdmin.close(); }
});

test('headers and logs: nosniff, no framing, no-store on the API; log lines carry no personal data', async () => {
  const lines = [];
  const sink = { log: (l) => lines.push(l), info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const s = await startCoreServer({ overrides: { log: sink } });
  try {
    const res = await s.api('/api/config');
    assert.deepEqual([res.headers.get('x-content-type-options'), res.headers.get('x-frame-options'), res.headers.get('cache-control'), res.headers.get('x-powered-by')], ['nosniff', 'DENY', 'no-store', null]);
    const page = await fetch(`${s.url}/definitely-not-a-page`);
    assert.equal(page.status, 404);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const { id, token } = await paidOrder(s, { note: 'leave with the neighbour' });
    await s.api(`/api/orders/${id}?token=${token}`);
    await s.tick();
    const all = lines.join('\n');
    assert.ok(all.includes(id)); // ids are logged…
    for (const secret of ['buyer@example.test', '+34600000000', 'Calle Falsa', 'Test Person', '47001', token, 'neighbour', 'test-cron', 'test-admin']) assert.ok(!all.includes(secret), `log leaked ${secret}`); // …people are not
  } finally { await s.close(); }
});
