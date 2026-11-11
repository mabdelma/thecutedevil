// The Cute Devil: cart state. No DOM in here. Owner: shop.
// Storage: localStorage key `tcd:cart`, value { v: 1, items: [{ key, id, qty, options }] }.
// Prices are never stored: totals are always re-read from products.js.
// Every change dispatches `tcd:cart` on document with { count, total, reason, key }.
import { getById, priceOf } from './products.js';

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

/** Line identity = product id + option values, in the product's own option order. */
export function lineKey(id, options = {}) {
  const product = getById(id);
  const names = product ? (product.options || []).map((o) => o.name) : Object.keys(options).sort();
  return [id, ...names.map((n) => `${n}=${options[n]}`)].join('|');
}

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
      const key = lineKey(product.id, options);
      const qty = clampQty(raw.qty);
      const seen = lines.get(key);
      if (seen) seen.qty = clampQty(seen.qty + qty); else lines.set(key, { key, id: product.id, qty, options });
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

/** A copy of the cart lines: [{ key, id, qty, options }]. */
export function items() {
  return read().items.map((line) => ({ ...line, options: { ...line.options } }));
}

/** Lines joined with their product and sample prices, for rendering and for the order message. */
export function lines() {
  return read().items.map((line) => {
    const product = getById(line.id);
    const unit = priceOf(product, line.options);
    return { ...line, options: { ...line.options }, product, unit, lineTotal: unit * line.qty };
  });
}

/** Add a live product. Returns the line, or null when it cannot be added (not live, option missing). */
export function add(id, qty = 1, options = {}) {
  const product = getById(id);
  if (!product || product.status !== 'live') return null;
  const clean = cleanOptions(product, options);
  if (!clean) return null;
  const cart = read();
  const key = lineKey(product.id, clean);
  let line = cart.items.find((l) => l.key === key);
  if (line) line.qty = clampQty(line.qty + clampQty(qty));
  else { line = { key, id: product.id, qty: clampQty(qty), options: clean }; cart.items.push(line); }
  write('add', key);
  return { ...line, options: { ...line.options } };
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

/** Sample total, from the catalogue prices. */
export function total() {
  return read().items.reduce((sum, l) => sum + priceOf(getById(l.id), l.options) * l.qty, 0);
}

// keep tabs in step with each other
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== KEY) return;
    memory = null;
    emit('sync');
  });
}
