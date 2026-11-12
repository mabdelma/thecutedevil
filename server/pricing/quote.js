// The quote: every number the customer sees, computed on the server. Owner: core. Contract: section f.
// The browser sends ids, quantities and options only. Prices come from the catalogue, shipping and tax from the
// rule files, availability from the routing engine. POST /api/checkout runs this again and trusts nothing else.
import { priceOf } from '../catalogue/index.js';
import { route } from '../routing/engine.js';
import { shippingOptions } from './shipping.js';
import { computeTax } from './tax.js';

/** [{ method, provider }] for a destination: the first provider (registry order) wins each method. */
export function paymentMethodsFor(ctx, { country, currency }) {
  const seen = new Map();
  for (const { provider, methods } of ctx.payments.forDestination({ country, currency })) {
    for (const method of methods) if (!seen.has(method)) seen.set(method, provider.id);
  }
  return Array.from(seen, ([method, provider]) => ({ method, provider }));
}

/**
 * @param {object} input  the result of validateQuoteInput / validateCheckoutInput
 * @param {object} ctx
 * @returns {Promise<{quote: object, internal: object}>}  `quote` is the public answer (no supplier ids);
 *   `internal` carries what checkout needs (priced lines, routing with suppliers, the provider per method).
 */
export async function buildQuote(input, ctx) {
  const { country, region, currency } = input;
  const destination = { country, region, state: input.state || '', postcode: input.postcode || '', city: input.city || '' };
  const unavailable = [];
  const lines = [];
  for (const item of input.items) {
    if (!item.purchasable) { unavailable.push({ key: item.key, reason: 'NOT_FOR_SALE' }); continue; }
    const unit = priceOf(item.product, item.options, currency, item.personalisation);
    lines.push({
      key: item.key, id: item.id, productId: item.id, variantKey: item.variantKey, category: item.product.category, qty: item.qty,
      options: item.options, personalisation: item.personalisation, unit, total: unit * item.qty,
      name: ctx.catalogue.nameOf(item.id), weightG: item.product.weightG,
    });
  }

  let routing = await route(lines, destination, ctx);
  let methods = paymentMethodsFor(ctx, { country, currency });
  let cod = false;
  if (methods.some((m) => m.method === 'cod')) {
    // COD is offered only when every line can go to a supplier that collects cash
    const codRouting = lines.length ? await route(lines, destination, ctx, { cod: true }) : { fulfilments: [], unavailable: [] };
    const codOk = lines.length > 0 && routing.unavailable.length === 0 && codRouting.unavailable.length === 0
      && codRouting.fulfilments.every((f) => f.supplier === 'manual' || ctx.suppliers.get(f.supplier)?.capabilities.cod === true);
    if (!codOk) methods = methods.filter((m) => m.method !== 'cod');
    else if (input.paymentMethod === 'cod') { routing = codRouting; cod = true; }
  }
  unavailable.push(...routing.unavailable);

  const gone = new Set(unavailable.map((u) => u.key));
  const sold = lines.filter((l) => !gone.has(l.key));
  const fulfilmentOf = new Map();
  routing.fulfilments.forEach((f, index) => f.lineKeys.forEach((key) => fulfilmentOf.set(key, index)));

  const subtotal = sold.reduce((n, l) => n + l.total, 0);
  const days = (f) => ({ minDays: Number.isFinite(f.quote?.minDays) ? f.quote.minDays : null, maxDays: Number.isFinite(f.quote?.maxDays) ? f.quote.maxDays : null });
  const allDays = routing.fulfilments.map(days);
  const minDays = allDays.length && allDays.every((d) => d.minDays !== null) ? Math.min(...allDays.map((d) => d.minDays)) : null;
  const maxDays = allDays.length && allDays.every((d) => d.maxDays !== null) ? Math.max(...allDays.map((d) => d.maxDays)) : null;
  const options = sold.length ? shippingOptions(sold, destination, currency, ctx.shippingRates).map((o) => ({ ...o, minDays, maxDays })) : [];
  const chosen = options.find((o) => o.id === input.shippingOption) || options[0] || null;
  const shipping = chosen ? chosen.amount : 0;
  const tax = computeTax({ country, region, currency, lines: sold.map((l) => ({ key: l.key, total: l.total })), shipping }, ctx.taxRules);
  const total = subtotal + shipping + (tax.included ? 0 : tax.amount);
  const notices = [...(routing.fulfilments.length > 1 ? ['checkout.notice.splitShipment'] : []), ...tax.notices];

  const quote = {
    country, region, currency,
    lines: sold.map((l) => ({ key: l.key, id: l.id, qty: l.qty, unit: l.unit, total: l.total, fulfilment: fulfilmentOf.get(l.key) ?? 0 })),
    unavailable,
    shippingOptions: options,
    shippingOption: chosen ? chosen.id : null, // the option `shipping`, `tax` and `total` below are priced for
    fulfilments: routing.fulfilments.map((f, index) => ({ index, lineKeys: f.lineKeys.slice(), ...days(f) })),
    tax: { included: tax.included, rateBp: tax.rateBp, amount: tax.amount, labelKey: tax.labelKey },
    subtotal, shipping, total,
    paymentMethods: sold.length ? methods : [],
    notices,
  };
  return { quote, internal: { destination, lines: sold, routing, tax, shippingOption: chosen ? chosen.id : null, methods, cod } };
}
