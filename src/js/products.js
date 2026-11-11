// The Cute Devil: product catalogue, the single source of truth. Owner: shop.
// Every price here is a SAMPLE (sample: true). The UI shows a "Sample" badge next to each one.
// To change the range, edit this file only: cards, product pages, cart and the WhatsApp
// message all read from it. Prices are never stored in the cart.
//
// Shape: { id (slug), name, niche: 'wear'|'scent'|'tech', price: Number, currency: 'EUR', sample: true,
//          pitch (one line), tagline (what it is), description, art (id from art.js),
//          options: [{ name, values: [], default?, prices?: { value: Number } }], status: 'live'|'soon'|'sold', featured }
// `prices` on an option is optional: when present, the chosen value sets the unit price (see priceOf).
//
// WORDS live in the dictionary, not here (src/i18n/en.json is the source of truth):
//   products.<id>.pitch / .tagline / .description   read through p.pitch, p.tagline, p.description
//   niche.<niche>, option.<name>, option.value.<value>   read through nicheLabel / optionLabel / valueLabel
// Product NAMES, sizes and "ml" are never translated. Option names and values below are the stable
// English codes: the cart stores them and the WhatsApp message prints them as they are.
import { renderArt } from './art.js';
import { t, has } from './i18n.js';

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

/** Unit price for a product with the chosen options (falls back to product.price). */
export function priceOf(product, options = {}) {
  if (!product) return 0;
  for (const opt of product.options || []) {
    const chosen = options ? options[opt.name] : undefined;
    if (opt.prices && Object.prototype.hasOwnProperty.call(opt.prices, chosen)) return opt.prices[chosen];
  }
  return product.price;
}

const SYMBOL = { EUR: '€' };
/** "€79" (sample prices are whole numbers; cents show only when needed). */
export function formatPrice(amount, currency = 'EUR') {
  const n = Math.round(Number(amount) * 100) / 100;
  return `${SYMBOL[currency] || `${currency} `}${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/** The product illustration. `scope` makes gradient ids unique when the same art is on the page twice. */
export function artFor(product, scope = '') {
  const svg = renderArt(product ? product.art : '', { title: product ? product.name : undefined });
  if (!scope) return svg;
  return svg.replace(/\bid="(a-[^"]+)"/g, `id="$1-${scope}"`).replace(/url\(#(a-[^)]+)\)/g, `url(#$1-${scope})`);
}
