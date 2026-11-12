// mock and manual suppliers, registry, mapping file, region helpers, and the supplier webhook route. Owner: sup.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { create as createMock, signMockWebhook } from '../../suppliers/mock.js';
import { create as createManual } from '../../suppliers/manual.js';
import { loadSuppliers } from '../../suppliers/registry.js';
import { assertSupplierAdapter } from '../../suppliers/interface.js';
import { regionOf, countriesOf, EU_COUNTRIES } from '../../suppliers/regions.js';
import { mapping, mappingEntry, placeholders } from '../../catalogue/mapping.js';
import { catalogue } from '../../catalogue/products.js';
import { listCatalogue } from '../../suppliers/tools/list-catalogue.js';
import supplierWebhooks from '../../routes/webhooks-supplier.js';
import { AppError } from '../../lib/errors.js';
import { config, dest, fakeClock, fakeFetch, fulfilment, line, raw } from './helpers.js';

const mockCfg = (env = {}) => config({ COMMERCE_MODE: 'mock', ...env });

test('registry: nothing when off; mock + manual in mock mode; only configured real adapters load', () => {
  assert.deepEqual(loadSuppliers(config({ COMMERCE_MODE: 'off' })).list(), []);
  assert.deepEqual(loadSuppliers(mockCfg()).list().map((a) => a.id), ['mock', 'manual']);
  assert.deepEqual(loadSuppliers(config({})).list().map((a) => a.id), ['manual']); // live, no supplier keys
  const some = loadSuppliers(config({ PRINTFUL_API_KEY: 'k', PRINTFUL_WEBHOOK_SECRET: 's', GELATO_API_KEY: 'g', PRINTIFY_API_TOKEN: 'half-configured' }));
  assert.deepEqual(some.list().map((a) => a.id), ['printful', 'manual']);
  assert.equal(some.has('printful'), true); assert.equal(some.has('gelato'), false); assert.equal(some.get('mock'), null);
  const all = loadSuppliers(config({ PRINTFUL_API_KEY: 'k', PRINTFUL_WEBHOOK_SECRET: 's', PRINTIFY_API_TOKEN: 't', PRINTIFY_SHOP_ID: '1', PRINTIFY_WEBHOOK_SECRET: 's', GELATO_API_KEY: 'g', GELATO_WEBHOOK_SECRET: 's', PRINTLET_API_KEY: 'p', PRINTLET_BASE_URL: 'https://x.example', PRINTLET_WEBHOOK_SECRET: 's' }));
  assert.deepEqual(all.list().map((a) => a.id), ['printful', 'printify', 'gelato', 'printlet', 'manual']);
  for (const a of all.list()) assertSupplierAdapter(a);
});

test('manual: always available, zero quote, parks the order and returns a reference', async () => {
  const manual = createManual(mockCfg());
  assert.equal(createManual(config({ COMMERCE_MODE: 'off' })), null);
  assert.equal(await manual.isAvailable(line('mock', { mapping: null }), dest('EG', 'EG')), true);
  assert.deepEqual(await manual.quote([line('mock', { mapping: null })], dest()), { supplier: 'manual', currency: 'EUR', itemsCost: 0, shippingCost: 0, total: 0, minDays: 7, maxDays: 14, shippingMethod: 'manual', source: 'table' });
  assert.deepEqual(await manual.createOrder(fulfilment([line('mock')])), { supplierOrderRef: 'TCD-261112-AB2C-F1-0', status: 'submitted' });
  assert.deepEqual(await manual.parseWebhook({ rawBody: raw('{}'), headers: {}, query: {} }), []);
  assert.equal(manual.capabilities.cod, false);
  assert.equal((await manual.cancel({ externalId: 'x' })).cancelled, true);
});

test('mock: only in mock mode; deterministic quote; FAIL and REJECT', async () => {
  assert.equal(createMock(config({})), null);
  const mock = createMock(mockCfg(), fakeClock());
  const q1 = await mock.quote([line('mock', { qty: 2 })], dest()); const q2 = await mock.quote([line('mock', { qty: 2 })], dest());
  assert.deepEqual(q1, q2);
  assert.deepEqual(q1, { supplier: 'mock', currency: 'EUR', itemsCost: 2400, shippingCost: 500, total: 2900, minDays: 3, maxDays: 7, shippingMethod: 'mock-standard', source: 'table' });
  assert.equal(await mock.isAvailable(line('mock'), dest()), true);
  assert.equal(await mock.isAvailable(line('mock', { mapping: null }), dest()), false);
  await assert.rejects(mock.createOrder(fulfilment([line('mock', { personalisation: { name: 'FAIL' } })])), (e) => e.retryable === true);
  await assert.rejects(mock.createOrder(fulfilment([line('mock', { personalisation: { name: 'REJECT' } })])), (e) => e.retryable === false);
  assert.equal(await mock.getOrder({ externalId: 'TCD-261112-AB2C-F1-0' }), null);
});

