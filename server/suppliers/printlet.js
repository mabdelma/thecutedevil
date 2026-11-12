// Printlet (Egypt) adapter. Owner: sup. Contract: web/COMMERCE_ARCH.md section d.
// The HTTP calls and the list of open questions live in printlet-api.js. Printlet's API is a public *beta RC* that
// nobody here has run against a real account, so this adapter reports itself UNAVAILABLE unless
//   PRINTLET_API_KEY, PRINTLET_BASE_URL, PRINTLET_WEBHOOK_SECRET are set   AND   PRINTLET_API_CONFIRMED=1
// (config.printlet.apiConfirmed). Unconfirmed: isAvailable → false, no COD capability, createOrder throws the
// non-retryable PRINTLET_UNVERIFIED, which sends the fulfilment to `manual`.
//
// Mapping entry for Printlet: productRef = catalogue product id, variantRef = variant id,
//   files: [{ placement: <print area key>, url, technique?: <name>, preset?: 'center' }]
// Revisions, country id, shipping method and city id are looked up at order time (the docs forbid hard-coding them).
import { ProviderError } from '../lib/errors.js';
import { createPrintletApi } from './printlet-api.js';
import { assertUrlKey, fromMinor, isMapped, notFound, parseJsonBody, printFiles, sha256, tableQuote, toMinor } from './util.js';

const ID = 'printlet';
const no = (code, message) => new ProviderError(code, message, { retryable: false, provider: ID });
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** Every status of the Order schema → contract status. */
export function mapStatus(order) {
  const raw = String(order.status || '');
  switch (raw) {
    case 'accepted': case 'cancellation_requested': return { status: 'submitted' };
    case 'pending_verification': return { status: 'on_hold', problem: 'COD order waits for confirmation at Printlet' };
    case 'payment_required': return { status: 'on_hold', problem: 'Printlet wallet payment needed (top up the wallet, then pay in the dashboard)' };
    case 'in_production': return { status: 'in_production' };
    case 'shipped': return { status: 'shipped' };
    case 'delivered': return { status: 'delivered' };
    case 'cancelled': case 'refunded': return { status: 'cancelled' };
    case 'failed': return { status: 'failed', problem: 'failed at Printlet' };
    default: return { status: 'submitted' };
  }
}

export function toState(order) {
  const m = mapStatus(order);
  const done = ['shipped', 'delivered'].includes(m.status);
  // The published Order schema has no tracking fields; read them if Printlet sends any, else one bare shipment.
  const t = order.tracking || order.shipment || {};
  return {
    status: m.status, rawStatus: String(order.status || ''), ...(m.problem ? { problem: m.problem } : {}),
    shipments: done ? [{ ref: String(order.id), carrier: t.carrier || null, trackingNumber: t.tracking_number || t.number || null, trackingUrl: t.tracking_url || t.url || null, shippedAt: null, deliveredAt: null }] : [],
  };
}

