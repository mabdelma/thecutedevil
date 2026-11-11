// The Cute Devil: shared motion hooks. Owner: shell.
// Markup hooks: data-reveal, data-stagger, data-split, data-parallax, data-magnetic,
// data-tilt, data-marquee, data-devil. See web/STYLEGUIDE.md.
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const ctx = { lenis: null, reduced: false, fine: false, on: false };
const seen = new WeakSet();
const HORNS = '<svg viewBox="0 0 64 22" aria-hidden="true" focusable="false"><path d="M6 22C2 12 4 4 10 0c0 9 4 16 12 22z"/><path d="M58 22c4-10 2-18-4-22 0 9-4 16-12 22z"/></svg>';
const NO_CHILDREN = 'img,input,textarea,select,svg,video,canvas,picture,hr,br';
const DEVIL_MAX = 24;
const EASE = 'expo.out';

/* ---------------------------------------------------------------- init */
export function init(options = {}) {
  Object.assign(ctx, options);
  ctx.on = !ctx.reduced;
  if (ctx.on && ctx.fine) startDevilPointer();
  if (ctx.on) gsap.ticker.add(tickMarquees);
}

/* ---------------------------------------------------------------- reveal */
let revealIO = null;
function getRevealIO() {
  if (revealIO) return revealIO;
  revealIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting && e.boundingClientRect.bottom >= 0) continue;
      revealIO.unobserve(e.target);
      const play = e.target._tcdPlay;
      if (play) { e.target._tcdPlay = null; try { play(); } catch (err) { show(e.target); } }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.01 });
  return revealIO;
}
function show(el) { el.classList.add('is-in', 'is-split'); }
function onView(el, play) { el._tcdPlay = play; getRevealIO().observe(el); }

const FROM = {
  up: { opacity: 0, y: 44 },
  fade: { opacity: 0 },
  scale: { opacity: 0, scale: 0.9 },
  clip: { opacity: 1, clipPath: 'inset(0% 0% 100% 0%)' },
};
const TO = {
  up: { opacity: 1, y: 0 },
  fade: { opacity: 1 },
  scale: { opacity: 1, scale: 1 },
  clip: { opacity: 1, clipPath: 'inset(0% 0% 0% 0%)' },
};
function revealTween(el, type, delay) {
  const t = FROM[type] ? type : 'up';
  el.classList.add('is-in');
  gsap.fromTo(el, FROM[t], {
    ...TO[t], duration: t === 'clip' ? 1 : 0.8, ease: EASE, delay, overwrite: 'auto',
    onComplete: () => gsap.set(el, { clearProps: 'opacity,clipPath,transform' }),
  });
}
function setupReveal(el) {
  const delay = parseFloat(el.dataset.delay) || 0;
  onView(el, () => revealTween(el, el.dataset.reveal, delay));
}
function setupStagger(el) {
  const each = parseFloat(el.dataset.stagger) || 0.1;
  const base = parseFloat(el.dataset.delay) || 0;
  onView(el, () => {
    el.classList.add('is-in');
    Array.from(el.children).forEach((child, i) => {
      seen.add(child);
      revealTween(child, child.dataset.reveal || 'up', base + i * each);
    });
  });
}

/* ---------------------------------------------------------------- split text (hand made) */
function splitInto(source, target, type, bag) {
  source.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      node.textContent.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) { target.appendChild(document.createTextNode(' ')); return; }
        const w = document.createElement('span');
        w.className = 'c-split__w';
        if (type === 'chars') {
          for (const ch of Array.from(part)) {
            const c = document.createElement('span');
            c.className = 'c-split__c';
            c.textContent = ch;
            w.appendChild(c);
            bag.chars.push(c);
          }
        } else {
          const i = document.createElement('span');
          i.className = 'c-split__i';
          i.textContent = part;
          w.appendChild(i);
          bag.inners.push(i);
        }
        bag.words.push(w);
        target.appendChild(w);
      });
    } else if (node.nodeType === 1) {
      if (node.tagName === 'BR') { target.appendChild(node.cloneNode()); return; }
      const clone = node.cloneNode(false);
      splitInto(node, clone, type, bag);
      target.appendChild(clone);
    }
  });
}

