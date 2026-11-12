// Recorded-shape Stripe snapshot events (API 2026-10-28.endive), trimmed to the fields the provider reads.
// No real ids, people or keys: everything here is invented.
export const session = (over = {}) => ({
  id: 'cs_test_fixture_001', object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
  amount_total: 8399, currency: 'eur', payment_intent: 'pi_fixture_001', client_reference_id: 'TCD-261112-AB2C',
  metadata: { order_public_id: 'TCD-261112-AB2C', payment_id: '7' }, ...over,
});
export const event = (type, object, over = {}) => ({
  id: `evt_fixture_${type.replace(/\W/g, '_')}`, object: 'event', api_version: '2026-10-28.endive', created: 1794400000,
  type, data: { object }, livemode: false, ...over,
});
export const charge = (over = {}) => ({
  id: 'ch_fixture_001', object: 'charge', amount: 8399, amount_refunded: 8399, currency: 'eur', refunded: true,
  payment_intent: 'pi_fixture_001', metadata: { order_public_id: 'TCD-261112-AB2C', payment_id: '7' }, ...over,
});
export const intent = (over = {}) => ({
  id: 'pi_fixture_001', object: 'payment_intent', amount: 8399, currency: 'eur', status: 'requires_payment_method',
  metadata: { order_public_id: 'TCD-261112-AB2C', payment_id: '7' }, ...over,
});