test('mock journey: create (idempotent) → ship → tracking MOCK123 → deliver; cancel refused after shipping', async () => {
  const mock = createMock(mockCfg(), fakeClock());
  const f = fulfilment([line('mock')]);
  const a = await mock.createOrder(f); const b = await mock.createOrder(f);
  assert.equal(a.supplierOrderRef, 'MOCK-TCD-261112-AB2C-F1-0'); assert.equal(b.supplierOrderRef, a.supplierOrderRef);
  assert.equal(mock.orders().length, 1);
  assert.equal((await mock.getOrder({ externalId: f.externalId })).status, 'submitted');
  assert.equal(mock.ship(f.externalId), true);
  const shipped = await mock.getOrder({ supplierOrderRef: a.supplierOrderRef });
  assert.equal(shipped.status, 'shipped'); assert.equal(shipped.shipments[0].trackingNumber, 'MOCK123');
  assert.deepEqual(await mock.cancel({ externalId: f.externalId }), { cancelled: false, reason: 'already shipped' });
  mock.deliver(f.externalId);
  const done = await mock.getOrder({ externalId: f.externalId });
  assert.equal(done.status, 'delivered'); assert.ok(done.shipments[0].deliveredAt);
  const other = fulfilment([line('mock')], { externalId: 'TCD-261112-AB2C-F2-0' });
  await mock.createOrder(other);
  assert.deepEqual(await mock.cancel({ externalId: other.externalId }), { cancelled: true });
  assert.equal(mock.ship(other.externalId), false);
});

