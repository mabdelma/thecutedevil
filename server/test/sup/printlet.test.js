// Printlet adapter against its OpenAPI 1.0.0-rc.1 (https://printleteg.com/api/developer-docs/api-integration/openapi). Owner: sup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, mapStatus } from '../../suppliers/printlet.js';
import { loadSuppliers } from '../../suppliers/registry.js';
import * as fx from '../fixtures/sup/fixtures.js';
import { config, dest, fakeClock, fakeFetch, fulfilment, line, raw, withExtra } from './helpers.js';

const ENV = { PRINTLET_API_KEY: 'prnt_test_x', PRINTLET_BASE_URL: 'https://printlet.example.test/api/integrations/v1', PRINTLET_WEBHOOK_SECRET: 'pl-secret' };
const confirmedCfg = () => withExtra(config(ENV), 'printlet', { apiConfirmed: true });
const make = (handler, cfg = confirmedCfg()) => { const fetch = fakeFetch(handler); return { adapter: create(cfg, { fetch, ...fakeClock() }), fetch }; };
const EG = dest('EG', 'EG', { city: 'Cairo', postcode: '' });
const f = (more = {}) => fulfilment([line('printlet')], { currency: 'EGP', recipient: { name: 'Test Person', line1: '1 Example Street', line2: '', city: 'cairo', state: '', postcode: '', country: 'EG', phone: '+201000000000', email: '' }, ...more });
const B = '/api/integrations/v1';

/** A tiny Printlet: order is paid from the wallet when asked. */
function server({ artwork = 'ready', wallet = true } = {}) {
  const state = { order: null, posts: 0 };
  const handler = (c) => {
    const p = c.path.slice(B.length);
    if (c.method === 'GET' && p === '/orders') return { body: { data: state.order ? [state.order] : [], has_more: false, next_cursor: null } };
    if (p === '/catalog/countries') return { body: fx.printletCountries };
    if (p === '/catalog/shipping-methods') return { body: fx.printletShipping };
    if (p === '/catalog/products/prod-1') return { body: fx.printletProduct };
    if (p === '/artworks') return { status: artwork === 'ready' ? 200 : 202, body: fx.printletArtwork(artwork) };
    if (p === '/quotes') return { status: 201, body: fx.printletQuote };
    if (c.method === 'POST' && p === '/orders') { state.posts += 1; state.order = fx.printletOrder(c.body.end_customer_payment.method === 'cod' ? { status: 'pending_verification' } : {}); return { status: 201, body: state.order }; }
    if (p === '/orders/ord-1/cod-verification') { state.order = { ...state.order, status: 'payment_required', resource_version: 2 }; return { body: state.order }; }
    if (p === '/orders/ord-1/payment-session') {
      if (!wallet) return { status: 402, body: fx.printletError('insufficient_wallet_balance') };
      state.order = { ...state.order, status: 'accepted', payment_status: 'committed' }; return { body: { payment_method: 'wallet', order: state.order } };
    }
    if (p === '/orders/ord-1' && c.method === 'GET') return state.order ? { body: state.order } : { status: 404, body: fx.printletError('not_found') };
    if (p === '/orders/ord-1/cancel') { state.order = { ...state.order, status: state.order.payment_status === 'committed' ? 'cancellation_requested' : 'cancelled' }; return { status: 202, body: state.order }; }
    return { status: 404, body: fx.printletError('not_found') };
  };
  return { state, handler };
}

test('printlet: not loaded without env; loaded but UNAVAILABLE without the explicit confirmation flag', async () => {
  assert.equal(create(config({}), {}), null);
  const { adapter, fetch } = make(() => ({}), config(ENV));
  assert.equal(adapter.capabilities.cod, false);
  assert.equal(await adapter.isAvailable(line('printlet'), EG), false);
  await assert.rejects(adapter.createOrder(f()), (e) => e.code === 'PRINTLET_UNVERIFIED' && e.retryable === false);
  assert.equal(await adapter.getOrder({ externalId: 'x' }), null);
  assert.equal((await adapter.cancel({ externalId: 'x' })).cancelled, false);
  assert.equal(fetch.calls.length, 0); // no HTTP at all while unconfirmed
  assert.equal(loadSuppliers(config(ENV)).get('printlet').capabilities.cod, false);
});

