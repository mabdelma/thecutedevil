// Environment → one frozen config object. Owner: core. Nothing else reads process.env.
// Contract: web/COMMERCE_ARCH.md section i. With no env at all this returns mode 'off'.

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
const flag = (v) => ['1', 'true', 'yes', 'on'].includes(str(v).toLowerCase());
/** A group is "configured" only when every listed key has a value; otherwise it is null. */
/** Optional on/off setting: '1'/'true' → true, '0'/'false' → false, unset → undefined (the reader's own default applies). */
const tri = (v) => (str(v) === '' ? undefined : flag(v) ? true : ['0', 'false', 'no', 'off'].includes(str(v).toLowerCase()) ? false : undefined);
const group = (obj, required) => (required.every((k) => obj[k]) ? Object.freeze(obj) : null);

/** Gelato return address (optional; see "Suppliers notes"): sent only when name, line 1, city, postcode and country are all set. */
function gelatoReturn(env) {
  const a = {
    companyName: str(env.GELATO_RETURN_COMPANY_NAME), addressLine1: str(env.GELATO_RETURN_ADDRESS_LINE1), addressLine2: str(env.GELATO_RETURN_ADDRESS_LINE2),
    city: str(env.GELATO_RETURN_CITY), postCode: str(env.GELATO_RETURN_POST_CODE), state: str(env.GELATO_RETURN_STATE),
    country: str(env.GELATO_RETURN_COUNTRY).toUpperCase(), email: str(env.GELATO_RETURN_EMAIL), phone: str(env.GELATO_RETURN_PHONE),
  };
  return a.companyName && a.addressLine1 && a.city && a.postCode && a.country ? Object.freeze(a) : null;
}

export function loadConfig(env = process.env) {
  const requested = str(env.COMMERCE_MODE).toLowerCase(); // '', 'off', 'mock', 'live'
  let databaseUrl = str(env.DATABASE_URL);
  let mode = 'off';
  const problems = []; // why commerce stayed off although it was asked for (logged at boot, never secrets)
  if (requested === 'mock') {
    mode = 'mock';
    if (!databaseUrl) databaseUrl = 'sqlite:./data/mock.sqlite';
  } else if (requested === 'live') {
    // live takes real money: it needs a database and the public address used in redirects and e-mails
    if (!databaseUrl) problems.push('COMMERCE_MODE=live needs DATABASE_URL');
    if (!str(env.PUBLIC_BASE_URL)) problems.push('COMMERCE_MODE=live needs PUBLIC_BASE_URL');
    else if (!/^https:\/\/[^\s/]+/i.test(str(env.PUBLIC_BASE_URL))) problems.push('PUBLIC_BASE_URL must start with https:// in live mode');
    if (problems.length === 0) mode = 'live';
  } else if (requested && requested !== 'off') {
    problems.push(`COMMERCE_MODE "${requested}" is not one of off, mock, live`);
  }

  return Object.freeze({
    mode, // 'off' | 'mock' | 'live'
    problems: Object.freeze(problems),
    port: Number(env.PORT) || 3000,
    host: str(env.HOST) || '0.0.0.0',
    publicBaseUrl: (str(env.PUBLIC_BASE_URL) || `http://127.0.0.1:${Number(env.PORT) || 3000}`).replace(/\/+$/, ''),
    databaseUrl: mode === 'off' ? '' : databaseUrl,
    enableUS: flag(env.ENABLE_US),
    enableUK: flag(env.ENABLE_UK),
    cronSecret: str(env.CRON_SECRET),
    admin: group({ user: str(env.ADMIN_USER), pass: str(env.ADMIN_PASS) }, ['user', 'pass']),
    ownerAlertEmail: str(env.OWNER_ALERT_EMAIL),
    // Key for the order-status link in customer e-mails (see "Integration notes"). At least 32 characters; when it is
    // missing in live mode the e-mails simply carry no link. Mock mode has a fixed, public value: no real orders there.
    orderLinkSecret: str(env.ORDER_LINK_SECRET).length >= 32 ? str(env.ORDER_LINK_SECRET) : mode === 'mock' ? 'mock-mode-order-link-key-not-a-secret' : '',
    smtp: group({
      host: str(env.SMTP_HOST), port: Number(env.SMTP_PORT) || 587, user: str(env.SMTP_USER),
      pass: str(env.SMTP_PASS), from: str(env.SMTP_FROM), secure: flag(env.SMTP_SECURE),
    }, ['host', 'user', 'pass', 'from']),
    stripe: Object.freeze({
      es: group({ secretKey: str(env.STRIPE_ES_SECRET_KEY), webhookSecret: str(env.STRIPE_ES_WEBHOOK_SECRET) }, ['secretKey', 'webhookSecret']),
      ae: group({ secretKey: str(env.STRIPE_AE_SECRET_KEY), webhookSecret: str(env.STRIPE_AE_WEBHOOK_SECRET) }, ['secretKey', 'webhookSecret']),
    }),
    paymob: group({
      secretKey: str(env.PAYMOB_SECRET_KEY), publicKey: str(env.PAYMOB_PUBLIC_KEY), hmacSecret: str(env.PAYMOB_HMAC_SECRET),
      integrationIdCard: str(env.PAYMOB_INTEGRATION_ID_CARD), integrationIdWallet: str(env.PAYMOB_INTEGRATION_ID_WALLET),
    }, ['secretKey', 'publicKey', 'hmacSecret', 'integrationIdCard']),
    printful: group({ apiKey: str(env.PRINTFUL_API_KEY), storeId: str(env.PRINTFUL_STORE_ID), webhookSecret: str(env.PRINTFUL_WEBHOOK_SECRET), confirm: tri(env.PRINTFUL_CONFIRM), webhookSigningKeyHex: str(env.PRINTFUL_WEBHOOK_SIGNING_KEY_HEX) }, ['apiKey', 'webhookSecret']),
    printify: group({ token: str(env.PRINTIFY_API_TOKEN), shopId: str(env.PRINTIFY_SHOP_ID), webhookSecret: str(env.PRINTIFY_WEBHOOK_SECRET), sendToProduction: tri(env.PRINTIFY_SEND_TO_PRODUCTION) }, ['token', 'shopId', 'webhookSecret']),
    gelato: group({ apiKey: str(env.GELATO_API_KEY), webhookSecret: str(env.GELATO_WEBHOOK_SECRET), confirm: tri(env.GELATO_CONFIRM), returnAddress: gelatoReturn(env) }, ['apiKey', 'webhookSecret']),
    printlet: group({ apiKey: str(env.PRINTLET_API_KEY), baseUrl: str(env.PRINTLET_BASE_URL), webhookSecret: str(env.PRINTLET_WEBHOOK_SECRET), apiConfirmed: flag(env.PRINTLET_API_CONFIRMED) }, ['apiKey', 'baseUrl', 'webhookSecret']),
  });
}
