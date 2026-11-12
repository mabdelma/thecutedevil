// The Cute Devil: order status / confirmation page. Owner: web. Contract: web/COMMERCE_ARCH.md section f.
// Reached from the payment provider's success URL (?id=…&token=…&paid=1), from e-mail links
// (?id=…&token=…) and, without parameters, for the last order made in this browser.
// The bag is cleared HERE, and only once the order shows as confirmed.
import { ready } from '../app.js';
import { scan } from '../motion.js';
import { getById, formatPrice, artFor, optionLabel, valueLabel, personalisationLabel } from '../products.js';
import { t, tn, has, getLang } from '../i18n.js';
import * as cart from '../cart.js';
import * as commerce from '../commerce.js';
import { whatsappUrl } from '../checkout.js';

const root = document.documentElement;
// If a strict Content-Security-Policy ever blocks the inline boot script of the page, do its job here.
if (root.classList.contains('no-js')) {
  root.classList.remove('no-js'); root.classList.add('js');
  try { const th = localStorage.getItem('tcd:theme'); if (th) root.setAttribute('data-theme', th); } catch (err) { /* private mode */ }
}

const POLL_MS = 2500;      // the order view is rate-limited to 30 per minute
const POLL_TRIES = 16;     // about 40 seconds after coming back from the payment page
const CONFIRMED = ['confirmed', 'processing', 'partially_shipped', 'shipped', 'delivered'];
// Written to the seller on WhatsApp, so it stays in English in every language.
const HELP_TEXT = (id) => (id ? `Hi The Cute Devil! I have a question about my order ${id}.` : 'Hi The Cute Devil! I have a question about an order.');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  arrow: '<svg class="c-btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16z"/><path d="M3.5 8L12 12.5 20.5 8M12 12.5v8"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 20.5l1.3-4.7a8.5 8.5 0 1 1 3.4 3.4z"/><path d="M9.2 8.2c-.3 3.4 3.2 6.9 6.6 6.6l.7-1.8-2-1.1-.9.9c-1-.5-1.9-1.4-2.4-2.4l.9-.9-1.1-2z"/></svg>',
  horns: '<svg viewBox="0 0 64 22" aria-hidden="true" focusable="false"><path d="M6 22C2 12 4 4 10 0c0 9 4 16 12 22z"/><path d="M58 22c4-10 2-18-4-22 0 9-4 16-12 22z"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 6h9v9M18 6L7 17"/></svg>',
};

const S = { host: null, id: '', token: '', paid: false, fromUrl: false, view: 'loading', order: null, tries: 0, timer: 0, waitedOut: false };

