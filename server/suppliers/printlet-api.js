// Printlet (Egypt) HTTP calls: the ONLY file that knows Printlet's URLs and field names. Owner: sup.
//
// Source: Printlet "API Integration" — marked *Beta v1.0 RC* by Printlet — read 12 Nov 2026:
//   guide    https://www.printleteg.com/developers/api-integration
//   OpenAPI  https://printleteg.com/api/developer-docs/api-integration/openapi   (version 1.0.0-rc.1)
// Every function names the OpenAPI operationId it calls. Nothing here has been run against a real account, and the
// API is a release candidate, so the adapter stays switched off until PRINTLET_API_CONFIRMED=1 (see printlet.js).
//
// NOT in the public documents (must be confirmed with Printlet before going live):
//   1. Webhook signing: the guide says "HMAC from the timestamp and the exact raw body", but names neither the
//      headers nor the string layout. Until known, deliveries are checked by the ?key= secret in our URL only.
//   2. Where the webhook URL is registered (dashboard credentials page?) and the event `resource` fields.
//   3. Tracking: the Order schema has no carrier / tracking number / tracking URL fields.
//   4. Looking an order up by merchant_order_id (only listOrders + status filter is documented).
//   5. Rate limits (none published) and whether the same Idempotency-Key replays the first answer after hours.
//   6. How Egyptian city names map to city_id (we match shipping-method rate cities by name).
import { createHttp } from './http.js';

export function createPrintletApi(cfg, deps = {}) {
  const http = createHttp({
    provider: 'printlet', baseUrl: cfg.baseUrl, deps,
    rate: { capacity: 60, windowMs: 60000 }, // our own caution; Printlet publishes no limit
    headers: () => ({ Authorization: `Bearer ${cfg.apiKey}` }),
  });
  // Every POST needs an Idempotency-Key (8–200 chars); the same key is reused when the same step is retried.
  const post = (path, body, key, extra = {}) => http.post(path, body, { headers: { 'Idempotency-Key': key, ...(extra.headers || {}) }, retry: extra.retry });
  const data = (res) => res.data;

  return {
    /** listCatalogCountries → [{ id, code, name, currency }] */
    countries: async () => data(await http.get('/catalog/countries')).data || [],
    /** listCatalogProducts → [{ id, name, status, variants: [{ id, revision, sku, available }] }] */
    products: async (countryId) => data(await http.get('/catalog/products', { query: { country_id: countryId } })).data || [],
    /** getCatalogProduct → product with print_areas[].techniques[].placement_presets */
    product: async (productId, countryId) => data(await http.get(`/catalog/products/${encodeURIComponent(productId)}`, { query: { country_id: countryId } })),
    /** listCatalogShippingMethods → [{ id, name, delivery_time, rates: [{ cities: [{ id, name }], price }] }] */
    shippingMethods: async (countryId) => data(await http.get('/catalog/shipping-methods', { query: { country_id: countryId } })).data || [],
    /** createArtwork (remote HTTPS URL; waits up to `wait` seconds for validation) → { id, revision, status } */
    createArtwork: async ({ url, merchantArtworkId, wait = 10 }, key) => data(await post('/artworks', { source: { type: 'remote_url', url }, merchant_artwork_id: merchantArtworkId, wait, rights_attested: true }, key)),
    /** getArtwork */
    artwork: async (id) => data(await http.get(`/artworks/${encodeURIComponent(id)}`)),
    /** createQuote → { id, status, total: { amount, currency }, shipping, expires_at } (valid 15 minutes) */
    createQuote: async (body, key) => data(await post('/quotes', body, key)),
    /** createOrder (from a quote) → Order */
    createOrder: async (body, key) => data(await post('/orders', body, key)),
    /** getOrder */
    order: async (id) => data(await http.get(`/orders/${encodeURIComponent(id)}`)),
    /** listOrders → { data: [Order], next_cursor, has_more } */
    orders: async (after) => data(await http.get('/orders', { query: { limit: 100, after } })),
    /** setCodVerification: we already confirmed the COD order with the customer at checkout */
    verifyCod: async (id, reference, key) => data(await post(`/orders/${encodeURIComponent(id)}/cod-verification`, { status: 'verified', reference }, key)),
    /** createOrderPaymentSession with the Printlet wallet (If-Match = order.resource_version) → { order } */
    payFromWallet: async (id, resourceVersion, key) => data(await post(`/orders/${encodeURIComponent(id)}/payment-session`, { payment_method: 'wallet' }, key, { headers: { 'If-Match': String(resourceVersion) }, retry: false })),
    /** cancelOrder (202: cancelled, or cancellation requested when already committed) */
    cancel: async (id, key) => data(await post(`/orders/${encodeURIComponent(id)}/cancel`, undefined, key, { retry: false })),
  };
}
