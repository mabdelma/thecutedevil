// Unit tests for core's pure modules. Owner: core. Contract: section k.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { createDb, isUniqueViolation } from '../db.js';
import { AppError } from '../lib/errors.js';
import { checkoutKey, orderToken, publicId, safeEqual, sha256, token } from '../lib/ids.js';
import { createLogger, redact, scrub } from '../lib/log.js';
import { createLimiter } from '../lib/ratelimit.js';
import { isDoubtfulText, isEmail, normalisePhone, tidy, validateCheckoutInput, validateQuoteInput } from '../lib/validate.js';
import { currencyOf, enabledCountries, EU_COUNTRIES, regionOf } from '../markets.js';
import { createCatalogue, getProduct, lineKey, parseFrontEndProducts, priceOf, validateCatalogue, variantKey, variantKeys, loadFrontEnd } from '../catalogue/index.js';
import { catalogue, CURRENCIES } from '../catalogue/products.js';
import { shippingOptions, loadShippingRates } from '../pricing/shipping.js';
import { computeTax, loadTaxRules } from '../pricing/tax.js';
import { loadRules } from '../routing/engine.js';
import { t, formatMoney } from '../i18n.js';
import { EMAIL_STRINGS_EN, renderEmail } from '../email/templates.js';
import * as states from '../orders/states.js';

const cfg = loadConfig({ COMMERCE_MODE: 'mock' });
const vctx = { config: cfg, catalogue: createCatalogue() };
const throwsCode = (fn, code, field) => assert.throws(fn, (err) => {
  assert.ok(err instanceof AppError, `expected AppError, got ${err}`);
  assert.equal(err.code, code);
  if (field) assert.ok(err.fields && field in err.fields, `expected field ${field} in ${JSON.stringify(err.fields)}`);
  return true;
});

/* ---- config --------------------------------------------------------------------------------------- */

