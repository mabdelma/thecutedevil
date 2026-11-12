// Markets: which countries are served, their region and currency, and address rules. Owner: core.
// Contract: web/COMMERCE_ARCH.md "Conventions". The customer never chooses a currency: it follows the country.

export const EU_COUNTRIES = Object.freeze(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
export const GCC_COUNTRIES = Object.freeze(['SA', 'KW', 'QA', 'BH', 'OM']);
export const REGIONS = Object.freeze(['EU', 'UK', 'CA', 'US', 'AE', 'GCC', 'EG']);
export const LANGS = Object.freeze(['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'ru', 'hi', 'ja', 'zh']);
export const DEFAULT_LANG = 'en';

const REGION_BY_COUNTRY = new Map([
  ...EU_COUNTRIES.map((c) => [c, 'EU']),
  ['GB', 'UK'], ['CA', 'CA'], ['US', 'US'], ['AE', 'AE'], ['EG', 'EG'],
  ...GCC_COUNTRIES.map((c) => [c, 'GCC']),
]);

const CURRENCY_BY_COUNTRY = new Map([
  ...EU_COUNTRIES.map((c) => [c, 'EUR']),
  ['GB', 'GBP'], ['CA', 'CAD'], ['US', 'USD'], ['AE', 'AED'], ['KW', 'AED'], ['QA', 'AED'], ['BH', 'AED'], ['OM', 'AED'],
  ['SA', 'SAR'], ['EG', 'EGP'],
]);

/** 'ES' → 'EU'; null for a country that is never served. */
export const regionOf = (country) => REGION_BY_COUNTRY.get(String(country || '').toUpperCase()) || null;
/** 'ES' → 'EUR'; null for a country that is never served. */
export const currencyOf = (country) => CURRENCY_BY_COUNTRY.get(String(country || '').toUpperCase()) || null;

/** Regions switched on by the feature flags (US and UK are off by default). */
export function enabledRegions(config) {
  return REGIONS.filter((r) => (r === 'US' ? Boolean(config.enableUS) : r === 'UK' ? Boolean(config.enableUK) : true));
}

/** Every country whose market is switched on (payment and routing are checked elsewhere). */
export function enabledCountries(config) {
  const regions = new Set(enabledRegions(config));
  return Array.from(REGION_BY_COUNTRY.keys()).filter((c) => regions.has(REGION_BY_COUNTRY.get(c)));
}

export const isMarketEnabled = (country, config) => enabledCountries(config).includes(String(country || '').toUpperCase());

/** Address rules of section f: postcode for EU, UK, CA, US; phone for AE, GCC and EG (and for every COD order). */
export function addressRules(country) {
  const region = regionOf(country);
  return {
    postcodeRequired: ['EU', 'UK', 'CA', 'US'].includes(region),
    phoneRequired: ['AE', 'GCC', 'EG'].includes(region),
  };
}
