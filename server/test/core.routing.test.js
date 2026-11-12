// Routing engine tests. Owner: core. Contract: section e (precedence, tiers, tie-breaks, split, blocked, COD, manual).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canRouteStatic, findRule, isBlocked, loadRules, mappingFor, route, toTiers } from '../routing/engine.js';
import { fakeSupplier, fakeSuppliers } from './core-fakes.js';

const EU = { country: 'ES', region: 'EU' };
const line = (key, category = 'apparel', extra = {}) => ({ key, productId: key, variantKey: 'default', category, qty: 1, personalisation: null, ...extra });
const map = (supplier, amount, { regions = ['EU', 'CA', 'EG'], currency = 'EUR', days = [4, 9] } = {}) => ({ supplier, productRef: 'p', variantRef: 'v', regions, cost: { amount, currency }, days });

function setup({ rules, mapping, suppliers = ['a', 'b', 'c'], cod = [], mode = 'live' }) {
  const adapters = Object.fromEntries(suppliers.map((id) => [id, fakeSupplier(id, { cod: cod.includes(id) })]));
  const ctx = { config: { mode }, suppliers: fakeSuppliers(Object.values(adapters)), mapping, rules: { version: 1, costFx: { EUR: 1, USD: 0.9, EGP: 0.02 }, blocked: [], ...rules } };
  return { ctx, adapters };
}

test('rule lookup: category+region, then category+*, then *+region, then *+*', () => {
  const rules = { rules: [
    { category: '*', region: '*', candidates: ['d'] }, { category: '*', region: 'EU', candidates: ['c'] },
    { category: 'apparel', region: '*', candidates: ['b'] }, { category: 'apparel', region: 'EU', candidates: ['a'] },
  ] };
  assert.deepEqual(findRule(rules, 'apparel', 'EU').candidates, ['a']);
  assert.deepEqual(findRule(rules, 'apparel', 'CA').candidates, ['b']);
  assert.deepEqual(findRule(rules, 'tote', 'EU').candidates, ['c']);
  assert.deepEqual(findRule(rules, 'tote', 'CA').candidates, ['d']);
  assert.equal(findRule({ rules: [] }, 'tote', 'CA'), null);
  assert.deepEqual(toTiers(['a', ['b', 'c'], [], 7, '']), [['a'], ['b', 'c']]);
  assert.equal(isBlocked({ blocked: [{ category: 'fragrance', region: '*' }] }, 'fragrance', 'EU'), true);
  assert.equal(isBlocked({ blocked: [{ category: 'tote', region: 'EG' }] }, 'tote', 'EU'), false);
});

test('candidates are tried in listed order: the first eligible supplier wins even when it costs more', async () => {
  const { ctx } = setup({ rules: { rules: [{ category: 'apparel', region: 'EU', candidates: ['a', 'b', 'c'] }] }, mapping: { tee: { '*': [map('a', 3000), map('b', 1000), map('c', 500)] } } });
  const r = await route([line('tee')], EU, ctx);
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.fulfilments.length, 1);
  assert.equal(r.fulfilments[0].supplier, 'a');
  assert.deepEqual(r.fulfilments[0].candidates, ['a', 'b', 'c']);
  assert.deepEqual(r.fulfilments[0].lineKeys, ['tee']);
  assert.equal(r.fulfilments[0].quote.total, 3400);
});

test('a tier is ranked by landed cost (converted with costFx), then days, then listed order', async () => {
  const rules = { rules: [{ category: 'apparel', region: 'EU', candidates: [['a', 'b'], 'c'] }] };
  let s = setup({ rules, mapping: { tee: { '*': [map('a', 3000), map('b', 2000), map('c', 100)] } } });
  let r = await route([line('tee')], EU, s.ctx);
  assert.deepEqual(r.fulfilments[0].candidates, ['b', 'a', 'c']); // cheaper first inside the tier; c stays last although cheapest
  // currency conversion: 3000 USD × 0.9 = 2700 + shipping  <  2900 EUR + shipping
  s = setup({ rules, mapping: { tee: { '*': [map('a', 3000, { currency: 'USD' }), map('b', 2900), map('c', 100)] } } });
  s.adapters.a.quoteOverride = (lines) => ({ supplier: 'a', currency: 'USD', itemsCost: 3000, shippingCost: 0, total: 3000, minDays: 4, maxDays: 9, shippingMethod: 'x', source: 'api' });
  s.adapters.b.quoteOverride = () => ({ supplier: 'b', currency: 'EUR', itemsCost: 2900, shippingCost: 0, total: 2900, minDays: 4, maxDays: 9, shippingMethod: 'x', source: 'api' });
  r = await route([line('tee')], EU, s.ctx);
  assert.equal(r.fulfilments[0].supplier, 'a');
  // same cost → fewer days wins
  s = setup({ rules, mapping: { tee: { '*': [map('a', 2000, { days: [5, 12] }), map('b', 2000, { days: [3, 8] }), map('c', 100)] } } });
  r = await route([line('tee')], EU, s.ctx);
  assert.equal(r.fulfilments[0].supplier, 'b');
  // same cost and days → listed order
  s = setup({ rules, mapping: { tee: { '*': [map('a', 2000), map('b', 2000), map('c', 100)] } } });
  r = await route([line('tee')], EU, s.ctx);
  assert.equal(r.fulfilments[0].supplier, 'a');
});