test('config: modes, required variables and feature flags', () => {
  assert.equal(loadConfig({}).mode, 'off');
  assert.equal(loadConfig({}).databaseUrl, '');
  const mock = loadConfig({ COMMERCE_MODE: 'mock' });
  assert.equal(mock.mode, 'mock');
  assert.equal(mock.databaseUrl, 'sqlite:./data/mock.sqlite');
  assert.equal(loadConfig({ COMMERCE_MODE: 'live', DATABASE_URL: 'sqlite::memory:' }).mode, 'off'); // no PUBLIC_BASE_URL
  assert.equal(loadConfig({ COMMERCE_MODE: 'live', DATABASE_URL: 'sqlite::memory:', PUBLIC_BASE_URL: 'http://shop.test' }).mode, 'off'); // not https
  const live = loadConfig({ COMMERCE_MODE: 'LIVE', DATABASE_URL: 'sqlite::memory:', PUBLIC_BASE_URL: 'https://shop.test/' });
  assert.equal(live.mode, 'live');
  assert.equal(live.publicBaseUrl, 'https://shop.test');
  assert.deepEqual([...live.problems], []);
  assert.ok(loadConfig({ COMMERCE_MODE: 'live' }).problems.length >= 2);
  assert.ok(loadConfig({ COMMERCE_MODE: 'banana' }).problems[0].includes('banana'));
  assert.equal(mock.enableUS, false);
  assert.equal(loadConfig({ ENABLE_US: '1', ENABLE_UK: 'true' }).enableUS, true);
  assert.equal(loadConfig({ ENABLE_US: '1', ENABLE_UK: 'true' }).enableUK, true);
  assert.equal(mock.admin, null);
  assert.equal(loadConfig({ ADMIN_USER: 'a' }).admin, null);
  assert.deepEqual({ ...loadConfig({ ADMIN_USER: 'a', ADMIN_PASS: 'b' }).admin }, { user: 'a', pass: 'b' });
  assert.equal(mock.smtp, null);
  assert.equal(loadConfig({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f@x.test' }).smtp.port, 587);
  assert.equal(mock.cronSecret, '');
  assert.throws(() => { mock.mode = 'live'; }, TypeError); // frozen
});

/* ---- migration ------------------------------------------------------------------------------------- */

test('migration: up creates every table, down removes them, up again works (SQLite)', async () => {
  const db = createDb('sqlite::memory:');
  const tables = ['orders', 'order_items', 'payments', 'fulfilments', 'shipments', 'jobs', 'webhook_events', 'email_log', 'order_events'];
  try {
    await db.migrate.latest();
    for (const name of tables) assert.equal(await db.schema.hasTable(name), true, name);
    await db('jobs').insert({ type: 'x', payload: '{}', run_after: 1, idem_key: 'k', created_at: 1, updated_at: 1 });
    await assert.rejects(db('jobs').insert({ type: 'x', payload: '{}', run_after: 1, idem_key: 'k', created_at: 1, updated_at: 1 }), (err) => isUniqueViolation(err));
    await db.migrate.rollback(undefined, true);
    for (const name of tables) assert.equal(await db.schema.hasTable(name), false, name);
    await db.migrate.latest();
    assert.equal(await db.schema.hasTable('orders'), true);
  } finally { await db.destroy(); }
});

/* ---- state machines ------------------------------------------------------------------------------- */

test('order state machine: exactly the contract table; every other move is rejected', () => {
  const allowed = {
    pending_payment: ['confirmed', 'expired', 'cancelled'], expired: ['confirmed'], confirmed: ['processing', 'cancelled'],
    processing: ['partially_shipped', 'shipped', 'cancelled'], partially_shipped: ['shipped'], shipped: ['delivered'], delivered: [], cancelled: [],
  };
  assert.deepEqual(Object.keys(allowed).sort(), [...states.ORDER_STATUSES].sort());
  for (const from of states.ORDER_STATUSES) {
    for (const to of states.ORDER_STATUSES) {
      const ok = allowed[from].includes(to);
      assert.equal(states.canOrderGo(from, to), ok, `${from} → ${to}`);
      if (ok) states.assertOrderTransition(from, to); else throwsCode(() => states.assertOrderTransition(from, to), 'ILLEGAL_TRANSITION');
    }
  }
  throwsCode(() => states.assertOrderTransition('nonsense', 'confirmed'), 'ILLEGAL_TRANSITION');
});

test('fulfilment state machine: exactly the contract table; every other move is rejected', () => {
  const allowed = {
    pending: ['submitting', 'cancelled', 'manual'], submitting: ['submitted', 'in_production', 'pending', 'manual'],
    submitted: ['in_production', 'shipped', 'cancelled', 'manual'], in_production: ['shipped', 'manual'], shipped: ['delivered'],
    manual: ['submitted', 'shipped', 'cancelled'], delivered: [], cancelled: [],
  };
  assert.deepEqual(Object.keys(allowed).sort(), [...states.FULFILMENT_STATUSES].sort());
  for (const from of states.FULFILMENT_STATUSES) {
    for (const to of states.FULFILMENT_STATUSES) {
      const ok = allowed[from].includes(to);
      assert.equal(states.canFulfilmentGo(from, to), ok, `${from} → ${to}`);
      if (!ok) throwsCode(() => states.assertFulfilmentTransition(from, to), 'ILLEGAL_TRANSITION');
    }
  }
});

test('payment status tables: refunds and COD', () => {
  assert.ok(states.canPaymentStatusGo('unpaid', 'paid'));
  assert.ok(states.canPaymentStatusGo('paid', 'refund_pending'));
  assert.ok(states.canPaymentStatusGo('refund_pending', 'refunded'));
  assert.ok(states.canPaymentStatusGo('cod_due', 'cod_collected'));
  assert.equal(states.canPaymentStatusGo('refunded', 'paid'), false);
  assert.equal(states.canPaymentStatusGo('cod_collected', 'cod_due'), false);
  assert.equal(states.canPaymentStatusGo('unpaid', 'refunded'), false);
  assert.ok(states.canPaymentRowGo('pending', 'succeeded'));
  assert.ok(states.canPaymentRowGo('expired', 'succeeded')); // late payment
  assert.equal(states.canPaymentRowGo('succeeded', 'pending'), false);
  assert.equal(states.canPaymentRowGo('refunded', 'succeeded'), false);
  throwsCode(() => states.assertPaymentRowTransition('refunded', 'succeeded'), 'ILLEGAL_TRANSITION');
  throwsCode(() => states.assertPaymentStatusTransition('refunded', 'paid'), 'ILLEGAL_TRANSITION');
});

test('derived order status and legal paths', () => {
  assert.equal(states.deriveOrderStatus([]), null);
  assert.equal(states.deriveOrderStatus(['pending']), null);
  assert.equal(states.deriveOrderStatus(['manual', 'pending']), null);
  assert.equal(states.deriveOrderStatus(['submitted', 'pending']), 'processing');
  assert.equal(states.deriveOrderStatus(['shipped', 'in_production']), 'partially_shipped');
  assert.equal(states.deriveOrderStatus(['shipped', 'delivered']), 'shipped');
  assert.equal(states.deriveOrderStatus(['delivered', 'cancelled']), 'delivered');
  assert.equal(states.deriveOrderStatus(['cancelled', 'cancelled']), null);
  assert.deepEqual(states.orderPath('confirmed', 'delivered'), ['processing', 'shipped', 'delivered']);
  assert.deepEqual(states.orderPath('confirmed', 'partially_shipped'), ['processing', 'partially_shipped']);
  assert.deepEqual(states.orderPath('partially_shipped', 'delivered'), ['shipped', 'delivered']);
  assert.deepEqual(states.orderPath('shipped', 'processing'), []); // never backwards
  assert.deepEqual(states.orderPath('cancelled', 'shipped'), []);
  assert.deepEqual(states.orderPath('pending_payment', 'shipped'), []);
  assert.deepEqual(states.fulfilmentPath('submitted', 'delivered'), ['shipped', 'delivered']);
  assert.deepEqual(states.fulfilmentPath('shipped', 'submitted'), []);
  assert.deepEqual(states.fulfilmentPath('pending', 'shipped'), []);
  assert.deepEqual(states.fulfilmentPath('cancelled', 'shipped'), []);
});

/* ---- markets, ids, log, limiter --------------------------------------------------------------------- */

test('markets: region and currency follow the country; US and UK are behind flags', () => {
  assert.equal(EU_COUNTRIES.length, 27);
  assert.deepEqual([regionOf('ES'), currencyOf('ES')], ['EU', 'EUR']);
  assert.deepEqual([regionOf('GB'), currencyOf('GB')], ['UK', 'GBP']);
  assert.deepEqual([regionOf('CA'), currencyOf('CA')], ['CA', 'CAD']);
  assert.deepEqual([regionOf('US'), currencyOf('US')], ['US', 'USD']);
  assert.deepEqual([regionOf('AE'), currencyOf('AE')], ['AE', 'AED']);
  assert.deepEqual([regionOf('SA'), currencyOf('SA')], ['GCC', 'SAR']);
  for (const c of ['KW', 'QA', 'BH', 'OM']) assert.deepEqual([regionOf(c), currencyOf(c)], ['GCC', 'AED']);
  assert.deepEqual([regionOf('EG'), currencyOf('EG')], ['EG', 'EGP']);
  assert.equal(regionOf('BR'), null);
  assert.equal(currencyOf('BR'), null);
  const off = enabledCountries(loadConfig({}));
  assert.ok(!off.includes('US') && !off.includes('GB') && off.includes('ES') && off.includes('EG'));
  const on = enabledCountries(loadConfig({ ENABLE_US: '1', ENABLE_UK: '1' }));
  assert.ok(on.includes('US') && on.includes('GB'));
});

test('ids: order reference, tokens, constant-time compare, checkout-derived token', () => {
  assert.match(publicId(Date.UTC(2026, 0, 5)), /^TCD-260105-[A-HJ-NP-Z2-9]{4}$/);
  assert.match(token(), /^[0-9a-f]{64}$/);
  assert.notEqual(token(), token());
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', undefined), false);
  const id = '3b241101-e2bb-4255-8caf-4136c566a962';
  assert.match(orderToken(id), /^[0-9a-f]{64}$/);
  assert.equal(orderToken(id), orderToken(id));
  assert.notEqual(orderToken(id), orderToken('3b241101-e2bb-4255-8caf-4136c566a963'));
  assert.equal(checkoutKey(id).length, 36);
  assert.ok(!checkoutKey(id).includes(id.slice(0, 8)));
});

test('log: sensitive keys and e-mail addresses never reach the sink', () => {
  const lines = [];
  const log = createLogger({ info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l), log: (l) => lines.push(l) });
  log.info('order.created', { order: 'TCD-1', email: 'a@b.test', phone: '+34600', apiKey: 'sk_live_abc', token: 'zzz', nested: { password: 'p', authorization: 'Bearer x', ok: 1 } });
  log.error('failed for buyer@example.test with Bearer abc.def and sk_test_123456');
  log.warn(new Error('boom for x@y.test'));
  const all = lines.join('\n');
  for (const secret of ['a@b.test', '+34600', 'sk_live_abc', 'zzz', 'buyer@example.test', 'abc.def', 'sk_test_123456', 'x@y.test', '"p"']) assert.ok(!all.includes(secret), secret);
  assert.ok(all.includes('order=TCD-1') && all.includes('"ok":1'));
  assert.equal(lines.length, 3);
  assert.deepEqual(redact({ SMTP_PASS: 'x', list: [{ secret: 1 }] }), { SMTP_PASS: '[redacted]', list: [{ secret: '[redacted]' }] });
  assert.equal(scrub('mail me at who@where.test'), 'mail me at [email]');
});

test('rate limiter: fixed window per key, blocks, reset', () => {
  let now = 1000;
  const limiter = createLimiter({ now: () => now });
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.hit('quote', 'ip1', 3, 60000).ok, true);
  const over = limiter.hit('quote', 'ip1', 3, 60000);
  assert.equal(over.ok, false);
  assert.equal(over.retryAfterMs, 60000);
  assert.equal(limiter.hit('quote', 'ip2', 3, 60000).ok, true); // another IP
  assert.equal(limiter.hit('checkout', 'ip1', 3, 60000).ok, true); // another bucket
  now += 60000;
  assert.equal(limiter.hit('quote', 'ip1', 3, 60000).ok, true); // new window
  assert.equal(limiter.blockedFor('login', 'ip1'), 0);
  limiter.block('login', 'ip1', 900000);
  assert.equal(limiter.blockedFor('login', 'ip1'), 900000);
  now += 900001;
  assert.equal(limiter.blockedFor('login', 'ip1'), 0);
  limiter.hit('x', 'ip', 1, 1000);
  limiter.clear('x', 'ip');
  assert.equal(limiter.hit('x', 'ip', 1, 1000).ok, true);
  limiter.reset();
  assert.equal(limiter.hit('quote', 'ip1', 1, 60000).ok, true);
});

/* ---- catalogue ------------------------------------------------------------------------------------- */

test('catalogue: all 12 products, prices in seven currencies, variant keys and prices', () => {
  assert.equal(catalogue.length, 12);
  assert.deepEqual(CURRENCIES, ['EUR', 'GBP', 'CAD', 'USD', 'AED', 'SAR', 'EGP']);
  const hoodie = getProduct('halos-off-hoodie');
  assert.equal(variantKey(hoodie, { size: 'M' }), 'size=M');
  assert.equal(variantKey(getProduct('horns-down-cap'), {}), 'default');
  assert.equal(lineKey(hoodie, { size: 'M' }), 'halos-off-hoodie|size=M');
  assert.equal(lineKey(getProduct('horns-down-cap'), {}), 'horns-down-cap');
  assert.equal(lineKey(hoodie, { size: 'M' }, { name: 'ALEX' }), 'halos-off-hoodie|size=M|@name=ALEX');
  assert.deepEqual(variantKeys(hoodie), ['size=S', 'size=M', 'size=L', 'size=XL']);
  assert.equal(priceOf(hoodie, { size: 'M' }, 'EUR'), 7900);
  assert.equal(priceOf(hoodie, { size: 'M' }, 'EUR', { name: 'ALEX' }), 8400); // + surcharge
  assert.equal(priceOf(hoodie, { size: 'M' }, 'EGP'), 249900);
  const scent = getProduct('secret-no-1');
  assert.equal(priceOf(scent, { volume: '30 ml' }, 'EUR'), 4200);
  assert.equal(priceOf(scent, { volume: '100 ml' }, 'EUR'), 10400);
  assert.throws(() => priceOf(hoodie, { size: 'M' }, 'JPY'), /no JPY price/);
  for (const id of ['secret-no-1', 'sweet-nothing', 'after-midnight', 'morning-alibi', 'little-devil-earbuds', 'hot-head-power-bank', 'night-shift-lamp', 'the-tail-cable']) assert.equal(getProduct(id).sellable, false, id);
  const view = createCatalogue();
  assert.equal(view.isPurchasable('halos-off-hoodie'), true);
  assert.equal(view.isPurchasable('two-sides-socks'), false); // sellable but "soon" on the site
  assert.equal(view.isPurchasable('secret-no-1'), false); // live on the site but never sold online
  assert.equal(view.nameOf('halos-off-hoodie'), "halo's off hoodie");
});

test('catalogue validation: passes on the real files, including the front-end id and option check', () => {
  const result = validateCatalogue();
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(loadFrontEnd().size, 12);
});

test('catalogue validation: catches bad prices, unknown ids, option drift and unmapped variants', () => {
  const frontEnd = new Map(parseFrontEndProducts(`
    const SIZES = ['S', 'M'];
    const volume = (a) => ({ name: 'volume', values: ['30 ml'], prices: { '30 ml': a } });
    export const products = [
      { id: 'tee', name: "it's a tee", options: [{ name: 'size', values: SIZES, default: 'M' }], status: 'live' },
      { id: 'scent', name: 'scent', options: [volume(42)], status: 'soon' },
      { id: 'ghost', name: 'ghost', options: [], status: 'live' },
    ];`).map((p) => [p.id, p]));
  assert.deepEqual(frontEnd.get('tee'), { id: 'tee', name: "it's a tee", status: 'live', options: [{ name: 'size', values: ['S', 'M'] }] });
  assert.deepEqual(frontEnd.get('scent').options, [{ name: 'volume', values: ['30 ml'] }]);
  const price = { EUR: 100, GBP: 100, CAD: 100, USD: 100, AED: 100, SAR: 100, EGP: 100 };
  const good = [
    { id: 'tee', category: 'apparel', sellable: true, weightG: 100, options: [{ name: 'size', values: ['S', 'M'] }], price },
    { id: 'scent', category: 'fragrance', sellable: false, weightG: 100, options: [{ name: 'volume', values: ['30 ml'] }], price },
    { id: 'ghost', category: 'tote', sellable: false, weightG: 100, options: [], price },
  ];
  assert.equal(validateCatalogue({ catalogue: good, frontEnd }).ok, true);
  const has = (cat, extra, text) => {
    const r = validateCatalogue({ catalogue: cat, frontEnd, ...extra });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes(text)), `${text} not in ${JSON.stringify(r.errors)}`);
  };
  has([{ ...good[0], price: { ...price, SAR: 0 } }, good[1], good[2]], {}, 'SAR must be a positive integer');
  has([{ ...good[0], price: { ...price, EGP: 10.5 } }, good[1], good[2]], {}, 'EGP');
  has([{ ...good[0], price: { EUR: 100 } }, good[1], good[2]], {}, 'GBP');
  has([good[0], good[1]], {}, 'ghost is not in the catalogue');
  has([{ ...good[0], options: [{ name: 'size', values: ['S', 'L'] }] }, good[1], good[2]], {}, 'options differ');
  has([{ ...good[0], category: 'boat' }, good[1], good[2]], {}, 'unknown category');
  has([{ ...good[0], variantPrices: { 'size=XXL': price } }, good[1], good[2]], {}, 'not a variant');
  has([{ ...good[0], personalisation: [{ key: 'name', type: 'text', maxLength: 5, pattern: '([' }] }, good[1], good[2]], {}, 'does not compile');
  has(good, { frontEnd: new Map() }, 'no product ids found');
  const rules = { rules: [{ category: 'apparel', region: 'EU', candidates: ['printful'] }] };
  has(good, { mapping: {}, rules }, 'no supplier mapping');
  has(good, { mapping: { tee: { 'size=S': [{ supplier: 'printful' }] } }, rules }, 'tee [size=M]');
  assert.equal(validateCatalogue({ catalogue: good, frontEnd, mapping: { tee: { '*': [{ supplier: 'printful' }] } }, rules }).ok, true);
  assert.equal(validateCatalogue({ catalogue: good, frontEnd, mapping: {}, rules: { rules: [{ category: 'apparel', region: '*', candidates: ['manual'] }] } }).ok, true);
  assert.equal(validateCatalogue({ catalogue: good, frontEnd, mapping: {}, rules, mockSuppliers: true }).ok, true);
});