/** Split an element by hand. Returns { words, chars, targets, lines() }.
 *  Screen readers get the original text; the visual copy is aria-hidden. */
export function split(el, type = 'words') {
  if (el._tcdSplit) return el._tcdSplit;
  const bag = { words: [], chars: [], inners: [] };
  const visual = document.createElement('span');
  visual.setAttribute('aria-hidden', 'true');
  splitInto(el, visual, type, bag);
  const sr = document.createElement('span');
  sr.className = 'u-sr';
  sr.textContent = el.textContent.replace(/\s+/g, ' ').trim();
  el.replaceChildren(sr, visual);
  const targets = type === 'chars' ? bag.chars : bag.inners;
  const result = {
    type, words: bag.words, chars: bag.chars, targets,
    /** index of the visual line each word sits on (measure after layout) */
    lines() {
      let line = -1; let top = null;
      return bag.words.map((w) => {
        const t = Math.round(w.getBoundingClientRect().top);
        if (top === null || Math.abs(t - top) > 4) { line += 1; top = t; }
        return line;
      });
    },
  };
  el._tcdSplit = result;
  el.classList.add('is-split');
  return result;
}
function setupSplit(el) {
  const type = ['chars', 'words', 'lines'].includes(el.dataset.split) ? el.dataset.split : 'words';
  const s = split(el, type);
  const delay = parseFloat(el.dataset.delay) || 0;
  gsap.set(s.targets, { yPercent: 125 });
  onView(el, () => {
    el.classList.add('is-in');
    const vars = { yPercent: 0, duration: type === 'chars' ? 0.7 : 0.9, ease: EASE, overwrite: 'auto' };
    if (type === 'lines') {
      const lines = s.lines();
      gsap.to(s.targets, { ...vars, delay: (i) => delay + lines[i] * 0.1 });
    } else {
      gsap.to(s.targets, { ...vars, delay, stagger: type === 'chars' ? 0.022 : 0.06 });
    }
  });
}

/* ---------------------------------------------------------------- parallax */
function setupParallax(el) {
  const speed = parseFloat(el.dataset.parallax) || 0.2;
  const range = () => speed * Math.min(window.innerHeight, 900) * 0.5;
  gsap.fromTo(el, { y: () => range() }, {
    y: () => -range(), ease: 'none',
    scrollTrigger: { trigger: el.parentElement || el, start: 'top bottom', end: 'bottom top', scrub: true, invalidateOnRefresh: true },
  });
}

/* ---------------------------------------------------------------- magnetic (large CTAs only) */
function setupMagnetic(el) {
  const strength = parseFloat(el.dataset.magnetic) || 0.3;
  const label = el.querySelector('.c-btn__label');
  let ox = 0; let oy = 0;
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - (r.left - ox + r.width / 2);
    const my = e.clientY - (r.top - oy + r.height / 2);
    ox = Math.max(-14, Math.min(14, mx * strength));
    oy = Math.max(-10, Math.min(10, my * strength));
    gsap.to(el, { x: ox, y: oy, duration: 0.35, ease: 'power3.out', overwrite: 'auto' });
    if (label) gsap.to(label, { x: ox * 0.35, y: oy * 0.35, duration: 0.35, ease: 'power3.out', overwrite: 'auto' });
  });
  el.addEventListener('pointerleave', () => {
    ox = 0; oy = 0;
    gsap.to(el, { x: 0, y: 0, duration: 0.8, ease: 'elastic.out(1, 0.4)', overwrite: 'auto' });
    if (label) gsap.to(label, { x: 0, y: 0, duration: 0.8, ease: 'elastic.out(1, 0.4)', overwrite: 'auto' });
  });
}

/* ---------------------------------------------------------------- tilt */
function setupTilt(el) {
  const max = Math.min(parseFloat(el.dataset.tilt) || 8, 14);
  el.addEventListener('pointermove', (e) => {
    if ((e.pointerType && e.pointerType !== 'mouse') || window.innerWidth < 768) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    gsap.to(el, { rotationY: px * max * 2, rotationX: -py * max * 2, transformPerspective: 900, duration: 0.4, ease: 'power3.out', overwrite: 'auto' });
  });
  el.addEventListener('pointerleave', () => {
    gsap.to(el, { rotationX: 0, rotationY: 0, duration: 0.6, ease: 'power3.out', overwrite: 'auto' });
  });
}