test('filter: not loaded, no mapping, region not listed, isAvailable false, isAvailable throwing', async () => {
  const rules = { rules: [{ category: 'apparel', region: 'EU', candidates: ['ghost', 'a', 'b', 'c'] }] };
  const s = setup({ rules, mapping: { tee: { '*': [map('a', 1000, { regions: ['CA'] }), map('b', 1000), map('c', 1000)], 'size=M': [map('c', 900)] } } });
  let r = await route([line('tee')], EU, s.ctx);
  assert.deepEqual(r.fulfilments[0].candidates, ['b', 'c']); // ghost is not loaded, a does not list EU
  s.adapters.b.unavailable.add('tee');
  r = await route([line('tee')], EU, s.ctx);
  assert.deepEqual(r.fulfilments[0].candidates, ['c']);
  s.adapters.c.isAvailable = async () => { throw new Error('boom'); };
  r = await route([line('tee')], EU, s.ctx);
  assert.deepEqual(r.fulfilments, []);
  assert.deepEqual(r.unavailable, [{ key: 'tee', reason: 'NOT_AVAILABLE_IN_REGION' }]);
  // exact variant key wins over '*'
  assert.equal(mappingFor(s.ctx, 'c', 'tee', 'size=M').cost.amount, 900);
  assert.equal(mappingFor(s.ctx, 'c', 'tee', 'size=L').cost.amount, 1000);
  assert.equal(mappingFor(s.ctx, 'c', 'unknown', 'default'), null);
});

test('blocked category, empty candidate list and a product region allow-list make a line unavailable', async () => {
  const s = setup({
    rules: { blocked: [{ category: 'fragrance', region: '*' }], rules: [{ category: 'apparel', region: 'EU', candidates: ['a'] }, { category: 'fragrance', region: 'EU', candidates: ['a'] }, { category: '*', region: '*', candidates: [] }] },
    mapping: { tee: { '*': [map('a', 1000)] }, scent: { '*': [map('a', 1000)] }, mug: { '*': [map('a', 1000)] }, cap: { '*': [map('a', 1000)] } },
  });
  s.ctx.catalogue = { get: (id) => (id === 'cap' ? { id, regions: ['CA'] } : { id }) };
  const r = await route([line('tee'), line('scent', 'fragrance'), line('mug', 'drinkware'), line('cap')], EU, s.ctx);
  assert.deepEqual(r.fulfilments.map((f) => f.lineKeys), [['tee']]);
  assert.deepEqual(r.unavailable.map((u) => u.key).sort(), ['cap', 'mug', 'scent']);
  assert.equal(canRouteStatic(s.ctx, { id: 'tee', category: 'apparel' }, 'default', 'EU'), true);
  assert.equal(canRouteStatic(s.ctx, { id: 'scent', category: 'fragrance' }, 'default', 'EU'), false);
  assert.equal(canRouteStatic(s.ctx, { id: 'cap', category: 'apparel', regions: ['CA'] }, 'default', 'EU'), false);
});

