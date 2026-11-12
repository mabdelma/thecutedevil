// Per-supplier variant mapping. Owner: sup. Server only (never imported by the front end).
// Contract: web/COMMERCE_ARCH.md section c.
// Shape: mapping[productId][variantKey | '*'] = [{ supplier, productRef, variantRef, regions: [],
//          files?: [{ placement, url }], cost?: { amount, currency }, days?: [min, max] }]
//
// !!! EVERY productRef / variantRef / file URL BELOW IS A PLACEHOLDER !!!
// A ref that starts with "PLACEHOLDER" is treated as "not mapped": the adapter answers isAvailable = false, so
// nothing can be ordered from that supplier until the owner creates the product in the supplier account and
// replaces the ref with the real id. How to find the ids: node server/suppliers/tools/list-catalogue.js <supplier>
// (steps in web/COMMERCE_ARCH.md, "Suppliers notes"). `cost` and `days` are rough study figures for the routing
// comparison only; replace them with the supplier's real prices too.
//
// What each supplier expects:
//   printful  productRef = catalogue product id; variantRef = catalogue variant id (per size/colour), with `files`
//             (placement = Printful file type, e.g. 'default', 'front', 'embroidery_front'); or variantRef
//             'sync:<sync variant id>' for a product already designed in the Printful store (no `files` needed).
//   printify  productRef = the shop's product id (24 hex chars); variantRef = its numeric variant id. No `files`:
//             the design lives in the Printify product.
//   gelato    productRef = any label; variantRef = productUid (one per size/colour); `files` placement = Gelato
//             file type ('default', 'back', …).
//   printlet  productRef = catalogue product id; variantRef = variant id; `files` placement = print area key.
// Optional extras read by the adapters:
//   personalisation: { <field key>: { placement, urlTemplate: 'https://…/render?text={value}' } }   text → print file
//   shipping: { amount, currency }   static shipping cost for the table quote
// `mock` and `manual` need no entries here (the routing engine handles both).

const P = 'PLACEHOLDER';
const ART = 'https://example.com/PLACEHOLDER-print-files'; // replace with the real public https folder of print files
const WEST = ['EU', 'UK', 'CA', 'US'];

/** One product × one variant → the list of suppliers able to make it. */
function entries(slug, tag, o) {
  const file = (name) => `${ART}/${slug}-${name}.png`;
  const out = [];
  if (o.printful) out.push({ supplier: 'printful', productRef: `${P}-PRINTFUL-PRODUCT-${slug}`, variantRef: `${P}-PRINTFUL-VARIANT-${slug}-${tag}`, regions: WEST, files: [{ placement: o.printful.placement, url: file('front') }], cost: { amount: o.printful.cost, currency: 'USD' }, days: [4, 9] });
  if (o.gelato) out.push({ supplier: 'gelato', productRef: `${P}-GELATO-${slug}`, variantRef: `${P}-GELATO-PRODUCTUID-${slug}-${tag}`, regions: WEST, files: [{ placement: 'default', url: file('front') }], cost: { amount: o.gelato.cost, currency: 'EUR' }, days: [4, 9] });
  if (o.printify) out.push({ supplier: 'printify', productRef: `${P}-PRINTIFY-PRODUCT-${slug}`, variantRef: `${P}-PRINTIFY-VARIANT-${slug}-${tag}`, regions: WEST, cost: { amount: o.printify.cost, currency: 'USD' }, days: [5, 10] });
  if (o.printlet) out.push({ supplier: 'printlet', productRef: `${P}-PRINTLET-PRODUCT-${slug}`, variantRef: `${P}-PRINTLET-VARIANT-${slug}-${tag}`, regions: ['EG'], files: [{ placement: `${P}-PRINT-AREA-KEY`, url: file('front') }], cost: { amount: o.printlet.cost, currency: 'EGP' }, days: [2, 5] });
  return out;
}

const bySize = (slug, sizes, o) => Object.fromEntries(sizes.map((size) => [`size=${size}`, entries(slug, size, o)]));
const SIZES = ['S', 'M', 'L', 'XL'];

/** @type {Record<string, Record<string, Array<object>>>} */
export const mapping = {
  // PLACEHOLDER: embroidered hoodie
  'halos-off-hoodie': bySize('halos-off-hoodie', SIZES, {
    printful: { placement: 'embroidery_chest_left', cost: 2950 }, gelato: { cost: 2700 }, printify: { cost: 2600 }, printlet: { cost: 45000 },
  }),
  // PLACEHOLDER: printed tee
  'nice-guy-long-story-tee': bySize('nice-guy-long-story-tee', SIZES, {
    printful: { placement: 'default', cost: 1295 }, gelato: { cost: 1100 }, printify: { cost: 1050 }, printlet: { cost: 22000 },
  }),
  // PLACEHOLDER: embroidered cap (no options → variant key 'default')
  'horns-down-cap': { default: entries('horns-down-cap', 'default', {
    printful: { placement: 'embroidery_front', cost: 1550 }, gelato: { cost: 1500 }, printify: { cost: 1450 }, printlet: { cost: 20000 },
  }) },
  // PLACEHOLDER: socks. Not confirmed in Gelato's or Printlet's range, so only Printful and Printify are listed.
  'two-sides-socks': bySize('two-sides-socks', ['36-40', '41-45'], {
    printful: { placement: 'default', cost: 995 }, printify: { cost: 900 },
  }),
};

/** This supplier's entry for a variant: exact variant key first, then '*'. null when there is none. */
export function mappingEntry(productId, variantKey, supplier, table = mapping) {
  const product = table[productId];
  if (!product) return null;
  for (const key of [variantKey, '*']) {
    const hit = Array.isArray(product[key]) ? product[key].find((e) => e.supplier === supplier) : null;
    if (hit) return hit;
  }
  return null;
}

/** Entries that still hold placeholder refs: [{ productId, variantKey, supplier }]. Empty = the mapping is filled. */
export function placeholders(table = mapping) {
  const out = [];
  for (const [productId, variants] of Object.entries(table)) {
    for (const [variantKey, list] of Object.entries(variants)) {
      for (const e of list) if ([e.productRef, e.variantRef].some((r) => String(r).toUpperCase().startsWith(P))) out.push({ productId, variantKey, supplier: e.supplier });
    }
  }
  return out;
}
