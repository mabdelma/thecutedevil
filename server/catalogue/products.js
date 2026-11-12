// Catalogue: the single source of truth for what is sold and at what price. Owner: core.
// Contract: web/COMMERCE_ARCH.md section c. PURE DATA: no imports, no Node APIs, because the front end
// (src/js/products.js) imports this same file through Vite. Supplier references live in mapping.js.
//
// OWNER, PLEASE READ:
// - Money is in minor units: 7900 = 79.00.
// - The EUR column is today's sample price x 100. The other six columns (GBP, CAD, USD, AED, SAR, EGP) are
//   PLACEHOLDERS worked out with a rough rate. Set every one of them yourself before live mode.
// - EUR, GBP, AED, SAR and EGP prices include tax. CAD and USD prices do not (section h).
// - `sellable: false` = never purchasable online (perfume and electronics are deferred by the supply study).
// - Presentation (name, picture, status live/soon/sold) stays in src/js/products.js.

export const CURRENCIES = ['EUR', 'GBP', 'CAD', 'USD', 'AED', 'SAR', 'EGP'];

/**
 * @typedef {Object} CatalogueProduct
 * @property {string} id            same slug as src/js/products.js
 * @property {string} category      apparel | headwear | drinkware | phone_case | wall_art | tote | stationery | engraved | fragrance | electronics
 * @property {boolean} sellable     false = never purchasable online (deferred categories)
 * @property {number} weightG
 * @property {Array<{name:string, values:string[]}>} options   same names, values and order as the front end
 * @property {Record<string, number>} price                    minor units for every code in CURRENCIES
 * @property {Record<string, Record<string, number>>} [variantPrices]   variantKey → price table (overrides `price`)
 * @property {Array<{key:string, type:'text', maxLength:number, pattern:string, required:boolean, surcharge?:Record<string, number>}>} [personalisation]
 * @property {string[]} [regions]   optional allow-list of regions; default = every region the routing rules can serve
 */

const SIZES = ['S', 'M', 'L', 'XL'];
const VOLUMES = ['30 ml', '50 ml', '100 ml'];

