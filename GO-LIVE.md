# GO-LIVE checklist: The Cute Devil shop

Sources: `web/COMMERCE_ARCH.md` (contract and developer notes) and `web/INTEGRATION_REPORT.md`, 2026-11-12. Keep secrets only in the host's environment settings.

## 1. What works today, and how to see it

Everything runs in **mock mode**: fake payment page, fake supplier, no real accounts.

1. `cd site && npm install`
2. `npm run build`
3. `COMMERCE_MODE=mock npm start` (PowerShell: `$env:COMMERCE_MODE='mock'; npm start`)
4. Open `http://127.0.0.1:3000`. The server serves the built site and `/api`. The database is SQLite at `./data/mock.sqlite`.
5. Development with hot reload: terminal 1 `COMMERCE_MODE=mock npm run dev:api`, terminal 2 `npm run dev`.

What you will see:

- **Mock payment page** (`/api/mock/pay/<id>`): two buttons, "pay" and "fail". It posts a signed event to `/api/webhooks/mock`, then returns you to the order page or the checkout. It offers COD in every country (live: Egypt only).
- **Mock supplier**: stands in for every supplier named in the routing table. Personalisation `FAIL` fails with retries and ends parked for a human; `REJECT` fails at once.
- **Mark a parcel shipped**: `POST /api/webhooks/supplier/mock?key=mock` with body `{ "id": "evt-1", "action": "ship", "externalId": "<fulfilment external_id>" }` (also `deliver`, `fail`, `hold`). Tracking becomes `MOCK123`.
- **E-mails** are not sent; they go to an in-memory outbox and are logged `sent`.
- Without `COMMERCE_MODE` the site is the old one: sample prices, WhatsApp order.

Checks: `npm test` (203 tests) and `bash web/qa/run_all.sh` (13 browser journeys, all passed; the script was edited after its last full run).

## 2. Branches, Hostinger, rollback

1. This code is on the `commerce` branch. The live site on `main` is static.
2. Switch the Hostinger site to a "Node.js web app" (one process, requests cut at 120 s).
3. Build `npm run build`, start `npm start`, Node 20 or 22.
4. The server serves `dist/` and `/api`, at the domain root. Deploy `src/` too (the server reads `src/i18n/*.json` and `src/js/products.js`).
5. Migrations run on every start. After a rebuild the server must restart (a deploy does that).
6. Deploy first **without** `COMMERCE_MODE`: the site behaves like today (tested).
7. **Rollback, fast**: remove `COMMERCE_MODE` (or set `off`) and restart. The site shows the WhatsApp flow again; orders stay in the database.
8. **Rollback, full**: deploy `main` as a static site again. The notes do not describe the Hostinger panel steps; write them down the first time you switch.

## 3. Environment variables

A group works only when **all** its required variables are set.

**Core**

| Name | What it is | Needed for |
|---|---|---|
| `COMMERCE_MODE` | unset/`off`, `mock`, `live` | everything |
| `DATABASE_URL` | `mysql://user:pass@host:3306/db` | `live` (required) |
| `PUBLIC_BASE_URL` | public origin, must start with `https://` | `live` (required); links in redirects and e-mails |
| `PORT` | listen port (Hostinger sets it) | server |
| `ENABLE_US`, `ENABLE_UK` | `1` opens the market | US, UK (off by default) |

**Stripe Spain** (`stripe_es`: EU, UK, CA, US in EUR, GBP, CAD, USD)

| Name | What it is |
|---|---|
| `STRIPE_ES_SECRET_KEY` | API secret key of the Spanish account |
| `STRIPE_ES_WEBHOOK_SECRET` | signing secret of that account's webhook endpoint |

**Stripe UAE** (`stripe_ae`: AE, SA, KW, QA, BH, OM in AED, SAR)

| Name | What it is |
|---|---|
| `STRIPE_AE_SECRET_KEY` | API secret key of the UAE account |
| `STRIPE_AE_WEBHOOK_SECRET` | signing secret of that account's webhook endpoint |

**Paymob** (`paymob`: Egypt, EGP)

| Name | What it is | Needed for |
|---|---|---|
| `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET` | account keys and HMAC | Egypt cards |
| `PAYMOB_INTEGRATION_ID_CARD` | id of the "Online Card" integration | Egypt cards |
| `PAYMOB_INTEGRATION_ID_WALLET` | id of the "Mobile Wallet" integration | optional: wallet method |

