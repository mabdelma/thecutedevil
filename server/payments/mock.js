// Mock provider: the only one loaded when COMMERCE_MODE=mock. Owner: pay.
// createCheckout answers a local URL (/api/mock/pay/:paymentId, served by routes/mock-pay.js) where a tester
// chooses "pay" or "fail"; that route then posts an event signed with HMAC-SHA256 (key `mock`) to
// /api/webhooks/mock, exactly like a real provider would. Nothing here is a secret: mock mode is for testing.
import { AppError, ProviderError } from '../lib/errors.js';
import { CHECKOUT_TTL_MS, field, hmacHex, sameHex } from './interface.js';

export const MOCK_KEY = 'mock';
export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';
const ALL_CURRENCIES = ['EUR', 'GBP', 'CAD', 'USD', 'AED', 'SAR', 'EGP'];
const EVENT_TYPES = ['payment.succeeded', 'payment.failed', 'payment.expired', 'refund.succeeded', 'refund.failed', 'ignored'];

export const signMockBody = (rawBody) => hmacHex('sha256', MOCK_KEY, rawBody);

/** The pay page is stateless: everything it needs travels in its own signed query string. */
const linkString = (q) => [q.id, q.ref, q.amount, q.currency, q.success, q.cancel].join('\n');
export const signMockLink = (q) => hmacHex('sha256', MOCK_KEY, linkString(q));
export const verifyMockLink = (q) => sameHex(signMockLink(q), String(q.sig || ''));

/** The event the pay page (or a test) delivers. Deterministic id: pressing a button twice is one event. */
export function mockEvent({ providerRef, outcome, amount, currency, occurredAt = Date.now() }) {
  const type = outcome === 'pay' ? 'payment.succeeded' : outcome === 'fail' ? 'payment.failed' : outcome;
  return { id: `mockevt_${providerRef}_${type}`, type, providerRef, providerPaymentRef: `mockpay_${providerRef}`, amount, currency, occurredAt };
}

/** @returns {import('./interface.js').PaymentProvider | null} */
export function create(config, deps = {}) {
  if (config.mode !== 'mock') return null;
  const now = deps.now || Date.now;
  const seen = new Map(); // providerRef → { status, amount, currency }: only so getPayment can answer within one process

  return {
    id: 'mock',
    capabilities: () => ({ countries: '*', currencies: ALL_CURRENCIES.slice(), methods: ['card', 'cod'], refunds: true }),

    async createCheckout({ order, payment, urls }) {
      const paymentId = field(payment, 'id');
      const amount = field(payment, 'amount');
      const currency = String(field(payment, 'currency') || '').toUpperCase();
      const idemKey = field(payment, 'idemKey');
      if (paymentId === undefined || !idemKey || !Number.isInteger(amount)) throw new ProviderError('MOCK_BAD_INPUT', 'payment.id, payment.idemKey and payment.amount are required', { provider: 'mock' });
      const providerRef = `mock_${hmacHex('sha256', MOCK_KEY, String(idemKey)).slice(0, 24)}`; // same idemKey → same session
      if (field(payment, 'method') === 'cod') return { kind: 'confirmed', providerRef };
      const q = { id: String(paymentId), ref: providerRef, amount: String(amount), currency, success: urls?.success || '/', cancel: urls?.cancel || '/' };
      seen.set(providerRef, { status: 'pending', amount, currency });
      const query = new URLSearchParams({ ...q, order: String(field(order, 'publicId') || ''), sig: signMockLink(q) });
      // Relative on purpose: it works behind the Vite proxy and on any test port.
      return { kind: 'redirect', url: `/api/mock/pay/${encodeURIComponent(q.id)}?${query}`, providerRef, expiresAt: now() + CHECKOUT_TTL_MS };
    },

    async parseWebhook({ rawBody, headers }) {
      const signature = headers?.[MOCK_SIGNATURE_HEADER];
      if (!Buffer.isBuffer(rawBody) || !sameHex(signMockBody(rawBody), String(signature || ''))) throw new AppError('WEBHOOK_SIGNATURE', 400, 'Invalid webhook signature');
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch (err) { throw new AppError('WEBHOOK_SIGNATURE', 400, 'Invalid webhook payload'); }
      const list = Array.isArray(body) ? body : [body];
      return list.map((e) => {
        if (!e || typeof e.id !== 'string' || !EVENT_TYPES.includes(e.type)) throw new AppError('WEBHOOK_SIGNATURE', 400, 'Invalid webhook payload');
        const status = { 'payment.succeeded': 'succeeded', 'payment.failed': 'failed', 'payment.expired': 'expired' }[e.type];
        if (status && e.providerRef && seen.get(e.providerRef)?.status !== 'succeeded') seen.set(e.providerRef, { status, amount: e.amount, currency: e.currency });
        return { eventId: e.id, type: e.type, providerRef: e.providerRef, providerPaymentRef: e.providerPaymentRef, amount: e.amount, currency: e.currency, occurredAt: Number(e.occurredAt) || now() };
      });
    },

    async getPayment(providerRef) {
      const s = seen.get(providerRef) || { status: 'pending' };
      return { status: s.status, providerPaymentRef: s.status === 'succeeded' ? `mockpay_${providerRef}` : undefined, amount: s.amount, currency: s.currency };
    },

    async refund({ amount, idempotencyKey }) {
      if (!Number.isInteger(amount) || amount <= 0) throw new ProviderError('MOCK_BAD_AMOUNT', 'refund amount must be a positive integer', { provider: 'mock' });
      return { status: 'succeeded', refundRef: `mockre_${hmacHex('sha256', MOCK_KEY, String(idempotencyKey)).slice(0, 24)}` };
    },
  };
}
