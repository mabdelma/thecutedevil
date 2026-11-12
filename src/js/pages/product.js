// The Cute Devil: product page. Reads ?id=, renders the stage, the buy form and related pieces. Owner: shop.
import { ready } from '../app.js';
import { scan, refresh } from '../motion.js';
import '../../css/checkout.css';
import { getById, byNiche, priceOf, formatPrice, artFor, nicheLabel, optionLabel, valueLabel, statusOf, availableHere, personalisationOf, validatePersonalisation, personalisationLabel } from '../products.js';
import { t, strings, has, getLang } from '../i18n.js';
import * as cart from '../cart.js';
import * as commerce from '../commerce.js';
import { whatsappUrl } from '../checkout.js';
import { cardHTML, bindQuickAdd } from './shop.js';

const STR = strings({
  backTo: (niche) => t('product.backTo', { niche: nicheLabel(niche) }),
  sample: 'common.sample',
  priceNote: 'product.priceNote',
  soon: 'common.soon',
  sold: 'common.sold',
  hint: 'product.hint',
  pick: (name) => t('product.pick', { option: optionLabel(name) }),
  qty: 'product.qty',
  less: 'product.less',
  more: 'product.more',
  add: 'product.add',
  addBar: 'product.add',
  soonBtn: 'product.soonBtn',
  soldBtn: 'common.sold',
  soonReason: 'product.soonReason',
  soldReason: 'product.soldReason',
  ask: 'product.ask',
  honest: () => t(commerce.isOn() ? 'product.on.honest' : 'common.honest'),
  detailsTitle: 'product.detailsTitle',
  howTitle: 'product.howTitle',
  how: () => [1, 2, 3].map((i) => (commerce.isOn() ? [t(`product.on.how${i}.k`), t(`product.on.how${i}.v`)] : [t(`product.how${i}.k`), t(`product.how${i}.v`)])),
  // commerce on
  priceNoteOn: 'product.on.priceNote',
  deliverTo: 'cart.deliverTo',
  notHereBtn: (country) => t('product.on.notHereBtn', { country }),
  notHereReason: 'product.on.notHereReason',
  persoTitle: 'product.perso.title',
  persoOptional: 'cart.field.optional',
  persoHint: (n) => t('product.perso.hint', { n }),
  persoExtra: (price) => t('product.perso.extra', { price }),
  persoNotice: 'product.perso.notice',
  persoErr: (kind, label, n) => t(`product.perso.err.${kind}`, { label, n }),
  relatedEyebrow: (niche) => t('product.relatedEyebrow', { niche: nicheLabel(niche) }),
  relatedTitle: 'product.relatedTitle',
  lostEyebrow: 'product.lost.eyebrow',
  lostTitle: 'product.lost.title',
  lostText: 'product.lost.text',
  lostCta: 'common.openShop',
  lostHome: 'product.lost.home',
  pageTitle: (name) => t('product.meta.titleName', { name }),
  lostPageTitle: 'product.lost.pageTitle',
});
// Written to the seller on WhatsApp, so it stays in English in every language.
const ASK_TEXT = (name) => `Hi The Cute Devil! Please tell me when "${name}" is available.`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  arrow: '<svg class="c-btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 12h12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 12h12M12 6v12"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.3"/></svg>',
};

/* ---------------------------------------------------------------- templates */
/** The value an option group starts on: its own `default`, else the value whose price is the one shown, else the first. */
function defaultValue(p, opt) {
  if (opt.default && opt.values.includes(opt.default)) return opt.default;
  if (opt.prices) {
    const match = opt.values.find((v) => priceOf(p, { [opt.name]: v }) === p.price);
    if (match) return match;
  }
  return opt.values[0];
}

/** The delivery-country select (commerce on): prices and availability follow it. */
function marketHTML() {
  if (!commerce.isOn()) return '';
  const now = commerce.getCountry();
  const options = commerce.countryOptions(getLang()).map((c) => `<option value="${c.code}"${c.code === now ? ' selected' : ''}>${esc(c.name)} · ${c.currency}</option>`).join('');
  return `
<div class="k-market k-market--inline">
  <label class="k-market__k" for="product-country">${esc(STR.deliverTo)}</label>
  <span class="c-langpick k-market__pick">${ICON.pin}<select class="c-select c-langpick__select" id="product-country" data-country-select>${options}</select></span>
</div>`;
}

