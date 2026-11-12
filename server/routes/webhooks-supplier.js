// POST /api/webhooks/supplier/:supplier. Owner: sup. Contract: web/COMMERCE_ARCH.md section d ("Webhook route").
// core mounts this BEFORE express.json(), behind express.raw, so req.body is the untouched Buffer.
// Flow: adapter.parseWebhook verifies first (bad key/signature → 400 WEBHOOK_SIGNATURE) → for each event,
// recordWebhookOnce on (sup:<id>, eventId) → first delivery only: handleSupplierEvent → 200 { ok: true }.
// A handler error answers 500 so the supplier retries; core marks the row failed, so the retry is processed again.
import { Router } from 'express';
import { AppError } from '../lib/errors.js';
import * as coreEvents from '../orders/events.js';

/**
 * @param {object} ctx  { config, db, log, suppliers }
 * @param {{recordWebhookOnce?: Function, handleSupplierEvent?: Function}} [deps]  test seam; defaults to orders/events.js
 */
export default function supplierWebhooks(ctx, deps = {}) {
  const recordWebhookOnce = deps.recordWebhookOnce || coreEvents.recordWebhookOnce;
  const handleSupplierEvent = deps.handleSupplierEvent || coreEvents.handleSupplierEvent;
  const router = Router();

  router.post('/:supplier', async (req, res, next) => {
    try {
      const id = String(req.params.supplier || '');
      const adapter = ctx.suppliers && ctx.suppliers.get(id);
      if (!adapter) throw new AppError('NOT_FOUND', 404, 'No such endpoint');
      const rawBody = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? Buffer.from(req.body) : null;
      if (!rawBody) throw new AppError('VALIDATION', 400, 'Raw body required'); // mounted without express.raw
      const events = await adapter.parseWebhook({ rawBody, headers: req.headers, query: req.query || {} });
      const source = `sup:${id}`;
      for (const event of events) {
        const first = await recordWebhookOnce(ctx, { source, eventId: event.eventId, type: event.type, rawBody });
        if (first) await handleSupplierEvent(ctx, id, event); // core marks the row processed / ignored / failed
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      if (!(err instanceof AppError)) (ctx.log || console).error(`[webhook sup:${req.params.supplier}] ${err.code || err.name}: ${err.message}`);
      next(err);
    }
  });
  return router;
}
