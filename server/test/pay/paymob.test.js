// Paymob provider: HMAC known vector, intention request shape, callback mapping, refund. Owner: pay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { create, computeHmac, hmacString, verifyHmac, HMAC_FIELDS, mapTransaction } from '../../payments/paymob.js';
import { AppError, ProviderError } from '../../lib/errors.js';
import { config, quiet, order, items, shipping, payment, urls, fetchStub } from './helpers.js';
import { DOCUMENTED_STRING, TEST_SECRET, EXPECTED_HMAC, transaction, callback } from '../fixtures/pay/paymob-callback.js';

const egOrder = () => order({ currency: 'EGP', country: 'EG', lang: 'ar' });
const egPayment = (over = {}) => payment({ currency: 'EGP', ...over });
const make = (fetch = fetchStub({ json: { id: 'pi_test_x', client_secret: 'egy_csk_test_abc', intention_order_id: 217503754 } }), env = {}) => ({ fetch, provider: create(config(env), { log: quiet, fetch, now: () => 1794400000000, t: () => 'الشحن' }) });
const post = (provider, payload, hmac) => provider.parseWebhook({ rawBody: Buffer.from(JSON.stringify(payload)), headers: {}, query: hmac === undefined ? {} : { hmac } });
const badSignature = (e) => e instanceof AppError && e.code === 'WEBHOOK_SIGNATURE' && e.status === 400;

test('paymob HMAC: the 20 documented fields, in the documented order, reproduce the documented string', () => {
  assert.equal(HMAC_FIELDS.length, 20);
  assert.equal(HMAC_FIELDS[0], 'amount_cents');
  assert.equal(HMAC_FIELDS[13], 'order.id');
  assert.equal(HMAC_FIELDS[19], 'success');
  assert.equal(hmacString(transaction()), DOCUMENTED_STRING);
});

test('paymob HMAC: known vector (SHA-512, hex) and constant-time verification', () => {
  assert.equal(createHmac('sha512', TEST_SECRET).update(DOCUMENTED_STRING).digest('hex'), EXPECTED_HMAC); // the vector itself
  assert.equal(computeHmac(transaction(), TEST_SECRET), EXPECTED_HMAC);
  assert.equal(verifyHmac(transaction(), EXPECTED_HMAC, TEST_SECRET), true);
  assert.equal(verifyHmac(transaction(), EXPECTED_HMAC.toUpperCase(), TEST_SECRET), true);
  assert.equal(verifyHmac(transaction({ amount_cents: 1 }), EXPECTED_HMAC, TEST_SECRET), false);
  assert.equal(verifyHmac(transaction(), EXPECTED_HMAC, 'another_secret'), false);
  assert.equal(verifyHmac(transaction(), EXPECTED_HMAC.slice(0, 64), TEST_SECRET), false);
  assert.equal(verifyHmac(transaction(), '', TEST_SECRET), false);
  assert.equal(verifyHmac(transaction(), undefined, TEST_SECRET), false);
});

test('paymob: not created without its env group; wallet appears only with its integration id', () => {
  assert.equal(create(config({ PAYMOB_HMAC_SECRET: '' }), {}), null);
  assert.deepEqual(make().provider.capabilities().methods, ['card']);
  assert.deepEqual(make(undefined, { PAYMOB_INTEGRATION_ID_WALLET: '222222' }).provider.capabilities(), { countries: ['EG'], currencies: ['EGP'], methods: ['card', 'wallet'], refunds: true });
});