/** @type {CatalogueProduct[]} */
export const catalogue = [
  /* ------------------------------------------------------------ wear */
  {
    id: 'halos-off-hoodie',
    category: 'apparel',
    sellable: true,
    weightG: 550,
    options: [{ name: 'size', values: SIZES }],
    price: { EUR: 7900, GBP: 6900, CAD: 11900, USD: 8900, AED: 32900, SAR: 33900, EGP: 249900 },
    // Optional name embroidered on the hoodie (letters, digits, space, dot, dash; 12 characters at most).
    personalisation: [{
      key: 'name', type: 'text', maxLength: 12, pattern: '^[\\p{L}\\p{N} .\\-]+$', required: false,
      surcharge: { EUR: 500, GBP: 400, CAD: 800, USD: 600, AED: 2100, SAR: 2200, EGP: 15900 },
    }],
  },
  {
    id: 'nice-guy-long-story-tee',
    category: 'apparel',
    sellable: true,
    weightG: 200,
    options: [{ name: 'size', values: SIZES }],
    price: { EUR: 3500, GBP: 3000, CAD: 5300, USD: 3900, AED: 14500, SAR: 15100, EGP: 110900 },
  },
  {
    id: 'horns-down-cap',
    category: 'headwear',
    sellable: true,
    weightG: 110,
    options: [],
    price: { EUR: 2900, GBP: 2500, CAD: 4400, USD: 3200, AED: 12000, SAR: 12500, EGP: 91900 },
  },
  {
    id: 'two-sides-socks',
    category: 'apparel',
    sellable: true,
    weightG: 70,
    options: [{ name: 'size', values: ['36-40', '41-45'] }],
    price: { EUR: 1600, GBP: 1400, CAD: 2400, USD: 1800, AED: 6600, SAR: 6900, EGP: 50900 },
  },

  /* ------------------------------------------------------------ scent (deferred: never sold online in v1) */
  {
    id: 'secret-no-1',
    category: 'fragrance',
    sellable: false,
    weightG: 250,
    options: [{ name: 'volume', values: VOLUMES }],
    price: { EUR: 6800, GBP: 5900, CAD: 10200, USD: 7600, AED: 28200, SAR: 29200, EGP: 214900 },
    variantPrices: {
      'volume=30 ml': { EUR: 4200, GBP: 3700, CAD: 6300, USD: 4700, AED: 17400, SAR: 18100, EGP: 132900 },
      'volume=50 ml': { EUR: 6800, GBP: 5900, CAD: 10200, USD: 7600, AED: 28200, SAR: 29200, EGP: 214900 },
      'volume=100 ml': { EUR: 10400, GBP: 9000, CAD: 15600, USD: 11600, AED: 43200, SAR: 44700, EGP: 328900 },
    },
  },
  {
    id: 'sweet-nothing',
    category: 'fragrance',
    sellable: false,
    weightG: 250,
    options: [{ name: 'volume', values: VOLUMES }],
    price: { EUR: 6200, GBP: 5400, CAD: 9300, USD: 6900, AED: 25700, SAR: 26700, EGP: 195900 },
    variantPrices: {
      'volume=30 ml': { EUR: 3800, GBP: 3300, CAD: 5700, USD: 4300, AED: 15800, SAR: 16300, EGP: 119900 },
      'volume=50 ml': { EUR: 6200, GBP: 5400, CAD: 9300, USD: 6900, AED: 25700, SAR: 26700, EGP: 195900 },
      'volume=100 ml': { EUR: 9600, GBP: 8400, CAD: 14400, USD: 10800, AED: 39800, SAR: 41300, EGP: 302900 },
    },
  },
  {
    id: 'after-midnight',
    category: 'fragrance',
    sellable: false,
    weightG: 250,
    options: [{ name: 'volume', values: VOLUMES }],
    price: { EUR: 7400, GBP: 6400, CAD: 11100, USD: 8300, AED: 30700, SAR: 31800, EGP: 233900 },
    variantPrices: {
      'volume=30 ml': { EUR: 4600, GBP: 4000, CAD: 6900, USD: 5200, AED: 19100, SAR: 19800, EGP: 144900 },
      'volume=50 ml': { EUR: 7400, GBP: 6400, CAD: 11100, USD: 8300, AED: 30700, SAR: 31800, EGP: 233900 },
      'volume=100 ml': { EUR: 11200, GBP: 9700, CAD: 16800, USD: 12500, AED: 46500, SAR: 48200, EGP: 353900 },
    },
  },
  {
    id: 'morning-alibi',
    category: 'fragrance',
    sellable: false,
    weightG: 250,
    options: [{ name: 'volume', values: VOLUMES }],
    price: { EUR: 5800, GBP: 5000, CAD: 8700, USD: 6500, AED: 24100, SAR: 24900, EGP: 182900 },
    variantPrices: {
      'volume=30 ml': { EUR: 3600, GBP: 3100, CAD: 5400, USD: 4000, AED: 14900, SAR: 15500, EGP: 113900 },
      'volume=50 ml': { EUR: 5800, GBP: 5000, CAD: 8700, USD: 6500, AED: 24100, SAR: 24900, EGP: 182900 },
      'volume=100 ml': { EUR: 8800, GBP: 7700, CAD: 13200, USD: 9900, AED: 36500, SAR: 37800, EGP: 277900 },
    },
  },

  /* ------------------------------------------------------------ tech (deferred: never sold online in v1) */
  {
    id: 'little-devil-earbuds',
    category: 'electronics',
    sellable: false,
    weightG: 120,
    options: [{ name: 'colour', values: ['cream', 'navy'] }],
    price: { EUR: 5900, GBP: 5100, CAD: 8900, USD: 6600, AED: 24500, SAR: 25400, EGP: 185900 },
  },
  {
    id: 'hot-head-power-bank',
    category: 'electronics',
    sellable: false,
    weightG: 250,
    options: [],
    price: { EUR: 3900, GBP: 3400, CAD: 5900, USD: 4400, AED: 16200, SAR: 16800, EGP: 122900 },
  },
  {
    id: 'night-shift-lamp',
    category: 'electronics',
    sellable: false,
    weightG: 600,
    options: [],
    price: { EUR: 4900, GBP: 4300, CAD: 7400, USD: 5500, AED: 20300, SAR: 21100, EGP: 154900 },
  },
  {
    id: 'the-tail-cable',
    category: 'electronics',
    sellable: false,
    weightG: 60,
    options: [],
    price: { EUR: 1900, GBP: 1700, CAD: 2900, USD: 2100, AED: 7900, SAR: 8200, EGP: 59900 },
  },
];
