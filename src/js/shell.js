// The Cute Devil: header, footer, mobile menu, theme switcher, language switcher. Owner: shell.
// Rendered from template strings so the pages never drift. Every string comes from the dictionary
// (src/i18n/*.json): the templates print t(key) AND mark the node with data-i18n, so a language
// change re-translates the shell in place without rebuilding it or losing its event listeners.
import { logoMark } from './logo.js';
import { t, tn, LANGS, getLang, setLang } from './i18n.js';

/** The English tagline (kept for older imports). The shell itself prints t('brand.tagline'). */
export const TAGLINE = 'Charming outside. Mysterious inside.';

const WHATSAPP_NUMBER = '34622209935';
const WHATSAPP_URL = `https://wa.me/${WHATSAPP_NUMBER}`;
const LINKEDIN_URL = 'https://www.linkedin.com/in/mohamedjiedr';
const OWNER_URL = 'https://grandmindstechnology.com';

// Never translated: the brand, proper names, the phone number.
const FIXED = {
  brand: 'the cute devil',
  whatsappNumber: '+34 622 20 99 35',
  linkedin: 'LinkedIn',
  copyright: '© 2026 The Cute Devil',
  owner: 'Grand Minds Technology',
};
// The WhatsApp message of the contact form stays in English: the seller reads it.
const MSG = {
  hello: (name) => `Hi, this is ${name}.`,
  from: '(sent from the contact page of The Cute Devil)',
};
const NAV = [
  { key: 'shop', href: 'shop.html', label: 'nav.shop', hint: 'nav.shopHint' },
  { key: 'story', href: 'story.html', label: 'nav.story', hint: 'nav.storyHint' },
  { key: 'contact', href: 'contact.html', label: 'nav.contact', hint: 'nav.contactHint' },
];
const HELP = [
  { href: 'faq.html', label: 'footer.link.faq' },
  { href: 'shipping-returns.html', label: 'footer.link.shipping' },
  { href: 'contact.html', label: 'footer.link.contact' },
];
const LEGAL = [
  { href: 'terms.html', label: 'footer.link.terms' },
  { href: 'privacy.html', label: 'footer.link.privacy' },
  { href: 'cookies.html', label: 'footer.link.cookies' },
  { href: 'legal.html', label: 'footer.link.legal' },
];
const THEME_KEYS = { cream: 'theme.cream', red: 'theme.red', purple: 'theme.purple', blue: 'theme.blue' };