export function create(config, deps = {}) {
  const cfg = config.printlet;
  if (!cfg) return null;
  const confirmed = cfg.apiConfirmed === true || cfg.apiConfirmed === '1';
  const api = deps.printletApi || createPrintletApi(cfg, deps);
  const now = deps.now || Date.now;
  const unverified = () => no('PRINTLET_UNVERIFIED', 'printlet: API not confirmed with a real account (set PRINTLET_API_CONFIRMED=1 after the test order)');

  const findByExternal = async (externalId) => {
    let after;
    for (let page = 0; page < 3; page += 1) {
      const res = await api.orders(after);
      const hit = (res.data || []).find((o) => String(o.merchant_order_id) === String(externalId));
      if (hit) return hit;
      if (!res.has_more || !res.next_cursor) break;
      after = res.next_cursor;
    }
    return null;
  };

  /** After creation: confirm COD if needed, then pay Printlet from the wallet. A failure here leaves the order on hold. */
  const settle = async (order, fulfilment) => {
    try {
      if (order.status === 'pending_verification') order = await api.verifyCod(order.id, fulfilment.orderPublicId, `${fulfilment.externalId}:cod`);
      if (order.status === 'payment_required') order = (await api.payFromWallet(order.id, order.resource_version, `${fulfilment.externalId}:pay:${order.resource_version}`)).order || order;
    } catch (err) { /* getOrder will report on_hold with the reason; the owner is alerted by the poll */ }
    const total = order.printlet_total ? toMinor(order.printlet_total.amount) : null;
    return {
      supplierOrderRef: String(order.id), status: order.status === 'in_production' ? 'in_production' : 'submitted',
      ...(total !== null ? { cost: { amount: total, currency: order.printlet_total.currency } } : {}),
    };
  };

  return {
    id: ID,
    capabilities: { webhooks: true, cancel: true, cod: confirmed, liveQuote: false },

    async isAvailable(line, destination) { return confirmed && destination && destination.country === 'EG' && isMapped(line, destination); },

    /** A live quote needs uploaded artwork and a city id, so routing uses the mapping table. */
    async quote(lines) { return tableQuote(ID, lines, { shippingMethod: 'standard', defaultCurrency: 'EGP', defaultDays: [2, 5] }); },

    async createOrder(fulfilment) {
      if (!confirmed) throw unverified();
      const existing = await findByExternal(fulfilment.externalId);
      if (existing && !['cancelled', 'refunded'].includes(existing.status)) return settle(existing, fulfilment);

      const r = fulfilment.recipient; const ext = fulfilment.externalId;
      const country = (await api.countries()).find((c) => c.code === 'EG');
      if (!country) throw no('PRINTLET_NO_MARKET', 'printlet: Egypt is not in the catalogue countries');
      let method = null; let city = null;
      for (const m of await api.shippingMethods(country.id)) {
        for (const rate of m.rates || []) { const c = (rate.cities || []).find((x) => same(x.name, r.city) || same(x.name, r.state)); if (c) { method = m; city = c; break; } }
        if (city) break;
      }
      if (!city) throw no('PRINTLET_CITY_UNKNOWN', 'printlet: the delivery city matches no Printlet shipping city');

      const items = [];
      for (const [i, line] of fulfilment.lines.entries()) {
        const product = await api.product(line.mapping.productRef, country.id);
        const variant = (product.variants || []).find((v) => String(v.id) === String(line.mapping.variantRef));
        if (!variant || variant.available === false) throw no('PRINTLET_VARIANT_UNAVAILABLE', 'printlet: variant missing or unavailable');
        const areas = [];
        for (const [j, file] of printFiles(line, ID).entries()) {
          const area = (product.print_areas || []).find((a) => same(a.key, file.placement));
          const technique = area && ((area.techniques || []).find((t) => file.technique && same(t.name, file.technique)) || (area.techniques || [])[0]);
          if (!technique) throw no('PRINTLET_PRINT_AREA_UNKNOWN', `printlet: print area "${file.placement}" not offered for this product`);
          const preset = (technique.placement_presets || []).includes(file.preset) ? file.preset : (technique.placement_presets || []).includes('center') ? 'center' : (technique.placement_presets || [])[0];
          const artId = `${ext}:art:${i}:${j}`;
          const art = await api.createArtwork({ url: file.url, merchantArtworkId: artId }, artId);
          if (art.status === 'failed' || art.status === 'expired' || art.status === 'deleted') throw no('PRINTLET_ARTWORK_REJECTED', 'printlet: artwork rejected');
          if (art.status !== 'ready') throw new ProviderError('PRINTLET_ARTWORK_PENDING', 'printlet: artwork still being validated', { retryable: true, provider: ID });
          areas.push({ print_area: { id: area.id, revision: area.revision }, technique: { id: technique.id, revision: technique.revision }, placement_preset: preset, artwork: { id: art.id, revision: art.revision } });
        }
        items.push({ merchant_line_id: String(line.orderItemId ?? i + 1), configuration: { variant: { id: variant.id, revision: variant.revision }, quantity: line.qty, print_areas: areas } });
      }

      const bucket = Math.floor(now() / 600000); // quotes live 15 minutes: a later retry asks for a fresh one
      const quote = await api.createQuote({
        merchant_quote_id: `${ext}:q${bucket}`, market: { country_id: country.id, currency: country.currency || 'EGP' }, items,
        shipping: { method_id: method.id, recipient: { name: r.name, phone: r.phone, ...(r.email ? { email: r.email } : {}), address_line_1: r.line1, ...(r.line2 ? { address_line_2: r.line2 } : {}), city_id: city.id, ...(r.postcode ? { postal_code: r.postcode } : {}), country: 'EG' } },
      }, `${ext}:quote:${bucket}`);
      const cod = fulfilment.cod;
      const order = await api.createOrder({
        merchant_order_id: ext, merchant_order_number: fulfilment.orderPublicId, quote_id: quote.id,
        end_customer_payment: cod
          ? { method: 'cod', currency: cod.currency, collection_amount: fromMinor(cod.amount), includes_merchant_shipping: true }
          : { method: 'prepaid', currency: country.currency || 'EGP' },
      }, `${ext}:order`);
      return settle(order, fulfilment);
    },

    async getOrder({ supplierOrderRef, externalId }) {
      if (!confirmed) return null;
      let order = null;
      if (supplierOrderRef) { try { order = await api.order(supplierOrderRef); } catch (err) { if (!notFound(err)) throw err; } }
      if (!order && externalId) order = await findByExternal(externalId);
      return order ? toState(order) : null;
    },

    async parseWebhook({ rawBody, query }) {
      assertUrlKey(query, cfg.webhookSecret); // Printlet's own HMAC layout is not published yet (printlet-api.js, point 1)
      const p = parseJsonBody(rawBody);
      const eventId = p.id ? String(p.id) : sha256(rawBody);
      const res = p.resource && typeof p.resource === 'object' ? p.resource : {};
      const type = String(p.type || '');
      if (type.startsWith('order.')) {
        return [{ eventId, type: 'order.updated', externalId: res.merchant_order_id ? String(res.merchant_order_id) : undefined, supplierOrderRef: res.id ? String(res.id) : undefined }];
      }
      return [{ eventId, type: type.startsWith('catalog.') ? 'stock.updated' : 'ignored' }];
    },

    async cancel({ supplierOrderRef, externalId }) {
      if (!confirmed) return { cancelled: false, reason: 'Printlet API not confirmed' };
      let id = supplierOrderRef;
      if (!id) { const found = await findByExternal(externalId); id = found && found.id; }
      if (!id) return { cancelled: false, reason: 'not found at Printlet' };
      try {
        const order = await api.cancel(id, `${externalId || id}:cancel`);
        // 202 covers both "cancelled" and "cancellation requested"; only the first is a real cancellation.
        return order && order.status === 'cancelled' ? { cancelled: true } : { cancelled: false, reason: `Printlet status ${order ? order.status : 'unknown'}` };
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) return { cancelled: false, reason: err.message };
        throw err;
      }
    },
  };
}