**Suppliers**

| Name | What it is | Needed for |
|---|---|---|
| `PRINTFUL_API_KEY` | private token (it expires; renew by hand) | Printful |
| `PRINTFUL_WEBHOOK_SECRET` | random string you choose; goes in the webhook URL | Printful |
| `PRINTFUL_STORE_ID` | only for an account-level token | optional |
| `PRINTFUL_CONFIRM` | `1`/`0`. Unset: draft in mock, confirmed (charged) in live | optional |
| `PRINTFUL_WEBHOOK_SIGNING_KEY_HEX` | only for Printful v2 webhooks | optional |
| `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID` | personal token (valid one year), shop id | Printify |
| `PRINTIFY_WEBHOOK_SECRET` | secret given to Printify; it signs with it | Printify |
| `PRINTIFY_SEND_TO_PRODUCTION` | `1`/`0`. Unset: not sent in mock, sent in live | optional |
| `GELATO_API_KEY` | API key | Gelato |
| `GELATO_WEBHOOK_SECRET` | random string you choose; goes in the webhook URL | Gelato |
| `GELATO_CONFIRM` | `1`/`0`. Unset: draft in mock, real order in live | optional |
| `GELATO_RETURN_COMPANY_NAME`, `_ADDRESS_LINE1`, `_ADDRESS_LINE2`, `_CITY`, `_POST_CODE`, `_STATE`, `_COUNTRY`, `_EMAIL`, `_PHONE` | return address on Gelato parcels; sent only when name, line 1, city, postcode and country are all set | optional |
| `PRINTLET_API_KEY`, `PRINTLET_BASE_URL`, `PRINTLET_WEBHOOK_SECRET` | key (start with a `prnt_test_…` key), `https://printleteg.com/api/integrations/v1`, URL secret | Printlet, and through it COD |
| `PRINTLET_API_CONFIRMED` | `1` only after Printlet answers the open points (section 6) | default off: no Printlet, no COD |

**E-mail**

| Name | What it is | Needed for |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | mail server | sending e-mail; without it rows are logged `skipped` |
| `OWNER_ALERT_EMAIL` | your address | owner alerts |

**Security**

| Name | What it is | Needed for |
|---|---|---|
| `CRON_SECRET` | bearer for the tick | `/api/cron/tick` (404 when unset) |
| `ADMIN_USER`, `ADMIN_PASS` | HTTP Basic login | `/api/admin/*` (404 when unset) |
| `ORDER_LINK_SECRET` | random, at least 32 characters (`openssl rand -hex 32`) | "View your order" link in e-mails. Changing it later breaks links in old e-mails |

## 4. Database

1. Create a MySQL database on Hostinger and set `DATABASE_URL`.
2. Migrations run at every start. By hand: `npm run migrate`.
3. Every test used SQLite. MySQL is untested: check the first start log.

## 5. Stripe (repeat for each account)

1. Start in **test mode**. Each webhook secret belongs to one endpoint, one account, one mode.
2. Put the secret key in `STRIPE_ES_SECRET_KEY` (Spain) or `STRIPE_AE_SECRET_KEY` (UAE).
3. Dashboard → Developers → Webhooks → Create an event destination:
   - Spain: `https://thecutedevil.com/api/webhooks/stripe_es`
   - UAE: `https://thecutedevil.com/api/webhooks/stripe_ae`
   - Events from **Your account**, payload **Snapshot** (not "Thin"), API version **2026-10-28.endive**.
4. Subscribe to: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.payment_failed`, `charge.refunded`, `refund.failed`.
5. Copy that endpoint's signing secret into `STRIPE_ES_WEBHOOK_SECRET` / `STRIPE_AE_WEBHOOK_SECRET`.
6. Local test without a public URL: `stripe listen --forward-to localhost:3000/api/webhooks/stripe_es`.
7. Check these four points with test keys:
   1. A session with `shipping_options` and no address collection is accepted and shows the shipping line.
   2. The UAE account can charge and settle **SAR** as well as AED; which payment methods each dashboard offers per currency.
   3. A second partial refund's `charge.refunded` carries `previous_attributes.amount_refunded`, and the Charge carries the PaymentIntent metadata.
   4. Each endpoint really is Snapshot at API version 2026-10-28.endive.

**Paymob**: register `https://thecutedevil.com/api/webhooks/paymob` as the "Transaction processed callback" of each integration used. Its eight unverified points are listed in "Payments notes"; each is one commented function at the top of `server/payments/paymob.js`.