/** Text fields a product lets the customer personalise (name on the chest, …). */
function persoHTML(p) {
  const fields = personalisationOf(p);
  if (!fields.length) return '';
  const currency = commerce.getCurrency();
  const rows = fields.map((f) => {
    const id = `perso-${esc(f.key)}`;
    const extra = f.surcharge && Number.isInteger(f.surcharge[currency]) && f.surcharge[currency] > 0 ? STR.persoExtra(formatPrice(f.surcharge[currency], currency)) : '';
    const max = Number.isInteger(f.maxLength) ? f.maxLength : 40;
    const hintKey = `personalisation.${f.key}.hint`;
    return `
<div class="c-field k-perso__field" data-perso="${esc(f.key)}">
  <label class="c-field__label" for="${id}">${esc(personalisationLabel(f.key))}${f.required ? '' : ` <small>${esc(STR.persoOptional)}</small>`}${extra ? ` <small class="k-perso__extra" translate="no">${esc(extra)}</small>` : ''}</label>
  <div class="k-perso__control">
    <input class="c-input" id="${id}" name="perso:${esc(f.key)}" type="text" maxlength="${max}" autocomplete="off" autocapitalize="characters" spellcheck="false" dir="auto" aria-describedby="${id}-hint ${id}-error"${f.required ? ' required aria-required="true"' : ''}>
    <span class="k-perso__count" data-perso-count aria-hidden="true" translate="no">0/${max}</span>
  </div>
  <p class="c-field__hint" id="${id}-hint">${esc(has(hintKey) ? t(hintKey) : STR.persoHint(max))}</p>
  <p class="c-field__error" id="${id}-error" role="alert"></p>
</div>`;
  }).join('');
  return `
<fieldset class="s-opt k-perso">
  <legend class="s-opt__legend">${esc(STR.persoTitle)}</legend>
  ${rows}
  <p class="k-perso__notice">${esc(STR.persoNotice)}</p>
</fieldset>`;
}

function optionHTML(p, opt) {
  const preset = defaultValue(p, opt);
  // show a price under each pill only when the values really cost different amounts
  const priced = new Set(opt.values.map((v) => priceOf(p, { [opt.name]: v }))).size > 1;
  const pills = opt.values.map((value, i) => {
    const sub = priced ? `<span class="s-pill__sub" translate="no">${esc(formatPrice(priceOf(p, { [opt.name]: value }), p.currency))}</span>` : '';
    return `
<label class="s-pill">
  <input class="s-pill__input" type="radio" name="${esc(opt.name)}" value="${esc(value)}" id="opt-${esc(opt.name)}-${i}"${value === preset ? ' checked' : ''}>
  <span class="s-pill__face"><span>${esc(valueLabel(value))}</span>${sub}</span>
</label>`;
  }).join('');
  return `
<fieldset class="s-opt" data-option="${esc(opt.name)}" aria-describedby="opt-${esc(opt.name)}-error">
  <legend class="s-opt__legend">${esc(optionLabel(opt.name))} <span class="s-opt__chosen" data-chosen>${esc(valueLabel(preset))}</span></legend>
  <div class="s-opt__pills">${pills}</div>
  <p class="c-field__error" id="opt-${esc(opt.name)}-error" role="alert"></p>
</fieldset>`;
}

