// GET/POST /api/mock/pay/:paymentId. Owner: pay. Exists only when COMMERCE_MODE=mock (404 otherwise).
// GET shows a "pay now" page with two buttons. POST builds the event, signs it and delivers it to
// /api/webhooks/mock over HTTP on this same server, then sends the browser to the success or cancel URL.
// Works whether core mounts it as api.use('/mock/pay', mockPay(ctx)) or as api.use(mockPay(ctx)).
import express, { Router } from 'express';
import { MOCK_SIGNATURE_HEADER, mockEvent, signMockBody, verifyMockLink } from '../payments/mock.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="/img/favicon.svg" type="image/svg+xml"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#1b1b2f;background:#f6f1e7}main{max-width:32rem;margin:0 auto;padding:24px;background:#fff;border-radius:8px}h1{margin:0 0 12px;font-size:1.5rem}form{display:flex;flex-wrap:wrap;gap:12px}button{font:inherit;font-weight:600;min-height:48px;padding:0 20px;border-radius:8px;border:1.5px solid #1b1b2f;background:#fff;color:#1b1b2f;cursor:pointer}#mock-pay{background:#1b1b2f;color:#fff}</style></head><body><main>${body}</main></body></html>`;

/** Only our own pages are valid return targets: a path on this site, or an absolute URL under PUBLIC_BASE_URL. */
function safeReturn(url, base) {
  const value = String(url || '');
  if (/^\/(?![/\\])/.test(value)) return value;
  try { if (new URL(value).origin === new URL(base).origin) return value; } catch (err) { /* not a URL */ }
  return '/';
}

/** @param {object} ctx  @param {{fetch?: Function}} [seams] */
export default function mockPay(ctx, seams = {}) {
  const router = Router();
  const doFetch = seams.fetch || globalThis.fetch;
  const enabled = () => ctx.config.mode === 'mock' && Boolean(ctx.payments?.get('mock'));

  const link = (req) => {
    const q = req.query || {};
    const one = (v) => (Array.isArray(v) ? String(v[0]) : String(v ?? ''));
    return { id: one(q.id), ref: one(q.ref), amount: one(q.amount), currency: one(q.currency), success: one(q.success), cancel: one(q.cancel), sig: one(q.sig), order: one(q.order) };
  };
  const guard = (req, res, next) => {
    if (!/^\d{1,12}$/.test(String(req.params.paymentId))) return next('route'); // not ours (matters when mounted at the API root)
    if (!enabled()) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
    const q = link(req);
    if (q.id !== String(req.params.paymentId) || !verifyMockLink(q)) return res.status(400).type('html').send(page('Mock payment', '<h1>Mock payment</h1><p id="mock-error">This payment link is not valid.</p>'));
    req.mockLink = q;
    return next();
  };

  const show = (req, res) => {
    const q = req.mockLink;
    const action = esc(req.originalUrl);
    res.status(200).type('html').send(page('Mock payment', `<h1>Mock payment</h1>
<p>Test mode: no money moves. Order <strong>${esc(q.order || '-')}</strong>, amount <strong id="mock-amount">${esc((Number(q.amount) / 100).toFixed(2))} ${esc(q.currency)}</strong>.</p>
<form method="post" action="${action}">
<button type="submit" name="outcome" value="pay" id="mock-pay">Pay (success)</button>
<button type="submit" name="outcome" value="fail" id="mock-fail">Fail (declined)</button>
</form>`));
  };

  const submit = async (req, res) => {
    const q = req.mockLink;
    const outcome = req.body?.outcome === 'pay' ? 'pay' : 'fail';
    const event = mockEvent({ providerRef: q.ref, outcome, amount: Number(q.amount), currency: q.currency });
    const body = JSON.stringify(event);
    // Same server, same route a real provider would call: /api/webhooks/mock next to wherever this router is mounted.
    const apiBase = req.originalUrl.split('?')[0].replace(/\/mock\/pay\/[^/]*$/, '');
    const port = req.socket?.localPort;
    const target = `${port ? `http://127.0.0.1:${port}` : ctx.config.publicBaseUrl}${apiBase}/webhooks/mock`;
    let status = 0;
    try {
      const hook = await doFetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', [MOCK_SIGNATURE_HEADER]: signMockBody(body) }, body, signal: AbortSignal.timeout(30000) });
      status = hook.status;
    } catch (err) { status = 0; }
    if (status < 200 || status >= 300) {
      return res.status(502).type('html').send(page('Mock payment', `<h1>Mock payment</h1><p id="mock-error">The webhook was not accepted (status ${esc(status)}). Nothing was changed; you can go back and try again.</p>`));
    }
    return res.redirect(303, safeReturn(outcome === 'pay' ? q.success : q.cancel, ctx.config.publicBaseUrl));
  };

  for (const path of ['/:paymentId', '/mock/pay/:paymentId']) {
    router.get(path, guard, show);
    router.post(path, express.urlencoded({ extended: false, limit: '2kb' }), guard, submit);
  }
  return router;
}
