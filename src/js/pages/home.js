// The Cute Devil: home + story page scenes. Owner: home.
// Everything here is progressive: the HTML reads fully without this file, and every
// scene is skipped under prefers-reduced-motion (content simply stays visible).
import { ready } from '../app.js';
import { scan, split, refresh } from '../motion.js';
import { renderArt } from '../art.js';

const STR = {
  sample: 'Sample',
  soon: 'coming soon',
  sold: 'sold out',
  artFallback: 'The Cute Devil product',
};

// Used only when products.js is missing or broken. Same six as the static HTML.
const FALLBACK = [
  { id: 'halos-off-hoodie', name: "halo's off hoodie", pitch: 'tiny horns stitched on the hood.', niche: 'wear', art: 'hoodie' },
  { id: 'secret-no-1', name: 'secret no. 1', pitch: 'warm amber, a little smoke. signature.', niche: 'scent', art: 'perfume-secret' },
  { id: 'little-devil-earbuds', name: 'little devil earbuds', pitch: 'horned pocket case. nobody knows what is playing.', niche: 'tech', art: 'earbuds' },
  { id: 'nice-guy-long-story-tee', name: 'nice guy, long story tee', pitch: 'red shadow peeking from the pocket.', niche: 'wear', art: 'tee' },
  { id: 'after-midnight', name: 'after midnight', pitch: 'oud and leather. for the hours nobody asks about.', niche: 'scent', art: 'perfume-midnight' },
  { id: 'night-shift-lamp', name: 'night shift lamp', pitch: 'one dial, angel white to devil red.', niche: 'tech', art: 'lamp' },
];
const NICHE_ORDER = ['wear', 'scent', 'tech'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safe = (fn) => { try { return fn(); } catch (err) { console.warn('[tcd:home]', err); return undefined; } };

/* ------------------------------------------------------------------ art */
let artSeq = 0;
/** Inline product art with gradient ids made unique, so the same art can sit on the page twice. */
function art(id, title) {
  const scope = `h${(artSeq += 1)}`;
  return renderArt(id, { title: title || STR.artFallback })
    .replace(/\bid="(a-[^"]+)"/g, `id="$1-${scope}"`)
    .replace(/url\(#(a-[^)]+)\)/g, `url(#$1-${scope})`);
}
function fillArt(root = document) {
  $$('[data-art]', root).forEach((el) => {
    if (el.firstElementChild) return;
    el.innerHTML = art(el.dataset.art, el.dataset.artTitle);
  });
}

/* ------------------------------------------------------------------ featured six */
async function loadProducts() {
  try {
    const mods = import.meta.glob('../products.js');
    const load = mods['../products.js'];
    if (!load) return null;
    const m = await load();
    return m && Array.isArray(m.products) && m.products.length ? m : null;
  } catch (err) {
    return null;
  }
}
function pickSix(list) {
  const ok = list.filter((p) => p && p.id && p.name);
  const byNiche = NICHE_ORDER.map((n) => {
    const all = ok.filter((p) => p.niche === n);
    const featured = all.filter((p) => p.featured);
    return featured.concat(all.filter((p) => !p.featured)).slice(0, 2);
  });
  const out = [];
  for (let row = 0; row < 2; row += 1) byNiche.forEach((group) => { if (group[row]) out.push(group[row]); });
  return out.length === 6 ? out : null;
}
function cardHtml(p, fmt) {
  const badges = [];
  if (p.status === 'soon') badges.push(`<span class="c-badge c-badge--soon">${esc(STR.soon)}</span>`);
  if (p.status === 'sold') badges.push(`<span class="c-badge c-badge--sold">${esc(STR.sold)}</span>`);
  const hasPrice = Number.isFinite(Number(p.price)) && p.price !== null && p.price !== undefined;
  const foot = hasPrice
    ? `<div class="c-card__foot"><span>${esc(fmt(p.price, p.currency || 'EUR'))}</span>${p.sample ? `<span class="c-badge c-badge--sample">${esc(STR.sample)}</span>` : ''}</div>`
    : '';
  return `<div class="h-feat__item"><article class="c-card" data-devil data-tilt="6" data-cursor="view" data-niche="${esc(p.niche)}">
<div class="c-card__media">${badges.length ? `<div class="c-card__badges">${badges.join('')}</div>` : ''}${art(p.art, p.name)}</div>
<div class="c-card__body"><p class="h-feat__niche">${esc(p.niche)}</p>
<h3 class="c-card__title"><a class="c-card__link" href="product.html?id=${encodeURIComponent(p.id)}">${esc(p.name)}</a></h3>
<p class="c-card__text">${esc(p.pitch || p.tagline || '')}</p>${foot}</div>
</article></div>`;
}
async function renderFeatured() {
  const grid = $('[data-featured]');
  if (!grid) return;
  const m = await loadProducts();
  let list = m ? pickSix(m.products) : null;
  const fmt = m && typeof m.formatPrice === 'function'
    ? m.formatPrice
    : (n, cur) => `${cur === 'EUR' ? '€' : `${cur} `}${n}`;
  if (!list) list = FALLBACK;
  grid.innerHTML = list.map((p) => cardHtml(p, fmt)).join('');
}

/* ------------------------------------------------------------------ hero */
function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (err) { return false; }
}
function initHero({ gsap, reduced, fine }) {
  const hero = $('[data-hero]');
  if (!hero) return;
  const host = $('[data-hero3d]', hero);
  const stage = $('.h-hero__stage', hero);
  let orb = null;
  let progress = 0;

  // 3D orb: lazy, desktop widths only, never under reduced motion. The SVG stays if anything fails.
  if (host && !reduced && window.innerWidth >= 768 && webglOk()) {
    const start = () => import('../hero3d.js').then((mod) => {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim();
      orb = mod.mount(host, { accent });
      orb.setProgress(progress);
    }).catch((err) => { console.warn('[tcd:home] hero3d', err); });
    if ('requestIdleCallback' in window) window.requestIdleCallback(start, { timeout: 1200 }); else setTimeout(start, 300);
  }
  if (reduced) return;

  hero.classList.add('is-scene');
  const title = $('.h-hero__title', hero);
  const scope = (title && title.querySelector('[aria-hidden="true"]')) || title;
  const a = scope && scope.querySelector('.h-hero__line--a');
  const b = scope && scope.querySelector('.h-hero__line--b');
  const content = $('.h-hero__content', hero);
  const lower = $('.h-hero__lower', hero);
  const ledeA = $('.h-hero__lede--a', hero);
  const ledeB = $('.h-hero__lede--b', hero);
  const hint = $('.h-hero__hint', hero);
  const badge = $('.h-hero__badge', hero);
  if (!a || !b || !content || !lower) return;

  const headerH = () => { const h = $('[data-shell="header"]'); return h ? h.offsetHeight : 0; };
  const shift = () => a.offsetHeight;
  const state = { p: 0 };
  const apply = () => {
    progress = state.p;
    hero.style.setProperty('--hp', clamp((state.p - 0.08) / 0.4, 0, 1).toFixed(3));
    if (orb) orb.setProgress(state.p);
  };

  const tl = gsap.timeline({
    defaults: { ease: 'power2.inOut' },
    scrollTrigger: { trigger: hero, start: () => `top ${headerH()}px`, end: 'bottom bottom', scrub: 0.6, invalidateOnRefresh: true },
  });
  tl.to(state, { p: 1, duration: 1, ease: 'none', onUpdate: apply }, 0);
  if (hint) tl.to(hint, { opacity: 0, duration: 0.08 }, 0);
  tl.to(a, { xPercent: -24, rotation: -5, opacity: 0, transformOrigin: '0% 100%', duration: 0.36 }, 0.06);
  tl.to(content, { y: () => shift() / 2, duration: 0.5 }, 0.06);
  tl.to(b, { y: () => -shift(), duration: 0.5 }, 0.06);
  tl.to(lower, { y: () => -shift(), duration: 0.5 }, 0.06);
  if (ledeA && ledeB) {
    tl.to(ledeA, { opacity: 0, duration: 0.12 }, 0.28);
    tl.to(ledeB, { opacity: 1, duration: 0.14 }, 0.42);
  }
  if (badge) tl.to(badge, { rotation: 300, duration: 1, ease: 'none' }, 0);
  // hold the finished frame for the last stretch, then let it scroll away
  tl.to({}, { duration: 0.01 }, 0.99);

  // pointer: spotlight, a small drift on the headline, and the fallback orb's eyes
  if (fine && title) {
    const tx = gsap.quickTo(title, 'x', { duration: 0.8, ease: 'power3.out' });
    const ty = gsap.quickTo(title, 'y', { duration: 0.8, ease: 'power3.out' });
    const fallback = $('[data-hero-fallback]', hero);
    let raf = 0; let px = 0; let py = 0;
    const frame = () => {
      raf = 0;
      const r = stage.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      const nx = clamp((px - r.left) / r.width, 0, 1);
      const ny = clamp((py - r.top) / r.height, 0, 1);
      hero.style.setProperty('--mx', `${(nx * 100).toFixed(1)}%`);
      hero.style.setProperty('--my', `${(ny * 100).toFixed(1)}%`);
      tx((nx - 0.5) * -22); ty((ny - 0.5) * -12);
      if (fallback && !(host && host.classList.contains('is-3d'))) {
        const f = fallback.getBoundingClientRect();
        const ex = clamp((px - (f.left + f.width / 2)) / 300, -1, 1) * 8;
        const ey = clamp((py - (f.top + f.height / 2)) / 300, -1, 1) * 8;
        fallback.style.setProperty('--ex', `${ex.toFixed(1)}px`);
        fallback.style.setProperty('--ey', `${ey.toFixed(1)}px`);
      }
    };
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      px = e.clientX; py = e.clientY;
      if (!raf) raf = requestAnimationFrame(frame);
    }, { passive: true });
  }
}

