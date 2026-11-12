// Identifiers and constant-time helpers. Owner: core.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes, same as src/js/checkout.js

/** Order reference shown to the customer: TCD-YYMMDD-XXXX (UTC date). */
export function publicId(at = Date.now()) {
  const d = new Date(at);
  const two = (n) => String(n).padStart(2, '0');
  let tail = '';
  for (let i = 0; i < 4; i += 1) tail += ALPHABET[randomInt(ALPHABET.length)];
  return `TCD-${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${tail}`;
}

/** 32 random bytes as hex. */
export const token = () => randomBytes(32).toString('hex');

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Constant-time string comparison (both sides are hashed first, so length does not leak). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What is stored in orders.checkout_id: a 36-character hash of the browser's checkout UUID (never the UUID itself). */
export const checkoutKey = (checkoutId) => sha256(`tcd:checkout:${checkoutId}`).slice(0, 36);

/**
 * Order access token. It is derived from the browser's secret checkout UUID, so a repeated POST /api/checkout
 * can answer the same token although only its SHA-256 is stored (see "Core notes" in COMMERCE_ARCH.md).
 */
/**
 * The token inside the order-status link of customer e-mails. The checkout token is never stored (only its SHA-256),
 * so the e-mail link carries its own: an HMAC over the order id and that stored hash, keyed with ORDER_LINK_SECRET.
 * It is computed when an e-mail is rendered and when a link is checked; it is never written to the database or a log.
 */
export const orderLinkToken = (secret, publicId, tokenHash) => createHmac('sha256', String(secret)).update(`tcd:order-link:v1:${publicId}:${tokenHash}`).digest('hex');

export const orderToken = (checkoutId) => createHmac('sha256', String(checkoutId)).update('tcd:order-token:v1').digest('hex');
