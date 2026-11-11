// The Cute Devil: header, footer, mobile menu, theme switcher. Owner: shell.
// Rendered from template strings so six pages never drift and all copy sits in STR.
import { logoMark } from './logo.js';

/** The one place the tagline lives (home's hero headline is the only other copy). */
export const TAGLINE = 'Charming outside. Mysterious inside.';

const WHATSAPP_NUMBER = '34622209935';
const WHATSAPP_URL = `https://wa.me/${WHATSAPP_NUMBER}`;
const LINKEDIN_URL = 'https://www.linkedin.com/in/mohamedjiedr';

const STR = {
  brand: 'the cute devil',
  home: 'The Cute Devil, home',
  navLabel: 'Main',
  nav: [
    { key: 'shop', href: 'shop.html', label: 'shop', hint: 'wear, scent, tech' },
    { key: 'story', href: 'story.html', label: 'story', hint: 'who is behind it' },
    { key: 'contact', href: 'contact.html', label: 'contact', hint: 'say hello' },
  ],
  themeLabel: 'Accent colour',
  themes: { cream: 'Red on cream', red: 'Red on navy', purple: 'Purple', blue: 'Blue' },
  themePick: 'pick your shade',
  bag: 'Open bag',
  bagCount: (n) => (n === 1 ? '1 item in bag' : `${n} items in bag`),
  menuOpen: 'Open menu',
  menuClose: 'Close menu',
  menu: 'Menu',
  footExplore: 'explore',
  footHelp: 'help',
  footLegal: 'legal',
  help: [
    { href: 'faq.html', label: 'FAQ' },
    { href: 'shipping-returns.html', label: 'Shipping & returns' },
    { href: 'contact.html', label: 'Contact' },
  ],
  legal: [
    { href: 'terms.html', label: 'Terms' },
    { href: 'privacy.html', label: 'Privacy' },
    { href: 'cookies.html', label: 'Cookies' },
    { href: 'legal.html', label: 'Legal notice' },
  ],
  footTalk: 'talk to us',
  footWhere: 'where',
  footShade: 'shade',
  whatsapp: 'WhatsApp',
  whatsappNumber: '+34 622 20 99 35',
  whatsappCta: 'message us on whatsapp',
  linkedin: 'LinkedIn',
  places: ['Valladolid, Spain', 'Abu Dhabi, UAE'],
  copyright: '© 2026 The Cute Devil',
  madeWith: 'Made with charm. And a little mystery.',
  formName: 'Please tell us your name.',
  formMessage: 'Please write a short message.',
  formOpened: 'WhatsApp opened in a new tab. Press send there and we will reply.',
  formHello: (name) => `Hi, this is ${name}.`,
  formFrom: '(sent from the contact page of The Cute Devil)',
};