test('printlet: confirmed → available in Egypt only, COD capable, table quote in EGP', async () => {
  const { adapter } = make(() => ({}));
  assert.equal(adapter.capabilities.cod, true);
  assert.equal(await adapter.isAvailable(line('printlet'), EG), true);
  assert.equal(await adapter.isAvailable(line('printlet'), dest()), false);
  assert.equal(await adapter.isAvailable(line('printlet', { mapping: { variantRef: 'PLACEHOLDER-PRINTLET-VARIANT-x' } }), EG), false);
  assert.deepEqual(await adapter.quote([line('printlet', { qty: 2 })], EG), { supplier: 'printlet', currency: 'EGP', itemsCost: 44000, shippingCost: 0, total: 44000, minDays: 2, maxDays: 5, shippingMethod: 'standard', source: 'table' });
});

test('printlet: createOrder walks catalogue → artwork → quote → order → wallet payment, with idempotency keys', async () => {
  const s = server(); const { adapter, fetch } = make(s.handler);
  const out = await adapter.createOrder(f());
  assert.deepEqual(out, { supplierOrderRef: 'ord-1', status: 'submitted', cost: { amount: 26500, currency: 'EGP' } });
  const by = (suffix, method = 'POST') => fetch.calls.find((c) => c.method === method && c.path === B + suffix);
  assert.equal(by('/artworks').headers.Authorization, 'Bearer prnt_test_x');
  assert.deepEqual(by('/artworks').body, { source: { type: 'remote_url', url: 'https://cdn.example.com/front.png' }, merchant_artwork_id: 'TCD-261112-AB2C-F1-0:art:0:0', wait: 10, rights_attested: true });
  const quote = by('/quotes').body;
  assert.deepEqual(quote.market, { country_id: 'c0000000-0000-4000-8000-000000000001', currency: 'EGP' });
  assert.deepEqual(quote.items, [{ merchant_line_id: '11', configuration: { variant: { id: 'var-1', revision: 2 }, quantity: 1, print_areas: [{ print_area: { id: 'area-front', revision: 4 }, technique: { id: 'tech-dtf', revision: 5 }, placement_preset: 'center', artwork: { id: 'art-1', revision: 1 } }] } }]);
  assert.deepEqual(quote.shipping, { method_id: 'd0000000-0000-4000-8000-000000000001', recipient: { name: 'Test Person', phone: '+201000000000', address_line_1: '1 Example Street', city_id: 'e0000000-0000-4000-8000-000000000001', country: 'EG' } });
  assert.deepEqual(by('/orders').body, { merchant_order_id: 'TCD-261112-AB2C-F1-0', merchant_order_number: 'TCD-261112-AB2C', quote_id: 'quote-1', end_customer_payment: { method: 'prepaid', currency: 'EGP' } });
  assert.equal(by('/orders').headers['Idempotency-Key'], 'TCD-261112-AB2C-F1-0:order');
  const pay = by('/orders/ord-1/payment-session');
  assert.deepEqual(pay.body, { payment_method: 'wallet' }); assert.equal(pay.headers['If-Match'], '1');
  for (const c of fetch.calls.filter((x) => x.method === 'POST')) assert.ok(String(c.headers['Idempotency-Key']).length >= 8, c.path);
});

test('printlet: COD order carries the amount to collect and is verified before payment', async () => {
  const s = server(); const { adapter, fetch } = make(s.handler);
  await adapter.createOrder(f({ cod: { amount: 249900, currency: 'EGP' } }));
  const order = fetch.calls.find((c) => c.method === 'POST' && c.path === `${B}/orders`).body;
  assert.deepEqual(order.end_customer_payment, { method: 'cod', currency: 'EGP', collection_amount: '2499.00', includes_merchant_shipping: true });
  const steps = fetch.calls.map((c) => c.path.slice(B.length)).filter((p) => p.startsWith('/orders/ord-1/'));
  assert.deepEqual(steps, ['/orders/ord-1/cod-verification', '/orders/ord-1/payment-session']);
  assert.equal(fetch.calls.at(-1).headers['If-Match'], '2');
});

test('printlet: idempotency, the same fulfilment twice makes one supplier order', async () => {
  const s = server(); const { adapter } = make(s.handler);
  const a = await adapter.createOrder(f()); const b = await adapter.createOrder(f());
  assert.equal(s.state.posts, 1); assert.equal(a.supplierOrderRef, b.supplierOrderRef);
});

