# COMMERCE ARCHITECTURE (the contract)

Four roles code against this file in parallel: `core`, `pay`, `sup`, `web`. Edit only your own files. If something here is unclear, follow the scaffolding in `site/server/` (it already runs) and keep the shapes below unchanged.

Fixed context: custom build on the existing Vite site; Hostinger "Node.js web app" (one Node process, requests cut at 120 s, no workers, no Redis); MySQL in production, SQLite locally; Node 20+, ES modules, plain JS; secrets only in env.

Conventions used everywhere:

- **Money** is an integer in minor units (`7900` = 79.00). All seven currencies have two decimals.
- **Time** is epoch milliseconds (`Date.now()`), stored as BIGINT in `*_at` columns.
- **Regions**: `EU` (27 member states), `UK` (GB, only if `ENABLE_UK`), `CA`, `US` (only if `ENABLE_US`), `AE`, `GCC` (SA, KW, QA, BH, OM), `EG`. Any other country is not served.
- **Currency by country** (fixed, in `server/markets.js`): EU → EUR, GB → GBP, CA → CAD, US → USD, AE/KW/QA/BH/OM → AED, SA → SAR, EG → EGP. The customer never chooses a currency; it follows the destination country.
- **Errors**: HTTP handlers throw `AppError(code, status, message, { fields })` (`server/lib/errors.js`); the API answers `{ "error": { "code", "message", "fields"? } }`. Providers and adapters throw `ProviderError(code, message, { retryable, status, provider })`: `retryable: true` for network errors, timeouts, 429 and 5xx; `false` for anything the same request can never fix.
- **ctx**: every server module receives `ctx = { config, db, log, payments, suppliers }`. Only `server/config.js` reads `process.env`.
- **Outbound HTTP**: global `fetch` with `AbortSignal.timeout(15000)`. No handler may run longer than 60 s.

## a. Files and owners

`S` = already written as scaffolding (stub or working); its owner completes it.

```
site/server/
  index.js                    core  S  start(): config → db → migrate → registries → app → listen
  app.js                      core  S  createApp(ctx): /api routers, static dist/, 404
  config.js                   core  S  loadConfig(env)
  db.js                       core  S  createDb(url), migrate(db), now()
  markets.js                  core     countries, regions, currency, address rules, enabled markets
  i18n.js                     core     t(lang, key, vars): reads ../src/i18n/*.json, English fallback
  lib/errors.js               core  S  AppError, ProviderError
  lib/validate.js             core     input validators, tidy()
  lib/ratelimit.js            core     in-memory fixed-window limiter
  lib/ids.js                  core     publicId(), token(), sha256(), safeEqual()
  lib/log.js                  core     logger that redacts secrets and PII
  migrations/001_init.js      core  S  schema of section b
  catalogue/products.js       core  S  catalogue data (pure data, also imported by the front end)
  catalogue/index.js          core     getProduct, variantKey, priceOf, validateCatalogue
  catalogue/mapping.js        sup   S  per-supplier variant mapping
  routing/rules.json          core  S  owner-editable routing table
  routing/engine.js           core     route(lines, destination, ctx)
  pricing/shipping-rates.json core     owner-editable customer shipping prices
  pricing/tax-rules.json      core     owner-editable tax display rates
  pricing/shipping.js         core     shippingOptions(lines, destination, currency)
  pricing/tax.js              core     computeTax(input)
  pricing/quote.js            core     buildQuote(input, ctx)
  orders/states.js            core     status lists and allowed transitions
  orders/service.js           core     createOrder, getOrderView, cancelOrder, recomputeOrderStatus
  orders/events.js            core  S  recordWebhookOnce, handlePaymentEvent, handleSupplierEvent
  jobs/queue.js               core     enqueue, claim, complete, fail
  jobs/handlers.js            core     one handler per job type
  jobs/runner.js              core     tick(ctx, { budgetMs }), startTimer(ctx)
  email/send.js               core     nodemailer transport, outbox in mock mode
  email/templates.js          core     subject + text + HTML per template, built with i18n.js
  routes/public.js            core     /config /quote /checkout /orders/:publicId
  routes/cron.js              core     /cron/tick
  routes/admin.js             core     /admin/*
  routes/webhooks-payment.js  pay      POST /webhooks/:provider
  routes/webhooks-supplier.js sup      POST /webhooks/supplier/:supplier
  routes/mock-pay.js          pay      GET/POST /mock/pay/:paymentId (mock mode only)
  payments/interface.js       pay   S  typedefs, assertPaymentProvider
  payments/registry.js        pay   S  loadPayments(config, deps)
  payments/stripe.js          pay      one factory, two instances: stripe_es, stripe_ae
  payments/paymob.js          pay      Egypt
  payments/saudi.js           pay      placeholder: create() always returns null in v1
  payments/cod.js             pay      cash on delivery
  payments/mock.js            pay      mock mode only
  suppliers/interface.js      sup   S  typedefs, assertSupplierAdapter
  suppliers/registry.js       sup   S  loadSuppliers(config, deps)
  suppliers/http.js           sup      fetch wrapper: timeout, JSON, ProviderError mapping
  suppliers/printful.js | printify.js | gelato.js | printlet.js | mock.js | manual.js    sup
  scripts/migrate.js          core  S  npm run migrate
  scripts/cancel-order.js     core     node server/scripts/cancel-order.js <publicId>
  scripts/fulfilment-set.js   core     human closes a `manual` fulfilment (status, tracking)
  test/harness.js             core  S  startTestServer(env)
  test/scaffold.test.js       core  S
  test/e2e.*.test.js          core     journeys of section g
  test/pay/*.test.js          pay
  test/sup/*.test.js          sup
  test/fixtures/<role>/       each role's recorded payloads (no real personal data)
```

`core` mounts the `pay` and `sup` routers in `app.js` at the place marked there (before `express.json()`, with `express.raw`). Each router file exports `default function (ctx) → express.Router`.

Front end, all owned by `web`:

| New | Edited |
|---|---|
| `checkout.html`, `order.html` (same page skeleton as SPEC.md section D; `vite.config.js` picks them up automatically) | `src/js/products.js` (prices come from the catalogue, multi-currency `formatPrice`) |
| `src/js/commerce.js` (API client, cached `/api/config`, chosen country in `localStorage` `tcd:country`) | `src/js/cart.js` (optional `personalisation` in the line and in its key; totals in the active currency) |
| `src/js/pages/checkout.js`, `src/js/pages/order.js` | `src/js/cart-ui.js` (commerce on → button to `checkout.html`; commerce off → today's WhatsApp steps, untouched) |
| `src/css/checkout.css` | `src/js/checkout.js` (WhatsApp flow stays; nothing else added here) |
| `web/qa/commerce.py` (browser QA against mock mode) | `src/js/pages/shop.js`, `src/js/pages/product.js` (currency, personalisation fields, "not available in your country") |
| | `src/js/shell.js` (country selector in the footer), `src/i18n/*.json` (all 11 languages) |

`web` never edits `server/`. `core`, `pay`, `sup` never edit `src/`, except that `core` owns `server/catalogue/products.js`, which `src/js/products.js` imports.

## b. Database

Implemented in `server/migrations/001_init.js`; that file is the reference for exact types and lengths. Products and variants are not in the database in v1.

| Table | Columns | Indexes |
|---|---|---|
| `orders` | id, public_id `TCD-YYMMDD-XXXX`, checkout_id (client UUID), token_hash, status, payment_status, needs_attention, attention_reason, country, region, currency, lang, email, phone, ship_name, ship_line1, ship_line2, ship_city, ship_state, ship_postcode, note, payment_method, payment_provider, shipping_option, subtotal, shipping_total, discount_total, tax_total, tax_included, tax_rate_bp, tax_details (JSON), total, terms_accepted_at, expires_at, confirmed_at, anonymised_at, created_at, updated_at | unique public_id; unique checkout_id; (status, expires_at); (needs_attention, created_at); email; created_at |
| `order_items` | id, order_id, fulfilment_id (null until routed), product_id, variant_key, name, category, qty, unit_price, line_total, tax_amount, weight_g, options (JSON), personalisation (JSON) | order_id; fulfilment_id |
| `payments` | id, order_id, provider, method, status, amount, currency, refunded_amount, provider_ref, provider_payment_ref, redirect_url, raw_status, idem_key, last_error, expires_at, created_at, updated_at | unique idem_key; unique (provider, provider_ref); order_id |
| `fulfilments` | id, order_id, seq, supplier, candidates (JSON), candidate_index, status, external_id (max 32), supplier_order_ref, shipping_method, cost_amount, cost_currency, eta_min_days, eta_max_days, submit_attempts, raw_status, last_error, submitted_at, next_poll_at, created_at, updated_at | unique external_id; unique (order_id, seq); (status, next_poll_at); (supplier, supplier_order_ref) |
| `shipments` | id, order_id, fulfilment_id, supplier_shipment_ref, status, carrier, tracking_number, tracking_url, shipped_at, delivered_at, created_at, updated_at | unique (fulfilment_id, supplier_shipment_ref); order_id |
| `jobs` | id, type, payload (JSON), status `queued/running/done/dead`, attempts, max_attempts, run_after, locked_at, last_error, idem_key, created_at, updated_at | unique idem_key; (status, run_after) |
| `webhook_events` | id, source (`pay:stripe_es`, `sup:printful`), event_id, type, status, payload_hash, last_error, received_at, processed_at | unique (source, event_id) |
| `email_log` | id, order_id, template, lang, to_email, status `queued/sent/failed/skipped`, idem_key, message_id, vars (JSON), last_error, created_at, sent_at | unique idem_key; order_id |
| `order_events` | id, order_id, type, from_status, to_status, message, created_at (audit trail and status-page timeline) | (order_id, created_at) |

Routing creates one fulfilment per supplier per order. A reroute keeps the row, changes `supplier`, raises `candidate_index` and issues a new `external_id` = `<public_id>-F<seq>-<candidate_index>`.

**Order status** (only `orders/service.js` writes it, always inside a transaction, always with an `order_events` row):

| From | Allowed to |
|---|---|
| `pending_payment` | `confirmed`, `expired`, `cancelled` |
| `expired` | `confirmed` (a payment that arrives late re-opens the order) |
| `confirmed` | `processing`, `cancelled` |
| `processing` | `partially_shipped`, `shipped`, `cancelled` |
| `partially_shipped` | `shipped` |
| `shipped` | `delivered` |
| `delivered`, `cancelled` | terminal |

`processing` = at least one fulfilment submitted; `partially_shipped` / `shipped` / `delivered` are derived from the non-cancelled fulfilments by `recomputeOrderStatus`. A COD order is created directly as `confirmed`.

`payment_status`: `unpaid → paid → refund_pending → refunded | partially_refunded`; COD: `cod_due → cod_collected`.
`payments.status`: `created → pending → succeeded | failed | expired`, then `refunded | partially_refunded`; COD rows use `cod_due → cod_collected`.

**Fulfilment status**:

| From | Allowed to |
|---|---|
| `pending` | `submitting`, `cancelled`, `manual` |
| `submitting` | `submitted`, `in_production`, `pending` (retry or reroute), `manual` |
| `submitted` | `in_production`, `shipped`, `cancelled`, `manual` |
| `in_production` | `shipped`, `manual` |
| `shipped` | `delivered` |
| `manual` | `submitted`, `shipped`, `cancelled` (by a human, through `scripts/fulfilment-set.js`) |
| `delivered`, `cancelled` | terminal |

## c. Catalogue

`server/catalogue/products.js` is the single source of truth for what is sold, the price in every currency, weight, category and personalisation fields. It is pure data with no imports, because the browser bundle imports the same file.

```js
export const CURRENCIES = ['EUR', 'GBP', 'CAD', 'USD', 'AED', 'SAR', 'EGP'];
export const catalogue = [{
  id: 'halos-off-hoodie',            // same slug as src/js/products.js
  category: 'apparel',               // apparel | headwear | drinkware | phone_case | wall_art | tote |
                                     // stationery | engraved | fragrance | electronics
  sellable: true,                    // false = never purchasable online
  weightG: 550,
  options: [{ name: 'size', values: ['S', 'M', 'L', 'XL'] }],
  price: { EUR: 7900, GBP: 6900, CAD: 11900, USD: 8900, AED: 32900, SAR: 33900, EGP: 249900 },
  variantPrices: { 'size=XL': { EUR: 8200, /* all seven */ } },   // optional override per variant
  personalisation: [{ key: 'name', type: 'text', maxLength: 12, pattern: '^[\\p{L}\\p{N} .\\-]+$',
                      required: false, surcharge: { EUR: 500, /* all seven */ } }],
  regions: ['EU', 'CA'],             // optional allow-list
}];
```

- `variantKey(product, options)` = `name=value` pairs joined by `|` in the product's option order, or `default` when there are no options. It equals the tail of the cart's existing `lineKey`.
- `core` fills the catalogue with all 12 current ids. Scent and tech products get `sellable: false` (the study defers perfume and electronics). EUR values are today's sample prices × 100; the other six columns are placeholders the owner must set.
- Prices are fixed tables. There is no FX conversion anywhere in customer-facing code. EUR, GBP, AED, SAR and EGP prices include tax; CAD and USD prices exclude it (section h).
- `server/catalogue/mapping.js` (owner `sup`, server only):

```js
export const mapping = {
  'halos-off-hoodie': {
    'size=M': [{ supplier: 'printful', productRef: '380', variantRef: '10780', regions: ['EU', 'UK', 'CA', 'US'],
                 files: [{ placement: 'embroidery_chest_left', url: 'https://…/horns.png' }],
                 cost: { amount: 2950, currency: 'USD' }, days: [4, 9] }],
    '*': [ /* used when the exact variant key has no entry */ ],
  },
};
```

  `cost` and `days` are the static fallback when a live supplier quote is not available. `regions` is where that supplier produces close enough to ship this variant.
- **Front end**: `src/js/products.js` keeps presentation only (name, niche, art, status, featured) and reads prices from the catalogue: `import { catalogue } from '../../server/catalogue/products.js'`. `priceOf(product, options, currency)` returns minor units; `formatPrice(minor, currency)` uses `Intl.NumberFormat(lang, { style: 'currency', currency })`. With commerce off the site shows EUR and the "Sample" badge as today. With commerce on, a product is purchasable only if `sellable` and status `live`; others show as "soon".
- **Validation**: `validateCatalogue()` (run in `core` tests and at boot, where a failure turns commerce off and logs why) checks: all seven currencies present and positive integers; every id found in `src/js/products.js` (read as text, ids extracted by regex) exists in the catalogue with the same option names and values; every sellable variant has a mapping entry or a routing rule that names `manual`.

## d. Interfaces

Typedefs are in `payments/interface.js` and `suppliers/interface.js`. Every module exports `create(config, deps) → instance | null` and returns `null` when its env group in `config` is `null`.

### PaymentProvider

```js
provider.id                        // 'stripe_es' | 'stripe_ae' | 'paymob' | 'cod' | 'mock'
provider.capabilities()            // → { countries: ['ES', …] | '*', currencies: ['EUR', …],
                                   //     methods: ['card' | 'wallet' | 'cod'], refunds: true }
await provider.createCheckout({
  order,                           // orders row (camelCase): publicId, currency, total, country, lang, email
  items,                           // [{ name, qty, unitPrice, lineTotal }]  server-computed
  shipping: { amount, labelKey }, payment,   // payments row: id, amount, currency, idemKey
  urls: { success, cancel },       // absolute URLs built from PUBLIC_BASE_URL
})                                 // → { kind: 'redirect', url, providerRef, expiresAt }
                                   //   { kind: 'confirmed', providerRef }            (COD)
await provider.parseWebhook({ rawBody /* Buffer */, headers, query })
                                   // verifies the signature first; → PaymentEvent[]
                                   // bad signature → throw new AppError('WEBHOOK_SIGNATURE', 400)
await provider.getPayment(providerRef)
                                   // → { status: 'pending' | 'succeeded' | 'failed' | 'expired',
                                   //     providerPaymentRef, amount, currency }
await provider.refund({ payment, amount, reason, idempotencyKey })
                                   // → { status: 'succeeded' | 'pending', refundRef }

PaymentEvent = { eventId, type: 'payment.succeeded' | 'payment.failed' | 'payment.expired' |
                 'refund.succeeded' | 'refund.failed' | 'ignored',
                 providerRef, providerPaymentRef, amount, currency, occurredAt }
```

Rules for `pay`:

- `createCheckout` sends `payment.idemKey` as the provider's idempotency key and puts `order.publicId` in the provider's reference/metadata field.
- Stripe: hosted Checkout Session, `mode: 'payment'`, line items built with `price_data` from the server-computed items, session expiry 30 minutes, `locale` from `order.lang`. Our own checkout page collects the address, so Stripe collects only the payment. One factory, two instances; each has its own webhook URL (`/api/webhooks/stripe_es`, `/api/webhooks/stripe_ae`) and secret.
- Capabilities: `stripe_es` → EU, GB, CA, US in EUR, GBP, CAD, USD; `stripe_ae` → AE, SA, KW, QA, BH, OM in AED, SAR; `paymob` → EG in EGP (`card`, and `wallet` if its integration id is set); `cod` → EG in EGP; `mock` → `'*'`, all currencies, `card` and `cod`. `saudi.js` documents where mada/Tabby/Tamara will plug in and returns `null`.
- `cod` is created only when `deps.suppliers` holds an adapter with `capabilities.cod`. `createCheckout` returns `{ kind: 'confirmed' }`; `refund` throws `ProviderError('COD_NO_REFUND')`.
- `mock` redirects to `/api/mock/pay/:paymentId`, a small page with "pay" and "fail" buttons that posts a signed event to `/api/webhooks/mock` (HMAC-SHA256, key `mock`) and then sends the browser to the success or cancel URL.
- Paymob facts must be re-read from Paymob's current documentation before coding; its HMAC covers a fixed ordered list of fields.
- Registry: `loadPayments(config, deps)` → `{ get(id), list(), forDestination({ country, currency }) → [{ provider, methods }] }`.

Webhook route (`pay`), for every provider: `events = await provider.parseWebhook(req)`; for each event, `if (await recordWebhookOnce(ctx, { source: 'pay:' + id, eventId, type, rawBody })) await handlePaymentEvent(ctx, id, event)`; answer `200 { ok: true }`. Unknown provider → 404. If a handler throws, answer 500 so the provider retries; the `webhook_events` row is then marked `failed` and a repeat of the same event is processed again.

### SupplierAdapter

```js
adapter.id                         // 'printful' | 'printify' | 'gelato' | 'printlet' | 'mock' | 'manual'
adapter.capabilities               // { webhooks, cancel, cod, liveQuote }  (booleans)
await adapter.isAvailable(line, destination)          // → boolean; no network call slower than 2 s
await adapter.quote(lines, destination)
   // → { supplier, currency, itemsCost, shippingCost, total, minDays, maxDays, shippingMethod,
   //     source: 'api' | 'table' }
await adapter.createOrder(fulfilment)
   // → { supplierOrderRef, status: 'submitted' | 'in_production', cost?: { amount, currency } }
await adapter.getOrder({ supplierOrderRef, externalId })
   // → SupplierOrderState | null (null = the supplier has no such order)
await adapter.parseWebhook({ rawBody, headers, query })    // → SupplierEvent[]
await adapter.cancel({ supplierOrderRef, externalId })     // → { cancelled: boolean, reason? }

line        = { orderItemId, productId, variantKey, category, qty, personalisation, mapping }
              // mapping = this supplier's entry from catalogue/mapping.js, or null
destination = { country, region, state, postcode, city }
fulfilment  = { id, externalId, orderPublicId, lines, shippingMethod, currency, lang,
                recipient: { name, line1, line2, city, state, postcode, country, phone, email },
                cod: { amount, currency } | null }
SupplierOrderState = { status: 'submitted' | 'in_production' | 'shipped' | 'delivered' |
                       'cancelled' | 'failed' | 'on_hold', rawStatus, problem?,
                       shipments: [{ ref, carrier, trackingNumber, trackingUrl, shippedAt, deliveredAt }] }
SupplierEvent = { eventId, type: 'order.updated' | 'stock.updated' | 'ignored',
                  externalId, supplierOrderRef }
```

Rules for `sup`:

- `createOrder` is idempotent on `fulfilment.externalId` (Printful `external_id`, Printify `external_id`, Gelato `orderReferenceId`). On a duplicate-reference answer, fetch the existing order and return it as success. Printful: create with `confirm`. Printify: create from an existing product/variant, then call send-to-production. Gelato: one order may come back as several linked orders; report all their shipments.
- `isAvailable` is false when `line.mapping` is null or `destination.region` is not in `mapping.regions`. Stock events may update an in-memory unavailable set.
- `quote` may call the supplier's shipping/cost API; when that fails or takes more than 3 s, return the table values from the mapping with `source: 'table'`.
- A supplier webhook is only a signal: `core` then calls `getOrder` for the real state. Verification: Printify's signing secret where offered; otherwise a shared secret in the registered URL (`?key=<…_WEBHOOK_SECRET>`), compared in constant time. Bad key → `AppError('WEBHOOK_SIGNATURE', 400)`. When the payload has no event id, use `sha256(rawBody)`.
- `manual`: `isAvailable` true, `quote` returns zeros with `days` from the rule, `createOrder` returns `{ supplierOrderRef: externalId, status: 'submitted' }` and nothing else happens; `core` parks the fulfilment as `manual` and alerts the owner. `mock`: deterministic and in-memory; a line with `personalisation.name === 'FAIL'` fails with a retryable error, `'REJECT'` with a non-retryable one; `mock.ship(externalId)` (test helper) marks it shipped with tracking `MOCK123`.
- Printlet's API was not read during the research. `sup` reads its developer page first; if a call cannot be confirmed, the adapter keeps the interface, and `createOrder` throws a non-retryable `ProviderError('PRINTLET_UNVERIFIED')`, which sends the fulfilment to `manual`.
- Registry: `loadSuppliers(config, deps)` → `{ get(id), has(id), list() }`. `manual` exists whenever mode is not `off`; `mock` only in mode `mock`.

Webhook route (`sup`): same pattern as payments, with `source: 'sup:' + id` and `handleSupplierEvent`.

## e. Routing engine

`route(lines, destination, ctx) → { fulfilments: [{ supplier, candidates, lineKeys, quote }], unavailable: [{ key, reason }] }`, used by both `/api/quote` and order confirmation.

Rules live in `server/routing/rules.json`, which the owner can edit and redeploy:

```json
{
  "version": 1,
  "costFx": { "EUR": 1, "USD": 0.92, "GBP": 1.17, "CAD": 0.67, "AED": 0.25, "SAR": 0.245, "EGP": 0.019 },
  "blocked": [{ "category": "fragrance", "region": "*" }, { "category": "electronics", "region": "*" }],
  "rules": [
    { "category": "apparel", "region": "EU", "candidates": [["printful", "gelato"], "printify"] },
    { "category": "apparel", "region": "EG", "candidates": ["printlet"] },
    { "category": "wall_art", "region": "AE", "candidates": ["gelato"] },
    { "category": "*", "region": "*", "candidates": [] }
  ]
}
```

1. **Rule lookup**: most specific wins: `category+region`, then `category+*`, then `*+region`, then `*+*`. A `blocked` match makes the line unavailable.
2. **Candidates** are tried in order. An inner array is a tier: its members are equals and are ranked by landed cost (`quote.total` converted with `costFx`, which is used only for this comparison), then `maxDays`, then listed order.
3. **Filter**: drop suppliers that are not loaded, have no mapping for the variant, do not list the region, or answer `isAvailable` false. For a COD order, drop suppliers without `capabilities.cod`.
4. **Split**: repeat until every line is assigned: among suppliers that are in the best remaining tier of at least one unassigned line, take the one that covers the most lines (ties: lower landed cost, then days, then name) and give it those lines. Each pick becomes one fulfilment; its `candidates` is the ordered list of suppliers able to take all of its lines.
5. **No candidate**: at quote time the line is `unavailable` (`NOT_AVAILABLE_IN_REGION`) and checkout is refused, unless the rule itself names `"manual"`. After payment, `manual` is always the last fallback.

`core` fills the table from the study's routing table. Cells the study marks "unconfirmed" get an empty candidate list, so those lines are not sold there until the owner adds a supplier after a test order.

## f. Public API

Same origin, so no CORS. JSON bodies up to 100 kB. Every response carries `Cache-Control: no-store`.

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /api/config` | none | `{ enabled, mode: 'off'\|'mock'\|'live', countries: [{ code, region, currency, methods: ['card','cod'] }], currencies, defaultCountry, flags: { us, uk }, whatsappFallback: true }` | none; with commerce off it answers `enabled: false` and empty lists |
| `POST /api/quote` | `{ country, state?, postcode?, items: [{ id, qty, options, personalisation? }], paymentMethod?, lang? }` | see below | 400 `VALIDATION`, 422 `MARKET_NOT_SERVED`, 422 `CART_EMPTY`, 503 `COMMERCE_OFF`, 429 `RATE_LIMITED` |
| `POST /api/checkout` | quote request plus `{ checkoutId, shippingOption, paymentMethod, customer: { name, email, phone? }, address: { line1, line2?, city, state?, postcode? }, note?, acceptTerms: true, expectedTotal }` | 201 `{ orderId, token, statusUrl, payment: { kind: 'redirect', url } \| { kind: 'confirmed' } }` | as quote, plus 422 `ITEM_UNAVAILABLE` (`fields` lists line keys), 409 `PRICE_CHANGED` (body carries a fresh `quote`), 422 `PAYMENT_METHOD_UNAVAILABLE`, 502 `PAYMENT_PROVIDER_ERROR` |
| `POST /api/webhooks/:provider` | raw provider body | 200 `{ ok: true }` | 400 `WEBHOOK_SIGNATURE`, 404, 500 |
| `POST /api/webhooks/supplier/:supplier` | raw supplier body | 200 `{ ok: true }` | 400 `WEBHOOK_SIGNATURE`, 404, 500 |
| `GET /api/orders/:publicId?token=` | none | see below | 404 `NOT_FOUND` for a wrong id and for a wrong token alike |
| `POST /api/cron/tick` | header `Authorization: Bearer <CRON_SECRET>` (or `?secret=`) | `{ ok, ran, failed, remaining, tookMs }` | 401; 404 when `CRON_SECRET` is unset |
| `GET /api/admin/orders?status=&attention=1&limit=50&before=<id>` | HTTP Basic | `{ orders: [...], nextBefore }` | 401; 404 when admin env is unset |
| `GET /api/admin/orders/:publicId`, `GET /api/admin/jobs?status=dead` | HTTP Basic | full order with items, payments, fulfilments, shipments, events, emails; job rows | same |

Quote response:

```json
{ "country": "ES", "region": "EU", "currency": "EUR",
  "lines": [{ "key": "halos-off-hoodie|size=M", "id": "halos-off-hoodie", "qty": 1,
              "unit": 7900, "total": 7900, "fulfilment": 0 }],
  "unavailable": [{ "key": "secret-no-1|volume=50 ml", "reason": "NOT_AVAILABLE_IN_REGION" }],
  "shippingOptions": [{ "id": "standard", "amount": 499, "minDays": 4, "maxDays": 9 }],
  "fulfilments": [{ "index": 0, "lineKeys": ["halos-off-hoodie|size=M"], "minDays": 4, "maxDays": 9 }],
  "tax": { "included": true, "rateBp": 2100, "amount": 1458, "labelKey": "checkout.tax.vatIncluded" },
  "subtotal": 7900, "shipping": 499, "total": 8399,
  "paymentMethods": [{ "method": "card", "provider": "stripe_es" }],
  "notices": ["checkout.notice.splitShipment"] }
```

Supplier ids are never sent to the browser. `paymentMethods` lists `cod` only when a COD provider serves the country and every fulfilment's supplier has `capabilities.cod`. Customer shipping is one price per order from `pricing/shipping-rates.json` (`{ "EU": { "EUR": { "base": 499, "perExtraItem": 150, "freeFrom": 9000 } } }`), even when the order splits.

Order view: `{ id, status, paymentStatus, paymentMethod, createdAt, currency, lang, items: [{ id, name, options, personalisation, qty, unit, total }], subtotal, shipping, tax: { included, amount, rateBp }, total, shipTo: { city, country }, fulfilments: [{ index, status, itemKeys, etaMinDays, etaMaxDays, shipments: [{ carrier, trackingNumber, trackingUrl, shippedAt, deliveredAt }] }], timeline: [{ type, status, at }] }`. No e-mail, phone or street address is returned.

**Checkout rules**: `checkoutId` is a UUID the browser creates once per attempt. The same `checkoutId` again returns the same order and, while it is still `pending_payment`, the same redirect URL. The server re-runs the whole quote; `expectedTotal` must equal the recomputed total. `statusUrl` = `<PUBLIC_BASE_URL>/order?id=<publicId>&token=<token>`; the payment success URL is the same with `&paid=1`, the cancel URL is `/checkout?cancelled=<publicId>`. The browser clears the bag on the status page, not before the redirect.

**Validation** (`lib/validate.js`; text fields go through the same `tidy` rule as `src/js/checkout.js`): at most 20 lines; `qty` integer 1 to 10; `id` known, sellable and live; `options` exactly the product's option names with listed values; `personalisation` only declared keys, each matching its `pattern` and `maxLength`; `country` in the enabled list; `name` 2 to 60; `email` at most 191 with one `@` and a dot in the domain; `phone` in E.164, required for COD and for AE, GCC and EG; `line1` 3 to 191; `city` 2 to 120; `postcode` required for EU, UK, CA, US; `note` at most 300; `lang` one of the 11 codes, else `en`; `acceptTerms` must be `true`. Unknown fields are ignored.

**Rate limits** (per IP, in memory, one process): quote 60/min; checkout 10 per 10 min; order view 30/min; admin 30/min and a 15-minute block after 5 failed logins; cron 10/min. Webhooks are not rate-limited (the signature is the gate) but are capped at 1 MB.

## g. Sequences

Job types: `fulfilment.submit`, `fulfilment.poll`, `email.send`, `payment.refund`, `orders.expire`, `orders.anonymise`, `owner.alert`. Every `enqueue` has an idempotency key (`fulfilment.submit:<id>:<candidate_index>`, `email:<email_log.idem_key>`, …); a duplicate key is a silent no-op. `tick` first re-queues `running` jobs whose lock is older than 5 minutes, then claims due jobs one at a time (`UPDATE … WHERE id = ? AND status = 'queued'`, proceed only if one row changed) until its budget is spent: 20 s for the in-process timer (every 30 s, `unref`), 50 s for `/api/cron/tick`. A job that throws is re-queued with backoff until `max_attempts`, then becomes `dead` and raises an owner alert.

1. **Card, happy path**. `POST /api/checkout` → validate, quote, route → one transaction inserts `orders` (`pending_payment`, `expires_at` = now + 60 min), `order_items`, `payments` (`created`) → `provider.createCheckout` → store `provider_ref`, `redirect_url`, status `pending` → 201 → browser goes to the provider. Webhook `payment.succeeded` → dedupe → `handlePaymentEvent`: check amount and currency against the payment row; payment `succeeded`; order `confirmed` / `paid`; route again and insert `fulfilments` (`pending`), linking the items; enqueue `fulfilment.submit` per fulfilment and `email.send` (`order_confirmed`); then run those jobs inline for at most 10 s so the usual case finishes inside the webhook. `fulfilment.submit`: `submitting` → `adapter.createOrder` → `submitted`, `next_poll_at` set → order `processing`.
2. **Paid, supplier call fails**. Retryable error: back to `pending`, `submit_attempts + 1`, job re-queued after 1, 5, then 15 minutes. Non-retryable error, or the fourth failure: first `getOrder({ externalId })` on the failing supplier (if the order exists there after all, adopt it); otherwise move to the next candidate (`candidate_index + 1`, new `external_id`, attempts reset). No candidate left: `supplier = 'manual'`, status `manual`, `orders.needs_attention = true`, `owner.alert` e-mail to `OWNER_ALERT_EMAIL`. The customer is not refunded automatically; a human decides.
3. **COD**. Allowed only as in section f. Order is created `confirmed` / `cod_due`, payment row `cod_due`; fulfilments are created at once with `cod: { amount, currency }`; e-mail `order_confirmed` in its COD wording. If rerouting finds no COD-capable candidate, the fulfilment goes to `manual`. Supplier state `delivered` sets `cod_collected`.
4. **Cancel and refund before production**. `cancelOrder(ctx, publicId, { reason })`, called in v1 only by `scripts/cancel-order.js`: fulfilments in `pending` or `manual` are cancelled directly; `submitted` ones through `adapter.cancel`; if any is `in_production` or later, or a supplier refuses, nothing changes and the script reports `CANNOT_CANCEL`. Then order `cancelled`, `payment_status = refund_pending`, job `payment.refund` (`provider.refund` with key `refund:<payment id>:<amount>`), then `refunded` and e-mail `order_cancelled`. Refunds made in the provider's dashboard arrive as `refund.succeeded` and update the same fields.
5. **Supplier says shipped**. Webhook → dedupe → `handleSupplierEvent` → `adapter.getOrder` → upsert `shipments` on (fulfilment_id, supplier_shipment_ref) → fulfilment `shipped` → `recomputeOrderStatus` → `email.send` `shipped` with key `shipped:shipment:<id>` (one e-mail per shipment). `fulfilment.poll` does the same every 6 hours for `submitted` and `in_production` fulfilments (every hour when the supplier has no webhooks), and alerts the owner when one has been open for 10 days or the supplier reports `failed` or `on_hold`.
6. **Duplicate webhooks**. The unique (source, event_id) row makes the second delivery answer 200 without work. Every state change is also guarded by the transition tables, and job and e-mail keys are unique, so a replay that slips past changes nothing.
7. **Abandoned orders**. `orders.expire` (enqueued by each tick, key per 5-minute window) takes `pending_payment` orders past `expires_at`, asks `provider.getPayment`: `succeeded` → handled as a payment event; otherwise order `expired`, payment `expired`. No e-mail. `orders.anonymise` blanks e-mail, phone, name and address on expired orders older than 30 days.

E-mail templates: `order_confirmed`, `shipped`, `order_cancelled`, `refund_issued` (customer language, English fallback per key, `dir="rtl"` for Arabic) and `owner_alert` (English). With no SMTP config the row is `skipped`; in mock mode messages go to `ctx.outbox` for tests.

i18n keys (`web` adds them in all 11 files; `core` lists the exact e-mail keys it reads in `email/templates.js`): `checkout.*`, `order.*`, `orderStatus.<status>`, `fulfilmentStatus.<status>`, `payMethod.<method>`, `apiError.<CODE>`, `email.<template>.subject|intro|…`, `email.common.*`. Country names come from `Intl.DisplayNames`, not from the dictionaries.

## h. Tax and price display

v1 shows prices and stores tax fields; it does not file, register or decide anything.

- `computeTax({ country, region, currency, lines, shipping }) → { included, rateBp, amount, lines: [{ key, amount }], labelKey, notices }` in `pricing/tax.js` is the only place tax is calculated. Everything else treats its result as opaque. A later version can replace the inside with Stripe Tax or a fuller rules table without touching callers.
- v1 reads `pricing/tax-rules.json`: EU countries, GB, AE, SA and EG are **tax-inclusive** (the shown price is final; tax = gross × r / (1 + r) at the destination's rate, for display and records). One gross price serves the whole EU. CA and US are **tax-exclusive at rate 0**, with the notice `checkout.notice.dutiesMayApply`. KW, QA, BH, OM: rate 0 plus the same notice.
- `orders.tax_total`, `tax_included`, `tax_rate_bp`, `tax_details` and `order_items.tax_amount` are stored on every order.
- The rates in that file are starting values, not advice. Which entity sells in each market, OSS, recargo de equivalencia, Canadian and Gulf registration, and whether to switch on Stripe Tax are the owner's decisions with his adviser, before live mode.

## i. Environment

All read by `core` in `config.js`; the "used by" role consumes the parsed group. A group is `null` unless every required variable in it is set.

| Variable | Meaning | Used by | Enables |
|---|---|---|---|
| `COMMERCE_MODE` | unset or `off`; `mock`; `live` | core | `mock`: mock payment and supplier, SQLite at `./data/mock.sqlite` if no `DATABASE_URL`. `live`: real providers, requires `DATABASE_URL` |
| `DATABASE_URL` | `mysql://user:pass@host:3306/db` or `sqlite:./file` | core | the database; required for `live` |
| `PUBLIC_BASE_URL` | `https://thecutedevil.com` | core, pay | absolute links in redirects and e-mails; required for `live` |
| `PORT` | listen port (Hostinger sets it) | core | |
| `STRIPE_ES_SECRET_KEY`, `STRIPE_ES_WEBHOOK_SECRET` | Spanish account | pay | `stripe_es`: EU, UK, CA, US |
| `STRIPE_AE_SECRET_KEY`, `STRIPE_AE_WEBHOOK_SECRET` | UAE account | pay | `stripe_ae`: AE, GCC |
| `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_INTEGRATION_ID_CARD` | Paymob Egypt | pay | `paymob`: EG cards |
| `PAYMOB_INTEGRATION_ID_WALLET` | optional | pay | wallet method |
| `PRINTFUL_API_KEY`, `PRINTFUL_WEBHOOK_SECRET` (+ optional `PRINTFUL_STORE_ID`) | Printful token; URL secret we choose | sup | `printful` |
| `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`, `PRINTIFY_WEBHOOK_SECRET` | Printify | sup | `printify` |
| `GELATO_API_KEY`, `GELATO_WEBHOOK_SECRET` | Gelato | sup | `gelato` |
| `PRINTLET_API_KEY`, `PRINTLET_BASE_URL`, `PRINTLET_WEBHOOK_SECRET` | Printlet Egypt | sup | `printlet`, and through it `cod` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | mail server | core | sending e-mail (otherwise logged as `skipped`) |
| `OWNER_ALERT_EMAIL` | where alerts go | core | owner alerts |
| `CRON_SECRET` | bearer for the tick | core | `/api/cron/tick` |
| `ADMIN_USER`, `ADMIN_PASS` | Basic auth | core | `/api/admin/*` |
| `ENABLE_US`, `ENABLE_UK` | `1` to open the market | core | US, UK (both off by default) |
| `ORDER_LINK_SECRET` | random string, at least 32 characters (for example `openssl rand -hex 32`) | core | the "View your order" link in customer e-mails; without it the e-mails carry no link. Mock mode uses a fixed public value |
| `PRINTLET_API_CONFIRMED` | `1` once Printlet has confirmed the open API points (see "Suppliers notes") | sup | default off: Printlet stays unavailable, no COD, orders for it go to `manual` |
| `PRINTFUL_CONFIRM` | `1` / `0` | sup | unset: draft orders in mock mode, confirmed (charged) orders in live mode |
| `PRINTFUL_WEBHOOK_SIGNING_KEY_HEX` | hex key, only for Printful v2 webhooks | sup | unset: v1 webhooks, checked by the secret in the URL |
| `PRINTIFY_SEND_TO_PRODUCTION` | `1` / `0` | sup | unset: not sent in mock mode, sent in live mode |
| `GELATO_CONFIRM` | `1` / `0` | sup | unset: `orderType: draft` in mock mode, `order` in live mode |
| `GELATO_RETURN_COMPANY_NAME`, `_ADDRESS_LINE1`, `_ADDRESS_LINE2`, `_CITY`, `_POST_CODE`, `_STATE`, `_COUNTRY`, `_EMAIL`, `_PHONE` | return address printed on Gelato parcels | sup | sent only when name, line 1, city, postcode and country are all set; otherwise no return address |

`/api/config` reports `enabled: true` only when mode is not `off`, the database is open, the catalogue validates, and at least one payment provider and one supplier are loaded. A country appears in `countries` only if its market is switched on, a payment provider serves it, and at least one sellable product routes there.

## j. Deployment

```json
"scripts": {
  "dev": "vite",                              "dev:api": "node --watch server/index.js",
  "build": "vite build",                      "start": "node server/index.js",
  "migrate": "node server/scripts/migrate.js", "test": "node --test"
}
```

- Hostinger: build `npm run build`, start `npm start`, Node 20 or 22. Migrations also run on every boot, so no shell access is needed. Cron (every minute, or the shortest interval the plan allows): `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://thecutedevil.com/api/cron/tick`.
- Development: terminal 1 `COMMERCE_MODE=mock npm run dev:api` (port 3000), terminal 2 `npm run dev`. `vite.config.js` proxies `/api` to `127.0.0.1:${API_PORT || 3000}` for both `dev` and `preview`.
- Static: Express serves `dist/` with `extensions: ['html']`, so `/shop` and `/shop.html` both work; `/assets/*` is cached for a year, HTML is revalidated. Any unknown non-API path answers status 404 with `dist/404.html` (a `<base href="/">` is injected so it renders on nested paths). Unknown `/api` paths answer JSON 404.
- `better-sqlite3` is an optional dependency: if its native build fails on the host, production with MySQL is unaffected.
- Front-end calls use the absolute path `/api/...`. The site must be served from the domain root.

## k. Tests

`npm test` runs every `*.test.js` under `server/test/` with Node's runner. No network: providers and suppliers are tested with a stubbed `fetch` (`deps.fetch`) and recorded fixtures.

| Role | Must cover |
|---|---|
| core | config parsing; migration up and down on SQLite; both state machines (every illegal transition rejected); job queue (claim once, backoff, stale lock, idempotency key); routing (precedence, tiers, tie-breaks, split, blocked, COD filter, manual); shipping and tax arithmetic; validation of every field; catalogue validation including the front-end id check; e-mail language fallback; rate limiter |
| pay | per provider: capabilities; `createCheckout` request shape, amounts and idempotency key; webhook signature accept and reject; event mapping; refund; `forDestination` for one country of each region; Stripe instance separation (an ES event with the AE secret is rejected) |
| sup | per adapter: mapping to the supplier's order payload; duplicate `externalId` returns the existing order; status mapping for every documented supplier status; webhook secret check; quote fallback to table; cancel refusal; registry loads only configured adapters |
| web | `web/qa/commerce.py` against mock mode: add to bag → checkout → mock pay → status page, in `en`, `ar` (RTL) and one more language; commerce off still shows the WhatsApp flow; a missing i18n key fails the run |

Shared end-to-end harness: `server/test/harness.js` → `startTestServer(env)` starts the real server on a free port with `COMMERCE_MODE=mock` and a temporary SQLite file, and returns `{ url, ctx, db, api(path, init), close() }`. `core` writes `server/test/e2e.*.test.js`, one file per sequence in section g, driving time with `POST /api/cron/tick` and an injectable clock (`ctx.now`).

## l. Security checklist

- Verify every webhook signature or shared secret on the raw body before parsing; compare in constant time.
- Deduplicate webhooks on (source, event_id); give every supplier call, payment call, job and e-mail an idempotency key.
- Never trust the browser for prices, currency, tax, shipping or totals: the server recomputes all of them from the catalogue and rule files, and checks the paid amount and currency against the payment row.
- Order access: 32 random bytes as hex, shown once, stored only as SHA-256; the same 404 for a wrong id and a wrong token; `Referrer-Policy: no-referrer` on the order page.
- PII: store only what delivery needs; never store card data; do not store webhook bodies (hash only); anonymise expired orders after 30 days; the order view omits e-mail, phone and street address.
- Logs: one line per event with ids and codes only. No secrets, tokens, e-mail addresses, street addresses or full provider payloads. `lib/log.js` redacts keys named like `key`, `secret`, `token`, `pass`, `authorization`, `email`, `phone`.
- Secrets only in env; `.env*` and `data/` are git-ignored. Admin and cron endpoints answer 404 when their secrets are unset.
- Headers on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`; a Content-Security-Policy on `checkout.html` and `order.html` that allows only self.
- Parameterised queries only (Knex bindings); JSON body limit 100 kB; rate limits of section f.
- Personalisation text is validated by pattern and a blocklist before it reaches a supplier; anything doubtful sends the fulfilment to `manual`.

## Payments notes (pay, 2026-11-12)

Written by the `pay` role after building `server/payments/*`, `server/routes/webhooks-payment.js`, `server/routes/mock-pay.js` and `server/test/pay/*`. Nothing above was changed.

### Environment variables

| Variable | Where to find it | Effect |
|---|---|---|
| `COMMERCE_MODE` | | `mock` loads only the `mock` provider (every country, every currency, `card` + `cod`). `live` loads the real providers below, each only when its whole group is set. |
| `PUBLIC_BASE_URL` | | Success/cancel URLs (built by `core`) and Paymob's `notification_url`. Must be the public HTTPS origin in live mode. |
| `STRIPE_ES_SECRET_KEY`, `STRIPE_ES_WEBHOOK_SECRET` | Spanish Stripe account: API keys (`sk_…`), and the signing secret (`whsec_…`) of the endpoint created below | `stripe_es`: EU-27, GB, CA, US in EUR, GBP, CAD, USD |
| `STRIPE_AE_SECRET_KEY`, `STRIPE_AE_WEBHOOK_SECRET` | UAE Stripe account, same two values | `stripe_ae`: AE, SA, KW, QA, BH, OM in AED, SAR |
| `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_INTEGRATION_ID_CARD` | Paymob dashboard → Settings → Account info (keys, HMAC) and Developers → Payment Integrations (the id of the "Online Card" integration) | `paymob`: EG in EGP, method `card` |
| `PAYMOB_INTEGRATION_ID_WALLET` | id of the "Mobile Wallet" integration | adds method `wallet` |
| (none) | | `cod` loads in live mode when a loaded supplier has `capabilities.cod` (EG, EGP). `saudi` never loads in v1. |

The Paymob dashboard menu names in this section are not taken from the documentation pages that were read; follow Paymob's "Getting Integration Credentials" guide if they differ. Test keys and live keys are different values for every row. A webhook signing secret belongs to one endpoint of one account in one mode.

### Webhook URLs to register

Replace `https://thecutedevil.com` with `PUBLIC_BASE_URL` if it differs.

| Where | URL | Settings |
|---|---|---|
| Stripe dashboard of the **Spanish** account → Developers → Webhooks → Create an event destination | `https://thecutedevil.com/api/webhooks/stripe_es` | Events from **Your account**; payload format **Snapshot** (not "Thin", which the dashboard now preselects); API version **2026-10-28.endive**; the seven events below. Copy the `whsec_…` into `STRIPE_ES_WEBHOOK_SECRET`. |
| Stripe dashboard of the **UAE** account, same steps | `https://thecutedevil.com/api/webhooks/stripe_ae` | Same settings and events. Copy its own `whsec_…` into `STRIPE_AE_WEBHOOK_SECRET`. |
| Paymob dashboard → Developers → Payment Integrations → each integration used (card, and wallet if enabled) → **Transaction processed callback** | `https://thecutedevil.com/api/webhooks/paymob` | The same URL is also sent as `notification_url` with every intention. **Transaction response callback** (where the browser returns) can stay empty: every intention sends its own `redirection_url`. |

Stripe events to subscribe to, on both accounts:

```
checkout.session.completed
checkout.session.expired
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
payment_intent.payment_failed
charge.refunded
refund.failed
```

Paymob has no event list: the callback is sent for every processed transaction (payment, refund, void).

Local testing of Stripe without a public URL: `stripe listen --forward-to localhost:3000/api/webhooks/stripe_es` prints a temporary `whsec_…` to use as the secret.

### How provider events map to PaymentEvent

| Provider event | PaymentEvent |
|---|---|
| Stripe `checkout.session.completed` with `payment_status` `paid` / `no_payment_required` | `payment.succeeded` (providerRef = session id, providerPaymentRef = PaymentIntent id) |
| Stripe `checkout.session.completed` with `payment_status: unpaid` (delayed method) | `ignored`; the result follows as one of the next two |
| Stripe `checkout.session.async_payment_succeeded` / `async_payment_failed` | `payment.succeeded` / `payment.failed` |
| Stripe `checkout.session.expired` | `payment.expired` |
| Stripe `payment_intent.payment_failed` | `ignored` while its session is still open (a declined card can be retried on the same page); `payment.failed` once the session is closed. Costs one Stripe API call (session lookup); if that call fails the route answers 500 and Stripe retries. |
| Stripe `charge.refunded` | `refund.succeeded` |
| Stripe `refund.failed` (also `charge.refund.updated` with status `failed`, if subscribed) | `refund.failed` (providerPaymentRef only) |
| Stripe sessions/charges without our `order_public_id` metadata (Payment Links, dashboard payments), every other type | `ignored` |
| Paymob transaction, `success: true` | `payment.succeeded` (providerRef = Paymob order id = `intention_order_id`, providerPaymentRef = transaction id) |
| Paymob transaction, `success: false`, not pending | `payment.failed`. This is one declined attempt: a later `payment.succeeded` for the same providerRef can still arrive. |
| Paymob transaction, `pending: true`; original transaction repeated with `is_refunded` / `is_voided` | `ignored` |
| Paymob refund/void transaction | `refund.succeeded` / `refund.failed` (providerPaymentRef = `parent_transaction`) |

Points `core` should know:

- **Refund amounts**: on `refund.*`, `amount` is the amount of that one refund. Stripe events also carry `totalRefunded` (everything refunded so far on the payment). A refund started by our own `payment.refund` job comes back a second time as a webhook `refund.succeeded`; treat it as the same refund (cap `refunded_amount` at `totalRefunded` or at the payment amount), not as a second one.
- **Finding the payment row**: `providerRef` is set whenever it could be resolved. On Stripe `refund.failed`, and on `charge.refunded` when the session lookup failed, only `providerPaymentRef` is set, so match on `(provider, provider_payment_ref)` as a fallback. Store `providerPaymentRef` from `payment.succeeded`: both providers need it to refund.
- **Dedupe**: the route calls `recordWebhookOnce` then `handlePaymentEvent` for every event, `ignored` ones included. It also updates `webhook_events.status` itself (`processed` / `ignored` / `failed` + `last_error`), best effort. For the contract's "a repeat of a failed event is processed again", `recordWebhookOnce` must answer `true` when the existing row's status is `failed`.
- **Timing**: with a `success_url` set, Stripe holds the customer's redirect for up to 10 seconds waiting for the answer to `checkout.session.completed`. The inline job run after a payment should stay well under that.
- **Mounting**: `routes/webhooks-payment.js` as in `app.js`'s comment (`express.raw` before `express.json`); it answers 500 rather than trust a body a JSON parser already consumed. `routes/mock-pay.js` works as `api.use('/mock/pay', mockPay(ctx))` or `api.use(mockPay(ctx))`, parses its own form body, and answers 404 outside mock mode.
- **Mock**: `createCheckout` answers a relative URL (`/api/mock/pay/<payment id>?…`, signed), so it works behind the Vite proxy and on any port. With `payment.method === 'cod'` it answers `{ kind: 'confirmed' }`. The page's buttons have ids `mock-pay` and `mock-fail` (for `web/qa/commerce.py`); it posts the signed event to `/api/webhooks/mock` on the same server, then redirects (303) to the success or cancel URL, which must be a path or lie under `PUBLIC_BASE_URL`, else `/`.
- **Session lifetime** is 31 minutes, not 30: Stripe rejects anything under 30 minutes by its own clock, and the extra minute absorbs clock skew.
- **Amounts**: providers charge exactly `payment.amount`. When items + shipping do not add up to it (discount, exclusive tax), the order is sent as one line "Order <publicId>" of that amount. Stripe sessions whose returned total differs from `payment.amount` are expired and refused (`STRIPE_AMOUNT_MISMATCH`).
- **Languages**: Stripe Checkout has no Arabic and no Hindi; `ar` and `hi` are sent as `locale: auto` (the browser's language).
- `registry.methodsFor({ country, currency })` (extra, optional) returns the flat `[{ method, provider }]` list for the quote.

### To check with live test keys before going live

Stripe (documentation read 2026-11-12; code follows it, these are behaviours only a real account shows):

1. `shipping_options` with `shipping_rate_data` is accepted on a session without `shipping_address_collection`, and the page shows the shipping line.
2. The UAE account can present and settle **SAR** as well as AED, and which payment methods each account's dashboard offers per currency (methods are not listed in code; the dashboard settings decide).
3. `charge.refunded` carries `data.previous_attributes.amount_refunded` on a second partial refund (used to compute the single refund's amount), and the Charge carries the PaymentIntent's metadata.
4. Each webhook endpoint really is Snapshot format at API version 2026-10-28.endive.

Paymob (the developer site's home page and several sub-pages could not be opened from the build environment; the "create intention", "unified checkout", "HMAC transaction callback" and "refund" pages were read). Each item is isolated in one commented function or constant at the top of `server/payments/paymob.js`:

1. `intentionPath()`: the create-intention path `/v1/intention/` on `https://accept.paymob.com` (the docs page shows only "/" under a blank base URL).
2. `intentionExpiration()`: the unit of `expiration` (seconds assumed).
3. `refundRequest()`: refund authenticated with `Authorization: Token <secret key>`. The documented example uses an `auth_token` in the body from the older API-key login, for which there is no env var.
4. `inquiryRequest()`: looking a payment up by order id (`/api/ecommerce/orders/transaction_inquiry` with the secret key). If Paymob refuses it, `getPayment` reports `pending`, so the order simply expires and a real payment still arrives by webhook.
5. `transactionKind()`: the callback field names `is_refund` / `is_void` on refund and void transactions (`parent_transaction` is documented).
6. Whether Paymob rejects a second intention with the same `special_reference` (we send `payment.idemKey`; Paymob has no idempotency header), whether the items must add up to `amount` (they always do here), and the exact `billing_data` fields it insists on (`phone_number` is documented; the rest are sent, `NA` when unknown).
7. The HMAC: field order and the documented example string are reproduced by a test, but the documentation does not publish the secret of its example, so the final digest has only been checked against our own computation. Verify one real callback.
8. `redirection_url` receives the browser after failed payments too (the status page must show the order's real state, not trust `paid=1`).

## Suppliers notes (sup, 2026-11-12)

Files: `server/suppliers/` (`http.js`, `util.js`, `regions.js`, `printful.js`, `printify.js`, `gelato.js`, `printlet.js` + `printlet-api.js`, `mock.js`, `manual.js`, `registry.js`, `tools/list-catalogue.js`), `server/routes/webhooks-supplier.js`, `server/catalogue/mapping.js`, tests in `server/test/sup/`, fixtures in `server/test/fixtures/sup/fixtures.js`.

### Environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `PRINTFUL_API_KEY`, `PRINTFUL_WEBHOOK_SECRET` | `printful` | Private token (it expires: renew it by hand). The webhook secret is a random string **we** choose; it goes in the webhook URL. `PRINTFUL_STORE_ID` only for an account-level token. |
| `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`, `PRINTIFY_WEBHOOK_SECRET` | `printify` | Personal access token (valid one year). The secret is given to Printify when the webhook is created; Printify signs with it. |
| `GELATO_API_KEY`, `GELATO_WEBHOOK_SECRET` | `gelato` | The secret is a random string we choose; it goes in the webhook URL. |
| `PRINTLET_API_KEY`, `PRINTLET_BASE_URL`, `PRINTLET_WEBHOOK_SECRET` | `printlet` | Base URL `https://printleteg.com/api/integrations/v1`. Start with a `prnt_test_…` key. The secret goes in the webhook URL. |

**Four optional settings the adapters already read, but `server/config.js` (owner `core`) does not pass through yet.** Until `core` adds them, the safe defaults apply:

| Proposed variable | Config key the adapter reads | Default when absent |
|---|---|---|
| `PRINTLET_API_CONFIRMED=1` | `config.printlet.apiConfirmed` (boolean) | **off**: Printlet stays unavailable, no COD, `createOrder` throws `PRINTLET_UNVERIFIED` → `manual` |
| `PRINTFUL_CONFIRM=1/0` | `config.printful.confirm` | draft in mock mode, confirmed (charged) in live mode |
| `PRINTIFY_SEND_TO_PRODUCTION=1/0` | `config.printify.sendToProduction` | not sent in mock mode, sent in live mode |
| `GELATO_CONFIRM=1/0`, `GELATO_RETURN_*` | `config.gelato.confirm`, `config.gelato.returnAddress` (`{ companyName, addressLine1, addressLine2, city, postCode, state, country, email, phone }`) | `orderType: draft` in mock mode, `order` in live mode; no return address sent |

Also optional: `config.printful.webhookSigningKeyHex` (only if Printful v2 webhooks are used later).

### Webhook URLs to register

| Supplier | URL | How to register | Verification |
|---|---|---|---|
| Printful | `https://thecutedevil.com/api/webhooks/supplier/printful?key=<PRINTFUL_WEBHOOK_SECRET>` | `POST https://api.printful.com/webhooks` with `{ "url": …, "types": ["package_shipped","package_returned","order_failed","order_canceled","order_put_hold","order_put_hold_approval","order_remove_hold","order_updated","order_refunded","stock_updated"], "params": { "stock_updated": { "product_ids": [ … ] } } }`. One URL per store; test with Printful's Webhook Simulator. | v1 has no signature → secret in the URL |
| Printify | `https://thecutedevil.com/api/webhooks/supplier/printify` | One `POST /v1/shops/{shop_id}/webhooks.json` per topic, body `{ "topic": …, "url": …, "secret": "<PRINTIFY_WEBHOOK_SECRET>" }`; topics `order:created`, `order:updated`, `order:sent-to-production`, `order:shipment:created`, `order:shipment:delivered`. | `X-Pfy-Signature: sha256=<HMAC of raw body>` |
| Gelato | `https://thecutedevil.com/api/webhooks/supplier/gelato?key=<GELATO_WEBHOOK_SECRET>` | Gelato dashboard → Developer → Webhooks; events `order_status_updated`, `order_item_status_updated`, `order_item_tracking_code_updated`, `catalog_product_stock_availability_updated`. | no signature documented → secret in the URL |
| Printlet | `https://thecutedevil.com/api/webhooks/supplier/printlet?key=<PRINTLET_WEBHOOK_SECRET>` | In the Printlet dashboard (exact place to be confirmed). | Printlet signs with HMAC but does not publish the header layout → secret in the URL for now |
| mock | `/api/webhooks/supplier/mock?key=mock` with `{ "id": "evt-1", "action": "ship" \| "deliver" \| "fail" \| "hold", "externalId": "<fulfilment external_id>" }` | mock mode only; tests may call `ctx.suppliers.get('mock').ship(externalId)` directly | `?key=mock` or header `x-mock-signature` |

Webhooks are only a signal; `fulfilment.poll` remains the safety net (Gelato retries 3 times in about 10 seconds, Printify blocks a failing webhook for an hour).

### Filling the variant mapping

Every ref in `server/catalogue/mapping.js` starts with `PLACEHOLDER`. An adapter answers `isAvailable = false` for such a ref, so nothing can reach a supplier with a fake id. Costs and days in the file are rough figures for the routing comparison.

1. Create the product with its design in the supplier account (Printify: in the shop named by `PRINTIFY_SHOP_ID`; Printful: either design it in the store, or use a catalogue variant plus a print file URL).
2. Put the print files on a public `https` address and replace the `https://example.com/PLACEHOLDER-print-files/…` URLs.
3. List the ids: `node server/suppliers/tools/list-catalogue.js printful` (store sync variants → `variantRef: 'sync:<id>'`), `… printful <catalogue product id>` (catalogue variants per size), `… printify`, `… printlet` and `… printlet <product id>` (variants and print-area keys), `… gelato <catalogUid>` (unverified endpoint; otherwise copy the productUid from the Gelato dashboard). Set the supplier's env vars first; the webhook secret can be any value for this script.
4. Replace `productRef` / `variantRef` per size, set the real `cost` and `days`, and remove suppliers that do not make the product. For Printlet, `files[].placement` is the print-area key.
5. Personalised products: add `personalisation: { <field>: { placement, urlTemplate: 'https://…?text={value}' } }` to the entry (the URL must return a print file). Without it a personalised line is refused before any call (`PERSONALISATION_NEEDS_HUMAN`) and ends in `manual`. Printify personalised lines always go to the next candidate.
6. Run `npm test`, then place one real test order per supplier in mock mode (orders are created as drafts) before switching to live.

### Verified from official documents, and still to check with a real account

- **Printful** (v1; v2 is still beta with incomplete order endpoints). Verified: endpoints, payload, statuses, `@external_id` lookup, shipping rates, webhook types, 120 requests/minute with `Retry-After`. To check: the exact answer to a repeated `external_id` (the adapter looks the order up before and after creating, so either answer is safe), and whether catalogue-variant orders with file URLs fit the chosen products.
- **Printify** (v1). Verified: order by existing product/variant, 409 with the existing order id, send to production, cancel rules, statuses, shipping calculation, webhook signature. To check: that costs are always USD cents, the shop's order-approval setting (set it to manual), and finding an order by external id (the adapter scans the newest 150 orders).
- **Gelato** (v4). Verified: create, quote, cancel, search filters, statuses, connected orders, webhook payloads. Assumed (the dashboard docs sit behind a bot check): the search URL `/v4/orders:search`, `GET /v4/orders/{id}`, tracking in `shipment.packages[]`, the answer to a repeated `orderReferenceId`, the product-catalogue endpoint used by the listing script, and whether the quote accepts a neutral placeholder recipient.
- **Printlet** (API Integration beta 1.0.0-rc.1, public OpenAPI). Verified from the OpenAPI: catalogue, artwork by URL, quote, order, COD verification, wallet payment, cancel, statuses. To confirm with Printlet before setting `PRINTLET_API_CONFIRMED=1`: the webhook signature headers and string layout; where the webhook URL is registered and what the event `resource` holds; where tracking number and carrier appear (the Order schema has none); lookup by `merchant_order_id`; rate limits and how long an Idempotency-Key is remembered; how city names map to `city_id`; that the wallet is funded (otherwise orders wait as `on_hold`).

## Core notes

2026-11-12, `core`. Where the implementation extends or departs from the text above. Nothing here changes an interface of section d.

1. **Order token and `checkout_id`.** A repeated `POST /api/checkout` must answer the same token, but only the token's SHA-256 may be stored. So the token is derived: `HMAC-SHA256(key = checkoutId, "tcd:order-token:v1")` (64 hex characters), and `orders.checkout_id` stores a 36-character hash of the browser's UUID, never the UUID. The secrecy of the token rests on the browser's `crypto.randomUUID()` (122 random bits). `checkoutId` must be a lowercase or uppercase UUID; anything else is a `VALIDATION` error.
2. **COD order creation.** A COD order is inserted as `pending_payment`, the `cod` provider is called, and the order is confirmed (with fulfilments and jobs) in a second transaction during the same request. The response is `{ kind: 'confirmed' }` as specified; the timeline shows `pending_payment → confirmed`. A crash between the two steps leaves an unpaid order that expires, and the same `checkoutId` finishes it.
3. **New error codes.** `409 ORDER_CLOSED` (the same `checkoutId` again after the order expired or was cancelled: the browser must start a new checkout), `409 ILLEGAL_TRANSITION` and `409 CONFLICT` (internal, never expected on the public API), `401 UNAUTHORIZED` (cron, admin). `web` has no `apiError.ORDER_CLOSED` string yet.
4. **`unavailable` reasons.** Besides `NOT_AVAILABLE_IN_REGION` the quote reports `NOT_FOR_SALE` for a known product that is not `sellable` or not `live` (so a stale bag gets a line-level message). An unknown id or wrong options is still `400 VALIDATION`.
5. **Line keys.** `key` = the cart's `lineKey`: `id|name=value…`, plus `|@field=text` per filled personalisation field (the same format `src/js/cart.js` uses). Duplicate lines in one request are merged; the merged quantity may not pass 10.
6. **Routing.** (a) "Covers the most lines" counts the unassigned lines for which a supplier is in the *best remaining tier*; lower tiers are fallbacks for failures, not a way to merge parcels. (b) Fulfilments are returned in the order of the customer's lines. (c) `route(lines, destination, ctx, { cod, postPayment })` has a fourth, optional argument. (d) A rule may carry `"days": [min, max]`, used for `manual`. (e) **Mock mode:** when the `mock` supplier is loaded, it stands in for every supplier a rule names, and gets a generated mapping when `catalogue/mapping.js` has no `mock` entry; empty cells and `blocked` stay as they are. (f) `rules.json` follows the study strictly: every cell marked unconfirmed, "test order first" or "after catalogue check" is empty. With today's catalogue (hoodie, tee, cap) that means **EU, CA and EG are sold; AE and the rest of the Gulf are not** until the owner adds a supplier to those cells. Prodigi, Contrado, Art of Where and Teelaunch have no adapter and are left out.
7. **Name and status of a product** are read from the text of `src/js/products.js` (it cannot be imported in Node). The parser understands the current file (`id`, `name`, `status`, `options` written as literals, as a top-level `const` array, or through a helper like `volume()`). If options cannot be read the comparison is skipped with a boot warning; a missing id turns commerce off. `src/` must therefore be deployed with the server (it already is for `server/i18n.js`).
8. **Catalogue.** The hoodie carries the optional `name` personalisation of the contract's example (12 characters, surcharge 5.00 EUR). The six non-EUR price columns and all of `shipping-rates.json` are placeholders. In mock mode the "every sellable variant has a mapping" check is skipped (the mock supplier needs none); in live mode a sellable variant without mapping turns commerce off.
9. **`/api/config`.** `enabled` is also false when no country qualifies or when a webhook router of `pay` / `sup` failed to load (`index.js` loads the registries and those routers with `import()` and logs a broken one instead of crashing the site). The answer is cached for 60 s. `createApp(ctx)` reads the routers from `ctx.routers = { paymentWebhooks, supplierWebhooks, mockPay }`.
10. **Config.** `COMMERCE_MODE=live` also needs `PUBLIC_BASE_URL` starting with `https://`; otherwise mode is `off` and `config.problems` says why (logged at boot).
11. **E-mail.** (a) The keys read are exactly `EMAIL_STRINGS_EN` in `server/email/templates.js` (the `email.*` set `web` added, without `email.common.viewOrder`, plus `payMethod.*`); that object is the built-in English fallback. (b) E-mails carry **no link to the status page**, because the token is not stored; the shipped e-mail carries the carrier's tracking link. (c) Mock mode never uses SMTP: messages go to `ctx.outbox` and the row is `sent`. Live mode without SMTP: row `skipped`. (d) `order_cancelled` is sent after the refund succeeded (or at once when nothing was paid); `refund_issued` is for refunds on orders that are not cancelled. (e) The WhatsApp number in the footer is a constant in `templates.js`, equal to the one in `src/js/checkout.js`.
12. **Refund events.** On `refund.succeeded` the refunded total becomes `max(current, event.totalRefunded ?? event.amount)`, capped at the payment amount, so our own refund followed by the provider's webhook is not counted twice. Where the provider sends no running total (Paymob), two separate partial refunds of the same size made in its dashboard are recorded as one: check the provider.
13. **Payment events that do not confirm.** Wrong amount or currency → nothing is confirmed, `needs_attention = PAYMENT_AMOUNT_MISMATCH`. Payment for a cancelled or already-paid order → `PAID_AFTER_CANCEL` / `DUPLICATE_PAYMENT`. An event whose reference matches no payment row is marked `ignored` (answer 200). All attention reasons: those three, `NO_SUPPLIER_LEFT`, `MANUAL_FULFILMENT`, `PERSONALISATION_REVIEW`, `SUPPLIER_FAILED`, `SUPPLIER_ON_HOLD`, `SUPPLIER_CANCELLED` (the parcel is parked as `manual`, not cancelled), `FULFILMENT_OVERDUE`, `REFUND_FAILED`, `CANCEL_PARTIAL`, `JOB_DEAD`. One owner alert per order and reason.
14. **Webhook dedupe.** `recordWebhookOnce` also lets an event through again when its row has been `received` for more than 5 minutes (the process died mid-handler). `handlePaymentEvent` / `handleSupplierEvent` mark the row `processed`, `ignored` or `failed` themselves.
15. **Jobs.** `fulfilment.submit` jobs have 8 attempts (the 1/5/15-minute retries and crash re-runs share one job row; `fulfilments.submit_attempts` decides when to move on). Generic backoff is 1, 5, 15, then 60 minutes. A dead job raises `owner.alert` (`JOB_DEAD`). Shipped parcels are polled once a day (for `delivered` and COD collection) for up to 45 days. `fulfilment.poll` keys are `fulfilment.poll:<id>:<next_poll_at>`. Done jobs older than 30 days are deleted.
16. **Cancel.** If one supplier cancels and a later one refuses, the first parcel *is* cancelled there and is recorded as such; the order stays open with `CANCEL_PARTIAL`. Suppliers without `capabilities.cancel` are refused before anything is touched. A fulfilment in `submitting` refuses the cancel ("try again in a few minutes").
17. **Extra files.** `server/scripts/_cli.js` (shared by the two scripts), `server/test/core-fakes.js` (fake provider, suppliers and registries for core's tests), `server/test/core.*.test.js` (unit tests). `startTestServer(env, overrides)` takes optional fakes and switches the in-process timer off. `setManualFulfilment` (used by `scripts/fulfilment-set.js`) also accepts `delivered`.
18. **Headers.** The CSP on `checkout.html` and `order.html` is `default-src 'self'` plus `img-src 'self' data:` and `style-src 'self' 'unsafe-inline'`; tighten it if the pages need neither.
19. **Requests from the other roles' notes, done.** `config.js` now passes the optional supplier settings: `PRINTLET_API_CONFIRMED` → `config.printlet.apiConfirmed`, `PRINTFUL_CONFIRM` → `config.printful.confirm`, `PRINTFUL_WEBHOOK_SIGNING_KEY_HEX` → `config.printful.webhookSigningKeyHex`, `PRINTIFY_SEND_TO_PRODUCTION` → `config.printify.sendToProduction`, `GELATO_CONFIRM` → `config.gelato.confirm`, and `GELATO_RETURN_COMPANY_NAME / _ADDRESS_LINE1 / _ADDRESS_LINE2 / _CITY / _POST_CODE / _STATE / _COUNTRY / _EMAIL / _PHONE` → `config.gelato.returnAddress` (null unless name, line 1, city, postcode and country are set). The on/off ones are `true` / `false` / `undefined` (unset = the adapter's own default). The inline job run after a payment webhook is capped at 6 s (not 10) because Stripe holds the customer's redirect for 10 s. Payment rows are also matched on `(provider, provider_payment_ref)`.

## Integration notes

2026-11-12, integration and QA. What changed when the four parts were run together for the first time. Evidence and the full list of findings: `web/INTEGRATION_REPORT.md`. Run everything again with `bash web/qa/run_all.sh`.

1. **Shipping option: one mechanism.** `POST /api/quote` accepts the optional `shippingOption` and its answer carries `shippingOption`: the id of the option that `shipping`, `tax` and `total` are priced for (the first option when the input is absent or unknown). The checkout page sends the customer's choice with every quote, asks for a new quote when the choice changes, shows `quote.total` and sends that same number as `expectedTotal`. Nothing is added up in the browser. `POST /api/checkout` still refuses an unknown option (`400 VALIDATION`, `fields.shippingOption`) and a total that is not its own (`409 PRICE_CHANGED`).
2. **Error shapes.** `PRICE_CHANGED` has one shape: `{ "error": { … }, "quote": { … } }` (the quote next to `error`, as in section f). `409 ORDER_CLOSED` has the string `apiError.ORDER_CLOSED`; the checkout page then forgets its attempt id, so the next press of the pay button starts a new order.
3. **Order link in e-mails.** Every customer e-mail (`order_confirmed`, `shipped`, `order_cancelled`, `refund_issued`) ends with "View your order" (`email.common.viewOrder`). The checkout token is still stored only as SHA-256, so the e-mail link has its own token: `HMAC-SHA256(ORDER_LINK_SECRET, "tcd:order-link:v1:<public id>:<token hash>")`, computed when the e-mail is rendered and when a link is checked, never written to the database or a log. `GET /api/orders/:publicId` accepts either token; a wrong one is the same 404. Changing `ORDER_LINK_SECRET` makes links in old e-mails stop working (the link the browser got at checkout keeps working). No secret in live mode means no link, as before.
4. **Refund amounts.** `PaymentEvent.amount` on `refund.*` is the amount of that one refund. Core now handles three cases: a running total (`totalRefunded`, Stripe) wins; with a `refundRef` and no total (Paymob now sends its refund transaction id) separate refunds are added up and each id is counted once (a row in `webhook_events`, source `refund:<provider>`), including the echo of a refund started by our own `payment.refund` job; with neither, the old rule stays (never added). This replaces the limitation described in "Core notes" 12.
5. **Content-Security-Policy.** `checkout.html` and `order.html` carry one inline boot script (theme and language before first paint). The server now allows exactly that script by its SHA-256, read from the built file: `script-src 'self' 'sha256-…'`. Before, the browser blocked it and logged an error on both pages.
6. **Copy for both states.** The static pages are written for commerce off (WhatsApp). With commerce on, `src/js/shell.js` swaps the keys listed in its `COPY_ON` table for their `….on.…` keys (home steps, FAQ answers, meta descriptions) and hides nodes marked `data-commerce-off`; `data-commerce-only` stays the opposite. New keys are in `web/NEW_I18N_KEYS.txt`, with English placeholders in the ten other dictionaries.
7. **Markets without a supplier (UAE, Gulf).** They are not in `/api/config`, so they cannot be chosen. A visitor whose time zone says he is in a country that is a known market but not an enabled one (`commerce.notServedCountry()`) gets a calm notice in the bag and under the checkout's country select, with the WhatsApp order one tap away; everyone gets a small "country not in the list?" hint there. An API answer `MARKET_NOT_SERVED` shows the message with the WhatsApp button instead of "try again".
8. **QA.** `web/qa/commerce.py` (named in section a) drives the real server in mock mode and reads the SQLite file after every step. `web/qa/run_all.sh` runs everything. `api_stub.mjs` is kept only for `checkout.py`, for the states the real mock server cannot produce (two shipping options, split parcels, partly shipped orders).

