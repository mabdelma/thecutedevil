// The Cute Devil: long-form pages (faq, shipping, terms, privacy, cookies, legal). Owner: pages.
// Everything here is an enhancement: the pages read and work without it (real anchors, real <details>).
const STR = {
  cleared: 'Done. Your saved theme and bag were removed from this device.',
  clearedEmpty: 'Nothing was saved on this device. It is still clean.',
  clearFailed: 'Your browser blocked access to storage. Please clear the site data from your browser settings.',
};

const KEYS = ['tcd:theme', 'tcd:cart'];
const DEFAULT_THEME = 'cream';
const wide = window.matchMedia('(min-width: 64em)');

/* ---------------------------------------------------------------- table of contents */
function initToc() {
  const toc = document.querySelector('[data-toc]');
  if (!toc) return;
  const box = toc.querySelector('details');
  const title = toc.querySelector('summary');
  const links = Array.from(toc.querySelectorAll('a[href^="#"]'));

  // desktop: always open and not a toggle; mobile: starts collapsed
  const layout = () => {
    if (!box) return;
    box.open = wide.matches;
    if (title) { if (wide.matches) title.setAttribute('tabindex', '-1'); else title.removeAttribute('tabindex'); }
  };
  if (title) title.addEventListener('click', (e) => { if (wide.matches) e.preventDefault(); });
  if (wide.addEventListener) wide.addEventListener('change', layout); else wide.addListener(layout);
  layout();

  // on mobile, fold the list before the page scrolls so the target position is right
  toc.addEventListener('click', (e) => {
    if (box && !wide.matches && e.target.closest('a[href^="#"]')) box.open = false;
  });

  // highlight the section being read
  const targets = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  if (!targets.length) return;
  let ticking = false;
  const paint = () => {
    ticking = false;
    const line = Math.min(window.innerHeight * 0.35, 260);
    let current = targets[0];
    for (const t of targets) { if (t.getBoundingClientRect().top <= line) current = t; }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4 && targets[targets.length - 1].getBoundingClientRect().top < window.innerHeight) {
      current = targets[targets.length - 1];
    }
    links.forEach((a) => {
      if (a.hash === `#${current.id}`) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    });
  };
  const queue = () => { if (!ticking) { ticking = true; requestAnimationFrame(paint); } };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue, { passive: true });
  paint();
}

/* ---------------------------------------------------------------- FAQ: open the question named in the URL */
function initFaq() {
  const openFromHash = () => {
    if (!location.hash) return;
    let el = null;
    try { el = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (err) { /* bad hash */ }
    if (el && el.matches('details.c-faq')) el.open = true;
  };
  window.addEventListener('hashchange', openFromHash);
  openFromHash();
}

/* ---------------------------------------------------------------- cookies page: clear saved data */
function initClear() {
  const button = document.querySelector('[data-clear-storage]');
  const status = document.querySelector('[data-clear-status]');
  if (!button) return;
  const say = (text, error) => {
    if (!status) return;
    status.classList.toggle('is-error', Boolean(error));
    status.textContent = '';
    // a fresh text node on the next frame so screen readers announce a repeated message
    requestAnimationFrame(() => { status.textContent = text; });
  };
  button.addEventListener('click', async () => {
    let had = false;
    try {
      had = KEYS.some((k) => localStorage.getItem(k) !== null);
    } catch (err) { say(STR.clearFailed, true); return; }

    // empty the live cart first so the open page and other tabs follow, then drop the keys
    try { const cart = await import('../cart.js'); cart.clear(); } catch (err) { /* cart module is optional here */ }
    try {
      KEYS.forEach((k) => localStorage.removeItem(k));
    } catch (err) { say(STR.clearFailed, true); return; }

    document.documentElement.setAttribute('data-theme', DEFAULT_THEME);
    document.dispatchEvent(new CustomEvent('tcd:theme', { detail: { theme: DEFAULT_THEME } }));
    document.dispatchEvent(new CustomEvent('tcd:cart', { detail: { count: 0, total: 0, reason: 'clear' } }));
    say(had ? STR.cleared : STR.clearedEmpty, false);
  });
}

function init() {
  initToc();
  initFaq();
  initClear();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
