// Printify adapter. Owner: sup. Contract: web/COMMERCE_ARCH.md section d.
// Docs read 12 Nov 2026: https://developers.printify.com/ and https://developers.printify.com/openapi.json (API v1).
//   POST /v1/shops/{shop_id}/orders.json                 existing product_id + variant_id (on-the-fly products are
//                                                         slated for deprecation, so the mapping must hold real ids)
//   409 = external_id already used; the answer carries order.id of the existing order
//   POST …/orders/{id}/send_to_production.json (202)     POST …/orders/{id}/cancel.json (only on-hold / payment-not-received)
//   POST …/orders/shipping.json → { standard, express, priority, printify_express, economy } in cents
//   Webhooks: header X-Pfy-Signature: sha256=<hex HMAC-SHA256 of the raw body with the webhook secret>
// Rate limit: 600 requests / minute; a User-Agent header is mandatory.
import { ProviderError } from '../lib/errors.js';
import { createHttp } from './http.js';
import { isoCountry } from './regions.js';
import { badSignature, boolOpt, header, hmacSha256Hex, isMapped, notFound, parseJsonBody, safeEqual, sha256, splitName, tableQuote, toMs, withTimeout } from './util.js';

const ID = 'printify';
const ORDER_TOPICS = new Set(['order:created', 'order:updated', 'order:sent-to-production', 'order:shipment:created', 'order:shipment:delivered', 'order:line-item:canceled']);

/** Every documented order status → contract status. */
export function mapStatus(order, { sendToProduction }) {
  const raw = String(order.status || '');
  const ships = order.shipments || [];
  switch (raw) {
    case 'pending': case 'sending-to-production': case 'cost-calculation':
    case 'sending_to_production_delegate': case 'sending_to_production_delegate_sync': return { status: 'submitted' };
    // API orders wait on-hold until sent to production; once we have sent them, on-hold means a problem.
    case 'on-hold': return sendToProduction ? { status: 'on_hold', problem: 'on hold at Printify (stock, discontinued or shipping restriction)' } : { status: 'submitted' };
    case 'in-production': case 'partially-fulfilled': return { status: 'in_production' };
    case 'fulfilled': return { status: ships.length > 0 && ships.every((s) => s.delivered_at) ? 'delivered' : 'shipped' };
    case 'canceled': return { status: 'cancelled' };
    case 'payment-not-received': return { status: 'on_hold', problem: 'Printify could not charge the account' };
    case 'has-issues': return { status: 'on_hold', problem: 'Printify reports an issue (often the address)' };
    case 'unfulfillable': return { status: 'failed', problem: 'unfulfillable (inventory or technical)' };
    case 'source-check-failed': return { status: 'failed', problem: 'print file failed validation' };
    default: return { status: 'submitted' };
  }
}

export function toState(order, opt) {
  const m = mapStatus(order, opt);
  return {
    status: m.status, rawStatus: String(order.status || ''), ...(m.problem ? { problem: m.problem } : {}),
    shipments: (order.shipments || []).map((s, i) => ({
      ref: String(s.number || `${order.id}-${i + 1}`), carrier: s.carrier || null, trackingNumber: s.number ? String(s.number) : null,
      trackingUrl: s.url || null, shippedAt: toMs(s.shipped_at) ?? toMs(order.fulfilled_at), deliveredAt: toMs(s.delivered_at),
    })),
  };
}

const addressTo = (r) => {
  const n = splitName(r.name);
  return {
    first_name: n.first, last_name: n.last, ...(r.email ? { email: r.email } : {}), ...(r.phone ? { phone: r.phone } : {}),
    country: isoCountry(r.country), region: r.state || '', address1: r.line1, ...(r.line2 ? { address2: r.line2 } : {}), city: r.city, zip: r.postcode || '',
  };
};
const lineItem = (line) => ({ product_id: String(line.mapping.productRef), variant_id: Number(line.mapping.variantRef), quantity: line.qty });

export function buildOrderBody(fulfilment) {
  for (const line of fulfilment.lines) {
    const p = line.personalisation && Object.values(line.personalisation).some((v) => typeof v === 'string' && v.trim());
    // Printify personalisation needs a per-product configuration created beforehand (opaque strategy token); not automated in v1.
    if (p) throw new ProviderError('PERSONALISATION_NEEDS_HUMAN', 'printify: personalised lines are not sent automatically', { retryable: false, provider: ID });
  }
  return {
    external_id: fulfilment.externalId, label: fulfilment.orderPublicId,
    line_items: fulfilment.lines.map((line) => ({ ...lineItem(line), external_id: String(line.orderItemId ?? `${line.productId}|${line.variantKey}`) })),
    shipping_method: 1, send_shipping_notification: false, // 1 = standard; the shop sends its own e-mails
    address_to: addressTo(fulfilment.recipient),
  };
}