/* ---- shipping and tax ------------------------------------------------------------------------------- */

test('shipping: base + per extra item, free from a subtotal, one price per order', () => {
  const rates = { EU: { EUR: { base: 499, perExtraItem: 150, freeFrom: 9000 } }, CA: { CAD: { base: 899 } } };
  const eu = { region: 'EU' };
  assert.deepEqual(shippingOptions([{ qty: 1, total: 7900 }], eu, 'EUR', rates), [{ id: 'standard', amount: 499 }]);
  assert.equal(shippingOptions([{ qty: 2, total: 7000 }], eu, 'EUR', rates)[0].amount, 649);
  assert.equal(shippingOptions([{ qty: 1, total: 3500 }, { qty: 2, total: 5000 }], eu, 'EUR', rates)[0].amount, 799);
  assert.equal(shippingOptions([{ qty: 1, total: 8999 }], eu, 'EUR', rates)[0].amount, 499);
  assert.equal(shippingOptions([{ qty: 1, total: 9000 }], eu, 'EUR', rates)[0].amount, 0);
  assert.equal(shippingOptions([{ qty: 3, total: 999999 }], { region: 'CA' }, 'CAD', rates)[0].amount, 899); // no perExtra, no freeFrom
  throwsCode(() => shippingOptions([{ qty: 1, total: 1 }], { region: 'EU' }, 'USD', rates), 'MARKET_NOT_SERVED');
  throwsCode(() => shippingOptions([{ qty: 1, total: 1 }], { region: 'GCC' }, 'AED', rates), 'MARKET_NOT_SERVED');
});

