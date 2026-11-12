// Status lists and the allowed transitions. Owner: core. Contract: web/COMMERCE_ARCH.md section b.
// Statuses are short strings checked HERE, not database enums, so MySQL and SQLite agree.
import { AppError } from '../lib/errors.js';

export const ORDER_TRANSITIONS = Object.freeze({
  pending_payment: ['confirmed', 'expired', 'cancelled'],
  expired: ['confirmed'], // a payment that arrives late re-opens the order
  confirmed: ['processing', 'cancelled'],
  processing: ['partially_shipped', 'shipped', 'cancelled'],
  partially_shipped: ['shipped'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
});
export const ORDER_STATUSES = Object.freeze(Object.keys(ORDER_TRANSITIONS));

export const FULFILMENT_TRANSITIONS = Object.freeze({
  pending: ['submitting', 'cancelled', 'manual'],
  submitting: ['submitted', 'in_production', 'pending', 'manual'],
  submitted: ['in_production', 'shipped', 'cancelled', 'manual'],
  in_production: ['shipped', 'manual'],
  shipped: ['delivered'],
  manual: ['submitted', 'shipped', 'cancelled'],
  delivered: [],
  cancelled: [],
});
export const FULFILMENT_STATUSES = Object.freeze(Object.keys(FULFILMENT_TRANSITIONS));

export const PAYMENT_STATUS_TRANSITIONS = Object.freeze({ // orders.payment_status
  unpaid: ['paid'],
  paid: ['refund_pending', 'refunded', 'partially_refunded'],
  refund_pending: ['refunded', 'partially_refunded', 'paid'],
  partially_refunded: ['refunded', 'refund_pending'],
  refunded: [],
  cod_due: ['cod_collected'],
  cod_collected: [],
});

export const PAYMENT_ROW_TRANSITIONS = Object.freeze({ // payments.status
  created: ['pending', 'succeeded', 'failed', 'expired', 'cod_due'],
  pending: ['succeeded', 'failed', 'expired'],
  failed: ['succeeded'], // providers may report a late success after a failed attempt on the same session
  expired: ['succeeded'],
  succeeded: ['refunded', 'partially_refunded'],
  partially_refunded: ['refunded', 'partially_refunded'],
  refunded: [],
  cod_due: ['cod_collected'],
  cod_collected: [],
});

export const canOrderGo = (from, to) => (ORDER_TRANSITIONS[from] || []).includes(to);
export const canFulfilmentGo = (from, to) => (FULFILMENT_TRANSITIONS[from] || []).includes(to);
export const canPaymentStatusGo = (from, to) => (PAYMENT_STATUS_TRANSITIONS[from] || []).includes(to);
export const canPaymentRowGo = (from, to) => (PAYMENT_ROW_TRANSITIONS[from] || []).includes(to);

const illegal = (what, from, to) => new AppError('ILLEGAL_TRANSITION', 409, `${what}: ${from} → ${to} is not allowed`);
export function assertOrderTransition(from, to) { if (!canOrderGo(from, to)) throw illegal('order', from, to); }
export function assertFulfilmentTransition(from, to) { if (!canFulfilmentGo(from, to)) throw illegal('fulfilment', from, to); }
export function assertPaymentStatusTransition(from, to) { if (!canPaymentStatusGo(from, to)) throw illegal('payment status', from, to); }
export function assertPaymentRowTransition(from, to) { if (!canPaymentRowGo(from, to)) throw illegal('payment', from, to); }

/** Progress order of the shipping-side statuses (never move backwards). */
const ORDER_RANK = ['confirmed', 'processing', 'partially_shipped', 'shipped', 'delivered'];
const FULFILMENT_RANK = ['submitted', 'in_production', 'shipped', 'delivered'];

/**
 * What the order status should be, given its fulfilments. Cancelled fulfilments are ignored.
 * → 'processing' | 'partially_shipped' | 'shipped' | 'delivered' | null (null = nothing to derive yet)
 */
export function deriveOrderStatus(fulfilmentStatuses) {
  const live = fulfilmentStatuses.filter((s) => s !== 'cancelled');
  if (live.length === 0) return null;
  const sent = live.filter((s) => s === 'shipped' || s === 'delivered').length;
  if (live.every((s) => s === 'delivered')) return 'delivered';
  if (sent === live.length) return 'shipped';
  if (sent > 0) return 'partially_shipped';
  if (live.some((s) => s === 'submitted' || s === 'in_production')) return 'processing';
  return null;
}

/** Shortest legal path through `via` statuses (breadth first). [] when there is none or nothing to do. */
function shortestPath(transitions, from, target, via) {
  if (from === target) return [];
  const queue = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const path = queue.shift();
    for (const next of transitions[path[path.length - 1]] || []) {
      if (seen.has(next) || !via.includes(next)) continue;
      if (next === target) return [...path.slice(1), next];
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return [];
}

/** Legal steps from one order status forward to a derived target, e.g. confirmed → [processing, shipped]. [] = stay. */
export function orderPath(from, target) {
  const a = ORDER_RANK.indexOf(from);
  const b = ORDER_RANK.indexOf(target);
  if (a < 0 || b < 0 || b <= a) return [];
  return shortestPath(ORDER_TRANSITIONS, from, target, ORDER_RANK.slice(a + 1, b + 1));
}

/** Legal steps from one fulfilment status forward to a supplier-reported one. [] = stay (never backwards). */
export function fulfilmentPath(from, target) {
  const b = FULFILMENT_RANK.indexOf(target);
  if (b < 0) return [];
  const a = FULFILMENT_RANK.indexOf(from);
  if (a >= 0 && b <= a) return [];
  if (a < 0 && from !== 'manual' && from !== 'submitting') return [];
  return shortestPath(FULFILMENT_TRANSITIONS, from, target, FULFILMENT_RANK.slice(a + 1, b + 1));
}
