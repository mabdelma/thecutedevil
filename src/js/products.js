// The Cute Devil: product presentation (names, niches, art, status) and price helpers. Owner: shop / web.
// PRICES: the single source of truth is server/catalogue/products.js (owner: core), a fixed price table per
// currency in minor units (7900 = 79.00). This file only reads it. The `price` numbers below are the old EUR
// samples: they are used only while a product has no catalogue entry yet, and only for EUR.
//   commerce off (see commerce.js): EUR, the "Sample" badge and the short "€79" format, as before.
//   commerce on: the currency of the chosen country, formatted with Intl.NumberFormat.
// Money is ALWAYS an integer in minor units in this code base. Prices are never stored in the cart.
//
// Shape: { id (slug), name, niche: 'wear'|'scent'|'tech', price: Number (EUR sample), currency: 'EUR', sample: true,
//          pitch (one line), tagline (what it is), description, art (id from art.js),
//          options: [{ name, values: [], default?, prices?: { value: Number } }], status: 'live'|'soon'|'sold', featured }
//
// WORDS live in the dictionary, not here (src/i18n/en.json is the source of truth):
//   products.<id>.pitch / .tagline / .description   read through p.pitch, p.tagline, p.description
//   niche.<niche>, option.<name>, option.value.<value>   read through nicheLabel / optionLabel / valueLabel
// Product NAMES, sizes and "ml" are never translated. Option names and values below are the stable
// English codes: the cart stores them and the order prints them as they are.
import { renderArt } from './art.js';
import { t, has, getLang } from './i18n.js';
import { catalogue } from '../../server/catalogue/products.js';
import { isOn, getCurrency, getRegion, settled } from './commerce.js';

// Wait for the commerce answer (cached after the first page of a visit, otherwise one short request)
// so every module that imports this file paints the right currency the first time.
await settled;

export const NICHES = ['wear', 'scent', 'tech'];

const SIZES = ['S', 'M', 'L', 'XL'];
const volume = (p30, p50, p100) => ({
  name: 'volume',
  values: ['30 ml', '50 ml', '100 ml'],
  prices: { '30 ml': p30, '50 ml': p50, '100 ml': p100 },
});

export const products = [
  /* ------------------------------------------------------------ wear */
  {
    id: 'halos-off-hoodie',
    name: "halo's off hoodie",
    niche: 'wear',
    price: 79,
    currency: 'EUR',
    sample: true,
    art: 'hoodie',
    options: [{ name: 'size', values: SIZES, default: 'M' }],
    status: 'live',
    featured: true,
  },
  {
    id: 'nice-guy-long-story-tee',
    name: 'nice guy, long story tee',
    niche: 'wear',
    price: 35,
    currency: 'EUR',
    sample: true,
    art: 'tee',
    options: [{ name: 'size', values: SIZES, default: 'M' }],
    status: 'live',
    featured: true,
  },
  {
    id: 'horns-down-cap',
    name: 'horns down cap',
    niche: 'wear',
    price: 29,
    currency: 'EUR',
    sample: true,
    art: 'cap',
    options: [],
    status: 'live',
    featured: false,
  },
  {
    id: 'two-sides-socks',
    name: 'two sides socks',
    niche: 'wear',
    price: 16,
    currency: 'EUR',
    sample: true,
    art: 'socks',
    options: [{ name: 'size', values: ['36-40', '41-45'] }],
    status: 'soon',
    featured: false,
  },

  /* ------------------------------------------------------------ scent */
  {
    id: 'secret-no-1',
    name: 'secret no. 1',
    niche: 'scent',
    price: 68,
    currency: 'EUR',
    sample: true,
    art: 'perfume-secret',
    options: [volume(42, 68, 104)],
    status: 'live',
    featured: true,
  },
  {
    id: 'sweet-nothing',
    name: 'sweet nothing',
    niche: 'scent',
    price: 62,
    currency: 'EUR',
    sample: true,
    art: 'perfume-sweet',
    options: [volume(38, 62, 96)],
    status: 'live',
    featured: true,
  },
  {
    id: 'after-midnight',
    name: 'after midnight',
    niche: 'scent',
    price: 74,
    currency: 'EUR',
    sample: true,
    art: 'perfume-midnight',
    options: [volume(46, 74, 112)],
    status: 'soon',
    featured: false,
  },
  {
    id: 'morning-alibi',
    name: 'morning alibi',
    niche: 'scent',
    price: 58,
    currency: 'EUR',
    sample: true,
    art: 'perfume-alibi',
    options: [volume(36, 58, 88)],
    status: 'live',
    featured: false,
  },

  /* ------------------------------------------------------------ tech */
  {
    id: 'little-devil-earbuds',
    name: 'little devil earbuds',
    niche: 'tech',
    price: 59,
    currency: 'EUR',
    sample: true,
    art: 'earbuds',
    options: [{ name: 'colour', values: ['cream', 'navy'] }],
    status: 'live',
    featured: true,
  },
  {
    id: 'hot-head-power-bank',
    name: 'hot head power bank',
    niche: 'tech',
    price: 39,
    currency: 'EUR',
    sample: true,
    art: 'powerbank',
    options: [],
    status: 'live',
    featured: true,
  },
  {
    id: 'night-shift-lamp',
    name: 'night shift lamp',
    niche: 'tech',
    price: 49,
    currency: 'EUR',
    sample: true,
    art: 'lamp',
    options: [],
    status: 'soon',
    featured: false,
  },
  {
    id: 'the-tail-cable',
    name: 'the tail cable',
    niche: 'tech',
    price: 19,
    currency: 'EUR',
    sample: true,
    art: 'cable',
    options: [],
    status: 'sold',
    featured: false,
  },
];

