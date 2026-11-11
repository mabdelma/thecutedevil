// The Cute Devil: product catalogue, the single source of truth. Owner: shop.
// Every price here is a SAMPLE (sample: true). The UI shows a "Sample" badge next to each one.
// To change the range, edit this file only: cards, product pages, cart and the WhatsApp
// message all read from it. Prices are never stored in the cart.
//
// Shape: { id (slug), name, niche: 'wear'|'scent'|'tech', price: Number, currency: 'EUR', sample: true,
//          pitch (one line), tagline (what it is), description, art (id from art.js),
//          options: [{ name, values: [], default?, prices?: { value: Number } }], status: 'live'|'soon'|'sold', featured }
// `prices` on an option is optional: when present, the chosen value sets the unit price (see priceOf).
import { renderArt } from './art.js';

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
    pitch: 'tiny horns stitched on the hood.',
    tagline: 'heavyweight hoodie',
    description: 'A heavy, soft navy hoodie that looks perfectly innocent from the front. Pull the hood up and two small horns appear. The logo sits where the drawstrings meet, so the secret is always close to your chest.',
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
    pitch: 'red shadow peeking from the pocket.',
    tagline: 'pocket tee',
    description: 'A cream cotton tee with one small detail: a horned shadow looking out of the chest pocket. Most people will not notice it. The ones who do will ask, and the answer is always "long story".',
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
    pitch: 'navy, low-key embroidered shadow.',
    tagline: 'six-panel cap, one size',
    description: 'A navy six-panel cap with the shadow stitched tone on tone, so it only shows when the light hits it. One size, with an adjustable strap. Quiet from far away, curious up close.',
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
    pitch: 'one angelic pair, one very red.',
    tagline: 'two-pair sock set',
    description: 'Two pairs in one set: a calm cream pair and a very red one. Wear the side that fits the day, or mix them and let people guess. Either way, only your shoes know.',
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
    pitch: 'warm amber, a little smoke. signature.',
    tagline: 'eau de parfum',
    description: 'The signature scent of the house. Warm amber opens first, friendly and easy to like. A thin line of smoke arrives later and stays, like something you decided not to say.',
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
    pitch: 'vanilla and pink pepper. sweet first, then something else.',
    tagline: 'eau de parfum',
    description: 'Soft vanilla on the surface, pink pepper underneath. It starts sweet and polite, then turns a little sharp when people come closer. Made for a second impression.',
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
    pitch: 'oud and leather. for the hours nobody asks about.',
    tagline: 'eau de parfum',
    description: 'Deep oud wrapped in dark leather. It is slow, calm and hard to read, and it gets better the later it is. A scent for the part of the night that stays between you and the moon.',
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
    pitch: 'clean citrus and musk. you were home.',
    tagline: 'eau de toilette',
    description: 'Bright citrus and clean musk, fresh as an open window. It smells like eight hours of sleep and a clear conscience. Nobody will ask where you were.',
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
    pitch: 'horned pocket case. nobody knows what is playing.',
    tagline: 'wireless earbuds',
    description: 'Wireless earbuds in a small pocket case with two horns on top. It looks like a toy on the desk. What plays inside is between you and the horns. Your playlist stays your business.',
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
    pitch: 'hot name, calm face.',
    tagline: 'slim power bank',
    description: 'A slim navy power bank with the face on the front and four small lights that tell you how much is left. It sits in your pocket and says nothing. The only one who knows how long the night will be.',
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
    pitch: 'one dial, angel white to devil red.',
    tagline: 'desk mood lamp',
    description: 'A small desk lamp with one dial. Turn it one way for clean white light to work by. Turn it the other way and the room goes deep red, and the lamp grows horns on the wall.',
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
    pitch: 'braided red, pointed tip.',
    tagline: 'braided charging cable',
    description: 'A braided red charging cable that ends in a pointed tail tip. It is the one cable on the desk nobody takes by mistake. Leave it out: it looks like something is hiding behind the laptop.',
    art: 'cable',
    options: [],
    status: 'sold',
    featured: false,
  },
];

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
