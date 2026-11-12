// Payment registry: loads only the providers whose env vars are present. Owner: pay.
// Contract: web/COMMERCE_ARCH.md section d.
//   mode 'off'  → nothing
//   mode 'mock' → only `mock` (serves every country and currency; no real provider is touched)
//   mode 'live' → stripe_es, stripe_ae, paymob, saudi (always null in v1), cod: each only when configured
import { assertPaymentProvider } from './interface.js';
import { createStripe } from './stripe.js';
import { create as paymob } from './paymob.js';
import { create as saudi } from './saudi.js';
import { create as cod } from './cod.js';
import { create as mock } from './mock.js';

/** @type {Record<string, Array<(config: object, deps: object) => (import('./interface.js').PaymentProvider | null)>>} */
const FACTORIES = {
  off: [],
  mock: [mock],
  live: [createStripe('stripe_es'), createStripe('stripe_ae'), paymob, saudi, cod],
};

/** Does this provider's capability set cover the destination? */
export function serves(provider, { country, currency }) {
  const cap = provider.capabilities();
  const countryOk = cap.countries === '*' || cap.countries.includes(String(country || '').toUpperCase());
  return countryOk && cap.currencies.includes(String(currency || '').toUpperCase());
}

/**
 * @returns {{ get(id: string): object|null, list(): object[],
 *            forDestination(d: {country: string, currency: string}): Array<{provider: object, methods: string[]}>,
 *            methodsFor(d: {country: string, currency: string}): Array<{method: string, provider: string}> }}
 */
export function loadPayments(config, deps = {}) {
  const map = new Map();
  for (const create of FACTORIES[config.mode] || []) {
    const provider = create(config, deps);
    if (provider) map.set(provider.id, assertPaymentProvider(provider));
  }
  const forDestination = (destination) => {
    const out = [];
    for (const provider of map.values()) {
      if (serves(provider, destination)) out.push({ provider, methods: provider.capabilities().methods.slice() });
    }
    return out;
  };
  return {
    get: (id) => map.get(id) || null,
    list: () => Array.from(map.values()),
    forDestination,
    /** Flat list for the quote's `paymentMethods`: the first provider (registry order) wins each method. */
    methodsFor(destination) {
      const seen = new Map();
      for (const { provider, methods } of forDestination(destination)) {
        for (const method of methods) if (!seen.has(method)) seen.set(method, provider.id);
      }
      return Array.from(seen, ([method, provider]) => ({ method, provider }));
    },
  };
}
