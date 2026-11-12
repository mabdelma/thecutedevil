// Stripe provider: session creation (client stubbed), webhook signatures, event mapping, refund. Owner: pay.
import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createStripe, STRIPE_API_VERSION, STRIPE_LOCALES, stripeLocale } from '../../payments/stripe.js';
import { AppError, ProviderError } from '../../lib/errors.js';
import { LANGS } from '../../markets.js';
import { config, quiet, order, items, shipping, payment, urls, stripeStub, LIVE_ENV } from './helpers.js';
import { session, event, charge, intent } from '../fixtures/pay/stripe-events.js';

const NOW = 1794400000000;
const make = (id = 'stripe_es', stub = stripeStub(), extra = {}) => ({ stub, provider: createStripe(id)(config(), { log: quiet, now: () => NOW, stripeClients: { [id]: stub }, t: () => 'Envío estándar', ...extra }) });
const signed = (payload, secret, timestamp = Math.floor(Date.now() / 1000)) => ({
  rawBody: Buffer.from(payload), query: {},
  headers: { 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp }) },
});
const deliver = (provider, evt, secret = LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET) => provider.parseWebhook(signed(JSON.stringify(evt), secret));
const badSignature = (e) => e instanceof AppError && e.code === 'WEBHOOK_SIGNATURE' && e.status === 400;

test('stripe: API version is pinned and equals the library default it was written for', () => {
  assert.equal(STRIPE_API_VERSION, '2026-10-28.endive');
  assert.equal(make().provider.apiVersion, STRIPE_API_VERSION);
  assert.equal(createStripe('stripe_es')(config({ STRIPE_ES_WEBHOOK_SECRET: '' }), {}), null);
});

test('stripe: every site language maps to a locale Stripe accepts', () => {
  const accepted = ['auto', 'de', 'en', 'es', 'fr', 'it', 'ja', 'pt', 'ru', 'zh'];
  for (const lang of LANGS) assert.ok(accepted.includes(stripeLocale(lang)), lang);
  assert.equal(Object.keys(STRIPE_LOCALES).length, 11);
  assert.equal(stripeLocale('ar'), 'auto'); // not in Stripe's list
  assert.equal(stripeLocale('hi'), 'auto');
  assert.equal(stripeLocale('xx'), 'auto');
  assert.equal(stripeLocale('FR'), 'fr');
});

test('stripe: createCheckout sends server amounts, currency, metadata, locale, URLs, expiry and the idempotency key', async () => {
  const { stub, provider } = make();
  const out = await provider.createCheckout({ order: order(), items: items(), shipping: shipping(), payment: payment(), urls: urls() });
  assert.equal(stub.calls.length, 1);
  const [params, options] = stub.calls[0].args;
  assert.deepEqual(options, { idempotencyKey: 'checkout:7:1' });
  assert.equal(params.mode, 'payment');
  assert.equal(params.ui_mode, 'hosted_page');
  assert.deepEqual(params.line_items, [
    { quantity: 1, price_data: { currency: 'eur', unit_amount: 5900, product_data: { name: 'Halos Off Hoodie' } } },
    { quantity: 2, price_data: { currency: 'eur', unit_amount: 1000, product_data: { name: 'Horns Cap' } } },
  ]);
  assert.deepEqual(params.shipping_options, [{ shipping_rate_data: { type: 'fixed_amount', display_name: 'Envío estándar', fixed_amount: { amount: 499, currency: 'eur' } } }]);
  const charged = params.line_items.reduce((s, l) => s + l.quantity * l.price_data.unit_amount, 0) + params.shipping_options[0].shipping_rate_data.fixed_amount.amount;
  assert.equal(charged, 8399);
  assert.deepEqual(params.metadata, { order_public_id: 'TCD-261112-AB2C', payment_id: '7' });
  assert.deepEqual(params.payment_intent_data.metadata, params.metadata);
  assert.equal(params.client_reference_id, 'TCD-261112-AB2C');
  assert.equal(params.customer_email, 'buyer@example.com');
  assert.equal(params.locale, 'es');
  assert.equal(params.success_url, urls().success);
  assert.equal(params.cancel_url, urls().cancel);
  assert.equal(params.expires_at, Math.floor(NOW / 1000) + 31 * 60);
  assert.equal(params.shipping_address_collection, undefined); // our own page collected the address
  assert.equal(params.payment_method_types, undefined); // methods come from the account's dashboard settings
  assert.deepEqual(out, { kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_stub', providerRef: 'cs_test_stub', expiresAt: params.expires_at * 1000 });
});

test('stripe: the UAE instance charges AED/SAR, Arabic falls back to auto, a foreign currency is refused before any call', async () => {
  const { stub, provider } = make('stripe_ae');
  await provider.createCheckout({ order: order({ lang: 'ar', currency: 'SAR', country: 'SA' }), items: items(), shipping: shipping(), payment: payment({ currency: 'SAR' }), urls: urls() });
  const [params] = stub.calls[0].args;
  assert.equal(params.locale, 'auto');
  assert.equal(params.line_items[0].price_data.currency, 'sar');
  await assert.rejects(provider.createCheckout({ order: order(), items: items(), shipping: shipping(), payment: payment({ currency: 'EUR' }), urls: urls() }), (e) => e instanceof ProviderError && e.code === 'STRIPE_CURRENCY_NOT_SERVED' && !e.retryable);
  assert.equal(stub.calls.length, 1);
});

test('stripe: lines that do not add up to the payment amount are sent as one line of exactly that amount', async () => {
  const { stub, provider } = make();
  await provider.createCheckout({ order: order(), items: items(), shipping: shipping(), payment: payment({ amount: 7899 }), urls: urls() }); // e.g. a discount
  const [params] = stub.calls[0].args;
  assert.deepEqual(params.line_items, [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 7899, product_data: { name: 'Order TCD-261112-AB2C' } } }]);
  assert.equal(params.shipping_options, undefined);
});

