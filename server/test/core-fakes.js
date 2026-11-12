// Fakes for core's tests: a payment provider, supplier adapters and their registries, all implementing the
// contract's interfaces (section d) in memory. Owner: core. Not a test file; nothing here touches the network.
import { randomUUID } from 'node:crypto';
import { ProviderError } from '../lib/errors.js';
import { startTestServer } from './harness.js';

export function fakeProvider(id, { countries = '*', currencies = ['EUR', 'GBP', 'CAD', 'USD', 'AED', 'SAR', 'EGP'], methods = ['card'] } = {}) {
  const p = {
    id,
    calls: { createCheckout: [], refund: [], getPayment: [] },
    remote: new Map(), // providerRef → { status, amount, currency }
    failCheckout: null, // set to an Error to make the next createCheckout throw
    failRefund: null,
    refundStatus: 'succeeded',
    capabilities: () => ({ countries, currencies, methods, refunds: !methods.includes('cod') }),
    async createCheckout(input) {
      p.calls.createCheckout.push(input);
      if (p.failCheckout) { const err = p.failCheckout; p.failCheckout = null; throw err; }
      const providerRef = `sess_${input.payment.idemKey}`;
      if (input.payment.method === 'cod') return { kind: 'confirmed', providerRef: `cod_${input.order.publicId}` };
      if (!p.remote.has(providerRef)) p.remote.set(providerRef, { status: 'pending', amount: input.payment.amount, currency: input.payment.currency, providerPaymentRef: null });
      return { kind: 'redirect', url: `https://pay.test/${id}/${providerRef}`, providerRef, expiresAt: Date.now() + 31 * 60 * 1000 };
    },
    async parseWebhook() { return []; },
    async getPayment(providerRef) {
      p.calls.getPayment.push(providerRef);
      const r = p.remote.get(providerRef);
      if (!r) throw new ProviderError('NOT_FOUND', 'no such session', { retryable: false });
      return { ...r };
    },
    async refund(input) {
      p.calls.refund.push(input);
      if (p.failRefund) { const err = p.failRefund; p.failRefund = null; throw err; }
      return { status: p.refundStatus, refundRef: `re_${input.idempotencyKey}` };
    },
    /** A PaymentEvent as the provider's webhook parser would produce it. */
    event(type, payment, extra = {}) {
      return { eventId: `evt_${randomUUID()}`, type, providerRef: payment.provider_ref, providerPaymentRef: `pi_${payment.id}`, amount: payment.amount, currency: payment.currency, occurredAt: Date.now(), ...extra };
    },
  };
  return p;
}

export function fakePayments(providers) {
  const map = new Map(providers.map((p) => [p.id, p]));
  return {
    get: (id) => map.get(id) || null,
    list: () => Array.from(map.values()),
    forDestination({ country, currency }) {
      return Array.from(map.values()).filter((p) => {
        const cap = p.capabilities();
        return (cap.countries === '*' || cap.countries.includes(country)) && cap.currencies.includes(currency);
      }).map((provider) => ({ provider, methods: provider.capabilities().methods.slice() }));
    },
  };
}