test('split: one fulfilment per supplier; the supplier covering most lines is picked first', async () => {
  const s = setup({
    rules: { rules: [
      { category: 'apparel', region: 'EU', candidates: [['a', 'b'], 'c'] }, { category: 'headwear', region: 'EU', candidates: ['a', 'c'] },
      { category: 'wall_art', region: 'EU', candidates: ['b', 'a'] }, { category: 'tote', region: 'EU', candidates: ['c'] },
    ] },
    mapping: {
      hoodie: { '*': [map('a', 3000), map('b', 2000), map('c', 2500)] }, cap: { '*': [map('a', 1400), map('c', 1300)] },
      poster: { '*': [map('b', 900), map('a', 950)] }, tote: { '*': [map('c', 700)] },
    },
  });
  // hoodie + cap: a is in the best tier of both → one parcel from a, although b is cheaper for the hoodie
  let r = await route([line('hoodie'), line('cap', 'headwear')], EU, s.ctx);
  assert.equal(r.fulfilments.length, 1);
  assert.equal(r.fulfilments[0].supplier, 'a');
  assert.deepEqual(r.fulfilments[0].lineKeys, ['hoodie', 'cap']);
  assert.deepEqual(r.fulfilments[0].candidates, ['a', 'c']); // only suppliers able to take BOTH lines
  assert.equal(r.fulfilments[0].quote.total, 3000 + 1400 + 400);
  // hoodie + poster: b covers both in their best tiers
  r = await route([line('hoodie'), line('poster', 'wall_art')], EU, s.ctx);
  assert.deepEqual(r.fulfilments.map((f) => [f.supplier, f.lineKeys]), [['b', ['hoodie', 'poster']]]);
  // cap + poster + tote: three suppliers, three parcels; every line is assigned exactly once
  r = await route([line('cap', 'headwear'), line('poster', 'wall_art'), line('tote', 'tote')], EU, s.ctx);
  assert.equal(r.fulfilments.length, 3);
  assert.deepEqual(r.fulfilments.flatMap((f) => f.lineKeys).sort(), ['cap', 'poster', 'tote']);
  assert.deepEqual(Object.fromEntries(r.fulfilments.map((f) => [f.lineKeys[0], f.supplier])), { cap: 'a', poster: 'b', tote: 'c' });
  // hoodie + cap + poster: a and b could each take two lines; b is cheaper for its pair, so b goes first and a gets the cap
  r = await route([line('hoodie'), line('cap', 'headwear'), line('poster', 'wall_art')], EU, s.ctx);
  assert.deepEqual(r.fulfilments.map((f) => [f.supplier, f.lineKeys]), [['b', ['hoodie', 'poster']], ['a', ['cap']]]);
  // one unavailable line does not stop the others from routing
  r = await route([line('hoodie'), line('mug', 'drinkware')], EU, s.ctx);
  assert.equal(r.fulfilments.length, 1);
  assert.deepEqual(r.unavailable, [{ key: 'mug', reason: 'NOT_AVAILABLE_IN_REGION' }]);
});

test('split tie-break: equal coverage → lower landed cost, then days, then name', async () => {
  const rules = { rules: [{ category: 'apparel', region: 'EU', candidates: [['b', 'a']] }] };
  let s = setup({ rules, mapping: { x: { '*': [map('a', 1000), map('b', 1000)] }, y: { '*': [map('a', 1000), map('b', 1200)] } } });
  let r = await route([line('x'), line('y')], EU, s.ctx);
  assert.equal(r.fulfilments[0].supplier, 'a'); // cheaper for the pair
  s = setup({ rules, mapping: { x: { '*': [map('a', 1000, { days: [6, 14] }), map('b', 1000, { days: [3, 7] })] } } });
  r = await route([line('x')], EU, s.ctx);
  assert.equal(r.fulfilments[0].supplier, 'b'); // faster
  s = setup({ rules, mapping: { x: { '*': [map('a', 1000), map('b', 1000)] } } });
  r = await route([line('x')], EU, s.ctx);
  assert.equal(r.fulfilments[0].supplier, 'b'); // listed first
});

test('quote failure or timeout falls back to the mapping table; an unknown cost ranks last', async () => {
  const rules = { rules: [{ category: 'apparel', region: 'EU', candidates: [['a', 'b']] }] };
  const s = setup({ rules, mapping: { x: { '*': [map('a', 1000), { ...map('b', 0), cost: undefined }] } } });
  s.adapters.a.quoteOverride = () => { throw new Error('supplier API down'); };
  s.adapters.b.quoteOverride = () => { throw new Error('supplier API down'); };
  const r = await route([{ ...line('x'), qty: 3 }], EU, s.ctx);
  assert.equal(r.fulfilments[0].supplier, 'a');
  assert.equal(r.fulfilments[0].quote.source, 'table');
  assert.equal(r.fulfilments[0].quote.total, 3000);
  assert.deepEqual([r.fulfilments[0].quote.minDays, r.fulfilments[0].quote.maxDays], [4, 9]);
  assert.deepEqual(r.fulfilments[0].candidates, ['a', 'b']);
});

