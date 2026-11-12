// Saudi local methods: placeholder. Owner: pay. v1 serves Saudi Arabia with cards through `stripe_ae` (SAR).
//
// Where the local methods will plug in later:
//   mada        Saudi debit network. Either enabled on the Stripe UAE account (then nothing changes here: it shows
//               up inside the same hosted Checkout page), or through a Saudi acquirer (e.g. Paymob KSA at
//               ksa.paymob.com, which uses the same Intention API as payments/paymob.js with a KSA base URL).
//   Tabby       buy-now-pay-later: create a checkout session server-side, redirect, verify its signed webhook.
//   Tamara      same shape as Tabby.
// Each becomes its own module with `create(config, deps)`; config.js gets an env group for it, capabilities() lists
// { countries: ['SA'], currencies: ['SAR'], methods: [...] } and the registry adds the factory. The orders code
// does not change: it only sees the PaymentProvider interface.
import { ProviderError } from '../lib/errors.js';

const unavailable = () => { throw new ProviderError('SAUDI_UNAVAILABLE', 'Saudi local payment methods are not available in v1', { provider: 'saudi' }); };

/** The whole interface, reporting itself unavailable. Never registered; kept so the shape is tested. */
export const placeholder = Object.freeze({
  id: 'saudi',
  available: false,
  capabilities: () => ({ countries: [], currencies: [], methods: [], refunds: false }),
  createCheckout: async () => unavailable(),
  parseWebhook: async () => unavailable(),
  getPayment: async () => unavailable(),
  refund: async () => unavailable(),
});

/** v1: always null, so the registry never loads it. */
export function create() { return null; }