test('printlet: an empty wallet leaves the order on hold instead of failing the fulfilment', async () => {
  const s = server({ wallet: false }); const { adapter } = make(s.handler);
  assert.equal((await adapter.createOrder(f())).supplierOrderRef, 'ord-1');
  const state = await adapter.getOrder({ supplierOrderRef: 'ord-1', externalId: 'x' });
  assert.equal(state.status, 'on_hold'); assert.match(state.problem, /wallet/);
});

test('printlet: unknown city and rejected artwork are non-retryable; pending artwork is retryable', async () => {
  const a = make(server().handler);
  await assert.rejects(a.adapter.createOrder(f({ recipient: { ...f().recipient, city: 'Atlantis' } })), (e) => e.code === 'PRINTLET_CITY_UNKNOWN' && !e.retryable);
  const b = make(server({ artwork: 'failed' }).handler);
  await assert.rejects(b.adapter.createOrder(f()), (e) => e.code === 'PRINTLET_ARTWORK_REJECTED' && !e.retryable);
  const c = make(server({ artwork: 'processing' }).handler);
  await assert.rejects(c.adapter.createOrder(f()), (e) => e.code === 'PRINTLET_ARTWORK_PENDING' && e.retryable === true);
});

test('printlet: every status of the Order schema maps', () => {
  const expected = { pending_verification: 'on_hold', payment_required: 'on_hold', accepted: 'submitted', in_production: 'in_production', shipped: 'shipped', delivered: 'delivered', cancellation_requested: 'submitted', cancelled: 'cancelled', failed: 'failed', refunded: 'cancelled' };
  for (const [raw, status] of Object.entries(expected)) assert.equal(mapStatus({ status: raw }).status, status, raw);
});

test('printlet: getOrder by reference or by merchant_order_id; shipped reports one shipment; unknown → null', async () => {
  const s = server(); s.state.order = fx.printletOrder({ status: 'shipped' });
  const { adapter } = make(s.handler);
  const state = await adapter.getOrder({ supplierOrderRef: 'ord-1', externalId: 'x' });
  assert.equal(state.status, 'shipped');
  assert.deepEqual(state.shipments, [{ ref: 'ord-1', carrier: null, trackingNumber: null, trackingUrl: null, shippedAt: null, deliveredAt: null }]);
  assert.equal((await adapter.getOrder({ externalId: 'TCD-261112-AB2C-F1-0' })).status, 'shipped');
  assert.equal(await adapter.getOrder({ externalId: 'nope' }), null);
});

test('printlet: webhook needs the URL secret; order events map, catalogue events are stock signals', async () => {
  const { adapter } = make(() => ({}));
  const body = raw(fx.printletEvent('order.shipped'));
  await assert.rejects(adapter.parseWebhook({ rawBody: body, headers: {}, query: {} }), (e) => e.code === 'WEBHOOK_SIGNATURE');
  assert.deepEqual(await adapter.parseWebhook({ rawBody: body, headers: {}, query: { key: 'pl-secret' } }), [{ eventId: 'evt_1', type: 'order.updated', externalId: 'TCD-261112-AB2C-F1-0', supplierOrderRef: 'ord-1' }]);
  assert.equal((await adapter.parseWebhook({ rawBody: raw(fx.printletEvent('catalog.product.updated')), headers: {}, query: { key: 'pl-secret' } }))[0].type, 'stock.updated');
  assert.equal((await adapter.parseWebhook({ rawBody: raw(fx.printletEvent('artwork.ready')), headers: {}, query: { key: 'pl-secret' } }))[0].type, 'ignored');
});

test('printlet: cancel is true only when Printlet says cancelled; a mere request is a refusal', async () => {
  const s = server(); const { adapter } = make(s.handler);
  s.state.order = fx.printletOrder();
  assert.deepEqual(await adapter.cancel({ supplierOrderRef: 'ord-1', externalId: 'TCD-261112-AB2C-F1-0' }), { cancelled: true });
  s.state.order = fx.printletOrder({ status: 'accepted', payment_status: 'committed' });
  const r = await adapter.cancel({ supplierOrderRef: 'ord-1', externalId: 'TCD-261112-AB2C-F1-0' });
  assert.equal(r.cancelled, false); assert.match(r.reason, /cancellation_requested/);
});