const PAGE_TO_NAV = { shop: 'shop', product: 'shop', story: 'story', contact: 'contact' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ICON_BAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 8.5h14l-1.1 10.2a2 2 0 0 1-2 1.8H8.1a2 2 0 0 1-2-1.8z"/><path d="M8.5 8.5C7 6.6 7.2 4.3 8.6 3c.1 2 1.2 3.2 2.9 3.6M15.5 8.5c1.5-1.9 1.3-4.2-.1-5.5-.1 2-1.2 3.2-2.9 3.6"/></svg>';
const ICON_WA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 20.5l1.3-4.7a8.5 8.5 0 1 1 3.4 3.4z"/><path d="M9.2 8.2c-.3 3.4 3.2 6.9 6.6 6.6l.7-1.8-2-1.1-.9.9c-1-.5-1.9-1.4-2.4-2.4l.9-.9-1.1-2z"/></svg>';

function switcherHTML() {
  const dots = Object.keys(STR.themes).map((name) => (
    `<button type="button" class="c-theme__dot c-theme__dot--${name}" role="radio" aria-checked="false" tabindex="-1" data-theme-set="${name}" aria-label="${esc(STR.themes[name])}" title="${esc(STR.themes[name])}"></button>`
  )).join('');
  return `<div class="c-theme" role="radiogroup" aria-label="${esc(STR.themeLabel)}" data-theme-switch>${dots}</div>`;
}

function headerHTML(current) {
  const links = STR.nav.map((n) => (
    `<li><a class="c-nav__link" href="${n.href}"${n.key === current ? ' aria-current="page"' : ''}>${esc(n.label)}</a></li>`
  )).join('');
  return `
<div class="c-container c-container--wide c-header__inner">
  <a class="c-logo" href="index.html" aria-label="${esc(STR.home)}">${logoMark}<span class="c-logo__word">${esc(STR.brand)}</span></a>
  <nav class="c-nav" aria-label="${esc(STR.navLabel)}"><ul class="c-nav__list">${links}</ul></nav>
  <div class="c-header__tools">
    ${switcherHTML()}
    <button type="button" class="c-bag" data-cart-toggle aria-label="${esc(STR.bag)}" aria-haspopup="dialog">
      ${ICON_BAG}
      <span class="c-bag__count is-empty" data-cart-count aria-live="polite" aria-atomic="true">0</span>
    </button>
    <button type="button" class="c-burger" aria-expanded="false" aria-controls="tcd-menu" aria-label="${esc(STR.menuOpen)}" data-menu-toggle><span class="c-burger__box"></span></button>
  </div>
</div>`;
}

function sheetHTML(current) {
  const links = STR.nav.map((n, i) => (
    `<a class="c-sheet__link" style="--i:${i}" href="${n.href}"${n.key === current ? ' aria-current="page"' : ''}>${esc(n.label)}<span>${esc(n.hint)}</span></a>`
  )).join('');
  return `
<div class="c-sheet__row"><span class="c-sheet__label">${esc(STR.themePick)}</span>${switcherHTML()}</div>
<nav class="c-sheet__nav" aria-label="${esc(STR.menu)}">${links}</nav>
<div class="c-sheet__foot">
  <a class="c-btn c-btn--primary c-btn--block" href="${WHATSAPP_URL}" target="_blank" rel="noopener">${ICON_WA}${esc(STR.whatsappCta)}</a>
  <p class="u-small u-muted">${esc(TAGLINE)}</p>
</div>`;
}

function footerHTML() {
  const list = (items) => items.map((n) => `<li><a class="c-footer__link" href="${n.href}">${esc(n.label)}</a></li>`).join('');
  const links = list(STR.nav);
  return `
<div class="c-container c-container--wide">
  <div class="c-footer__top">
    <div class="c-footer__brand">
      <a href="index.html" aria-label="${esc(STR.home)}">${logoMark}</a>
      <p class="c-footer__tagline">${esc(TAGLINE)}</p>
    </div>
    <div class="c-footer__cols">
      <div><h2 class="c-footer__h">${esc(STR.footExplore)}</h2><ul class="c-footer__list">${links}</ul></div>
      <div><h2 class="c-footer__h">${esc(STR.footHelp)}</h2><ul class="c-footer__list">${list(STR.help)}</ul></div>
      <div><h2 class="c-footer__h">${esc(STR.footLegal)}</h2><ul class="c-footer__list">${list(STR.legal)}</ul></div>
      <div><h2 class="c-footer__h">${esc(STR.footTalk)}</h2><ul class="c-footer__list">
        <li><a class="c-footer__link" href="${WHATSAPP_URL}" target="_blank" rel="noopener" aria-label="${esc(STR.whatsapp)} ${esc(STR.whatsappNumber)}">${esc(STR.whatsappNumber)}</a></li>
        <li><a class="c-footer__link" href="${LINKEDIN_URL}" target="_blank" rel="noopener">${esc(STR.linkedin)}</a></li>
      </ul></div>
      <div><h2 class="c-footer__h">${esc(STR.footWhere)}</h2><p class="c-footer__plain">${STR.places.map(esc).join('<br>')}</p></div>
      <div><h2 class="c-footer__h">${esc(STR.footShade)}</h2>${switcherHTML()}</div>
    </div>
  </div>
</div>
<div class="c-footer__word" aria-hidden="true" data-reveal="up">${esc(STR.brand)}</div>
<div class="c-container c-container--wide c-footer__base"><p>${esc(STR.copyright)}</p><p>${esc(STR.madeWith)}</p></div>`;
}

/* ---------------------------------------------------------------- theme switcher */
function bindSwitchers(theme) {
  const paint = () => {
    const now = theme.get();
    document.querySelectorAll('[data-theme-set]').forEach((b) => {
      const on = b.dataset.themeSet === now;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
  };
  document.querySelectorAll('[data-theme-switch]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('[data-theme-set]');
      if (b) theme.set(b.dataset.themeSet);
    });
    group.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const list = theme.list;
      const next = list[(list.indexOf(theme.get()) + step + list.length) % list.length];
      theme.set(next);
      const b = group.querySelector(`[data-theme-set="${next}"]`);
      if (b) b.focus();
    });
  });
  document.addEventListener('tcd:theme', paint);
  paint();
}

