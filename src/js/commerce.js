// The Cute Devil: commerce client. No DOM in here. Owner: web. Contract: web/COMMERCE_ARCH.md section f.
// One question decides everything: does GET /api/config say `enabled: true`?
//   no (or the request fails, or it takes too long)  → the site behaves exactly as before: sample
//       prices in EUR and the WhatsApp order steps in the bag.
//   yes → real prices in the currency of the chosen country, checkout.html and order.html.
// The answer (also a "no") is cached for a few minutes in sessionStorage so the next page paints with
// the right prices at once; every page load still asks again and corrects itself. On the first page of
// a visit, modules that show prices wait for `settled` (at most the short timeout below).
// The chosen delivery country lives in localStorage `tcd:country`. The currency always follows it.
// Event on document whenever the answer, the country or the currency changes: `tcd:market`
//   { enabled, country, currency }.

const COUNTRY_KEY = 'tcd:country';
const CACHE_KEY = 'tcd:config';
const LAST_ORDER_KEY = 'tcd:lastOrder';
const CACHE_MS = 5 * 60 * 1000;
const CACHE_FAIL_MS = 60 * 1000; // a failed request is trusted for less time
const CONFIG_TIMEOUT = 2500;

const OFF = Object.freeze({
  enabled: false, mode: 'off', countries: [], currencies: [], defaultCountry: null, flags: { us: false, uk: false }, whatsappFallback: true,
});

/** An error answered by the API ({ error: { code, message, fields } }) or a network failure (code NETWORK / TIMEOUT). */
export class ApiError extends Error {
  constructor(code, status, message, fields, body) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.fields = fields;
    this.body = body || null;
  }
}

/* ---------------------------------------------------------------- config */
function normalise(raw) {
  if (!raw || raw.enabled !== true || !Array.isArray(raw.countries)) return OFF;
  const countries = raw.countries
    .filter((c) => c && typeof c.code === 'string' && /^[A-Z]{2}$/.test(c.code) && typeof c.currency === 'string' && /^[A-Z]{3}$/.test(c.currency))
    .map((c) => ({ code: c.code, region: String(c.region || ''), currency: c.currency, methods: Array.isArray(c.methods) ? c.methods.map(String) : [] }));
  if (!countries.length) return OFF;
  return {
    enabled: true,
    mode: raw.mode === 'mock' ? 'mock' : 'live',
    countries,
    currencies: Array.isArray(raw.currencies) ? raw.currencies.map(String) : Array.from(new Set(countries.map((c) => c.currency))),
    defaultCountry: typeof raw.defaultCountry === 'string' ? raw.defaultCountry : null,
    flags: { us: Boolean(raw.flags && raw.flags.us), uk: Boolean(raw.flags && raw.flags.uk) },
    whatsappFallback: raw.whatsappFallback !== false,
  };
}

function readCache() {
  try {
    const data = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
    if (data && Date.now() - data.at < (data.failed ? CACHE_FAIL_MS : CACHE_MS)) return normalise(data.config);
  } catch (err) { /* private mode */ }
  return null;
}
function writeCache(value, failed) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), failed: Boolean(failed), config: value })); } catch (err) { /* private mode */ }
}

const cached = readCache();
let config = cached || OFF;
let country = null;
let missed = null; // where the visitor seems to be, when that country is not an enabled market (UAE, the Gulf, …)

/* ---------------------------------------------------------------- country */
// Only used to pick a sensible first country; the customer can always change it.
const ZONES = {
  'Europe/Madrid': 'ES', 'Atlantic/Canary': 'ES', 'Africa/Ceuta': 'ES', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Busingen': 'DE',
  'Europe/Rome': 'IT', 'Europe/Lisbon': 'PT', 'Atlantic/Madeira': 'PT', 'Atlantic/Azores': 'PT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE',
  'Europe/Vienna': 'AT', 'Europe/Dublin': 'IE', 'Europe/Athens': 'GR', 'Europe/Stockholm': 'SE', 'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI',
  'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ', 'Europe/Budapest': 'HU', 'Europe/Bucharest': 'RO', 'Europe/Sofia': 'BG', 'Europe/Zagreb': 'HR',
  'Europe/Ljubljana': 'SI', 'Europe/Bratislava': 'SK', 'Europe/Luxembourg': 'LU', 'Europe/Malta': 'MT', 'Asia/Nicosia': 'CY', 'Europe/Tallinn': 'EE',
  'Europe/Riga': 'LV', 'Europe/Vilnius': 'LT', 'Europe/London': 'GB', 'Europe/Belfast': 'GB',
  'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Kuwait': 'KW', 'Asia/Qatar': 'QA', 'Asia/Bahrain': 'BH', 'Asia/Muscat': 'OM', 'Africa/Cairo': 'EG',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'America/St_Johns': 'CA',
  'America/Regina': 'CA', 'America/Montreal': 'CA', 'America/Moncton': 'CA',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US',
  'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Detroit': 'US',
};