export function create(config, deps = {}) {
  const cfg = config.printify;
  if (!cfg) return null;
  const sendToProduction = boolOpt(cfg.sendToProduction, config.mode === 'live');
  const shop = `/v1/shops/${encodeURIComponent(cfg.shopId)}`;
  const http = createHttp({
    provider: ID, baseUrl: cfg.baseUrl || 'https://api.printify.com', rate: { capacity: 600, windowMs: 60000 }, deps,
    headers: () => ({ Authorization: `Bearer ${cfg.token}`, 'User-Agent': 'Node.js commerce-server' }),
  });
  const opt = { sendToProduction };
  const getById = async (id) => {
    try { return (await http.get(`${shop}/orders/${encodeURIComponent(id)}.json`)).data; } catch (err) { if (notFound(err)) return null; throw err; }
  };
  /** No "find by external_id" endpoint is documented: scan the newest orders for metadata.shop_order_id. */
  const findByExternal = async (externalId) => {
    for (let page = 1; page <= 3; page += 1) {
      const { data } = await http.get(`${shop}/orders.json`, { query: { limit: 50, page } });
      const rows = (data && data.data) || [];
      const hit = rows.find((o) => o.metadata && String(o.metadata.shop_order_id) === String(externalId));
      if (hit) return hit;
      if (rows.length < 50 || !data.next_page_url) break;
    }
    return null;
  };
  const produce = async (id) => {
    if (!sendToProduction) return 'submitted';
    await http.post(`${shop}/orders/${encodeURIComponent(id)}/send_to_production.json`, undefined);
    return 'submitted'; // 202: accepted, production starts asynchronously
  };

  return {
    id: ID,
    capabilities: { webhooks: true, cancel: true, cod: false, liveQuote: true },

    async isAvailable(line, destination) { return isMapped(line, destination); },

    async quote(lines, destination) {
      const table = tableQuote(ID, lines, { shippingMethod: 'standard', defaultCurrency: 'USD' });
      try {
        const body = { line_items: lines.map(lineItem), address_to: { country: isoCountry(destination.country), region: destination.state || '', city: destination.city || '', zip: destination.postcode || '' } };
        const { data } = await withTimeout(http.post(`${shop}/orders/shipping.json`, body, { retry: false, timeoutMs: 3000 }), 3000, ID);
        if (!data || !Number.isInteger(data.standard) || table.currency !== 'USD') return table; // Printify bills in USD cents
        return { ...table, shippingCost: data.standard, total: table.itemsCost + data.standard, source: 'api' };
      } catch (err) { return table; }
    },

    async createOrder(fulfilment) {
      const body = buildOrderBody(fulfilment);
      let id;
      try {
        id = (await http.post(`${shop}/orders.json`, body, { retry: false })).data.id; // not retried blindly: 409 below is the safe path
      } catch (err) {
        const dup = err instanceof ProviderError && err.status === 409 && err.body && err.body.order && err.body.order.id;
        if (!dup) throw err;
        id = String(dup);
        const existing = await getById(id);
        if (existing && !['pending', 'on-hold'].includes(existing.status)) { // already moving: nothing to send
          return { supplierOrderRef: id, status: mapStatus(existing, opt).status === 'in_production' ? 'in_production' : 'submitted' };
        }
      }
      return { supplierOrderRef: String(id), status: await produce(id) };
    },

    async getOrder({ supplierOrderRef, externalId }) {
      const order = supplierOrderRef ? await getById(supplierOrderRef) : await findByExternal(externalId);
      return order ? toState(order, opt) : null;
    },

    async parseWebhook({ rawBody, headers }) {
      const given = header(headers, 'x-pfy-signature');
      if (!safeEqual(given, `sha256=${hmacSha256Hex(cfg.webhookSecret, rawBody)}`)) throw badSignature();
      const p = parseJsonBody(rawBody);
      const eventId = p.id ? String(p.id) : sha256(rawBody);
      if (ORDER_TOPICS.has(p.type) && p.resource && p.resource.id) return [{ eventId, type: 'order.updated', supplierOrderRef: String(p.resource.id) }];
      return [{ eventId, type: 'ignored' }];
    },

    async cancel({ supplierOrderRef, externalId }) {
      let id = supplierOrderRef;
      if (!id) { const found = await findByExternal(externalId); id = found && found.id; }
      if (!id) return { cancelled: false, reason: 'not found at Printify' };
      try {
        await http.post(`${shop}/orders/${encodeURIComponent(id)}/cancel.json`, undefined, { retry: false });
        return { cancelled: true };
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) return { cancelled: false, reason: err.message };
        throw err;
      }
    },
  };
}