test('shipping-rates.json: every enabled country has a rate in its own currency', () => {
  const rates = loadShippingRates();
  for (const country of enabledCountries(loadConfig({ ENABLE_US: '1', ENABLE_UK: '1' }))) {
    const [o] = shippingOptions([{ qty: 1, total: 100 }], { region: regionOf(country) }, currencyOf(country), rates);
    assert.ok(Number.isInteger(o.amount) && o.amount >= 0, country);
  }
});

test('tax: inclusive = gross × r / (1 + r); parts always add up; exclusive markets at rate 0 with a duties notice', () => {
  const es = computeTax({ country: 'ES', lines: [{ key: 'a', total: 7900 }], shipping: 499 });
  assert.deepEqual({ included: es.included, rateBp: es.rateBp, amount: es.amount, labelKey: es.labelKey }, { included: true, rateBp: 2100, amount: 1458, labelKey: 'checkout.tax.vatIncluded' }); // the contract's example
  assert.deepEqual(es.lines, [{ key: 'a', amount: 1371 }]);
  assert.equal(es.shippingAmount, 87);
  assert.deepEqual(es.notices, []);
  const many = computeTax({ country: 'DE', lines: [{ key: 'a', total: 333 }, { key: 'b', total: 333 }, { key: 'c', total: 335 }], shipping: 0 });
  assert.equal(many.amount, Math.round((1001 * 1900) / 11900));
  assert.equal(many.lines.reduce((n, l) => n + l.amount, 0) + many.shippingAmount, many.amount);
  const ca = computeTax({ country: 'CA', lines: [{ key: 'a', total: 11900 }], shipping: 899 });
  assert.deepEqual({ included: ca.included, rateBp: ca.rateBp, amount: ca.amount }, { included: false, rateBp: 0, amount: 0 });
  assert.deepEqual(ca.notices, ['checkout.notice.dutiesMayApply']);
  const kw = computeTax({ country: 'KW', lines: [{ key: 'a', total: 1000 }], shipping: 0 });
  assert.deepEqual({ included: kw.included, rateBp: kw.rateBp, amount: kw.amount, notices: kw.notices }, { included: true, rateBp: 0, amount: 0, notices: ['checkout.notice.dutiesMayApply'] });
  assert.equal(computeTax({ country: 'AE', lines: [{ key: 'a', total: 10500 }], shipping: 0 }).amount, 500);
  assert.equal(computeTax({ country: 'EG', lines: [{ key: 'a', total: 11400 }], shipping: 0 }).amount, 1400);
  const added = computeTax({ country: 'XX', lines: [{ key: 'a', total: 1000 }], shipping: 500 }, { countries: { XX: { included: false, rateBp: 1000 } } });
  assert.deepEqual({ amount: added.amount, lines: added.lines, shippingAmount: added.shippingAmount, labelKey: added.labelKey }, { amount: 150, lines: [{ key: 'a', amount: 100 }], shippingAmount: 50, labelKey: 'checkout.tax.added' });
  throwsCode(() => computeTax({ country: 'BR', lines: [], shipping: 0 }), 'MARKET_NOT_SERVED');
});

