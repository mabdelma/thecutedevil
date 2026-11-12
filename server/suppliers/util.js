// Small shared helpers for supplier adapters. Owner: sup. No network, no env.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ProviderError } from '../lib/errors.js';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const hmacSha256Hex = (key, value) => createHmac('sha256', key).update(value).digest('hex');

/** Constant-time string comparison (both sides hashed first, so length does not leak). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export const badSignature = () => new AppError('WEBHOOK_SIGNATURE', 400, 'Webhook verification failed');

/** Shared-secret-in-URL check (`?key=<…_WEBHOOK_SECRET>`), used where the supplier offers no signature. */
export function assertUrlKey(query, secret) {
  const key = query && typeof query.key === 'string' ? query.key : '';
  if (!safeEqual(key, secret)) throw badSignature();
}

export const header = (headers, name) => {
  if (!headers) return '';
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? String(v[0] || '') : typeof v === 'string' ? v : '';
};

export function parseJsonBody(rawBody) {
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    const data = JSON.parse(text);
    if (data && typeof data === 'object') return data;
  } catch (err) { /* fall through */ }
  throw new AppError('VALIDATION', 400, 'Webhook body is not JSON');
}

/** "13.60" | 13.6 → 1360 (minor units, two decimals). Returns null for anything that is not a number. */
export function toMinor(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
export const fromMinor = (minor) => (Math.round(minor) / 100).toFixed(2);

/** "Jane van Dam" → { first: 'Jane', last: 'van Dam' }. A single word is used for both (suppliers require both). */
export function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Milliseconds from an epoch-seconds number, epoch-ms number, or a date string ("2017-04-18 13:24:28+00:00"). */
export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  const t = Date.parse(String(value).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/* ---- mapping helpers ------------------------------------------------------------------------ */

export const PLACEHOLDER = 'PLACEHOLDER';
export const isPlaceholderRef = (ref) => typeof ref !== 'string' || ref === '' || ref.toUpperCase().startsWith(PLACEHOLDER);

/** Contract rule: unavailable when there is no mapping or the region is not listed. Placeholder refs never ship. */
export function isMapped(line, destination) {
  const m = line && line.mapping;
  if (!m || !Array.isArray(m.regions) || !destination || !m.regions.includes(destination.region)) return false;
  return !isPlaceholderRef(String(m.variantRef ?? '')) && !isPlaceholderRef(String(m.productRef ?? ''));
}

const DEFAULT_DAYS = [5, 12];

/** Static quote from the mapping's `cost` and `days` (source: 'table'). */
export function tableQuote(supplier, lines, { shippingMethod = 'standard', defaultCurrency = 'EUR', defaultDays = DEFAULT_DAYS } = {}) {
  let currency = null; let itemsCost = 0; let shippingCost = 0; let minDays = 0; let maxDays = 0;
  for (const line of lines) {
    const m = line.mapping || {};
    if (m.cost && Number.isInteger(m.cost.amount)) {
      if (!currency) currency = m.cost.currency;
      if (m.cost.currency === currency) itemsCost += m.cost.amount * line.qty;
    }
    if (m.shipping && Number.isInteger(m.shipping.amount)) shippingCost = Math.max(shippingCost, m.shipping.amount);
    const days = Array.isArray(m.days) && m.days.length === 2 ? m.days : defaultDays;
    minDays = Math.max(minDays, days[0]); maxDays = Math.max(maxDays, days[1]);
  }
  return { supplier, currency: currency || defaultCurrency, itemsCost, shippingCost, total: itemsCost + shippingCost, minDays, maxDays, shippingMethod, source: 'table' };
}

/** Resolve with fn()'s value, or reject with a retryable TIMEOUT after ms. */
export function withTimeout(promise, ms, provider) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError('TIMEOUT', `${provider}: no answer within ${ms} ms`, { retryable: true, provider })), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

/**
 * Print files for one line: the mapping's fixed artwork plus one file per personalisation field.
 * mapping.personalisation[key] = { placement, urlTemplate? }:
 *   - text field: urlTemplate must contain {value}; it points at the owner's renderer that returns a print file.
 *   - file field: the value itself is an https URL and is passed through.
 * A personalised line the mapping cannot turn into a file is NOT sent: non-retryable error → next candidate → manual.
 */
export function printFiles(line, provider) {
  const m = line.mapping || {};
  const files = (m.files || []).map((f) => ({ ...f }));
  const p = line.personalisation && typeof line.personalisation === 'object' ? line.personalisation : {};
  for (const [key, raw] of Object.entries(p)) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const rule = m.personalisation && m.personalisation[key];
    if (rule && /^https:\/\/\S+$/i.test(value) && !rule.urlTemplate) files.push({ placement: rule.placement || 'default', url: value });
    else if (rule && typeof rule.urlTemplate === 'string' && rule.urlTemplate.includes('{value}')) {
      files.push({ placement: rule.placement || 'default', url: rule.urlTemplate.replace('{value}', encodeURIComponent(value)) });
    } else {
      throw new ProviderError('PERSONALISATION_NEEDS_HUMAN', `${provider}: no print-file rule for personalisation field "${key}"`, { retryable: false, provider });
    }
  }
  return files;
}

/** true/false from an optional config value ('1', 'true', true …), else the default. */
export function boolOpt(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === 'string' && value.trim() !== '') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return fallback;
}

export const notFound = (err) => err instanceof ProviderError && err.status === 404;
