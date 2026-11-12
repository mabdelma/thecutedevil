// Printful adapter against documented shapes (https://developers.printful.com/docs/). Owner: sup. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, mapStatus } from '../../suppliers/printful.js';
import { AppError, ProviderError } from '../../lib/errors.js';
import { sha256, hmacSha256Hex } from '../../suppliers/util.js';
import * as fx from '../fixtures/sup/fixtures.js';
import { config, dest, fakeClock, fakeFetch, fulfilment, line, raw, withExtra } from './helpers.js';

const ENV = { PRINTFUL_API_KEY: 'pf-key', PRINTFUL_WEBHOOK_SECRET: 'url-secret', PRINTFUL_STORE_ID: '77' };
const make = (handler, cfg = config(ENV)) => { const fetch = fakeFetch(handler); return { adapter: create(cfg, { fetch, ...fakeClock() }), fetch }; };
const EXT = '/orders/@TCD-261112-AB2C-F1-0';

test('printful: null without env; capabilities', () => {
  assert.equal(create(config({}), {}), null);
  assert.deepEqual(make(() => ({})).adapter.capabilities, { webhooks: true, cancel: true, cod: false, liveQuote: true });
});

test('printful: availability needs a real mapping and the region', async () => {
  const { adapter } = make(() => ({}));
  assert.equal(await adapter.isAvailable(line('printful'), dest()), true);
  assert.equal(await adapter.isAvailable(line('printful'), dest('EG', 'EG')), false);
  assert.equal(await adapter.isAvailable(line('printful', { mapping: null }), dest()), false);
  assert.equal(await adapter.isAvailable(line('printful', { mapping: { variantRef: 'PLACEHOLDER-PRINTFUL-VARIANT-x' } }), dest()), false);
});

test('printful: createOrder builds the v1 payload, confirms in live mode, sends auth and store headers', async () => {
  const { adapter, fetch } = make((c) => (c.method === 'GET' ? { status: 404, body: fx.printfulError(404, 'Not found') } : { body: fx.printfulOrder() }));
  const out = await adapter.createOrder(fulfilment([line('printful', { qty: 2 })]));
  assert.deepEqual(out, { supplierOrderRef: '13', status: 'submitted', cost: { amount: 3450, currency: 'USD' } });
  const [lookup, post] = fetch.calls;
  assert.equal(lookup.path, EXT);
  assert.equal(post.method, 'POST'); assert.equal(post.path, '/orders'); assert.equal(post.host, 'api.printful.com');
  assert.deepEqual(post.query, { confirm: 'true' });
  assert.equal(post.headers.Authorization, 'Bearer pf-key'); assert.equal(post.headers['X-PF-Store-Id'], '77');
  assert.deepEqual(post.body, {
    external_id: 'TCD-261112-AB2C-F1-0', shipping: 'STANDARD',
    recipient: { name: 'Test Person', address1: '1 Example Street', city: 'Madrid', country_code: 'ES', zip: '28001', phone: '+34600000000', email: 'buyer@example.com' },
    items: [{ external_id: '11', variant_id: 10780, quantity: 2, files: [{ type: 'embroidery_chest_left', url: 'https://cdn.example.com/horns.png' }] }],
  });
  assert.ok(post.body.external_id.length <= 32);
});

test('printful: draft outside live mode; the config flag overrides both ways', async () => {
  const handler = (c) => (c.method === 'GET' ? { status: 404 } : { body: fx.printfulOrder({ status: 'draft' }) });
  const mockMode = make(handler, config({ ...ENV, COMMERCE_MODE: 'mock' }));
  await mockMode.adapter.createOrder(fulfilment([line('printful')]));
  assert.deepEqual(mockMode.fetch.calls[1].query, { confirm: 'false' });
  const forcedDraft = make(handler, withExtra(config(ENV), 'printful', { confirm: '0' }));
  await forcedDraft.adapter.createOrder(fulfilment([line('printful')]));
  assert.deepEqual(forcedDraft.fetch.calls[1].query, { confirm: 'false' });
  const forcedConfirm = make(handler, withExtra(config({ ...ENV, COMMERCE_MODE: 'mock' }), 'printful', { confirm: '1' }));
  await forcedConfirm.adapter.createOrder(fulfilment([line('printful')]));
  assert.deepEqual(forcedConfirm.fetch.calls[1].query, { confirm: 'true' });
});

test('printful: idempotency, the same fulfilment twice makes one supplier order', async () => {
  let stored = null; let posts = 0;
  const { adapter } = make((c) => {
    if (c.method === 'GET') return stored ? { body: stored } : { status: 404 };
    posts += 1; stored = fx.printfulOrder(); return { body: stored };
  });
  const f = fulfilment([line('printful')]);
  const a = await adapter.createOrder(f); const b = await adapter.createOrder(f);
  assert.equal(posts, 1);
  assert.equal(a.supplierOrderRef, b.supplierOrderRef);
});