// `price`, `currency` and `sample` answer for the active market, so older callers that print
// formatPrice(p.price, p.currency) stay right: minor units in the active currency, and no "Sample"
// badge once real prices are on. The EUR sample number typed above is kept aside for samplePrice().
const SAMPLE = new Map(products.map((p) => [p.id, p.price]));
products.forEach((p) => {
  Object.defineProperty(p, 'price', { get: () => priceOf(p, {}), enumerable: true });
  Object.defineProperty(p, 'currency', { get: () => getCurrency(), enumerable: true });
  Object.defineProperty(p, 'sample', { get: () => !isOn(), enumerable: true });
});

// pitch, tagline and description always answer in the active language
products.forEach((p) => {
  ['pitch', 'tagline', 'description'].forEach((field) => {
    Object.defineProperty(p, field, { get: () => t(`products.${p.id}.${field}`), enumerable: true });
  });
});

/** "wear" → the niche name in the active language. */
export const nicheLabel = (niche) => (has(`niche.${niche}`) ? t(`niche.${niche}`) : String(niche || ''));
/** "size" → the option name in the active language. */
export const optionLabel = (name) => (has(`option.${name}`) ? t(`option.${name}`) : String(name || ''));
/** "cream" → the colour in the active language; sizes and volumes ("M", "50 ml") pass through untouched. */
export const valueLabel = (value) => (has(`option.value.${value}`) ? t(`option.value.${value}`) : String(value == null ? '' : value));

const index = new Map(products.map((p) => [p.id, p]));

/** One product by slug, or null. */
export function getById(id) {
  return index.get(String(id || '')) || null;
}

/** Products of one niche; anything else ('all', '', undefined) returns the whole range. */
export function byNiche(niche) {
  return NICHES.includes(niche) ? products.filter((p) => p.niche === niche) : products.slice();
}

/* ---------------------------------------------------------------- catalogue (prices, sellable, personalisation) */
const entries = new Map((Array.isArray(catalogue) ? catalogue : []).map((c) => [c.id, c]));
/** The catalogue entry of a product (server/catalogue/products.js), or null. */
export const catalogueOf = (id) => entries.get(String(id || '')) || null;

/** `name=value` pairs joined by `|` in the product's option order, or `default`. Same rule as the server. */
export function variantKey(product, options = {}) {
  const names = product ? (product.options || []).map((o) => o.name) : [];
  return names.length ? names.map((n) => `${n}=${options ? options[n] : undefined}`).join('|') : 'default';
}

const money = (v) => (Number.isInteger(v) && v > 0 ? v : null);
function samplePrice(product, options) {
  for (const opt of product.options || []) {
    const chosen = options ? options[opt.name] : undefined;
    if (opt.prices && Object.prototype.hasOwnProperty.call(opt.prices, chosen)) return Math.round(opt.prices[chosen] * 100);
  }
  return Math.round((SAMPLE.get(product.id) || 0) * 100);
}

/**
 * Unit price in MINOR units for a product with the chosen options, in `currency` (default: the active one).
 * `personalisation` ({ key: text }) adds the surcharge of every field that is filled in.
 * Returns null when there is no price for that currency (the piece cannot be bought there).
 */
