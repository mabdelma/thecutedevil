// Routing engine: which supplier makes which line. Owner: core. Contract: web/COMMERCE_ARCH.md section e.
// Driven by routing/rules.json (owner-editable). Used by /api/quote and again when an order is confirmed.
import { readFileSync } from 'node:fs';
import { mapping as defaultMapping } from '../catalogue/mapping.js';

export const loadRules = (file = new URL('./rules.json', import.meta.url)) => JSON.parse(readFileSync(file, 'utf8'));
let cachedRules = null;
export const rulesOf = (ctx) => ctx.rules || (cachedRules ||= loadRules());
const mappingOf = (ctx) => ctx.mapping || defaultMapping;

const ISAVAILABLE_TIMEOUT_MS = 2500;
const QUOTE_TIMEOUT_MS = 4000;
const DEFAULT_DAYS = [5, 14];
const MANUAL_DAYS = [7, 21];

const matches = (rule, category, region) => rule.category === category && rule.region === region;

/** A `blocked` entry matches when its category and region match (either may be '*'). */
export function isBlocked(rules, category, region) {
  return (rules.blocked || []).some((b) => (b.category === '*' || b.category === category) && (b.region === '*' || b.region === region));
}

/** Most specific rule wins: category+region, category+*, *+region, *+*. → rule | null */
export function findRule(rules, category, region) {
  const list = rules.rules || [];
  return list.find((r) => matches(r, category, region)) || list.find((r) => matches(r, category, '*'))
    || list.find((r) => matches(r, '*', region)) || list.find((r) => matches(r, '*', '*')) || null;
}

/** ["a", ["b", "c"]] → [["a"], ["b", "c"]] */
export const toTiers = (candidates) => (Array.isArray(candidates) ? candidates : [])
  .map((c) => (Array.isArray(c) ? c.filter((s) => typeof s === 'string' && s) : typeof c === 'string' && c ? [c] : [])).filter((t) => t.length > 0);

/** In mock mode the mock supplier stands in for every real supplier a rule names (rules.json stays the live table). */
const mockStandsIn = (ctx) => ctx.config?.mode === 'mock' && Boolean(ctx.suppliers?.has('mock'));

function tiersFor(ctx, category, region) {
  const rules = rulesOf(ctx);
  if (isBlocked(rules, category, region)) return { blocked: true, tiers: [], rule: null };
  const rule = findRule(rules, category, region);
  let tiers = toTiers(rule?.candidates);
  if (mockStandsIn(ctx)) {
    tiers = tiers.map((tier) => Array.from(new Set(tier.map((s) => (s === 'manual' ? s : 'mock')))));
    tiers = tiers.filter((tier, i) => tiers.findIndex((other) => other.join() === tier.join()) === i);
  }
  return { blocked: false, tiers, rule };
}

/**
 * This supplier's mapping entry for a variant (exact variant key first, then '*'), or null.
 * `manual` needs no mapping; the mock supplier gets a generated one when `sup` has not listed it.
 */
export function mappingFor(ctx, supplierId, productId, variantKey, { region, rule } = {}) {
  if (supplierId === 'manual') return { supplier: 'manual', productRef: productId, variantRef: variantKey, regions: region ? [region] : [], days: rule?.days || MANUAL_DAYS };
  const product = mappingOf(ctx)[productId];
  const pick = (entries) => (Array.isArray(entries) ? entries.find((e) => e && e.supplier === supplierId) : null);
  const found = product ? pick(product[variantKey]) || pick(product['*']) : null;
  if (found) return found;
  if (supplierId === 'mock' && mockStandsIn(ctx)) {
    return { supplier: 'mock', productRef: productId, variantRef: variantKey, regions: ['EU', 'UK', 'CA', 'US', 'AE', 'GCC', 'EG'], cost: { amount: 1500, currency: 'EUR' }, days: [4, 9] };
  }
  return null;
}

const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); timer.unref?.(); });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
};

/** Static part of the filter (no network): loaded, mapped, region listed, COD-capable when needed. → mapping | null */
function staticMapping(ctx, supplierId, line, destination, { cod = false, rule } = {}) {
  const adapter = ctx.suppliers.get(supplierId);
  if (supplierId === 'manual') {
    if (cod && adapter && !adapter.capabilities.cod) return null;
    return mappingFor(ctx, 'manual', line.productId, line.variantKey, { region: destination.region, rule });
  }
  if (!adapter) return null;
  if (cod && !adapter.capabilities.cod) return null;
  const m = mappingFor(ctx, supplierId, line.productId, line.variantKey, { region: destination.region, rule });
  if (!m || !Array.isArray(m.regions) || !m.regions.includes(destination.region)) return null;
  return m;
}