/* ------------------------------------------------------------------ marquee band skew */
function initBand({ gsap, ScrollTrigger, lenis }) {
  const rows = $$('.h-band__row');
  if (!rows.length || !lenis) return;
  const skew = rows.map((row) => gsap.quickTo(row, 'skewX', { duration: 0.5, ease: 'power3.out' }));
  lenis.on('scroll', (e) => {
    const v = clamp((e && e.velocity ? e.velocity : 0) * -0.22, -9, 9);
    skew.forEach((fn, i) => fn(i % 2 ? -v : v));
  });
  ScrollTrigger.addEventListener('scrollEnd', () => skew.forEach((fn) => fn(0)));
}

/* ------------------------------------------------------------------ entrances */
const hiddenByUs = [];
const ENTER = {
  fan: (i) => ({ opacity: 0, y: 110, rotation: [-9, 0, 9][i % 3], rotationX: 18, transformPerspective: 1200 }),
  flip: (i) => ({ opacity: 0, y: 90, rotationY: i % 2 ? 38 : -38, rotation: i % 2 ? 5 : -5, scale: 0.86, transformPerspective: 1200 }),
  rise: () => ({ opacity: 0, y: 60, rotation: -3 }),
};
function enter({ gsap, ScrollTrigger }, items, kind, stagger = 0.09) {
  if (!items.length) return;
  const from = ENTER[kind] || ENTER.rise;
  items.forEach((el, i) => gsap.set(el, from(i)));
  hiddenByUs.push(...items);
  ScrollTrigger.batch(items, {
    start: 'top 90%',
    once: true,
    onEnter: (batch) => gsap.to(batch, {
      opacity: 1, y: 0, rotation: 0, rotationX: 0, rotationY: 0, scale: 1,
      duration: 1.15, ease: 'expo.out', stagger, overwrite: true,
    }),
  });
}

