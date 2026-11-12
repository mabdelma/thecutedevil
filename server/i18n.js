// Server-side strings. Owner: core. Reads the site dictionaries (src/i18n/<lang>.json, owned by `web`).
// Lookup order per key: the language file → en.json → the caller's built-in English → the key itself.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, DEFAULT_LANG } from './markets.js';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/i18n');
const cache = new Map();

function dictionary(lang, dir = DIR) {
  const id = `${dir}|${lang}`;
  if (cache.has(id)) return cache.get(id);
  let dict = {};
  const file = resolve(dir, `${lang}.json`);
  try { if (existsSync(file)) dict = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { dict = {}; }
  cache.set(id, dict);
  return dict;
}

export const normaliseLang = (lang) => (LANGS.includes(String(lang || '').toLowerCase()) ? String(lang).toLowerCase() : DEFAULT_LANG);
export const isRtl = (lang) => normaliseLang(lang) === 'ar';

const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, name) => (vars && vars[name] != null ? String(vars[name]) : m));
const usable = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @param {string} lang     one of the 11 codes (anything else → en)
 * @param {string} key      e.g. 'email.shipped.subject'
 * @param {object} [vars]   {placeholder} values
 * @param {object} [options] { fallback: { key: 'English text' }, strings: { key: text } (wins over the files), dir }
 */
export function t(lang, key, vars, options = {}) {
  const code = normaliseLang(lang);
  const candidates = [
    options.strings?.[key],
    dictionary(code, options.dir)[key],
    code === DEFAULT_LANG ? undefined : dictionary(DEFAULT_LANG, options.dir)[key],
    options.fallback?.[key],
  ];
  const found = candidates.find(usable);
  return fill(found === undefined ? key : found, vars);
}

/** Money for people: formatMoney(7900, 'EUR', 'es') → "79,00 €". */
export function formatMoney(minor, currency, lang = DEFAULT_LANG) {
  try { return new Intl.NumberFormat(normaliseLang(lang), { style: 'currency', currency }).format(minor / 100); }
  catch (err) { return `${(minor / 100).toFixed(2)} ${currency}`; }
}

/** Country name in the customer's language (never from the dictionaries). */
export function countryName(code, lang = DEFAULT_LANG) {
  try { return new Intl.DisplayNames([normaliseLang(lang)], { type: 'region' }).of(code) || code; } catch (err) { return code; }
}

export const clearI18nCache = () => cache.clear();