export function priceOf(product, options = {}, currency = getCurrency(), personalisation = null) {
  if (!product) return 0;
  const entry = catalogueOf(product.id);
  let unit = null;
  if (entry) {
    const variant = entry.variantPrices && entry.variantPrices[variantKey(product, options)];
    unit = money(variant && variant[currency]);
    if (unit === null) unit = money(entry.price && entry.price[currency]);
  }
  if (unit === null && currency === 'EUR') unit = samplePrice(product, options);
  if (unit === null) return null;
  if (personalisation && entry && Array.isArray(entry.personalisation)) {
    entry.personalisation.forEach((f) => {
      if (personalisation[f.key] && f.surcharge && Number.isInteger(f.surcharge[currency])) unit += f.surcharge[currency];
    });
  }
  return unit;
}

const SYMBOL = { EUR: '€' };
const formats = new Map();
/**
 * Minor units → text. Commerce on: Intl currency format in the page language ("€79.00", "AED 329.00").
 * Commerce off: the short sample format "€79" (cents only when needed), as before.
 */
export function formatPrice(minor, currency = getCurrency()) {
  if (minor === null || minor === undefined || Number.isNaN(Number(minor))) return '—';
  const n = Math.round(Number(minor)) / 100;
  if (isOn()) {
    const id = `${getLang()}|${currency}`;
    try {
      if (!formats.has(id)) formats.set(id, new Intl.NumberFormat(`${getLang()}-u-nu-latn`, { style: 'currency', currency }));
      return formats.get(id).format(n);
    } catch (err) { /* unknown currency code: fall through */ }
  }
  return `${SYMBOL[currency] || `${currency} `}${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/** 'live' | 'soon' | 'sold' as the customer sees it: with commerce on, a piece that is not sellable online shows as "soon". */
export function statusOf(product) {
  if (!product) return 'sold';
  if (isOn() && product.status === 'live') {
    const entry = catalogueOf(product.id);
    if (!entry || entry.sellable !== true) return 'soon';
  }
  return product.status;
}
/** False only when commerce is on and the catalogue limits the piece to other regions (or has no price there). */
export function availableHere(product) {
  if (!product || !isOn()) return true;
  const entry = catalogueOf(product.id);
  if (entry && Array.isArray(entry.regions) && entry.regions.length && !entry.regions.includes(getRegion())) return false;
  return priceOf(product, {}) !== null;
}
/** Can this piece go into the bag right now? */
export const canBuy = (product) => statusOf(product) === 'live' && availableHere(product);

/* ---------------------------------------------------------------- personalisation */
const tidyText = (value) => String(value == null ? '' : value)
  .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();

/** The personalisation fields a product declares: [{ key, type: 'text', maxLength, pattern, required, surcharge? }]. Commerce on only. */
export function personalisationOf(product) {
  if (!product || !isOn()) return [];
  const entry = catalogueOf(product.id);
  return entry && Array.isArray(entry.personalisation) ? entry.personalisation.filter((f) => f && typeof f.key === 'string' && (f.type || 'text') === 'text') : [];
}
/**
 * Check personalisation values against the product's fields.
 * → { ok, values: { key: text } (filled fields only), errors: { key: 'required' | 'tooLong' | 'pattern' } }
 */
export function validatePersonalisation(product, input = {}) {
  const values = {};
  const errors = {};
  personalisationOf(product).forEach((f) => {
    const text = tidyText(input ? input[f.key] : '');
    if (!text) { if (f.required) errors[f.key] = 'required'; return; }
    if (Number.isInteger(f.maxLength) && Array.from(text).length > f.maxLength) { errors[f.key] = 'tooLong'; return; }
    if (f.pattern) {
      let ok = true;
      try { ok = new RegExp(f.pattern, 'u').test(text); } catch (err) { ok = true; }
      if (!ok) { errors[f.key] = 'pattern'; return; }
    }
    values[f.key] = text;
  });
  return { ok: Object.keys(errors).length === 0, values, errors };
}
/** "name" → the field label in the active language (personalisation.<key>), else the key. */
export const personalisationLabel = (key) => (has(`personalisation.${key}`) ? t(`personalisation.${key}`) : String(key || ''));

/** The product illustration. `scope` makes gradient ids unique when the same art is on the page twice. */
export function artFor(product, scope = '') {
  const svg = renderArt(product ? product.art : '', { title: product ? product.name : undefined });
  if (!scope) return svg;
  return svg.replace(/\bid="(a-[^"]+)"/g, `id="$1-${scope}"`).replace(/url\(#(a-[^)]+)\)/g, `url(#$1-${scope})`);
}
