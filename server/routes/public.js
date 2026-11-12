// Public API: /config /quote /checkout /orders/:publicId. Owner: core. Contract: section f.
import express from 'express';
import { AppError, ProviderError } from '../lib/errors.js';
import { orderToken } from '../lib/ids.js';
import { errorText } from '../lib/log.js';
import { rateLimit } from '../lib/ratelimit.js';
import { validateCheckoutInput, validateQuoteInput } from '../lib/validate.js';
import { CURRENCIES, variantKeys } from '../catalogue/index.js';
import { currencyOf, enabledCountries, regionOf } from '../markets.js';
import { canRouteStatic } from '../routing/engine.js';
import { buildQuote, paymentMethodsFor } from '../pricing/quote.js';
import { checkoutRequest, confirmOrder, createOrder, findByCheckout, getOrderView, newPaymentAttempt, nowOf, statusUrl } from '../orders/service.js';
import { runJobsInline } from '../jobs/runner.js';

const MIN = 60 * 1000;
const CONFIG_CACHE_MS = 60 * 1000;

/** Is commerce really on? Mode, database, a valid catalogue, a payment provider, a supplier and the webhook routes. */
export function commerceState(ctx) {
  const reasons = [];
  if (ctx.config.mode === 'off') reasons.push('mode_off');
  if (!ctx.db) reasons.push('no_database');
  if (ctx.catalogueCheck && !ctx.catalogueCheck.ok) reasons.push('catalogue_invalid');
  if (!ctx.payments || ctx.payments.list().length === 0) reasons.push('no_payment_provider');
  if (!ctx.suppliers || ctx.suppliers.list().length === 0) reasons.push('no_supplier');
  if (ctx.routersMissing && ctx.routersMissing.length) reasons.push('webhook_routes_missing');
  return { enabled: reasons.length === 0, reasons };
}

function countriesFor(ctx) {
  const sellable = ctx.catalogue.list().filter((p) => ctx.catalogue.isPurchasable(p.id));
  const routable = new Map(); // `${region}|${cod}` → boolean
  const routes = (region, cod) => {
    const id = `${region}|${cod}`;
    if (!routable.has(id)) routable.set(id, sellable.some((p) => variantKeys(p).some((key) => canRouteStatic(ctx, p, key, region, { cod }))));
    return routable.get(id);
  };
  const out = [];
  for (const code of enabledCountries(ctx.config)) {
    const region = regionOf(code);
    const currency = currencyOf(code);
    if (!routes(region, false)) continue;
    const methods = paymentMethodsFor(ctx, { country: code, currency }).map((m) => m.method).filter((m) => m !== 'cod' || routes(region, true));
    if (methods.length === 0) continue;
    out.push({ code, region, currency, methods });
  }
  return out;
}

/** What GET /api/config answers. Cached for a minute (it never calls a supplier). */
export function publicConfig(ctx) {
  const cache = ctx.configCache;
  if (cache && Date.now() - cache.at < CONFIG_CACHE_MS) return cache.value;
  const { enabled } = commerceState(ctx);
  const countries = enabled ? countriesFor(ctx) : [];
  const currencies = CURRENCIES.filter((c) => countries.some((x) => x.currency === c));
  const value = {
    enabled: enabled && countries.length > 0,
    mode: enabled && countries.length > 0 ? ctx.config.mode : 'off',
    countries: enabled ? countries : [],
    currencies,
    defaultCountry: countries.some((c) => c.code === 'ES') ? 'ES' : countries[0]?.code || null,
    flags: { us: Boolean(ctx.config.enableUS), uk: Boolean(ctx.config.enableUK) },
    whatsappFallback: true,
  };
  ctx.configCache = { at: Date.now(), value };
  return value;
}

const requireCommerce = (ctx) => (req, res, next) => (commerceState(ctx).enabled ? next() : next(new AppError('COMMERCE_OFF', 503, 'Online checkout is not available right now.')));