test('paymob: createCheckout posts the intention and answers the unified checkout URL', async () => {
  const { fetch, provider } = make();
  const out = await provider.createCheckout({ order: egOrder(), items: items(), shipping: shipping(), payment: egPayment(), urls: urls() });
  assert.equal(fetch.calls.length, 1);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, 'https://accept.paymob.com/v1/intention/');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Token egy_sk_test_fake');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.amount, 8399);
  assert.equal(body.currency, 'EGP');
  assert.deepEqual(body.payment_methods, [111111]);
  assert.deepEqual(body.items, [{ name: 'Halos Off Hoodie', amount: 5900, quantity: 1 }, { name: 'Horns Cap', amount: 1000, quantity: 2 }, { name: 'الشحن', amount: 499, quantity: 1 }]);
  assert.equal(body.items.reduce((s, i) => s + i.amount * i.quantity, 0), body.amount);
  assert.equal(body.special_reference, 'checkout:7:1'); // the idempotency key
  assert.deepEqual(body.extras, { order_public_id: 'TCD-261112-AB2C', payment_id: '7' });
  assert.equal(body.notification_url, 'https://shop.example/api/webhooks/paymob');
  assert.equal(body.redirection_url, urls().success);
  assert.equal(body.billing_data.phone_number, '+201000000000');
  assert.equal(body.billing_data.first_name, 'Test');
  assert.equal(body.billing_data.last_name, 'Buyer');
  assert.equal(body.billing_data.email, 'buyer@example.com');
  assert.deepEqual(out, { kind: 'redirect', url: 'https://eg.checkout.paymob.com/?publicKey=egy_pk_test_fake&clientSecret=egy_csk_test_abc', providerRef: '217503754', expiresAt: 1794400000000 + 31 * 60 * 1000 });
});

test('paymob: wallet uses its own integration id; wrong currency and missing wallet are refused before any call', async () => {
  const wallet = make(undefined, { PAYMOB_INTEGRATION_ID_WALLET: '222222' });
  await wallet.provider.createCheckout({ order: egOrder(), items: items(), shipping: shipping(), payment: egPayment({ method: 'wallet' }), urls: urls() });
  assert.deepEqual(wallet.fetch.calls[0].body.payment_methods, [222222]);
  const { fetch, provider } = make();
  await assert.rejects(provider.createCheckout({ order: egOrder(), items: items(), shipping: shipping(), payment: egPayment({ method: 'wallet' }), urls: urls() }), (e) => e.code === 'PAYMOB_NO_WALLET');
  await assert.rejects(provider.createCheckout({ order: order(), items: items(), shipping: shipping(), payment: payment(), urls: urls() }), (e) => e.code === 'PAYMOB_CURRENCY_NOT_SERVED');
  assert.equal(fetch.calls.length, 0);
});

test('paymob: HTTP and network failures become ProviderError with the right retry flag', async () => {
  const input = { order: egOrder(), items: items(), shipping: shipping(), payment: egPayment(), urls: urls() };
  await assert.rejects(make(fetchStub({ status: 503 })).provider.createCheckout(input), (e) => e instanceof ProviderError && e.retryable === true && e.status === 503);
  await assert.rejects(make(fetchStub({ status: 429 })).provider.createCheckout(input), (e) => e.retryable === true);
  await assert.rejects(make(fetchStub({ status: 400, json: { detail: 'x' } })).provider.createCheckout(input), (e) => e.retryable === false && e.code === 'PAYMOB_HTTP_400');
  await assert.rejects(make(fetchStub(new TypeError('fetch failed'))).provider.createCheckout(input), (e) => e.retryable === true && e.code === 'PAYMOB_NETWORK');
  await assert.rejects(make(fetchStub({ json: { id: 'x' } })).provider.createCheckout(input), (e) => e.code === 'PAYMOB_BAD_RESPONSE');
});

test('paymob webhook: valid HMAC accepted; tampered, wrong-secret, missing and non-transaction payloads rejected', async () => {
  const { provider } = make();
  const events = await post(provider, callback(), EXPECTED_HMAC);
  assert.deepEqual(events, [{ providerRef: '217503754', amount: 100000, currency: 'EGP', occurredAt: Date.parse('2024-06-13T11:33:44.592345'), eventId: 'txn:192036465:paid', type: 'payment.succeeded', providerPaymentRef: '192036465' }]);
  await assert.rejects(post(provider, callback(transaction({ amount_cents: 1 })), EXPECTED_HMAC), badSignature);
  await assert.rejects(post(provider, callback(transaction({ success: false })), EXPECTED_HMAC), badSignature);
  await assert.rejects(post(provider, callback(), computeHmac(transaction(), 'another_secret')), badSignature);
  await assert.rejects(post(provider, callback(), undefined), badSignature);
  await assert.rejects(post(provider, { type: 'TOKEN', obj: transaction() }, EXPECTED_HMAC), badSignature);
  await assert.rejects(post(provider, {}, EXPECTED_HMAC), badSignature);
  await assert.rejects(provider.parseWebhook({ rawBody: Buffer.from('not json'), headers: {}, query: { hmac: EXPECTED_HMAC } }), badSignature);
});

