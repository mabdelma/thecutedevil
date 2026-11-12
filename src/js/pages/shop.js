// The Cute Devil: shop page (catalogue + niche filter). Owner: shop.
// Also exports the product card so product.html can show related pieces.
import { ready } from '../app.js';
import { scan, refresh } from '../motion.js';
import { products, byNiche, NICHES, formatPrice, artFor, nicheLabel, optionLabel, statusOf, availableHere, personalisationOf } from '../products.js';
import { t, tn, strings, getLang, apply } from '../i18n.js';
import * as cart from '../cart.js';
import * as commerce from '../commerce.js';

const cap = (word) => { const w = String(word); return w ? w[0].toLocaleUpperCase(getLang()) + w.slice(1) : w; };
const STR = strings({
  sample: 'common.sample',
  soon: 'common.soon',
  sold: 'common.sold',
  add: 'shop.card.add',
  addLabel: (name) => t('shop.card.addLabel', { name }),
  choose: (option) => t('shop.card.choose', { option }),
  look: 'shop.card.look',
  notHere: 'shop.card.notHere',
  personalise: 'shop.card.personalise',
  line: (niche) => t(`shop.line.${niche}`),
  status: (n, niche) => (niche === 'all' ? tn('shop.status.all', n) : tn('shop.status.niche', n, { niche: nicheLabel(niche) })),
  title: (niche) => (niche === 'all' ? t('shop.meta.title') : t('shop.meta.titleNiche', { niche: cap(nicheLabel(niche)) })),
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 12h12M12 6v12"/></svg>';
const ICON_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

/** One product card. `scope` keeps SVG gradient ids unique when the art is on the page twice. */
export function cardHTML(p, { scope = '', level = 3 } = {}) {
  const href = `product.html?id=${encodeURIComponent(p.id)}`;
  // with commerce on, a piece that is not sold online shows as "soon"; one that does not ship to the chosen country says so
  const status = statusOf(p);
  const here = availableHere(p);
  const perso = personalisationOf(p).length > 0;
  const quick = status === 'live' && here && !perso && !(p.options && p.options.length);
  const badge = status === 'soon' ? `<span class="c-badge c-badge--soon">${esc(STR.soon)}</span>`
    : status === 'sold' ? `<span class="c-badge c-badge--sold">${esc(STR.sold)}</span>`
      : !here ? `<span class="c-badge c-badge--sold">${esc(STR.notHere)}</span>` : '';
  let more = '';
  if (status !== 'live' || !here) more = STR.look;
  else if (p.options && p.options.length) more = STR.choose(optionLabel(p.options[0].name));
  else if (perso) more = STR.personalise;
  return `
<article class="c-card s-card s-card--${status === 'live' && !here ? 'sold' : status}" data-devil data-tilt="6" data-niche="${p.niche}" data-id="${esc(p.id)}">
  <div class="c-card__media">
    ${artFor(p, scope)}
    ${badge ? `<div class="c-card__badges">${badge}</div>` : ''}
    ${quick ? `<button type="button" class="s-card__add" data-quick-add="${esc(p.id)}" aria-label="${esc(STR.addLabel(p.name))}">${ICON_PLUS}<span class="s-card__add-label" aria-hidden="true">${esc(STR.add)}</span></button>` : ''}
  </div>
  <div class="c-card__body">
    <p class="s-card__niche">${esc(nicheLabel(p.niche))}</p>
    <h${level} class="c-card__title"><a class="c-card__link" href="${href}" translate="no">${esc(p.name)}</a></h${level}>
    <p class="c-card__text">${esc(p.pitch)}</p>
    <div class="c-card__foot">
      <span class="s-price"><span class="s-price__num" translate="no">${esc(formatPrice(p.price, p.currency))}</span>${p.sample ? `<span class="c-badge c-badge--sample">${esc(STR.sample)}</span>` : ''}</span>
      ${more ? `<span class="s-card__more" aria-hidden="true">${esc(more)}${ICON_ARROW}</span>` : ''}
    </div>
  </div>
</article>`;
}

/** Quick add for cards inside `root` (the drawer opens itself on the cart event). */
export function bindQuickAdd(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick-add]');
    if (!btn) return;
    e.preventDefault();
    const line = cart.add(btn.dataset.quickAdd, 1, {});
    const card = btn.closest('.s-card');
    if (line && card) {
      card.classList.add('is-added');
      window.setTimeout(() => card.classList.remove('is-added'), 1200);
    }
  });
}

/* ---------------------------------------------------------------- copy that depends on the commerce switch */
// shop.html is written for the WhatsApp flow ("sample prices", "order on whatsapp"). With commerce on the
// same nodes read their commerce-on keys; with commerce off they go back to the keys in the HTML.
const COPY_ON = {
  'shop.band.item1': 'shop.on.band1',
  'shop.band.item2': 'shop.on.band2',
  'shop.band.item3': 'shop.on.band3',
  'shop.how.title': 'shop.on.how.title',
  'shop.how.text': 'shop.on.how.text',
};
function paintCopy() {
  const on = commerce.isOn();
  document.querySelectorAll('main [data-i18n], main [data-i18n-off]').forEach((n) => {
    const off = n.dataset.i18nOff || n.getAttribute('data-i18n');
    if (!COPY_ON[off]) return;
    n.dataset.i18nOff = off;
    const want = on ? COPY_ON[off] : off;
    if (n.getAttribute('data-i18n') !== want) { n.setAttribute('data-i18n', want); apply(n); }
  });
  // "Sample prices are placeholders for now."
  document.querySelectorAll('[data-i18n-html="shop.line.note"]').forEach((n) => { n.hidden = on; });
}