test('stripe: a session whose total differs from the order is expired and refused', async () => {
  const { stub, provider } = make('stripe_es', stripeStub({ create: () => ({ id: 'cs_x', url: 'https://checkout.stripe.com/x', amount_total: 1 }) }));
  await assert.rejects(provider.createCheckout({ order: order(), items: items(), shipping: shipping(), payment: payment(), urls: urls() }), (e) => e.code === 'STRIPE_AMOUNT_MISMATCH');
  assert.equal(stub.calls[1].name, 'sessions.expire');
});

test('stripe: library errors become ProviderError with the right retry flag', async () => {
  const failing = (err) => make('stripe_es', stripeStub({ create: () => { throw err; } })).provider.createCheckout({ order: order(), items: items(), shipping: shipping(), payment: payment(), urls: urls() });
  await assert.rejects(failing(Object.assign(new Error('down'), { type: 'StripeConnectionError' })), (e) => e instanceof ProviderError && e.retryable === true && e.provider === 'stripe_es');
  await assert.rejects(failing(Object.assign(new Error('slow down'), { type: 'StripeRateLimitError', statusCode: 429 })), (e) => e.retryable === true);
  await assert.rejects(failing(Object.assign(new Error('oops'), { type: 'StripeAPIError', statusCode: 500 })), (e) => e.retryable === true && e.status === 500);
  await assert.rejects(failing(Object.assign(new Error('bad param'), { type: 'StripeInvalidRequestError', statusCode: 400, code: 'parameter_invalid_integer' })), (e) => e.retryable === false && e.code === 'STRIPE_PARAMETER_INVALID_INTEGER');
  await assert.rejects(failing(Object.assign(new Error('bad key'), { type: 'StripeAuthenticationError', statusCode: 401 })), (e) => e.retryable === false);
});

test('stripe webhook: a valid signature is accepted and checkout.session.completed maps to payment.succeeded', async () => {
  const { provider } = make();
  const events = await deliver(provider, event('checkout.session.completed', session()));
  assert.deepEqual(events, [{ eventId: 'evt_fixture_checkout_session_completed', occurredAt: 1794400000000, type: 'payment.succeeded', providerRef: 'cs_test_fixture_001', providerPaymentRef: 'pi_fixture_001', amount: 8399, currency: 'EUR' }]);
});

test('stripe webhook: tampered body, missing header, stale timestamp and non-Buffer body are all rejected', async () => {
  const { provider } = make();
  const payload = JSON.stringify(event('checkout.session.completed', session()));
  const good = signed(payload, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET);
  await assert.rejects(provider.parseWebhook({ ...good, rawBody: Buffer.from(payload.replace('8399', '1')) }), badSignature);
  await assert.rejects(provider.parseWebhook({ ...good, headers: {} }), badSignature);
  await assert.rejects(provider.parseWebhook({ ...good, headers: { 'stripe-signature': 't=1,v1=00' } }), badSignature);
  await assert.rejects(provider.parseWebhook(signed(payload, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600)), badSignature);
  await assert.rejects(provider.parseWebhook({ ...good, rawBody: JSON.parse(payload) }), badSignature); // a parsed body can never be verified
  await assert.rejects(provider.parseWebhook({ ...good, rawBody: payload }), badSignature);
});