/* ---------------------------------------------------------------- helpers */
const money = (minor) => formatPrice(minor, S.order ? S.order.currency : commerce.getCurrency());
const date = (ms) => {
  if (!Number.isFinite(Number(ms)) || !ms) return '';
  try { return new Intl.DateTimeFormat(`${getLang()}-u-nu-latn`, { dateStyle: 'medium' }).format(new Date(Number(ms))); } catch (err) { return new Date(Number(ms)).toDateString(); }
};
const eta = (min, max) => {
  const a = Number(min); const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return '';
  return a === b || a <= 0 ? tn('checkout.eta.days', b) : t('checkout.eta.range', { min: a, max: b });
};
const label = (prefix, code) => (has(`${prefix}.${code}`) ? t(`${prefix}.${code}`) : String(code || '').replace(/_/g, ' '));
const safeUrl = (value) => {
  try { const u = new URL(String(value || '')); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (err) { return ''; }
};
/** The server's key of an order item: id + options in the product's own order. */
function itemKey(item) {
  return cart.lineKey(item.id, item.options || {}, item.personalisation || null);
}
function itemMeta(item) {
  const product = getById(item.id);
  const options = item.options || {};
  const names = product ? (product.options || []).map((o) => o.name) : Object.keys(options);
  return names.filter((n) => options[n] !== undefined).map((n) => `${optionLabel(n)} ${valueLabel(options[n])}`)
    .concat(Object.keys(item.personalisation || {}).map((k) => `${personalisationLabel(k)}: \u2068${item.personalisation[k]}\u2069`)).join(' · ');
}
const helpUrl = () => whatsappUrl(HELP_TEXT(S.order ? S.order.id : S.id));

/* ---------------------------------------------------------------- templates */
function stateHTML({ eyebrow = '', title, text, actions = '', busy = false, ref = '' }) {
  return `
<div class="k-state">
  ${busy ? '<span class="k-spin k-spin--lg" aria-hidden="true"></span>' : `<span class="k-state__horns" aria-hidden="true">${ICON.horns}</span>`}
  ${eyebrow ? `<p class="c-eyebrow">${esc(eyebrow)}</p>` : ''}
  <h1 class="u-h2 k-state__title" id="order-title" tabindex="-1">${esc(title)}</h1>
  <p class="c-lede k-state__text"${busy ? ' role="status"' : ''}>${esc(text)}</p>
  ${ref ? `<p class="k-state__ref">${esc(t('order.number'))} <strong translate="no">${esc(ref)}</strong></p>` : ''}
  ${actions ? `<div class="u-cluster k-state__cta">${actions}</div>` : ''}
</div>`;
}
const btn = (href, key, kind = 'primary', arrow = true) => `<a class="c-btn c-btn--${kind}${kind === 'primary' ? ' c-btn--lg' : ''}" href="${href}"><span class="c-btn__label">${esc(t(key))}${arrow && kind === 'primary' ? ICON.arrow : ''}</span></a>`;
const helpBtn = () => `<a class="c-btn c-btn--text" href="${esc(helpUrl())}" target="_blank" rel="noopener">${ICON.wa}<span>${esc(t('order.help.cta'))}</span></a>`;

const STEPS = ['paid', 'production', 'shipped', 'delivered'];
const STAGE = { pending: 1, submitting: 1, submitted: 1, manual: 1, in_production: 1, shipped: 2, delivered: 3 };

function timelineHTML(stage, status, cod, dates = {}) {
  const items = STEPS.map((step, i) => {
    const done = i < stage || stage === 3;
    const now = i === stage && stage !== 3;
    const key = step === 'paid' && cod ? 'order.step.confirmed' : `order.step.${step}`;
    let sub = '';
    if (now && i === 1) sub = label('fulfilmentStatus', status);
    else if (step === 'shipped' && dates.shipped && (done || now)) sub = dates.shipped;
    else if (step === 'delivered' && dates.delivered && done) sub = dates.delivered;
    else if (now) sub = t('order.step.now');
    return `
<li class="k-track__step${done ? ' is-done' : ''}${now ? ' is-now' : ''}"${now ? ' aria-current="step"' : ''}>
  <span class="k-track__dot" aria-hidden="true">${done ? ICON.check : ''}</span>
  <span class="k-track__text"><b>${esc(t(key))}</b>${sub ? `<small>${esc(sub)}</small>` : ''}<span class="u-sr">${esc(done ? t('order.step.srDone') : now ? t('order.step.srNow') : t('order.step.srNext'))}</span></span>
</li>`;
  }).join('');
  return `<ol class="k-track" style="--stage:${Math.max(0, Math.min(3, stage))}">${items}</ol>`;
}

function parcelHTML(f, n, total, order, byKey) {
  const cod = order.paymentMethod === 'cod';
  const cancelled = f.status === 'cancelled';
  const stage = STAGE[f.status] === undefined ? 1 : STAGE[f.status];
  const ships = Array.isArray(f.shipments) ? f.shipments : [];
  const shippedAt = ships.map((s) => s.shippedAt).filter(Boolean).sort()[0];
  const deliveredAt = ships.map((s) => s.deliveredAt).filter(Boolean).sort().pop();
  const days = stage < 2 && !cancelled ? eta(f.etaMinDays, f.etaMaxDays) : '';
  const mine = (f.itemKeys || []).map((k) => byKey.get(k)).filter(Boolean);
  const tracking = ships.map((s) => {
    const url = safeUrl(s.trackingUrl);
    const who = [s.carrier, s.trackingNumber].filter(Boolean).join(' · ');
    if (!url && !who) return '';
    return `
<div class="k-tracking">
  <p class="k-tracking__k">${esc(t('order.tracking.label'))}${who ? ` <span translate="no" dir="ltr">${esc(who)}</span>` : ''}</p>
  ${url ? `<a class="c-btn c-btn--ghost c-btn--sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t('order.tracking.cta'))}${ICON.out}</a>` : ''}
</div>`;
  }).join('');
  return `
<article class="k-parcelcard${cancelled ? ' is-cancelled' : ''}">
  <header class="k-parcelcard__head">
    <h3 class="k-parcelcard__title">${ICON.box}<span>${esc(total > 1 ? t('checkout.parcel.nOf', { n, total }) : t('order.parcel.single'))}</span></h3>
    <span class="c-badge${stage >= 2 && !cancelled ? ' c-badge--accent' : ''}">${esc(label('fulfilmentStatus', f.status))}</span>
  </header>
  ${mine.length ? `<ul class="k-parcelcard__items">${mine.map((it, i) => `<li><span class="k-mini" aria-hidden="true">${artFor(getById(it.id), `p${n}i${i}`)}</span><span><span translate="no">${esc(it.name)}</span> <span class="u-muted" translate="no">× ${it.qty}</span></span></li>`).join('')}</ul>` : ''}
  ${cancelled ? `<p class="u-muted">${esc(t('order.parcel.cancelled'))}</p>` : timelineHTML(stage, f.status, cod, { shipped: date(shippedAt), delivered: date(deliveredAt) })}
  ${days ? `<p class="k-parcelcard__eta">${esc(t('checkout.parcel.arrives', { eta: days }))}</p>` : ''}
  ${tracking}
</article>`;
}

function orderHTML(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  // fulfilments name their items by line key; the shorter `id|variant` form is accepted too
  const byKey = new Map();
  items.forEach((it) => { const short = cart.lineKey(it.id, it.options || {}); if (!byKey.has(short)) byKey.set(short, it); });
  items.forEach((it) => byKey.set(itemKey(it), it));
  const cod = order.paymentMethod === 'cod';
  let parcels = Array.isArray(order.fulfilments) ? order.fulfilments.slice().sort((a, b) => (a.index || 0) - (b.index || 0)) : [];
  if (!parcels.length) {
    // not routed yet (the order was confirmed a moment ago): one parcel that follows the order status
    const status = { shipped: 'shipped', delivered: 'delivered', partially_shipped: 'shipped' }[order.status] || 'pending';
    parcels = [{ index: 0, status, itemKeys: items.map(itemKey), shipments: [] }];
  }
  const live = parcels.filter((f) => f.status !== 'cancelled').length;
  const tax = order.tax || {};
  const ship = order.shipTo || {};
  const where = [ship.city, ship.country ? commerce.countryName(ship.country, getLang()) : ''].filter(Boolean).join(', ');
  const heroKey = has(`order.hero.${order.status}`) ? `order.hero.${order.status}` : 'order.hero.confirmed';
  const lede = cod && ['confirmed', 'processing'].includes(order.status) ? t('order.lede.cod') : (has(`order.lede.${order.status}`) ? t(`order.lede.${order.status}`) : t('order.lede.confirmed'));
  return `
<header class="k-orderhead">
  <p class="c-eyebrow">${esc(t('order.number'))} <span translate="no">${esc(order.id)}</span></p>
  <h1 class="k-head__title" id="order-title" tabindex="-1">${t(heroKey)}</h1>
  <p class="c-lede">${esc(lede)}</p>
  <p class="k-orderhead__meta"><span class="c-badge c-badge--contrast">${esc(label('orderStatus', order.status))}</span>${order.createdAt ? `<span>${esc(t('order.placed', { date: date(order.createdAt) }))}</span>` : ''}</p>
</header>
<div class="k-layout k-layout--order">
  <div class="k-main">
    <section aria-labelledby="order-parcels">
      <h2 class="k-step__title" id="order-parcels">${esc(live > 1 ? tn('order.parcels.title', live) : t('order.parcels.titleOne'))}</h2>
      ${live > 1 ? `<p class="k-split">${ICON.box}<span>${esc(t('order.parcels.split'))}</span></p>` : ''}
      <div class="k-parcelcards">${parcels.map((f, i) => parcelHTML(f, i + 1, parcels.length, order, byKey)).join('')}</div>
    </section>
    <section class="k-help" aria-labelledby="order-help">
      <div>
        <h2 class="u-h3" id="order-help">${esc(t('order.help.title'))}</h2>
        <p class="u-muted">${esc(t('order.help.text'))}</p>
      </div>
      <a class="c-btn c-btn--contrast" href="${esc(helpUrl())}" target="_blank" rel="noopener">${ICON.wa}<span>${esc(t('order.help.cta'))}</span></a>
    </section>
  </div>
  <aside class="k-side" aria-labelledby="order-summary">
    <div class="k-summary" data-devil style="--devil-rest: 8; --devil-max: 16; --devil-horn: 4rem">
      <header class="k-summary__head"><h2 class="k-summary__title" id="order-summary">${esc(t('order.summary.title'))}</h2></header>
      <ul class="k-lines">${items.map((it, i) => {
    const meta = itemMeta(it);
    return `
<li class="k-line">
  <span class="k-line__thumb" aria-hidden="true">${artFor(getById(it.id), `o${i}`)}<span class="k-line__qty" translate="no">${it.qty}</span></span>
  <div class="k-line__main">
    <p class="k-line__name" translate="no">${esc(it.name)}</p>
    ${meta ? `<p class="k-line__meta">${esc(meta)}</p>` : ''}
    <p class="k-line__meta" translate="no">× ${it.qty}</p>
  </div>
  <span class="k-line__total" translate="no">${esc(money(it.total))}</span>
</li>`;
  }).join('')}</ul>
      <dl class="k-total">
        <div class="k-total__row"><dt>${esc(t('checkout.total.subtotal'))}</dt><dd translate="no">${esc(money(order.subtotal))}</dd></div>
        <div class="k-total__row"><dt>${esc(t('checkout.total.shipping'))}</dt><dd${order.shipping === 0 ? '' : ' translate="no"'}>${esc(order.shipping === 0 ? t('checkout.ship.free') : money(order.shipping))}</dd></div>
        ${!tax.included && tax.amount > 0 ? `<div class="k-total__row"><dt>${esc(t('checkout.total.tax'))}</dt><dd translate="no">${esc(money(tax.amount))}</dd></div>` : ''}
        <div class="k-total__row k-total__row--grand"><dt>${esc(t('checkout.total.total'))}</dt><dd translate="no">${esc(money(order.total))}</dd></div>
      </dl>
      ${tax.included && tax.amount > 0 ? `<p class="k-total__tax">${esc(t('checkout.tax.included', { amount: money(tax.amount) }))}</p>` : ''}
      <dl class="k-facts">
        <div><dt>${esc(t('order.facts.payment'))}</dt><dd>${esc(label('payMethod', order.paymentMethod))} · ${esc(label('order.payment', order.paymentStatus))}</dd></div>
        ${where ? `<div><dt>${esc(t('order.facts.shipTo'))}</dt><dd>${esc(where)}</dd></div>` : ''}
      </dl>
    </div>
    <p class="k-alt"><a class="c-link" href="shop.html">${esc(t('cart.keepLooking'))}</a></p>
  </aside>
</div>`;
}

/* ---------------------------------------------------------------- render */
function render({ focus = false } = {}) {
  const o = S.order;
  const id = (o && o.id) || S.id;
  let html = '';
  let title = t('order.meta.title');
  switch (S.view) {
    case 'loading':
      html = stateHTML({ title: t('order.loading'), text: t('order.loadingText'), busy: true });
      break;
    case 'confirming':
      html = stateHTML({ eyebrow: t('order.confirming.eyebrow'), title: t('order.confirming.title'), text: t('order.confirming.text'), busy: true, ref: id });
      break;
    case 'pending':
      html = S.waitedOut
        ? stateHTML({ eyebrow: t('order.pending.eyebrow'), title: t('order.waiting.title'), text: t('order.waiting.text'), ref: id, actions: `<button type="button" class="c-btn c-btn--primary c-btn--lg" data-order-refresh><span class="c-btn__label">${esc(t('order.waiting.cta'))}</span></button>${helpBtn()}` })
        : stateHTML({ eyebrow: t('order.pending.eyebrow'), title: t('order.pending.title'), text: t('order.pending.text'), ref: id, actions: `${btn('checkout.html', 'order.pending.cta')}${helpBtn()}` });
      break;
    case 'expired':
      html = stateHTML({ eyebrow: label('orderStatus', 'expired'), title: t('order.failed.title'), text: t('order.failed.text'), ref: id, actions: `${btn('checkout.html', 'order.failed.cta')}${helpBtn()}` });
      break;
    case 'cancelled': {
      const refund = o && ['refund_pending', 'refunded', 'partially_refunded'].includes(o.paymentStatus) ? ` ${t(`order.cancelled.${o.paymentStatus === 'refund_pending' ? 'refundPending' : 'refunded'}`)}` : '';
      html = stateHTML({ eyebrow: label('orderStatus', 'cancelled'), title: t('order.cancelled.title'), text: `${t('order.cancelled.text')}${refund}`, ref: id, actions: `${btn('shop.html', 'common.openShop')}${helpBtn()}` });
      break;
    }
    case 'notfound':
      html = stateHTML({ eyebrow: t('order.notFound.eyebrow'), title: t('order.notFound.title'), text: t('order.notFound.text'), actions: `${btn('shop.html', 'common.openShop')}${helpBtn()}` });
      break;
    case 'error':
      html = stateHTML({ title: t('order.error.title'), text: t('order.error.text'), ref: id, actions: `<button type="button" class="c-btn c-btn--primary c-btn--lg" data-order-refresh><span class="c-btn__label">${esc(t('order.waiting.cta'))}</span></button>${helpBtn()}` });
      break;
    default:
      html = orderHTML(o);
      title = t('order.meta.titleId', { id: o.id });
  }
  document.title = title;
  S.host.innerHTML = html;
  S.host.dataset.view = S.view;
  try { scan(S.host); } catch (err) { /* decoration only */ }
  if (focus) { const h = S.host.querySelector('#order-title'); if (h) h.focus({ preventScroll: true }); }
}

/* ---------------------------------------------------------------- data */
function clearBagOnce(order) {
  const last = commerce.lastOrder();
  if (!last || last.id !== order.id || last.cleared) return;
  cart.clear();
  commerce.rememberOrder({ id: last.id, token: last.token, cleared: true });
  try { sessionStorage.removeItem('tcd:checkout'); sessionStorage.removeItem('tcd:checkoutId'); } catch (err) { /* private mode */ }
}

function show(order) {
  S.order = order;
  const before = S.view;
  if (CONFIRMED.includes(order.status)) { S.view = 'ok'; clearBagOnce(order); }
  else if (order.status === 'cancelled') S.view = 'cancelled';
  else if (order.status === 'expired') S.view = 'expired';
  else if (S.paid && !S.waitedOut) S.view = 'confirming';
  else S.view = 'pending';
  // while the payment is being confirmed the same screen stays up: do not redraw it on every poll
  if (!(before === 'confirming' && S.view === 'confirming')) render({ focus: before !== 'loading' && before !== S.view });
  if (S.view === 'confirming') poll();
}

function poll() {
  window.clearTimeout(S.timer);
  if (S.tries >= POLL_TRIES) { S.waitedOut = true; S.view = 'pending'; render({ focus: true }); return; }
  S.tries += 1;
  S.timer = window.setTimeout(() => load({ quiet: true }), POLL_MS);
}

async function load({ quiet = false } = {}) {
  if (!S.id || !S.token) { S.view = 'notfound'; render(); return; }
  if (!quiet) { S.view = 'loading'; render(); }
  try {
    const order = await commerce.getOrder(S.id, S.token);
    if (!order || typeof order.id !== 'string' || typeof order.status !== 'string') throw new commerce.ApiError('BAD_RESPONSE', 0);
    show(order);
  } catch (err) {
    if (quiet && S.view === 'confirming' && (!err || err.code !== 'NOT_FOUND')) { poll(); return; } // a hiccup while waiting: try again
    S.view = err && (err.code === 'NOT_FOUND' || err.status === 404) ? 'notfound' : 'error';
    render({ focus: quiet });
  }
}

function init() {
  S.host = document.querySelector('[data-order]');
  if (!S.host) return;
  const params = new URLSearchParams(window.location.search);
  S.id = String(params.get('id') || '').trim().slice(0, 40);
  S.token = String(params.get('token') || '').trim().slice(0, 128);
  S.paid = params.get('paid') === '1';
  S.fromUrl = Boolean(S.id && S.token);
  if (!S.fromUrl) {
    const last = commerce.lastOrder();
    if (last) { S.id = last.id; S.token = last.token; }
  }
  S.host.addEventListener('click', (e) => {
    if (!e.target.closest('[data-order-refresh]')) return;
    S.tries = 0; S.waitedOut = false;
    load();
  });
  document.addEventListener('tcd:lang', () => render());
  window.addEventListener('pagehide', () => window.clearTimeout(S.timer));
  load();
}

if (document.body.dataset.page === 'order') {
  ready.then(init).catch((err) => { console.warn('[tcd] order', err); init(); });
}
