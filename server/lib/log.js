// Logger: one line per event, ids and codes only. Owner: core. Contract: section l.
// Keeps the console surface (log/info/warn/error) so providers and adapters can use it as `deps.log`,
// and adds an optional fields object: log.info('order.confirmed', { order: 'TCD-…', total: 8399 }).
const SENSITIVE_KEY = /key|secret|token|pass|authorization|email|phone|address|line1|line2|name$/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const SECRET_RE = /\b(sk|pk|rk|whsec)_(live|test)_[A-Za-z0-9]+/g;

/** Remove e-mail addresses, bearer tokens and Stripe-style keys from free text. */
export function scrub(text) {
  return String(text == null ? '' : text).replace(EMAIL_RE, '[email]').replace(BEARER_RE, '$1 [redacted]').replace(SECRET_RE, '[redacted]');
}

/** Deep copy with sensitive keys replaced. Safe on cycles (depth-limited). */
export function redact(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrub(value);
  if (value instanceof Error) return scrub(value.code ? `${value.code}: ${value.message}` : value.message);
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return String(value);
}

const formatFields = (fields) => Object.entries(redact(fields))
  .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`).join(' ');

/** Short, secret-free description of an error for logs and `last_error` columns. */
export function errorText(err) {
  if (!err) return '';
  const code = err.code && typeof err.code === 'string' ? `${err.code}: ` : '';
  return scrub(`${code}${err.message || err}`).slice(0, 300);
}

/** @param {{log?: Function, info?: Function, warn?: Function, error?: Function}} [sink] defaults to console */
export function createLogger(sink = console) {
  const write = (level) => (message, fields) => {
    const line = `[tcd] ${scrub(message instanceof Error ? errorText(message) : message)}${fields && typeof fields === 'object' ? ` ${formatFields(fields)}` : ''}`;
    const fn = sink[level] || sink.log;
    if (typeof fn === 'function') fn.call(sink, line);
  };
  return { log: write('log'), info: write('info'), warn: write('warn'), error: write('error') };
}
