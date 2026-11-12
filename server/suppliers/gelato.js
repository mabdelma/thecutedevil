// Gelato adapter. Owner: sup. Contract: web/COMMERCE_ARCH.md section d.
// Docs read 12 Nov 2026 (developers.gelato.com; dashboard.gelato.com/docs sits behind a bot check and could not be read):
//   VERIFIED  POST https://order.gelatoapis.com/v4/orders            https://developers.gelato.com/docs/get-started
//   VERIFIED  POST https://order.gelatoapis.com/v4/orders:quote      https://developers.gelato.com/docs/orders/v4/quote
//   VERIFIED  POST https://order.gelatoapis.com/v4/orders/{id}:cancel (200, 404, 409)   …/docs/orders/v4/cancel
//   VERIFIED  search filters (orderReferenceId …) and response { orders: [] }           …/docs/orders/v4/search/
//   VERIFIED  order fields, statuses, connectedOrderIds                                  …/docs/orders/order_details/
//   VERIFIED  webhook events and payloads; NO signature or auth is documented            …/docs/webhooks
//   ASSUMED   the search URL itself (/v4/orders:search), GET /v4/orders/{id}, and that tracking sits in
//             shipment.packages[].trackingCode / trackingUrl. Check all three with a real account.
// Gelato publishes no rate limit; the bucket below (100 / minute) is our own caution, not a documented number.
import { ProviderError } from '../lib/errors.js';
import { createHttp } from './http.js';
import { isoCountry } from './regions.js';
import { assertUrlKey, boolOpt, isMapped, notFound, parseJsonBody, printFiles, sha256, splitName, tableQuote, toMinor, toMs, withTimeout } from './util.js';

const ID = 'gelato';
const ORDER_EVENTS = new Set(['order_status_updated', 'order_item_status_updated', 'order_item_tracking_code_updated']);
const METHODS = ['normal', 'standard', 'express'];

/** Every documented fulfillmentStatus → contract status. */
export function mapStatus(raw, { draft }) {
  switch (String(raw || '')) {
    case 'created': case 'uploading': case 'passed': case 'digitizing': return { status: 'submitted' };
    case 'draft': return draft ? { status: 'submitted' } : { status: 'on_hold', problem: 'still a draft at Gelato' };
    case 'in_production': case 'printed': return { status: 'in_production' };
    case 'shipped': case 'in_transit': return { status: 'shipped' };
    case 'delivered': return { status: 'delivered' };
    case 'canceled': return { status: 'cancelled' };
    case 'failed': return { status: 'failed', problem: 'order creation failed at Gelato (address, payment or stock)' };
    case 'returned': return { status: 'failed', problem: 'parcel returned to sender' };
    case 'pending_approval': return { status: 'on_hold', problem: 'waiting for approval in the Gelato dashboard' };
    case 'pending_personalization': case 'not_connected': case 'on_hold': return { status: 'on_hold', problem: `Gelato: ${raw}` };
    default: return { status: 'submitted' };
  }
}

function shipmentsOf(order) {
  const out = []; const seen = new Set();
  const add = (ref, code, url, carrier) => {
    if (!code && !url) return;
    const key = String(code || url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ref: String(ref || key), carrier: carrier || null, trackingNumber: code ? String(code) : null, trackingUrl: url || null, shippedAt: toMs(order.shippedAt) ?? null, deliveredAt: null });
  };
  const sh = order.shipment || {};
  for (const pkg of sh.packages || []) add(pkg.id || pkg.trackingCode, pkg.trackingCode, pkg.trackingUrl, sh.shipmentMethodName);
  for (const item of order.items || []) for (const f of item.fulfillments || []) add(f.trackingCode, f.trackingCode, f.trackingUrl, f.shipmentMethodName);
  return out;
}

/** One order may come back as several connected orders: merge them into one state, least advanced status wins. */
export function toState(orders, opt) {
  const live = orders.map((o) => ({ o, m: mapStatus(o.fulfillmentStatus, opt) }));
  const active = live.filter((x) => x.m.status !== 'cancelled');
  const pick = (s) => active.find((x) => x.m.status === s);
  let chosen;
  if (active.length === 0) chosen = live[0];
  else chosen = pick('failed') || pick('on_hold')
    || (active.every((x) => x.m.status === 'delivered') ? active[0] : null)
    || (active.every((x) => ['shipped', 'delivered'].includes(x.m.status)) ? pick('shipped') : null)
    || (active.some((x) => ['in_production', 'shipped', 'delivered'].includes(x.m.status)) ? { o: active[0].o, m: { status: 'in_production' } } : null)
    || active[0];
  return {
    status: chosen.m.status, rawStatus: orders.map((o) => o.fulfillmentStatus).join(','), ...(chosen.m.problem ? { problem: chosen.m.problem } : {}),
    shipments: orders.flatMap(shipmentsOf),
  };
}

