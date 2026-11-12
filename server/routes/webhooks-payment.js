// POST /api/webhooks/:provider. Owner: pay. Contract: web/COMMERCE_ARCH.md sections d, f, g.6.
// core mounts this router BEFORE express.json():
//   api.use('/webhooks', express.raw({ type: () => true, limit: '1mb' }), paymentWebhooks(ctx));
// so req.body is the untouched Buffer the provider signed. If the bytes were parsed first, signatures cannot be
// checked: that is answered with 500 (so the provider retries), never by trusting the payload.
import { Router } from 'express';
import { AppError } from '../lib/errors.js';

const MAX_BYTES = 1024 * 1024;

async function rawBodyOf(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body === undefined && req.readable && !req.readableEnded) { // mounted without express.raw: read the stream ourselves
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new AppError('VALIDATION', 413, 'Webhook body too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  // express.raw leaves {} for an empty body (its signature check then fails with 400, as it should).
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length === 0) return Buffer.alloc(0);
  throw new AppError('WEBHOOK_RAW_BODY', 500, 'The webhook route did not receive the raw request body');
}

/** Best effort: keep webhook_events.status truthful. core's recordWebhookOnce owns the row; a failure here changes nothing. */
async function mark(ctx, source, eventId, status, error) {
  if (!ctx.db) return;
  try {
    const patch = { status, last_error: error ? String(error).slice(0, 500) : null };
    if (status !== 'failed') patch.processed_at = Date.now();
    await ctx.db('webhook_events').where({ source, event_id: eventId }).update(patch);
  } catch (err) { /* the table belongs to core */ }
}

/**
 * @param {object} ctx
 * @param {{recordWebhookOnce?: Function, handlePaymentEvent?: Function}} [seams]  tests replace core's two functions
 */
export default function paymentWebhooks(ctx, seams = {}) {
  // core's seam (orders/events.js) is loaded on first use, so this router can be built and tested on its own.
  let core;
  const seam = async (name) => seams[name] || (core ||= await import('../orders/events.js'))[name];
  const log = ctx.log || console;
  const router = Router();

  router.post('/:provider', async (req, res) => {
    const id = String(req.params.provider);
    const answer = (status, code, message) => res.status(status).json({ error: { code, message } });
    const provider = ctx.payments?.get(id);
    if (!provider) return answer(404, 'NOT_FOUND', 'No such endpoint');

    let rawBody;
    let events;
    try {
      rawBody = await rawBodyOf(req);
      events = await provider.parseWebhook({ rawBody, headers: req.headers, query: req.query || {} });
    } catch (err) {
      if (err instanceof AppError && err.status < 500) return answer(err.status, err.code, err.message);
      log.error(`[webhook pay:${id}] could not read the event: ${err.code || err.name}`);
      return answer(500, 'INTERNAL', 'Something went wrong');
    }

    const source = `pay:${id}`;
    for (const event of events) {
      try {
        const recordWebhookOnce = await seam('recordWebhookOnce');
        const handlePaymentEvent = await seam('handlePaymentEvent');
        const first = await recordWebhookOnce(ctx, { source, eventId: event.eventId, type: event.type, rawBody });
        if (!first) continue; // duplicate delivery: answer 200 without doing the work again
        await handlePaymentEvent(ctx, id, event);
        await mark(ctx, source, event.eventId, event.type === 'ignored' ? 'ignored' : 'processed');
      } catch (err) {
        await mark(ctx, source, event.eventId, 'failed', err.code || err.message);
        log.error(`[webhook ${source}] event ${event.eventId} (${event.type}) failed: ${err.code || err.message}`);
        return answer(500, 'INTERNAL', 'Something went wrong'); // the provider retries; the failed row is processed again
      }
    }
    return res.status(200).json({ ok: true });
  });

  return router;
}
