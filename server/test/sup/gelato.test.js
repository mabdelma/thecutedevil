// Gelato adapter against documented shapes (https://developers.gelato.com/docs/). Owner: sup. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, mapStatus, toState } from '../../suppliers/gelato.js';
import { sha256 } from '../../suppliers/util.js';
import * as fx from '../fixtures/sup/fixtures.js';
import { config, dest, fakeClock, fakeFetch, fulfilment, line, raw, withExtra } from './helpers.js';

const ENV = { GELATO_API_KEY: 'gel-key', GELATO_WEBHOOK_SECRET: 'gel-url-secret' };
const make = (handler, cfg = config(ENV)) => { const fetch = fakeFetch(handler); return { adapter: create(cfg, { fetch, ...fakeClock() }), fetch }; };
const OID = '37365096-6628-4538-a9c2-fbf9892deb85';
const RETURN = { companyName: 'Returns', addressLine1: '2 Return Road', city: 'Valladolid', postCode: '47001', country: 'ES', email: 'returns@example.com', phone: '+34000000000' };

test('gelato: null without env', () => { assert.equal(create(config({}), {}), null); });

test('gelato: createOrder searches first, then posts files by URL with the return address', async () => {
  const { adapter, fetch } = make((c) => (c.path === '/v4/orders:search' ? { body: { orders: [] } } : { body: fx.gelatoOrder() }), withExtra(config(ENV), 'gelato', { returnAddress: RETURN }));
  const out = await adapter.createOrder(fulfilment([line('gelato', { qty: 2 })], { shippingMethod: 'express' }));
  assert.deepEqual(out, { supplierOrderRef: OID, status: 'submitted', cost: { amount: 1876, currency: 'EUR' } });
  const [search, post] = fetch.calls;
  assert.equal(search.host, 'order.gelatoapis.com'); assert.equal(search.body.orderReferenceId, 'TCD-261112-AB2C-F1-0');
  assert.equal(`${post.method} ${post.path}`, 'POST /v4/orders');
  assert.equal(post.headers['X-API-KEY'], 'gel-key');
  assert.deepEqual(post.body, {
    orderType: 'order', orderReferenceId: 'TCD-261112-AB2C-F1-0', customerReferenceId: 'TCD-261112-AB2C', currency: 'EUR',
    items: [{ itemReferenceId: '11', productUid: line('gelato').mapping.variantRef, files: [{ type: 'default', url: 'https://cdn.example.com/front.png' }], quantity: 2 }],
    shipmentMethodUid: 'express',
    shippingAddress: { firstName: 'Test', lastName: 'Person', addressLine1: '1 Example Street', city: 'Madrid', postCode: '28001', country: 'ES', email: 'buyer@example.com', phone: '+34600000000' },
    returnAddress: RETURN,
  });
});

test('gelato: draft outside live mode; unknown shipping method is left to Gelato', async () => {
  const { adapter, fetch } = make((c) => (c.path === '/v4/orders:search' ? { body: { orders: [] } } : { body: fx.gelatoOrder({ orderType: 'draft', fulfillmentStatus: 'draft' }) }), config({ ...ENV, COMMERCE_MODE: 'mock' }));
  await adapter.createOrder(fulfilment([line('gelato')], { shippingMethod: 'PRINTFUL_FAST' })); // left over from another supplier's quote
  assert.equal(fetch.calls[1].body.orderType, 'draft');
  assert.ok(!('shipmentMethodUid' in fetch.calls[1].body) && !('returnAddress' in fetch.calls[1].body));
});

test('gelato: idempotency, the same fulfilment twice makes one supplier order', async () => {
  let stored = null; let posts = 0;
  const { adapter } = make((c) => {
    if (c.path === '/v4/orders:search') return { body: { orders: stored ? [stored] : [] } };
    posts += 1; stored = fx.gelatoOrder(); return { body: stored };
  });
  const f = fulfilment([line('gelato')]);
  const a = await adapter.createOrder(f); const b = await adapter.createOrder(f);
  assert.equal(posts, 1); assert.equal(a.supplierOrderRef, b.supplierOrderRef);
});

test('gelato: every documented status maps', () => {
  const expected = {
    created: 'submitted', uploading: 'submitted', passed: 'submitted', in_production: 'in_production', printed: 'in_production', draft: 'on_hold', failed: 'failed',
    canceled: 'cancelled', pending_approval: 'on_hold', pending_personalization: 'on_hold', digitizing: 'submitted', not_connected: 'on_hold', on_hold: 'on_hold',
    shipped: 'shipped', in_transit: 'shipped', delivered: 'delivered', returned: 'failed',
  };
  for (const [raw, status] of Object.entries(expected)) assert.equal(mapStatus(raw, { draft: false }).status, status, raw);
  assert.equal(mapStatus('draft', { draft: true }).status, 'submitted');
});

