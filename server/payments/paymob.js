// Paymob (Egypt, EGP): Intention API + Unified Checkout redirect. Owner: pay.
//
// What was read in Paymob's public documentation on 2026-11-12, and what was NOT:
//   CONFIRMED  base URL https://accept.paymob.com/ (same for test and live; the keys decide the mode)
//   CONFIRMED  create intention: POST, header `Authorization: Token <secret key>`; body amount (in cents), currency,
//              payment_methods (integration ids), items[{name, amount}], billing_data (phone_number required),
//              extras (returned in callbacks under payment_key_claims), special_reference (returned as
//              merchant_order_id), notification_url, redirection_url, expiration; response has id, client_secret,
//              intention_order_id (the order id that callbacks carry)
//   CONFIRMED  checkout URL https://eg.checkout.paymob.com/?publicKey=…&clientSecret=…
//   CONFIRMED  callback HMAC: SHA-512, hex, key = HMAC secret, received in the `hmac` query parameter, 20 fields in
//              a fixed order (HMAC_FIELDS below), booleans as lowercase true/false. The documented worked example's
//              concatenated string is reproduced by a test.
//   CONFIRMED  refund URL https://accept.paymob.com/api/acceptance/void_refund/refund, body { transaction_id,
//              amount_cents }; the refund's own callback carries `parent_transaction`
//   UNVERIFIED everything inside the functions marked "UNVERIFIED" below. Each one is the only place that holds
//              that assumption; check them with Paymob test keys before going live (list: "Payments notes" in
//              web/COMMERCE_ARCH.md).
import { AppError, ProviderError } from '../lib/errors.js';
import { CHECKOUT_TTL_MS, chargeLines, field, hmacHex, sameHex, shippingLabel } from './interface.js';

const BASE_URL = 'https://accept.paymob.com';
const CHECKOUT_URL = 'https://eg.checkout.paymob.com/';
const REFUND_PATH = '/api/acceptance/void_refund/refund';

/** UNVERIFIED: the docs page shows the create-intention path only as "/" under a blank base URL.
    "/v1/intention/" is the path Paymob's SDKs and earlier documentation use. */
const intentionPath = () => '/v1/intention/';

/** UNVERIFIED: `expiration` is documented as a number without a unit; seconds is assumed. */
const intentionExpiration = () => Math.floor(CHECKOUT_TTL_MS / 1000);

/** UNVERIFIED: the documented refund example authenticates with an `auth_token` in the body (legacy API-key flow,
    which this shop has no env var for). The secret key in the same `Token` header as the Intention API is assumed. */
const refundRequest = (secretKey, transactionId, amount) => ({
  headers: { Authorization: `Token ${secretKey}`, 'Content-Type': 'application/json' },
  body: { transaction_id: transactionId, amount_cents: amount },
});

/** UNVERIFIED: no "look up a payment by order id" endpoint could be read. This legacy inquiry call with the
    secret key is an assumption; getPayment() treats a refusal as "still pending" (see there). */
const inquiryRequest = (secretKey, orderId) => ({
  path: '/api/ecommerce/orders/transaction_inquiry',
  headers: { Authorization: `Token ${secretKey}`, 'Content-Type': 'application/json' },
  body: { order_id: orderId },
});

/** UNVERIFIED field names of the callback body beyond the 20 signed ones: `obj.is_refund`, `obj.is_void`
    (this transaction IS a refund / a void) and `obj.parent_transaction` (confirmed for refunds only). */
const transactionKind = (obj) => (obj.is_refund === true || obj.is_void === true ? 'refund' : 'payment');

/** The documented order of the signed fields for the "transaction processed" (POST, JSON) callback. */
export const HMAC_FIELDS = Object.freeze([
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id',
  'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id', 'owner',
  'pending', 'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
]);

const pathValue = (obj, path) => path.split('.').reduce((o, key) => (o === null || o === undefined ? undefined : o[key]), obj);
const asText = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));

/** The string Paymob signs: the 20 values of `obj`, in order, with no separator. */
export const hmacString = (obj) => HMAC_FIELDS.map((f) => asText(pathValue(obj, f))).join('');
export const computeHmac = (obj, secret) => hmacHex('sha512', secret, hmacString(obj));
export const verifyHmac = (obj, received, secret) => Boolean(obj) && sameHex(computeHmac(obj, secret), String(received || ''));