function buyHTML(p) {
  const status = statusOf(p);
  if (status === 'live' && !availableHere(p)) {
    return `
<div class="s-buy" data-buy>
  ${marketHTML()}
  <button type="button" class="c-btn c-btn--primary c-btn--lg c-btn--block" disabled>${esc(STR.notHereBtn(commerce.countryName(commerce.getCountry(), getLang())))}</button>
  <p class="s-buy__reason">${esc(STR.notHereReason)} <a class="c-link" href="${esc(whatsappUrl(ASK_TEXT(p.name)))}" target="_blank" rel="noopener">${esc(STR.ask)}</a></p>
</div>`;
  }
  if (status !== 'live') {
    const soon = status === 'soon';
    return `
<div class="s-buy" data-buy>
  <button type="button" class="c-btn c-btn--primary c-btn--lg c-btn--block" disabled>${esc(soon ? STR.soonBtn : STR.soldBtn)}</button>
  <p class="s-buy__reason">${esc(soon ? STR.soonReason : STR.soldReason)} <a class="c-link" href="${esc(whatsappUrl(ASK_TEXT(p.name)))}" target="_blank" rel="noopener">${esc(STR.ask)}</a></p>
</div>`;
  }
  return `
<form class="s-buy" data-buy novalidate>
  ${(p.options || []).map((opt) => optionHTML(p, opt)).join('')}
  ${persoHTML(p)}
  <div class="s-buy__row">
    <div class="s-buy__qty">
      <span class="s-buy__qty-label" id="qty-label">${esc(STR.qty)}</span>
      <div class="s-qty" role="group" aria-labelledby="qty-label">
        <button type="button" class="s-qty__btn" data-qty="-1" aria-label="${esc(STR.less)}" disabled>${ICON.minus}</button>
        <span class="s-qty__value" data-qty-value aria-live="polite" aria-atomic="true">1</span>
        <button type="button" class="s-qty__btn" data-qty="1" aria-label="${esc(STR.more)}">${ICON.plus}</button>
      </div>
    </div>
    <button type="submit" class="c-btn c-btn--primary c-btn--lg s-buy__add" data-add data-magnetic="0.25" data-devil><span class="c-btn__label">${esc(STR.add)}${ICON.arrow}</span></button>
  </div>
  ${marketHTML()}
  <p class="s-buy__honest">${esc(STR.honest())}</p>
</form>`;
}