const items = (lines, key) => lines.map((line) => {
  const files = printFiles(line, ID).map((f) => ({ type: f.placement || 'default', url: f.url }));
  return { itemReferenceId: String(line.orderItemId ?? `${line.productId}|${line.variantKey}`), [key]: String(line.mapping.variantRef), ...(files.length ? { files } : {}), quantity: line.qty };
});

export function buildOrderBody(fulfilment, { draft, returnAddress, currency }) {
  const r = fulfilment.recipient; const n = splitName(r.name);
  return {
    orderType: draft ? 'draft' : 'order',
    orderReferenceId: fulfilment.externalId, customerReferenceId: fulfilment.orderPublicId, currency,
    items: items(fulfilment.lines, 'productUid'),
    // omitted → Gelato picks the cheapest method
    ...(METHODS.includes(fulfilment.shippingMethod) ? { shipmentMethodUid: fulfilment.shippingMethod } : {}),
    shippingAddress: {
      firstName: n.first, lastName: n.last, addressLine1: r.line1, ...(r.line2 ? { addressLine2: r.line2 } : {}), city: r.city,
      postCode: r.postcode || '', ...(r.state ? { state: r.state } : {}), country: isoCountry(r.country),
      ...(r.email ? { email: r.email } : {}), ...(r.phone ? { phone: r.phone } : {}),
    },
    ...(returnAddress ? { returnAddress } : {}),
  };
}

