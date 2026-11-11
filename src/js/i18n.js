// The Cute Devil: internationalisation runtime.
// Dictionaries live in src/i18n/<code>.json (flat "dotted.key": "string"). English is the source of
// truth and the per-key fallback, so it ships in the main bundle; every other language is its own
// chunk, loaded only when it is the active one.
//
// Markup hooks (see apply):
//   data-i18n="key"                 text of the element (child elements such as icons are kept)
//   data-i18n-html="key"            innerHTML (only where the value carries inline markup)
//   data-i18n-attr="attr:key;…"     attributes (aria-label, placeholder, content, title)
// JS: t('key', { vars }), tn('key', count, { vars }) for plurals (key.one / key.other / …).
// Language choice: ?lang= → localStorage `tcd:lang` → navigator.languages → 'en'.
// Event on document after every change: `tcd:lang` { lang, dir }.
// QA: ?pseudo=1 wraps every value as ⟦…⟧ with accents and ~35% extra length.
import en from '../i18n/en.json';

export const LANGS = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'zh', name: '中文', dir: 'ltr' },
  { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
  { code: 'pt', name: 'Português', dir: 'ltr' },
  { code: 'ru', name: 'Русский', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', dir: 'ltr' },
  { code: 'ja', name: '日本語', dir: 'ltr' },
  { code: 'hi', name: 'हिन्दी', dir: 'ltr' },
  { code: 'it', name: 'Italiano', dir: 'ltr' },
];
const KEY = 'tcd:lang';
const CODES = LANGS.map((l) => l.code);
const loaders = import.meta.glob(['../i18n/*.json', '!../i18n/en.json', '!../i18n/_notes.json']);
const root = document.documentElement;
const params = new URLSearchParams(window.location.search);
const PSEUDO = params.get('pseudo') === '1';

const norm = (v) => {
  const c = String(v || '').toLowerCase().slice(0, 2);
  return CODES.includes(c) ? c : '';
};
function detect() {
  const q = norm(params.get('lang'));
  if (q) return { lang: q, from: 'query' };
  let stored = '';
  try { stored = norm(localStorage.getItem(KEY)); } catch (err) { /* private mode */ }
  if (stored) return { lang: stored, from: 'storage' };
  const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const l of list) { const c = norm(l); if (c) return { lang: c, from: 'browser' }; }
  return { lang: 'en', from: 'default' };
}

let lang = 'en';
let dict = en;
const cache = { en };

