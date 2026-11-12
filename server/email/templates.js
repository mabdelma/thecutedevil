// E-mail templates: subject + text + HTML. Owner: core. Contract: section g ("E-mail templates").
// Every word comes from i18n keys. EMAIL_STRINGS_EN below is the exact list of keys this file reads, with the
// English text used when a dictionary (src/i18n/<lang>.json, owned by `web`) does not have the key yet.
// `web` translates these keys in all 11 files; nothing else needs to change here.
import { t, isRtl, formatMoney, countryName, normaliseLang } from '../i18n.js';

export const EMAIL_STRINGS_EN = Object.freeze({
  'email.common.greeting': 'Hello {name},',
  'email.common.orderNumber': 'Order {id}',
  'email.common.subtotal': 'Subtotal',
  'email.common.shipping': 'Shipping',
  'email.common.tax': 'Tax',
  'email.common.taxIncluded': 'Includes tax: {amount}',
  'email.common.total': 'Total',
  'email.common.shipTo': 'Delivery address',
  'email.common.paymentMethod': 'Payment',
  'email.common.viewOrder': 'View your order',
  'email.common.help': 'Questions? Write to us on WhatsApp: {whatsapp}',
  'email.common.signature': 'The Cute Devil',
  'email.common.footer': 'You are receiving this e-mail because you placed an order at {site}.',
  'email.order_confirmed.subject': 'Your order {id} is confirmed',
  'email.order_confirmed.intro': 'Thank you. Your payment went through and we are getting your order ready.',
  'email.order_confirmed.introCod': 'Thank you. Your order is confirmed. You pay the courier in cash when it arrives.',
  'email.order_confirmed.next': 'We will e-mail you again with a tracking link as soon as it ships.',
  'email.order_confirmed.split': 'Your pieces are made in different places, so they may arrive in separate parcels.',
  'email.order_confirmed.madeToOrder': 'Personalised pieces are made only for you and cannot be returned for a change of mind.',
  'email.shipped.subject': 'Your order {id} has shipped',
  'email.shipped.intro': 'Good news: a parcel from your order is on its way.',
  'email.shipped.tracking': 'Tracking: {carrier} {number}',
  'email.shipped.track': 'Track your parcel',
  'email.shipped.more': 'The rest of your order follows in another parcel.',
  'email.order_cancelled.subject': 'Your order {id} was cancelled',
  'email.order_cancelled.intro': 'Your order was cancelled. If you already paid, your refund is on its way.',
  'email.refund_issued.subject': 'Your refund for order {id}',
  'email.refund_issued.intro': 'We have refunded {amount} to your original payment method. It can take a few days to show on your statement.',
  'payMethod.card': 'card',
  'payMethod.wallet': 'mobile wallet',
  'payMethod.cod': 'cash on delivery',
});

/** The shop's public WhatsApp number: the same one as WHATSAPP_NUMBER in src/js/checkout.js. */
export const SUPPORT_WHATSAPP = '+34 622 209 935';

export const TEMPLATES = Object.freeze(['order_confirmed', 'shipped', 'order_cancelled', 'refund_issued', 'owner_alert']);

const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (url) => (typeof url === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(url) ? url : '');
/** A header value must never carry a line break. */
const oneLine = (text) => String(text).replace(/[\r\n]+/g, ' ').trim();

function layout({ lang, subject, paragraphs, table, link, links, footer }) {
  const anchors = [...(links || []), link].filter((l) => l && safeUrl(l.url));
  const dir = isRtl(lang) ? 'rtl' : 'ltr';
  const align = dir === 'rtl' ? 'right' : 'left';
  const rows = (table || []).map(([label, value = '', strong]) => `<tr><td style="padding:4px 0;text-align:${align}">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:${dir === 'rtl' ? 'left' : 'right'};white-space:nowrap">${strong ? '<strong>' : ''}${escapeHtml(value)}${strong ? '</strong>' : ''}</td></tr>`).join('');
  const html = `<!doctype html><html lang="${escapeHtml(lang)}" dir="${dir}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>`
    + `<body style="margin:0;padding:24px;background:#f6f1e7;color:#1b1b2f;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5" dir="${dir}">`
    + `<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:24px;border-radius:8px;text-align:${align}">`
    + paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`).join('')
    + (rows ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:12px 0" dir="${dir}">${rows}</table>` : '')
    + anchors.map((l) => `<p style="margin:0 0 12px"><a href="${escapeHtml(safeUrl(l.url))}">${escapeHtml(l.label)}</a></p>`).join('')
    + footer.map((p) => `<p style="margin:12px 0 0;color:#555555">${escapeHtml(p)}</p>`).join('')
    + '</div></body></html>';
  const text = [
    ...paragraphs,
    ...(table && table.length ? ['', ...table.map(([label, value]) => (value ? `${label}: ${value}` : label))] : []),
    ...anchors.flatMap((l) => ['', `${l.label}: ${safeUrl(l.url)}`]),
    '', ...footer,
  ].join('\n');
  return { subject: oneLine(subject), text, html };
}

/**
 * @param {string} template  one of TEMPLATES
 * @param {string} lang      customer language (owner_alert is always English)
 * @param {{order?: object, items?: object[], shipment?: object, moreToCome?: boolean, split?: boolean, amount?: number, statusUrl?: string, alert?: {reason: string, message?: string, adminUrl?: string}}} data
 *   order = orders row (snake_case), items = order_items rows
 * @param {object} [strings]  optional key → text overrides (wins over the dictionaries)
 * @returns {{subject: string, text: string, html: string}}
 */
