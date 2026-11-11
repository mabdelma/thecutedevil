// The Cute Devil: boot. Owner: shell.
// Contract: `ready` resolves with { gsap, ScrollTrigger, lenis|null, reduced, fine }; `theme` is { get, set, list }.
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import * as shell from './shell.js';
import * as motion from './motion.js';
import { initCursor } from './cursor.js';

const THEME_KEY = 'tcd:theme';
const THEMES = ['cream', 'red', 'purple', 'blue']; // first one is the default
const root = document.documentElement;

export const theme = {
  list: THEMES,
  get() {
    const t = root.getAttribute('data-theme');
    return THEMES.includes(t) ? t : THEMES[0];
  },
  set(name) {
    if (!THEMES.includes(name)) return;
    root.setAttribute('data-theme', name);
    try { localStorage.setItem(THEME_KEY, name); } catch (err) { /* private mode */ }
    document.dispatchEvent(new CustomEvent('tcd:theme', { detail: { theme: name } }));
  },
};

const step = (fn) => { try { return fn(); } catch (err) { console.warn('[tcd]', err); return undefined; } };

function boot() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  let lenis = null;

  // finish the page-transition wipe first so the new page never flashes uncovered for long
  step(() => motion.wipeEnter(!reduced));

  if (!THEMES.includes(root.getAttribute('data-theme'))) root.setAttribute('data-theme', THEMES[0]);
  step(() => shell.mount(theme));

  step(() => {
    gsap.registerPlugin(ScrollTrigger);
    gsap.defaults({ ease: 'power3.out', duration: 0.6 });
  });

  if (!reduced) {
    step(() => {
      lenis = new Lenis({ lerp: 0.1, anchors: true, autoRaf: false });
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add((time) => lenis.raf(time * 1000));
      gsap.ticker.lagSmoothing(0);
      // any module may lock page scroll by toggling html.is-locked (menu, cart drawer)
      new MutationObserver(() => {
        if (root.classList.contains('is-locked')) lenis.stop(); else lenis.start();
      }).observe(root, { attributes: true, attributeFilter: ['class'] });
    });
  }

  step(() => initCursor({ gsap, reduced, fine }));
  step(() => motion.init({ lenis, reduced, fine }));

  // html.motion switches on the hidden start states; if scanning fails, show everything
  root.classList.add(reduced ? 'motion-off' : 'motion');
  try {
    motion.scan(document);
  } catch (err) {
    console.warn('[tcd]', err);
    root.classList.remove('motion');
    root.classList.add('motion-off');
  }
  step(() => motion.wipeLinks(!reduced));

  const refresh = () => step(() => ScrollTrigger.refresh());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
  window.addEventListener('load', refresh, { once: true });

  return { gsap, ScrollTrigger, lenis, reduced, fine };
}

export const ready = new Promise((resolve) => {
  let result;
  try {
    result = boot();
  } catch (err) {
    console.warn('[tcd]', err);
    root.classList.remove('motion');
    root.classList.add('motion-off');
    result = { gsap, ScrollTrigger, lenis: null, reduced: true, fine: false };
  }
  resolve(result);
});

// The cart UI belongs to the shop developer. Loaded only if the file exists, never fatal.
ready.then(() => {
  try {
    const mods = import.meta.glob('./cart-ui.js');
    const load = mods['./cart-ui.js'];
    if (load) load().catch((err) => console.warn('[tcd] cart-ui', err));
  } catch (err) { console.warn('[tcd] cart-ui', err); }
});
