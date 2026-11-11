// The Cute Devil: decorative cursor follower (dot + horned ring).
// It never hides or replaces the native cursor. Fine pointers only, off under reduced motion.
// Markup hook: data-cursor="link|view|drag|hide".
const STR = { view: 'view', drag: 'drag' };

const INTERACTIVE = 'a[href],button,summary,[role="button"],[role="radio"],[role="tab"],select';
const TEXTUAL = 'input:not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]),textarea';
const MODES = ['link', 'view', 'drag', 'hide', 'text'];

export function initCursor({ gsap, reduced, fine }) {
  if (!gsap || reduced || !fine) return null;

  const el = document.createElement('div');
  el.className = 'c-cursor';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<span class="c-cursor__ring"><span class="c-cursor__shape"><svg class="c-cursor__horns" viewBox="0 0 64 22" focusable="false"><path d="M6 22C2 12 4 4 10 0c0 9 4 16 12 22z"/><path d="M58 22c4-10 2-18-4-22 0 9-4 16-12 22z"/></svg></span><span class="c-cursor__label"></span></span><span class="c-cursor__dot"></span>';
  document.body.appendChild(el);

  const ring = el.querySelector('.c-cursor__ring');
  const dot = el.querySelector('.c-cursor__dot');
  const label = el.querySelector('.c-cursor__label');
  const ringX = gsap.quickTo(ring, 'x', { duration: 0.35, ease: 'power3.out' });
  const ringY = gsap.quickTo(ring, 'y', { duration: 0.35, ease: 'power3.out' });
  const dotX = gsap.quickSetter(dot, 'x', 'px');
  const dotY = gsap.quickSetter(dot, 'y', 'px');
  let started = false;
  let mode = '';

  function setMode(next) {
    if (next === mode) return;
    MODES.forEach((m) => el.classList.toggle(`is-${m}`, m === next));
    label.textContent = STR[next] || '';
    mode = next;
  }
  function modeFor(target) {
    if (!target || !target.closest) return '';
    const hinted = target.closest('[data-cursor]');
    if (hinted && MODES.includes(hinted.dataset.cursor)) return hinted.dataset.cursor;
    if (target.closest(TEXTUAL)) return 'text';
    if (target.closest(INTERACTIVE)) return 'link';
    return '';
  }

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') { el.classList.remove('is-on'); return; }
    if (!started) { started = true; gsap.set(ring, { x: e.clientX, y: e.clientY }); }
    el.classList.add('is-on');
    dotX(e.clientX); dotY(e.clientY);
    ringX(e.clientX); ringY(e.clientY);
  }, { passive: true });
  document.addEventListener('pointerover', (e) => setMode(modeFor(e.target)), { passive: true });
  document.addEventListener('pointerdown', () => el.classList.add('is-down'), { passive: true });
  document.addEventListener('pointerup', () => el.classList.remove('is-down'), { passive: true });
  document.documentElement.addEventListener('pointerleave', () => el.classList.remove('is-on'));
  window.addEventListener('blur', () => el.classList.remove('is-on'));

  return el;
}