test('paymob webhook: event mapping for declined, pending, refund and reversed-parent callbacks', async () => {
  const { provider } = make();
  const send = (obj) => post(provider, callback(obj), computeHmac(obj, TEST_SECRET)).then((e) => e[0]);
  const declined = await send(transaction({ id: 5, success: false }));
  assert.deepEqual({ t: declined.type, id: declined.eventId, ref: declined.providerRef }, { t: 'payment.failed', id: 'txn:5:failed', ref: '217503754' });
  assert.equal((await send(transaction({ id: 6, success: false, pending: true }))).type, 'ignored');
  const refund = await send(transaction({ id: 9, is_refund: true, has_parent_transaction: true, parent_transaction: 192036465, amount_cents: 2500 }));
  assert.deepEqual({ t: refund.type, id: refund.eventId, pay: refund.providerPaymentRef, amount: refund.amount }, { t: 'refund.succeeded', id: 'txn:9:refund', pay: '192036465', amount: 2500 });
  assert.equal((await send(transaction({ id: 10, is_refund: true, success: false, parent_transaction: 192036465 }))).type, 'refund.failed');
  const parent = await send(transaction({ is_refunded: true })); // the original transaction, repeated after its refund
  assert.deepEqual({ t: parent.type, id: parent.eventId }, { t: 'ignored', id: 'txn:192036465:reversed' });
  assert.equal(mapTransaction(transaction()).eventId, 'txn:192036465:paid'); // same delivery twice → same id → deduped
});

test('paymob: refund posts transaction id and amount; a decline throws', async () => {
  const ok = make(fetchStub({ json: { type: 'TRANSACTION', obj: { id: 777, success: true, pending: false, parent_transaction: 192036465 } } }));
  const out = await ok.provider.refund({ payment: { id: 7, providerRef: '217503754', providerPaymentRef: '192036465' }, amount: 2500, reason: 'x', idempotencyKey: 'refund:7:2500' });
  assert.deepEqual(out, { status: 'succeeded', refundRef: '777' });
  assert.equal(ok.fetch.calls[0].url, 'https://accept.paymob.com/api/acceptance/void_refund/refund');
  assert.deepEqual(ok.fetch.calls[0].body, { transaction_id: 192036465, amount_cents: 2500 });
  assert.equal(ok.fetch.calls[0].init.headers.Authorization, 'Token egy_sk_test_fake');
  await assert.rejects(make(fetchStub({ json: { id: 778, success: false, pending: false } })).provider.refund({ payment: { providerPaymentRef: '1' }, amount: 5, reason: '', idempotencyKey: 'k' }), (e) => e.code === 'PAYMOB_REFUND_FAILED');
  await assert.rejects(ok.provider.refund({ payment: {}, amount: 5, reason: '', idempotencyKey: 'k' }), (e) => e.code === 'PAYMOB_NOT_PAID');
});

test('paymob: getPayment reports pending when the (unverified) inquiry is refused, and rethrows what can be retried', async () => {
  assert.deepEqual(await make(fetchStub({ status: 404 })).provider.getPayment('217503754'), { status: 'pending', providerPaymentRef: undefined, amount: undefined, currency: 'EGP' });
  assert.deepEqual(await make(fetchStub({ json: { id: 192036465, success: true, pending: false, amount_cents: 100000, currency: 'EGP' } })).provider.getPayment('217503754'), { status: 'succeeded', providerPaymentRef: '192036465', amount: 100000, currency: 'EGP' });
  await assert.rejects(make(fetchStub({ status: 502 })).provider.getPayment('217503754'), (e) => e.retryable === true);
});
