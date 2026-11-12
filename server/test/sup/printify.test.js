// Printify adapter against documented shapes (https://developers.printify.com/openapi.json). Owner: sup. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, mapStatus } from '../../suppliers/printify.js';
import { ProviderError } from '../../lib/errors.js';
import { hmacSha256Hex } from '../../suppliers/util.js';
import * as fx from '../fixtures/sup/fixtures.js';
import { config, dest, fakeClock, fakeFetch, fulfilment, line, raw } from './helpers.js';

const ENV = { PRINTIFY_API_TOKEN: 'pfy-token', PRINTIFY_SHOP_ID: '815256', PRINTIFY_WEBHOOK_SECRET: 'whsec' };
const make = (handler, cfg = config(ENV)) => { const fetch = fakeFetch(handler); return { adapter: create(cfg, { fetch, ...fakeClock() }), fetch }; };
const SHOP = '/v1/shops/815256';
const ID = '5a96f649b2439217d070f507';
const sign = (body) => `sha256=${hmacSha256Hex('whsec', body)}`;

test('printify: null unless token, shop and webhook secret are all set', () => {
  assert.equal(create(config({ PRINTIFY_API_TOKEN: 'x' }), {}), null);
  assert.ok(create(config(ENV), {}));
});

test('printify: createOrder orders an existing product/variant, then sends it to production (live)', async () => {
  const { adapter, fetch } = make((c) => (c.path.endsWith('/orders.json') ? { body: { id: ID } } : { status: 202, body: { id: ID } }));
  const out = await adapter.createOrder(fulfilment([line('printify', { qty: 3 })]));
  assert.deepEqual(out, { supplierOrderRef: ID, status: 'submitted' });
  const [post, send] = fetch.calls;
  assert.equal(`${post.method} ${post.path}`, `POST ${SHOP}/orders.json`);
  assert.equal(post.headers.Authorization, 'Bearer pfy-token');
  assert.ok(post.headers['User-Agent']);
  assert.deepEqual(post.body, {
    external_id: 'TCD-261112-AB2C-F1-0', label: 'TCD-261112-AB2C',
    line_items: [{ product_id: '5bfd0b66a342bcc9b5563216', variant_id: 17887, quantity: 3, external_id: '11' }],
    shipping_method: 1, send_shipping_notification: false,
    address_to: { first_name: 'Test', last_name: 'Person', email: 'buyer@example.com', phone: '+34600000000', country: 'ES', region: '', address1: '1 Example Street', city: 'Madrid', zip: '28001' },
  });
  assert.ok(!('blueprint_id' in post.body.line_items[0]) && !('print_areas' in post.body.line_items[0])); // never an on-the-fly product
  assert.equal(`${send.method} ${send.path}`, `POST ${SHOP}/orders/${ID}/send_to_production.json`);
});

test('printify: outside live mode the order is created but not sent to production', async () => {
  const { adapter, fetch } = make(() => ({ body: { id: ID } }), config({ ...ENV, COMMERCE_MODE: 'mock' }));
  await adapter.createOrder(fulfilment([line('printify')]));
  assert.equal(fetch.calls.length, 1);
});

test('printify: 409 duplicate external_id → the existing order is used (one supplier order)', async () => {
  let created = false; let posts = 0; let sends = 0;
  const { adapter } = make((c) => {
    if (c.path.endsWith('/orders.json') && c.method === 'POST') { posts += 1; if (created) return { status: 409, body: fx.printifyConflict }; created = true; return { body: { id: ID } }; }
    if (c.path.endsWith('send_to_production.json')) { sends += 1; return { status: 202, body: {} }; }
    return { body: fx.printifyOrder({ status: 'in-production' }) };
  });
  const f = fulfilment([line('printify')]);
  const a = await adapter.createOrder(f); const b = await adapter.createOrder(f);
  assert.equal(a.supplierOrderRef, ID); assert.equal(b.supplierOrderRef, ID);
  assert.equal(b.status, 'in_production');
  assert.equal(posts, 2); assert.equal(sends, 1); // the second call found it already in production
});

test('printify: a duplicate still on hold is sent to production (create succeeded, send had failed)', async () => {
  const { adapter, fetch } = make((c) => {
    if (c.path.endsWith('/orders.json')) return { status: 409, body: fx.printifyConflict };
    if (c.method === 'GET') return { body: fx.printifyOrder({ status: 'on-hold' }) };
    return { status: 202, body: {} };
  });
  await adapter.createOrder(fulfilment([line('printify')]));
  assert.equal(fetch.calls.at(-1).path, `${SHOP}/orders/${ID}/send_to_production.json`);
});

test('printify: personalised lines are refused before any call; validation errors are not retryable', async () => {
  const a = make(() => ({}));
  await assert.rejects(a.adapter.createOrder(fulfilment([line('printify', { personalisation: { name: 'X' } })])), (e) => e.code === 'PERSONALISATION_NEEDS_HUMAN' && !e.retryable);
  assert.equal(a.fetch.calls.length, 0);
  const b = make(() => ({ status: 400, body: { status: 'error', code: 8103, message: 'Validation failed.', errors: { reason: 'zip required', code: 8103 } } }));
  await assert.rejects(b.adapter.createOrder(fulfilment([line('printify')])), (e) => e instanceof ProviderError && e.retryable === false);
});

