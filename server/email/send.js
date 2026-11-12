// Transactional e-mail. Owner: core. Contract: section g. Every message has a row in email_log with a unique
// idempotency key, so a replayed webhook or a re-run job can never send the same message twice on purpose.
//   live + SMTP configured → nodemailer, row `sent`
//   live, no SMTP          → nothing is sent, row `skipped`, one log line
//   mock mode              → never touches SMTP: the message goes to ctx.outbox (tests read it), row `sent`
import { toJson, fromJson } from '../db.js';
import { enqueue } from '../jobs/queue.js';
import { errorText } from '../lib/log.js';
import { renderEmail } from './templates.js';
import { emailStatusUrl } from '../orders/service.js';

const nowOf = (ctx) => (typeof ctx.now === 'function' ? ctx.now() : Date.now());

/**
 * Record an e-mail and enqueue its send job. Call it inside the transaction that causes the e-mail.
 * @param {object} q  Knex or transaction
 * @param {{orderId?: number|null, template: string, lang?: string, to: string, idemKey: string, vars?: object}} mail
 */
export async function queueEmail(q, ctx, mail) {
  const at = nowOf(ctx);
  if (!mail.to) return null;
  await q('email_log').insert({
    order_id: mail.orderId ?? null, template: mail.template, lang: mail.lang || 'en', to_email: mail.to, status: 'queued',
    idem_key: mail.idemKey, vars: toJson(mail.vars || {}), created_at: at,
  }).onConflict('idem_key').ignore();
  const row = await q('email_log').where({ idem_key: mail.idemKey }).first('id');
  if (!row) return null;
  return enqueue(q, { type: 'email.send', payload: { emailLogId: row.id }, idemKey: `email:${mail.idemKey}`.slice(0, 120) }, at);
}

let transportCache = null;
async function transportFor(ctx) {
  if (ctx.mailer) return ctx.mailer; // injectable for tests
  if (!ctx.config.smtp) return null;
  if (transportCache && transportCache.smtp === ctx.config.smtp) return transportCache.transport;
  const { default: nodemailer } = await import('nodemailer');
  const { host, port, user, pass, secure } = ctx.config.smtp;
  const transport = nodemailer.createTransport({ host, port, secure: secure || port === 465, auth: { user, pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
  transportCache = { smtp: ctx.config.smtp, transport };
  return transport;
}

/**
 * Send one email_log row (job `email.send`). Safe to call again: a row that is `sent` or `skipped` is left alone.
 * Throws on a transport error so the queue retries with backoff.
 */
export async function deliverEmail(ctx, emailLogId) {
  const row = await ctx.db('email_log').where({ id: emailLogId }).first();
  if (!row || row.status === 'sent' || row.status === 'skipped') return row ? row.status : 'missing';
  const at = nowOf(ctx);
  const skip = (reason) => ctx.db('email_log').where({ id: row.id }).update({ status: 'skipped', last_error: reason, sent_at: null }).then(() => 'skipped');

  const vars = fromJson(row.vars, {});
  const order = row.order_id ? await ctx.db('orders').where({ id: row.order_id }).first() : null;
  if (row.order_id && !order) return skip('order not found');
  if (order && order.anonymised_at) return skip('order anonymised');
  if (!row.to_email) return skip('no recipient');

  const data = { order, alert: vars.alert, amount: vars.amount, site: ctx.config.publicBaseUrl };
  if (order && row.template !== 'owner_alert') {
    data.statusUrl = emailStatusUrl(ctx, order); // built here, at send time: the link token is never stored
    const items = await ctx.db('order_items').where({ order_id: order.id }).orderBy('id');
    data.items = items;
    if (row.template === 'order_confirmed') {
      data.split = (await ctx.db('fulfilments').where({ order_id: order.id }).whereNot({ status: 'cancelled' }).count({ n: '*' }).first()).n > 1;
    }
    if (row.template === 'shipped') {
      const shipment = vars.shipmentId ? await ctx.db('shipments').where({ id: vars.shipmentId, order_id: order.id }).first() : null;
      if (!shipment) return skip('shipment not found');
      data.shipment = shipment;
      data.items = items.filter((i) => i.fulfilment_id === shipment.fulfilment_id);
      const open = await ctx.db('fulfilments').where({ order_id: order.id }).whereNotIn('status', ['shipped', 'delivered', 'cancelled']).count({ n: '*' }).first();
      data.moreToCome = Number(open.n) > 0;
    }
  }
  if (row.template === 'owner_alert' && order && ctx.config.admin) data.alert = { ...data.alert, adminUrl: `${ctx.config.publicBaseUrl}/api/admin/orders/${order.public_id}` };
  const message = renderEmail(row.template, row.lang, data, ctx.emailStrings);

  if (ctx.config.mode === 'mock') {
    ctx.outbox?.push({ to: row.to_email, template: row.template, lang: row.lang, orderId: order ? order.public_id : null, ...message });
    if (ctx.outbox && ctx.outbox.length > 200) ctx.outbox.splice(0, ctx.outbox.length - 200);
    await ctx.db('email_log').where({ id: row.id }).update({ status: 'sent', message_id: `mock-${row.id}`, sent_at: at, last_error: null });
    return 'sent';
  }
  const transport = await transportFor(ctx);
  if (!transport) {
    ctx.log.info('email.skipped', { template: row.template, order: order ? order.public_id : null, reason: 'smtp_not_configured' });
    return skip('SMTP is not configured');
  }
  try {
    const info = await transport.sendMail({ from: ctx.config.smtp?.from, to: row.to_email, subject: message.subject, text: message.text, html: message.html });
    await ctx.db('email_log').where({ id: row.id }).update({ status: 'sent', message_id: String(info?.messageId || '').slice(0, 191) || null, sent_at: nowOf(ctx), last_error: null });
    ctx.log.info('email.sent', { template: row.template, order: order ? order.public_id : null });
    return 'sent';
  } catch (err) {
    await ctx.db('email_log').where({ id: row.id }).update({ status: 'failed', last_error: errorText(err) });
    throw err;
  }
}