/** One verified transaction callback → one PaymentEvent. */
export function mapTransaction(obj, now = Date.now) {
  const occurred = Date.parse(obj.created_at);
  const base = {
    providerRef: String(obj.order?.id ?? ''), amount: obj.amount_cents, currency: obj.currency,
    occurredAt: Number.isFinite(occurred) ? occurred : now(),
  };
  if (obj.pending === true) return { ...base, eventId: `txn:${obj.id}:pending`, type: 'ignored' };
  if (transactionKind(obj) === 'refund') {
    const ok = obj.success === true;
    return { ...base, eventId: `txn:${obj.id}:${ok ? 'refund' : 'refund_failed'}`, type: ok ? 'refund.succeeded' : 'refund.failed', providerPaymentRef: obj.parent_transaction ? String(obj.parent_transaction) : undefined, refundRef: String(obj.id) };
  }
  // Paymob repeats the ORIGINAL transaction's callback with is_refunded / is_voided set once it has been refunded:
  // the refund's own callback (above) is the one that carries the refunded amount.
  if (obj.is_refunded === true || obj.is_voided === true) return { ...base, eventId: `txn:${obj.id}:reversed`, type: 'ignored' };
  if (obj.success === true) return { ...base, eventId: `txn:${obj.id}:paid`, type: 'payment.succeeded', providerPaymentRef: String(obj.id) };
  // One declined attempt. The customer can try again on the same checkout page, so a later payment.succeeded
  // for the same providerRef is possible.
  return { ...base, eventId: `txn:${obj.id}:failed`, type: 'payment.failed', providerPaymentRef: String(obj.id) };
}

