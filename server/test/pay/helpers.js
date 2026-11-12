// Shared by the pay tests. Owner: pay.
import express from 'express';
import { loadConfig } from '../../config.js';

export const quiet = { log() {}, info() {}, warn() {}, error() {} };

/** Fake keys only: nothing here can reach a real account. */
export const LIVE_ENV = Object.freeze({
  COMMERCE_MODE: 'live', DATABASE_URL: 'sqlite::memory:', PUBLIC_BASE_URL: 'https://shop.example',
  STRIPE_ES_SECRET_KEY: 'sk_test_fake_es', STRIPE_ES_WEBHOOK_SECRET: 'whsec_fake_es_secret',
  STRIPE_AE_SECRET_KEY: 'sk_test_fake_ae', STRIPE_AE_WEBHOOK_SECRET: 'whsec_fake_ae_secret',
  PAYMOB_SECRET_KEY: 'egy_sk_test_fake', PAYMOB_PUBLIC_KEY: 'egy_pk_test_fake', PAYMOB_HMAC_SECRET: 'test_hmac_secret_not_real',
  PAYMOB_INTEGRATION_ID_CARD: '111111',
});
export const config = (env = {}) => loadConfig({ ...LIVE_ENV, ...env });

export const order = (over = {}) => ({ publicId: 'TCD-261112-AB2C', currency: 'EUR', total: 8399, country: 'ES', lang: 'es', email: 'buyer@example.com', phone: '+201000000000', shipName: 'Test Buyer', shipLine1: '1 Test Street', shipCity: 'Cairo', ...over });
export const items = () => [{ name: 'Halos Off Hoodie', qty: 1, unitPrice: 5900, lineTotal: 5900 }, { name: 'Horns Cap', qty: 2, unitPrice: 1000, lineTotal: 2000 }];
export const shipping = () => ({ amount: 499, labelKey: 'checkout.shipping.standard' });
export const payment = (over = {}) => ({ id: 7, amount: 8399, currency: 'EUR', idemKey: 'checkout:7:1', method: 'card', ...over });
export const urls = () => ({ success: 'https://shop.example/order?id=TCD-261112-AB2C&token=t&paid=1', cancel: 'https://shop.example/checkout?cancelled=TCD-261112-AB2C' });

/** A Stripe client double that records every call. */
export function stripeStub(over = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => { calls.push({ name, args }); return typeof result === 'function' ? result(...args) : result; };
  return {
    calls,
    checkout: { sessions: {
      create: rec('sessions.create', over.create || ((p) => ({ id: 'cs_test_stub', url: 'https://checkout.stripe.com/c/pay/cs_test_stub', expires_at: p.expires_at, amount_total: p.line_items.reduce((s, l) => s + l.price_data.unit_amount * l.quantity, 0) + (p.shipping_options?.[0]?.shipping_rate_data.fixed_amount.amount || 0) }))),
      retrieve: rec('sessions.retrieve', over.retrieve || { id: 'cs_test_stub', status: 'complete', payment_status: 'paid', amount_total: 8399, currency: 'eur', payment_intent: 'pi_stub' }),
      list: rec('sessions.list', over.list || { data: [{ id: 'cs_test_fixture_001', status: 'open', payment_status: 'unpaid' }] }),
      expire: rec('sessions.expire', {}),
    } },
    refunds: { create: rec('refunds.create', over.refund || { id: 're_stub', status: 'succeeded' }) },
  };
}

/** A fetch double: answers from a queue and records the requests. */
export function fetchStub(...answers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    const status = a?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(a?.json ?? {}) };
  };
  fn.calls = calls;
  return fn;
}

/** Mount the pay routers exactly as the contract tells core to (raw body before express.json). */
export async function serve(ctx, { webhooks, mockPay } = {}) {
  const app = express();
  const api = express.Router();
  if (webhooks) api.use('/webhooks', express.raw({ type: () => true, limit: '1mb' }), webhooks);
  api.use(express.json({ limit: '100kb' }));
  if (mockPay) api.use('/mock/pay', mockPay);
  app.use('/api', api);
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((ok) => server.close(ok)) };
}

/** recordWebhookOnce as the contract describes it, on the real webhook_events table (core's own may not exist yet). */
export async function recordWebhookOnce(ctx, { source, eventId, type }) {
  const existing = await ctx.db('webhook_events').where({ source, event_id: eventId }).first();
  if (existing) {
    if (existing.status !== 'failed') return false;
    await ctx.db('webhook_events').where({ id: existing.id }).update({ status: 'received', last_error: null });
    return true;
  }
  await ctx.db('webhook_events').insert({ source, event_id: eventId, type, status: 'received', received_at: Date.now() });
  return true;
}