/** The real router behind express.raw, with in-memory stand-ins for core's two functions. */
async function routeServer(suppliers, { failHandler = false } = {}) {
  const seen = new Set(); const handled = [];
  const ctx = { suppliers, log: { error() {} }, db: null };
  const app = express();
  app.use('/api/webhooks/supplier', express.raw({ type: () => true, limit: '1mb' }), supplierWebhooks(ctx, {
    recordWebhookOnce: async (c, e) => { const k = `${e.source}|${e.eventId}`; if (seen.has(k)) return false; seen.add(k); return true; },
    handleSupplierEvent: async (c, id, event) => { if (failHandler) { seen.clear(); throw new Error('boom'); } handled.push({ id, event, state: await suppliers.get(id).getOrder(event) }); },
  }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err instanceof AppError ? err.status : 500).json({ error: { code: err instanceof AppError ? err.code : 'INTERNAL' } }));
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/webhooks/supplier`;
  const post = async (path, body, headers = {}) => { const res = await fetch(url + path, { method: 'POST', body, headers }); return { status: res.status, body: await res.json() }; };
  return { post, handled, close: () => new Promise((ok) => server.close(ok)) };
}

test('webhook route + mock: an order is advanced to shipped through POST /api/webhooks/supplier/mock; duplicates are dropped', async () => {
  const suppliers = loadSuppliers(mockCfg());
  const mock = suppliers.get('mock');
  const f = fulfilment([line('mock')]);
  await mock.createOrder(f);
  const s = await routeServer(suppliers);
  try {
    const body = JSON.stringify({ id: 'evt-1', action: 'ship', externalId: f.externalId });
    assert.deepEqual(await s.post('/mock', body, { 'x-mock-signature': signMockWebhook(Buffer.from(body)) }), { status: 200, body: { ok: true } });
    assert.equal(s.handled.length, 1);
    assert.deepEqual(s.handled[0].event, { eventId: 'evt-1', type: 'order.updated', externalId: f.externalId, supplierOrderRef: 'MOCK-TCD-261112-AB2C-F1-0' });
    assert.equal(s.handled[0].state.status, 'shipped'); assert.equal(s.handled[0].state.shipments[0].trackingNumber, 'MOCK123');
    assert.equal((await s.post('/mock?key=mock', body)).status, 200); // same event id again
    assert.equal(s.handled.length, 1);
    assert.equal((await s.post('/mock?key=mock', JSON.stringify({ id: 'evt-2', action: 'deliver', externalId: f.externalId }))).status, 200);
    assert.equal(s.handled[1].state.status, 'delivered');
    const bad = await s.post('/mock', body, { 'x-mock-signature': 'nope' });
    assert.deepEqual(bad, { status: 400, body: { error: { code: 'WEBHOOK_SIGNATURE' } } });
    assert.equal((await s.post('/nobody?key=mock', body)).status, 404);
    assert.equal((await s.post('/manual', body)).status, 200); // manual has no webhooks: nothing to do
    assert.equal(s.handled.length, 2);
  } finally { await s.close(); }
});

test('webhook route: a handler error answers 500 so the supplier retries', async () => {
  const suppliers = loadSuppliers(mockCfg());
  await suppliers.get('mock').createOrder(fulfilment([line('mock')]));
  const s = await routeServer(suppliers, { failHandler: true });
  try {
    const res = await s.post('/mock?key=mock', JSON.stringify({ id: 'evt-9', action: 'ship', externalId: 'TCD-261112-AB2C-F1-0' }));
    assert.equal(res.status, 500);
  } finally { await s.close(); }
});

test('regions: country → region', () => {
  assert.equal(EU_COUNTRIES.length, 27);
  assert.deepEqual(['ES', 'gb', 'CA', 'US', 'AE', 'SA', 'OM', 'EG', 'CH', ''].map(regionOf), ['EU', 'UK', 'CA', 'US', 'AE', 'GCC', 'GCC', 'EG', null, null]);
  assert.deepEqual(countriesOf('GCC'), ['SA', 'KW', 'QA', 'BH', 'OM']);
  assert.deepEqual(countriesOf('UK'), ['GB']);
});

test('mapping: contract shape, every wearable variant covered, all refs still marked PLACEHOLDER and therefore unsellable', async () => {
  const wearables = catalogue.filter((p) => p.sellable);
  assert.ok(wearables.length >= 4);
  const key = (p, combo) => (p.options.length ? p.options.map((o, i) => `${o.name}=${combo[i]}`).join('|') : 'default');
  for (const p of wearables) {
    const combos = p.options.reduce((acc, o) => acc.flatMap((c) => o.values.map((v) => [...c, v])), [[]]);
    for (const combo of combos) {
      const entries = mapping[p.id] && (mapping[p.id][key(p, combo)] || mapping[p.id]['*']);
      assert.ok(Array.isArray(entries) && entries.length > 0, `${p.id} ${key(p, combo)}`);
      for (const e of entries) {
        assert.ok(['printful', 'printify', 'gelato', 'printlet'].includes(e.supplier));
        assert.ok(typeof e.productRef === 'string' && typeof e.variantRef === 'string' && Array.isArray(e.regions) && e.regions.length > 0);
        assert.ok(Number.isInteger(e.cost.amount) && e.days.length === 2);
      }
    }
  }
  assert.equal(mappingEntry('horns-down-cap', 'default', 'printful').supplier, 'printful');
  assert.equal(mappingEntry('two-sides-socks', 'size=36-40', 'gelato'), null);
  assert.equal(mappingEntry('nope', 'default', 'printful'), null);
  assert.ok(placeholders().length > 0);
  const suppliers = loadSuppliers(config({ PRINTFUL_API_KEY: 'k', PRINTFUL_WEBHOOK_SECRET: 's' }));
  const l = { ...line('printful'), mapping: mappingEntry('halos-off-hoodie', 'size=M', 'printful') };
  assert.equal(await suppliers.get('printful').isAvailable(l, dest()), false);
});

test('list-catalogue script: prints mapping-ready ids from the documented endpoints, never the key', async () => {
  const fetch = fakeFetch((c) => (c.path.endsWith('/products.json') ? { body: { current_page: 1, data: [{ id: '5d39b159e7c48c000728c89f', title: 'Tee', variants: [{ id: 17887, sku: 'A', title: 'M', cost: 516, is_enabled: true }, { id: 17888, sku: 'B', title: 'L', cost: 516, is_enabled: false }] }], next_page_url: null } } : { status: 404 }));
  const out = await listCatalogue('printify', undefined, config({ PRINTIFY_API_TOKEN: 'tok-secret', PRINTIFY_SHOP_ID: '9', PRINTIFY_WEBHOOK_SECRET: 'x' }), { fetch, ...fakeClock() });
  assert.deepEqual(out, ["productRef '5d39b159e7c48c000728c89f': Tee", "  variantRef '17887'  M  sku A  cost 516"]);
  assert.ok(!out.join('\n').includes('tok-secret'));
  await assert.rejects(listCatalogue('printful', undefined, config({}), {}), /env vars are not set/);
  await assert.rejects(listCatalogue('nope', undefined, config({}), {}), /usage/);
});
