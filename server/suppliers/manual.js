// `manual` supplier: the last fallback. Owner: sup. Contract: web/COMMERCE_ARCH.md section d.
// "Creating" an order sends nothing anywhere: it returns a reference, core parks the fulfilment as `manual`,
// alerts the owner, and a human closes it with server/scripts/fulfilment-set.js.
const ID = 'manual';
const DEFAULT_DAYS = [7, 14];

export function create(config) {
  if (!config || config.mode === 'off') return null;
  return {
    id: ID,
    capabilities: { webhooks: false, cancel: true, cod: false, liveQuote: false },
    async isAvailable() { return true; },
    async quote(lines) {
      let minDays = 0; let maxDays = 0;
      for (const line of lines) {
        const d = line.mapping && Array.isArray(line.mapping.days) ? line.mapping.days : DEFAULT_DAYS;
        minDays = Math.max(minDays, d[0]); maxDays = Math.max(maxDays, d[1]);
      }
      return { supplier: ID, currency: 'EUR', itemsCost: 0, shippingCost: 0, total: 0, minDays: minDays || DEFAULT_DAYS[0], maxDays: maxDays || DEFAULT_DAYS[1], shippingMethod: 'manual', source: 'table' };
    },
    async createOrder(fulfilment) { return { supplierOrderRef: fulfilment.externalId, status: 'submitted' }; },
    /** A human owns the state; the database row is the truth, so there is nothing to report from here. */
    async getOrder() { return { status: 'submitted', rawStatus: 'manual', shipments: [] }; },
    async parseWebhook() { return []; },
    async cancel() { return { cancelled: true }; },
  };
}
