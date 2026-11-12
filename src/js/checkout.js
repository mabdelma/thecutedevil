// The Cute Devil: checkout. Turns the bag into a WhatsApp message. No DOM in here. Owner: shop.
// v1 has no payment, no stock sync and no order database: an order exists once the customer
// presses send in WhatsApp. The cart drawer (cart-ui.js) drives the steps and calls this module.
import { getById, priceOf, formatPrice } from './products.js';
import { isOn, getCurrency } from './commerce.js';
import { t, getLang } from './i18n.js';

export const WHATSAPP_NUMBER = '34622209935'; // digits only, country code first
const MAX_MESSAGE = 1500; // keep the wa.me link comfortably short

// The order message is written for the seller, so it stays in English in every language.
// Only the form errors shown to the customer come from the dictionary.
const STR = {
  hello: "Hi The Cute Devil! I'd like to order:",
  sample: '(sample)',
  total: (amount) => (isOn() ? `Estimated total: ${amount} (before shipping, to be confirmed)` : `Estimated total: ${amount} (sample prices, to be confirmed)`),
  name: (v) => `Name: ${v}`,
  city: (v) => `City / country: ${v}`,
  note: (v) => `Note: ${v}`,
  ref: (v) => `Ref: ${v}`,
  more: (n) => `+ ${n} more ${n === 1 ? 'line' : 'lines'} (I will list them in the chat)`,
  lang: (v) => `Site language: ${v}`,
  get errName() { return t('checkout.errName'); },
  get errCity() { return t('checkout.errCity'); },
  get errNote() { return t('checkout.errNote'); },
};

export const LIMITS = { name: [2, 60], city: [2, 80], note: [0, 300] };

