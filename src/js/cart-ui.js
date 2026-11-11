// The Cute Devil: cart drawer + WhatsApp checkout steps. Owner: shop.
// Loaded by app.js on EVERY page (also contact and 404, which do not link shop.css),
// so the drawer brings its own styles with the import below.
import '../css/shop.css';
import * as cart from './cart.js';
import { formatPrice, artFor, optionLabel, valueLabel } from './products.js';
import { t, tn, strings, apply } from './i18n.js';
import { createOrder, validateCustomer, submitOrder, LIMITS } from './checkout.js';

const STR = strings({
  steps: ['cart.step.bag', 'cart.step.details', 'cart.step.whatsapp'], // dictionary keys
  stepOf: (n) => t('cart.stepOf', { n, total: 3 }),
  close: 'cart.close',
  titleBag: 'cart.title.bag',
  titleDetails: 'cart.title.details',
  titlePreview: 'cart.title.preview',
  titleSent: 'cart.title.sent',
  titleDone: 'cart.title.done',
  pieces: (n) => tn('cart.pieces', n),
  emptyTitle: 'cart.empty.title',
  emptyText: 'cart.empty.text',
  emptyCta: 'common.openShop',
  each: (price) => t('cart.each', { price }),
  qtyGroup: (name) => t('cart.qtyGroup', { name }),
  less: (name) => t('cart.less', { name }),
  more: (name) => t('cart.more', { name }),
  remove: (name) => t('cart.remove', { name }),
  maxHint: (n) => t('cart.maxHint', { n }),
  total: 'cart.total',
  sample: 'common.sample',
  honest: 'common.honest',
  toDetails: 'cart.toDetails',
  keepLooking: 'cart.keepLooking',
  detailsIntro: 'cart.details.intro',
  name: 'cart.field.name',
  city: 'cart.field.city',
  cityHint: 'cart.field.cityHint',
  note: 'cart.field.note',
  optional: 'cart.field.optional',
  notePlaceholder: 'cart.field.notePlaceholder',
  toPreview: 'cart.toPreview',
  back: 'cart.back',
  previewIntro: 'cart.preview.intro',
  messageLabel: 'cart.preview.messageLabel',
  ref: 'cart.ref',
  openWhatsApp: 'cart.openWhatsApp',
  copy: 'cart.copy',
  copied: 'cart.copied',
  copyFailed: 'cart.copyFailed',
  edit: 'cart.edit',
  sentIntro: 'cart.sent.intro',
  sentYes: 'cart.sent.yes',
  sentAgain: 'cart.sent.again',
  sentNo: 'cart.sent.no',
  doneText: 'cart.done.text',
  doneRef: (ref) => t('cart.done.ref', { ref }),
  doneCta: 'cart.keepLooking',
  added: (name) => t('cart.say.added', { name }),
  removed: (name) => t('cart.say.removed', { name }),
  qtyNow: (name, qty, total) => t('cart.say.qty', { name, qty, total }),
  cleared: 'cart.say.cleared',
  fixForm: 'cart.say.fixForm',
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 12h12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 12h12M12 6v12"/></svg>',
  arrow: '<svg class="c-btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 20.5l1.3-4.7a8.5 8.5 0 1 1 3.4 3.4z"/><path d="M9.2 8.2c-.3 3.4 3.2 6.9 6.6 6.6l.7-1.8-2-1.1-.9.9c-1-.5-1.9-1.4-2.4-2.4l.9-.9-1.1-2z"/></svg>',
  horns: '<svg viewBox="0 0 64 22" aria-hidden="true" focusable="false"><path d="M6 22C2 12 4 4 10 0c0 9 4 16 12 22z"/><path d="M58 22c4-10 2-18-4-22 0 9-4 16-12 22z"/></svg>',
};

const state = {
  open: false,
  step: 'bag', // bag | details | preview | sent | done
  customer: { name: '', city: '', note: '' },
  errors: {},
  order: null,
  doneRef: '',
  opener: null,
  inerted: [],
};
const el = { root: null, wrap: null, panel: null, title: null, stepLabel: null, steps: null, body: null, foot: null, live: null };

/* ---------------------------------------------------------------- templates */
function optionText(line) {
  return (line.product.options || []).map((o) => `${optionLabel(o.name)} ${valueLabel(line.options[o.name])}`).join(' · ');
}

function lineHTML(line, i) {
  const p = line.product;
  const href = `product.html?id=${encodeURIComponent(p.id)}`;
  const meta = [optionText(line), STR.each(formatPrice(line.unit, p.currency))].filter(Boolean).join(' · ');
  return `
<li class="s-line" style="--i:${i}" data-key="${esc(line.key)}">
  <a class="s-line__thumb" href="${href}" tabindex="-1" aria-hidden="true">${artFor(p, `bag${i}`)}</a>
  <div class="s-line__main">
    <a class="s-line__name" href="${href}" translate="no">${esc(p.name)}</a>
    <p class="s-line__meta">${esc(meta)}</p>
    <div class="s-line__row">
      <div class="s-qty s-qty--sm" role="group" aria-label="${esc(STR.qtyGroup(p.name))}">
        <button type="button" class="s-qty__btn" data-act="dec" data-fid="dec:${esc(line.key)}" aria-label="${esc(STR.less(p.name))}"${line.qty <= cart.MIN_QTY ? ' disabled' : ''}>${ICON.minus}</button>
        <span class="s-qty__value" aria-hidden="true">${line.qty}</span>
        <button type="button" class="s-qty__btn" data-act="inc" data-fid="inc:${esc(line.key)}" aria-label="${esc(STR.more(p.name))}"${line.qty >= cart.MAX_QTY ? ' disabled' : ''}>${ICON.plus}</button>
      </div>
      <span class="s-line__total">${esc(formatPrice(line.lineTotal, p.currency))}</span>
    </div>
    ${line.qty >= cart.MAX_QTY ? `<p class="s-line__hint">${esc(STR.maxHint(cart.MAX_QTY))}</p>` : ''}
  </div>
  <button type="button" class="s-line__remove" data-act="remove" data-fid="rm:${esc(line.key)}" aria-label="${esc(STR.remove(p.name))}">${ICON.close}</button>
</li>`;
}

function totalHTML(lines) {
  const sum = lines.reduce((s, l) => s + l.lineTotal, 0);
  const currency = lines[0] ? lines[0].product.currency : 'EUR';
  return `
<div class="s-cart__total">
  <span class="s-cart__total-k">${esc(STR.total)} <span class="c-badge c-badge--sample">${esc(STR.sample)}</span></span>
  <strong class="s-cart__total-v">${esc(formatPrice(sum, currency))}</strong>
</div>
<p class="s-cart__honest">${esc(STR.honest)}</p>`;
}

function fieldHTML(key, { label, type = 'input', hint = '', optional = false, placeholder = '', autocomplete = '' }) {
  const id = `tcd-order-${key}`;
  const error = state.errors[key] || '';
  const described = [hint ? `${id}-hint` : '', `${id}-error`].filter(Boolean).join(' ');
  const common = `class="${type === 'textarea' ? 'c-textarea s-cart__note' : 'c-input'}" id="${id}" name="${key}" data-fid="field:${key}" maxlength="${LIMITS[key][1]}" aria-describedby="${described}"${optional ? '' : ' required aria-required="true"'}${error ? ' aria-invalid="true"' : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${autocomplete ? ` autocomplete="${autocomplete}"` : ''}`;
  const value = esc(state.customer[key] || '');
  const control = type === 'textarea' ? `<textarea ${common} rows="3">${value}</textarea>` : `<input ${common} type="text" value="${value}">`;
  return `
<div class="c-field${error ? ' is-invalid' : ''}">
  <label class="c-field__label" for="${id}">${esc(label)}${optional ? ` <small>${esc(STR.optional)}</small>` : ''}</label>
  ${control}
  ${hint ? `<p class="c-field__hint" id="${id}-hint">${esc(hint)}</p>` : ''}
  <p class="c-field__error" id="${id}-error" role="alert">${esc(error)}</p>
</div>`;
}

const VIEWS = {
  bag() {
    const lines = cart.lines();
    if (!lines.length) {
      return {
        title: STR.titleBag, step: 1,
        body: `
<div class="s-cart__empty">
  <span class="s-cart__empty-horns">${ICON.horns}</span>
  <h3 class="u-h3">${esc(STR.emptyTitle)}</h3>
  <p class="u-muted">${esc(STR.emptyText)}</p>
  <a class="c-btn c-btn--primary" href="shop.html">${esc(STR.emptyCta)}${ICON.arrow}</a>
</div>`,
        foot: '',
      };
    }
    return {
      title: STR.titleBag, step: 1, count: STR.pieces(cart.count()),
      body: `<ul class="s-cart__lines">${lines.map(lineHTML).join('')}</ul>`,
      foot: `${totalHTML(lines)}
<button type="button" class="c-btn c-btn--primary c-btn--block" data-act="to-details" data-fid="to-details">${ICON.wa}${esc(STR.toDetails)}</button>
<button type="button" class="c-btn c-btn--text c-btn--block" data-act="close">${esc(STR.keepLooking)}</button>`,
    };
  },
  details() {
    return {
      title: STR.titleDetails, step: 2,
      body: `
<p class="s-cart__intro">${esc(STR.detailsIntro)}</p>
<form class="c-form s-cart__form" id="tcd-order-form" novalidate>
  ${fieldHTML('name', { label: STR.name, autocomplete: 'name' })}
  ${fieldHTML('city', { label: STR.city, hint: STR.cityHint, autocomplete: 'address-level2' })}
  ${fieldHTML('note', { label: STR.note, type: 'textarea', optional: true, placeholder: STR.notePlaceholder })}
</form>`,
      foot: `${totalHTML(cart.lines())}
<button type="submit" form="tcd-order-form" class="c-btn c-btn--primary c-btn--block" data-fid="to-preview">${esc(STR.toPreview)}${ICON.arrow}</button>
<button type="button" class="c-btn c-btn--text c-btn--block" data-act="to-bag">${esc(STR.back)}</button>`,
    };
  },
  preview() {
    const order = state.order;
    return {
      title: STR.titlePreview, step: 3,
      body: `
<p class="s-cart__intro">${esc(STR.previewIntro)}</p>
<pre class="s-cart__msg" tabindex="0" aria-label="${esc(STR.messageLabel)}" data-cart-message lang="en" dir="ltr" translate="no">${esc(order.text)}</pre>
<p class="s-cart__ref"><span>${esc(STR.ref)}</span> <strong translate="no">${esc(order.ref)}</strong></p>`,
      foot: `<p class="s-cart__honest">${esc(STR.honest)}</p>
<a class="c-btn c-btn--primary c-btn--block" href="${esc(order.url)}" target="_blank" rel="noopener" data-act="send" data-fid="send" data-cart-wa>${ICON.wa}${esc(STR.openWhatsApp)}</a>
<!-- PAYMENT-PROVIDER SLOT (markup): a card provider adds its button here, for example
     <button type="button" class="c-btn c-btn--contrast c-btn--block" data-act="pay-card">pay by card</button>
     and its handler calls submitOrder(state.order, 'card'). See checkout.js for the full recipe. -->
<div class="s-cart__pair">
  <button type="button" class="c-btn c-btn--text" data-act="to-details">${esc(STR.edit)}</button>
  <button type="button" class="c-btn c-btn--text" data-act="copy" data-fid="copy">${esc(STR.copy)}</button>
</div>`,
    };
  },
  sent() {
    const order = state.order;
    return {
      title: STR.titleSent, step: 3,
      body: `
<p class="s-cart__intro">${esc(STR.sentIntro)}</p>
<p class="s-cart__ref"><span>${esc(STR.ref)}</span> <strong translate="no">${esc(order.ref)}</strong></p>`,
      foot: `
<button type="button" class="c-btn c-btn--primary c-btn--block" data-act="sent-yes" data-fid="sent-yes">${esc(STR.sentYes)}</button>
<a class="c-btn c-btn--ghost c-btn--block" href="${esc(order.url)}" target="_blank" rel="noopener" data-cart-wa>${ICON.wa}${esc(STR.sentAgain)}</a>
<button type="button" class="c-btn c-btn--text c-btn--block" data-act="to-bag">${esc(STR.sentNo)}</button>`,
    };
  },
  done() {
    return {
      title: STR.titleDone, step: 3,
      body: `
<div class="s-cart__empty">
  <span class="s-cart__empty-horns">${ICON.horns}</span>
  <p>${esc(STR.doneText)}</p>
  <p class="s-cart__ref"><strong>${esc(STR.doneRef(state.doneRef))}</strong></p>
  <button type="button" class="c-btn c-btn--primary" data-act="close" data-fid="done-close">${esc(STR.doneCta)}</button>
</div>`,
      foot: '',
    };
  },
};

/* ---------------------------------------------------------------- render */
function render({ focus } = {}) {
  if (!el.wrap) return;
  const active = document.activeElement;
  const keep = focus || (active && el.panel.contains(active) && active.dataset ? active.dataset.fid : '');
  const view = (VIEWS[state.step] || VIEWS.bag)();
  el.wrap.dataset.step = state.step;
  el.title.textContent = view.title;
  el.stepLabel.textContent = [STR.stepOf(view.step), view.count].filter(Boolean).join(' · ');
  el.steps.querySelectorAll('[data-step-dot]').forEach((dot, i) => {
    dot.classList.toggle('is-on', i + 1 <= view.step);
    dot.classList.toggle('is-now', i + 1 === view.step);
  });
  el.body.innerHTML = view.body;
  el.foot.innerHTML = view.foot;
  el.foot.hidden = !view.foot.trim();
  el.body.scrollTop = 0;
  if (!state.open) return;
  let target = keep ? el.panel.querySelector(`[data-fid="${window.CSS && CSS.escape ? CSS.escape(keep) : keep}"]`) : null;
  if (target && target.disabled) target = target.parentElement.querySelector('button:not([disabled])');
  if (target) target.focus({ preventScroll: true });
  else if (active && !document.body.contains(active)) el.panel.focus({ preventScroll: true });
}

function say(text) {
  if (!el.live) return;
  el.live.textContent = '';
  window.setTimeout(() => { el.live.textContent = text; }, 40);
}

function go(step, focus) {
  state.step = step;
  render({ focus });
  if (!focus) el.panel.focus({ preventScroll: true });
}

/* ---------------------------------------------------------------- open / close */
function focusables() {
  return Array.from(el.panel.querySelectorAll('a[href], button:not([disabled]), input, textarea, select, [tabindex="0"]'))
    .filter((n) => n.tabIndex !== -1 && n.getClientRects().length);
}

export function open(step) {
  if (!el.wrap) return;
  if (step) state.step = step;
  else if (state.step === 'done') state.step = 'bag';
  if (state.step !== 'bag' && state.step !== 'done' && cart.count() === 0) state.step = 'bag';
  if (state.open) { render(); return; }
  state.open = true;
  state.opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.querySelector('[data-cart-toggle]');
  render();
  el.wrap.inert = false;
  el.wrap.classList.add('is-open');
  document.documentElement.classList.add('is-locked', 'is-cart-open');
  state.inerted = Array.from(document.body.children).filter((n) => n !== el.root && !n.inert && !n.matches('script, style, link, .c-cursor, .c-wipe'));
  state.inerted.forEach((n) => { n.inert = true; });
  document.querySelectorAll('[data-cart-toggle]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
  window.setTimeout(() => { if (state.open) el.panel.focus({ preventScroll: true }); }, 30);
}

export function close() {
  if (!state.open) return;
  state.open = false;
  el.wrap.classList.remove('is-open');
  el.wrap.inert = true;
  state.inerted.forEach((n) => { n.inert = false; });
  state.inerted = [];
  const root = document.documentElement;
  root.classList.remove('is-cart-open');
  if (!root.classList.contains('is-menu-open')) root.classList.remove('is-locked');
  document.querySelectorAll('[data-cart-toggle]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  const back = state.opener && document.body.contains(state.opener) ? state.opener : document.querySelector('[data-cart-toggle]');
  if (back && back.focus) back.focus({ preventScroll: true });
  if (state.step === 'done') state.step = 'bag';
}

/* ---------------------------------------------------------------- actions */
function readForm() {
  const form = el.body.querySelector('#tcd-order-form');
  if (!form) return;
  ['name', 'city', 'note'].forEach((k) => { if (form.elements[k]) state.customer[k] = form.elements[k].value; });
}

function submitDetails() {
  readForm();
  const result = validateCustomer(state.customer);
  state.errors = result.errors;
  if (!result.ok) {
    const first = ['name', 'city', 'note'].find((k) => result.errors[k]);
    render({ focus: `field:${first}` });
    say(STR.fixForm);
    return;
  }
  state.customer = result.values;
  // keep one reference while the customer goes back and forth between the steps
  const ref = state.order ? state.order.ref : undefined;
  state.order = createOrder(cart.items(), { ...result.values, ref });
  go('preview', 'send');
}

async function copyMessage() {
  const text = state.order ? state.order.text : '';
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (err) {
    try {
      const pre = el.body.querySelector('[data-cart-message]');
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      ok = document.execCommand('copy');
    } catch (err2) { ok = false; }
  }
  say(ok ? STR.copied : STR.copyFailed);
  const btn = el.foot.querySelector('[data-act="copy"]');
  if (btn && ok) { btn.textContent = STR.copied; window.setTimeout(() => { if (btn.isConnected) btn.textContent = STR.copy; }, 2200); }
}

function onClick(e) {
  const target = e.target.closest('[data-act], [data-cart-close]');
  if (!target || !el.wrap.contains(target)) return;
  if (target.hasAttribute('data-cart-close')) { close(); return; }
  const act = target.dataset.act;
  const row = target.closest('[data-key]');
  const key = row ? row.dataset.key : '';
  const line = key ? cart.lines().find((l) => l.key === key) : null;
  switch (act) {
    case 'close': close(); break;
    case 'inc': if (line) cart.setQty(key, line.qty + 1); break;
    case 'dec': if (line) cart.setQty(key, Math.max(cart.MIN_QTY, line.qty - 1)); break;
    case 'remove':
      if (line) {
        state.removedName = line.product.name;
        cart.remove(key);
      }
      break;
    case 'to-details': state.errors = {}; go('details', 'field:name'); break;
    case 'to-bag': readForm(); go('bag'); break;
    case 'copy': copyMessage(); break;
    case 'send':
      // a real link: the browser opens wa.me in a new tab; we only move the drawer on
      submitOrder(state.order, 'whatsapp');
      window.setTimeout(() => go('sent', 'sent-yes'), 250);
      break;
    case 'sent-yes':
      state.doneRef = state.order ? state.order.ref : '';
      state.order = null;
      state.customer.note = '';
      state.step = 'done';
      cart.clear();
      say(STR.cleared);
      el.panel.focus({ preventScroll: true });
      break;
    default: break;
  }
}

function onCart(e) {
  const d = e.detail || {};
  const lines = cart.lines();
  const line = d.key ? lines.find((l) => l.key === d.key) : null;
  // the bag changed under an open order: the message would be wrong, so start again from the bag
  if (d.reason !== 'clear' && (state.step === 'preview' || state.step === 'sent')) { state.order = null; state.step = 'bag'; }
  if (state.step !== 'bag' && state.step !== 'done' && !lines.length) state.step = 'bag';
  if (d.reason === 'add') {
    state.step = 'bag';
    state.order = null;
    open('bag');
    if (line) say(STR.added(line.product.name));
    window.requestAnimationFrame(() => {
      const row = line ? el.body.querySelector(`[data-key="${CSS.escape(line.key)}"]`) : null;
      if (row) { row.classList.add('is-new'); row.scrollIntoView({ block: 'nearest' }); }
    });
    return;
  }
  if (d.reason === 'qty') state.order = null;
  render();
  if (d.reason === 'qty' && line) say(STR.qtyNow(line.product.name, line.qty, formatPrice(cart.total(), line.product.currency)));
  if (d.reason === 'remove' && state.removedName) {
    say(STR.removed(state.removedName));
    state.removedName = '';
    if (state.open && !el.panel.contains(document.activeElement)) {
      const next = el.body.querySelector('.s-line__remove, a.c-btn');
      (next || el.panel).focus({ preventScroll: true });
    }
  }
}

function onKey(e) {
  if (!state.open) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key !== 'Tab') return;
  const list = focusables();
  if (!list.length) { e.preventDefault(); el.panel.focus(); return; }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (!el.panel.contains(active) || active === el.panel) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

/* ---------------------------------------------------------------- mount */
function mount() {
  let root = document.querySelector('[data-cart-root]');
  if (!root) {
    root = document.createElement('div');
    root.setAttribute('data-cart-root', '');
    root.setAttribute('data-lenis-prevent', '');
    document.body.appendChild(root);
  }
  if (root.querySelector('.s-cart')) return;
  root.innerHTML = `
<div class="s-cart" data-step="bag" inert>
  <div class="s-cart__backdrop" data-cart-close></div>
  <aside class="s-cart__panel" role="dialog" aria-modal="true" aria-labelledby="tcd-cart-title" tabindex="-1" data-lenis-prevent>
    <header class="s-cart__head">
      <div class="s-cart__heading">
        <p class="s-cart__step" data-cart-step></p>
        <h2 class="s-cart__title" id="tcd-cart-title"></h2>
      </div>
      <button type="button" class="s-cart__close" data-cart-close aria-label="${esc(STR.close)}" data-i18n-attr="aria-label:cart.close">${ICON.close}</button>
    </header>
    <ol class="s-cart__steps" aria-hidden="true" data-cart-steps>
      ${STR.steps.map((key) => `<li class="s-cart__dot" data-step-dot><span data-i18n="${key}">${esc(t(key))}</span></li>`).join('')}
    </ol>
    <div class="s-cart__body" data-cart-body data-lenis-prevent></div>
    <footer class="s-cart__foot" data-cart-foot></footer>
    <p class="u-sr" role="status" aria-live="polite" aria-atomic="true" data-cart-live></p>
  </aside>
</div>`;
  el.root = root;
  el.wrap = root.querySelector('.s-cart');
  el.panel = root.querySelector('.s-cart__panel');
  el.title = root.querySelector('.s-cart__title');
  el.stepLabel = root.querySelector('[data-cart-step]');
  el.steps = root.querySelector('[data-cart-steps]');
  el.body = root.querySelector('[data-cart-body]');
  el.foot = root.querySelector('[data-cart-foot]');
  el.live = root.querySelector('[data-cart-live]');

  render();
  el.wrap.addEventListener('click', onClick);
  el.wrap.addEventListener('submit', (e) => { if (e.target.id === 'tcd-order-form') { e.preventDefault(); submitDetails(); } });
  el.wrap.addEventListener('input', (e) => {
    const field = e.target.closest('.c-field.is-invalid');
    if (!field || !e.target.value.trim()) return;
    field.classList.remove('is-invalid');
    e.target.removeAttribute('aria-invalid');
    const slot = field.querySelector('.c-field__error');
    if (slot) slot.textContent = '';
    delete state.errors[e.target.name];
  });
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest && e.target.closest('[data-cart-toggle]');
    if (!toggle) return;
    e.preventDefault();
    if (state.open) close(); else open();
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('tcd:cart', onCart);
  // language change: the frame is marked with data-i18n, the current step is drawn again
  document.addEventListener('tcd:lang', () => {
    readForm();
    apply(el.root);
    // the previewed order text is English in every language, only its "Site language" line changes
    if (state.order && (state.step === 'preview' || state.step === 'sent')) {
      state.order = createOrder(cart.items(), { ...state.customer, ref: state.order.ref });
    }
    if (state.errors && Object.keys(state.errors).length) state.errors = validateCustomer(state.customer).errors;
    render();
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) { close(); render(); } });
  document.querySelectorAll('[data-cart-toggle]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  // make sure the header count matches the cleaned cart (unknown or sold items are dropped on load)
  document.dispatchEvent(new CustomEvent('tcd:cart', { detail: { count: cart.count(), total: cart.total(), reason: 'init' } }));
}

mount();