export function create(config, deps = {}) {
  const cfg = config.gelato;
  if (!cfg) return null;
  const draft = !boolOpt(cfg.confirm, config.mode === 'live'); // draft outside live mode
  const opt = { draft };
  const http = createHttp({ provider: ID, baseUrl: cfg.baseUrl || 'https://order.gelatoapis.com', rate: { capacity: 100, windowMs: 60000 }, deps, headers: () => ({ 'X-API-KEY': cfg.apiKey }) });
  const unavailable = new Set(); // productUids out of stock in every stock region
  const currencyOf = (lines) => (lines[0] && lines[0].mapping && lines[0].mapping.cost && lines[0].mapping.cost.currency) || 'EUR';
  const search = async (externalId) => {
    const { data } = await http.post('/v4/orders:search', { orderReferenceId: externalId, limit: 20 });
    return ((data && data.orders) || []).filter((o) => String(o.orderReferenceId) === String(externalId));
  };
  const getById = async (id) => {
    try { return (await http.get(`/v4/orders/${encodeURIComponent(id)}`)).data; } catch (err) { if (notFound(err)) return null; throw err; }
  };
  const result = (order) => {
    const receipts = order.receipts || [];
    const total = receipts.length ? receipts.reduce((sum, r) => sum + (toMinor(r.totalInclVat ?? r.total) || 0), 0) : null;
    return {
      supplierOrderRef: String(order.id), status: mapStatus(order.fulfillmentStatus, opt).status === 'in_production' ? 'in_production' : 'submitted',
      ...(total ? { cost: { amount: total, currency: receipts[0].currency || order.currency } } : {}),
    };
  };

  return {
    id: ID,
    capabilities: { webhooks: true, cancel: true, cod: false, liveQuote: true },

    async isAvailable(line, destination) { return isMapped(line, destination) && !unavailable.has(String(line.mapping.variantRef)); },

    async quote(lines, destination) {
      const table = tableQuote(ID, lines, { shippingMethod: 'normal', defaultCurrency: 'EUR' });
      try {
        const body = {
          orderReferenceId: `quote-${sha256(JSON.stringify([lines.map((l) => [l.mapping.variantRef, l.qty]), destination.country, destination.postcode])).slice(0, 16)}`,
          customerReferenceId: 'quote', currency: table.currency, allowMultipleQuotes: false,
          // The quote API insists on a full recipient; only the place matters for price, so the rest is neutral filler.
          recipient: { country: isoCountry(destination.country), firstName: 'Quote', lastName: 'Request', addressLine1: 'Quote', city: destination.city || 'Quote', postCode: destination.postcode || '', ...(destination.state ? { state: destination.state } : {}), email: 'quote@example.com' },
          products: items(lines.map((l) => ({ ...l, personalisation: null })), 'productUid'),
        };
        const { data } = await withTimeout(http.post('/v4/orders:quote', body, { retry: false, timeoutMs: 3000 }), 3000, ID);
        const quotes = (data && data.quotes) || [];
        if (quotes.length === 0) return table;
        let itemsCost = 0; let shippingCost = 0; let minDays = 0; let maxDays = 0; let method = 'normal';
        for (const q of quotes) {
          for (const p of q.products || []) { if (p.currency && p.currency !== table.currency) return table; itemsCost += toMinor(p.price) || 0; }
          const ships = (q.shipmentMethods || []).filter((s) => s.type !== 'pallet');
          const s = ships.filter((x) => x.type === 'normal').sort((a, b) => a.price - b.price)[0] || ships.sort((a, b) => a.price - b.price)[0];
          if (!s || (s.currency && s.currency !== table.currency)) return table;
          shippingCost += toMinor(s.price) || 0; method = s.type === 'express' ? 'express' : 'normal'; // generic uid, valid on order create
          minDays = Math.max(minDays, s.minDeliveryDays || 0); maxDays = Math.max(maxDays, s.maxDeliveryDays || 0);
        }
        return { supplier: ID, currency: table.currency, itemsCost, shippingCost, total: itemsCost + shippingCost, minDays: minDays || table.minDays, maxDays: maxDays || table.maxDays, shippingMethod: String(method), source: 'api' };
      } catch (err) { return table; }
    },

    async createOrder(fulfilment) {
      const body = buildOrderBody(fulfilment, { draft, returnAddress: cfg.returnAddress || null, currency: currencyOf(fulfilment.lines) });
      // The docs do not say what a repeated orderReferenceId answers, so look first and never post twice.
      const existing = (await search(fulfilment.externalId)).filter((o) => o.fulfillmentStatus !== 'canceled');
      if (existing.length > 0) return result(existing[0]);
      const { data } = await http.post('/v4/orders', body, { retry: false });
      return result(data);
    },

    async getOrder({ supplierOrderRef, externalId }) {
      let first = supplierOrderRef ? await getById(supplierOrderRef) : null;
      if (!first && externalId) { const hits = await search(externalId); first = hits[0] ? (await getById(hits[0].id)) || hits[0] : null; }
      if (!first) return null;
      const orders = [first];
      for (const id of (first.connectedOrderIds || []).slice(0, 5)) {
        if (String(id) === String(first.id)) continue;
        const linked = await getById(id);
        if (linked) orders.push(linked);
      }
      return toState(orders, opt);
    },

    async parseWebhook({ rawBody, query }) {
      assertUrlKey(query, cfg.webhookSecret);
      const p = parseJsonBody(rawBody);
      const eventId = p.id ? String(p.id) : sha256(rawBody);
      if (ORDER_EVENTS.has(p.event)) {
        return [{ eventId, type: 'order.updated', externalId: p.orderReferenceId ? String(p.orderReferenceId) : undefined, supplierOrderRef: p.orderId ? String(p.orderId) : undefined }];
      }
      if (p.event === 'catalog_product_stock_availability_updated') {
        for (const row of p.productsAvailability || p.productAvailability || []) { // the docs use both spellings
          const all = row.availability || [];
          if (all.length > 0 && all.every((a) => a.status === 'out-of-stock')) unavailable.add(String(row.productUid)); else unavailable.delete(String(row.productUid));
        }
        return [{ eventId, type: 'stock.updated' }];
      }
      return [{ eventId, type: 'ignored' }];
    },

    async cancel({ supplierOrderRef, externalId }) {
      let id = supplierOrderRef;
      if (!id) { const hits = await search(externalId); id = hits[0] && hits[0].id; }
      if (!id) return { cancelled: false, reason: 'not found at Gelato' };
      try {
        await http.post(`/v4/orders/${encodeURIComponent(id)}:cancel`, undefined, { retry: false });
        return { cancelled: true };
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) return { cancelled: false, reason: err.status === 409 ? 'already printed or shipped' : err.message };
        throw err;
      }
    },
  };
}