function pageHTML(p) {
  const shown = statusOf(p);
  const status = shown === 'soon' ? `<span class="c-badge c-badge--soon">${esc(STR.soon)}</span>`
    : shown === 'sold' ? `<span class="c-badge c-badge--sold">${esc(STR.sold)}</span>` : '';
  const buyable = shown === 'live' && availableHere(p);
  const related = byNiche(p.niche).filter((x) => x.id !== p.id).slice(0, 3);
  return `
<section class="s-product" aria-labelledby="product-name">
  <div class="c-container c-container--wide">
    <a class="s-crumb" href="shop.html?niche=${p.niche}">${ICON.back}${esc(STR.backTo(p.niche))}</a>
    <div class="s-product__grid">
      <div class="s-product__media" data-reveal="scale">
        <div class="s-stage" data-stage data-devil data-niche="${p.niche}">
          <div class="s-stage__clip" aria-hidden="true">
            <div class="s-stage__glow"></div>
            <div class="s-stage__ring"></div>
            <div class="s-stage__word">${esc(nicheLabel(p.niche))}</div>
          </div>
          <div class="s-stage__tilt" data-stage-tilt><div class="s-stage__float">${artFor(p)}<span class="k-preview" data-perso-preview data-art="${esc(p.art)}" aria-hidden="true" translate="no" dir="auto" hidden></span></div></div>
          <div class="s-stage__glare" aria-hidden="true"></div>
          ${status ? `<div class="s-stage__tags">${status}</div>` : ''}
          <span class="s-stage__hint" aria-hidden="true">${esc(STR.hint)}</span>
        </div>
      </div>
      <div class="s-product__info">
        <div class="s-product__top">
          <p class="c-eyebrow" data-reveal="fade">${esc(nicheLabel(p.niche))} · ${esc(p.tagline)}</p>
          <h1 class="s-product__name" id="product-name" data-split="words" translate="no">${esc(p.name)}</h1>
          <p class="c-lede s-product__pitch" data-reveal="up" data-delay="0.2">${esc(p.pitch)}</p>
        </div>
        <div class="s-product__price" data-reveal="up" data-delay="0.25">
          <span class="s-price__num" data-price translate="no">${esc(formatPrice(p.price, p.currency))}</span>
          ${p.sample ? `<span class="c-badge c-badge--sample">${esc(STR.sample)}</span>` : ''}
          ${status}
          ${p.sample ? `<p class="s-product__price-note">${esc(STR.priceNote)}</p>` : `<p class="s-product__price-note">${esc(STR.priceNoteOn)}</p>`}
        </div>
        <div data-reveal="up" data-delay="0.3">${buyHTML(p)}</div>
        <div class="s-product__desc" data-reveal="up">
          <h2 class="u-h3">${esc(STR.detailsTitle)}</h2>
          <p>${esc(p.description)}</p>
        </div>
        <aside class="s-how" aria-labelledby="how-title" data-reveal="up">
          <h2 class="s-how__title" id="how-title">${esc(STR.howTitle)}</h2>
          <ol class="s-how__list">${STR.how().map(([k, v]) => `<li><span><strong>${esc(k)}</strong> ${esc(v)}</span></li>`).join('')}</ol>
        </aside>
      </div>
    </div>
  </div>
</section>
${related.length ? `
<section class="c-section c-section--tight s-related" aria-labelledby="related-title">
  <div class="c-container c-container--wide">
    <header class="c-section__head">
      <p class="c-eyebrow" data-reveal="fade">${esc(STR.relatedEyebrow(p.niche))}</p>
      <h2 id="related-title" data-split="words">${esc(STR.relatedTitle)}</h2>
    </header>
    <div class="c-grid c-grid--products s-related__grid" data-related data-stagger="0.08">${related.map((x) => cardHTML(x, { scope: 'rel' })).join('')}</div>
  </div>
</section>` : ''}
${buyable ? `
<div class="s-bar" data-bar>
  <div class="s-bar__text">
    <span class="s-bar__name" translate="no">${esc(p.name)}</span>
    <span class="s-bar__price"><span data-price translate="no">${esc(formatPrice(p.price, p.currency))}</span>${p.sample ? `<span class="c-badge c-badge--sample">${esc(STR.sample)}</span>` : ''}</span>
  </div>
  <button type="button" class="c-btn c-btn--primary" data-bar-add>${esc(STR.addBar)}</button>
</div>` : ''}`;
}

function lostHTML() {
  return `
<section class="s-lost" aria-labelledby="lost-title">
  <div class="c-container c-container--narrow s-lost__inner">
    <div class="s-lost__art" aria-hidden="true">${artFor(null)}</div>
    <p class="c-eyebrow">${esc(STR.lostEyebrow)}</p>
    <h1 id="lost-title">${STR.lostTitle}</h1>
    <p class="c-lede">${esc(STR.lostText)}</p>
    <div class="u-cluster" style="justify-content:center">
      <a class="c-btn c-btn--primary c-btn--lg" href="shop.html" data-magnetic="0.25" data-devil><span class="c-btn__label">${esc(STR.lostCta)}${ICON.arrow}</span></a>
      <a class="c-btn c-btn--text" href="index.html">${esc(STR.lostHome)}</a>
    </div>
  </div>
</section>`;
}

/* ---------------------------------------------------------------- behaviour */
function bindStage(host, { gsap, reduced, fine }) {
  const stage = host.querySelector('[data-stage]');
  const tilt = host.querySelector('[data-stage-tilt]');
  if (!stage || !tilt || !gsap || reduced || !fine) return;
  const MAX = 14;
  const rx = gsap.quickTo(tilt, 'rotationX', { duration: 0.7, ease: 'power3.out' });
  const ry = gsap.quickTo(tilt, 'rotationY', { duration: 0.7, ease: 'power3.out' });
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const r = stage.getBoundingClientRect();
    const px = Math.max(-0.5, Math.min(0.5, (e.clientX - r.left) / r.width - 0.5));
    const py = Math.max(-0.5, Math.min(0.5, (e.clientY - r.top) / r.height - 0.5));
    ry(px * MAX * 2);
    rx(-py * MAX * 2);
    stage.style.setProperty('--px', px.toFixed(3));
    stage.style.setProperty('--py', py.toFixed(3));
    stage.style.setProperty('--glare', '1');
  });
  stage.addEventListener('pointerleave', () => {
    rx(0); ry(0);
    stage.style.setProperty('--px', '0');
    stage.style.setProperty('--py', '0');
    stage.style.setProperty('--glare', '0');
  });
}

