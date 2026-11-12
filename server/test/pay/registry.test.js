// Provider selection by country and currency; only configured providers load. Owner: pay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPayments } from '../../payments/registry.js';
import { assertPaymentProvider } from '../../payments/interface.js';
import { create as createSaudi, placeholder as saudi } from '../../payments/saudi.js';
import { create as createCod } from '../../payments/cod.js';
import { ProviderError } from '../../lib/errors.js';
import { config, quiet, order, payment } from './helpers.js';

const suppliers = (cod) => ({ list: () => [{ id: 'printlet', capabilities: { cod } }] });
const ids = (reg, country, currency) => reg.forDestination({ country, currency }).map((x) => x.provider.id);

test('registry: nothing loads when commerce is off or when no provider is configured', () => {
  assert.deepEqual(loadPayments(config({ COMMERCE_MODE: '' }), { log: quiet }).list(), []);
  const bare = loadPayments(config({ STRIPE_ES_SECRET_KEY: '', STRIPE_AE_WEBHOOK_SECRET: '', PAYMOB_HMAC_SECRET: '' }), { log: quiet });
  assert.deepEqual(bare.list(), []);
  assert.equal(bare.get('stripe_es'), null);
});

test('registry: each provider loads only with its whole env group', () => {
  const all = loadPayments(config(), { log: quiet, suppliers: suppliers(true) });
  assert.deepEqual(all.list().map((p) => p.id), ['stripe_es', 'stripe_ae', 'paymob', 'cod']);
  for (const p of all.list()) assertPaymentProvider(p);
  const onlyEs = loadPayments(config({ STRIPE_AE_SECRET_KEY: '', PAYMOB_SECRET_KEY: '' }), { log: quiet });
  assert.deepEqual(onlyEs.list().map((p) => p.id), ['stripe_es']);
});

test('registry: mock mode loads only the mock provider, which serves everything', () => {
  const reg = loadPayments(config({ COMMERCE_MODE: 'mock' }), { log: quiet, suppliers: suppliers(true) });
  assert.deepEqual(reg.list().map((p) => p.id), ['mock']);
  assert.deepEqual(reg.get('mock').capabilities(), { countries: '*', currencies: ['EUR', 'GBP', 'CAD', 'USD', 'AED', 'SAR', 'EGP'], methods: ['card', 'cod'], refunds: true });
  assert.deepEqual(ids(reg, 'JP', 'EUR'), ['mock']);
});

test('forDestination: one country of each region goes to the right account', () => {
  const reg = loadPayments(config({ PAYMOB_INTEGRATION_ID_WALLET: '222222' }), { log: quiet, suppliers: suppliers(true) });
  assert.deepEqual(ids(reg, 'ES', 'EUR'), ['stripe_es']); // EU
  assert.deepEqual(ids(reg, 'GB', 'GBP'), ['stripe_es']); // UK
  assert.deepEqual(ids(reg, 'CA', 'CAD'), ['stripe_es']);
  assert.deepEqual(ids(reg, 'US', 'USD'), ['stripe_es']);
  assert.deepEqual(ids(reg, 'AE', 'AED'), ['stripe_ae']);
  assert.deepEqual(ids(reg, 'KW', 'AED'), ['stripe_ae']); // GCC in AED
  assert.deepEqual(ids(reg, 'SA', 'SAR'), ['stripe_ae']);
  assert.deepEqual(ids(reg, 'EG', 'EGP'), ['paymob', 'cod']);
  assert.deepEqual(reg.methodsFor({ country: 'EG', currency: 'EGP' }), [{ method: 'card', provider: 'paymob' }, { method: 'wallet', provider: 'paymob' }, { method: 'cod', provider: 'cod' }]);
  assert.deepEqual(reg.methodsFor({ country: 'es', currency: 'eur' }), [{ method: 'card', provider: 'stripe_es' }]);
});

test('forDestination: wrong currency for the country, or an unserved country, gets nothing', () => {
  const reg = loadPayments(config(), { log: quiet, suppliers: suppliers(true) });
  assert.deepEqual(ids(reg, 'ES', 'AED'), []);
  assert.deepEqual(ids(reg, 'AE', 'EUR'), []);
  assert.deepEqual(ids(reg, 'EG', 'EUR'), []);
  assert.deepEqual(ids(reg, 'JP', 'EUR'), []);
  assert.deepEqual(ids(reg, 'SA', 'EGP'), []);
});

test('capabilities: Stripe accounts and Paymob', () => {
  const reg = loadPayments(config(), { log: quiet });
  const es = reg.get('stripe_es').capabilities();
  assert.equal(es.countries.length, 30);
  assert.deepEqual(es.currencies, ['EUR', 'GBP', 'CAD', 'USD']);
  assert.deepEqual(reg.get('stripe_ae').capabilities(), { countries: ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'], currencies: ['AED', 'SAR'], methods: ['card'], refunds: true });
  assert.deepEqual(reg.get('paymob').capabilities(), { countries: ['EG'], currencies: ['EGP'], methods: ['card'], refunds: true });
});

test('cod: exists only while a loaded supplier collects cash; confirms at once; no refund', async () => {
  assert.equal(loadPayments(config(), { log: quiet, suppliers: suppliers(false) }).get('cod'), null);
  assert.equal(loadPayments(config(), { log: quiet }).get('cod'), null);
  assert.equal(createCod(config({ COMMERCE_MODE: '' }), { suppliers: suppliers(true) }), null);
  const cod = loadPayments(config(), { log: quiet, suppliers: suppliers(true) }).get('cod');
  assert.deepEqual(cod.capabilities(), { countries: ['EG'], currencies: ['EGP'], methods: ['cod'], refunds: false });
  assert.deepEqual(await cod.createCheckout({ order: order({ currency: 'EGP', country: 'EG' }), payment: payment({ currency: 'EGP', method: 'cod' }) }), { kind: 'confirmed', providerRef: 'cod_TCD-261112-AB2C' });
  await assert.rejects(cod.refund({}), (e) => e instanceof ProviderError && e.code === 'COD_NO_REFUND' && e.retryable === false);
  await assert.rejects(cod.parseWebhook({}), (e) => e.status === 404);
  await assert.rejects(cod.createCheckout({ order: order(), payment: payment() }), (e) => e.code === 'COD_CURRENCY_NOT_SERVED');
});

test('saudi: placeholder has the whole interface, reports itself unavailable and is never loaded', async () => {
  assert.equal(createSaudi(config(), {}), null);
  assertPaymentProvider(saudi);
  assert.equal(saudi.available, false);
  assert.deepEqual(saudi.capabilities().methods, []);
  for (const call of [saudi.createCheckout({}), saudi.getPayment('x'), saudi.refund({}), saudi.parseWebhook({})]) {
    await assert.rejects(call, (e) => e instanceof ProviderError && e.code === 'SAUDI_UNAVAILABLE');
  }
  assert.equal(loadPayments(config(), { log: quiet }).get('saudi'), null);
});