/* ---------------------------------------------------------------- pseudo locale (QA only) */
const ACCENT = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý', c: 'ç', n: 'ñ', C: 'Ç', N: 'Ñ' };
function pseudo(value) {
  const parts = String(value).split(/(<[^>]+>|\{[a-zA-Z0-9_]+\}|&[a-z#0-9]+;)/);
  let letters = 0;
  const body = parts.map((part, i) => {
    if (i % 2) return part;
    letters += part.replace(/\s/g, '').length;
    return part.replace(/[aeiouyAEIOUYcnCN]/g, (ch) => ACCENT[ch]);
  }).join('');
  const extra = Math.ceil(letters * 0.35);
  let pad = '';
  for (let i = 0; i < extra; i += 1) pad += (i && i % 6 === 0 ? ' ' : '') + 'ÿ';
  return `⟦${body}${letters > 8 ? ' ' : ''}${pad}⟧`;
}

/* ---------------------------------------------------------------- lookup */
const raw = (key) => (typeof dict[key] === 'string' && dict[key] !== '' ? dict[key] : (typeof en[key] === 'string' ? en[key] : null));
// Placeholders every string may use without passing them: {name} is the founder's full name, kept in ONE key.
const GLOBALS = { name: 'brand.founderName' };
const fill = (text, vars) => text.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => {
  if (vars && k in vars) return String(vars[k]);
  if (k in GLOBALS) { const v = raw(GLOBALS[k]); return v === null ? m : v; }
  return m;
});

/** True when the key exists in the active language or in English. */
export function has(key) { return raw(key) !== null; }

/** Translate. Missing in the active language → English; missing everywhere → the key itself. */
export function t(key, vars) {
  const text = raw(key);
  if (text === null) return key;
  return fill(PSEUDO ? pseudo(text) : text, vars);
}

/** Plural: picks key.zero|one|two|few|many|other by the active language's rules, `{n}` is the count. */
export function tn(key, n, vars) {
  let cat = 'other';
  try { cat = new Intl.PluralRules(lang).select(n); } catch (err) { cat = n === 1 ? 'one' : 'other'; }
  const all = { n, ...vars };
  if (typeof dict[`${key}.${cat}`] === 'string') return t(`${key}.${cat}`, all);
  if (typeof dict[`${key}.other`] === 'string') return t(`${key}.other`, all);
  return t(`${key}.${n === 1 ? 'one' : 'other'}`, all);
}

/** An object whose properties read the dictionary lazily: strings({ close: 'cart.close' }).close */
export function strings(map) {
  const out = {};
  Object.keys(map).forEach((name) => {
    const v = map[name];
    Object.defineProperty(out, name, typeof v === 'string' ? { get: () => t(v), enumerable: true } : { value: v, enumerable: true });
  });
  return out;
}

export const getLang = () => lang;
export const getDir = (code = lang) => (LANGS.find((l) => l.code === code) || LANGS[0]).dir;
export const isPseudo = () => PSEUDO;

/* ---------------------------------------------------------------- DOM */
function setText(el, value) {
  if (!el.firstElementChild) { if (el.textContent !== value) el.textContent = value; return; }
  // keep child elements (icons, counters): only the first real text node carries the string
  let done = false;
  Array.from(el.childNodes).forEach((n) => {
    if (n.nodeType !== 3 || !n.nodeValue.trim()) return;
    if (done) { n.remove(); return; }
    const lead = /^\s/.test(n.nodeValue) ? ' ' : '';
    const tail = /\s$/.test(n.nodeValue) ? ' ' : '';
    n.nodeValue = lead + value + tail;
    done = true;
  });
  if (!done) el.insertBefore(document.createTextNode(`${value} `), el.firstChild);
}
function each(scope, selector, fn) {
  if (scope.nodeType === 1 && scope.matches(selector)) fn(scope);
  scope.querySelectorAll(selector).forEach(fn);
}

const before = new Set();
/** Run `fn(root)` right before a subtree is re-translated (motion.js un-splits headlines here). */
export function onBeforeApply(fn) { before.add(fn); }

/** Translate every marked node inside `scope` (default: the whole document, head included). */
export function apply(scope = document) {
  const el = scope && scope.nodeType === 9 ? scope.documentElement : scope;
  if (!el || !el.querySelectorAll) return;
  before.forEach((fn) => { try { fn(el); } catch (err) { console.warn('[tcd:i18n]', err); } });
  each(el, '[data-i18n]', (n) => setText(n, t(n.getAttribute('data-i18n'))));
  each(el, '[data-i18n-html]', (n) => { n.innerHTML = t(n.getAttribute('data-i18n-html')); });
  each(el, '[data-i18n-attr]', (n) => {
    n.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
      const at = pair.indexOf(':');
      if (at < 1) return;
      n.setAttribute(pair.slice(0, at).trim(), t(pair.slice(at + 1).trim()));
    });
  });
}

function paintRoot() {
  root.setAttribute('lang', lang);
  root.setAttribute('dir', getDir());
}
const reveal = () => root.classList.remove('i18n-wait');

async function load(code) {
  if (cache[code]) return cache[code];
  const loader = loaders[`../i18n/${code}.json`];
  if (!loader) return en;
  const mod = await loader();
  cache[code] = (mod && mod.default) || mod || en;
  return cache[code];
}

/** Switch language without a reload. Resolves with the code that is active afterwards. */
export async function setLang(code, { store = true } = {}) {
  const next = norm(code) || 'en';
  let table = en;
  try { table = await load(next); } catch (err) { console.warn('[tcd:i18n]', err); }
  lang = next;
  dict = table;
  if (store) { try { localStorage.setItem(KEY, next); } catch (err) { /* private mode */ } }
  // a ?lang= in the address would win again on reload: keep it in step with the choice
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('lang') && url.searchParams.get('lang') !== next) {
      url.searchParams.set('lang', next);
      window.history.replaceState(window.history.state, '', url);
    }
  } catch (err) { /* ignore */ }
  paintRoot();
  apply(document);
  reveal();
  document.dispatchEvent(new CustomEvent('tcd:lang', { detail: { lang, dir: getDir() } }));
  return lang;
}

/* ---------------------------------------------------------------- boot */
const first = detect();
lang = first.lang;
paintRoot();
if (first.from === 'query') { try { localStorage.setItem(KEY, lang); } catch (err) { /* private mode */ } }

/** Resolves once the active dictionary is loaded and the static HTML is translated. Never rejects. */
export const ready = (async () => {
  try {
    if (lang !== 'en') dict = await load(lang);
    if (lang !== 'en' || PSEUDO) apply(document);
  } catch (err) {
    console.warn('[tcd:i18n]', err);
    dict = en;
  }
  reveal();
  return lang;
})();
