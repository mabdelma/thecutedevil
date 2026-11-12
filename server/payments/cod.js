// Cash on delivery: no online payment; the order is confirmed at once and the courier collects. Owner: pay.
// Offered only for Egypt in EGP, and only while a loaded supplier can collect cash (capabilities.cod).
// core additionally hides COD from a quote unless every fulfilment's supplier has capabilities.cod.
import { AppError, ProviderError } from '../lib/errors.js';
import { field } from './interface.js';

/** @returns {import('./interface.js').PaymentProvider | null} */
export function create(config, deps = {}) {
  if (config.mode === 'off') return null;
  const suppliers = deps.suppliers?.list?.() || [];
  if (!suppliers.some((s) => s?.capabilities?.cod === true)) return null;
  return {
    id: 'cod',
    capabilities: () => ({ countries: ['EG'], currencies: ['EGP'], methods: ['cod'], refunds: false }),
    async createCheckout({ order, payment }) {
      if (String(field(payment, 'currency') || '').toUpperCase() !== 'EGP') throw new ProviderError('COD_CURRENCY_NOT_SERVED', 'cash on delivery is EGP only', { provider: 'cod' });
      return { kind: 'confirmed', providerRef: `cod_${field(order, 'publicId')}` };
    },
    async parseWebhook() { throw new AppError('NOT_FOUND', 404, 'cash on delivery has no webhook'); },
    /** Nothing to ask anyone: cash is due until the supplier reports the parcel delivered (core sets cod_collected). */
    async getPayment() { return { status: 'pending', providerPaymentRef: undefined, amount: undefined, currency: 'EGP' }; },
    async refund() { throw new ProviderError('COD_NO_REFUND', 'cash on delivery cannot be refunded online', { provider: 'cod' }); },
  };
}