test('stripe webhook: the two accounts are separate (an ES event signed for ES is rejected by AE and the reverse)', async () => {
  const es = make('stripe_es').provider;
  const ae = make('stripe_ae').provider;
  const evt = event('checkout.session.completed', session());
  await assert.rejects(deliver(ae, evt, LIVE_ENV.STRIPE_ES_WEBHOOK_SECRET), badSignature);
  await assert.rejects(deliver(es, evt, LIVE_ENV.STRIPE_AE_WEBHOOK_SECRET), badSignature);
  assert.equal((await deliver(ae, evt, LIVE_ENV.STRIPE_AE_WEBHOOK_SECRET))[0].type, 'payment.succeeded');
});

test('stripe webhook: delayed payment methods', async () => {
  const { provider } = make();
  const waiting = await deliver(provider, event('checkout.session.completed', session({ payment_status: 'unpaid' })));
  assert.equal(waiting[0].type, 'ignored'); // completed but not paid yet: do not fulfil
  const ok = await deliver(provider, event('checkout.session.async_payment_succeeded', session()));
  assert.equal(ok[0].type, 'payment.succeeded');
  assert.equal(ok[0].providerRef, 'cs_test_fixture_001');
  const failed = await deliver(provider, event('checkout.session.async_payment_failed', session({ payment_status: 'unpaid' })));
  assert.equal(failed[0].type, 'payment.failed');
  assert.notEqual(ok[0].eventId, failed[0].eventId);
});

test('stripe webhook: expired session, foreign sessions and unknown types', async () => {
  const { provider } = make();
  const expired = await deliver(provider, event('checkout.session.expired', session({ status: 'expired', payment_status: 'unpaid', payment_intent: null })));
  assert.equal(expired[0].type, 'payment.expired');
  assert.equal(expired[0].providerRef, 'cs_test_fixture_001');
  assert.equal(expired[0].providerPaymentRef, undefined);
  assert.equal((await deliver(provider, event('checkout.session.completed', session({ metadata: {} }))))[0].type, 'ignored'); // e.g. a Payment Link
  assert.equal((await deliver(provider, event('checkout.session.completed', session({ mode: 'subscription' }))))[0].type, 'ignored');
  const other = await deliver(provider, event('customer.created', { id: 'cus_x', object: 'customer' }));
  assert.deepEqual(other, [{ eventId: 'evt_fixture_customer_created', occurredAt: 1794400000000, type: 'ignored' }]);
});

test('stripe webhook: payment_intent.payment_failed is a failure only once the session is closed', async () => {
  const open = make('stripe_es', stripeStub({ list: { data: [{ id: 'cs_test_fixture_001', status: 'open', payment_status: 'unpaid' }] } }));
  assert.equal((await deliver(open.provider, event('payment_intent.payment_failed', intent())))[0].type, 'ignored'); // the customer can still retry
  assert.deepEqual(open.stub.calls[0].args[0], { payment_intent: 'pi_fixture_001', limit: 1 });
  const closed = make('stripe_es', stripeStub({ list: { data: [{ id: 'cs_test_fixture_001', status: 'expired', payment_status: 'unpaid' }] } }));
  const [failed] = await deliver(closed.provider, event('payment_intent.payment_failed', intent()));
  assert.deepEqual({ type: failed.type, providerRef: failed.providerRef, providerPaymentRef: failed.providerPaymentRef, amount: failed.amount, currency: failed.currency }, { type: 'payment.failed', providerRef: 'cs_test_fixture_001', providerPaymentRef: 'pi_fixture_001', amount: 8399, currency: 'EUR' });
  const none = make('stripe_es', stripeStub({ list: { data: [] } }));
  assert.equal((await deliver(none.provider, event('payment_intent.payment_failed', intent())))[0].type, 'ignored');
  const foreign = make();
  assert.equal((await deliver(foreign.provider, event('payment_intent.payment_failed', intent({ metadata: {} }))))[0].type, 'ignored');
  assert.equal(foreign.stub.calls.length, 0);
  const down = make('stripe_es', stripeStub({ list: () => { throw Object.assign(new Error('down'), { type: 'StripeConnectionError' }); } }));
  await assert.rejects(deliver(down.provider, event('payment_intent.payment_failed', intent())), (e) => e instanceof ProviderError && e.retryable); // route answers 500, Stripe retries
});