const PAGE_TO_NAV = { shop: 'shop', product: 'shop', story: 'story', contact: 'contact' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** A translated text node holder: prints the string now and can be re-translated in place later. */
const tx = (key) => `data-i18n="${key}">${esc(t(key))}`;
/** Translated attributes: at('aria-label:menu.label;title:menu.label') */
const at = (pairs) => `${pairs.split(';').map((pair) => { const [a, k] = pair.split(':'); return `${a}="${esc(t(k))}"`; }).join(' ')} data-i18n-attr="${pairs}"`;

const ICON_BAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 8.5h14l-1.1 10.2a2 2 0 0 1-2 1.8H8.1a2 2 0 0 1-2-1.8z"/><path d="M8.5 8.5C7 6.6 7.2 4.3 8.6 3c.1 2 1.2 3.2 2.9 3.6M15.5 8.5c1.5-1.9 1.3-4.2-.1-5.5-.1 2-1.2 3.2-2.9 3.6"/></svg>';
const ICON_WA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 20.5l1.3-4.7a8.5 8.5 0 1 1 3.4 3.4z"/><path d="M9.2 8.2c-.3 3.4 3.2 6.9 6.6 6.6l.7-1.8-2-1.1-.9.9c-1-.5-1.9-1.4-2.4-2.4l.9-.9-1.1-2z"/></svg>';
const ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5s1.3-6.1 3.9-8.5z"/></svg>';
const ICON_CARET = '<svg class="c-lang__caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 10l5 5 5-5"/></svg>';

function switcherHTML() {
  const dots = Object.keys(THEME_KEYS).map((name) => (
    `<button type="button" class="c-theme__dot c-theme__dot--${name}" role="radio" aria-checked="false" tabindex="-1" data-theme-set="${name}" ${at(`aria-label:${THEME_KEYS[name]};title:${THEME_KEYS[name]}`)}></button>`
  )).join('');
  return `<div class="c-theme" role="radiogroup" ${at('aria-label:theme.label')} data-theme-switch>${dots}</div>`;
}

/* language: a button + listbox in the header (desktop), a native select in the menu sheet and the footer */
function langMenuHTML() {
  const options = LANGS.map((l) => (
    `<li class="c-lang__option" role="option" id="tcd-lang-${l.code}" data-lang-set="${l.code}" aria-selected="false"><span class="c-lang__name" lang="${l.code}" dir="${l.dir}" translate="no">${esc(l.name)}</span><span class="c-lang__code" lang="en" aria-hidden="true">${l.code}</span></li>`
  )).join('');
  return `
<div class="c-lang" data-lang-menu>
  <button type="button" class="c-lang__btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="tcd-lang-list" data-lang-toggle>
    ${ICON_GLOBE}<span class="c-lang__now" data-lang-now translate="no"></span>${ICON_CARET}
  </button>
  <ul class="c-lang__list" id="tcd-lang-list" role="listbox" tabindex="-1" ${at('aria-label:lang.label')} data-lang-list data-lenis-prevent hidden>${options}</ul>
</div>`;
}
function langSelectHTML(id) {
  const options = LANGS.map((l) => `<option value="${l.code}" lang="${l.code}">${esc(l.name)}</option>`).join('');
  return `<span class="c-langpick">${ICON_GLOBE}<select class="c-select c-langpick__select" id="${id}" ${at('aria-label:lang.label')} data-lang-select translate="no">${options}</select></span>`;
}

function headerHTML(current) {
  const links = NAV.map((n) => (
    `<li><a class="c-nav__link" href="${n.href}"${n.key === current ? ' aria-current="page"' : ''} ${tx(n.label)}</a></li>`
  )).join('');
  return `
<div class="c-container c-container--wide c-header__inner">
  <a class="c-logo" href="index.html" ${at('aria-label:shell.home')}>${logoMark}<span class="c-logo__word" translate="no">${esc(FIXED.brand)}</span></a>
  <nav class="c-nav" ${at('aria-label:nav.label')}><ul class="c-nav__list">${links}</ul></nav>
  <div class="c-header__tools">
    ${switcherHTML()}
    <button type="button" class="c-theme__dot c-theme-cycle" data-theme-cycle ${at('aria-label:theme.cycle;title:theme.cycle')}></button>
    ${langMenuHTML()}
    <button type="button" class="c-bag" data-cart-toggle aria-label="${esc(t('bag.open'))}" aria-haspopup="dialog">
      ${ICON_BAG}
      <span class="c-bag__count is-empty" data-cart-count aria-live="polite" aria-atomic="true">0</span>
    </button>
    <button type="button" class="c-burger" aria-expanded="false" aria-controls="tcd-menu" aria-label="${esc(t('menu.open'))}" data-menu-toggle><span class="c-burger__box"></span></button>
  </div>
</div>`;
}

function sheetHTML(current) {
  const links = NAV.map((n, i) => (
    `<a class="c-sheet__link" style="--i:${i}" href="${n.href}"${n.key === current ? ' aria-current="page"' : ''}><b ${tx(n.label)}</b><span ${tx(n.hint)}</span></a>`
  )).join('');
  return `
<div class="c-sheet__row"><span class="c-sheet__label" ${tx('theme.pick')}</span>${switcherHTML()}</div>
<div class="c-sheet__row"><label class="c-sheet__label" for="tcd-lang-sheet" ${tx('lang.pick')}</label>${langSelectHTML('tcd-lang-sheet')}</div>
<nav class="c-sheet__nav" ${at('aria-label:menu.label')}>${links}</nav>
<div class="c-sheet__foot">
  <a class="c-btn c-btn--primary c-btn--block" href="${WHATSAPP_URL}" target="_blank" rel="noopener">${ICON_WA}<span ${tx('menu.whatsapp')}</span></a>
  <p class="u-small u-muted" ${tx('brand.tagline')}</p>
</div>`;
}

const creditHTML = () => t('footer.credit', { company: `<a class="c-footer__owner" href="${OWNER_URL}" target="_blank" rel="noopener" translate="no">${esc(FIXED.owner)}</a>` });

function footerHTML() {
  const list = (items) => items.map((n) => `<li><a class="c-footer__link" href="${n.href}" ${tx(n.label)}</a></li>`).join('');
  // "contact" lives under help; here its place is taken by a direct WhatsApp link
  const links = list(NAV.filter((n) => n.key !== 'contact'))
    + `<li><a class="c-footer__link" href="${WHATSAPP_URL}" target="_blank" rel="noopener" ${tx('footer.whatsapp')}</a></li>`;
  return `
<div class="c-container c-container--wide">
  <div class="c-footer__top">
    <div class="c-footer__brand">
      <a href="index.html" ${at('aria-label:shell.home')}>${logoMark}</a>
      <p class="c-footer__tagline" ${tx('brand.tagline')}</p>
      <p class="c-footer__personal" ${tx('footer.personal')}</p>
    </div>
    <div class="c-footer__cols">
      <div><h2 class="c-footer__h" ${tx('footer.explore')}</h2><ul class="c-footer__list">${links}</ul></div>
      <div><h2 class="c-footer__h" ${tx('footer.help')}</h2><ul class="c-footer__list">${list(HELP)}</ul></div>
      <div><h2 class="c-footer__h" ${tx('footer.legal')}</h2><ul class="c-footer__list">${list(LEGAL)}</ul></div>
      <div><h2 class="c-footer__h" ${tx('footer.talk')}</h2><ul class="c-footer__list">
        <li><a class="c-footer__link" href="${WHATSAPP_URL}" target="_blank" rel="noopener" data-wa-label><bdi dir="ltr">${esc(FIXED.whatsappNumber)}</bdi></a></li>
        <li><a class="c-footer__link" href="${LINKEDIN_URL}" target="_blank" rel="noopener" translate="no">${esc(FIXED.linkedin)}</a></li>
      </ul></div>
      <div><h2 class="c-footer__h" ${tx('footer.where')}</h2><p class="c-footer__plain"><span ${tx('footer.place1')}</span><br><span ${tx('footer.place2')}</span></p></div>
      <div><h2 class="c-footer__h" ${tx('footer.shade')}</h2>${switcherHTML()}</div>
      <div><h2 class="c-footer__h"><label for="tcd-lang-footer" ${tx('footer.language')}</label></h2>${langSelectHTML('tcd-lang-footer')}</div>
    </div>
  </div>
</div>
<div class="c-footer__word" aria-hidden="true" data-reveal="up" translate="no">${esc(FIXED.brand)}</div>
<div class="c-container c-container--wide c-footer__base">
  <p translate="no">${esc(FIXED.copyright)}</p>
  <p class="c-footer__credit"><span data-footer-credit>${creditHTML()}</span> <span class="c-footer__sep" aria-hidden="true">·</span> <span ${tx('footer.madein')}</span></p>
  <p ${tx('footer.madeWith')}</p>
</div>`;
}

/* ---------------------------------------------------------------- language switcher */
function bindLanguage() {
  const paint = () => {
    const now = getLang();
    const info = LANGS.find((l) => l.code === now) || LANGS[0];
    document.querySelectorAll('[data-lang-now]').forEach((n) => { n.textContent = info.code.toUpperCase(); });
    document.querySelectorAll('[data-lang-toggle]').forEach((b) => {
      b.setAttribute('aria-label', t('lang.current', { name: info.name }));
      b.setAttribute('title', info.name);
    });
    document.querySelectorAll('[data-lang-set]').forEach((o) => o.setAttribute('aria-selected', o.dataset.langSet === now ? 'true' : 'false'));
    document.querySelectorAll('[data-lang-select]').forEach((sel) => { sel.value = now; });
    document.querySelectorAll('[data-footer-credit]').forEach((n) => { n.innerHTML = creditHTML(); });
    document.querySelectorAll('[data-wa-label]').forEach((n) => n.setAttribute('aria-label', t('footer.whatsappLabel', { number: FIXED.whatsappNumber })));
  };

  document.querySelectorAll('[data-lang-select]').forEach((sel) => {
    sel.addEventListener('change', () => setLang(sel.value));
  });

  document.querySelectorAll('[data-lang-menu]').forEach((box) => {
    const button = box.querySelector('[data-lang-toggle]');
    const list = box.querySelector('[data-lang-list]');
    const options = Array.from(list.querySelectorAll('[data-lang-set]'));
    let active = 0;
    const mark = (i) => {
      active = (i + options.length) % options.length;
      options.forEach((o, n) => o.classList.toggle('is-active', n === active));
      list.setAttribute('aria-activedescendant', options[active].id);
      options[active].scrollIntoView({ block: 'nearest' });
    };
    const isOpen = () => !list.hidden;
    const open = () => {
      if (isOpen()) return;
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      mark(Math.max(0, options.findIndex((o) => o.dataset.langSet === getLang())));
      list.focus({ preventScroll: true });
    };
    const close = (focus = true) => {
      if (!isOpen()) return;
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      list.removeAttribute('aria-activedescendant');
      if (focus) button.focus({ preventScroll: true });
    };
    const choose = (i) => { const code = options[i].dataset.langSet; close(); setLang(code); };

    button.addEventListener('click', () => { if (isOpen()) close(); else open(); });
    button.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    list.addEventListener('click', (e) => {
      const o = e.target.closest('[data-lang-set]');
      if (o) choose(options.indexOf(o));
    });
    list.addEventListener('pointermove', (e) => {
      const o = e.target.closest('[data-lang-set]');
      if (o && options.indexOf(o) !== active) mark(options.indexOf(o));
    });
    list.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); mark(active + 1); break;
        case 'ArrowUp': e.preventDefault(); mark(active - 1); break;
        case 'Home': e.preventDefault(); mark(0); break;
        case 'End': e.preventDefault(); mark(options.length - 1); break;
        case 'Enter': case ' ': e.preventDefault(); choose(active); break;
        case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break;
        case 'Tab': close(false); break;
        default: {
          // type-ahead on the language code or the first letter of its name
          const ch = e.key.length === 1 ? e.key.toLowerCase() : '';
          const hit = ch ? options.findIndex((o, n) => n !== active && (o.dataset.langSet.startsWith(ch) || o.textContent.trim().toLowerCase().startsWith(ch))) : -1;
          if (hit > -1) mark(hit);
        }
      }
    });
    document.addEventListener('pointerdown', (e) => { if (isOpen() && !box.contains(e.target)) close(false); });
    list.addEventListener('focusout', (e) => { if (isOpen() && !box.contains(e.relatedTarget)) close(false); });
  });

  document.addEventListener('tcd:lang', paint);
  paint();
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
  document.querySelectorAll('[data-theme-cycle]').forEach((b) => {
    b.addEventListener('click', () => {
      const list = theme.list;
      theme.set(list[(list.indexOf(theme.get()) + 1) % list.length]);
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
    burger.setAttribute('aria-label', t(open ? 'menu.close' : 'menu.open'));
    others().forEach((n) => { n.inert = open; });
    if (open) {
      const first = sheet.querySelector('.c-sheet__link');
      if (focus && first) setTimeout(() => first.focus({ preventScroll: true }), 60);
    } else if (focus) {
      burger.focus({ preventScroll: true });
    }
  }
  const focusables = () => [burger, ...sheet.querySelectorAll('a[href],select,button:not([tabindex="-1"])')].filter((n) => n.offsetParent !== null);

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
  document.addEventListener('tcd:lang', () => {
    burger.setAttribute('aria-label', t(open ? 'menu.close' : 'menu.open'));
    sheet.setAttribute('aria-label', t('menu.label'));
  });
}

/* ---------------------------------------------------------------- bag count */
function bindBagCount(header) {
  const button = header.querySelector('[data-cart-toggle]');
  const bubble = header.querySelector('[data-cart-count]');
  let shown = 0;
  const paint = (count, bump) => {
    const n = Math.max(0, Number(count) || 0);
    shown = n;
    bubble.textContent = String(n);
    bubble.classList.toggle('is-empty', n === 0);
    button.setAttribute('aria-label', `${t('bag.open')}, ${tn('bag.count', n)}`);
    if (bump && n > 0) { bubble.classList.remove('is-bump'); void bubble.offsetWidth; bubble.classList.add('is-bump'); }
  };
  let initial = 0;
  try {
    const data = JSON.parse(localStorage.getItem('tcd:cart') || 'null');
    if (data && Array.isArray(data.items)) initial = data.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
  } catch (err) { /* ignore */ }
  paint(initial, false);
  document.addEventListener('tcd:cart', (e) => paint(e.detail && e.detail.count, true));
  document.addEventListener('tcd:lang', () => paint(shown, false));
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
      if (name) fieldError(name, n ? '' : t('form.errName'));
      if (message) fieldError(message, m ? '' : t('form.errMessage'));
      if (status) status.textContent = '';
      if (name && !n) { name.focus(); return; }
      if (message && !m) { message.focus(); return; }
      const text = [MSG.hello(n), '', m, '', MSG.from].join('\n');
      window.open(`${WHATSAPP_URL}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      if (status) status.textContent = t('form.opened');
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
    sheet.setAttribute('aria-label', t('menu.label'));
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
  bindLanguage();
  bindWhatsAppForms();
}