const served = (code) => config.countries.some((c) => c.code === code);
/** The visitor's country by time zone alone (the browser language says little about where a parcel goes). */
function zoneCountry() {
  try { return ZONES[Intl.DateTimeFormat().resolvedOptions().timeZone] || null; } catch (err) { return null; }
}

function guessCountry() {
  const tries = [];
  try { tries.push(ZONES[Intl.DateTimeFormat().resolvedOptions().timeZone]); } catch (err) { /* ignore */ }
  try {
    const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    list.forEach((tag) => { const m = /^[a-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2})\b/.exec(String(tag || '')); if (m) tries.push(m[1].toUpperCase()); });
  } catch (err) { /* ignore */ }
  tries.push(config.defaultCountry);
  return tries.find((code) => code && served(code)) || (config.countries[0] ? config.countries[0].code : null);
}

function pickCountry() {
  if (!config.enabled) return null;
  let stored = '';
  try { stored = String(localStorage.getItem(COUNTRY_KEY) || '').toUpperCase(); } catch (err) { /* private mode */ }
  if (stored && served(stored)) { missed = null; return stored; } // the customer chose a market: nothing to explain
  const zone = zoneCountry();
  missed = zone && !served(zone) ? zone : null;
  return guessCountry();
}
country = pickCountry();

const snapshot = () => `${config.enabled}|${country}|${getCurrency()}|${config.countries.map((c) => c.code + c.currency).join(',')}`;
function emit() {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent('tcd:market', { detail: { enabled: config.enabled, country, currency: getCurrency() } }));
}

/** True when the shop takes real orders (the API said so). */
export const isOn = () => config.enabled;
/** The normalised /api/config answer (the "off" shape when commerce is off). */
export const getConfig = () => config;
/** Enabled markets: [{ code, region, currency, methods }]. Empty when commerce is off. */
export const countries = () => config.countries.slice();
/** One market by country code, or null. */
export const market = (code = country) => config.countries.find((c) => c.code === code) || null;
/** The chosen delivery country (ISO code), or null when commerce is off. */
export const getCountry = () => country;
/** The currency of the chosen country; EUR when commerce is off (today's sample prices). */
export function getCurrency() {
  const m = config.enabled ? market(country) : null;
  return m ? m.currency : 'EUR';
}
/** The country the visitor seems to be in when we do not deliver there online yet (else null). The pages say so
    and offer the WhatsApp order; it clears as soon as the customer picks a delivery country. */
export const notServedCountry = () => (config.enabled ? missed : null);
/** The region of the chosen country ('EU', 'AE', …) or ''. */
export const getRegion = () => { const m = market(country); return m ? m.region : ''; };

/** Choose the delivery country. Ignored when the code is not an enabled market. */
export function setCountry(code) {
  const next = String(code || '').toUpperCase();
  if (!config.enabled || !served(next)) return country;
  if (next === country) { // confirming the suggested country is a choice too
    try { localStorage.setItem(COUNTRY_KEY, next); } catch (err) { /* private mode */ }
    if (missed) { missed = null; emit(); }
    return country;
  }
  country = next;
  missed = null;
  try { localStorage.setItem(COUNTRY_KEY, next); } catch (err) { /* private mode */ }
  emit();
  return country;
}

/** "ES" → "Spain" in the given language (Intl.DisplayNames; the code itself when unknown). */
export function countryName(code, lang = 'en') {
  try { return new Intl.DisplayNames([lang, 'en'], { type: 'region' }).of(code) || code; } catch (err) { return code; }
}
/** Enabled markets with their names in `lang`, sorted by name: [{ code, name, currency, region }]. */
export function countryOptions(lang = 'en') {
  const list = config.countries.map((c) => ({ ...c, name: countryName(c.code, lang) }));
  try { const col = new Intl.Collator(lang); list.sort((a, b) => col.compare(a.name, b.name)); } catch (err) { list.sort((a, b) => (a.name < b.name ? -1 : 1)); }
  return list;
}

/* ---------------------------------------------------------------- HTTP */
async function call(path, { method = 'GET', body, timeout = 20000 } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; if (ctrl) ctrl.abort(); }, timeout);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new ApiError(timedOut ? 'TIMEOUT' : 'NETWORK', 0, String((err && err.message) || err));
  }
  clearTimeout(timer);
  let data = null;
  try { data = await res.json(); } catch (err) { data = null; }
  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(typeof e.code === 'string' ? e.code : (res.status >= 500 ? 'INTERNAL' : 'HTTP'), res.status, e.message, e.fields, data);
  }
  if (data === null || typeof data !== 'object') throw new ApiError('BAD_RESPONSE', res.status, 'Not JSON');
  return data;
}