test('COD: suppliers that cannot collect cash are dropped', async () => {
  const rules = { rules: [{ category: 'apparel', region: 'EG', candidates: ['a', 'b'] }] };
  const s = setup({ rules, cod: ['b'], mapping: { x: { '*': [map('a', 1000), map('b', 2000)] } } });
  const EG = { country: 'EG', region: 'EG' };
  assert.equal((await route([line('x')], EG, s.ctx)).fulfilments[0].supplier, 'a');
  const cod = await route([line('x')], EG, s.ctx, { cod: true });
  assert.equal(cod.fulfilments[0].supplier, 'b');
  assert.deepEqual(cod.fulfilments[0].candidates, ['b']);
  const none = setup({ rules, mapping: { x: { '*': [map('a', 1000), map('b', 2000)] } } });
  assert.deepEqual((await route([line('x')], EG, none.ctx, { cod: true })).unavailable, [{ key: 'x', reason: 'NOT_AVAILABLE_IN_REGION' }]);
  assert.equal(canRouteStatic(s.ctx, { id: 'x', category: 'apparel' }, 'default', 'EG', { cod: true }), true);
  assert.equal(canRouteStatic(none.ctx, { id: 'x', category: 'apparel' }, 'default', 'EG', { cod: true }), false);
});

test('manual: sold when the rule names it; after payment it is always the last fallback', async () => {
  const rules = { rules: [{ category: 'tote', region: 'EU', candidates: ['a', 'manual'], days: [10, 20] }, { category: 'apparel', region: 'EU', candidates: ['a'] }, { category: '*', region: '*', candidates: [] }] };
  const s = setup({ rules, mapping: { tee: { '*': [map('a', 1000)] } } }); // nothing maps the tote
  let r = await route([line('bag', 'tote')], EU, s.ctx);
  assert.deepEqual(r.unavailable, []);
  assert.deepEqual(r.fulfilments.map((f) => [f.supplier, f.candidates, f.quote.total, f.quote.minDays, f.quote.maxDays]), [['manual', ['manual'], 0, 10, 20]]);
  // at quote time a line nobody can make is unavailable…
  s.adapters.a.unavailable.add('tee');
  r = await route([line('tee')], EU, s.ctx);
  assert.deepEqual(r.unavailable, [{ key: 'tee', reason: 'NOT_AVAILABLE_IN_REGION' }]);
  // …but once the customer has paid, it is parked with a person instead
  r = await route([line('tee'), line('mug', 'drinkware'), line('bag', 'tote')], EU, s.ctx, { postPayment: true });
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.fulfilments.length, 1);
  assert.equal(r.fulfilments[0].supplier, 'manual');
  assert.deepEqual(r.fulfilments[0].lineKeys.sort(), ['bag', 'mug', 'tee']);
});

test('mock mode: the mock supplier stands in for every supplier the live table names', async () => {
  const mock = fakeSupplier('mock');
  const ctx = { config: { mode: 'mock' }, suppliers: fakeSuppliers([mock]), mapping: {}, rules: loadRules() };
  const r = await route([line('halos-off-hoodie')], EU, ctx);
  assert.deepEqual(r.fulfilments.map((f) => [f.supplier, f.candidates]), [['mock', ['mock']]]);
  assert.deepEqual((await route([line('secret-no-1', 'fragrance')], EU, ctx)).unavailable.length, 1); // still blocked
  assert.deepEqual((await route([line('halos-off-hoodie')], { country: 'SA', region: 'GCC' }, ctx)).unavailable.length, 1); // empty cell stays empty
});

test('the shipped routing table: study cells for the categories sold online', () => {
  const rules = loadRules();
  const cell = (category, region) => findRule(rules, category, region).candidates;
  assert.deepEqual(cell('apparel', 'EU'), [['printful', 'gelato'], 'printify']);
  assert.deepEqual(cell('apparel', 'CA'), ['printful', 'printify', 'gelato']);
  assert.deepEqual(cell('apparel', 'EG'), ['printlet']);
  assert.deepEqual(cell('headwear', 'EU'), ['printful', 'printify']);
  assert.deepEqual(cell('drinkware', 'CA'), ['printify', 'printful']);
  assert.deepEqual(cell('wall_art', 'AE'), ['gelato']); // the only confirmed Gulf cell
  for (const category of ['apparel', 'headwear', 'drinkware', 'phone_case', 'wall_art', 'tote', 'stationery', 'engraved']) assert.deepEqual(cell(category, 'GCC'), [], `${category}/GCC is unconfirmed`);
  assert.deepEqual(cell('drinkware', 'EG'), []);
  assert.deepEqual(cell('engraved', 'EU'), []);
  assert.deepEqual(cell('something_new', 'EU'), []); // catch-all: not sold
  assert.equal(isBlocked(rules, 'fragrance', 'AE'), true);
  assert.equal(isBlocked(rules, 'electronics', 'EU'), true);
});