test('gelato: connected orders are read together and all their shipments reported', async () => {
  const second = '99999999-0000-4000-8000-000000000002';
  const a = fx.gelatoOrder({ fulfillmentStatus: 'shipped', connectedOrderIds: [second], shipment: { shipmentMethodName: 'DHL Parcel', packages: [{ id: 'pkg-1', trackingCode: 'TRACK-A', trackingUrl: 'https://example.com/t/A' }] } });
  const b = fx.gelatoOrder({ id: second, fulfillmentStatus: 'in_production', connectedOrderIds: [OID], shipment: { packages: [] } });
  const { adapter, fetch } = make((c) => (c.path === `/v4/orders/${OID}` ? { body: a } : c.path === `/v4/orders/${second}` ? { body: b } : { status: 404, body: {} }));
  const state = await adapter.getOrder({ supplierOrderRef: OID, externalId: 'x' });
  assert.equal(state.status, 'in_production'); // one part is still being made
  assert.equal(state.rawStatus, 'shipped,in_production');
  assert.deepEqual(state.shipments, [{ ref: 'pkg-1', carrier: 'DHL Parcel', trackingNumber: 'TRACK-A', trackingUrl: 'https://example.com/t/A', shippedAt: null, deliveredAt: null }]);
  assert.equal(fetch.calls.length, 2);
  const both = toState([a, { ...b, fulfillmentStatus: 'delivered', shipment: { packages: [{ id: 'pkg-2', trackingCode: 'TRACK-B', trackingUrl: 'https://example.com/t/B' }] } }], { draft: false });
  assert.equal(both.status, 'shipped'); assert.equal(both.shipments.length, 2);
  assert.equal(toState([{ ...a, fulfillmentStatus: 'canceled' }, { ...b, fulfillmentStatus: 'canceled' }], { draft: false }).status, 'cancelled');
});

test('gelato: getOrder by reference id uses search; nothing found → null', async () => {
  const { adapter } = make((c) => (c.path === '/v4/orders:search' ? { body: { orders: c.body.orderReferenceId === 'known' ? [{ id: OID, orderReferenceId: 'known', fulfillmentStatus: 'printed' }] : [] } } : { body: fx.gelatoOrder({ orderReferenceId: 'known', fulfillmentStatus: 'printed' }) }));
  assert.equal((await adapter.getOrder({ externalId: 'known' })).status, 'in_production');
  assert.equal(await adapter.getOrder({ externalId: 'unknown' }), null);
});

test('gelato: quote adds product prices and the cheapest normal shipping; falls back to the table', async () => {
  const ok = make(() => ({ body: fx.gelatoQuote }));
  const q = await ok.adapter.quote([line('gelato')], dest('DE', 'EU', { postcode: '10115', city: 'Berlin' }));
  assert.deepEqual(q, { supplier: 'gelato', currency: 'EUR', itemsCost: 1100, shippingCost: 450, total: 1550, minDays: 3, maxDays: 5, shippingMethod: 'normal', source: 'api' });
  const sent = ok.fetch.calls[0];
  assert.equal(sent.path, '/v4/orders:quote'); assert.equal(sent.body.allowMultipleQuotes, false);
  assert.equal(sent.body.recipient.country, 'DE'); assert.equal(sent.body.products[0].quantity, 1);
  const down = make(() => ({ status: 503 }));
  const t = await down.adapter.quote([line('gelato')], dest());
  assert.equal(t.source, 'table'); assert.equal(t.total, 1100);
});

test('gelato: webhook needs the URL secret; tracking events point at the order', async () => {
  const { adapter } = make(() => ({}));
  const body = raw(fx.gelatoStatusEvent);
  await assert.rejects(adapter.parseWebhook({ rawBody: body, headers: {}, query: { key: 'nope' } }), (e) => e.code === 'WEBHOOK_SIGNATURE' && e.status === 400);
  assert.deepEqual(await adapter.parseWebhook({ rawBody: body, headers: {}, query: { key: 'gel-url-secret' } }), [{ eventId: 'os_5e5680ce494f6', type: 'order.updated', externalId: 'TCD-261112-AB2C-F1-0', supplierOrderRef: OID }]);
  const tracking = raw({ event: 'order_item_tracking_code_updated', orderId: OID, orderReferenceId: 'TCD-261112-AB2C-F1-0', trackingCode: 'T', trackingUrl: 'https://example.com/t' });
  const ev = await adapter.parseWebhook({ rawBody: tracking, headers: {}, query: { key: 'gel-url-secret' } });
  assert.equal(ev[0].type, 'order.updated'); assert.equal(ev[0].eventId, sha256(tracking)); // no id in the payload
  const other = raw({ id: 'x', event: 'store_product_created' });
  assert.equal((await adapter.parseWebhook({ rawBody: other, headers: {}, query: { key: 'gel-url-secret' } }))[0].type, 'ignored');
});

test('gelato: stock webhook switches a product off only when every region is out', async () => {
  const { adapter } = make(() => ({}));
  const send = (p) => adapter.parseWebhook({ rawBody: raw(p), headers: {}, query: { key: 'gel-url-secret' } });
  assert.equal((await send(fx.gelatoStockEvent('out-of-stock')))[0].type, 'stock.updated');
  assert.equal(await adapter.isAvailable(line('gelato'), dest()), false);
  await send(fx.gelatoStockEvent('out-of-stock-replenishable'));
  assert.equal(await adapter.isAvailable(line('gelato'), dest()), true);
});

test('gelato: cancel 200 → cancelled; 409 (printed) → refusal', async () => {
  const ok = make(() => ({ body: {} }));
  assert.deepEqual(await ok.adapter.cancel({ supplierOrderRef: OID, externalId: 'x' }), { cancelled: true });
  assert.equal(ok.fetch.calls[0].path, `/v4/orders/${OID}:cancel`);
  const no = make(() => ({ status: 409, body: {} }));
  assert.deepEqual(await no.adapter.cancel({ supplierOrderRef: OID, externalId: 'x' }), { cancelled: false, reason: 'already printed or shipped' });
});