test('tax-rules.json and rules.json: every country has a rule; blocked categories and a catch-all exist', () => {
  const tax = loadTaxRules();
  for (const country of enabledCountries(loadConfig({ ENABLE_US: '1', ENABLE_UK: '1' }))) assert.ok(tax.countries[country], country);
  const rules = loadRules();
  assert.ok(rules.blocked.some((b) => b.category === 'fragrance') && rules.blocked.some((b) => b.category === 'electronics'));
  assert.deepEqual(rules.rules[rules.rules.length - 1], { category: '*', region: '*', candidates: [] });
  for (const c of CURRENCIES) assert.ok(rules.costFx[c] > 0, c);
  const known = ['printful', 'printify', 'gelato', 'printlet', 'manual'];
  for (const r of rules.rules) for (const s of r.candidates.flat()) assert.ok(known.includes(s), `${r.category}/${r.region}: ${s}`);
});

/* ---- validation ------------------------------------------------------------------------------------- */

const item = (extra = {}) => ({ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' }, ...extra });
const quoteBody = (extra = {}) => ({ country: 'ES', items: [item()], ...extra });
const checkout = (extra = {}) => ({
  country: 'ES', items: [item()], checkoutId: '3b241101-e2bb-4255-8caf-4136c566a962', shippingOption: 'standard', paymentMethod: 'card',
  customer: { name: 'Test Person', email: 'buyer@example.test' }, address: { line1: 'Calle Falsa 123', city: 'Valladolid', postcode: '47001' },
  acceptTerms: true, expectedTotal: 8399, ...extra,
});

test('validation: tidy, e-mail, phone, doubtful personalisation', () => {
  assert.equal(tidy('  a\u0000b \n\t c​ '), 'a b c');
  assert.equal(tidy(null), '');
  for (const ok of ['a@b.co', 'first.last+tag@sub.example.com']) assert.equal(isEmail(ok), true, ok);
  for (const bad of ['', 'a', 'a@b', 'a@@b.co', 'a b@c.co', 'a@b..co', '@b.co', 'a@.co', `${'x'.repeat(190)}@b.co`, 'a@b.c']) assert.equal(isEmail(bad), false, bad);
  assert.equal(normalisePhone('+34 622-20 99 35'), '+34622209935');
  for (const bad of ['622209935', '+0123456789', '+34', '+34abc', '']) assert.equal(normalisePhone(bad), '', bad);
  assert.equal(isDoubtfulText('ALEX'), false);
  assert.equal(isDoubtfulText('N.I.K.E'), true);
  assert.equal(isDoubtfulText('D1sney'), true);
});

test('validation (quote): country, items, qty, options, personalisation, lang, payment method', () => {
  const ok = validateQuoteInput(quoteBody({ lang: 'ar', postcode: ' 47001 ', paymentMethod: 'card', junk: 1 }), vctx);
  assert.deepEqual({ country: ok.country, region: ok.region, currency: ok.currency, lang: ok.lang, postcode: ok.postcode, paymentMethod: ok.paymentMethod }, { country: 'ES', region: 'EU', currency: 'EUR', lang: 'ar', postcode: '47001', paymentMethod: 'card' });
  assert.equal(ok.items[0].key, 'halos-off-hoodie|size=M');
  assert.equal(ok.items[0].variantKey, 'size=M');
  assert.equal(validateQuoteInput(quoteBody({ lang: 'xx' }), vctx).lang, 'en');
  assert.equal(validateQuoteInput(quoteBody({ country: 'es' }), vctx).country, 'ES');
  throwsCode(() => validateQuoteInput(null, vctx), 'VALIDATION');
  throwsCode(() => validateQuoteInput([], vctx), 'VALIDATION');
  throwsCode(() => validateQuoteInput(quoteBody({ country: '' }), vctx), 'VALIDATION', 'country');
  throwsCode(() => validateQuoteInput(quoteBody({ country: 'BR' }), vctx), 'MARKET_NOT_SERVED');
  throwsCode(() => validateQuoteInput(quoteBody({ country: 'US' }), vctx), 'MARKET_NOT_SERVED'); // flag off
  assert.equal(validateQuoteInput(quoteBody({ country: 'US' }), { ...vctx, config: loadConfig({ COMMERCE_MODE: 'mock', ENABLE_US: '1' }) }).currency, 'USD');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [] }), vctx), 'CART_EMPTY');
  throwsCode(() => validateQuoteInput({ country: 'ES' }, vctx), 'CART_EMPTY');
  throwsCode(() => validateQuoteInput(quoteBody({ items: 'x' }), vctx), 'VALIDATION', 'items');
  throwsCode(() => validateQuoteInput(quoteBody({ items: Array.from({ length: 21 }, () => item()) }), vctx), 'VALIDATION', 'items');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ id: 'nope' })] }), vctx), 'VALIDATION', 'items.0.id');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ id: '__proto__' })] }), vctx), 'VALIDATION', 'items.0.id');
  for (const qty of [0, 11, 1.5, '2', -1, null]) throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ qty })] }), vctx), 'VALIDATION', 'items.0.qty');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ options: {} })] }), vctx), 'VALIDATION', 'items.0.options');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ options: { size: 'XXL' } })] }), vctx), 'VALIDATION', 'items.0.options.size');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ options: { size: 'M', colour: 'red' } })] }), vctx), 'VALIDATION', 'items.0.options');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [{ id: 'horns-down-cap', qty: 1, options: { size: 'M' } }] }), vctx), 'VALIDATION', 'items.0.options');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ qty: 6 }), item({ qty: 6 })] }), vctx), 'VALIDATION', 'items.1.qty'); // merged over 10
  assert.equal(validateQuoteInput(quoteBody({ items: [item({ qty: 2 }), item({ qty: 3 })] }), vctx).items[0].qty, 5);
  const p = validateQuoteInput(quoteBody({ items: [item({ personalisation: { name: '  Álex  ' } })] }), vctx).items[0];
  assert.deepEqual(p.personalisation, { name: 'Álex' });
  assert.equal(p.key, 'halos-off-hoodie|size=M|@name=Álex');
  assert.equal(validateQuoteInput(quoteBody({ items: [item({ personalisation: { name: '' } })] }), vctx).items[0].personalisation, null);
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ personalisation: { name: 'THIRTEEN CHARS' } })] }), vctx), 'VALIDATION', 'items.0.personalisation.name');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ personalisation: { name: '<b>x</b>' } })] }), vctx), 'VALIDATION', 'items.0.personalisation.name');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ personalisation: { colour: 'x' } })] }), vctx), 'VALIDATION', 'items.0.personalisation.colour');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [item({ personalisation: 'x' })] }), vctx), 'VALIDATION', 'items.0.personalisation');
  throwsCode(() => validateQuoteInput(quoteBody({ items: [{ id: 'horns-down-cap', qty: 1, options: {}, personalisation: { name: 'x' } }] }), vctx), 'VALIDATION', 'items.0.personalisation.name');
  throwsCode(() => validateQuoteInput(quoteBody({ paymentMethod: 'bitcoin' }), vctx), 'VALIDATION', 'paymentMethod');
  throwsCode(() => validateQuoteInput(quoteBody({ postcode: 'x'.repeat(21) }), vctx), 'VALIDATION', 'postcode');
  assert.equal(validateQuoteInput(quoteBody({ items: [{ id: 'secret-no-1', qty: 1, options: { volume: '50 ml' } }] }), vctx).items[0].purchasable, false); // reported by the quote, not rejected here
});