test('printify: every documented status maps', () => {
  const sent = { sendToProduction: true };
  const expected = {
    pending: 'submitted', 'on-hold': 'on_hold', 'sending-to-production': 'submitted', 'in-production': 'in_production', canceled: 'cancelled', fulfilled: 'shipped',
    'partially-fulfilled': 'in_production', 'payment-not-received': 'on_hold', 'has-issues': 'on_hold', 'cost-calculation': 'submitted', unfulfillable: 'failed',
    sending_to_production_delegate: 'submitted', sending_to_production_delegate_sync: 'submitted', 'source-check-failed': 'failed',
  };
  for (const [raw, status] of Object.entries(expected)) assert.equal(mapStatus({ status: raw }, sent).status, status, raw);
  assert.equal(mapStatus({ status: 'on-hold' }, { sendToProduction: false }).status, 'submitted');
  assert.equal(mapStatus({ status: 'fulfilled', shipments: [{ delivered_at: '2017-04-18 13:24:28+00:00' }] }, sent).status, 'delivered');
});

test('printify: getOrder parses shipments; by external id it scans the order list; 404 → null', async () => {
  const shipped = fx.printifyOrder({ status: 'fulfilled', fulfilled_at: '2017-04-18 10:00:00+00:00', shipments: [{ carrier: 'usps', number: '94001116990045395649372', url: 'http://example.com/94001116990045395649372', delivered_at: null }] });
  const { adapter, fetch } = make((c) => {
    if (c.path === `${SHOP}/orders/${ID}.json`) return { body: shipped };
    if (c.path === `${SHOP}/orders.json`) return { body: { current_page: 1, data: [fx.printifyOrder({ id: 'other', metadata: { shop_order_id: 'nope' } }), shipped], next_page_url: null } };
    return { status: 404, body: {} };
  });
  const state = await adapter.getOrder({ supplierOrderRef: ID, externalId: 'x' });
  assert.equal(state.status, 'shipped'); assert.equal(state.rawStatus, 'fulfilled');
  assert.deepEqual(state.shipments, [{ ref: '94001116990045395649372', carrier: 'usps', trackingNumber: '94001116990045395649372', trackingUrl: 'http://example.com/94001116990045395649372', shippedAt: Date.parse('2017-04-18T10:00:00Z'), deliveredAt: null }]);
  assert.equal((await adapter.getOrder({ externalId: 'TCD-261112-AB2C-F1-0' })).status, 'shipped');
  assert.deepEqual(fetch.calls.at(-1).query, { limit: '50', page: '1' });
  assert.equal(await adapter.getOrder({ supplierOrderRef: 'missing', externalId: 'x' }), null);
  assert.equal(await adapter.getOrder({ externalId: 'unknown' }), null);
});

test('printify: quote reads the shipping endpoint (USD cents) and falls back to the table', async () => {
  const ok = make(() => ({ body: fx.printifyShipping }));
  const q = await ok.adapter.quote([line('printify', { qty: 2 })], dest());
  assert.deepEqual(q, { supplier: 'printify', currency: 'USD', itemsCost: 2100, shippingCost: 1000, total: 3100, minDays: 5, maxDays: 10, shippingMethod: 'standard', source: 'api' });
  assert.equal(ok.fetch.calls[0].path, `${SHOP}/orders/shipping.json`);
  assert.deepEqual(ok.fetch.calls[0].body.line_items, [{ product_id: '5bfd0b66a342bcc9b5563216', variant_id: 17887, quantity: 2 }]);
  const down = make(() => { throw new TypeError('fetch failed'); });
  assert.equal((await down.adapter.quote([line('printify')], dest())).source, 'table');
});

test('printify: webhook signature X-Pfy-Signature is verified on the raw body', async () => {
  const { adapter } = make(() => ({}));
  const body = raw(fx.printifyShipmentEvent);
  assert.deepEqual(await adapter.parseWebhook({ rawBody: body, headers: { 'x-pfy-signature': sign(body) }, query: {} }), [{ eventId: '653b6be8-2ff7-4ab5-a7a6-6889a8b3bbf5', type: 'order.updated', supplierOrderRef: ID }]);
  for (const headers of [{}, { 'x-pfy-signature': 'sha256=00' }, { 'x-pfy-signature': sign(raw('{"other":1}')) }]) {
    await assert.rejects(adapter.parseWebhook({ rawBody: body, headers, query: { key: 'whsec' } }), (e) => e.code === 'WEBHOOK_SIGNATURE' && e.status === 400);
  }
  const product = raw({ id: 'e1', type: 'product:publish:started', resource: { id: 'p', type: 'product' } });
  assert.equal((await adapter.parseWebhook({ rawBody: product, headers: { 'x-pfy-signature': sign(product) }, query: {} }))[0].type, 'ignored');
});

test('printify: cancel succeeds, and a refusal (not on-hold any more) is reported', async () => {
  const ok = make(() => ({ body: fx.printifyOrder({ status: 'canceled' }) }));
  assert.deepEqual(await ok.adapter.cancel({ supplierOrderRef: ID, externalId: 'x' }), { cancelled: true });
  assert.equal(ok.fetch.calls[0].path, `${SHOP}/orders/${ID}/cancel.json`);
  const no = make(() => ({ status: 400, body: { status: 'error', code: 8252, message: 'Order cannot be canceled' } }));
  assert.equal((await no.adapter.cancel({ supplierOrderRef: ID, externalId: 'x' })).cancelled, false);
});

test('printify: availability follows the mapping', async () => {
  const { adapter } = make(() => ({}));
  assert.equal(await adapter.isAvailable(line('printify'), dest()), true);
  assert.equal(await adapter.isAvailable(line('printify'), dest('AE', 'AE')), false);
  assert.equal(await adapter.isAvailable(line('printify', { mapping: { productRef: 'PLACEHOLDER-PRINTIFY-PRODUCT-x' } }), dest()), false);
});
