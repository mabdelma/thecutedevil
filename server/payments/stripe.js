// Stripe: one factory, two instances (two separate Stripe accounts). Owner: pay.
//   stripe_es  Spanish account  → EU, GB, CA, US   in EUR, GBP, CAD, USD   webhook /api/webhooks/stripe_es
//   stripe_ae  UAE account      → AE, SA, KW, QA, BH, OM   in AED, SAR     webhook /api/webhooks/stripe_ae
// Hosted Checkout Session (the customer pays on Stripe's page); our own checkout page already has the address,
// so Stripe collects only the payment. Parameters follow docs.stripe.com/api/checkout/sessions/create as read
// on 2026-11-12 for API version 2026-10-28.endive (the version stripe-node 23.1 ships with).
import Stripe from 'stripe';
import { AppError, ProviderError } from '../lib/errors.js';
import { CHECKOUT_TTL_MS, chargeLines, field, isMinor, shippingLabel } from './interface.js';

/** Pinned: requests are sent with this version whatever the account default is. Change it together with the library. */
export const STRIPE_API_VERSION = '2026-10-28.endive';

const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

export const STRIPE_ACCOUNTS = Object.freeze({
  stripe_es: Object.freeze({ configKey: 'es', countries: Object.freeze([...EU, 'GB', 'CA', 'US']), currencies: Object.freeze(['EUR', 'GBP', 'CAD', 'USD']) }),
  stripe_ae: Object.freeze({ configKey: 'ae', countries: Object.freeze(['AE', 'SA', 'KW', 'QA', 'BH', 'OM']), currencies: Object.freeze(['AED', 'SAR']) }),
});

/** Site language → Checkout `locale`. Stripe's list has no Arabic and no Hindi: those fall back to the browser's language. */
export const STRIPE_LOCALES = Object.freeze({ en: 'en', es: 'es', fr: 'fr', de: 'de', it: 'it', pt: 'pt', ru: 'ru', ja: 'ja', zh: 'zh', ar: 'auto', hi: 'auto' });
export const stripeLocale = (lang) => STRIPE_LOCALES[String(lang || '').toLowerCase()] || 'auto';

/** Events to subscribe to on each account's webhook endpoint (snapshot payloads). */
export const STRIPE_WEBHOOK_EVENTS = Object.freeze([
  'checkout.session.completed', 'checkout.session.expired',
  'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'payment_intent.payment_failed', 'charge.refunded', 'refund.failed',
]);

const idOf = (value) => (value && typeof value === 'object' ? value.id : value) || undefined;
const upper = (c) => (typeof c === 'string' ? c.toUpperCase() : undefined);

/** Stripe library error → ProviderError. Network trouble, 429 and 5xx can be retried; the rest cannot. */
function providerError(err, provider) {
  if (err instanceof ProviderError || err instanceof AppError) return err;
  const status = err?.statusCode;
  const type = err?.type || '';
  const retryable = type === 'StripeConnectionError' || type === 'StripeAPIError' || type === 'StripeRateLimitError'
    || status === 429 || status === 409 || (typeof status === 'number' && status >= 500) || (!type && !status);
  const code = err?.code ? `STRIPE_${String(err.code).toUpperCase()}` : type ? `STRIPE_${type.replace(/^Stripe/, '').replace(/Error$/, '').toUpperCase() || 'ERROR'}` : 'STRIPE_NETWORK';
  return new ProviderError(code, err?.message || 'Stripe request failed', { retryable, status, provider });
}