/**
 * Can this product variant be routed to the region at all? No network call: used by GET /api/config.
 * @returns {boolean}
 */
export function canRouteStatic(ctx, product, variantKey, region, { cod = false } = {}) {
  if (Array.isArray(product.regions) && !product.regions.includes(region)) return false;
  const { blocked, tiers, rule } = tiersFor(ctx, product.category, region);
  if (blocked) return false;
  const line = { productId: product.id, variantKey, category: product.category };
  return tiers.flat().some((s) => staticMapping(ctx, s, line, { region }, { rule, cod }) !== null);
}

/** Fallback quote from the mapping's static cost and days. */
function tableQuote(supplierId, lines) {
  let currency = null;
  let itemsCost = 0;
  let complete = true;
  let minDays = 0;
  let maxDays = 0;
  for (const line of lines) {
    const cost = line.mapping?.cost;
    if (cost && Number.isInteger(cost.amount) && (currency === null || currency === cost.currency)) { currency = cost.currency; itemsCost += cost.amount * line.qty; } else if (supplierId !== 'manual') complete = false;
    const days = Array.isArray(line.mapping?.days) ? line.mapping.days : DEFAULT_DAYS;
    minDays = Math.max(minDays, days[0]);
    maxDays = Math.max(maxDays, days[1]);
  }
  return { supplier: supplierId, currency: currency || 'EUR', itemsCost, shippingCost: 0, total: itemsCost, minDays, maxDays, shippingMethod: 'standard', source: 'table', complete };
}

const landedCost = (quote, rules) => {
  if (!quote || quote.complete === false || !Number.isFinite(quote.total)) return Infinity;
  const fx = rules.costFx ? rules.costFx[quote.currency] : undefined;
  return typeof fx === 'number' && fx > 0 ? quote.total * fx : Infinity;
};

/**
 * @param {Array<{key: string, productId: string, variantKey: string, category: string, qty: number, personalisation?: object|null, orderItemId?: number}>} lines
 * @param {{country: string, region: string, state?: string, postcode?: string, city?: string}} destination
 * @param {{config: object, suppliers: object, rules?: object, mapping?: object, catalogue?: object, log?: object}} ctx
 * @param {{cod?: boolean, postPayment?: boolean}} [options]
 *   cod: drop suppliers that cannot collect cash. postPayment: the order is paid, so a line nobody can take
 *   goes to `manual` instead of being reported unavailable.
 * @returns {Promise<{fulfilments: Array<{supplier: string, candidates: string[], lineKeys: string[], quote: object}>, unavailable: Array<{key: string, reason: string}>}>}
 */