test('validation (checkout): every customer and address field', () => {
  const ok = validateCheckoutInput(checkout({ customer: { name: ' Test   Person ', email: 'buyer@example.test', phone: '+34 600 000 000' }, note: ' hi ' }), vctx);
  assert.deepEqual(ok.customer, { name: 'Test Person', email: 'buyer@example.test', phone: '+34600000000' });
  assert.deepEqual(ok.address, { line1: 'Calle Falsa 123', line2: null, city: 'Valladolid', state: null, postcode: '47001' });
  assert.equal(ok.note, 'hi');
  assert.equal(validateCheckoutInput(checkout({ customer: { name: 'Test Person', email: 'buyer@example.test' } }), vctx).customer.phone, null); // optional in the EU
  const bad = (extra, field) => throwsCode(() => validateCheckoutInput(checkout(extra), vctx), 'VALIDATION', field);
  bad({ checkoutId: 'abc' }, 'checkoutId');
  bad({ checkoutId: undefined }, 'checkoutId');
  bad({ paymentMethod: undefined }, 'paymentMethod');
  bad({ shippingOption: '' }, 'shippingOption');
  bad({ acceptTerms: 'true' }, 'acceptTerms');
  bad({ acceptTerms: false }, 'acceptTerms');
  bad({ expectedTotal: '8399' }, 'expectedTotal');
  bad({ expectedTotal: -1 }, 'expectedTotal');
  bad({ expectedTotal: 83.99 }, 'expectedTotal');
  bad({ customer: { name: 'A', email: 'buyer@example.test' } }, 'customer.name');
  bad({ customer: { name: 'x'.repeat(61), email: 'buyer@example.test' } }, 'customer.name');
  bad({ customer: { name: 'Test Person', email: 'nope' } }, 'customer.email');
  bad({ customer: { name: 'Test Person', email: 'buyer@example.test', phone: '600000000' } }, 'customer.phone');
  bad({ customer: undefined }, 'customer.name');
  bad({ address: { line1: 'ab', city: 'Valladolid', postcode: '47001' } }, 'address.line1');
  bad({ address: { line1: 'x'.repeat(192), city: 'Valladolid', postcode: '47001' } }, 'address.line1');
  bad({ address: { line1: 'Calle Falsa 123', line2: 'x'.repeat(192), city: 'Valladolid', postcode: '47001' } }, 'address.line2');
  bad({ address: { line1: 'Calle Falsa 123', city: 'V', postcode: '47001' } }, 'address.city');
  bad({ address: { line1: 'Calle Falsa 123', city: 'x'.repeat(121), postcode: '47001' } }, 'address.city');
  bad({ address: { line1: 'Calle Falsa 123', city: 'Valladolid' } }, 'address.postcode'); // required in the EU
  bad({ address: { line1: 'Calle Falsa 123', city: 'Valladolid', postcode: '4700!' } }, 'address.postcode');
  bad({ address: undefined }, 'address.line1');
  bad({ note: 'x'.repeat(301) }, 'note');
  // Egypt: phone required, postcode optional; COD always needs a phone
  const eg = { country: 'EG', address: { line1: '12 Tahrir Street', city: 'Banha' } };
  bad({ ...eg, customer: { name: 'Test Person', email: 'buyer@example.test' } }, 'customer.phone');
  assert.equal(validateCheckoutInput(checkout({ ...eg, customer: { name: 'Test Person', email: 'buyer@example.test', phone: '+201000000000' } }), vctx).address.postcode, null);
  bad({ paymentMethod: 'cod', customer: { name: 'Test Person', email: 'buyer@example.test' } }, 'customer.phone');
  // several problems are reported together
  assert.throws(() => validateCheckoutInput(checkout({ acceptTerms: false, customer: { name: '', email: '' }, address: {} }), vctx), (err) => Object.keys(err.fields).length >= 5);
});