## 6. Suppliers

Same steps for each:

1. Create the account and set its env vars.
2. Create the products with their designs. Put print files on a public `https` address.
3. List ids: `node server/suppliers/tools/list-catalogue.js <supplier> [id]`.
4. Fill `server/catalogue/mapping.js`: replace every `PLACEHOLDER` ref and print-file URL, set real `cost` and `days`, remove suppliers that do not make the product.
5. Personalised products need a `personalisation` entry with a `urlTemplate`; without it the line goes to a human. Printify personalised lines always go to the next supplier.
6. Register the webhook. Run `npm test`.

| Supplier | Listing tool | Webhook URL | Draft flag | Verified from documents | Assumed / to check |
|---|---|---|---|---|---|
| Printful | `… printful` or `… printful <product id>` | `/api/webhooks/supplier/printful?key=<PRINTFUL_WEBHOOK_SECRET>` (register with `POST https://api.printful.com/webhooks`; test with its Webhook Simulator) | `PRINTFUL_CONFIRM=0` | endpoints, payload, statuses, lookup by external id, shipping rates, webhook types, rate limit | answer to a repeated `external_id`; whether catalogue variants with file URLs fit the products |
| Printify | `… printify` | `/api/webhooks/supplier/printify` (one `POST /v1/shops/{shop_id}/webhooks.json` per topic, with the secret) | `PRINTIFY_SEND_TO_PRODUCTION=0` | order by product/variant, 409 on duplicate, send to production, cancel, statuses, shipping, signature | costs always USD cents; set the shop's order approval to manual; lookup scans the newest 150 orders |
| Gelato | `… gelato <catalogUid>` (unverified endpoint; else copy productUid from the dashboard) | `/api/webhooks/supplier/gelato?key=<GELATO_WEBHOOK_SECRET>` (dashboard → Developer → Webhooks) | `GELATO_CONFIRM=0` | create, quote, cancel, search filters, statuses, connected orders, webhook payloads | search URL, get-order URL, where tracking sits, answer to a repeated reference, catalogue endpoint, placeholder recipient in quotes |
| Printlet | `… printlet`, `… printlet <product id>` | `/api/webhooks/supplier/printlet?key=<PRINTLET_WEBHOOK_SECRET>` (place in dashboard to be confirmed) | gated by `PRINTLET_API_CONFIRMED` | catalogue, artwork by URL, quote, order, COD verification, wallet, cancel, statuses (public OpenAPI, beta) | webhook signature layout; where the URL is registered; where tracking appears; lookup by merchant order id; rate limits; city → `city_id`; wallet must be funded |

Webhooks are only a signal; the server then asks the supplier for the real state, and polls every 6 hours anyway.

## 7. Cron

1. Call every minute, or the shortest interval the plan allows:
   `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://thecutedevil.com/api/cron/tick`
2. It answers `{ ok, ran, failed, remaining, tookMs }`. Limit: 10 calls per minute.
3. The process also runs its own timer every 30 s. The Hostinger cron call is untested.

## 8. Placeholders to replace with your adviser

| What | Where | State |
|---|---|---|
| Product prices | `server/catalogue/products.js` | EUR = old sample prices; GBP, CAD, USD, AED, SAR, EGP columns are placeholders. No FX conversion exists |
| Hoodie personalisation surcharge | same file | 5.00 EUR from the contract's example |
| Customer shipping prices | `server/pricing/shipping-rates.json` | all placeholders (base, per extra item, free-from) |
| Tax display rates | `server/pricing/tax-rules.json` | starting values, not advice. v1 only shows and stores tax; it does not file or register anything |
| Supplier cost and days | `server/catalogue/mapping.js` | rough figures |
| Cost comparison rates | `server/routing/rules.json` → `costFx` | rough; used only to compare suppliers |

Owner decisions before live: which entity sells in each market, OSS, recargo de equivalencia, Canadian and Gulf registration, whether to use Stripe Tax.

## 9. Markets

1. A country is offered only if its market is on, a payment provider serves it, and a sellable product routes there.
2. Today's catalogue (hoodie, tee, cap) routes to **EU, CA and EG**. Scent and tech products are not sold online.
3. **UAE and Gulf are empty on purpose**: the study marks those suppliers unconfirmed. Visitors there get a notice and the WhatsApp order.
4. To open a market after a successful test order: add the supplier to the category/region cell in `server/routing/rules.json`, list that region for the variant in `mapping.js`, redeploy.
5. US and UK: set `ENABLE_US=1` / `ENABLE_UK=1`.
6. Egypt: cards need the Paymob group. COD and Printlet both need `PRINTLET_API_CONFIRMED=1`; until then Egypt has no supplier.

