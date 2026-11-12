// Paymob "transaction processed" callback, built from the worked example on Paymob's "HMAC Transaction Callback"
// documentation page (read 2026-11-12). The 20 signed values below concatenate to the page's example string.
export const DOCUMENTED_STRING = '1000002024-06-13T11:33:44.592345EGPfalsefalse1920364654097558truefalsefalsefalsetruefalse217503754302852false2346MasterCardcardtrue';
export const TEST_SECRET = 'test_hmac_secret_not_real';
// HMAC-SHA512(TEST_SECRET, DOCUMENTED_STRING), computed once outside the provider code.
export const EXPECTED_HMAC = 'ed694fb80e84bccd94f6f4aba42b4d84dd5ddce017c2b1be1ea89600888f62bab17a1549c7e05b78596b9d992dfe8d1bbd1a4dd5fcf007f7a192a42f57228979';

export const transaction = (over = {}) => ({
  id: 192036465, pending: false, amount_cents: 100000, success: true, is_auth: false, is_capture: false,
  is_standalone_payment: true, is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: 4097558,
  has_parent_transaction: false, order: { id: 217503754, merchant_order_id: 'checkout:7:1' }, created_at: '2024-06-13T11:33:44.592345',
  currency: 'EGP', source_data: { pan: '2346', type: 'card', sub_type: 'MasterCard' }, error_occured: false, owner: 302852,
  payment_key_claims: { extra: { order_public_id: 'TCD-261112-AB2C', payment_id: '7' } }, ...over,
});
export const callback = (obj = transaction()) => ({ type: 'TRANSACTION', obj });