/* ---- i18n and e-mail -------------------------------------------------------------------------------- */

test('i18n: language file → English file → built-in English → key; placeholders; money', () => {
  const fallback = { 'x.only.builtin': 'Built in {n}' };
  assert.equal(t('en', 'nav.shop'), 'shop');
  assert.notEqual(t('ar', 'nav.shop'), 'nav.shop');
  assert.equal(t('zz', 'nav.shop'), 'shop'); // unknown language → en
  assert.equal(t('es', 'x.only.builtin', { n: 2 }, { fallback }), 'Built in 2');
  assert.equal(t('es', 'x.nowhere'), 'x.nowhere');
  assert.equal(t('es', 'x.only.builtin', {}, { fallback, strings: { 'x.only.builtin': 'Sobrescrito' } }), 'Sobrescrito');
  assert.equal(t('en', 'x.only.builtin', {}, { fallback }), 'Built in {n}'); // a missing variable stays visible
  assert.equal(formatMoney(7900, 'EUR', 'en'), '€79.00');
  assert.ok(formatMoney(249900, 'EGP', 'ar').length > 0);
});

const order = {
  public_id: 'TCD-260101-ABCD', ship_name: 'Test <b>Person</b>', ship_city: 'Valladolid', country: 'ES', currency: 'EUR', lang: 'en',
  subtotal: 7900, shipping_total: 499, tax_total: 1458, tax_included: 1, total: 8399, payment_method: 'card',
};
const items = [{ name: "halo's off hoodie", qty: 1, line_total: 7900, options: '{"size":"M"}', personalisation: '{"name":"ALEX"}' }];

