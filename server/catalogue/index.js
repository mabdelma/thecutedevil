// Catalogue access and validation. Owner: core. Contract: web/COMMERCE_ARCH.md section c.
// Prices come only from catalogue/products.js. Name and status (live / soon / sold) are presentation and
// live in src/js/products.js, which is read here as TEXT (it imports browser modules, so it cannot be imported).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogue as defaultCatalogue, CURRENCIES } from './products.js';

export { CURRENCIES };
export const CATEGORIES = ['apparel', 'headwear', 'drinkware', 'phone_case', 'wall_art', 'tote', 'stationery', 'engraved', 'fragrance', 'electronics'];
const HERE = dirname(fileURLToPath(import.meta.url));
export const FRONT_END_PRODUCTS = resolve(HERE, '../../src/js/products.js');

const index = new Map(defaultCatalogue.map((p) => [p.id, p]));

/** One catalogue product by slug, or null. */
export const getProduct = (id, catalogue) => (catalogue ? catalogue.find((p) => p.id === id) : index.get(String(id || ''))) || null;

/** `size=M|colour=navy` in the product's option order; `default` when the product has no options. */
export function variantKey(product, options = {}) {
  const names = (product.options || []).map((o) => o.name);
  if (names.length === 0) return 'default';
  return names.map((n) => `${n}=${options ? options[n] : undefined}`).join('|');
}

/** Line identity = the cart's lineKey (id + option pairs); personalised lines add `|@key=value` segments. */
export function lineKey(product, options = {}, personalisation = null) {
  const parts = [product.id, ...(product.options || []).map((o) => `${o.name}=${options ? options[o.name] : undefined}`)];
  for (const field of product.personalisation || []) {
    const value = personalisation ? personalisation[field.key] : undefined;
    if (value) parts.push(`@${field.key}=${value}`);
  }
  return parts.join('|');
}

/** All variant keys of a product (cartesian product of its options). */
export function variantKeys(product) {
  let keys = [[]];
  for (const opt of product.options || []) keys = keys.flatMap((k) => opt.values.map((v) => [...k, `${opt.name}=${v}`]));
  return (product.options || []).length ? keys.map((k) => k.join('|')) : ['default'];
}

/**
 * Unit price in minor units: the variant's price table (or the product's) plus the surcharge of every
 * personalisation field that is filled in. Throws when the currency is missing: never guess a price.
 */
export function priceOf(product, options, currency, personalisation = null) {
  const key = variantKey(product, options);
  const table = (product.variantPrices && product.variantPrices[key]) || product.price;
  let amount = table ? table[currency] : undefined;
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`catalogue: no ${currency} price for ${product.id} (${key})`);
  for (const field of product.personalisation || []) {
    if (personalisation && personalisation[field.key] && field.surcharge) {
      const extra = field.surcharge[currency];
      if (!Number.isInteger(extra) || extra < 0) throw new Error(`catalogue: no ${currency} surcharge for ${product.id}.${field.key}`);
      amount += extra;
    }
  }
  return amount;
}

/* ---- src/js/products.js, read as text ------------------------------------------------------------- */

const skipString = (text, i) => {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
  return j;
};

/** Index of the bracket that closes the one at `start` (strings and comments are skipped). */
function matchBracket(text, start) {
  const open = text[start];
  const close = { '[': ']', '{': '}', '(': ')' }[open];
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue; }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 1; if (i <= 0) return -1; continue; }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

const stringList = (body) => Array.from(body.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)).map((m) => m[2].replace(/\\(.)/g, '$1'));

/** Top-level `{ … }` literals of an array body. */
function topLevelObjects(body) {
  const out = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(body, i); continue; }
    if (c === '/' && body[i + 1] === '*') { i = body.indexOf('*/', i) + 1; continue; }
    if (c === '/' && body[i + 1] === '/') { i = body.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '{') { const end = matchBracket(body, i); if (end < 0) break; out.push(body.slice(i, end + 1)); i = end; }
  }
  return out;
}