/** Checkout Session → the contract's payment status. */
export function sessionStatus(session) {
  if (session.status === 'expired') return 'expired';
  if (session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')) return 'succeeded';
  return 'pending'; // open, or complete with a delayed payment method that has not settled yet
}

/**
 * @param {'stripe_es'|'stripe_ae'} id
 * @returns {(config: object, deps?: object) => import('./interface.js').PaymentProvider | null}
 * deps.stripeClients[id] replaces the real client in tests; deps.now replaces the clock.
 */
export function createStripe(id) {
  const account = STRIPE_ACCOUNTS[id];
  if (!account) throw new TypeError(`unknown Stripe instance ${id}`);
  return function create(config, deps = {}) {
    const keys = config.stripe?.[account.configKey];
    if (!keys) return null;
    const log = deps.log || console;
    const now = deps.now || Date.now;
    const client = deps.stripeClients?.[id] || new Stripe(keys.secretKey, {
      apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 1, timeout: 15000, telemetry: false,
      appInfo: { name: 'the-cute-devil-shop', version: '0.1.0' },
    });
    const call = async (fn) => { try { return await fn(); } catch (err) { throw providerError(err, id); } };

    /** The Checkout Session a PaymentIntent belongs to (PaymentIntent and Charge events do not carry it). */
    async function sessionOfIntent(paymentIntentId) {
      if (!paymentIntentId) return null;
      const page = await call(() => client.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 }));
      return page?.data?.[0] || null;
    }

    async function mapEvent(event) {
      const object = event?.data?.object || {};
      const base = { eventId: event.id, occurredAt: (event.created || Math.floor(now() / 1000)) * 1000 };
      const ignored = { ...base, type: 'ignored' };
      const type = String(event?.type || '');

      if (type.startsWith('checkout.session.')) {
        // Sessions made by anything else on the same account (Payment Links, the dashboard) are not ours.
        if (object.mode !== 'payment' || !object.metadata?.order_public_id) return ignored;
        const fromSession = { ...base, providerRef: object.id, providerPaymentRef: idOf(object.payment_intent), amount: object.amount_total, currency: upper(object.currency) };
        if (type === 'checkout.session.completed') {
          // 'unpaid' = a delayed method (bank debit, voucher): wait for async_payment_succeeded / _failed.
          return sessionStatus(object) === 'succeeded' ? { ...fromSession, type: 'payment.succeeded' } : ignored;
        }
        if (type === 'checkout.session.async_payment_succeeded') return { ...fromSession, type: 'payment.succeeded' };
        if (type === 'checkout.session.async_payment_failed') return { ...fromSession, type: 'payment.failed' };
        if (type === 'checkout.session.expired') return { ...fromSession, type: 'payment.expired' };
        return ignored;
      }

      if (type === 'payment_intent.payment_failed') {
        // A declined card does not end a hosted session: the customer can try another card on the same page.
        // So this is 'payment.failed' only once the session is no longer open; until then it is just noise.
        if (!object.metadata?.order_public_id) return ignored;
        const session = await sessionOfIntent(object.id);
        if (!session || session.status === 'open' || sessionStatus(session) === 'succeeded') return ignored;
        return { ...base, type: 'payment.failed', providerRef: session.id, providerPaymentRef: object.id, amount: object.amount, currency: upper(object.currency) };
      }

      if (type === 'charge.refunded') {
        const paymentIntent = idOf(object.payment_intent);
        if (!paymentIntent || !object.metadata?.order_public_id) return ignored;
        const before = event.data?.previous_attributes?.amount_refunded;
        const total = object.amount_refunded;
        let providerRef;
        try { providerRef = (await sessionOfIntent(paymentIntent))?.id; }
        catch (err) { log.warn(`[pay:${id}] session lookup for a refund failed (${err.code}); core can match on providerPaymentRef`); }
        return { ...base, type: 'refund.succeeded', providerRef, providerPaymentRef: paymentIntent, amount: isMinor(before) && total > before ? total - before : total, totalRefunded: total, currency: upper(object.currency) };
      }

      if (type === 'refund.failed' || (type === 'charge.refund.updated' && object.status === 'failed')) {
        const paymentIntent = idOf(object.payment_intent);
        if (!paymentIntent || !object.metadata?.order_public_id) return ignored;
        return { ...base, type: 'refund.failed', providerPaymentRef: paymentIntent, amount: object.amount, currency: upper(object.currency) };
      }

      return ignored;
    }

    return {
      id,
      apiVersion: STRIPE_API_VERSION,
      capabilities: () => ({ countries: account.countries.slice(), currencies: account.currencies.slice(), methods: ['card'], refunds: true }),

      async createCheckout({ order, items, shipping, payment, urls }) {
        const currency = upper(field(payment, 'currency'));
        const amount = field(payment, 'amount');
        const idemKey = field(payment, 'idemKey');
        const publicId = field(order, 'publicId');
        if (!account.currencies.includes(currency)) throw new ProviderError('STRIPE_CURRENCY_NOT_SERVED', `${id} does not charge ${currency}`, { provider: id });
        if (!Number.isInteger(amount) || amount <= 0) throw new ProviderError('STRIPE_BAD_AMOUNT', 'payment amount must be a positive integer', { provider: id });
        if (!idemKey || !publicId || !urls?.success) throw new ProviderError('STRIPE_BAD_INPUT', 'idemKey, order.publicId and urls.success are required', { provider: id });

        const charge = chargeLines({ order, items, shipping, payment });
        if (charge.consolidated) log.warn(`[pay:${id}] order ${publicId}: lines + shipping differ from the payment amount; sent as one line`);
        const cur = currency.toLowerCase();
        const metadata = { order_public_id: String(publicId), payment_id: String(field(payment, 'id') ?? '') };
        const expiresAt = now() + CHECKOUT_TTL_MS;
        const lang = field(order, 'lang');
        const params = {
          mode: 'payment',
          ui_mode: 'hosted_page',
          line_items: charge.lines.map((l) => ({
            quantity: l.quantity,
            price_data: { currency: cur, unit_amount: l.unitAmount, product_data: { name: l.name } },
          })),
          client_reference_id: String(publicId),
          metadata,
          payment_intent_data: { metadata, description: `Order ${publicId}` }, // copied to the PaymentIntent and its Charge: refund events find the order by it
          locale: stripeLocale(lang),
          success_url: urls.success,
          expires_at: Math.floor(expiresAt / 1000),
        };
        if (urls.cancel) params.cancel_url = urls.cancel;
        const email = field(order, 'email');
        if (email) params.customer_email = email;
        if (!charge.consolidated && shipping) {
          params.shipping_options = [{
            shipping_rate_data: {
              type: 'fixed_amount',
              display_name: await shippingLabel(lang, shipping.labelKey, deps),
              fixed_amount: { amount: charge.shipping, currency: cur },
            },
          }];
        }

        const session = await call(() => client.checkout.sessions.create(params, { idempotencyKey: String(idemKey) }));
        if (!session?.url || !session.id) throw new ProviderError('STRIPE_NO_URL', 'Stripe returned no checkout URL', { provider: id });
        if (isMinor(session.amount_total) && session.amount_total !== amount) {
          // Never send a customer to a page that asks for a different amount than the order's.
          await client.checkout.sessions.expire(session.id).catch(() => {});
          throw new ProviderError('STRIPE_AMOUNT_MISMATCH', `Stripe total ${session.amount_total} differs from the order's ${amount}`, { provider: id });
        }
        return { kind: 'redirect', url: session.url, providerRef: session.id, expiresAt: session.expires_at ? session.expires_at * 1000 : expiresAt };
      },

      /** Signature first (raw bytes + this account's secret), then mapping. A payload signed for the other account fails here. */
      async parseWebhook({ rawBody, headers }) {
        const signature = headers?.['stripe-signature'];
        let event;
        try {
          if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string') throw new Error('missing raw body or Stripe-Signature header');
          event = Stripe.webhooks.constructEvent(rawBody, signature, keys.webhookSecret); // HMAC-SHA256, constant time, 5-minute tolerance
        } catch (err) {
          throw new AppError('WEBHOOK_SIGNATURE', 400, 'Invalid webhook signature');
        }
        if (!event || typeof event.id !== 'string') throw new AppError('WEBHOOK_SIGNATURE', 400, 'Invalid webhook payload');
        return [await mapEvent(event)];
      },

      async getPayment(providerRef) {
        const session = await call(() => client.checkout.sessions.retrieve(providerRef));
        return { status: sessionStatus(session), providerPaymentRef: idOf(session.payment_intent), amount: session.amount_total, currency: upper(session.currency) };
      },

      async refund({ payment, amount, reason, idempotencyKey }) {
        if (!Number.isInteger(amount) || amount <= 0) throw new ProviderError('STRIPE_BAD_AMOUNT', 'refund amount must be a positive integer', { provider: id });
        if (!idempotencyKey) throw new ProviderError('STRIPE_BAD_INPUT', 'refund needs an idempotency key', { provider: id });
        let paymentIntent = field(payment, 'providerPaymentRef');
        if (!paymentIntent && field(payment, 'providerRef')) {
          const session = await call(() => client.checkout.sessions.retrieve(field(payment, 'providerRef')));
          paymentIntent = idOf(session.payment_intent);
        }
        if (!paymentIntent) throw new ProviderError('STRIPE_NOT_PAID', 'this payment has no PaymentIntent to refund', { provider: id });
        const params = { payment_intent: paymentIntent, amount, metadata: { payment_id: String(field(payment, 'id') ?? ''), reason: String(reason || '').slice(0, 400) } };
        if (['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) params.reason = reason; // Stripe accepts only these three
        const refund = await call(() => client.refunds.create(params, { idempotencyKey: String(idempotencyKey) }));
        if (refund.status === 'failed' || refund.status === 'canceled') {
          throw new ProviderError('STRIPE_REFUND_FAILED', `refund ${refund.id} is ${refund.status}${refund.failure_reason ? `: ${refund.failure_reason}` : ''}`, { provider: id });
        }
        return { status: refund.status === 'succeeded' ? 'succeeded' : 'pending', refundRef: refund.id };
      },
    };
  };
}

/** Contract shape `create(config, deps)`; the registry uses createStripe(id) for each account. */
export const create = (config, deps, id = 'stripe_es') => createStripe(id)(config, deps);
