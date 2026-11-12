// The Cute Devil: cart state. No DOM in here. Owner: shop.
// Storage: localStorage key `tcd:cart`, value { v: 1, items: [{ key, id, qty, options, personalisation? }] }.
// `personalisation` ({ fieldKey: text }) exists only on lines of products whose catalogue entry declares
// such fields; it is part of the line key, so the same hoodie with two different names is two lines.
// Prices are never stored: totals are always re-read from products.js, in the active currency (minor units).
// Every change dispatches `tcd:cart` on document with { count, total, reason, key }.
import { getById, priceOf, catalogueOf, canBuy } from './products.js';
import { getCurrency } from './commerce.js';

const KEY = 'tcd:cart';
const VERSION = 1;
export const MIN_QTY = 1;
export const MAX_QTY = 10;

let memory = null; // parsed cart; also the fallback when storage is blocked

const clampQty = (n) => Math.max(MIN_QTY, Math.min(MAX_QTY, Math.round(Number(n)) || MIN_QTY));

/** Keep only the option axes the product really has, with valid values. Returns null if one is missing. */
function cleanOptions(product, options) {
  const out = {};
  for (const opt of product.options || []) {
    const value = options ? options[opt.name] : undefined;
    if (!opt.values.includes(value)) return null;
    out[opt.name] = value;
  }
  return out;
}

/** Keep only the personalisation fields the catalogue declares, as short clean text. Returns null when none is filled. */
function cleanPersonalisation(product, input) {
  const entry = catalogueOf(product.id);
  const fields = entry && Array.isArray(entry.personalisation) ? entry.personalisation : [];
  if (!fields.length || !input || typeof input !== 'object') return null;
  const out = {};
  fields.forEach((f) => {
    const text = typeof input[f.key] === 'string' ? input[f.key].replace(/\s+/g, ' ').trim() : '';
    if (!text) return;
    out[f.key] = Array.from(text).slice(0, Number.isInteger(f.maxLength) ? f.maxLength : 60).join('');
  });
  return Object.keys(out).length ? out : null;
}

/**
 * Line identity = product id + option values in the product's own option order, plus one `@field=text`
 * segment per filled personalisation field. This is the same string the server uses as its line key
 * (server/catalogue/index.js lineKey), so quote lines can be matched to bag lines by key.
 */
export function lineKey(id, options = {}, personalisation = null) {
  const product = getById(id);
  const names = product ? (product.options || []).map((o) => o.name) : Object.keys(options).sort();
  const parts = [id, ...names.map((n) => `${n}=${options[n]}`)];
  if (personalisation) {
    const entry = catalogueOf(id);
    const declared = entry && Array.isArray(entry.personalisation) ? entry.personalisation.map((f) => f.key) : Object.keys(personalisation).sort();
    declared.forEach((k) => { if (personalisation[k]) parts.push(`@${k}=${personalisation[k]}`); });
  }
  return parts.join('|');
}
/** The line key without the personalisation: product id + variant (the contract's `id|variantKey`). */
export const variantLineKey = (line) => lineKey(line.id, line.options);

/** Drop anything that is broken, unknown or no longer for sale; merge duplicates. */
function sanitise(data) {
  const lines = new Map();
  if (data && data.v === VERSION && Array.isArray(data.items)) {
    for (const raw of data.items) {
      if (!raw || typeof raw !== 'object') continue;
      const product = getById(raw.id);
      if (!product || product.status !== 'live') continue;
      const options = cleanOptions(product, raw.options);
      if (!options) continue;
      const personalisation = cleanPersonalisation(product, raw.personalisation);
      const key = lineKey(product.id, options, personalisation);
      const qty = clampQty(raw.qty);
      const seen = lines.get(key);
      if (seen) seen.qty = clampQty(seen.qty + qty);
      else lines.set(key, personalisation ? { key, id: product.id, qty, options, personalisation } : { key, id: product.id, qty, options });
    }
  }
  return { v: VERSION, items: Array.from(lines.values()) };
}

function read() {
  if (memory) return memory;
  let data = null;
  try { data = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (err) { data = null; }
  memory = sanitise(data);
  return memory;
}

function write(reason, key) {
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch (err) { /* private mode: memory only */ }
  emit(reason, key);
}

function emit(reason, key) {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent('tcd:cart', { detail: { count: count(), total: total(), reason, key } }));
}

const copy = (line) => ({ ...line, options: { ...line.options }, ...(line.personalisation ? { personalisation: { ...line.personalisation } } : {}) });

/** A copy of the cart lines: [{ key, id, qty, options, personalisation? }]. */
export function items() {
  return read().items.map(copy);
}

/**
 * Lines joined with their product and prices in the active currency, for rendering and for the order.
 * `unit` and `lineTotal` are minor units (null when the piece has no price in that currency);
 * `buyable` is false when the piece cannot be ordered online in the chosen country.
 */
export function lines() {
  const currency = getCurrency();
  return read().items.map((line) => {
    const product = getById(line.id);
    const unit = priceOf(product, line.options, currency, line.personalisation);
    return { ...copy(line), product, unit, lineTotal: unit === null ? null : unit * line.qty, currency, buyable: canBuy(product) && unit !== null };
  });
}

/** Add a product. Returns the line, or null when it cannot be added (not for sale, option missing). */
export function add(id, qty = 1, options = {}, personalisation = null) {
  const product = getById(id);
  if (!product || product.status !== 'live' || !canBuy(product)) return null;
  const clean = cleanOptions(product, options);
  if (!clean) return null;
  const perso = cleanPersonalisation(product, personalisation);
  const cart = read();
  const key = lineKey(product.id, clean, perso);
  let line = cart.items.find((l) => l.key === key);
  if (line) line.qty = clampQty(line.qty + clampQty(qty));
  else { line = perso ? { key, id: product.id, qty: clampQty(qty), options: clean, personalisation: perso } : { key, id: product.id, qty: clampQty(qty), options: clean }; cart.items.push(line); }
  write('add', key);
  return copy(line);
}

/** Set a line's quantity (1 to 10). Zero or less removes the line. */
export function setQty(key, n) {
  const cart = read();
  const line = cart.items.find((l) => l.key === key);
  if (!line) return;
  if (Number(n) <= 0) { remove(key); return; }
  line.qty = clampQty(n);
  write('qty', key);
}

export function remove(key) {
  const cart = read();
  const before = cart.items.length;
  cart.items = cart.items.filter((l) => l.key !== key);
  if (cart.items.length !== before) write('remove', key);
}

export function clear() {
  memory = { v: VERSION, items: [] };
  write('clear');
}

/** Number of pieces in the bag (sum of quantities). */
export function count() {
  return read().items.reduce((sum, l) => sum + l.qty, 0);
}

/** Total in minor units of the active currency, from the catalogue prices. */
export function total() {
  const currency = getCurrency();
  return read().items.reduce((sum, l) => sum + (priceOf(getById(l.id), l.options, currency, l.personalisation) || 0) * l.qty, 0);
}

// keep tabs in step with each other
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== KEY) return;
    memory = null;
    emit('sync');
  });
}