export function fakeSupplier(id, { cod = false, webhooks = true, cancel = true } = {}) {
  const s = {
    id,
    capabilities: { webhooks, cancel, cod, liveQuote: false },
    orders: new Map(), // externalId → { supplierOrderRef, state, fulfilment }
    calls: { createOrder: [], getOrder: [], cancel: [], quote: [] },
    failures: [], // errors thrown by the next createOrder calls, in order
    swallow: false, // true: createOrder stores the order and THEN throws (the answer was lost on the way back)
    unavailable: new Set(), // product ids
    quoteOverride: null, // (lines, destination) → quote | throw
    refuseCancel: false,
    async isAvailable(line, destination) {
      return Boolean(line.mapping) && line.mapping.regions.includes(destination.region) && !s.unavailable.has(line.productId);
    },
    async quote(lines, destination) {
      s.calls.quote.push({ lines, destination });
      if (s.quoteOverride) return s.quoteOverride(lines, destination);
      const itemsCost = lines.reduce((n, l) => n + l.mapping.cost.amount * l.qty, 0);
      return { supplier: id, currency: lines[0].mapping.cost.currency, itemsCost, shippingCost: 400, total: itemsCost + 400, minDays: Math.max(...lines.map((l) => l.mapping.days[0])), maxDays: Math.max(...lines.map((l) => l.mapping.days[1])), shippingMethod: 'STANDARD', source: 'table' };
    },
    async createOrder(fulfilment) {
      s.calls.createOrder.push(fulfilment);
      const failure = s.failures.shift();
      if (failure && !s.swallow) throw failure;
      if (!s.orders.has(fulfilment.externalId)) {
        s.orders.set(fulfilment.externalId, { supplierOrderRef: `${id}-${s.orders.size + 1}`, fulfilment, state: { status: 'submitted', rawStatus: 'pending', shipments: [] } });
      }
      if (failure) throw failure;
      return { supplierOrderRef: s.orders.get(fulfilment.externalId).supplierOrderRef, status: 'submitted', cost: { amount: 1234, currency: 'EUR' } };
    },
    async getOrder({ externalId }) {
      s.calls.getOrder.push(externalId);
      const o = s.orders.get(externalId);
      return o ? { ...o.state, shipments: o.state.shipments.map((x) => ({ ...x })) } : null;
    },
    async parseWebhook() { return []; },
    async cancel({ externalId }) {
      s.calls.cancel.push(externalId);
      if (s.refuseCancel) return { cancelled: false, reason: 'already in production' };
      const o = s.orders.get(externalId);
      if (o) o.state = { ...o.state, status: 'cancelled', rawStatus: 'canceled' };
      return { cancelled: true };
    },
    /** Test helpers: move the supplier-side order. */
    set(externalId, status, extra = {}) { const o = s.orders.get(externalId); o.state = { ...o.state, status, rawStatus: status, ...extra }; },
    ship(externalId, { ref = 'SHIP1', delivered = false } = {}) {
      const o = s.orders.get(externalId);
      const shipments = o.state.shipments.filter((x) => x.ref !== ref);
      shipments.push({ ref, carrier: 'DHL', trackingNumber: `TRK-${ref}`, trackingUrl: `https://track.test/${ref}`, shippedAt: 1700000000000, deliveredAt: delivered ? 1700000500000 : null });
      o.state = { status: delivered ? 'delivered' : 'shipped', rawStatus: delivered ? 'delivered' : 'shipped', shipments };
    },
    event(externalId) { return { eventId: `sev_${randomUUID()}`, type: 'order.updated', externalId, supplierOrderRef: s.orders.get(externalId)?.supplierOrderRef }; },
  };
  return s;
}

export function fakeSuppliers(adapters) {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return { get: (id) => map.get(id) || null, has: (id) => map.has(id), list: () => Array.from(map.values()) };
}

const entry = (supplier, regions, amount, currency = 'EUR', days = [4, 9]) => ({ supplier, productRef: `${supplier}-p`, variantRef: `${supplier}-v`, regions, cost: { amount, currency }, days });
const WEST = ['EU', 'UK', 'CA', 'US'];
/** A mapping for the three sellable live products of the real catalogue, in the shape `sup` uses (section c). */
export const testMapping = {
  'halos-off-hoodie': { '*': [entry('printful', WEST, 3000), entry('gelato', WEST, 2800), entry('printify', WEST, 2600), entry('printlet', ['EG'], 60000, 'EGP', [3, 7])] },
  'nice-guy-long-story-tee': { '*': [entry('printful', WEST, 1200), entry('gelato', WEST, 1300), entry('printify', WEST, 1100), entry('printlet', ['EG'], 25000, 'EGP', [3, 7])] },
  'horns-down-cap': { default: [entry('printful', WEST, 1400), entry('printify', WEST, 1500, 'EUR', [5, 12])] },
};

/**
 * The real server (mock mode, temp SQLite, real rules.json and catalogue) with fake providers and suppliers.
 * → the harness object plus { pay, codPay, sup: { printful, gelato, printify, printlet }, tick(), setNow(ms), advance(ms) }
 */