/** Trim, collapse whitespace and strip control characters. */
export function tidy(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns { ok, values: { name, city, note }, errors: { name?, city?, note? } }. */
export function validateCustomer(input = {}) {
  const values = { name: tidy(input.name), city: tidy(input.city), note: tidy(input.note) };
  const errors = {};
  if (values.name.length < LIMITS.name[0] || values.name.length > LIMITS.name[1]) errors.name = STR.errName;
  if (values.city.length < LIMITS.city[0] || values.city.length > LIMITS.city[1]) errors.city = STR.errCity;
  if (values.note.length > LIMITS.note[1]) errors.note = STR.errNote;
  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** Order reference: TCD-YYMMDD-xxxx (4 random characters, no look-alikes). */
export function orderRef(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${two(date.getFullYear() % 100)}${two(date.getMonth() + 1)}${two(date.getDate())}`;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let tail = '';
  const random = new Uint32Array(4);
  try { crypto.getRandomValues(random); } catch (err) { for (let i = 0; i < 4; i += 1) random[i] = Math.floor(Math.random() * 2 ** 32); }
  for (let i = 0; i < 4; i += 1) tail += alphabet[random[i] % alphabet.length];
  return `TCD-${stamp}-${tail}`;
}

function describe(items) {
  const rows = [];
  let total = 0;
  const currency = getCurrency();
  // with real prices (commerce on) the "(sample)" mark is dropped; amounts are minor units
  const mark = isOn() ? '' : ` ${STR.sample}`;
  (items || []).forEach((item) => {
    const product = getById(item.id);
    if (!product) return;
    const qty = Math.max(1, Number(item.qty) || 1);
    const lineTotal = (priceOf(product, item.options, currency, item.personalisation) || 0) * qty;
    const variant = (product.options || []).map((o) => item.options && item.options[o.name]).filter(Boolean)
      .concat(Object.keys(item.personalisation || {}).map((k) => `${k}: ${item.personalisation[k]}`)).join(' / ');
    total += lineTotal;
    rows.push([product.name, variant, `× ${qty}`, `${formatPrice(lineTotal, currency)}${mark}`].filter(Boolean).join(' — ').replace(' — ×', ' ×'));
  });
  return { rows, total, currency };
}

/**
 * The order as plain text.
 * items: cart lines [{ id, qty, options }]; customer: { name, city, note?, ref? }.
 */
export function buildOrderText(items, customer = {}) {
  const { rows, total, currency } = describe(items);
  const name = tidy(customer.name);
  const city = tidy(customer.city);
  const note = tidy(customer.note).slice(0, LIMITS.note[1]);
  const tail = [
    '',
    STR.total(formatPrice(total, currency)),
    STR.name(name),
    STR.city(city),
    ...(note ? [STR.note(note)] : []),
    STR.ref(customer.ref || orderRef()),
    STR.lang(getLang()),
  ];
  const compose = (shown) => {
    const list = rows.slice(0, shown).map((row, i) => `${i + 1}) ${row}`);
    if (shown < rows.length) list.push(STR.more(rows.length - shown));
    return [STR.hello, '', ...list, ...tail].join('\n');
  };
  let shown = rows.length;
  let text = compose(shown);
  while (text.length > MAX_MESSAGE && shown > 1) { shown -= 1; text = compose(shown); }
  return text;
}

/** https://wa.me/34622209935?text=… (newlines become %0A). */
export function whatsappUrl(text) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(String(text || ''))}`;
}

/* =====================================================================================
   // PAYMENT-PROVIDER SLOT
   -------------------------------------------------------------------------------------
   Today there is ONE way to place an order: `whatsapp` below. It needs no server.
   A card provider (Stripe Checkout, Redsys, PayPal, Mollie…) plugs in HERE, as a second
   entry in `providers`, without touching the cart or the product pages.

   How to add it:
   1. Real prices first: set `sample: false` and real amounts in products.js.
   2. A card payment needs a small server endpoint (the secret key must never be in this
      file). On Hostinger that is a Node route or a PHP file, for example `api/checkout`.
      It receives the order, RE-READS the prices on the server (never trust amounts sent by
      the browser), creates the provider's checkout session and answers { url }.
   3. Add the provider next to `whatsapp`:

        card: {
          label: 'pay by card',
          async submit(order) {
            const res = await fetch('api/checkout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // send ids, quantities and options only: the server owns the prices
              body: JSON.stringify({ ref: order.ref, items: order.items, customer: order.customer }),
            });
            if (!res.ok) return { ok: false, error: 'payment-unavailable' };
            const { url } = await res.json();
            return { ok: true, redirectUrl: url };   // the provider's hosted payment page
          },
        },

   4. In cart-ui.js, the preview step has a matching comment "PAYMENT-PROVIDER SLOT (markup)":
      add a second button there that calls `submitOrder(order, 'card')` and then sends the
      customer to `redirectUrl`. Clear the bag only on the provider's success return page.
   5. This also means an external request, so update the "no external requests" rule and
      add the legal pages (terms of sale, privacy, returns) before taking real money.

   Every provider returns the same shape: { ok: Boolean, redirectUrl?: String, error?: String }.
   ===================================================================================== */
export const providers = {
  whatsapp: {
    label: 'order on whatsapp',
    async submit(order) {
      return { ok: true, redirectUrl: whatsappUrl(order.text) };
    },
  },
  // card: { ... }  ← PAYMENT-PROVIDER SLOT: see the block above
};

/** Build one order object from the bag and the customer details. */
export function createOrder(items, customer = {}) {
  const ref = customer.ref || orderRef();
  const clean = { name: tidy(customer.name), city: tidy(customer.city), note: tidy(customer.note), ref };
  const lines = (items || []).map(({ id, qty, options, personalisation }) => ({ id, qty, options: { ...options }, ...(personalisation ? { personalisation: { ...personalisation } } : {}) }));
  const text = buildOrderText(lines, clean);
  return { ref, items: lines, customer: clean, text, url: whatsappUrl(text) };
}

/** Hand the order to a provider. Resolves { ok, redirectUrl?, error? }. */
export async function submitOrder(order, provider = 'whatsapp') {
  const p = providers[provider];
  if (!p) return { ok: false, error: 'unknown-provider' };
  try { return await p.submit(order); } catch (err) { return { ok: false, error: 'provider-failed' }; }
}