/** @returns {import('./interface.js').PaymentProvider | null} */
export function create(config, deps = {}) {
  const keys = config.paymob;
  if (!keys) return null;
  const id = 'paymob';
  const log = deps.log || console;
  const now = deps.now || Date.now;
  const doFetch = deps.fetch || globalThis.fetch;
  const integration = (method) => {
    const raw = method === 'wallet' ? keys.integrationIdWallet : keys.integrationIdCard;
    return /^\d+$/.test(raw) ? Number(raw) : raw; // ids are integers; an integration NAME is also accepted by Paymob
  };

  async function request(path, { headers, body }) {
    let res;
    try {
      res = await doFetch(BASE_URL + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    } catch (err) {
      throw new ProviderError('PAYMOB_NETWORK', 'Paymob could not be reached', { retryable: true, provider: id });
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (err) { /* not JSON */ }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`PAYMOB_HTTP_${res.status}`, `Paymob answered ${res.status}`, { retryable, status: res.status, provider: id });
    }
    return json || {};
  }

  return {
    id,
    capabilities: () => ({ countries: ['EG'], currencies: ['EGP'], methods: keys.integrationIdWallet ? ['card', 'wallet'] : ['card'], refunds: true }),

    async createCheckout({ order, items, shipping, payment, urls }) {
      const amount = field(payment, 'amount');
      const currency = String(field(payment, 'currency') || '').toUpperCase();
      const idemKey = field(payment, 'idemKey');
      const publicId = field(order, 'publicId');
      const method = field(payment, 'method') === 'wallet' ? 'wallet' : 'card';
      if (currency !== 'EGP') throw new ProviderError('PAYMOB_CURRENCY_NOT_SERVED', `paymob does not charge ${currency}`, { provider: id });
      if (!Number.isInteger(amount) || amount <= 0) throw new ProviderError('PAYMOB_BAD_AMOUNT', 'payment amount must be a positive integer', { provider: id });
      if (!idemKey || !publicId || !urls?.success) throw new ProviderError('PAYMOB_BAD_INPUT', 'idemKey, order.publicId and urls.success are required', { provider: id });
      if (method === 'wallet' && !keys.integrationIdWallet) throw new ProviderError('PAYMOB_NO_WALLET', 'wallet integration is not configured', { provider: id });

      const charge = chargeLines({ order, items, shipping, payment });
      const lines = charge.lines.map((l) => ({ name: l.name.slice(0, 50), amount: l.unitAmount, quantity: l.quantity }));
      if (!charge.consolidated && charge.shipping > 0) {
        lines.push({ name: (await shippingLabel(field(order, 'lang'), shipping.labelKey, deps)).slice(0, 50), amount: charge.shipping, quantity: 1 });
      }
      const [first, ...rest] = String(field(order, 'shipName') || '').trim().split(/\s+/).filter(Boolean);
      const na = (v) => (v ? String(v) : 'NA');
      const body = {
        amount, // piastres: our minor units are Paymob's "cents"
        currency,
        payment_methods: [integration(method)],
        items: lines,
        billing_data: {
          first_name: na(first), last_name: na(rest.join(' ') || first), email: na(field(order, 'email')),
          phone_number: na(field(order, 'phone')), // required by Paymob; our checkout requires a phone for EG
          street: na(field(order, 'shipLine1')), city: na(field(order, 'shipCity')), state: na(field(order, 'shipState')),
          country: na(field(order, 'country')), apartment: 'NA', building: 'NA', floor: 'NA',
        },
        extras: { order_public_id: String(publicId), payment_id: String(field(payment, 'id') ?? '') },
        special_reference: String(idemKey), // unique per payment attempt: Paymob's own guard against a double charge
        notification_url: `${config.publicBaseUrl}/api/webhooks/paymob`,
        redirection_url: urls.success, // Paymob sends the browser here after success AND after failure
        expiration: intentionExpiration(),
      };
      const json = await request(intentionPath(), { headers: { Authorization: `Token ${keys.secretKey}`, 'Content-Type': 'application/json' }, body });
      if (!json.client_secret || !json.intention_order_id) throw new ProviderError('PAYMOB_BAD_RESPONSE', 'Paymob returned no client_secret / intention_order_id', { provider: id });
      const url = `${CHECKOUT_URL}?publicKey=${encodeURIComponent(keys.publicKey)}&clientSecret=${encodeURIComponent(json.client_secret)}`;
      return { kind: 'redirect', url, providerRef: String(json.intention_order_id), expiresAt: now() + CHECKOUT_TTL_MS };
    },

    /** "Transaction processed" callback: POST, JSON `{ type: 'TRANSACTION', obj }`, signature in `?hmac=`. */
    async parseWebhook({ rawBody, query }) {
      const bad = () => new AppError('WEBHOOK_SIGNATURE', 400, 'Invalid webhook signature');
      let payload;
      try { payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : ''); } catch (err) { throw bad(); }
      const obj = payload?.obj;
      const received = Array.isArray(query?.hmac) ? query.hmac[0] : query?.hmac;
      // Only the transaction callback can be verified with this algorithm; anything else (e.g. the card-token
      // callback, which has its own HMAC recipe) is rejected, never trusted.
      if (!obj || typeof obj !== 'object' || (payload.type && payload.type !== 'TRANSACTION')) throw bad();
      if (!verifyHmac(obj, received, keys.hmacSecret)) throw bad();
      if (obj.id === undefined || obj.order?.id === undefined) throw bad();
      return [mapTransaction(obj, now)];
    },

    async getPayment(providerRef) {
      const req = inquiryRequest(keys.secretKey, /^\d+$/.test(String(providerRef)) ? Number(providerRef) : providerRef);
      let obj;
      try {
        obj = await request(req.path, req);
      } catch (err) {
        if (err.retryable) throw err;
        // The inquiry call is unverified. Answering 'pending' lets core expire the order; a payment that did go
        // through still arrives by webhook and re-opens it (expired → confirmed is an allowed transition).
        log.warn(`[pay:paymob] inquiry refused (${err.code}); reporting pending`);
        return { status: 'pending', providerPaymentRef: undefined, amount: undefined, currency: 'EGP' };
      }
      const status = obj.success === true && obj.pending !== true ? 'succeeded' : 'pending';
      return { status, providerPaymentRef: obj.id !== undefined ? String(obj.id) : undefined, amount: obj.amount_cents, currency: obj.currency || 'EGP' };
    },

    /** Paymob has no idempotency header: the caller's job key (`refund:<payment id>:<amount>`) is what prevents a repeat. */
    async refund({ payment, amount }) {
      if (!Number.isInteger(amount) || amount <= 0) throw new ProviderError('PAYMOB_BAD_AMOUNT', 'refund amount must be a positive integer', { provider: id });
      const transactionId = field(payment, 'providerPaymentRef');
      if (!transactionId) throw new ProviderError('PAYMOB_NOT_PAID', 'this payment has no transaction to refund', { provider: id });
      const req = refundRequest(keys.secretKey, /^\d+$/.test(String(transactionId)) ? Number(transactionId) : transactionId, amount);
      const json = await request(REFUND_PATH, req);
      const obj = json.obj || json; // the documented example wraps the refund transaction as { type, obj }
      if (obj.success === false && obj.pending !== true) throw new ProviderError('PAYMOB_REFUND_FAILED', 'Paymob declined the refund', { provider: id });
      return { status: obj.success === true ? 'succeeded' : 'pending', refundRef: String(obj.id ?? '') };
    },
  };
}
