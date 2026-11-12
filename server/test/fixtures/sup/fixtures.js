// Recorded-SHAPE fixtures for supplier tests. Owner: sup. Written by hand from the official documentation
// (field names and nesting as documented, values invented, no real personal data).

/* ---- Printful v1 — https://developers.printful.com/docs/ (Orders API, Shipping Rate API, Webhook API) ---- */
export const printfulOrder = (over = {}) => ({
  code: 200,
  result: {
    id: 13, external_id: 'TCD-261112-AB2C-F1-0', store: 10, status: 'pending', shipping: 'STANDARD', created: 1602607640, updated: 1602607640,
    costs: { currency: 'USD', subtotal: '29.50', discount: '0.00', shipping: '5.00', tax: '0.00', vat: '0.00', total: '34.50' },
    shipments: [], ...over,
  },
});
export const printfulShipment = { id: 10, carrier: 'FEDEX', service: 'FedEx SmartPost', tracking_number: 794600000000, tracking_url: 'https://www.fedex.com/fedextrack/?tracknumbers=794600000000', created: 1588716060, ship_date: '2020-05-05', shipped_at: 1588716060, reshipment: false, items: [{ item_id: 1, quantity: 1, picked: 1, printed: 1 }] };
export const printfulRates = { code: 200, result: [{ id: 'STANDARD', name: 'Flat Rate (Estimated delivery: May 19–24) ', rate: '13.60', currency: 'USD', minDeliveryDays: 4, maxDeliveryDays: 7, minDeliveryDate: '2022-10-17', maxDeliveryDate: '2022-10-20' }] };
export const printfulError = (code, message) => ({ code, result: message, error: { reason: 'BadRequest', message } });
export const printfulWebhook = (type, order = {}, extra = {}) => ({ type, created: 1622456737, retries: 0, store: 12, data: { ...extra, order: { id: 13, external_id: 'TCD-261112-AB2C-F1-0', store: 10, status: 'fulfilled', ...order } } });
export const printfulStockWebhook = (out, discontinued = []) => ({ type: 'stock_updated', created: 1622456737, retries: 0, store: 12, data: { product_id: 380, variant_stock: { out, discontinued } } });

/* ---- Printify v1 — https://developers.printify.com/ and https://developers.printify.com/openapi.json ---- */
export const printifyOrder = (over = {}) => ({
  id: '5a96f649b2439217d070f507', address_to: {}, line_items: [{ id: '5a96f649b2439217d070f508', product_id: '5bfd0b66a342bcc9b5563216', variant_id: 17887, quantity: 1, status: 'pending' }],
  metadata: { order_type: 'external', shop_order_id: 'TCD-261112-AB2C-F1-0', shop_order_label: 'TCD-261112-AB2C' },
  total_price: 1050, total_shipping: 400, total_tax: 0, status: 'on-hold', shipping_method: 1, created_at: '2019-12-09 10:46:53+00:00', ...over,
});
export const printifyConflict = { status: 'error', code: 8503, message: 'Operation failed.', errors: { reason: 'Order already exists for the given external_id.', code: 8503 }, order: { id: '5a96f649b2439217d070f507', external_id: 'TCD-261112-AB2C-F1-0' } };
export const printifyShipping = { standard: 1000, express: 5000, priority: 5000, printify_express: 799, economy: 399 };
export const printifyShipmentEvent = {
  id: '653b6be8-2ff7-4ab5-a7a6-6889a8b3bbf5', type: 'order:shipment:created', created_at: '2022-05-17 15:00:00+00:00',
  resource: { id: '5a96f649b2439217d070f507', type: 'order', data: { shop_id: 815256, shipped_at: '2022-05-17 15:00:00+00:00', carrier: { code: 'USPS', tracking_number: '9400110200828911663274', tracking_url: 'https://example.com/track/9400110200828911663274' }, skus: ['6202'] } },
};

/* ---- Gelato v4 — https://developers.gelato.com/docs/get-started , /docs/orders/v4/quote , /docs/orders/v4/search/ ,
        /docs/orders/order_details/ , /docs/webhooks ---- */