function parseOptions(block, text) {
  const at = block.search(/\boptions\s*:\s*\[/);
  if (at < 0) return null;
  const open = block.indexOf('[', at);
  const close = matchBracket(block, open);
  if (close < 0) return null;
  const body = block.slice(open + 1, close).trim();
  if (!body) return [];
  const constArray = (name) => {
    const m = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\[`).exec(text);
    if (!m) return null;
    const s = text.indexOf('[', m.index);
    const e = matchBracket(text, s);
    return e < 0 ? null : stringList(text.slice(s + 1, e));
  };
  const fromObject = (obj) => {
    const name = /\bname\s*:\s*(['"])(.*?)\1/.exec(obj);
    const values = /\bvalues\s*:\s*(\[|[A-Za-z_$][\w$]*)/.exec(obj);
    if (!name || !values) return null;
    if (values[1] === '[') {
      const s = obj.indexOf('[', values.index);
      const e = matchBracket(obj, s);
      return e < 0 ? null : { name: name[2], values: stringList(obj.slice(s + 1, e)) };
    }
    const list = constArray(values[1]);
    return list ? { name: name[2], values: list } : null;
  };
  const out = [];
  let rest = body;
  while (rest.length) {
    rest = rest.replace(/^[\s,]+/, '');
    if (!rest) break;
    if (rest[0] === '{') {
      const end = matchBracket(rest, 0);
      const opt = end < 0 ? null : fromObject(rest.slice(0, end + 1));
      if (!opt) return null;
      out.push(opt);
      rest = rest.slice(end + 1);
      continue;
    }
    const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(rest); // helper such as volume(42, 68, 104)
    if (!call) return null;
    const end = matchBracket(rest, rest.indexOf('('));
    const helper = new RegExp(`\\b(?:const|function)\\s+${call[1].replace(/\$/g, '\\$')}\\b`).exec(text);
    if (end < 0 || !helper) return null;
    const bodyAt = text.indexOf('{', helper.index);
    const bodyEnd = bodyAt < 0 ? -1 : matchBracket(text, bodyAt);
    const opt = bodyEnd < 0 ? null : fromObject(text.slice(bodyAt, bodyEnd + 1));
    if (!opt) return null;
    out.push(opt);
    rest = rest.slice(end + 1);
  }
  return out;
}

/**
 * Extract { id, name, status, options } per product from the text of src/js/products.js.
 * `options` is null when the literal could not be read (the id check still applies).
 */
export function parseFrontEndProducts(text) {
  const start = /export\s+const\s+products\s*=\s*\[/.exec(text);
  if (!start) return [];
  const open = text.indexOf('[', start.index);
  const close = matchBracket(text, open);
  if (close < 0) return [];
  return topLevelObjects(text.slice(open + 1, close)).map((block) => {
    const id = /\bid\s*:\s*(['"])([a-z0-9][a-z0-9-]*)\1/.exec(block);
    if (!id) return null;
    const name = /\bname\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/.exec(block.replace(/\boptions\s*:\s*\[[\s\S]*$/, ''));
    const status = /\bstatus\s*:\s*(['"])(\w+)\1/.exec(block);
    return {
      id: id[2],
      name: name ? (name[1] ?? name[2]).replace(/\\(.)/g, '$1') : id[2],
      status: status ? status[2] : 'soon',
      options: parseOptions(block, text),
    };
  }).filter(Boolean);
}

let frontEndCache = null;
/** Presentation facts the server needs (name for the order snapshot, status for "is it live"). Cached. */
export function loadFrontEnd(file = FRONT_END_PRODUCTS) {
  if (file === FRONT_END_PRODUCTS && frontEndCache) return frontEndCache;
  const list = existsSync(file) ? parseFrontEndProducts(readFileSync(file, 'utf8')) : [];
  const map = new Map(list.map((p) => [p.id, p]));
  if (file === FRONT_END_PRODUCTS) frontEndCache = map;
  return map;
}

/**
 * A view of the catalogue for one process: products joined with name and status from the front end.
 * Tests pass their own `catalogue` and `frontEnd`.
 */
export function createCatalogue({ catalogue = defaultCatalogue, frontEnd = loadFrontEnd() } = {}) {
  const byId = new Map(catalogue.map((p) => [p.id, p]));
  const meta = (id) => frontEnd.get(id) || null;
  return {
    list: () => catalogue,
    get: (id) => byId.get(String(id || '')) || null,
    nameOf: (id) => meta(id)?.name || String(id),
    statusOf: (id) => meta(id)?.status || 'soon',
    /** Purchasable online right now: sellable in the catalogue and `live` on the site. */
    isPurchasable: (id) => Boolean(byId.get(id)?.sellable) && meta(id)?.status === 'live',
  };
}

/**
 * Checks of section c. → { ok, errors: string[], warnings: string[] }
 * @param {object} [input] { catalogue, frontEnd (Map from loadFrontEnd), mapping, rules, mockSuppliers }
 *   mapping + rules are optional: when given, every sellable variant needs a mapping entry or a rule naming `manual`.
 *   mockSuppliers: true in mock mode, where the mock supplier stands in for every real one.
 */
export function validateCatalogue({ catalogue = defaultCatalogue, frontEnd = loadFrontEnd(), mapping, rules, mockSuppliers = false } = {}) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  const priceTable = (table, where) => {
    if (!table || typeof table !== 'object') { errors.push(`${where}: price table missing`); return; }
    for (const c of CURRENCIES) if (!Number.isInteger(table[c]) || table[c] <= 0) errors.push(`${where}: ${c} must be a positive integer (minor units)`);
  };
  for (const p of catalogue) {
    const where = `catalogue ${p.id}`;
    if (!p.id || ids.has(p.id)) errors.push(`${where}: missing or duplicate id`);
    ids.add(p.id);
    if (!CATEGORIES.includes(p.category)) errors.push(`${where}: unknown category ${p.category}`);
    if (typeof p.sellable !== 'boolean') errors.push(`${where}: sellable must be true or false`);
    if (!Number.isInteger(p.weightG) || p.weightG <= 0) errors.push(`${where}: weightG must be a positive integer`);
    if (!Array.isArray(p.options)) { errors.push(`${where}: options must be an array`); continue; }
    for (const o of p.options) {
      if (!o.name || !Array.isArray(o.values) || o.values.length === 0 || new Set(o.values).size !== o.values.length) errors.push(`${where}: option ${o.name} needs unique values`);
      else if (o.values.some((v) => typeof v !== 'string' || /[|=]/.test(v))) errors.push(`${where}: option ${o.name} values must be strings without "|" or "="`);
    }
    priceTable(p.price, where);
    const keys = variantKeys(p);
    for (const [k, table] of Object.entries(p.variantPrices || {})) {
      if (!keys.includes(k)) errors.push(`${where}: variantPrices key "${k}" is not a variant`);
      priceTable(table, `${where} [${k}]`);
    }
    for (const f of p.personalisation || []) {
      if (!f.key || f.type !== 'text' || !Number.isInteger(f.maxLength) || f.maxLength < 1) errors.push(`${where}: personalisation field ${f.key} is malformed`);
      try { new RegExp(f.pattern, 'u'); } catch (err) { errors.push(`${where}: personalisation ${f.key} pattern does not compile`); }
      if (f.surcharge) for (const c of CURRENCIES) if (!Number.isInteger(f.surcharge[c]) || f.surcharge[c] < 0) errors.push(`${where}: personalisation ${f.key} surcharge ${c} must be an integer >= 0`);
    }
    for (const r of p.regions || []) if (!['EU', 'UK', 'CA', 'US', 'AE', 'GCC', 'EG'].includes(r)) errors.push(`${where}: unknown region ${r}`);
  }

  // every id of the site exists here with the same option names and values
  if (!frontEnd || frontEnd.size === 0) errors.push('src/js/products.js: no product ids found');
  for (const fe of frontEnd ? frontEnd.values() : []) {
    const p = catalogue.find((c) => c.id === fe.id);
    if (!p) { errors.push(`src/js/products.js id ${fe.id} is not in the catalogue`); continue; }
    if (fe.options === null) { warnings.push(`src/js/products.js ${fe.id}: options could not be read, not compared`); continue; }
    const same = fe.options.length === (p.options || []).length && fe.options.every((o, i) => o.name === p.options[i].name
      && o.values.length === p.options[i].values.length && o.values.every((v, j) => v === p.options[i].values[j]));
    if (!same) errors.push(`${fe.id}: options differ between src/js/products.js and the catalogue`);
  }

  // every sellable variant can be produced by someone
  if (mapping && rules && !mockSuppliers) {
    for (const p of catalogue.filter((c) => c.sellable)) {
      const manual = (rules.rules || []).some((r) => (r.category === p.category || r.category === '*') && (r.candidates || []).flat().includes('manual'));
      for (const key of variantKeys(p)) {
        const entries = mapping[p.id] ? mapping[p.id][key] || mapping[p.id]['*'] : null;
        if (!(Array.isArray(entries) && entries.length > 0) && !manual) errors.push(`${p.id} [${key}]: no supplier mapping and no routing rule naming "manual"`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