export async function startCoreServer({ env = {}, overrides = {}, suppliers = ['printful', 'gelato', 'printify', 'printlet'] } = {}) {
  const sup = Object.fromEntries(suppliers.map((id) => [id, fakeSupplier(id, { cod: id === 'printlet' })]));
  const pay = fakeProvider('fakepay', { methods: ['card'] });
  const codPay = fakeProvider('cod', { countries: ['EG'], currencies: ['EGP'], methods: ['cod'] });
  const s = await startTestServer({ OWNER_ALERT_EMAIL: 'owner@shop.test', ...env }, {
    payments: fakePayments([pay, codPay]), suppliers: fakeSuppliers(Object.values(sup)), mapping: testMapping, routers: {}, ...overrides,
  });
  let clock = Date.now();
  s.ctx.now = () => clock;
  s.ctx.cronBudgetMs = 5000;
  return {
    ...s, pay, codPay, sup,
    setNow(ms) { clock = ms; },
    advance(ms) { clock += ms; return clock; },
    now: () => clock,
    async tick() { s.ctx.limiter.reset(); return (await s.api('/api/cron/tick', { method: 'POST', headers: { Authorization: 'Bearer test-cron' } })).body; },
  };
}

/** A valid POST /api/checkout body for Spain. */
export function checkoutBody(overrides = {}) {
  return {
    country: 'ES', lang: 'en', checkoutId: randomUUID(), shippingOption: 'standard', paymentMethod: 'card',
    items: [{ id: 'halos-off-hoodie', qty: 1, options: { size: 'M' } }],
    customer: { name: 'Test Person', email: 'buyer@example.test', phone: '+34600000000' },
    address: { line1: 'Calle Falsa 123', city: 'Valladolid', postcode: '47001' },
    acceptTerms: true, expectedTotal: 7900 + 499,
    ...overrides,
  };
}

/** Quote, then check out with the quoted total. → { status, body, request } */
export async function placeOrder(s, overrides = {}) {
  const request = checkoutBody(overrides);
  if (overrides.expectedTotal === undefined) {
    const q = await s.api('/api/quote', { method: 'POST', body: { country: request.country, items: request.items, paymentMethod: request.paymentMethod, postcode: request.address.postcode } });
    request.expectedTotal = q.body.total;
  }
  const res = await s.api('/api/checkout', { method: 'POST', body: request });
  return { ...res, request };
}

export const orderRow = (s, publicId) => s.db('orders').where({ public_id: publicId }).first();
export const paymentOf = async (s, publicId) => s.db('payments').where({ order_id: (await orderRow(s, publicId)).id }).orderBy('id', 'desc').first();
export const fulfilmentsOf = async (s, publicId) => s.db('fulfilments').where({ order_id: (await orderRow(s, publicId)).id }).orderBy('seq');

/** What the payment webhook route does (section d): dedupe, then hand the event to core. → true when it was processed */
export async function deliverPayment(s, publicId, type = 'payment.succeeded', extra = {}, event = null) {
  const { recordWebhookOnce, handlePaymentEvent } = await import('../orders/events.js');
  const payment = await paymentOf(s, publicId);
  const provider = s.ctx.payments.get(payment.provider);
  const ev = event || provider.event(type, payment, extra);
  if (type === 'payment.succeeded' && provider.remote.has(payment.provider_ref)) provider.remote.get(payment.provider_ref).status = 'succeeded';
  const fresh = await recordWebhookOnce(s.ctx, { source: `pay:${provider.id}`, eventId: ev.eventId, type: ev.type, rawBody: Buffer.from(JSON.stringify(ev)) });
  if (fresh) await handlePaymentEvent(s.ctx, provider.id, ev);
  return { fresh, event: ev };
}

/** What the supplier webhook route does: dedupe, then core re-reads the order from the supplier. */
export async function deliverSupplier(s, supplierId, externalId, event = null) {
  const { recordWebhookOnce, handleSupplierEvent } = await import('../orders/events.js');
  const ev = event || s.sup[supplierId].event(externalId);
  const fresh = await recordWebhookOnce(s.ctx, { source: `sup:${supplierId}`, eventId: ev.eventId, type: ev.type, rawBody: Buffer.from(JSON.stringify(ev)) });
  if (fresh) await handleSupplierEvent(s.ctx, supplierId, ev);
  return { fresh, event: ev };
}

/** Place an order and pay it. → { id, token, order, fulfilments } */
export async function paidOrder(s, overrides = {}) {
  const res = await placeOrder(s, overrides);
  if (res.status !== 201) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (res.body.payment.kind === 'redirect') await deliverPayment(s, res.body.orderId);
  return { id: res.body.orderId, token: res.body.token, order: await orderRow(s, res.body.orderId), fulfilments: await fulfilmentsOf(s, res.body.orderId) };
}

export const mails = (s, template) => s.ctx.outbox.filter((m) => !template || m.template === template);
