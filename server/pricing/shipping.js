// Customer shipping price: one price per order from shipping-rates.json. Owner: core. Contract: section f.
import { readFileSync } from 'node:fs';
import { AppError } from '../lib/errors.js';

export const loadShippingRates = (file = new URL('./shipping-rates.json', import.meta.url)) => JSON.parse(readFileSync(file, 'utf8'));
let cached = null;
const defaults = () => (cached ||= loadShippingRates());

/**
 * @param {Array<{qty: number, total: number}>} lines   server-priced lines
 * @param {{region: string}} destination
 * @param {string} currency
 * @param {object} [rates]  defaults to pricing/shipping-rates.json
 * @returns {Array<{id: 'standard', amount: number}>}
 */
export function shippingOptions(lines, destination, currency, rates = defaults()) {
  const rule = rates?.[destination.region]?.[currency];
  if (!rule || !Number.isInteger(rule.base) || rule.base < 0) throw new AppError('MARKET_NOT_SERVED', 422, 'We do not ship to this country yet.');
  const items = lines.reduce((n, l) => n + l.qty, 0);
  const subtotal = lines.reduce((n, l) => n + l.total, 0);
  const perExtra = Number.isInteger(rule.perExtraItem) && rule.perExtraItem > 0 ? rule.perExtraItem : 0;
  const free = Number.isInteger(rule.freeFrom) && subtotal >= rule.freeFrom;
  return [{ id: 'standard', amount: free ? 0 : rule.base + perExtra * Math.max(0, items - 1) }];
}
