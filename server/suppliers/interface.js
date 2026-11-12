// SupplierAdapter contract. Owner: sup. Full text: web/COMMERCE_ARCH.md section d.
// An adapter module exports `create(config, deps) → adapter | null` (null = its env vars are missing).

/**
 * @typedef {Object} Destination
 * @property {string} country  ISO-3166 alpha-2
 * @property {'EU'|'UK'|'CA'|'US'|'AE'|'GCC'|'EG'} region
 * @property {string} [state]
 * @property {string} [postcode]
 * @property {string} [city]
 *
 * @typedef {Object} SupplierLine
 * @property {number} [orderItemId]
 * @property {string} productId
 * @property {string} variantKey
 * @property {string} category
 * @property {number} qty
 * @property {object|null} personalisation
 * @property {{supplier:string, productRef:string, variantRef:string, regions:string[], files?:object[], cost?:{amount:number,currency:string}, days?:[number,number]}|null} mapping
 *
 * @typedef {Object} SupplierQuote
 * @property {string} supplier
 * @property {string} currency
 * @property {number} itemsCost     minor units
 * @property {number} shippingCost  minor units
 * @property {number} total         itemsCost + shippingCost
 * @property {number} minDays       production + transit
 * @property {number} maxDays
 * @property {string} shippingMethod
 * @property {'api'|'table'} source
 *
 * @typedef {Object} SupplierOrderState
 * @property {'submitted'|'in_production'|'shipped'|'delivered'|'cancelled'|'failed'|'on_hold'} status
 * @property {string} rawStatus
 * @property {string} [problem]
 * @property {Array<{ref:string, carrier?:string, trackingNumber?:string, trackingUrl?:string, shippedAt?:number, deliveredAt?:number}>} shipments
 *
 * @typedef {Object} SupplierEvent
 * @property {string} eventId
 * @property {'order.updated'|'stock.updated'|'ignored'} type
 * @property {string} [externalId]        fulfilments.external_id
 * @property {string} [supplierOrderRef]
 *
 * @typedef {Object} SupplierAdapter
 * @property {string} id
 * @property {{webhooks:boolean, cancel:boolean, cod:boolean, liveQuote:boolean}} capabilities
 * @property {(line: SupplierLine, destination: Destination) => Promise<boolean>} isAvailable
 * @property {(lines: SupplierLine[], destination: Destination) => Promise<SupplierQuote>} quote
 * @property {(fulfilment: object) => Promise<{supplierOrderRef:string, status:'submitted'|'in_production', cost?:{amount:number,currency:string}}>} createOrder
 * @property {(ref: {supplierOrderRef?:string, externalId:string}) => Promise<SupplierOrderState|null>} getOrder
 * @property {(req: {rawBody:Buffer, headers:object, query:object}) => Promise<SupplierEvent[]>} parseWebhook
 * @property {(ref: {supplierOrderRef?:string, externalId:string}) => Promise<{cancelled:boolean, reason?:string}>} cancel
 */

export const SUPPLIER_METHODS = ['id', 'capabilities', 'isAvailable', 'quote', 'createOrder', 'getOrder', 'parseWebhook', 'cancel'];

/** Throws when an object does not have the whole SupplierAdapter surface. Used by the registry and by tests. */
export function assertSupplierAdapter(a) {
  for (const key of SUPPLIER_METHODS) {
    const ok = key === 'id' ? typeof a?.id === 'string' && a.id
      : key === 'capabilities' ? a?.capabilities && typeof a.capabilities === 'object'
        : typeof a?.[key] === 'function';
    if (!ok) throw new TypeError(`supplier adapter ${a?.id || '?'}: missing ${key}`);
  }
  return a;
}