/* ------------------------------------------------------------------ manifesto */
function initManifesto({ gsap }) {
  $$('[data-mani]').forEach((el) => {
    const s = split(el, 'words');
    if (!s.words.length) return;
    gsap.fromTo(s.words, { opacity: 0.14 }, {
      opacity: 1, ease: 'none', stagger: 0.12,
      scrollTrigger: { trigger: el, start: 'top 82%', end: 'bottom 48%', scrub: 0.5 },
    });
  });
}

/* ------------------------------------------------------------------ spotlights */
function initSpotlights({ gsap, fine }) {
  // big outlined words drift sideways with the scroll
  $$('[data-drift]').forEach((el) => {
    const dir = parseFloat(el.dataset.drift) || 1;
    gsap.fromTo(el, { xPercent: dir > 0 ? -22 : 0 }, {
      xPercent: dir > 0 ? 0 : -22, ease: 'none',
      scrollTrigger: { trigger: el.parentElement, start: 'top bottom', end: 'bottom top', scrub: 0.6 },
    });
  });

  // scent: everything turns with the scroll
  const scent = $('[data-scent]');
  if (scent) {
    const st = { trigger: scent, start: 'top bottom', end: 'bottom top', scrub: 0.7 };
    gsap.fromTo($('.h-scent__ring', scent), { rotation: -50 }, { rotation: 130, ease: 'none', transformOrigin: '50% 50%', scrollTrigger: st });
    gsap.fromTo($('.h-scent__orbit', scent), { rotation: 70 }, { rotation: -70, ease: 'none', scrollTrigger: st });
    gsap.fromTo($$('.h-scent__moon > div', scent), { rotation: -70 }, { rotation: 70, ease: 'none', scrollTrigger: st });
    gsap.fromTo($('.h-scent__bottle', scent), { rotation: -12, scale: 0.92 }, { rotation: 12, scale: 1.04, ease: 'none', scrollTrigger: st });
  }

  // tech: the hidden side opens through a growing circle that follows the pointer
  const tech = $('[data-tech]');
  if (tech) {
    gsap.fromTo(tech, { '--r': 0 }, {
      '--r': 76, ease: 'none',
      scrollTrigger: { trigger: tech, start: 'top 82%', end: 'center 38%', scrub: 0.6 },
    });
    if (fine) {
      tech.addEventListener('pointermove', (e) => {
        const r = tech.getBoundingClientRect();
        tech.style.setProperty('--cx', `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
        tech.style.setProperty('--cy', `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
      }, { passive: true });
      tech.addEventListener('pointerleave', () => { tech.style.removeProperty('--cx'); tech.style.removeProperty('--cy'); });
    }
  }
}

/* ------------------------------------------------------------------ founder: the shadow gets longer */
function initFounder({ gsap }) {
  $$('.h-founder__mark').forEach((mark) => {
    const st = { trigger: mark, start: 'top 92%', end: 'bottom 8%', scrub: 0.6 };
    gsap.fromTo(mark, { '--s': 0.04 }, { '--s': 1, ease: 'none', scrollTrigger: st });
    const trail = $('.h-founder__trail', mark);
    if (trail) gsap.fromTo(trail, { rotation: -10 }, { rotation: 12, ease: 'none', transformOrigin: '45% 62%', scrollTrigger: st });
    const logo = $('.h-founder__logo', mark);
    if (logo) gsap.fromTo(logo, { rotation: 5 }, { rotation: -4, ease: 'none', scrollTrigger: st });
  });
}

/* ------------------------------------------------------------------ pick. add. whatsapp. done. */
function initHow({ gsap }) {
  const how = $('[data-how]');
  if (!how) return;
  const wrap = $('.h-how__wrap', how);
  const steps = $$('.h-step', how);
  const words = $$('.h-how__title span', how);
  if (!wrap || !steps.length) return;
  how.classList.add('is-scene');
  const line = $('.h-how__line', how);
  let marks = [0.03, 0.3, 0.58, 0.86];
  // where each icon sits along the line (the line is vertical on small screens)
  const measure = () => {
    if (!line) return;
    const l = line.getBoundingClientRect();
    const across = l.width > l.height;
    const len = across ? l.width : l.height;
    if (!len) return;
    marks = steps.map((el) => {
      const icon = $('.h-step__icon', el);
      if (!icon) return 1;
      const r = icon.getBoundingClientRect();
      const at = across ? r.left + r.width / 2 - l.left : r.top + r.height / 2 - l.top;
      return clamp(at / len - 0.04, 0.02, 0.96);
    });
  };
  // each circle waits small and pops in as the line reaches it
  const icons = steps.map((el) => $('.h-step__icon', el));
  const lit = steps.map(() => false);
  icons.forEach((icon) => { if (icon) gsap.set(icon, { scale: 0.6 }); });
  hiddenByUs.push(...icons.filter(Boolean));
  const pop = (i, on) => {
    if (lit[i] === on) return;
    lit[i] = on;
    if (icons[i]) gsap.to(icons[i], { scale: on ? 1 : 0.6, duration: on ? 0.6 : 0.3, ease: on ? 'back.out(2.4)' : 'power2.out', overwrite: true });
  };
  const state = { p: 0 };
  const apply = () => {
    wrap.style.setProperty('--lp', state.p.toFixed(3));
    steps.forEach((el, i) => { const on = state.p >= (marks[i] ?? 1); el.classList.toggle('is-on', on); pop(i, on); });
    words.forEach((el, i) => el.classList.toggle('is-on', state.p >= (marks[i] ?? 1)));
  };
  gsap.to(state, {
    p: 1, ease: 'none', onUpdate: apply,
    scrollTrigger: { trigger: wrap, start: 'top 78%', end: 'bottom 62%', scrub: 0.5, onRefresh: measure },
  });
}

/* ------------------------------------------------------------------ touch: cards turn a little with the scroll */
// Pointer tilt needs a mouse. Without one, the featured cards and niche tiles get a light
// scroll-scrubbed turn instead (transform only; never under reduced motion, see boot).
function initTouchTilt({ gsap }) {
  if (!window.matchMedia('(hover: none)').matches) return;
  const turn = (el, trigger, i, deg, lift) => {
    const dir = i % 2 ? -1 : 1;
    gsap.fromTo(el, { rotationY: dir * deg, y: lift, transformPerspective: 900 }, {
      rotationY: -dir * deg, y: -lift, ease: 'none',
      scrollTrigger: { trigger, start: 'top bottom', end: 'bottom top', scrub: 0.6 },
    });
  };
  $$('.h-feat__item').forEach((item, i) => { const card = $('.c-card', item); if (card) turn(card, item, i, 9, 12); });
  $$('.h-trio__item').forEach((item, i) => { const tile = $('.h-niche', item); if (tile) turn(tile, item, i, 7, 10); });
}

/* ------------------------------------------------------------------ closing wordmark */
function initWordmark({ gsap, ScrollTrigger, fine }) {
  const word = $('[data-wordmark]');
  if (!word) return;
  const chars = split(word, 'chars').chars;
  if (!chars.length) return;
  gsap.from(chars, {
    yPercent: 85, rotation: (i) => (i % 2 ? 9 : -9), ease: 'power2.out', stagger: 0.06,
    scrollTrigger: { trigger: word, start: 'top 105%', end: 'top 55%', scrub: 0.6 },
  });
  if (!fine) return;
  const section = word.closest('section') || word;
  const lift = chars.map((c) => gsap.quickTo(c, 'y', { duration: 0.5, ease: 'power3.out' }));
  const lean = chars.map((c) => gsap.quickTo(c, 'skewX', { duration: 0.5, ease: 'power3.out' }));
  const grow = chars.map((c) => gsap.quickTo(c, 'scaleY', { duration: 0.5, ease: 'power3.out' }));
  let centres = [];
  const measure = () => { centres = chars.map((c) => { const r = c.getBoundingClientRect(); return r.left + r.width / 2; }); };
  measure();
  ScrollTrigger.addEventListener('refresh', measure);
  let raf = 0; let px = 0; let py = 0;
  const frame = () => {
    raf = 0;
    const r = word.getBoundingClientRect();
    const near = clamp(1 - Math.abs(py - (r.top + r.height / 2)) / (r.height * 1.6), 0, 1);
    const reach = Math.max(r.width * 0.16, 120);
    chars.forEach((c, i) => {
      const d = (px - centres[i]) / reach;
      const k = Math.max(0, 1 - Math.abs(d)) * near;
      lift[i](-k * r.height * 0.22);
      lean[i](clamp(d, -1, 1) * k * -14);
      grow[i](1 + k * 0.22);
    });
  };
  section.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    px = e.clientX; py = e.clientY;
    if (!raf) raf = requestAnimationFrame(frame);
  }, { passive: true });
  section.addEventListener('pointerleave', () => {
    chars.forEach((c, i) => { lift[i](0); lean[i](0); grow[i](1); });
  });
}

/* ------------------------------------------------------------------ boot */
safe(() => fillArt(document));

ready.then(async (env) => {
  await safe(renderFeatured);
  safe(() => fillArt(document));
  const grid = $('[data-featured]');
  if (grid) safe(() => scan(grid));
  if (!env || !env.gsap) return;

  safe(() => initHero(env));
  if (env.reduced) return;
  try {
    initBand(env);
    $$('[data-enter]').forEach((group) => enter(env, Array.from(group.children), group.dataset.enter));
    enter(env, $$('.h-feat__item'), 'flip', 0.08);
    initManifesto(env);
    initSpotlights(env);
    initFounder(env);
    initHow(env);
    initTouchTilt(env);
    initWordmark(env);
  } catch (err) {
    console.warn('[tcd:home]', err);
    // never leave anything hidden because a scene failed
    safe(() => env.gsap.set(hiddenByUs, { clearProps: 'all' }));
  }
  refresh();
});