test('printful: an existing draft is confirmed instead of re-created; a 400 on create adopts the existing order', async () => {
  const one = make((c) => (c.method === 'GET' ? { body: fx.printfulOrder({ status: 'draft' }) } : { body: fx.printfulOrder({ status: 'pending' }) }));
  await one.adapter.createOrder(fulfilment([line('printful')]));
  assert.deepEqual(one.fetch.calls.map((c) => `${c.method} ${c.path}`), [`GET ${EXT}`, 'POST /orders/13/confirm']);
  let gets = 0;
  const two = make((c) => {
    if (c.method === 'GET') { gets += 1; return gets === 1 ? { status: 404 } : { body: fx.printfulOrder() }; }
    return { status: 400, body: fx.printfulError(400, 'external_id already exists') };
  });
  assert.equal((await two.adapter.createOrder(fulfilment([line('printful')]))).supplierOrderRef, '13');
});

test('printful: a real 400 stays a non-retryable error', async () => {
  const { adapter } = make((c) => (c.method === 'GET' ? { status: 404 } : { status: 400, body: fx.printfulError(400, 'Invalid zip') }));
  await assert.rejects(adapter.createOrder(fulfilment([line('printful')])), (e) => e instanceof ProviderError && e.retryable === false && e.status === 400);
});

test('printful: personalisation becomes a print file by URL, or the line is refused before any call', async () => {
  const { adapter, fetch } = make((c) => (c.method === 'GET' ? { status: 404 } : { body: fx.printfulOrder() }));
  const mapping = { personalisation: { name: { placement: 'embroidery_chest_center', urlTemplate: 'https://render.example.com/text.png?t={value}' }, photo: { placement: 'back' } } };
  await adapter.createOrder(fulfilment([line('printful', { mapping, personalisation: { name: 'Lilith & Co', photo: 'https://uploads.example.com/p.png' } })]));
  assert.deepEqual(fetch.calls[1].body.items[0].files.slice(1), [
    { type: 'embroidery_chest_center', url: 'https://render.example.com/text.png?t=Lilith%20%26%20Co' },
    { type: 'back', url: 'https://uploads.example.com/p.png' },
  ]);
  const bare = make(() => ({}));
  await assert.rejects(bare.adapter.createOrder(fulfilment([line('printful', { personalisation: { name: 'Lilith' } })])), (e) => e.code === 'PERSONALISATION_NEEDS_HUMAN' && e.retryable === false);
  assert.equal(bare.fetch.calls.length, 0);
});

test('printful: sync variants are sent as sync_variant_id without files', async () => {
  const { adapter, fetch } = make((c) => (c.method === 'GET' ? { status: 404 } : { body: fx.printfulOrder() }));
  await adapter.createOrder(fulfilment([line('printful', { mapping: { variantRef: 'sync:4012', files: undefined } })]));
  assert.deepEqual(fetch.calls[1].body.items[0], { external_id: '11', sync_variant_id: 4012, quantity: 1 });
});

test('printful: every documented status maps', () => {
  const live = { confirm: true };
  const expected = { draft: 'on_hold', inreview: 'submitted', pending: 'submitted', failed: 'failed', canceled: 'cancelled', inprocess: 'in_production', onhold: 'on_hold', partial: 'in_production', fulfilled: 'shipped', archived: 'cancelled' };
  for (const [raw, status] of Object.entries(expected)) assert.equal(mapStatus({ status: raw }, live).status, status, raw);
  assert.equal(mapStatus({ status: 'draft' }, { confirm: false }).status, 'submitted');
  assert.equal(mapStatus({ status: 'archived', shipments: [{}] }, live).status, 'shipped');
});

test('printful: getOrder parses shipments; 404 → null; falls back to @external_id', async () => {
  const { adapter, fetch } = make((c) => (c.path === '/orders/13' ? { body: fx.printfulOrder({ status: 'fulfilled', shipments: [fx.printfulShipment] }) } : { status: 404 }));
  assert.deepEqual(await adapter.getOrder({ supplierOrderRef: '13', externalId: 'x' }), {
    status: 'shipped', rawStatus: 'fulfilled',
    shipments: [{ ref: '10', carrier: 'FEDEX', trackingNumber: '794600000000', trackingUrl: 'https://www.fedex.com/fedextrack/?tracknumbers=794600000000', shippedAt: 1588716060000, deliveredAt: null }],
  });
  assert.equal(await adapter.getOrder({ externalId: 'TCD-261112-AB2C-F1-0' }), null);
  assert.equal(fetch.calls[1].path, EXT);
});