/* ---------------------------------------------------------------- marquee */
const marquees = new Set();
let marqueeIO = null;
function buildMarquee(el) {
  const group = document.createElement('div');
  group.className = 'c-marquee__group';
  group.append(...Array.from(el.childNodes));
  const track = document.createElement('div');
  track.className = 'c-marquee__track';
  track.appendChild(group);
  el.appendChild(track);
  return { el, track, group };
}
function fillMarquee(m) {
  m.w = m.group.getBoundingClientRect().width;
  if (!m.w) return;
  const need = Math.ceil(m.el.getBoundingClientRect().width / m.w) + 1;
  while (m.track.children.length < need + 1) {
    const clone = m.group.cloneNode(true);
    clone.setAttribute('aria-hidden', 'true');
    clone.querySelectorAll('a,button,[tabindex]').forEach((n) => n.setAttribute('tabindex', '-1'));
    m.track.appendChild(clone);
  }
}
function setupMarquee(el) {
  const m = buildMarquee(el);
  if (!ctx.on) return; // static, wraps (see motion.css)
  const v = parseFloat(el.dataset.marquee);
  m.speed = Number.isFinite(v) && v !== 0 ? v : 40;
  m.x = 0; m.live = false;
  fillMarquee(m);
  if ('ResizeObserver' in window) new ResizeObserver(() => fillMarquee(m)).observe(el);
  if (!marqueeIO) {
    marqueeIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.target._tcdMarquee) e.target._tcdMarquee.live = e.isIntersecting; });
    }, { rootMargin: '100px' });
  }
  el._tcdMarquee = m;
  marqueeIO.observe(el);
  marquees.add(m);
}
function tickMarquees(time, deltaMs) {
  if (!marquees.size || document.hidden) return;
  const dt = Math.min(deltaMs, 64) / 1000;
  const boost = ctx.lenis ? Math.min(Math.abs(ctx.lenis.velocity || 0) * 9, 420) : 0;
  marquees.forEach((m) => {
    if (!m.live || !m.w) return;
    if (!m.el.isConnected) { marquees.delete(m); return; }
    const dir = m.speed < 0 ? 1 : -1;
    m.x += dir * (Math.abs(m.speed) + boost) * dt;
    m.x = ((m.x % m.w) - m.w) % m.w;
    m.track.style.transform = `translate3d(${m.x.toFixed(2)}px,0,0)`;
  });
}

/* ---------------------------------------------------------------- devil shadow */
const devils = new Set(); // in view, max DEVIL_MAX
let devilIO = null;
const pointer = { x: -1, y: -1, moved: false, raf: 0 };

function setupDevil(el) {
  if (el.dataset.devil !== 'plain' && !el.matches(NO_CHILDREN) && !el.querySelector(':scope > .c-horns')) {
    const horns = document.createElement('span');
    horns.className = 'c-horns';
    horns.setAttribute('aria-hidden', 'true');
    horns.innerHTML = HORNS;
    el.prepend(horns);
  }
  if (!(ctx.on && ctx.fine)) return; // fixed offset from CSS
  if (!devilIO) {
    devilIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { if (devils.size < DEVIL_MAX) devils.add(e.target); } else { devils.delete(e.target); }
      });
      pointer.moved = true; queueDevil();
    }, { rootMargin: '40px' });
  }
  el._tcdV = { x: 0.7, y: -0.7 };
  devilIO.observe(el);
}
function startDevilPointer() {
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = true; queueDevil();
  }, { passive: true });
  window.addEventListener('scroll', () => { if (pointer.x >= 0) { pointer.moved = true; queueDevil(); } }, { passive: true });
}
function queueDevil() { if (!pointer.raf) pointer.raf = requestAnimationFrame(frameDevil); }
function frameDevil() {
  pointer.raf = 0;
  if (pointer.x < 0 || !devils.size) return;
  const list = [];
  devils.forEach((el) => { if (!el.isConnected) devils.delete(el); else list.push(el); });
  const rects = list.map((el) => el.getBoundingClientRect()); // read
  let busy = false;
  list.forEach((el, i) => { // write
    const r = rects[i];
    const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
    let tx = (cx - pointer.x) / Math.max(Math.abs(cx - pointer.x), 140, r.width / 2);
    let ty = (cy - pointer.y) / Math.max(Math.abs(cy - pointer.y), 140, r.height / 2);
    tx = tx * 0.8 + 0.25; ty = ty * 0.8 - 0.25; // lean up-right like the logo
    const len = Math.hypot(tx, ty);
    if (len > 1) { tx /= len; ty /= len; }
    const v = el._tcdV || (el._tcdV = { x: 0.7, y: -0.7 });
    v.x += (tx - v.x) * 0.16; v.y += (ty - v.y) * 0.16;
    if (Math.abs(tx - v.x) > 0.004 || Math.abs(ty - v.y) > 0.004) busy = true;
    el.style.setProperty('--dx', `${v.x.toFixed(3)}px`);
    el.style.setProperty('--dy', `${v.y.toFixed(3)}px`);
    el.classList.toggle('is-devil-down', v.y > 0.12);
  });
  pointer.moved = false;
  if (busy) queueDevil();
}

