// The Cute Devil: checkout page. Owner: web. Contract: web/COMMERCE_ARCH.md section f.
// One page: order summary, contact, delivery address, shipping, payment, legal, pay.
//   - the server owns every amount: this page shows what POST /api/quote answers and sends
//     `expectedTotal` back with POST /api/checkout, which recomputes everything;
//   - the bag is NOT cleared here: order.html clears it once the order is confirmed;
//   - commerce off (or /api/config unreachable): this page only points back to the WhatsApp order.
import { ready } from '../app.js';
import { scan } from '../motion.js';
import { getById, formatPrice, artFor, optionLabel, valueLabel, personalisationLabel } from '../products.js';
import { t, tn, has, strings, getLang } from '../i18n.js';
import * as cart from '../cart.js';
import * as commerce from '../commerce.js';
import { tidy } from '../checkout.js';

const root = document.documentElement;
// If a strict Content-Security-Policy ever blocks the inline boot script of the page, do its job here.
if (root.classList.contains('no-js')) {
  root.classList.remove('no-js'); root.classList.add('js');
  try { const th = localStorage.getItem('tcd:theme'); if (th) root.setAttribute('data-theme', th); } catch (err) { /* private mode */ }
}

const DRAFT_KEY = 'tcd:checkout';      // sessionStorage: what the customer typed (survives a reload or a cancelled payment)
const ATTEMPT_KEY = 'tcd:checkoutId';  // sessionStorage: { fp, id } one UUID per distinct attempt
const LIMITS = { name: [2, 60], email: [3, 191], line1: [3, 191], line2: [0, 191], city: [2, 120], state: [2, 120], postcode: [2, 12], note: [0, 300] };

const STR = strings({
  offTitle: 'checkout.off.title',
  offText: 'checkout.off.text',
  offCta: 'checkout.off.cta',
  emptyTitle: 'checkout.empty.title',
  emptyText: 'checkout.empty.text',
  openShop: 'common.openShop',
  optional: 'cart.field.optional',
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  arrow: '<svg class="c-btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16z"/><path d="M3.5 8L12 12.5 20.5 8M12 12.5v8"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h3"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.4"/><path d="M6.5 9.5v5M17.5 9.5v5"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="4" y="8" width="16.5" height="11" rx="2.5"/><path d="M16 13.5h1.5"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 20.5l1.3-4.7a8.5 8.5 0 1 1 3.4 3.4z"/><path d="M9.2 8.2c-.3 3.4 3.2 6.9 6.6 6.6l.7-1.8-2-1.1-.9.9c-1-.5-1.9-1.4-2.4-2.4l.9-.9-1.1-2z"/></svg>',
  horns: '<svg viewBox="0 0 64 22" aria-hidden="true" focusable="false"><path d="M6 22C2 12 4 4 10 0c0 9 4 16 12 22z"/><path d="M58 22c4-10 2-18-4-22 0 9-4 16-12 22z"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 4l9 15.5H3z"/><path d="M12 10v4.5M12 17.3v.2"/></svg>',
};

/* ---------------------------------------------------------------- state */
const S = {
  host: null,
  mode: 'loading',             // loading | off | empty | form
  form: { email: '', phone: '', name: '', line1: '', line2: '', city: '', state: '', postcode: '', note: '', terms: false, made: false },
  errors: {},                  // field → message
  touched: new Set(),
  shippingOption: '',
  paymentMethod: '',
  paymentChosen: false,        // true once the customer picked a method (then it is sent with the quote)
  quote: null,
  quoteState: 'idle',          // idle | loading | ok | error
  quoteError: '',
  flagged: new Map(),          // cart line key → reason
  banner: null,                // { kind: 'info' | 'warn' | 'error', text }
  submitting: false,
  submitError: '',
  cancelled: '',
};
let quoteSeq = 0;
let quoteTimer = 0;

function loadDraft() {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    if (!d || typeof d !== 'object') return;
    Object.keys(S.form).forEach((k) => { if (typeof d[k] === 'string' && typeof S.form[k] === 'string') S.form[k] = d[k].slice(0, 400); });
    if (typeof d.shippingOption === 'string') S.shippingOption = d.shippingOption;
  } catch (err) { /* private mode */ }
}
function saveDraft() {
  try {
    const { terms, made, ...text } = S.form;
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...text, shippingOption: S.shippingOption }));
  } catch (err) { /* private mode */ }
}

/* ---------------------------------------------------------------- helpers */
const $ = (sel, scope = S.host) => (scope ? scope.querySelector(sel) : null);
const $$ = (sel, scope = S.host) => (scope ? Array.from(scope.querySelectorAll(sel)) : []);
const money = (minor) => formatPrice(minor, S.quote ? S.quote.currency : commerce.getCurrency());
const rules = () => commerce.addressRules(commerce.getCountry());
const phoneRequired = () => rules().phone === 'required' || S.paymentMethod === 'cod';
const eta = (min, max) => {
  const a = Number(min); const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return '';
  return a === b || a <= 0 ? tn('checkout.eta.days', b) : t('checkout.eta.range', { min: a, max: b });
};
const apiMessage = (code) => (has(`apiError.${code}`) ? t(`apiError.${code}`) : t('apiError.generic'));

/** Bag lines that can be sent to the server, and the ones that cannot be ordered online at all. */
function bag() {
  const lines = cart.lines();
  return { lines, sendable: lines.filter((l) => l.buyable), blocked: lines.filter((l) => !l.buyable) };
}
const itemOf = (l) => ({ id: l.id, qty: l.qty, options: { ...l.options }, ...(l.personalisation ? { personalisation: { ...l.personalisation } } : {}) });
const hasPersonalised = () => cart.lines().some((l) => l.personalisation && Object.keys(l.personalisation).length);