export const gelatoOrder = (over = {}) => ({
  id: '37365096-6628-4538-a9c2-fbf9892deb85', orderType: 'order', orderReferenceId: 'TCD-261112-AB2C-F1-0', customerReferenceId: 'TCD-261112-AB2C',
  fulfillmentStatus: 'created', financialStatus: 'paid', currency: 'EUR', connectedOrderIds: [],
  shipment: { shipmentMethodUid: 'normal', shipmentMethodName: 'DHL Parcel', minDeliveryDays: 3, maxDeliveryDays: 5, packages: [] },
  receipts: [{ currency: 'EUR', productsPrice: 11.0, shippingPrice: 4.5, total: 15.5, totalVat: 3.26, totalInclVat: 18.76 }], ...over,
});
export const gelatoQuote = {
  orderReferenceId: 'quote-x',
  quotes: [{
    id: 'q1', itemReferenceIds: ['11'], fulfillmentCountry: 'DE',
    shipmentMethods: [
      { name: 'DHL Express', shipmentMethodUid: 'dhl_express', price: 14.2, currency: 'EUR', minDeliveryDays: 1, maxDeliveryDays: 2, type: 'express' },
      { name: 'DHL Parcel', shipmentMethodUid: 'dhl_parcel', price: 4.5, currency: 'EUR', minDeliveryDays: 3, maxDeliveryDays: 5, type: 'normal' },
    ],
    products: [{ itemReferenceId: '11', productUid: 'x', quantity: 1, price: 11.0, currency: 'EUR' }],
  }],
};
export const gelatoStatusEvent = {
  id: 'os_5e5680ce494f6', event: 'order_status_updated', orderId: '37365096-6628-4538-a9c2-fbf9892deb85', storeId: null, orderReferenceId: 'TCD-261112-AB2C-F1-0', fulfillmentStatus: 'shipped',
  items: [{ itemReferenceId: '11', fulfillmentStatus: 'shipped', fulfillments: [{ trackingCode: '00340434161094042557', trackingUrl: 'https://example.com/track/00340434161094042557', shipmentMethodName: 'DHL Parcel', shipmentMethodUid: 'dhl_parcel', fulfillmentCountry: 'DE' }] }],
};
export const gelatoStockEvent = (status) => ({ id: 'stock_1', event: 'catalog_product_stock_availability_updated', productsAvailability: [{ productUid: 'apparel_product_gca_t-shirt_gsc_crewneck_gcu_unisex_gqa_classic_gsi_s_gco_white_gpr_4-4', availability: [{ stockRegionUid: 'EU', status }, { stockRegionUid: 'US', status }] }] });

/* ---- Printlet API Integration 1.0.0-rc.1 — https://printleteg.com/api/developer-docs/api-integration/openapi ---- */
export const printletCountries = { data: [{ id: 'c0000000-0000-4000-8000-000000000001', revision: 1, code: 'EG', name: 'Egypt', currency: 'EGP' }] };
export const printletShipping = { data: [{ id: 'd0000000-0000-4000-8000-000000000001', revision: 1, name: 'Standard', delivery_time: '1-2 working days', rates: [{ id: 'r1', name: 'Cairo & Giza', cities: [{ id: 'e0000000-0000-4000-8000-000000000001', name: 'Cairo' }], price_type: 'flat', price: {} }] }] };
export const printletProduct = {
  id: 'prod-1', revision: 3, name: 'Custom T-Shirt', status: 'active', variants: [{ id: 'var-1', revision: 2, sku: 'TEE-M-WHT', available: true }],
  print_areas: [{ id: 'area-front', revision: 4, key: 'front', name: 'Front', techniques: [{ id: 'tech-dtf', revision: 5, name: 'DTF', placement_presets: ['top_center', 'center'] }] }],
};
export const printletArtwork = (status = 'ready') => ({ id: 'art-1', revision: 1, status, environment: 'test', created_at: '2026-11-12T10:00:00Z' });
export const printletQuote = { id: 'quote-1', status: 'valid', total: { amount: '265.00', currency: 'EGP' }, shipping: { amount: '45.00', currency: 'EGP' }, expires_at: '2026-11-12T10:15:00Z' };
export const printletOrder = (over = {}) => ({ id: 'ord-1', merchant_order_id: 'TCD-261112-AB2C-F1-0', status: 'payment_required', payment_status: 'not_committed', environment: 'test', resource_version: 1, printlet_total: { amount: '265.00', currency: 'EGP' }, ...over });
export const printletEvent = (type = 'order.shipped') => ({ id: 'evt_1', type, api_version: 'v1', environment: 'test', occurred_at: '2026-11-12T10:00:00Z', installation_id: 'inst_1', resource: { id: 'ord-1', merchant_order_id: 'TCD-261112-AB2C-F1-0' } });
export const printletError = (code, retryable = false) => ({ error: { code, message: code, request_id: 'req_1', retryable } });