export function renderEmail(template, lang, data = {}, strings = undefined) {
  if (!TEMPLATES.includes(template)) throw new Error(`unknown e-mail template ${template}`);
  const { order } = data;

  if (template === 'owner_alert') {
    const alert = data.alert || {};
    const subject = `[The Cute Devil] ${order ? `Order ${order.public_id}` : 'Shop'} needs attention: ${alert.reason || 'CHECK'}`;
    return layout({
      lang: 'en', subject,
      paragraphs: [
        order ? `Order ${order.public_id} (${order.country}, ${formatMoney(order.total, order.currency, 'en')}) needs a person.` : 'The shop needs a person.',
        `Reason: ${alert.reason || 'CHECK'}`,
        ...(alert.message ? [alert.message] : []),
      ],
      link: alert.adminUrl ? { url: alert.adminUrl, label: 'Open the order in the admin view' } : null,
      footer: ['Nothing is refunded or cancelled automatically. To cancel and refund: node server/scripts/cancel-order.js <order id>.'],
    });
  }

  const code = normaliseLang(lang);
  const tr = (key, vars) => t(code, key, vars, { fallback: EMAIL_STRINGS_EN, strings });
  const money = (minor) => formatMoney(minor, order.currency, code);
  const id = order.public_id;
  const greeting = tr('email.common.greeting', { name: order.ship_name || '' }).replace(/\s+,/, ',');
  const site = String(data.site || 'thecutedevil.com').replace(/^https?:\/\//, '');
  const footer = [tr('email.common.help', { whatsapp: SUPPORT_WHATSAPP }), tr('email.common.signature'), tr('email.common.footer', { site })];
  // the customer's own status page (send.js builds the URL; absent when ORDER_LINK_SECRET is not set)
  const view = data.statusUrl ? { url: data.statusUrl, label: tr('email.common.viewOrder') } : null;
  const parse = (json) => { try { return json ? JSON.parse(json) : null; } catch (err) { return null; } };
  const personalised = (data.items || []).some((item) => parse(item.personalisation));
  const itemRows = () => (data.items || []).map((item) => {
    const options = Object.values(parse(item.options) || {});
    const extra = Object.values(parse(item.personalisation) || {});
    return [`${item.name}${options.length ? ` · ${options.join(' / ')}` : ''}${extra.length ? ` · "${extra.join(', ')}"` : ''} × ${item.qty}`, money(item.line_total)];
  });
  const totals = () => [
    [tr('email.common.subtotal'), money(order.subtotal)],
    [tr('email.common.shipping'), money(order.shipping_total)],
    ...(order.tax_total > 0 && !order.tax_included ? [[tr('email.common.tax'), money(order.tax_total)]] : []),
    [tr('email.common.total'), money(order.total), true],
    ...(order.tax_total > 0 && order.tax_included ? [[tr('email.common.taxIncluded', { amount: money(order.tax_total) })]] : []),
    [tr('email.common.paymentMethod'), tr(`payMethod.${order.payment_method}`)],
  ];

  if (template === 'order_confirmed') {
    return layout({
      lang: code, subject: tr('email.order_confirmed.subject', { id }),
      paragraphs: [
        greeting,
        tr(order.payment_method === 'cod' ? 'email.order_confirmed.introCod' : 'email.order_confirmed.intro'),
        tr('email.common.orderNumber', { id }),
        ...(data.split ? [tr('email.order_confirmed.split')] : []),
        tr('email.order_confirmed.next'),
        ...(personalised ? [tr('email.order_confirmed.madeToOrder')] : []),
        `${tr('email.common.shipTo')}: ${order.ship_city}, ${countryName(order.country, code)}`,
      ],
      table: [...itemRows(), ...totals()], link: view, footer,
    });
  }
  if (template === 'shipped') {
    const s = data.shipment || {};
    return layout({
      lang: code, subject: tr('email.shipped.subject', { id }),
      paragraphs: [
        greeting, tr('email.shipped.intro'), tr('email.common.orderNumber', { id }),
        ...(s.tracking_number ? [tr('email.shipped.tracking', { carrier: s.carrier || '', number: s.tracking_number }).replace(/\s{2,}/g, ' ')] : []),
        ...(data.moreToCome ? [tr('email.shipped.more')] : []),
      ],
      table: itemRows(),
      links: [s.tracking_url ? { url: s.tracking_url, label: tr('email.shipped.track') } : null, view],
      footer,
    });
  }
  if (template === 'order_cancelled') {
    return layout({
      lang: code, subject: tr('email.order_cancelled.subject', { id }),
      paragraphs: [
        greeting, tr('email.order_cancelled.intro'), tr('email.common.orderNumber', { id }),
        ...(Number.isInteger(data.amount) && data.amount > 0 ? [tr('email.refund_issued.intro', { amount: money(data.amount) })] : []),
      ],
      link: view, footer,
    });
  }
  // refund_issued
  return layout({
    lang: code, subject: tr('email.refund_issued.subject', { id }),
    paragraphs: [greeting, tr('email.common.orderNumber', { id }), tr('email.refund_issued.intro', { amount: money(data.amount || 0) })],
    link: view, footer,
  });
}