function bindBuy(host, p, keep = null) {
  const form = host.querySelector('form[data-buy]');
  if (!form) return null;
  const chosen = {};
  let qty = 1;
  let io = null;
  const qtyValue = form.querySelector('[data-qty-value]');
  const qtyButtons = Array.from(form.querySelectorAll('[data-qty]'));
  const priceSlots = Array.from(host.querySelectorAll('[data-price]'));
  const groups = Array.from(form.querySelectorAll('[data-option]'));
  const persoFields = Array.from(form.querySelectorAll('[data-perso]'));
  const preview = host.querySelector('[data-perso-preview]');
  const perso = {};
  const readPerso = () => { persoFields.forEach((f) => { perso[f.dataset.perso] = f.querySelector('input').value; }); return perso; };
  const persoError = (field, text) => {
    const input = field.querySelector('input');
    field.classList.toggle('is-invalid', Boolean(text));
    field.querySelector('.c-field__error').textContent = text || '';
    if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  };
  const paintPerso = () => {
    persoFields.forEach((f) => {
      const input = f.querySelector('input');
      f.querySelector('[data-perso-count]').textContent = `${Array.from(input.value).length}/${input.maxLength}`;
    });
    // the first filled field is drawn on the piece
    if (preview) {
      const text = persoFields.map((f) => f.querySelector('input').value.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
      preview.textContent = text;
      preview.hidden = !text;
      preview.style.setProperty('--len', String(Math.max(4, Array.from(text).length)));
    }
  };

  const setError = (group, text) => {
    group.classList.toggle('is-invalid', Boolean(text));
    group.querySelector('.c-field__error').textContent = text || '';
  };
  const paintPrice = () => {
    const text = formatPrice(priceOf(p, chosen, p.currency, validatePersonalisation(p, readPerso()).values), p.currency);
    priceSlots.forEach((n) => { n.textContent = text; });
  };
  const paintQty = () => {
    qtyValue.textContent = String(qty);
    qtyButtons.forEach((b) => { b.disabled = (b.dataset.qty === '-1' && qty <= cart.MIN_QTY) || (b.dataset.qty === '1' && qty >= cart.MAX_QTY); });
  };

  // after a language change the page is drawn again: put the customer's choices back
  if (keep) {
    groups.forEach((g) => {
      const want = keep.chosen[g.dataset.option];
      const input = want ? Array.from(g.querySelectorAll('input')).find((n) => n.value === want) : null;
      if (input) { input.checked = true; g.querySelector('[data-chosen]').textContent = valueLabel(want); }
    });
    qty = Math.max(cart.MIN_QTY, Math.min(cart.MAX_QTY, Number(keep.qty) || 1));
    persoFields.forEach((f) => { const v = keep.perso && keep.perso[f.dataset.perso]; if (v) f.querySelector('input').value = v; });
  }
  // every group starts on its default, so "add to bag" works on the first tap
  groups.forEach((g) => {
    const on = g.querySelector('input:checked');
    if (on) chosen[g.dataset.option] = on.value;
  });
  paintPerso();
  paintPrice();
  paintQty();

  form.addEventListener('input', (e) => {
    const field = e.target.closest('[data-perso]');
    if (!field) return;
    persoError(field, '');
    paintPerso();
    paintPrice();
  });
  form.addEventListener('change', (e) => {
    if (e.target.closest('[data-country-select]')) { commerce.setCountry(e.target.value); return; }
    const group = e.target.closest('[data-option]');
    if (!group) return;
    chosen[group.dataset.option] = e.target.value;
    group.querySelector('[data-chosen]').textContent = valueLabel(e.target.value);
    setError(group, '');
    paintPrice();
  });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-qty]');
    if (!b) return;
    qty = Math.max(cart.MIN_QTY, Math.min(cart.MAX_QTY, qty + Number(b.dataset.qty)));
    paintQty();
    if (b.disabled) (qtyButtons.find((x) => !x.disabled) || b).focus();
  });

  function addNow() {
    const missing = groups.filter((g) => !chosen[g.dataset.option]);
    groups.forEach((g) => setError(g, chosen[g.dataset.option] ? '' : STR.pick(g.dataset.option)));
    if (missing.length) {
      const first = missing[0].querySelector('input');
      missing[0].scrollIntoView({ block: 'center', behavior: 'auto' });
      if (first) first.focus({ preventScroll: true });
      return;
    }
    // personalisation: same rules as the server (length, allowed characters, required)
    const checked = validatePersonalisation(p, readPerso());
    const fieldsByKey = new Map(personalisationOf(p).map((f) => [f.key, f]));
    persoFields.forEach((f) => {
      const kind = checked.errors[f.dataset.perso];
      persoError(f, kind ? STR.persoErr(kind, personalisationLabel(f.dataset.perso), (fieldsByKey.get(f.dataset.perso) || {}).maxLength || '') : '');
    });
    if (!checked.ok) {
      const bad = persoFields.find((f) => checked.errors[f.dataset.perso]);
      bad.scrollIntoView({ block: 'center', behavior: 'auto' });
      bad.querySelector('input').focus({ preventScroll: true });
      return;
    }
    cart.add(p.id, qty, chosen, checked.values); // the drawer opens itself and announces the change
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); addNow(); });

  // sticky bar on phones: shown while the main button is off screen, hidden again at the footer
  const bar = host.querySelector('[data-bar]');
  const main = form.querySelector('[data-add]');
  if (bar && main && 'IntersectionObserver' in window) {
    bar.querySelector('[data-bar-add]').addEventListener('click', addNow);
    const footer = document.querySelector('[data-shell="footer"]');
    const seen = { main: true, footer: false };
    const paint = () => {
      const on = !seen.main && !seen.footer;
      bar.classList.toggle('is-on', on);
      bar.inert = !on;
    };
    io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.target === main) seen.main = en.isIntersecting; else seen.footer = en.isIntersecting; });
      paint();
    });
    io.observe(main);
    if (footer) io.observe(footer);
    paint();
  }
  return { state: () => ({ chosen: { ...chosen }, qty, perso: { ...readPerso() } }), destroy: () => { if (io) io.disconnect(); } };
}