export async function route(lines, destination, ctx, options = {}) {
  const rules = rulesOf(ctx);
  const cod = Boolean(options.cod);
  const unavailable = [];
  const stranded = []; // paid lines with no candidate → manual
  const open = []; // { line, tiers: string[][], order: string[], maps: Map<supplier, mapping> }

  for (const line of lines) {
    const product = ctx.catalogue?.get ? ctx.catalogue.get(line.productId) : null;
    const allowed = !product || !Array.isArray(product.regions) || product.regions.includes(destination.region);
    const { blocked, tiers, rule } = tiersFor(ctx, line.category, destination.region);
    const maps = new Map();
    const kept = [];
    if (!blocked && allowed) {
      for (const tier of tiers) {
        const members = [];
        for (const supplierId of tier) {
          const m = staticMapping(ctx, supplierId, line, destination, { cod, rule });
          if (!m) continue;
          const adapter = ctx.suppliers.get(supplierId);
          let ok = true;
          if (adapter) {
            try { ok = (await withTimeout(adapter.isAvailable({ ...line, mapping: m }, destination), ISAVAILABLE_TIMEOUT_MS)) === true; }
            catch (err) { ok = false; }
          }
          if (ok) { members.push(supplierId); maps.set(supplierId, m); }
        }
        if (members.length) kept.push(members);
      }
    }
    if (kept.length) open.push({ line, tiers: kept, order: kept.flat(), maps });
    else if (options.postPayment) stranded.push(line);
    else unavailable.push({ key: line.key, reason: 'NOT_AVAILABLE_IN_REGION' });
  }

  const quotes = new Map();
  const quoteFor = async (supplierId, entries) => {
    const id = `${supplierId}|${entries.map((e) => e.line.key).join('\u0001')}`;
    if (quotes.has(id)) return quotes.get(id);
    const withMapping = entries.map((e) => ({ ...e.line, mapping: e.maps.get(supplierId) || mappingFor(ctx, supplierId, e.line.productId, e.line.variantKey, { region: destination.region }) }));
    const adapter = ctx.suppliers.get(supplierId);
    let quote = null;
    if (adapter) {
      try {
        const q = await withTimeout(adapter.quote(withMapping, destination), QUOTE_TIMEOUT_MS);
        if (q && Number.isFinite(q.total) && typeof q.currency === 'string') quote = { minDays: DEFAULT_DAYS[0], maxDays: DEFAULT_DAYS[1], shippingMethod: 'standard', source: 'api', ...q, supplier: supplierId };
      } catch (err) { quote = null; }
    }
    if (!quote) quote = tableQuote(supplierId, withMapping);
    const result = { quote, landed: landedCost(quote, rules), maxDays: Number.isFinite(quote.maxDays) ? quote.maxDays : DEFAULT_DAYS[1] };
    quotes.set(id, result);
    return result;
  };

  const fulfilments = [];
  let unassigned = open;
  while (unassigned.length) {
    // contenders: suppliers in the best remaining tier of at least one unassigned line
    const covers = new Map();
    for (const entry of unassigned) for (const s of entry.tiers[0]) covers.set(s, [...(covers.get(s) || []), entry]);
    const ranked = [];
    for (const [supplierId, entries] of covers) {
      const { landed, maxDays } = await quoteFor(supplierId, entries);
      const listed = Math.min(...entries.map((e) => e.order.indexOf(supplierId)));
      ranked.push({ supplierId, entries, landed, maxDays, listed });
    }
    ranked.sort((a, b) => b.entries.length - a.entries.length || a.landed - b.landed || a.maxDays - b.maxDays || a.listed - b.listed || a.supplierId.localeCompare(b.supplierId));
    const pick = ranked[0];

    // ordered fallbacks: every other supplier able to take ALL of these lines
    const shared = pick.entries[0].order.filter((s) => s !== pick.supplierId && pick.entries.every((e) => e.order.includes(s)));
    const others = [];
    for (const supplierId of shared) {
      const tier = Math.max(...pick.entries.map((e) => e.tiers.findIndex((t) => t.includes(supplierId))));
      const { landed, maxDays } = await quoteFor(supplierId, pick.entries);
      others.push({ supplierId, tier, landed, maxDays, listed: pick.entries[0].order.indexOf(supplierId) });
    }
    others.sort((a, b) => a.tier - b.tier || a.landed - b.landed || a.maxDays - b.maxDays || a.listed - b.listed || a.supplierId.localeCompare(b.supplierId));

    const { quote } = await quoteFor(pick.supplierId, pick.entries);
    fulfilments.push({ supplier: pick.supplierId, candidates: [pick.supplierId, ...others.map((o) => o.supplierId)], lineKeys: pick.entries.map((e) => e.line.key), quote });
    const taken = new Set(pick.entries);
    unassigned = unassigned.filter((e) => !taken.has(e));
  }

  if (stranded.length) {
    const entries = stranded.map((line) => ({ line, maps: new Map() }));
    const { quote } = await quoteFor('manual', entries);
    const existing = fulfilments.find((f) => f.supplier === 'manual');
    if (existing) existing.lineKeys.push(...stranded.map((l) => l.key));
    else fulfilments.push({ supplier: 'manual', candidates: ['manual'], lineKeys: stranded.map((l) => l.key), quote });
  }
  // parcels are numbered in the order of the customer's lines, whatever order they were picked in
  const position = new Map(lines.map((l, i) => [l.key, i]));
  const firstLine = (f) => Math.min(...f.lineKeys.map((k) => position.get(k)));
  fulfilments.sort((a, b) => firstLine(a) - firstLine(b));
  return { fulfilments, unavailable };
}