/* ---------------------------------------------------------------- public */
function each(root, selector, fn) {
  const list = [];
  if (root.nodeType === 1 && root.matches(selector)) list.push(root);
  root.querySelectorAll(selector).forEach((n) => list.push(n));
  list.forEach((el) => {
    const key = `_tcd:${selector}`;
    if (el[key]) return;
    el[key] = true;
    try { fn(el); } catch (err) { show(el); }
  });
}

/** Wire every motion hook inside root. Safe to call again after injecting DOM. */
export function scan(root = document) {
  if (!root || !root.querySelectorAll) return;
  each(root, '[data-devil]', setupDevil);
  each(root, '[data-marquee]', setupMarquee);
  if (!ctx.on) return;
  each(root, '[data-split]:not([data-manual])', (el) => { seen.add(el); setupSplit(el); });
  each(root, '[data-stagger]', (el) => { Array.from(el.children).forEach((c) => seen.add(c)); setupStagger(el); });
  each(root, '[data-reveal]:not([data-manual])', (el) => { if (!seen.has(el)) setupReveal(el); });
  each(root, '[data-parallax]', setupParallax);
  if (ctx.fine) {
    each(root, '[data-magnetic]', setupMagnetic);
    each(root, '[data-tilt]', setupTilt);
  }
}

/** Recalculate scroll positions after layout changes (images, filters, accordions). */
export function refresh() {
  try { ScrollTrigger.refresh(); } catch (err) { /* not registered yet */ }
}

/* ---------------------------------------------------------------- page transition */
const WIPE_KEY = 'tcd:wipe';
function wipeEl() {
  let el = document.querySelector('.c-wipe');
  if (!el) {
    el = document.createElement('div');
    el.className = 'c-wipe';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}
/** Finish the wipe started on the previous page. Call as early as possible. */
export function wipeEnter(allowed) {
  let pending = false;
  try { pending = sessionStorage.getItem(WIPE_KEY) === '1'; sessionStorage.removeItem(WIPE_KEY); } catch (err) { /* private mode */ }
  if (!pending || !allowed) return;
  const el = wipeEl();
  el.className = 'c-wipe is-covering';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.className = 'c-wipe is-out';
    setTimeout(() => el.remove(), 900);
  }));
}
/** Intercept internal page links and cover the screen before leaving. */
export function wipeLinks(allowed) {
  // back/forward cache: never come back to a covered page
  window.addEventListener('pageshow', (e) => { if (e.persisted) document.querySelectorAll('.c-wipe').forEach((n) => n.remove()); });
  if (!allowed) return;
  document.addEventListener('click', (e) => {
    let url;
    try {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('data-no-wipe')) return;
      url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) return;
      if (url.pathname === window.location.pathname) return; // same page: hash or query change
    } catch (err) { return; }
    const go = () => { if (go.done) return; go.done = true; window.location.href = url.href; };
    try {
      e.preventDefault();
      sessionStorage.setItem(WIPE_KEY, '1');
      const el = wipeEl();
      el.className = 'c-wipe';
      void el.offsetWidth;
      el.className = 'c-wipe is-in';
      el.addEventListener('transitionend', go, { once: true });
      setTimeout(go, 560);
    } catch (err) { go(); }
  });
}
