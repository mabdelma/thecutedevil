// The ONLY place tax is calculated. Owner: core. Contract: section h. Everything else treats the result as opaque.
// v1 shows and records tax; it does not file, register or decide anything.
import { readFileSync } from 'node:fs';
import { AppError } from '../lib/errors.js';

export const loadTaxRules = (file = new URL('./tax-rules.json', import.meta.url)) => JSON.parse(readFileSync(file, 'utf8'));
let cached = null;
const defaults = () => (cached ||= loadTaxRules());

/** Tax contained in a gross amount: gross x r / (1 + r), in integer arithmetic. */
const containedTax = (gross, rateBp) => Math.round((gross * rateBp) / (10000 + rateBp));

/**
 * @param {{country: string, region?: string, currency?: string, lines: Array<{key: string, total: number}>, shipping: number}} input
 * @param {object} [rules]  defaults to pricing/tax-rules.json
 * @returns {{included: boolean, rateBp: number, amount: number, shippingAmount: number, lines: Array<{key: string, amount: number}>, labelKey: string, notices: string[]}}
 */
export function computeTax(input, rules = defaults()) {
  const rule = rules?.countries?.[input.country];
  if (!rule || !Number.isInteger(rule.rateBp) || rule.rateBp < 0) throw new AppError('MARKET_NOT_SERVED', 422, 'We do not ship to this country yet.');
  const included = rule.included !== false;
  const rateBp = rule.rateBp;
  const notices = rule.duties ? [rules.notices?.duties || 'checkout.notice.dutiesMayApply'] : [];
  const shipping = Number.isInteger(input.shipping) ? input.shipping : 0;
  const net = input.lines.reduce((n, l) => n + l.total, 0) + shipping;
  let lines;
  let amount;
  if (included) {
    amount = containedTax(net, rateBp); // on the whole order, so the lines never drift from the total
    lines = input.lines.map((l) => ({ key: l.key, amount: containedTax(l.total, rateBp) }));
  } else {
    lines = input.lines.map((l) => ({ key: l.key, amount: Math.round((l.total * rateBp) / 10000) }));
    amount = lines.reduce((n, l) => n + l.amount, 0) + Math.round((shipping * rateBp) / 10000);
  }
  const shippingAmount = amount - lines.reduce((n, l) => n + l.amount, 0); // the remainder, so the parts add up exactly
  const labelKey = rateBp === 0 ? (included ? 'checkout.tax.none' : 'checkout.tax.excluded') : included ? 'checkout.tax.vatIncluded' : 'checkout.tax.added';
  return { included, rateBp, amount, shippingAmount, lines, labelKey, notices };
}