/** Ask the provider for a payment page (or, for COD, accept the order). Never called inside a transaction. */
async function startPayment(ctx, order, payment, token) {
  const provider = ctx.payments.get(payment.provider);
  if (!provider) throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 422, 'This payment method is not available right now.');
  let result;
  try {
    result = await provider.createCheckout(await checkoutRequest(ctx, order, payment, token));
    const cod = result && result.kind === 'confirmed' && order.payment_method === 'cod';
    const redirect = result && result.kind === 'redirect' && typeof result.url === 'string' && /^(https?:\/\/|\/)[^\s]*$/i.test(result.url) && result.providerRef;
    if (!cod && !redirect) throw new ProviderError('PAYMENT_BAD_ANSWER', 'createCheckout returned no usable result');
  } catch (err) {
    ctx.log.error('checkout.provider_failed', { order: order.public_id, provider: payment.provider, error: errorText(err) });
    await ctx.db('payments').where({ id: payment.id }).update({ last_error: errorText(err), updated_at: nowOf(ctx) });
    throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'The payment service did not answer. Please try again.');
  }
  const at = nowOf(ctx);
  if (result.kind === 'confirmed') {
    if (result.providerRef) await ctx.db('payments').where({ id: payment.id }).whereNull('provider_ref').update({ provider_ref: String(result.providerRef).slice(0, 191), updated_at: at });
    const { jobIds } = await confirmOrder(ctx, { paymentId: payment.id, rawStatus: 'cod' });
    if (jobIds.length) { try { await runJobsInline(ctx, jobIds, 8000); } catch (err) { ctx.log.warn('inline.jobs', { error: errorText(err) }); } }
    return { kind: 'confirmed' };
  }
  await ctx.db('payments').where({ id: payment.id }).whereIn('status', ['created', 'pending']).update({
    status: 'pending', provider_ref: String(result.providerRef).slice(0, 191), redirect_url: result.url,
    expires_at: Number.isFinite(result.expiresAt) ? result.expiresAt : null, last_error: null, updated_at: at,
  });
  return { kind: 'redirect', url: result.url };
}

/** The same checkoutId again: the same order and, while it is still unpaid, the same payment page. */
async function resumeCheckout(ctx, { order, payment }, token) {
  const at = nowOf(ctx);
  if (order.status === 'pending_payment') {
    if (order.expires_at != null && Number(order.expires_at) <= at) throw new AppError('ORDER_CLOSED', 409, 'This checkout has expired. Please start again.');
    if (payment && payment.status === 'pending' && payment.redirect_url && (payment.expires_at == null || Number(payment.expires_at) > at)) return { kind: 'redirect', url: payment.redirect_url };
    if (payment && payment.status === 'created') return startPayment(ctx, order, payment, token); // the provider call failed last time
    return startPayment(ctx, order, await newPaymentAttempt(ctx, order), token); // the earlier attempt failed or expired
  }
  if (order.status === 'expired' || order.status === 'cancelled') throw new AppError('ORDER_CLOSED', 409, 'This checkout is closed. Please start again.');
  return { kind: 'confirmed' };
}

export default function publicRoutes(ctx) {
  const router = express.Router();
  const limit = (bucket, n, ms) => rateLimit(ctx.limiter, bucket, n, ms);

  router.get('/config', (req, res) => res.json(publicConfig(ctx)));

  router.post('/quote', limit('quote', 60, MIN), requireCommerce(ctx), async (req, res) => {
    const input = validateQuoteInput(req.body, ctx);
    const { quote } = await buildQuote(input, ctx);
    res.json(quote);
  });

  router.post('/checkout', limit('checkout', 10, 10 * MIN), requireCommerce(ctx), async (req, res) => {
    const input = validateCheckoutInput(req.body, ctx);
    const token = orderToken(input.checkoutId);
    const answer = (order, payment) => res.status(201).json({ orderId: order.public_id, token, statusUrl: statusUrl(ctx, order, token), payment });

    const existing = await findByCheckout(ctx, input.checkoutId);
    if (existing) return answer(existing.order, await resumeCheckout(ctx, existing, token));

    // Recompute everything. The browser's numbers are not read, except expectedTotal, which is only compared.
    const { quote, internal } = await buildQuote(input, ctx);
    if (quote.unavailable.length) throw new AppError('ITEM_UNAVAILABLE', 422, 'Some items are not available for this country.', { fields: quote.unavailable.map((u) => u.key) });
    if (quote.lines.length === 0) throw new AppError('CART_EMPTY', 422, 'Your bag is empty.');
    if (internal.shippingOption !== input.shippingOption) throw new AppError('VALIDATION', 400, 'Please check the highlighted fields.', { fields: { shippingOption: 'unknown' } });
    const method = quote.paymentMethods.find((m) => m.method === input.paymentMethod);
    if (!method) throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 422, 'This payment method is not available for this order.');
    if (input.expectedTotal !== quote.total) throw new AppError('PRICE_CHANGED', 409, 'The total has changed. Please review your order.', { details: { quote } });

    const made = await createOrder(ctx, { input, quote, internal, method: method.method, provider: method.provider, token });
    if (!made.created) return answer(made.order, await resumeCheckout(ctx, made, token)); // a double submit: the other request created it
    return answer(made.order, await startPayment(ctx, made.order, made.payment, token));
  });

  router.get('/orders/:publicId', limit('order', 30, MIN), async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    if (!ctx.db) throw new AppError('NOT_FOUND', 404, 'Order not found');
    const view = await getOrderView(ctx, String(req.params.publicId || ''), typeof req.query.token === 'string' ? req.query.token : '');
    if (!view) throw new AppError('NOT_FOUND', 404, 'Order not found');
    res.json(view);
  });

  return router;
}