test('e-mail templates: every template renders; HTML is escaped; subject is one line; Arabic is RTL', () => {
  const confirmed = renderEmail('order_confirmed', 'en', { order, items, split: true });
  assert.equal(confirmed.subject, 'Your order TCD-260101-ABCD is confirmed');
  assert.ok(confirmed.text.includes("halo's off hoodie · M · \"ALEX\" × 1: €79.00"));
  assert.ok(confirmed.text.includes('Total: €83.99') && confirmed.text.includes('Includes tax: €14.58'));
  assert.ok(confirmed.text.includes('separate parcels') && confirmed.text.includes('cannot be returned'));
  assert.ok(confirmed.html.includes('Test &lt;b&gt;Person&lt;/b&gt;') && !confirmed.html.includes('<b>Person</b>'));
  assert.ok(confirmed.html.includes('dir="ltr"'));
  assert.ok(!/\{\w+\}/.test(confirmed.text), 'no unfilled placeholder');
  const cod = renderEmail('order_confirmed', 'en', { order: { ...order, payment_method: 'cod' }, items });
  assert.ok(cod.text.includes('cash'));
  const shipped = renderEmail('shipped', 'en', { order, items, shipment: { carrier: 'DHL', tracking_number: 'TRK1', tracking_url: 'https://track.test/1' }, moreToCome: true });
  assert.ok(shipped.text.includes('Tracking: DHL TRK1') && shipped.text.includes('https://track.test/1') && shipped.text.includes('another parcel'));
  assert.ok(shipped.html.includes('href="https://track.test/1"'));
  const evil = renderEmail('shipped', 'en', { order: { ...order, public_id: 'TCD\r\nBcc: x@y.test' }, items, shipment: { tracking_number: 'T', tracking_url: 'javascript:alert(1)' } });
  assert.ok(!evil.subject.includes('\n') && !evil.subject.includes('\r'));
  assert.ok(!evil.html.includes('javascript:'));
  const cancelled = renderEmail('order_cancelled', 'en', { order, amount: 8399 });
  assert.ok(cancelled.text.includes('cancelled') && cancelled.text.includes('€83.99'));
  assert.ok(!renderEmail('order_cancelled', 'en', { order, amount: 0 }).text.includes('refunded'));
  assert.ok(renderEmail('refund_issued', 'en', { order, amount: 500 }).text.includes('€5.00'));
  const alert = renderEmail('owner_alert', 'ar', { order, alert: { reason: 'NO_SUPPLIER_LEFT', message: 'parcel 1', adminUrl: 'https://shop.test/api/admin/orders/TCD-260101-ABCD' } });
  assert.ok(alert.subject.includes('TCD-260101-ABCD') && alert.subject.includes('NO_SUPPLIER_LEFT'));
  assert.ok(alert.html.includes('dir="ltr"')); // owner alerts are always English
  assert.ok(alert.text.includes('cancel-order.js'));
  assert.throws(() => renderEmail('nope', 'en', { order }), /unknown e-mail template/);
  const ar = renderEmail('order_confirmed', 'ar', { order, items });
  assert.ok(ar.html.includes('dir="rtl"') && ar.html.includes('lang="ar"'));
});

test('e-mail language fallback: a key missing from the dictionaries uses the built-in English; strings override', () => {
  // an empty dictionary directory: every key must come from EMAIL_STRINGS_EN
  for (const [key, text] of Object.entries(EMAIL_STRINGS_EN)) assert.equal(t('fr', key, undefined, { fallback: EMAIL_STRINGS_EN, dir: '/nonexistent' }), text, key);
  const custom = renderEmail('order_confirmed', 'es', { order, items }, { 'email.order_confirmed.subject': 'Pedido {id} confirmado', 'email.order_confirmed.intro': 'Gracias.' });
  assert.equal(custom.subject, 'Pedido TCD-260101-ABCD confirmado');
  assert.ok(custom.text.includes('Gracias.'));
  assert.ok(custom.html.includes('lang="es"'));
  // every key the templates read is listed (so `web` can translate it) and no placeholder is left unfilled
  for (const lang of ['en', 'es', 'ar', 'ja']) {
    for (const [template, data] of [['order_confirmed', { order, items, split: true }], ['shipped', { order, items, shipment: { carrier: 'DHL', tracking_number: 'T1' }, moreToCome: true }], ['order_cancelled', { order, amount: 100 }], ['refund_issued', { order, amount: 100 }]]) {
      const mail = renderEmail(template, lang, data);
      assert.ok(!/\{\w+\}/.test(mail.text), `${template}/${lang}: unfilled placeholder in ${mail.text}`);
      assert.ok(!/\bemail\.[a-z_]+\.[a-zA-Z]+\b/.test(mail.text), `${template}/${lang}: raw key in text`);
    }
  }
});