/* ---------------------------------------------------------------- page */
const nicheFromUrl = () => {
  const n = new URLSearchParams(window.location.search).get('niche');
  return NICHES.includes(n) ? n : 'all';
};

function init({ gsap, reduced }) {
  const grid = document.querySelector('[data-shop-grid]');
  if (!grid) return;
  const chips = Array.from(document.querySelectorAll('[data-filter] [data-niche]'));
  const status = document.querySelector('[data-filter-status]');
  const line = document.querySelector('[data-shop-line]');
  const animate = Boolean(gsap) && !reduced;
  let current = nicheFromUrl();

  document.querySelectorAll('[data-count]').forEach((n) => { n.textContent = String(byNiche(n.dataset.count).length); });

  const matches = (card, niche) => niche === 'all' || card.dataset.niche === niche;
  let cards = [];
  const draw = () => {
    grid.innerHTML = products.map((p) => cardHTML(p)).join('');
    cards = Array.from(grid.children);
    cards.forEach((card) => { card.hidden = !matches(card, current); });
  };
  draw();

  function paintChrome(niche, swap) {
    chips.forEach((chip) => {
      if (chip.dataset.niche === niche) chip.setAttribute('aria-current', 'true'); else chip.removeAttribute('aria-current');
    });
    if (status) status.innerHTML = STR.status(byNiche(niche).length, niche);
    document.title = STR.title(niche);
    if (!line) return;
    if (swap && animate) {
      gsap.to(line, {
        opacity: 0, y: -12, duration: 0.18, ease: 'power2.in', overwrite: true,
        onComplete: () => {
          line.textContent = STR.line(niche);
          gsap.fromTo(line, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out', clearProps: 'opacity,transform' });
        },
      });
    } else {
      line.textContent = STR.line(niche);
    }
  }

  const unpin = (card) => { card.style.position = ''; card.style.left = ''; card.style.top = ''; card.style.width = ''; card.style.height = ''; card.style.pointerEvents = ''; };

  /** FLIP: leaving cards fade out in place, the rest glide to their new cells, new ones scale in. */
  function applyFilter(niche) {
    if (!animate) {
      cards.forEach((card) => { card.hidden = !matches(card, niche); });
      refresh();
      return;
    }
    // settle anything still moving from the last click
    cards.forEach((card) => {
      gsap.killTweensOf(card, 'x,y,scale,opacity');
      if (card.style.position === 'absolute') { card.hidden = true; unpin(card); }
      gsap.set(card, { x: 0, y: 0, scale: 1, opacity: 1 });
    });

    const first = new Map();
    cards.forEach((card) => { if (!card.hidden) first.set(card, { left: card.offsetLeft, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight }); });
    const leaving = cards.filter((card) => !card.hidden && !matches(card, niche));
    const entering = cards.filter((card) => card.hidden && matches(card, niche));
    const staying = cards.filter((card) => !card.hidden && matches(card, niche));

    // take the leaving cards out of the flow but leave them where they are
    leaving.forEach((card) => {
      const r = first.get(card);
      Object.assign(card.style, { position: 'absolute', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, pointerEvents: 'none' });
    });
    entering.forEach((card) => { card.hidden = false; });

    staying.forEach((card) => {
      const a = first.get(card);
      const dx = a.left - card.offsetLeft;
      const dy = a.top - card.offsetTop;
      if (dx || dy) gsap.fromTo(card, { x: dx, y: dy }, { x: 0, y: 0, duration: 0.65, ease: 'expo.out', clearProps: 'transform' });
    });
    entering.forEach((card, i) => {
      gsap.fromTo(card, { opacity: 0, scale: 0.86, y: 24 }, { opacity: 1, scale: 1, y: 0, duration: 0.55, delay: 0.12 + i * 0.05, ease: 'expo.out', clearProps: 'opacity,transform' });
    });
    leaving.forEach((card) => {
      gsap.to(card, {
        opacity: 0, scale: 0.86, duration: 0.3, ease: 'power2.in',
        onComplete: () => { card.hidden = true; unpin(card); gsap.set(card, { clearProps: 'opacity,transform' }); },
      });
    });
    window.setTimeout(refresh, 700);
  }

  function setNiche(niche, { push = false, animateIt = true } = {}) {
    if (niche === current) return;
    current = niche;
    if (push) {
      const url = new URL(window.location.href);
      if (niche === 'all') url.searchParams.delete('niche'); else url.searchParams.set('niche', niche);
      window.history.pushState({ niche }, '', url);
    }
    paintChrome(niche, animateIt);
    applyFilter(niche);
  }

  document.querySelector('[data-filter]').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-niche]');
    if (!chip || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setNiche(chip.dataset.niche, { push: true });
  });
  window.addEventListener('popstate', () => setNiche(nicheFromUrl()));

  paintChrome(current, false);
  paintCopy();
  bindQuickAdd(grid);
  scan(grid);
  refresh();

  // language change: the cards are drawn again in the new language, the filter stays where it is
  const redraw = () => {
    if (animate) cards.forEach((card) => gsap.killTweensOf(card));
    draw();
    paintChrome(current, false);
    scan(grid);
    refresh();
  };
  document.addEventListener('tcd:lang', redraw);
  // another delivery country (or the commerce switch itself): other currency, other availability
  document.addEventListener('tcd:market', () => { paintCopy(); redraw(); });
}

if (document.body.dataset.page === 'shop') {
  ready.then(init).catch((err) => {
    console.warn('[tcd] shop', err);
    init({ gsap: null, reduced: true });
  });
}
