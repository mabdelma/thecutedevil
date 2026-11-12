// Country → region helpers for supplier code. Owner: sup. Pure data (server/markets.js, owner core, is the
// authority for which markets are switched on; these helpers only classify a destination for an adapter).
// Regions are the contract's: EU (27 member states), UK, CA, US, AE, GCC (SA, KW, QA, BH, OM), EG.

export const EU_COUNTRIES = Object.freeze(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
export const GCC_COUNTRIES = Object.freeze(['SA', 'KW', 'QA', 'BH', 'OM']);
export const REGIONS = Object.freeze(['EU', 'UK', 'CA', 'US', 'AE', 'GCC', 'EG']);

/** 'ES' → 'EU', 'GB' → 'UK', 'SA' → 'GCC' … or null when the country is not served at all. */
export function regionOf(country) {
  const c = String(country || '').trim().toUpperCase();
  if (EU_COUNTRIES.includes(c)) return 'EU';
  if (c === 'GB' || c === 'UK') return 'UK';
  if (c === 'CA' || c === 'US' || c === 'AE' || c === 'EG') return c;
  if (GCC_COUNTRIES.includes(c)) return 'GCC';
  return null;
}

export function countriesOf(region) {
  if (region === 'EU') return EU_COUNTRIES.slice();
  if (region === 'GCC') return GCC_COUNTRIES.slice();
  if (region === 'UK') return ['GB'];
  return REGIONS.includes(region) ? [region] : [];
}

/** Suppliers (Printful, Gelato) insist on a state/province code for these destinations. */
export const stateRequired = (country) => ['US', 'CA', 'AU'].includes(String(country || '').toUpperCase());

/** ISO code the suppliers expect ('UK' is not ISO). */
export const isoCountry = (country) => { const c = String(country || '').trim().toUpperCase(); return c === 'UK' ? 'GB' : c; };
