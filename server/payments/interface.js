// PaymentProvider contract. Owner: pay. Full text: web/COMMERCE_ARCH.md section d.
// A provider module exports `create(config, deps) → provider | null` (null = its env vars are missing).
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @typedef {Object} PaymentCapabilities
 * @property {string[]|'*'} countries  ISO-3166 alpha-2 destination countries
 * @property {string[]} currencies     ISO-4217 codes it can charge
 * @property {Array<'card'|'wallet'|'cod'>} methods
 * @property {boolean} refunds
 *
 * @typedef {Object} PaymentEvent
 * @property {string} eventId   provider's unique event id (dedupe key)
 * @property {'payment.succeeded'|'payment.failed'|'payment.expired'|'refund.succeeded'|'refund.failed'|'ignored'} type
 * @property {string} [providerRef]         payments.provider_ref
 * @property {string} [providerPaymentRef]  payments.provider_payment_ref
 * @property {number} [amount]  minor units. payment.*: the amount of the payment. refund.*: the amount of THIS refund.
 * @property {number} [totalRefunded]  refund.* only, when the provider reports it: everything refunded so far on the payment
 * @property {string} [refundRef]  refund.* only, for providers without a running total (Paymob): the id of THIS refund, the same
 *                                 value refund() returns, so core can add separate refunds up and still count each one once
 * @property {string} [currency]
 * @property {number} occurredAt  epoch ms
 *
 * @typedef {Object} PaymentProvider
 * @property {string} id
 * @property {() => PaymentCapabilities} capabilities
 * @property {(input: object) => Promise<{kind:'redirect',url:string,providerRef:string,expiresAt:number}|{kind:'confirmed',providerRef:string}>} createCheckout
 * @property {(req: {rawBody:Buffer, headers:object, query:object}) => Promise<PaymentEvent[]>} parseWebhook
 * @property {(providerRef: string) => Promise<{status:'pending'|'succeeded'|'failed'|'expired', providerPaymentRef?:string, amount:number, currency:string}>} getPayment
 * @property {(input: {payment:object, amount:number, reason:string, idempotencyKey:string}) => Promise<{status:'succeeded'|'pending', refundRef:string}>} refund
 */

export const PAYMENT_METHODS = ['id', 'capabilities', 'createCheckout', 'parseWebhook', 'getPayment', 'refund'];

/** Throws when an object does not have the whole PaymentProvider surface. Used by the registry and by tests. */
export function assertPaymentProvider(p) {
  for (const key of PAYMENT_METHODS) {
    const ok = key === 'id' ? typeof p?.id === 'string' && p.id : typeof p?.[key] === 'function';
    if (!ok) throw new TypeError(`payment provider ${p?.id || '?'}: missing ${key}`);
  }
  return p;
}

/* ---- helpers shared by the provider modules (pay only) ---------------------------------------- */

/** Session / intention lifetime. Stripe's minimum is 30 minutes; one extra minute absorbs clock skew. */
export const CHECKOUT_TTL_MS = 31 * 60 * 1000;

/** Rows reach providers in camelCase (contract); snake_case is accepted too so a raw Knex row also works. */
export function field(row, camel) {
  if (!row) return undefined;
  if (row[camel] !== undefined && row[camel] !== null) return row[camel];
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return row[snake] === null ? undefined : row[snake];
}

export const isMinor = (n) => Number.isInteger(n) && n >= 0;

/**
 * Turn the server-computed order lines into what a provider charges.
 * The amount charged must always equal payments.amount. When lines + shipping do not add up to it
 * (a discount, exclusive tax, …) the order is sent as ONE line of exactly payments.amount.
 * @returns {{ lines: Array<{name: string, quantity: number, unitAmount: number}>, shipping: number, consolidated: boolean }}
 */
export function chargeLines({ order, items, shipping, payment }) {
  const total = field(payment, 'amount');
  const shippingAmount = isMinor(shipping?.amount) ? shipping.amount : 0;
  const lines = [];
  let sum = shippingAmount;
  let valid = Array.isArray(items) && items.length > 0;
  for (const item of valid ? items : []) {
    const qty = item.qty;
    const lineTotal = isMinor(item.lineTotal) ? item.lineTotal : item.unitPrice * qty;
    if (!Number.isInteger(qty) || qty < 1 || !isMinor(lineTotal) || !item.name) { valid = false; break; }
    const name = String(item.name).slice(0, 200);
    if (isMinor(item.unitPrice) && item.unitPrice * qty === lineTotal) lines.push({ name, quantity: qty, unitAmount: item.unitPrice });
    else lines.push({ name: `${name} × ${qty}`.slice(0, 250), quantity: 1, unitAmount: lineTotal });
    sum += lineTotal;
  }
  if (valid && sum === total) return { lines, shipping: shippingAmount, consolidated: false };
  return { lines: [{ name: `Order ${field(order, 'publicId')}`, quantity: 1, unitAmount: total }], shipping: 0, consolidated: true };
}

export const hmacHex = (algorithm, key, data) => createHmac(algorithm, key).update(data).digest('hex');

/** Constant-time comparison of two hex digests (false for any malformed or different-length input). */
export function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  const x = Buffer.from(a.toLowerCase(), 'utf8');
  const y = Buffer.from(b.toLowerCase(), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "Shipping" in the customer's language: core's i18n when it has the key, else a built-in word. */
const SHIPPING_WORD = { en: 'Shipping', es: 'Envío', fr: 'Livraison', de: 'Versand', it: 'Spedizione', pt: 'Envio', ar: 'الشحن', ru: 'Доставка', hi: 'शिपिंग', ja: '配送', zh: '配送' };
let i18nModule;
export async function shippingLabel(lang, labelKey, deps = {}) {
  const fallback = SHIPPING_WORD[lang] || SHIPPING_WORD.en;
  if (!labelKey) return fallback;
  try {
    let t = deps.t;
    if (!t) {
      if (i18nModule === undefined) i18nModule = await import('../i18n.js').catch(() => null);
      t = i18nModule?.t;
    }
    const text = t ? t(lang, labelKey) : '';
    return typeof text === 'string' && text.trim() && text !== labelKey ? text.slice(0, 100) : fallback;
  } catch (err) { return fallback; }
}
