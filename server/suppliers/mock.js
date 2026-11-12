// `mock` supplier for COMMERCE_MODE=mock. Owner: sup. Deterministic, in memory, no network.
// - personalisation.name === 'FAIL' → retryable error; 'REJECT' → non-retryable error
// - mock.ship(externalId) marks an order shipped with tracking MOCK123 (test helper)
// - the same can be done over HTTP, through the real supplier-webhook route:
//     POST /api/webhooks/supplier/mock?key=mock   {"id":"evt-1","action":"ship","externalId":"TCD-…-F1-0"}
//   actions: ship | deliver | fail | hold. Instead of ?key=mock the body may be signed:
//   header x-mock-signature = hex HMAC-SHA256(rawBody, 'mock')  (see signMockWebhook).
import { ProviderError } from '../lib/errors.js';
import { badSignature, header, hmacSha256Hex, parseJsonBody, safeEqual, sha256 } from './util.js';

const ID = 'mock';
export const MOCK_KEY = 'mock';
export const MOCK_TRACKING = 'MOCK123';
export const signMockWebhook = (rawBody) => hmacSha256Hex(MOCK_KEY, rawBody);

export function create(config, deps = {}) {
  if (!config || config.mode !== 'mock') return null;
  const now = deps.now || Date.now;
  const orders = new Map(); // externalId → { ref, status, problem, shipments, lines }
  const byRef = (ref) => { for (const [externalId, o] of orders) if (o.ref === ref) return [externalId, o]; return [null, null]; };
  const find = ({ supplierOrderRef, externalId }) => orders.get(externalId) || byRef(supplierOrderRef)[1] || null;
  const name = (line) => (line.personalisation && typeof line.personalisation.name === 'string' ? line.personalisation.name : '');

  const advance = (externalId, action) => {
    const o = orders.get(externalId);
    if (!o || o.status === 'cancelled') return null;
    if (action === 'ship' && !['shipped', 'delivered'].includes(o.status)) {
      o.status = 'shipped';
      o.shipments = [{ ref: `${o.ref}-S1`, carrier: 'MockPost', trackingNumber: MOCK_TRACKING, trackingUrl: `https://example.com/track/${MOCK_TRACKING}`, shippedAt: now(), deliveredAt: null }];
    } else if (action === 'deliver') {
      if (o.shipments.length === 0) advance(externalId, 'ship');
      o.status = 'delivered';
      o.shipments = o.shipments.map((s) => ({ ...s, deliveredAt: now() }));
    } else if (action === 'fail') { o.status = 'failed'; o.problem = 'mock failure';
    } else if (action === 'hold') { o.status = 'on_hold'; o.problem = 'mock hold'; }
    return o;
  };

  return {
    id: ID,
    capabilities: { webhooks: true, cancel: true, cod: true, liveQuote: false },

    async isAvailable(line, destination) {
      const m = line && line.mapping;
      return Boolean(m && Array.isArray(m.regions) && destination && m.regions.includes(destination.region));
    },

    async quote(lines) {
      let itemsCost = 0; let minDays = 0; let maxDays = 0;
      for (const line of lines) {
        const m = line.mapping || {};
        itemsCost += (m.cost && Number.isInteger(m.cost.amount) ? m.cost.amount : 1000) * line.qty;
        const d = Array.isArray(m.days) ? m.days : [3, 7];
        minDays = Math.max(minDays, d[0]); maxDays = Math.max(maxDays, d[1]);
      }
      return { supplier: ID, currency: 'EUR', itemsCost, shippingCost: 500, total: itemsCost + 500, minDays, maxDays, shippingMethod: 'mock-standard', source: 'table' };
    },

    async createOrder(fulfilment) {
      const existing = orders.get(fulfilment.externalId);
      if (existing) return { supplierOrderRef: existing.ref, status: 'submitted' }; // same fulfilment twice → one order
      if (fulfilment.lines.some((l) => name(l) === 'FAIL')) throw new ProviderError('MOCK_FAIL', 'mock: temporary failure', { retryable: true, provider: ID });
      if (fulfilment.lines.some((l) => name(l) === 'REJECT')) throw new ProviderError('MOCK_REJECT', 'mock: order rejected', { retryable: false, provider: ID });
      const ref = `MOCK-${fulfilment.externalId}`;
      orders.set(fulfilment.externalId, { ref, status: 'submitted', problem: null, shipments: [], lines: fulfilment.lines.length });
      return { supplierOrderRef: ref, status: 'submitted', cost: { amount: 1000 * fulfilment.lines.reduce((n, l) => n + l.qty, 0) + 500, currency: 'EUR' } };
    },

    async getOrder(ref) {
      const o = find(ref || {});
      if (!o) return null;
      return { status: o.status, rawStatus: `mock_${o.status}`, ...(o.problem ? { problem: o.problem } : {}), shipments: o.shipments.map((s) => ({ ...s })) };
    },

    async parseWebhook({ rawBody, headers, query }) {
      const keyOk = safeEqual(query && typeof query.key === 'string' ? query.key : '', MOCK_KEY);
      const sigOk = safeEqual(header(headers, 'x-mock-signature'), signMockWebhook(rawBody));
      if (!keyOk && !sigOk) throw badSignature();
      const p = parseJsonBody(rawBody);
      const eventId = p.id ? String(p.id) : sha256(rawBody);
      const externalId = typeof p.externalId === 'string' ? p.externalId : '';
      if (!['ship', 'deliver', 'fail', 'hold'].includes(p.action) || !advance(externalId, p.action)) return [{ eventId, type: 'ignored' }];
      return [{ eventId, type: 'order.updated', externalId, supplierOrderRef: orders.get(externalId).ref }];
    },

    async cancel(ref) {
      const o = find(ref || {});
      if (!o) return { cancelled: false, reason: 'unknown order' };
      if (o.status !== 'submitted' && o.status !== 'cancelled') return { cancelled: false, reason: `already ${o.status}` };
      o.status = 'cancelled';
      return { cancelled: true };
    },

    /* ---- test helpers (not part of the SupplierAdapter contract) ---- */
    ship(externalId) { return Boolean(advance(externalId, 'ship')); },
    deliver(externalId) { return Boolean(advance(externalId, 'deliver')); },
    setInProduction(externalId) { const o = orders.get(externalId); if (o) o.status = 'in_production'; return Boolean(o); },
    orders() { return Array.from(orders.entries()).map(([externalId, o]) => ({ externalId, ref: o.ref, status: o.status })); },
    reset() { orders.clear(); },
  };
}