/** Resolves with the config once the API has answered (or failed). Never rejects. */
export const ready = (async () => {
  const before = snapshot();
  let next = OFF;
  let failed = false;
  try { next = normalise(await call('/config', { timeout: CONFIG_TIMEOUT })); } catch (err) { next = OFF; failed = true; }
  config = next;
  writeCache(next, failed);
  country = pickCountry();
  if (snapshot() !== before) emit();
  return config;
})();

/** Resolves as soon as there is an answer to paint with: at once when one is cached, else when `ready` does. Never rejects. */
export const settled = cached ? Promise.resolve(config) : ready;

/** POST /api/quote. `body` = { country, state?, postcode?, items, paymentMethod?, lang? }. */
export const quote = (body) => call('/quote', { method: 'POST', body, timeout: 20000 });
/** POST /api/checkout. Resolves { orderId, token, statusUrl, payment }. */
export const checkout = (body) => call('/checkout', { method: 'POST', body, timeout: 60000 });
/** GET /api/orders/:publicId?token=. */
export const getOrder = (id, token) => call(`/orders/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, { timeout: 15000 });

/* ---------------------------------------------------------------- the last order made in this browser */
// Lets order.html find the order again without the e-mail link, and tells it which bag to clear.
export function rememberOrder(order) {
  try { localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ ...order, at: Date.now() })); } catch (err) { /* private mode */ }
}
export function lastOrder() {
  try {
    const data = JSON.parse(localStorage.getItem(LAST_ORDER_KEY) || 'null');
    return data && typeof data.id === 'string' && typeof data.token === 'string' ? data : null;
  } catch (err) { return null; }
}

/* ---------------------------------------------------------------- address rules (mirror of the server's validation) */
// state: 'required' | 'optional' | 'hidden'; stateKind picks the label (state, province, emirate, governorate, region).
const RULES = {
  EU: { postcode: 'required', state: 'optional', stateKind: 'province', phone: 'optional' },
  UK: { postcode: 'required', state: 'hidden', stateKind: 'region', phone: 'optional' },
  CA: { postcode: 'required', state: 'required', stateKind: 'province', phone: 'optional' },
  US: { postcode: 'required', state: 'required', stateKind: 'state', phone: 'optional', postcodeKind: 'zip' },
  AE: { postcode: 'hidden', state: 'required', stateKind: 'emirate', phone: 'required' },
  GCC: { postcode: 'optional', state: 'optional', stateKind: 'region', phone: 'required' },
  EG: { postcode: 'optional', state: 'required', stateKind: 'governorate', phone: 'required' },
};
const POSTCODE = {
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/i,
  GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i,
};
/** Which address fields a country needs: { postcode, state, stateKind, phone, postcodeKind, postcodePattern }. */
export function addressRules(code = country) {
  const m = market(code);
  const base = RULES[m ? m.region : ''] || { postcode: 'optional', state: 'optional', stateKind: 'region', phone: 'optional' };
  return { postcodeKind: 'postcode', ...base, postcodePattern: POSTCODE[code] || /^[A-Za-z0-9][A-Za-z0-9 -]{1,10}[A-Za-z0-9]$/ };
}

export const DIAL = {
  AT: '43', BE: '32', BG: '359', HR: '385', CY: '357', CZ: '420', DK: '45', EE: '372', FI: '358', FR: '33', DE: '49', GR: '30', HU: '36', IE: '353',
  IT: '39', LV: '371', LT: '370', LU: '352', MT: '356', NL: '31', PL: '48', PT: '351', RO: '40', SK: '421', SI: '386', ES: '34', SE: '46',
  GB: '44', CA: '1', US: '1', AE: '971', SA: '966', KW: '965', QA: '974', BH: '973', OM: '968', EG: '20',
};
/** "050 123 4567" + AE → "+971501234567". Returns '' when it cannot be a phone number (E.164: + and 8 to 15 digits). */
export function normalisePhone(input, code = country) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) return '';
  raw = raw.replace(/[\s().\-‐-―]/g, '');
  if (raw.startsWith('00')) raw = `+${raw.slice(2)}`;
  if (!raw.startsWith('+')) {
    const dial = DIAL[code];
    if (!dial || !/^\d+$/.test(raw)) return '';
    raw = `+${dial}${code === 'IT' ? raw : raw.replace(/^0+/, '')}`;
  }
  return /^\+[1-9]\d{7,14}$/.test(raw) ? raw : '';
}