/** Join the quote's lines to the bag lines. Same variant twice (two personalisations) → matched in order. */
function quoteLines() {
  const pool = new Map();
  ((S.quote && S.quote.lines) || []).forEach((ql) => { if (!pool.has(ql.key)) pool.set(ql.key, []); pool.get(ql.key).push(ql); });
  const out = new Map();
  // the server keys a line like the bag does; the contract's shorter `id|variant` form is accepted too
  bag().sendable.forEach((l) => {
    const list = [pool.get(l.key), pool.get(cart.variantLineKey(l))].find((x) => x && x.length);
    if (list) out.set(l.key, list.shift());
  });
  return out;
}

const selectedShipping = () => {
  const list = (S.quote && S.quote.shippingOptions) || [];
  return list.find((o) => o.id === S.shippingOption) || list[0] || null;
};
/** The total to show and to send as `expectedTotal`: always the server's own number. The chosen shipping option
    goes to POST /api/quote, so the quote is already priced for it; nothing is added up in the browser. */
const totalNow = () => (S.quote ? S.quote.total : null);
const canSubmit = () => S.quoteState === 'ok' && S.quote && !S.flagged.size && !bag().blocked.length && bag().sendable.length > 0
  && (S.quote.paymentMethods || []).length > 0 && (S.quote.shippingOptions || []).length > 0;

/* ---------------------------------------------------------------- validation */
function validateField(key) {
  const f = S.form;
  const r = rules();
  const len = (v, [min, max]) => v.length >= min && v.length <= max;
  switch (key) {
    case 'email': {
      const v = tidy(f.email);
      const at = v.split('@');
      const ok = v.length <= LIMITS.email[1] && at.length === 2 && at[0].length > 0 && /^[^\s.]+(\.[^\s.]+)+$/.test(at[1]) && !/\s/.test(v);
      return ok ? '' : t('checkout.err.email');
    }
    case 'phone': {
      const v = tidy(f.phone);
      if (!v) return phoneRequired() ? t('checkout.err.phoneRequired') : '';
      return commerce.normalisePhone(v, commerce.getCountry()) ? '' : t('checkout.err.phone');
    }
    case 'name': return len(tidy(f.name), LIMITS.name) ? '' : t('checkout.err.name');
    case 'line1': return len(tidy(f.line1), LIMITS.line1) ? '' : t('checkout.err.line1');
    case 'line2': return tidy(f.line2).length <= LIMITS.line2[1] ? '' : t('checkout.err.line2');
    case 'city': return len(tidy(f.city), LIMITS.city) ? '' : t('checkout.err.city');
    case 'state': {
      const v = tidy(f.state);
      if (r.state === 'hidden') return '';
      if (!v) return r.state === 'required' ? t(`checkout.err.state.${r.stateKind}`) : '';
      return len(v, LIMITS.state) ? '' : t(`checkout.err.state.${r.stateKind}`);
    }
    case 'postcode': {
      const v = tidy(f.postcode);
      if (r.postcode === 'hidden') return '';
      if (!v) return r.postcode === 'required' ? t(`checkout.err.${r.postcodeKind}`) : '';
      return r.postcodePattern.test(v) ? '' : t(`checkout.err.${r.postcodeKind}`);
    }
    case 'note': return tidy(f.note).length <= LIMITS.note[1] ? '' : t('checkout.errNote');
    case 'terms': return f.terms ? '' : t('checkout.err.terms');
    case 'made': return !hasPersonalised() || f.made ? '' : t('checkout.err.made');
    default: return '';
  }
}
const FIELDS = ['email', 'phone', 'name', 'line1', 'line2', 'city', 'state', 'postcode', 'note', 'terms', 'made'];

function paintError(key) {
  const input = $(`[name="${key}"]`);
  if (!input) return;
  const field = input.closest('.c-field, .k-check');
  const slot = $(`#co-${key}-error`);
  const text = S.errors[key] || '';
  if (field) field.classList.toggle('is-invalid', Boolean(text));
  if (slot) slot.textContent = text;
  if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}
function check(key) {
  const text = validateField(key);
  if (text) S.errors[key] = text; else delete S.errors[key];
  paintError(key);
  return !text;
}

/* ---------------------------------------------------------------- templates */
function fieldHTML(key, { label, type = 'text', autocomplete = '', inputmode = '', hint = '', optional = false, ltr = false, cls = '', placeholder = '' }) {
  const id = `co-${key}`;
  const max = LIMITS[key] ? LIMITS[key][1] : 40;
  const described = [hint ? `${id}-hint` : '', `${id}-error`].filter(Boolean).join(' ');
  const error = S.errors[key] || '';
  const common = `id="${id}" name="${key}" maxlength="${max}" aria-describedby="${described}"${autocomplete ? ` autocomplete="${autocomplete}"` : ''}${inputmode ? ` inputmode="${inputmode}"` : ''}${ltr ? ' dir="ltr"' : ''}${optional ? '' : ' required aria-required="true"'}${error ? ' aria-invalid="true"' : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}`;
  const value = esc(S.form[key] || '');
  const control = type === 'textarea'
    ? `<textarea class="c-textarea k-note" ${common} rows="2">${value}</textarea>`
    : `<input class="c-input${ltr ? ' k-ltr' : ''}" type="${type}" ${common} value="${value}">`;
  return `
<div class="c-field ${cls}${error ? ' is-invalid' : ''}" data-field="${key}">
  <label class="c-field__label" for="${id}"><span data-label>${esc(label)}</span> <small data-optional${optional ? '' : ' hidden'}>${esc(STR.optional)}</small></label>
  ${control}
  ${hint ? `<p class="c-field__hint" id="${id}-hint">${esc(hint)}</p>` : ''}
  <p class="c-field__error" id="${id}-error" role="alert">${esc(error)}</p>
</div>`;
}

