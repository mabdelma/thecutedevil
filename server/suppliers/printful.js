// Printful adapter. Owner: sup. Contract: web/COMMERCE_ARCH.md section d.
// Docs read 12 Nov 2026: https://developers.printful.com/docs/ (API v1, GA). v2 is still "2.0.0-beta" and says its
// Orders endpoints are incomplete (https://developers.printful.com/docs/v2-beta/), so everything here is v1:
//   POST /orders?confirm=   GET /orders/{id|@external_id}   POST /orders/{id}/confirm   DELETE /orders/{id}
//   POST /shipping/rates    POST /webhooks (one URL per store)
// v1 webhooks carry NO signature, so the registered URL holds a shared secret (?key=…). v2 webhooks sign with
// HMAC-SHA256 (header x-pf-webhook-signature, hex; secret key delivered as hex): verified too when a v2 key is configured.
// Rate limit: 120 requests / 60 s per store, 429 + Retry-After.
import { ProviderError } from '../lib/errors.js';
import { createHttp } from './http.js';
import { isoCountry } from './regions.js';
import {
  assertUrlKey, badSignature, boolOpt, header, hmacSha256Hex, isMapped, notFound, parseJsonBody, printFiles, safeEqual, sha256,
  tableQuote, toMinor, toMs, withTimeout,
} from './util.js';

const ID = 'printful';
const ORDER_EVENTS = new Set(['package_shipped', 'package_returned', 'order_created', 'order_updated', 'order_failed', 'order_canceled',
  'order_put_hold', 'order_put_hold_approval', 'order_remove_hold', 'order_refunded']);

/** variantRef '10780' = catalogue variant (needs files); 'sync:4012' = sync variant already holding its design. */
const variantField = (ref) => (String(ref).startsWith('sync:') ? { sync_variant_id: Number(String(ref).slice(5)) } : { variant_id: Number(ref) });

/** Every v1 order status (docs, "Order life cycle and statuses") → contract status. */
export function mapStatus(order, { confirm }) {
  const raw = String(order.status || '');
  const shipped = Array.isArray(order.shipments) && order.shipments.length > 0;
  switch (raw) {
    // With auto-confirm on, a draft means Printful sent it back (async cost calculation) and it waits for a confirm.
    case 'draft': return confirm ? { status: 'on_hold', problem: 'draft: waiting to be confirmed' } : { status: 'submitted' };
    case 'inreview': case 'pending': return { status: 'submitted' };
    case 'failed': return { status: 'failed', problem: 'returned for review by Printful (address, print file or charge)' };
    case 'canceled': return { status: 'cancelled' };
    case 'inprocess': case 'partial': return { status: 'in_production' };
    case 'onhold': return { status: 'on_hold', problem: 'on hold at Printful' };
    case 'fulfilled': return { status: 'shipped' };
    case 'archived': return { status: shipped ? 'shipped' : 'cancelled' };
    default: return { status: 'submitted' };
  }
}

export function toState(order, opt) {
  const m = mapStatus(order, opt);
  return {
    status: m.status, rawStatus: String(order.status || ''), ...(m.problem ? { problem: m.problem } : {}),
    shipments: (order.shipments || []).map((s) => ({
      ref: String(s.id), carrier: s.carrier || null, trackingNumber: s.tracking_number ? String(s.tracking_number) : null,
      trackingUrl: s.tracking_url ? String(s.tracking_url).trim() : null, shippedAt: toMs(s.shipped_at ?? s.ship_date), deliveredAt: null,
    })),
  };
}

export function buildOrderBody(fulfilment) {
  const r = fulfilment.recipient;
  const method = typeof fulfilment.shippingMethod === 'string' && /^[A-Z][A-Z0-9_]+$/.test(fulfilment.shippingMethod) ? fulfilment.shippingMethod : 'STANDARD';
  return {
    external_id: fulfilment.externalId,
    shipping: method,
    recipient: {
      name: r.name, address1: r.line1, ...(r.line2 ? { address2: r.line2 } : {}), city: r.city,
      ...(r.state ? { state_code: r.state } : {}), country_code: isoCountry(r.country), ...(r.postcode ? { zip: r.postcode } : {}),
      ...(r.phone ? { phone: r.phone } : {}), ...(r.email ? { email: r.email } : {}),
    },
    items: fulfilment.lines.map((line) => {
      const files = printFiles(line, ID).map((f) => ({ type: f.placement || 'default', url: f.url, ...(f.position ? { position: f.position } : {}) }));
      return {
        external_id: String(line.orderItemId ?? `${line.productId}|${line.variantKey}`),
        ...variantField(line.mapping.variantRef), quantity: line.qty,
        ...(files.length ? { files } : {}),
        ...(Array.isArray(line.mapping.options) && line.mapping.options.length ? { options: line.mapping.options } : {}),
      };
    }),
  };
}