/* ---------------------------------------------------------------- mobile menu */
function bindMenu(header, sheet) {
  const burger = header.querySelector('[data-menu-toggle]');
  const root = document.documentElement;
  const others = () => Array.from(document.body.children).filter((n) => n !== header && n !== sheet && !n.matches('script,[data-cart-root],.c-cursor,.c-wipe'));
  let open = false;

  function set(next, { focus = true } = {}) {
    if (next === open) return;
    open = next;
    sheet.classList.toggle('is-open', open);
    root.classList.toggle('is-menu-open', open);
    root.classList.toggle('is-locked', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    burger.setAttribute('aria-label', open ? STR.menuClose : STR.menuOpen);
    others().forEach((n) => { n.inert = open; });
    if (open) {
      const first = sheet.querySelector('.c-sheet__link');
      if (focus && first) setTimeout(() => first.focus({ preventScroll: true }), 60);
    } else if (focus) {
      burger.focus({ preventScroll: true });
    }
  }
  const focusables = () => [burger, ...sheet.querySelectorAll('a[href],button:not([tabindex="-1"])')].filter((n) => n.offsetParent !== null);

  burger.addEventListener('click', () => set(!open));
  sheet.addEventListener('click', (e) => { if (e.target.closest('a[href]')) set(false, { focus: false }); });
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); set(false); return; }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0]; const last = list[list.length - 1];
    const active = document.activeElement;
    if (!list.includes(active) && !header.contains(active)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  });
  // while the menu is open, only the burger is reachable in the header
  const mq = window.matchMedia('(min-width: 56em)');
  const onWide = () => { if (mq.matches) set(false, { focus: false }); };
  if (mq.addEventListener) mq.addEventListener('change', onWide); else mq.addListener(onWide);
  window.addEventListener('pageshow', (e) => { if (e.persisted) set(false, { focus: false }); });
}

/* ---------------------------------------------------------------- bag count */
function bindBagCount(header) {
  const button = header.querySelector('[data-cart-toggle]');
  const bubble = header.querySelector('[data-cart-count]');
  const paint = (count, bump) => {
    const n = Math.max(0, Number(count) || 0);
    bubble.textContent = String(n);
    bubble.classList.toggle('is-empty', n === 0);
    button.setAttribute('aria-label', `${STR.bag}, ${STR.bagCount(n)}`);
    if (bump && n > 0) { bubble.classList.remove('is-bump'); void bubble.offsetWidth; bubble.classList.add('is-bump'); }
  };
  let initial = 0;
  try {
    const data = JSON.parse(localStorage.getItem('tcd:cart') || 'null');
    if (data && Array.isArray(data.items)) initial = data.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
  } catch (err) { /* ignore */ }
  paint(initial, false);
  document.addEventListener('tcd:cart', (e) => paint(e.detail && e.detail.count, true));
}

/* ---------------------------------------------------------------- [data-wa-form]: compose a WhatsApp message, no backend */
function bindWhatsAppForms() {
  document.querySelectorAll('form[data-wa-form]').forEach((form) => {
    form.setAttribute('novalidate', '');
    const status = form.querySelector('[data-form-status]');
    const fieldError = (input, text) => {
      const field = input.closest('.c-field');
      const slot = field && field.querySelector('.c-field__error');
      if (field) field.classList.toggle('is-invalid', Boolean(text));
      if (slot) slot.textContent = text || '';
      if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    };
    form.addEventListener('input', (e) => { if (e.target.value && e.target.value.trim()) fieldError(e.target, ''); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = form.elements.name; const message = form.elements.message;
      const n = name ? name.value.trim() : ''; const m = message ? message.value.trim() : '';
      if (name) fieldError(name, n ? '' : STR.formName);
      if (message) fieldError(message, m ? '' : STR.formMessage);
      if (status) status.textContent = '';
      if (name && !n) { name.focus(); return; }
      if (message && !m) { message.focus(); return; }
      const text = [STR.formHello(n), '', m, '', STR.formFrom].join('\n');
      window.open(`${WHATSAPP_URL}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      if (status) status.textContent = STR.formOpened;
    });
  });
}

/* ---------------------------------------------------------------- mount */
export function mount(theme) {
  const page = document.body.dataset.page || '';
  const current = PAGE_TO_NAV[page] || '';

  const header = document.querySelector('[data-shell="header"]');
  let sheet = null;
  if (header) {
    header.innerHTML = headerHTML(current);
    sheet = document.createElement('div');
    sheet.className = 'c-sheet';
    sheet.id = 'tcd-menu';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', STR.menu);
    sheet.setAttribute('data-lenis-prevent', '');
    sheet.innerHTML = sheetHTML(current);
    header.after(sheet);
    bindMenu(header, sheet);
    bindBagCount(header);
    const stick = () => header.classList.toggle('is-stuck', window.scrollY > 8);
    window.addEventListener('scroll', stick, { passive: true });
    stick();
  }

  const footer = document.querySelector('[data-shell="footer"]');
  if (footer) footer.innerHTML = footerHTML();

  if (!document.querySelector('[data-cart-root]')) {
    const cart = document.createElement('div');
    cart.setAttribute('data-cart-root', '');
    cart.setAttribute('data-lenis-prevent', '');
    document.body.appendChild(cart);
  }

  // any element with [data-logo] receives the inline, theme-aware logo mark
  document.querySelectorAll('[data-logo]').forEach((el) => { if (!el.firstElementChild) el.innerHTML = logoMark; });

  if (theme) bindSwitchers(theme);
  bindWhatsAppForms();
}