function countryHTML() {
  const now = commerce.getCountry();
  const options = commerce.countryOptions(getLang()).map((c) => `<option value="${c.code}"${c.code === now ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  return `
<div class="c-field k-col-2" data-field="country">
  <label class="c-field__label" for="co-country">${esc(t('checkout.field.country'))}</label>
  <span class="k-select"><select class="c-select" id="co-country" name="country" autocomplete="country" aria-describedby="co-country-hint">${options}</select></span>
  <p class="c-field__hint" id="co-country-hint" data-k-currency></p>
  <div class="k-notserved" data-k-notserved></div>
</div>`;
}

const stepHead = (n, key, id) => `<header class="k-step__head"><span class="k-step__n" aria-hidden="true">${n}</span><h2 class="k-step__title" id="${id}">${esc(t(key))}</h2></header>`;

function formHTML() {
  return `
<div class="k-layout">
  <div class="k-main">
    <div class="k-banner" data-k-banner role="status" aria-live="polite" hidden></div>
    <form class="k-form" id="checkout-form" novalidate data-k-form>
      <section class="k-step" aria-labelledby="co-step-1">
        ${stepHead(1, 'checkout.step.contact', 'co-step-1')}
        <div class="k-fields">
          ${fieldHTML('email', { label: t('checkout.field.email'), type: 'email', autocomplete: 'email', inputmode: 'email', ltr: true, hint: t('checkout.field.emailHint') })}
          ${fieldHTML('phone', { label: t('checkout.field.phone'), type: 'tel', autocomplete: 'tel', inputmode: 'tel', ltr: true, hint: t('checkout.field.phoneHint'), optional: !phoneRequired() })}
        </div>
      </section>

      <section class="k-step" aria-labelledby="co-step-2">
        ${stepHead(2, 'checkout.step.delivery', 'co-step-2')}
        <div class="k-fields">
          ${countryHTML()}
          ${fieldHTML('name', { label: t('checkout.field.name'), autocomplete: 'name', cls: 'k-col-2' })}
          ${fieldHTML('line1', { label: t('checkout.field.line1'), autocomplete: 'address-line1', cls: 'k-col-2' })}
          ${fieldHTML('line2', { label: t('checkout.field.line2'), autocomplete: 'address-line2', optional: true, cls: 'k-col-2' })}
          ${fieldHTML('city', { label: t('checkout.field.city'), autocomplete: 'address-level2' })}
          ${fieldHTML('postcode', { label: t('checkout.field.postcode'), autocomplete: 'postal-code', ltr: true })}
          ${fieldHTML('state', { label: t('checkout.field.state.region'), autocomplete: 'address-level1', cls: 'k-col-2' })}
          ${fieldHTML('note', { label: t('checkout.field.note'), type: 'textarea', optional: true, cls: 'k-col-2', placeholder: t('checkout.field.notePlaceholder') })}
        </div>
      </section>

      <section class="k-step" aria-labelledby="co-step-3">
        ${stepHead(3, 'checkout.step.shipping', 'co-step-3')}
        <div data-k-shipping></div>
      </section>

      <section class="k-step" aria-labelledby="co-step-4">
        ${stepHead(4, 'checkout.step.payment', 'co-step-4')}
        <div data-k-payment></div>
      </section>

      <section class="k-step k-step--last" aria-label="${esc(t('checkout.step.confirm'))}">
        <div class="k-legal" data-k-legal></div>
        <p class="k-submit-error" data-k-submit-error role="alert"></p>
        <button type="submit" class="c-btn c-btn--primary c-btn--lg c-btn--block k-pay" data-k-pay data-devil>
          <span class="c-btn__label" data-k-pay-label></span>
        </button>
        <p class="k-secure" data-k-secure></p>
      </section>
    </form>
  </div>

  <aside class="k-side" aria-labelledby="co-summary-title">
    <div class="k-summary" data-devil style="--devil-rest: 8; --devil-max: 16; --devil-horn: 4rem">
      <header class="k-summary__head">
        <h2 class="k-summary__title" id="co-summary-title">${esc(t('checkout.summary.title'))}</h2>
        <button type="button" class="c-btn c-btn--text k-summary__edit" data-cart-toggle>${esc(t('checkout.summary.edit'))}</button>
      </header>
      <div data-k-summary></div>
    </div>
    ${commerce.getConfig().whatsappFallback ? `<p class="k-alt"><button type="button" class="c-link k-alt__btn" data-cart-toggle>${ICON.wa}<span>${esc(t('cart.whatsappInstead'))}</span></button></p>` : ''}
  </aside>
</div>`;
}

function stateHTML({ title, text, cta, href, toggle = false, secondary = '' }) {
  return `
<div class="k-state">
  <span class="k-state__horns" aria-hidden="true">${ICON.horns}</span>
  <h2 class="u-h2 k-state__title">${esc(title)}</h2>
  <p class="c-lede k-state__text">${esc(text)}</p>
  <div class="u-cluster k-state__cta">
    ${toggle ? `<button type="button" class="c-btn c-btn--primary c-btn--lg" data-cart-toggle>${ICON.wa}<span class="c-btn__label">${esc(cta)}</span></button>`
    : `<a class="c-btn c-btn--primary c-btn--lg" href="${href}"><span class="c-btn__label">${esc(cta)}${ICON.arrow}</span></a>`}
    ${secondary}
  </div>
</div>`;
}

/* ---------------------------------------------------------------- dynamic regions */
function lineHTML(l, i, ql) {
  const p = l.product;
  const meta = (p.options || []).map((o) => `${optionLabel(o.name)} ${valueLabel(l.options[o.name])}`)
    .concat(Object.keys(l.personalisation || {}).map((k) => `${personalisationLabel(k)}: \u2068${l.personalisation[k]}\u2069`)).join(' · ');
  const reason = S.flagged.get(l.key) || (!l.buyable ? 'NOT_SOLD_ONLINE' : '');
  const total = ql ? ql.total : l.lineTotal;
  return `
<li class="k-line${reason ? ' is-flagged' : ''}" data-key="${esc(l.key)}">
  <span class="k-line__thumb" aria-hidden="true">${artFor(p, `co${i}`)}<span class="k-line__qty" translate="no">${l.qty}</span></span>
  <div class="k-line__main">
    <p class="k-line__name" translate="no">${esc(p.name)}</p>
    ${meta ? `<p class="k-line__meta">${esc(meta)}</p>` : ''}
    <p class="k-line__meta"><span class="u-sr">${esc(t('product.qty'))}</span> <span translate="no">× ${l.qty}</span></p>
    ${reason ? `<p class="k-line__flag">${ICON.warn}<span>${esc(has(`checkout.unavailable.${reason}`) ? t(`checkout.unavailable.${reason}`) : t('checkout.unavailable.NOT_AVAILABLE_IN_REGION'))}</span></p>
    <button type="button" class="c-btn c-btn--text k-line__remove" data-k-remove="${esc(l.key)}">${esc(t('checkout.unavailable.remove'))}</button>` : ''}
  </div>
  <span class="k-line__total" translate="no">${reason ? '' : esc(money(total))}</span>
</li>`;
}

function summaryHTML() {
  const { lines } = bag();
  const q = S.quote;
  const map = quoteLines();
  const parcels = q && Array.isArray(q.fulfilments) ? q.fulfilments : [];
  let list = '';
  if (q && parcels.length > 1) {
    // more than one parcel: say so, and show what travels together
    const seen = new Set();
    list = parcels.map((f, n) => {
      const mine = lines.filter((l) => { const ql = map.get(l.key); return ql && ql.fulfilment === f.index && !S.flagged.has(l.key); });
      mine.forEach((l) => seen.add(l.key));
      if (!mine.length) return '';
      const days = eta(f.minDays, f.maxDays);
      return `
<div class="k-parcel">
  <p class="k-parcel__head">${ICON.box}<span>${esc(t('checkout.parcel.nOf', { n: n + 1, total: parcels.length }))}</span>${days ? `<span class="k-parcel__eta">${esc(t('checkout.parcel.arrives', { eta: days }))}</span>` : ''}</p>
  <ul class="k-lines">${mine.map((l) => lineHTML(l, lines.indexOf(l), map.get(l.key))).join('')}</ul>
</div>`;
    }).join('');
    const rest = lines.filter((l) => !seen.has(l.key));
    if (rest.length) list += `<ul class="k-lines">${rest.map((l) => lineHTML(l, lines.indexOf(l), map.get(l.key))).join('')}</ul>`;
  } else {
    list = `<ul class="k-lines">${lines.map((l, i) => lineHTML(l, i, map.get(l.key))).join('')}</ul>`;
  }

  let totals = '';
  if (S.quoteState === 'error') {
    totals = `
<div class="k-quote-error" role="alert">
  <p>${ICON.warn}<span>${esc(S.quoteError === 'MARKET_NOT_SERVED' ? t('apiError.MARKET_NOT_SERVED') : S.quoteError === 'RATE_LIMITED' ? t('apiError.RATE_LIMITED') : t('checkout.quote.failed'))}</span></p>
  ${S.quoteError === 'MARKET_NOT_SERVED' && commerce.getConfig().whatsappFallback
    ? `<button type="button" class="c-btn c-btn--ghost c-btn--sm" data-cart-toggle>${ICON.wa}<span>${esc(t('checkout.off.cta'))}</span></button>`
    : `<button type="button" class="c-btn c-btn--ghost c-btn--sm" data-k-retry>${esc(t('checkout.quote.retry'))}</button>`}
</div>`;
  } else if (q) {
    const opt = selectedShipping();
    const ship = q.shipping;
    const tax = q.tax || {};
    const taxText = tax.labelKey && has(tax.labelKey)
      ? t(tax.labelKey, { amount: money(tax.amount || 0), rate: ((tax.rateBp || 0) / 100).toLocaleString(getLang(), { maximumFractionDigits: 2 }) })
      : (tax.included && tax.amount > 0 ? t('checkout.tax.included', { amount: money(tax.amount) }) : '');
    const taxRow = !tax.included && tax.amount > 0
      ? `<div class="k-total__row"><dt>${esc(t('checkout.total.tax'))}</dt><dd translate="no">${esc(money(tax.amount))}</dd></div>` : '';
    const single = parcels.length === 1 ? eta(opt ? opt.minDays : parcels[0].minDays, opt ? opt.maxDays : parcels[0].maxDays) : '';
    totals = `
<dl class="k-total">
  <div class="k-total__row"><dt>${esc(t('checkout.total.subtotal'))}</dt><dd translate="no">${esc(money(q.subtotal))}</dd></div>
  <div class="k-total__row"><dt>${esc(t('checkout.total.shipping'))}${single ? ` <small>${esc(single)}</small>` : ''}</dt><dd${ship === 0 ? '' : ' translate="no"'}>${esc(ship === 0 ? t('checkout.ship.free') : money(ship))}</dd></div>
  ${taxRow}
  <div class="k-total__row k-total__row--grand"><dt>${esc(t('checkout.total.total'))}</dt><dd translate="no" data-k-total>${esc(money(totalNow()))}</dd></div>
</dl>
${taxText ? `<p class="k-total__tax">${esc(taxText)}</p>` : ''}
${(q.notices || []).filter((k) => has(k) && k !== 'checkout.notice.splitShipment').map((k) => `<p class="k-notice">${esc(t(k))}</p>`).join('')}`;
  } else {
    totals = `<p class="k-quote-wait"><span class="k-spin" aria-hidden="true"></span>${esc(t('checkout.quote.loading'))}</p>`;
  }
  return `<div class="k-summary__body${S.quoteState === 'loading' ? ' is-busy' : ''}" aria-busy="${S.quoteState === 'loading' ? 'true' : 'false'}">${list}${totals}</div>`;
}

function shippingHTML() {
  const q = S.quote;
  if (!q) return `<p class="k-quote-wait">${S.quoteState === 'error' ? esc(t('checkout.ship.unknown')) : `<span class="k-spin" aria-hidden="true"></span>${esc(t('checkout.quote.loading'))}`}</p>`;
  const list = q.shippingOptions || [];
  const parcels = Array.isArray(q.fulfilments) ? q.fulfilments.length : 1;
  if (!list.length) return `<p class="k-quote-wait">${esc(t('checkout.ship.none'))}</p>`;
  const chosen = selectedShipping();
  const options = list.map((o, i) => {
    const days = eta(o.minDays, o.maxDays);
    const name = has(`checkout.ship.option.${o.id}`) ? t(`checkout.ship.option.${o.id}`) : t('checkout.ship.option.standard');
    return `
<label class="k-choice">
  <input class="k-choice__input" type="radio" name="shippingOption" value="${esc(o.id)}" id="co-ship-${i}"${chosen && chosen.id === o.id ? ' checked' : ''}>
  <span class="k-choice__face">
    <span class="k-choice__dot" aria-hidden="true"></span>
    <span class="k-choice__text"><b>${esc(name)}</b>${days ? `<small>${esc(t('checkout.ship.arrives', { eta: days }))}</small>` : ''}</span>
    <span class="k-choice__price"${o.amount === 0 ? '' : ' translate="no"'}>${esc(o.amount === 0 ? t('checkout.ship.free') : money(o.amount))}</span>
  </span>
</label>`;
  }).join('');
  const split = parcels > 1 ? `
<p class="k-split">${ICON.box}<span><b>${esc(tn('checkout.parcel.count', parcels))}</b> ${esc(t('checkout.notice.splitShipment'))}</span></p>` : '';
  return `<fieldset class="k-choices"><legend class="u-sr">${esc(t('checkout.step.shipping'))}</legend>${options}</fieldset>${split}`;
}

function paymentHTML() {
  const q = S.quote;
  if (!q) return `<p class="k-quote-wait">${S.quoteState === 'error' ? esc(t('checkout.pay.unknown')) : `<span class="k-spin" aria-hidden="true"></span>${esc(t('checkout.quote.loading'))}`}</p>`;
  const methods = Array.from(new Set((q.paymentMethods || []).map((m) => m.method)));
  if (!methods.length) return `<p class="k-quote-error" role="alert">${ICON.warn}<span>${esc(t('apiError.PAYMENT_METHOD_UNAVAILABLE'))}</span></p>`;
  const options = methods.map((m, i) => `
<label class="k-choice">
  <input class="k-choice__input" type="radio" name="paymentMethod" value="${esc(m)}" id="co-pay-${i}"${S.paymentMethod === m ? ' checked' : ''}>
  <span class="k-choice__face">
    <span class="k-choice__dot" aria-hidden="true"></span>
    <span class="k-choice__text"><b>${esc(has(`payMethod.${m}`) ? t(`payMethod.${m}`) : m)}</b>${has(`checkout.pay.hint.${m}`) ? `<small>${esc(t(`checkout.pay.hint.${m}`))}</small>` : ''}</span>
    <span class="k-choice__icon" aria-hidden="true">${m === 'cod' ? ICON.cash : m === 'wallet' ? ICON.wallet : ICON.card}</span>
  </span>
</label>`).join('');
  return `<fieldset class="k-choices"><legend class="u-sr">${esc(t('checkout.step.payment'))}</legend>${options}</fieldset>`;
}

function legalHTML() {
  const link = (href, key) => `<a class="c-link" href="${href}" target="_blank" rel="noopener">${esc(t(key))}</a>`;
  const terms = t('checkout.legal.terms', { terms: link('terms.html', 'checkout.legal.termsLink'), privacy: link('privacy.html', 'checkout.legal.privacyLink'), returns: link('shipping-returns.html', 'checkout.legal.returnsLink') });
  const box = (key, html) => `
<div class="k-check${S.errors[key] ? ' is-invalid' : ''}">
  <label class="k-check__label" for="co-${key}">
    <input class="k-check__input" type="checkbox" id="co-${key}" name="${key}" required aria-required="true" aria-describedby="co-${key}-error"${S.form[key] ? ' checked' : ''}${S.errors[key] ? ' aria-invalid="true"' : ''}>
    <span class="k-check__box" aria-hidden="true"></span>
    <span class="k-check__text">${html}</span>
  </label>
  <p class="c-field__error" id="co-${key}-error" role="alert">${esc(S.errors[key] || '')}</p>
</div>`;
  return `${hasPersonalised() ? `
<div class="k-made">
  <p class="k-made__title">${esc(t('checkout.legal.madeTitle'))}</p>
  <p class="k-made__text">${esc(t('checkout.legal.madeText'))}</p>
  ${box('made', esc(t('checkout.legal.madeAccept')))}
</div>` : ''}${box('terms', terms)}`;
}

function paintBanner() {
  const el = $('[data-k-banner]');
  if (!el) return;
  el.hidden = !S.banner;
  el.className = `k-banner${S.banner ? ` k-banner--${S.banner.kind}` : ''}`;
  el.innerHTML = S.banner ? `${ICON.warn}<p>${esc(S.banner.text)}</p><button type="button" class="k-banner__close" data-k-banner-close aria-label="${esc(t('checkout.banner.close'))}">${ICON.close}</button>` : '';
}

/** Under the country select: what to do when the customer's country is not a market yet (UAE, the Gulf, …). */
function paintNotServed() {
  const el = $('[data-k-notserved]');
  if (!el) return;
  const away = commerce.notServedCountry();
  const wa = commerce.getConfig().whatsappFallback
    ? `<button type="button" class="c-link k-notserved__btn" data-cart-toggle>${ICON.wa}<span>${esc(t('checkout.off.cta'))}</span></button>` : '';
  el.className = `k-notserved${away ? ' k-notserved--away' : ''}`;
  if (away) el.setAttribute('role', 'status'); else el.removeAttribute('role');
  el.innerHTML = away
    ? `<p>${ICON.warn}<span>${esc(t('checkout.notServed.text', { country: commerce.countryName(away, getLang()) }))}</span></p>${wa}`
    : `<p><span>${esc(t('checkout.notServed.hint'))}</span></p>${wa}`;
}

function paintPay() {
  const btn = $('[data-k-pay]');
  if (!btn) return;
  const label = $('[data-k-pay-label]');
  const total = S.quote && S.quoteState !== 'error' ? money(totalNow()) : '';
  const cod = S.paymentMethod === 'cod';
  let text = total ? t(cod ? 'checkout.pay.placeOrder' : 'checkout.pay.pay', { total }) : t('checkout.pay.payPlain');
  if (S.submitting) text = t(cod ? 'checkout.pay.placing' : 'checkout.pay.redirecting');
  label.innerHTML = `${S.submitting ? '<span class="k-spin k-spin--btn" aria-hidden="true"></span>' : ICON.lock}<span translate="no" data-k-pay-text></span>`;
  label.querySelector('[data-k-pay-text]').textContent = text;
  const blocked = S.submitting || !canSubmit();
  btn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
  btn.classList.toggle('is-blocked', blocked);
  if (S.submitting) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
  const secure = $('[data-k-secure]');
  if (secure) secure.textContent = t(cod ? 'checkout.pay.secureCod' : 'checkout.pay.secure');
  const err = $('[data-k-submit-error]');
  if (err) err.textContent = S.submitError;
}

/** Labels, required marks and visibility of the fields that depend on the country. */
function paintAddress() {
  const r = rules();
  const set = (key, mode, label) => {
    const field = $(`[data-field="${key}"]`);
    if (!field) return;
    const input = field.querySelector('input');
    field.hidden = mode === 'hidden';
    input.disabled = mode === 'hidden';
    field.querySelector('[data-label]').textContent = label;
    field.querySelector('[data-optional]').hidden = mode !== 'optional';
    if (mode === 'required') { input.required = true; input.setAttribute('aria-required', 'true'); } else { input.required = false; input.removeAttribute('aria-required'); }
    if (mode === 'hidden') { delete S.errors[key]; paintError(key); }
  };
  set('state', r.state, t(`checkout.field.state.${r.stateKind}`));
  set('postcode', r.postcode, t(`checkout.field.${r.postcodeKind}`));
  set('phone', phoneRequired() ? 'required' : 'optional', t('checkout.field.phone'));
  const phone = $('[name="phone"]');
  const dial = commerce.DIAL[commerce.getCountry()];
  if (phone) phone.placeholder = dial ? `+${dial} …` : '';
  // a field that already shows an error is checked again under the new rules
  ['state', 'postcode', 'phone'].forEach((k) => { if (S.errors[k]) check(k); });
  const cur = $('[data-k-currency]');
  if (cur) cur.textContent = t('checkout.field.countryHint', { currency: commerce.getCurrency() });
  const sel = $('#co-country');
  if (sel && sel.value !== commerce.getCountry()) sel.value = commerce.getCountry();
  paintNotServed();
}

function paintDynamic() {
  if (S.mode !== 'form') return;
  const keepFocus = document.activeElement && S.host.contains(document.activeElement) ? document.activeElement : null;
  const focusName = keepFocus && keepFocus.matches('[data-k-shipping] input, [data-k-payment] input, [data-k-legal] input') ? [keepFocus.name, keepFocus.value] : null;
  $('[data-k-summary]').innerHTML = summaryHTML();
  $('[data-k-shipping]').innerHTML = shippingHTML();
  $('[data-k-payment]').innerHTML = paymentHTML();
  $('[data-k-legal]').innerHTML = legalHTML();
  if (focusName) {
    const again = $$(`[name="${focusName[0]}"]`).find((n) => n.type !== 'radio' || n.value === focusName[1]);
    if (again) again.focus({ preventScroll: true });
  }
  paintAddress();
  paintBanner();
  paintPay();
}

/* ---------------------------------------------------------------- quote */
function reconcile() {
  const q = S.quote;
  S.flagged = new Map();
  if (!q) return;
  const bad = new Map((q.unavailable || []).map((u) => [u.key, u.reason || 'NOT_AVAILABLE_IN_REGION']));
  const map = quoteLines();
  bag().sendable.forEach((l) => {
    const hit = [l.key, cart.variantLineKey(l)].find((k) => bad.has(k));
    if (hit && !map.has(l.key)) S.flagged.set(l.key, bad.get(hit));
  });
  const ships = q.shippingOptions || [];
  // the server says which option it priced; an option it does not know falls back to its first one
  if (typeof q.shippingOption === 'string' && ships.some((o) => o.id === q.shippingOption)) S.shippingOption = q.shippingOption;
  else if (!ships.some((o) => o.id === S.shippingOption)) S.shippingOption = ships[0] ? ships[0].id : '';
  const methods = (q.paymentMethods || []).map((m) => m.method);
  if (!methods.includes(S.paymentMethod)) { S.paymentMethod = methods[0] || ''; S.paymentChosen = false; }
}

function quoteBody() {
  const r = rules();
  const body = { country: commerce.getCountry(), items: bag().sendable.map(itemOf), lang: getLang() };
  const state = tidy(S.form.state);
  const postcode = tidy(S.form.postcode);
  if (state && r.state !== 'hidden') body.state = state;
  if (postcode && r.postcode !== 'hidden') body.postcode = postcode;
  if (S.paymentChosen && S.paymentMethod) body.paymentMethod = S.paymentMethod;
  if (S.shippingOption) body.shippingOption = S.shippingOption;
  return body;
}

async function runQuote() {
  const mine = ++quoteSeq;
  if (S.mode !== 'form') return;
  if (!bag().sendable.length) { S.quote = null; S.quoteState = 'idle'; reconcile(); paintDynamic(); return; }
  try {
    const q = await commerce.quote(quoteBody());
    if (mine !== quoteSeq) return;
    S.quote = q;
    S.quoteState = 'ok';
    S.quoteError = '';
  } catch (err) {
    if (mine !== quoteSeq) return;
    S.quote = null;
    S.quoteState = 'error';
    S.quoteError = err && err.code ? err.code : 'NETWORK';
  }
  reconcile();
  paintDynamic();
}
function requestQuote(delay = 0) {
  window.clearTimeout(quoteTimer);
  quoteSeq += 1; // anything still on its way is out of date
  S.quoteState = 'loading';
  S.submitError = '';
  const body = $('.k-summary__body');
  if (body) { body.classList.add('is-busy'); body.setAttribute('aria-busy', 'true'); }
  paintPay();
  quoteTimer = window.setTimeout(runQuote, delay);
}

/* ---------------------------------------------------------------- submit */
function uuid() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (err) { /* older browsers */ }
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); } catch (err) { for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256); }
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}
/** One checkoutId per distinct attempt: the same order sent twice (double tap, retry, back button) keeps its id. */
function attemptId(body) {
  const fp = JSON.stringify(body);
  try {
    const seen = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) || 'null');
    if (seen && seen.fp === fp && typeof seen.id === 'string') return seen.id;
  } catch (err) { /* private mode */ }
  const id = uuid();
  try { sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ fp, id })); } catch (err) { /* private mode */ }
  return id;
}

function readForm() {
  const form = $('[data-k-form]');
  if (!form) return;
  ['email', 'phone', 'name', 'line1', 'line2', 'city', 'state', 'postcode', 'note'].forEach((k) => { if (form.elements[k]) S.form[k] = form.elements[k].value; });
  ['terms', 'made'].forEach((k) => { if (form.elements[k]) S.form[k] = form.elements[k].checked; });
}

function fail(text, { focus = true } = {}) {
  S.submitError = text;
  paintPay();
  if (focus) { const btn = $('[data-k-pay]'); if (btn) btn.focus({ preventScroll: true }); }
}

async function submit() {
  if (S.submitting) return;                       // double-submit protection
  readForm();
  S.submitError = '';
  FIELDS.forEach((k) => { S.touched.add(k); check(k); });
  const firstBad = FIELDS.find((k) => S.errors[k]);
  if (firstBad) {
    const input = $(`[name="${firstBad}"]`);
    S.submitError = t('checkout.err.fix');
    paintPay();
    if (input) { input.scrollIntoView({ block: 'center', behavior: 'auto' }); input.focus({ preventScroll: true }); }
    return;
  }
  if (S.quoteState === 'loading') { fail(t('checkout.err.wait')); return; }
  if (!canSubmit()) {
    fail(S.flagged.size || bag().blocked.length ? t('checkout.err.unavailable') : t('checkout.quote.failed'));
    const side = $('.k-summary'); if (side) side.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    return;
  }
  const r = rules();
  const country = commerce.getCountry();
  const phone = commerce.normalisePhone(tidy(S.form.phone), country);
  const state = r.state === 'hidden' ? '' : tidy(S.form.state);
  const postcode = r.postcode === 'hidden' ? '' : tidy(S.form.postcode);
  const note = tidy(S.form.note);
  const body = {
    country,
    ...(state ? { state } : {}),
    ...(postcode ? { postcode } : {}),
    items: bag().sendable.map(itemOf),
    lang: getLang(),
    shippingOption: selectedShipping().id,
    paymentMethod: S.paymentMethod,
    customer: { name: tidy(S.form.name), email: tidy(S.form.email), ...(phone ? { phone } : {}) },
    address: { line1: tidy(S.form.line1), ...(tidy(S.form.line2) ? { line2: tidy(S.form.line2) } : {}), city: tidy(S.form.city), ...(state ? { state } : {}), ...(postcode ? { postcode } : {}) },
    ...(note ? { note } : {}),
    acceptTerms: true,
    expectedTotal: totalNow(),
  };
  body.checkoutId = attemptId(body);

  S.submitting = true;
  paintPay();
  try {
    const res = await commerce.checkout(body);
    const pay = res && res.payment;
    if (!res || typeof res.orderId !== 'string' || typeof res.token !== 'string' || !pay) throw new commerce.ApiError('BAD_RESPONSE', 0);
    commerce.rememberOrder({ id: res.orderId, token: res.token, cleared: false });
    saveDraft();
    if (pay.kind === 'redirect') {
      let url = null;
      try { url = new URL(pay.url, window.location.href); } catch (err) { url = null; }
      if (!url || !/^https?:$/.test(url.protocol)) throw new commerce.ApiError('PAYMENT_PROVIDER_ERROR', 502);
      window.location.assign(url.href);           // stay "submitting": the page is leaving
      return;
    }
    // cash on delivery: the order is confirmed at once
    window.location.assign(`order.html?id=${encodeURIComponent(res.orderId)}&token=${encodeURIComponent(res.token)}`);
  } catch (err) {
    S.submitting = false;
    const code = err && err.code ? err.code : 'NETWORK';
    if (code === 'PRICE_CHANGED') {
      const fresh = err.body && err.body.quote; // contract section f: the fresh quote sits next to `error`
      S.banner = { kind: 'warn', text: t('apiError.PRICE_CHANGED') };
      if (fresh && fresh.lines) { S.quote = fresh; S.quoteState = 'ok'; reconcile(); paintDynamic(); } else requestQuote();
      const b = $('[data-k-banner]'); if (b) b.scrollIntoView({ block: 'center', behavior: 'auto' });
      fail(t('apiError.PRICE_CHANGED'), { focus: false });
      return;
    }
    if (code === 'ITEM_UNAVAILABLE') {
      const keys = Array.isArray(err.fields) ? err.fields : Object.keys(err.fields || {});
      bag().sendable.forEach((l) => { if (keys.includes(cart.variantLineKey(l)) || keys.includes(l.key)) S.flagged.set(l.key, 'NOT_AVAILABLE_IN_REGION'); });
      if (!S.flagged.size) requestQuote(); else paintDynamic();
      fail(t('apiError.ITEM_UNAVAILABLE'), { focus: false });
      const side = $('.k-summary'); if (side) side.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      return;
    }
    if (code === 'VALIDATION' && err.fields) {
      // the server names the fields it refused: mark the ones this form knows
      const names = (Array.isArray(err.fields) ? err.fields : Object.keys(err.fields)).map((f) => String(f).split('.').pop());
      const known = names.map((n) => (n === 'acceptTerms' ? 'terms' : n)).filter((n) => FIELDS.includes(n));
      known.forEach((k) => { S.errors[k] = validateField(k) || t('checkout.err.server'); paintError(k); });
      fail(t('apiError.VALIDATION'), { focus: !known.length });
      if (known.length) { const input = $(`[name="${known[0]}"]`); if (input) { input.scrollIntoView({ block: 'center', behavior: 'auto' }); input.focus({ preventScroll: true }); } }
      return;
    }
    if (code === 'ORDER_CLOSED') {
      // this attempt's order expired or was cancelled on the server: the next press starts a new one
      try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (e) { /* private mode */ }
      requestQuote();
      fail(t('apiError.ORDER_CLOSED'));
      return;
    }
    if (code === 'PAYMENT_METHOD_UNAVAILABLE' || code === 'MARKET_NOT_SERVED' || code === 'CART_EMPTY') requestQuote();
    fail(apiMessage(code));
  }
}

/* ---------------------------------------------------------------- render + events */
function render() {
  const { lines } = bag();
  if (!commerce.isOn()) S.mode = 'off';
  else if (!lines.length) S.mode = 'empty';
  else S.mode = 'form';

  document.title = t('checkout.meta.title');
  if (S.mode === 'off') {
    S.host.innerHTML = stateHTML({
      title: STR.offTitle, text: STR.offText, cta: STR.offCta, toggle: lines.length > 0, href: 'shop.html',
      secondary: lines.length ? `<a class="c-btn c-btn--text" href="shop.html">${esc(STR.openShop)}</a>` : '',
    });
    return;
  }
  if (S.mode === 'empty') {
    S.host.innerHTML = stateHTML({ title: STR.emptyTitle, text: STR.emptyText, cta: STR.openShop, href: 'shop.html' });
    return;
  }
  S.host.innerHTML = formHTML();
  paintDynamic();
  try { scan(S.host); } catch (err) { /* decoration only */ }
}

function bind() {
  const host = S.host;
  host.addEventListener('submit', (e) => { if (e.target.matches('[data-k-form]')) { e.preventDefault(); submit(); } });
  host.addEventListener('click', (e) => {
    const pay = e.target.closest('[data-k-pay]');
    if (pay && S.submitting) { e.preventDefault(); return; }
    const remove = e.target.closest('[data-k-remove]');
    if (remove) { cart.remove(remove.dataset.kRemove); return; }
    if (e.target.closest('[data-k-retry]')) { requestQuote(); return; }
    if (e.target.closest('[data-k-banner-close]')) { S.banner = null; paintBanner(); }
  });
  host.addEventListener('input', (e) => {
    const name = e.target.name;
    if (!name || !(name in S.form) || e.target.type === 'checkbox') return;
    S.form[name] = e.target.value;
    if (S.errors[name]) check(name);
    saveDraft();
    if (name === 'postcode' || name === 'state') requestQuote(600);
  });
  host.addEventListener('focusout', (e) => {
    const name = e.target.name;
    if (!name || !(name in S.form) || e.target.type === 'checkbox') return;
    S.touched.add(name);
    if (tidy(e.target.value) || S.errors[name]) check(name);
    if (name === 'phone') {
      const full = commerce.normalisePhone(tidy(e.target.value), commerce.getCountry());
      if (full) { e.target.value = full; S.form.phone = full; saveDraft(); }
    }
  });
  host.addEventListener('change', (e) => {
    const { name } = e.target;
    if (name === 'country') { commerce.setCountry(e.target.value); paintNotServed(); return; } // → tcd:market → new quote
    if (name === 'shippingOption') { S.shippingOption = e.target.value; saveDraft(); requestQuote(); return; } // the server prices the chosen option
    if (name === 'paymentMethod') {
      S.paymentMethod = e.target.value; S.paymentChosen = true;
      paintAddress();
      requestQuote();   // cash on delivery can change who ships, so the quote is asked again
      return;
    }
    if (name === 'terms' || name === 'made') { S.form[name] = e.target.checked; check(name); }
  });

  document.addEventListener('tcd:cart', (e) => {
    const reason = e.detail && e.detail.reason;
    if (reason === 'init') return;
    const was = S.mode;
    readForm();
    const { lines } = bag();
    if (!lines.length || was !== 'form') { render(); if (S.mode === 'form') requestQuote(); return; }
    requestQuote(150);
    paintDynamic();
  });
  document.addEventListener('tcd:market', () => {
    readForm();
    const was = S.mode;
    if (!commerce.isOn() || was !== 'form') { render(); if (S.mode === 'form') requestQuote(); return; }
    S.quote = null;           // another country: other currency, other options
    S.banner = null;
    paintDynamic();
    requestQuote();
  });
  document.addEventListener('tcd:lang', () => { readForm(); Object.keys(S.errors).forEach((k) => { S.errors[k] = validateField(k) || S.errors[k]; }); render(); if (S.mode === 'form') requestQuote(); });
  // back from the payment page through the browser's back button: the form is usable again
  window.addEventListener('pageshow', (e) => { if (e.persisted) { S.submitting = false; paintPay(); if (S.mode === 'form') requestQuote(); } });
}

async function init() {
  S.host = document.querySelector('[data-checkout]');
  if (!S.host) return;
  loadDraft();
  const params = new URLSearchParams(window.location.search);
  S.cancelled = tidy(params.get('cancelled') || '').slice(0, 40);
  await commerce.ready;       // this page needs the live answer, not a cached one
  if (S.cancelled) {
    S.banner = { kind: 'info', text: t('checkout.banner.cancelled') };
    try { params.delete('cancelled'); const q = params.toString(); window.history.replaceState(window.history.state, '', `${window.location.pathname}${q ? `?${q}` : ''}`); } catch (err) { /* ignore */ }
  }
  bind();
  render();
  if (S.mode === 'form') requestQuote();
}

if (document.body.dataset.page === 'checkout') {
  ready.then(init).catch((err) => { console.warn('[tcd] checkout', err); init(); });
}