function init(ctx) {
  const host = document.querySelector('[data-product]');
  if (!host) return;
  const p = getById(new URLSearchParams(window.location.search).get('id'));
  host.classList.remove('s-skeleton');
  let buy = null;

  function draw(keep) {
    if (!p) {
      document.title = STR.lostPageTitle;
      host.innerHTML = lostHTML();
      scan(host);
      return;
    }
    document.title = STR.pageTitle(p.name);
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', `${p.name}: ${p.pitch} ${STR.honest()}`);
    host.innerHTML = pageHTML(p);
    bindStage(host, ctx);
    buy = bindBuy(host, p, keep);
    const related = host.querySelector('[data-related]');
    if (related) bindQuickAdd(related);
    scan(host);
    refresh();
  }
  draw(null);

  // language change: draw the page again in the new language, keeping options and quantity
  const redraw = () => {
    const keep = buy ? buy.state() : null;
    if (buy) buy.destroy();
    buy = null;
    draw(keep);
  };
  document.addEventListener('tcd:lang', redraw);
  // another delivery country (or the commerce switch): other currency, other availability
  document.addEventListener('tcd:market', redraw);
  // the "not available here" box has its own country select (no buy form to listen on)
  host.addEventListener('change', (e) => {
    if (e.target.closest('[data-country-select]') && !e.target.closest('form[data-buy]')) commerce.setCountry(e.target.value);
  });
}

if (document.body.dataset.page === 'product') {
  ready.then(init).catch((err) => {
    console.warn('[tcd] product', err);
    init({ gsap: null, reduced: true, fine: false });
  });
}