test('printful: quote uses the shipping-rate API and falls back to the table', async () => {
  const ok = make(() => ({ body: fx.printfulRates }));
  const q = await ok.adapter.quote([line('printful', { qty: 2 })], dest('US', 'US', { state: 'CA', postcode: '91311', city: 'Chatsworth' }));
  assert.deepEqual(q, { supplier: 'printful', currency: 'USD', itemsCost: 5900, shippingCost: 1360, total: 7260, minDays: 4, maxDays: 9, shippingMethod: 'STANDARD', source: 'api' });
  assert.deepEqual(ok.fetch.calls[0].body, { recipient: { country_code: 'US', state_code: 'CA', city: 'Chatsworth', zip: '91311' }, items: [{ variant_id: '10780', quantity: 2 }], currency: 'USD' });
  assert.equal(ok.fetch.calls[0].path, '/shipping/rates');
  const down = make(() => ({ status: 500 }));
  const t = await down.adapter.quote([line('printful')], dest());
  assert.equal(t.source, 'table'); assert.equal(t.total, 2950); assert.deepEqual([t.minDays, t.maxDays], [4, 9]);
  assert.equal(down.fetch.calls.length, 1); // a quote is never retried
});

test('printful: webhook needs the URL secret; order events carry both references', async () => {
  const { adapter } = make(() => ({}));
  const body = raw(fx.printfulWebhook('package_shipped', {}, { shipment: fx.printfulShipment }));
  await assert.rejects(adapter.parseWebhook({ rawBody: body, headers: {}, query: {} }), (e) => e instanceof AppError && e.code === 'WEBHOOK_SIGNATURE' && e.status === 400);
  await assert.rejects(adapter.parseWebhook({ rawBody: body, headers: {}, query: { key: 'wrong' } }), (e) => e.code === 'WEBHOOK_SIGNATURE');
  for (const type of ['package_shipped', 'package_returned', 'order_failed', 'order_canceled', 'order_put_hold', 'order_remove_hold', 'order_updated', 'order_refunded']) {
    const b = raw(fx.printfulWebhook(type));
    assert.deepEqual(await adapter.parseWebhook({ rawBody: b, headers: {}, query: { key: 'url-secret' } }), [{ eventId: sha256(b), type: 'order.updated', externalId: 'TCD-261112-AB2C-F1-0', supplierOrderRef: '13' }], type);
  }
  const other = raw({ type: 'product_synced', created: 1, retries: 0, store: 12, data: {} });
  assert.equal((await adapter.parseWebhook({ rawBody: other, headers: {}, query: { key: 'url-secret' } }))[0].type, 'ignored');
});

test('printful: v2 signature is enforced when a signing key is configured', async () => {
  const keyHex = 'a1b2c3d4e5f60718';
  const { adapter } = make(() => ({}), withExtra(config(ENV), 'printful', { webhookSigningKeyHex: keyHex }));
  const body = raw(fx.printfulWebhook('order_updated'));
  const good = hmacSha256Hex(Buffer.from(keyHex, 'hex'), body);
  assert.equal((await adapter.parseWebhook({ rawBody: body, headers: { 'x-pf-webhook-signature': good }, query: { key: 'url-secret' } })).length, 1);
  await assert.rejects(adapter.parseWebhook({ rawBody: body, headers: { 'x-pf-webhook-signature': 'deadbeef' }, query: { key: 'url-secret' } }), (e) => e.code === 'WEBHOOK_SIGNATURE');
  await assert.rejects(adapter.parseWebhook({ rawBody: body, headers: {}, query: { key: 'url-secret' } }), (e) => e.code === 'WEBHOOK_SIGNATURE');
});

test('printful: stock_updated switches a variant off and on again', async () => {
  const { adapter } = make(() => ({}));
  const send = (p) => adapter.parseWebhook({ rawBody: raw(p), headers: {}, query: { key: 'url-secret' } });
  assert.equal((await send(fx.printfulStockWebhook([10780])))[0].type, 'stock.updated');
  assert.equal(await adapter.isAvailable(line('printful'), dest()), false);
  await send(fx.printfulStockWebhook([]));
  assert.equal(await adapter.isAvailable(line('printful'), dest()), true);
});

test('printful: cancel succeeds, and a refusal is reported, not thrown', async () => {
  const ok = make(() => ({ body: fx.printfulOrder({ status: 'canceled' }) }));
  assert.deepEqual(await ok.adapter.cancel({ supplierOrderRef: '13', externalId: 'x' }), { cancelled: true });
  assert.equal(ok.fetch.calls[0].method, 'DELETE'); assert.equal(ok.fetch.calls[0].path, '/orders/13');
  const no = make(() => ({ status: 400, body: fx.printfulError(400, 'Order is being fulfilled') }));
  const r = await no.adapter.cancel({ supplierOrderRef: '13', externalId: 'x' });
  assert.equal(r.cancelled, false); assert.match(r.reason, /400/);
});
