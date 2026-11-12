// Test helpers for supplier adapters. Owner: sup. No network: every adapter gets a stubbed fetch and a fake clock.
import { loadConfig } from '../../config.js';

/** A clock that only moves when something sleeps. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start; const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, advance: (ms) => { t += ms; }, sleeps, random: () => 0 };
}

/**
 * Stubbed fetch. `handler(call)` gets { method, path, query, body, headers } and returns
 * { status?, body?, headers? } or throws to simulate a network error. Calls are recorded in `.calls`.
 */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { method: init.method || 'GET', host: u.host, path: decodeURIComponent(u.pathname), query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers || {} };
    calls.push(call);
    const r = (await handler(call)) || {};
    const status = r.status || 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body === undefined ? {} : r.body), { status, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
  };
  fn.calls = calls;
  return fn;
}

export const config = (env = {}) => loadConfig({ COMMERCE_MODE: 'live', DATABASE_URL: 'sqlite::memory:', PUBLIC_BASE_URL: 'https://shop.example.com', ...env });
/** loadConfig output is frozen and does not carry sup's optional extras yet; tests add them like this. */
export const withExtra = (cfg, group, extra) => ({ ...cfg, [group]: { ...cfg[group], ...extra } });

export const dest = (country = 'ES', region = 'EU', more = {}) => ({ country, region, state: '', postcode: '28001', city: 'Madrid', ...more });

export function line(supplier, more = {}) {
  const base = {
    printful: { supplier, productRef: '380', variantRef: '10780', regions: ['EU', 'UK', 'CA', 'US'], files: [{ placement: 'embroidery_chest_left', url: 'https://cdn.example.com/horns.png' }], cost: { amount: 2950, currency: 'USD' }, days: [4, 9] },
    printify: { supplier, productRef: '5bfd0b66a342bcc9b5563216', variantRef: '17887', regions: ['EU', 'UK', 'CA', 'US'], cost: { amount: 1050, currency: 'USD' }, days: [5, 10] },
    gelato: { supplier, productRef: 'tee', variantRef: 'apparel_product_gca_t-shirt_gsc_crewneck_gcu_unisex_gqa_classic_gsi_s_gco_white_gpr_4-4', regions: ['EU', 'UK', 'CA', 'US'], files: [{ placement: 'default', url: 'https://cdn.example.com/front.png' }], cost: { amount: 1100, currency: 'EUR' }, days: [4, 9] },
    printlet: { supplier, productRef: 'prod-1', variantRef: 'var-1', regions: ['EG'], files: [{ placement: 'front', url: 'https://cdn.example.com/front.png' }], cost: { amount: 22000, currency: 'EGP' }, days: [2, 5] },
    mock: { supplier, productRef: 'm', variantRef: 'm', regions: ['EU', 'UK', 'CA', 'US', 'AE', 'GCC', 'EG'], cost: { amount: 1200, currency: 'EUR' }, days: [3, 7] },
  }[supplier];
  const { mapping: mapExtra, ...rest } = more;
  return { orderItemId: 11, productId: 'halos-off-hoodie', variantKey: 'size=M', category: 'apparel', qty: 1, personalisation: null, mapping: mapExtra === null ? null : { ...base, ...(mapExtra || {}) }, ...rest };
}

export function fulfilment(lines, more = {}) {
  return {
    id: 7, externalId: 'TCD-261112-AB2C-F1-0', orderPublicId: 'TCD-261112-AB2C', lines, shippingMethod: 'standard', currency: 'EUR', lang: 'en',
    recipient: { name: 'Test Person', line1: '1 Example Street', line2: '', city: 'Madrid', state: '', postcode: '28001', country: 'ES', phone: '+34600000000', email: 'buyer@example.com' },
    cod: null, ...more,
  };
}

export const raw = (obj) => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