## 10. Test script before `live` with real keys

Real payment providers load only in `live`. Run this stage as `COMMERCE_MODE=live` with **Stripe test keys** and the three draft flags set to `0`.

1. Start; read the boot log; `GET /api/config` must say `enabled: true` with the expected countries.
2. Order a hoodie to a Spanish address, pay with a Stripe test card.
3. Check: order `processing/paid` in admin, a **draft** order in the supplier dashboard, confirmation e-mail received with a working "View your order" link.
4. Decline a card, then retry: one order, one confirmation.
5. Leave one checkout unpaid: it expires after 60 minutes, no e-mail.
6. Refund one order with the cancel script and one from the Stripe dashboard.
7. Repeat steps 2 and 3 for each supplier, for Canada, and for a two-product order.
8. A draft never ships. To prove the shipped webhook, tracking and shipped e-mail, place one small confirmed order per supplier to your own address.
9. Read the e-mails in real mail clients, English and Arabic.
10. Then set live Stripe keys and live webhook secrets, and remove the draft flags.

## 11. Operations

1. Order list: `https://thecutedevil.com/api/admin/orders` (Basic login). Filters: `?attention=1`, `?status=`. One order: `/api/admin/orders/<order id>`. Dead jobs: `/api/admin/jobs?status=dead`. Five wrong logins block the address for 15 minutes.
2. Cancel and refund (same env as the server): `node server/scripts/cancel-order.js TCD-YYMMDD-XXXX --reason "customer asked"`. `CANNOT_CANCEL` = a parcel is in production or a supplier refused; nothing changed.
3. Close a parked parcel by hand: `node server/scripts/fulfilment-set.js <order id> <parcel no> shipped --carrier DHL --tracking 123` (also `submitted`, `delivered`, `cancelled`).
4. **Owner alert e-mail** = an order needs you. One alert per order and reason. The customer is never refunded automatically. Reasons:
   - `NO_SUPPLIER_LEFT`, `MANUAL_FULFILMENT`, `PERSONALISATION_REVIEW`: place the supplier order by hand, then use `fulfilment-set.js`, or cancel.
   - `SUPPLIER_FAILED`, `SUPPLIER_ON_HOLD`, `SUPPLIER_CANCELLED`, `FULFILMENT_OVERDUE` (open 10 days): check the supplier dashboard.
   - `PAYMENT_AMOUNT_MISMATCH`, `PAID_AFTER_CANCEL`, `DUPLICATE_PAYMENT`, `REFUND_FAILED`: check the payment dashboard.
   - `CANCEL_PARTIAL`: one supplier cancelled, another refused. `JOB_DEAD`: see the dead jobs list.

## 12. Not done yet / known risks

- **Nothing was tested against real Stripe, Paymob, Printful, Printify, Gelato, Printlet, SMTP, MySQL or Hostinger** (120 s cut, cron, proxy, native SQLite build).
- Paymob: everything is unverified, including the HMAC against a real callback and the refund id.
- Printlet is gated behind `PRINTLET_API_CONFIRMED`; so is COD.
- Every ref in `mapping.js` is a placeholder, so live mode keeps commerce off until it is filled. Six price columns and all shipping rates are placeholders.
- The 1/5/15-minute retries, 60-minute expiry and 5-minute stale lock were tested by editing timestamps, not by waiting.
- 292 new text keys are still English in the 10 other languages.
- The legal pages are drafts with placeholders; a lawyer must review them. The story heading "a chat, not a form" and some translated lines (cookies headline "three small notes", the "clear" confirmation, most of the shipping page) still describe the WhatsApp-only shop.
- A parked order still shows "arrives in about 4 to 9 days" to the customer.
- Rate limits trust one proxy hop; correct only behind Hostinger's proxy.
- Owner's own tasks from the study, not handled by the code: German packaging register (LUCID) before shipping to Germany, Spanish packaging register, seller entity per market, VAT/OSS and other tax registrations, UAE licence activity, Saudi tax opinion, Egypt tax registration, GPSR and textile labels, trade mark search and filing, sample orders from every supplier.
