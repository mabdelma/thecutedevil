// Input validation for the public API. Owner: core. Contract: section f ("Validation").
// Nothing the browser says about prices is read here except `expectedTotal`, which is only compared.
import { AppError } from './errors.js';
import { UUID_RE } from './ids.js';
import { LANGS, DEFAULT_LANG, addressRules, currencyOf, isMarketEnabled, regionOf } from '../markets.js';
import { lineKey, variantKey } from '../catalogue/index.js';

export const LIMITS = Object.freeze({ lines: 20, qty: [1, 10], name: [2, 60], email: 191, line1: [3, 191], line2: 191, city: [2, 120], state: 120, postcode: 20, note: 300 });
export const PAYMENT_METHODS = Object.freeze(['card', 'wallet', 'cod']);

/** Trim, collapse whitespace and strip control characters: the same rule as src/js/checkout.js. */
export function tidy(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const text = (v) => (typeof v === 'string' || typeof v === 'number' ? tidy(v) : '');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function isEmail(value) {
  if (typeof value !== 'string' || value.length > LIMITS.email || /\s/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64) return false;
  return /^[^.@][^@]*\.[^.@]{2,}$/.test(parts[1]) && !parts[1].includes('..') && /^[A-Za-z0-9.-]+$/.test(parts[1]);
}

/** '+34 622-20 99 35' → '+34622209935', or '' when it is not E.164. */
export function normalisePhone(value) {
  const compact = text(value).replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : '';
}

/**
 * Words that must not be sent to a supplier without a person looking first (other people's brands, abuse).
 * A hit does not reject the order: the fulfilment is parked as `manual` (section l).
 */
export const PERSONALISATION_BLOCKLIST = Object.freeze([
  'nike', 'adidas', 'puma', 'gucci', 'prada', 'chanel', 'dior', 'hermes', 'louisvuitton', 'supreme', 'rolex', 'zara',
  'disney', 'marvel', 'pokemon', 'barbie', 'nintendo', 'starwars', 'harrypotter', 'cocacola', 'pepsi', 'ferrari', 'apple',
  'realmadrid', 'barcelona', 'fifa', 'uefa', 'nba', 'nfl',
  'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'nazi', 'hitler', 'isis', 'kkk', 'rape', 'puta', 'mierda',
]);

/** True when a personalisation text needs a human before production. */
export function isDoubtfulText(value) {
  const flat = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[01345@$]/g, (c) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', '@': 'a', $: 's' }[c])).replace(/[^\p{L}\p{N}]/gu, '');
  return PERSONALISATION_BLOCKLIST.some((word) => flat.includes(word));
}

class Problems {
  constructor() { this.fields = {}; }
  add(field, reason) { if (!(field in this.fields)) this.fields[field] = reason; }
  get any() { return Object.keys(this.fields).length > 0; }
  throwIfAny() { if (this.any) throw new AppError('VALIDATION', 400, 'Please check the highlighted fields.', { fields: this.fields }); }
}

function cleanPersonalisation(product, raw, where, problems) {
  const declared = product.personalisation || [];
  const out = {};
  if (raw != null && !isObject(raw)) { problems.add(where, 'invalid'); return null; }
  for (const key of Object.keys(raw || {})) if (!declared.some((f) => f.key === key) && text(raw[key]) !== '') problems.add(`${where}.${key}`, 'unknown');
  for (const field of declared) {
    const value = raw ? text(raw[field.key]) : '';
    if (!value) { if (field.required) problems.add(`${where}.${field.key}`, 'required'); continue; }
    if (Array.from(value).length > field.maxLength) { problems.add(`${where}.${field.key}`, 'too_long'); continue; }
    let ok = false;
    try { ok = new RegExp(field.pattern, 'u').test(value); } catch (err) { ok = false; }
    if (!ok) { problems.add(`${where}.${field.key}`, 'pattern'); continue; }
    out[field.key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Body of POST /api/quote → clean input. Throws AppError (VALIDATION 400, MARKET_NOT_SERVED 422, CART_EMPTY 422).
 * @param {object} body
 * @param {{config: object, catalogue: object}} ctx   catalogue = createCatalogue() view
 * @returns {{country, region, currency, state, postcode, city, lang, paymentMethod, shippingOption, items: Array<{key, id, product, qty, options, variantKey, personalisation, purchasable}>}}
 */
export function validateQuoteInput(body, ctx) {
  if (!isObject(body)) throw new AppError('VALIDATION', 400, 'The request body must be a JSON object.', { fields: { body: 'invalid' } });
  const problems = new Problems();
  const country = text(body.country).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) { problems.add('country', 'required'); problems.throwIfAny(); }
  if (!regionOf(country) || !isMarketEnabled(country, ctx.config)) throw new AppError('MARKET_NOT_SERVED', 422, 'We do not ship to this country yet.', { fields: { country: 'not_served' } });

  if (body.items != null && !Array.isArray(body.items)) problems.add('items', 'invalid');
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!problems.any && rawItems.length === 0) throw new AppError('CART_EMPTY', 422, 'Your bag is empty.');
  if (rawItems.length > LIMITS.lines) problems.add('items', 'too_many');

  const merged = new Map();
  rawItems.slice(0, LIMITS.lines).forEach((raw, i) => {
    const where = `items.${i}`;
    if (!isObject(raw)) { problems.add(where, 'invalid'); return; }
    const product = ctx.catalogue.get(typeof raw.id === 'string' ? raw.id : '');
    if (!product) { problems.add(`${where}.id`, 'unknown'); return; }
    if (!Number.isInteger(raw.qty) || raw.qty < LIMITS.qty[0] || raw.qty > LIMITS.qty[1]) { problems.add(`${where}.qty`, 'range'); return; }
    const given = raw.options == null ? {} : raw.options;
    if (!isObject(given)) { problems.add(`${where}.options`, 'invalid'); return; }
    const names = (product.options || []).map((o) => o.name);
    if (Object.keys(given).length !== names.length || Object.keys(given).some((k) => !names.includes(k))) { problems.add(`${where}.options`, 'mismatch'); return; }
    const options = {};
    for (const opt of product.options || []) {
      if (typeof given[opt.name] !== 'string' || !opt.values.includes(given[opt.name])) { problems.add(`${where}.options.${opt.name}`, 'unknown'); return; }
      options[opt.name] = given[opt.name];
    }
    const before = Object.keys(problems.fields).length;
    const personalisation = cleanPersonalisation(product, raw.personalisation, `${where}.personalisation`, problems);
    if (Object.keys(problems.fields).length !== before) return;
    const key = lineKey(product, options, personalisation);
    const seen = merged.get(key);
    if (seen) {
      seen.qty += raw.qty;
      if (seen.qty > LIMITS.qty[1]) problems.add(`${where}.qty`, 'range');
    } else {
      merged.set(key, { key, id: product.id, product, qty: raw.qty, options, variantKey: variantKey(product, options), personalisation, purchasable: ctx.catalogue.isPurchasable(product.id) });
    }
  });

  const state = text(body.state);
  const postcode = text(body.postcode).toUpperCase();
  const city = text(body.city ?? body.address?.city);
  if (state.length > LIMITS.state) problems.add('state', 'too_long');
  if (postcode.length > LIMITS.postcode) problems.add('postcode', 'too_long');
  let paymentMethod = null;
  if (body.paymentMethod != null && body.paymentMethod !== '') {
    if (PAYMENT_METHODS.includes(body.paymentMethod)) paymentMethod = body.paymentMethod; else problems.add('paymentMethod', 'unknown');
  }
  // Optional at quote time (the first option is priced when it is absent or unknown); POST /api/checkout requires it.
  const shippingOption = /^[a-z0-9_-]{1,24}$/.test(text(body.shippingOption)) ? text(body.shippingOption) : null;
  problems.throwIfAny();
  const lang = LANGS.includes(body.lang) ? body.lang : DEFAULT_LANG;
  return { country, region: regionOf(country), currency: currencyOf(country), state, postcode, city, lang, paymentMethod, shippingOption, items: Array.from(merged.values()) };
}

/** Body of POST /api/checkout → clean input (quote input plus customer, address and the idempotency id). */
export function validateCheckoutInput(body, ctx) {
  const address0 = isObject(body) && isObject(body.address) ? body.address : {};
  // the address block is the source of truth for state and postcode at checkout
  const quoteBody = isObject(body) ? { ...body, state: address0.state ?? body.state, postcode: address0.postcode ?? body.postcode } : body;
  const input = validateQuoteInput(quoteBody, ctx);
  const problems = new Problems();
  const rules = addressRules(input.country);

  const checkoutId = typeof body.checkoutId === 'string' ? body.checkoutId.trim().toLowerCase() : '';
  if (!UUID_RE.test(checkoutId)) problems.add('checkoutId', 'invalid');
  if (!input.paymentMethod) problems.add('paymentMethod', 'required');
  const shippingOption = text(body.shippingOption);
  if (!/^[a-z0-9_-]{1,24}$/.test(shippingOption)) problems.add('shippingOption', 'required');
  if (body.acceptTerms !== true) problems.add('acceptTerms', 'required');
  if (!Number.isInteger(body.expectedTotal) || body.expectedTotal < 0) problems.add('expectedTotal', 'invalid');

  const customer0 = isObject(body.customer) ? body.customer : {};
  const name = text(customer0.name);
  if (name.length < LIMITS.name[0] || name.length > LIMITS.name[1]) problems.add('customer.name', 'length');
  const email = typeof customer0.email === 'string' ? customer0.email.trim() : '';
  if (!isEmail(email)) problems.add('customer.email', 'invalid');
  const phoneGiven = text(customer0.phone) !== '';
  const phone = normalisePhone(customer0.phone);
  if (phoneGiven && !phone) problems.add('customer.phone', 'invalid');
  else if (!phone && (rules.phoneRequired || input.paymentMethod === 'cod')) problems.add('customer.phone', 'required');

  const line1 = text(address0.line1);
  if (line1.length < LIMITS.line1[0] || line1.length > LIMITS.line1[1]) problems.add('address.line1', 'length');
  const line2 = text(address0.line2);
  if (line2.length > LIMITS.line2) problems.add('address.line2', 'too_long');
  const city = text(address0.city);
  if (city.length < LIMITS.city[0] || city.length > LIMITS.city[1]) problems.add('address.city', 'length');
  if (rules.postcodeRequired && !input.postcode) problems.add('address.postcode', 'required');
  else if (input.postcode && !/^[A-Z0-9][A-Z0-9 -]{1,18}[A-Z0-9]$/.test(input.postcode)) problems.add('address.postcode', 'invalid');
  const note = text(body.note);
  if (note.length > LIMITS.note) problems.add('note', 'too_long');
  problems.throwIfAny();

  return {
    ...input, city, checkoutId, shippingOption, expectedTotal: body.expectedTotal,
    customer: { name, email, phone: phone || null },
    address: { line1, line2: line2 || null, city, state: input.state || null, postcode: input.postcode || null },
    note: note || null,
  };
}