test('stripe webhook: charge.refunded maps to refund.succeeded with this refund and the running total', async () => {
  const { provider } = make();
  const [full] = await deliver(provider, event('charge.refunded', charge()));
  assert.deepEqual(full, { eventId: 'evt_fixture_charge_refunded', occurredAt: 1794400000000, type: 'refund.succeeded', providerRef: 'cs_test_fixture_001', providerPaymentRef: 'pi_fixture_001', amount: 8399, totalRefunded: 8399, currency: 'EUR' });
  const [second] = await deliver(provider, event('charge.refunded', charge({ amount_refunded: 3000, refunded: false }), { data: { object: charge({ amount_refunded: 3000, refunded: false }), previous_attributes: { amount_refunded: 1000 } } }));
  assert.equal(second.amount, 2000);
  assert.equal(second.totalRefunded, 3000);
  const down = make('stripe_es', stripeStub({ list: () => { throw Object.assign(new Error('down'), { type: 'StripeConnectionError' }); } }));
  const [noRef] = await deliver(down.provider, event('charge.refunded', charge()));
  assert.equal(noRef.type, 'refund.succeeded'); // still delivered: core matches on providerPaymentRef
  assert.equal(noRef.providerRef, undefined);
  assert.equal((await deliver(provider, event('charge.refunded', charge({ metadata: {} }))))[0].type, 'ignored');
  const [failed] = await deliver(provider, event('refund.failed', { id: 're_x', object: 'refund', status: 'failed', amount: 500, currency: 'eur', payment_intent: 'pi_fixture_001', metadata: { order_public_id: 'TCD-261112-AB2C' } }));
  assert.deepEqual({ type: failed.type, ref: failed.providerPaymentRef, amount: failed.amount }, { type: 'refund.failed', ref: 'pi_fixture_001', amount: 500 });
});

test('stripe: getPayment maps session states', async () => {
  const state = async (retrieve) => (await make('stripe_es', stripeStub({ retrieve })).provider.getPayment('cs_test_stub'));
  assert.deepEqual(await state({ status: 'complete', payment_status: 'paid', amount_total: 8399, currency: 'eur', payment_intent: { id: 'pi_obj' } }), { status: 'succeeded', providerPaymentRef: 'pi_obj', amount: 8399, currency: 'EUR' });
  assert.equal((await state({ status: 'open', payment_status: 'unpaid', amount_total: 8399, currency: 'eur' })).status, 'pending');
  assert.equal((await state({ status: 'complete', payment_status: 'unpaid', amount_total: 8399, currency: 'eur' })).status, 'pending');
  assert.equal((await state({ status: 'expired', payment_status: 'unpaid', amount_total: 8399, currency: 'eur' })).status, 'expired');
});

test('stripe: refund uses the PaymentIntent, the amount and the idempotency key', async () => {
  const { stub, provider } = make();
  const out = await provider.refund({ payment: { id: 7, providerRef: 'cs_test_stub', providerPaymentRef: 'pi_stub' }, amount: 8399, reason: 'customer changed mind', idempotencyKey: 'refund:7:8399' });
  assert.deepEqual(out, { status: 'succeeded', refundRef: 're_stub' });
  assert.deepEqual(stub.calls[0].args, [{ payment_intent: 'pi_stub', amount: 8399, metadata: { payment_id: '7', reason: 'customer changed mind' } }, { idempotencyKey: 'refund:7:8399' }]);

  const snake = make(); // a raw database row, and no stored PaymentIntent: it is looked up from the session
  await snake.provider.refund({ payment: { id: 7, provider_ref: 'cs_test_stub', provider_payment_ref: null }, amount: 100, reason: 'requested_by_customer', idempotencyKey: 'refund:7:100' });
  assert.equal(snake.stub.calls[0].name, 'sessions.retrieve');
  assert.equal(snake.stub.calls[1].args[0].payment_intent, 'pi_stub');
  assert.equal(snake.stub.calls[1].args[0].reason, 'requested_by_customer');

  const pending = make('stripe_es', stripeStub({ refund: { id: 're_p', status: 'pending' } }));
  assert.equal((await pending.provider.refund({ payment: { providerPaymentRef: 'pi_stub' }, amount: 1, reason: '', idempotencyKey: 'k' })).status, 'pending');
  const failed = make('stripe_es', stripeStub({ refund: { id: 're_f', status: 'failed', failure_reason: 'insufficient_funds' } }));
  await assert.rejects(failed.provider.refund({ payment: { providerPaymentRef: 'pi_stub' }, amount: 1, reason: '', idempotencyKey: 'k' }), (e) => e.code === 'STRIPE_REFUND_FAILED');
  await assert.rejects(provider.refund({ payment: { providerPaymentRef: 'pi_stub' }, amount: 0, reason: '', idempotencyKey: 'k' }), (e) => e.code === 'STRIPE_BAD_AMOUNT');
  await assert.rejects(provider.refund({ payment: {}, amount: 5, reason: '', idempotencyKey: 'k' }), (e) => e.code === 'STRIPE_NOT_PAID');
});