export function create(config, deps = {}) {
  const cfg = config.printful;
  if (!cfg) return null;
  const confirm = boolOpt(cfg.confirm, config.mode === 'live'); // draft outside live mode, confirmed in live mode
  const http = createHttp({
    provider: ID, baseUrl: cfg.baseUrl || 'https://api.printful.com', rate: { capacity: 120, windowMs: 60000 }, deps,
    headers: () => ({ Authorization: `Bearer ${cfg.apiKey}`, ...(cfg.storeId ? { 'X-PF-Store-Id': String(cfg.storeId) } : {}) }),
  });
  const unavailable = new Set(); // catalogue variant ids reported out of stock / discontinued by stock_updated
  const stockByProduct = new Map();
  const state = (order) => toState(order, { confirm });
  const result = (order) => {
    const s = state(order);
    const total = order.costs ? toMinor(order.costs.total) : null;
    return {
      supplierOrderRef: String(order.id), status: s.status === 'in_production' ? 'in_production' : 'submitted',
      ...(total !== null && order.costs.currency ? { cost: { amount: total, currency: order.costs.currency } } : {}),
    };
  };
  const fetchOrder = async (idOrExternal) => {
    try { return (await http.get(`/orders/${encodeURIComponent(idOrExternal)}`)).data.result; } catch (err) { if (notFound(err)) return null; throw err; }
  };
  const adopt = async (order) => {
    if (confirm && order.status === 'draft') order = (await http.post(`/orders/${order.id}/confirm`, undefined)).data.result || order;
    return result(order);
  };

  return {
    id: ID,
    capabilities: { webhooks: true, cancel: true, cod: false, liveQuote: true },

    async isAvailable(line, destination) {
      if (!isMapped(line, destination)) return false;
      return !unavailable.has(String(line.mapping.variantRef));
    },

    async quote(lines, destination) {
      const table = tableQuote(ID, lines, { shippingMethod: 'STANDARD', defaultCurrency: 'USD' });
      if (lines.some((l) => !l.mapping || String(l.mapping.variantRef).startsWith('sync:'))) return table; // the rates API takes catalogue variants only
      try {
        const body = {
          recipient: { country_code: isoCountry(destination.country), ...(destination.state ? { state_code: destination.state } : {}), ...(destination.city ? { city: destination.city } : {}), ...(destination.postcode ? { zip: destination.postcode } : {}) },
          items: lines.map((l) => ({ variant_id: String(l.mapping.variantRef), quantity: l.qty })),
          currency: table.currency,
        };
        const { data } = await withTimeout(http.post('/shipping/rates', body, { retry: false, timeoutMs: 3000 }), 3000, ID);
        const rates = Array.isArray(data && data.result) ? data.result : [];
        const rate = rates.find((x) => x.id === 'STANDARD') || rates.slice().sort((a, b) => Number(a.rate) - Number(b.rate))[0];
        const shippingCost = rate ? toMinor(rate.rate) : null;
        if (shippingCost === null || (rate.currency && rate.currency !== table.currency)) return table;
        return {
          supplier: ID, currency: table.currency, itemsCost: table.itemsCost, shippingCost, total: table.itemsCost + shippingCost,
          // maxDeliveryDays is transit after fulfilment; the mapping's days carry production time
          minDays: Math.max(table.minDays, rate.minDeliveryDays || 0), maxDays: Math.max(table.maxDays, rate.maxDeliveryDays || 0),
          shippingMethod: String(rate.id), source: 'api',
        };
      } catch (err) { return table; }
    },

    async createOrder(fulfilment) {
      const body = buildOrderBody(fulfilment); // throws before any network call when a line cannot be built
      const existing = await fetchOrder(`@${fulfilment.externalId}`);
      if (existing && existing.status !== 'canceled') return adopt(existing);
      try {
        const { data } = await http.post('/orders', body, { query: { confirm: confirm ? 'true' : 'false' } });
        return result(data.result);
      } catch (err) {
        // The docs do not say what a repeated external_id answers; whatever it is, the order that already exists wins.
        if (err instanceof ProviderError && err.status >= 400 && err.status < 500) {
          const again = await fetchOrder(`@${fulfilment.externalId}`).catch(() => null);
          if (again && again.status !== 'canceled') return adopt(again);
        }
        throw err;
      }
    },

    async getOrder({ supplierOrderRef, externalId }) {
      const order = await fetchOrder(supplierOrderRef || `@${externalId}`);
      return order ? state(order) : null;
    },

    async parseWebhook({ rawBody, headers, query }) {
      assertUrlKey(query, cfg.webhookSecret);
      const signature = header(headers, 'x-pf-webhook-signature');
      if (cfg.webhookSigningKeyHex) { // v2 webhooks only
        if (!signature || !safeEqual(signature.toLowerCase(), hmacSha256Hex(Buffer.from(cfg.webhookSigningKeyHex, 'hex'), rawBody))) throw badSignature();
      }
      const p = parseJsonBody(rawBody);
      const eventId = sha256(rawBody); // v1 payloads have no event id
      const order = p.data && p.data.order;
      if (p.type === 'stock_updated' && p.data) {
        const gone = [...((p.data.variant_stock && p.data.variant_stock.out) || []), ...((p.data.variant_stock && p.data.variant_stock.discontinued) || [])].map(String);
        for (const old of stockByProduct.get(String(p.data.product_id)) || []) unavailable.delete(old); // ids not listed are back in stock
        stockByProduct.set(String(p.data.product_id), gone);
        for (const v of gone) unavailable.add(v);
        return [{ eventId, type: 'stock.updated' }];
      }
      if (ORDER_EVENTS.has(p.type) && order) {
        return [{ eventId, type: 'order.updated', externalId: order.external_id ? String(order.external_id) : undefined, supplierOrderRef: String(order.id) }];
      }
      return [{ eventId, type: 'ignored' }];
    },

    async cancel({ supplierOrderRef, externalId }) {
      try {
        await http.del(`/orders/${encodeURIComponent(supplierOrderRef || `@${externalId}`)}`);
        return { cancelled: true };
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) return { cancelled: false, reason: err.status === 404 ? 'not found at Printful' : err.message };
        throw err;
      }
    },
  };
}
