// Shared outbound HTTP for supplier adapters. Owner: sup.
// - timeout per attempt (AbortSignal.timeout, default 15 s, contract "Outbound HTTP")
// - token bucket per supplier (documented rate limits), driven by an injectable clock so tests need no real time
// - retry on network error / timeout / 429 / 5xx with backoff, honouring Retry-After
// - ProviderError mapping: retryable for network, timeout, 429, 5xx; not retryable for other 4xx
// - safe logging: method, path without query, status, duration. Never headers, keys, bodies or addresses.
import { ProviderError } from '../lib/errors.js';

const realSleep = (ms) => new Promise((ok) => { const t = setTimeout(ok, ms); if (t.unref) t.unref(); });

/** Simple token bucket: `capacity` requests per `windowMs`, refilled continuously. */
export function createTokenBucket({ capacity, windowMs = 60000, now = Date.now }) {
  let tokens = capacity; let last = now();
  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + ((t - last) * capacity) / windowMs);
    last = t;
  };
  return {
    /** 0 when a token was taken, otherwise the milliseconds to wait before trying again. */
    take() {
      refill();
      if (tokens >= 1) { tokens -= 1; return 0; }
      return Math.ceil(((1 - tokens) * windowMs) / capacity);
    },
    /** The supplier said "stop" (429): empty the bucket so queued calls wait too. */
    drain() { refill(); tokens = 0; },
    get tokens() { refill(); return tokens; },
  };
}

/** Retry-After: seconds or an HTTP date → milliseconds, or null. */
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000));
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

const safePath = (path) => String(path).split('?')[0];

/** Short supplier error text, cleaned of anything that looks like an address or contact detail. */
function safeMessage(data) {
  let msg = '';
  if (data && typeof data === 'object') {
    const e = data.error && typeof data.error === 'object' ? data.error : null;
    const errs = data.errors && typeof data.errors === 'object' ? data.errors : null;
    msg = (e && (e.message || e.reason)) || (errs && errs.reason) || data.message || (typeof data.result === 'string' ? data.result : '') || '';
  }
  return String(msg).replace(/[^\s@]+@[^\s@]+/g, '[email]').replace(/\+?\d[\d ()-]{7,}\d/g, '[number]').slice(0, 160);
}

/**
 * @param {object} o
 * @param {string} o.provider   adapter id, used in errors and log lines
 * @param {string} o.baseUrl
 * @param {() => object} o.headers   returns auth headers (never logged)
 * @param {{capacity:number, windowMs?:number}} [o.rate]   token bucket; omit for no limit
 * @param {object} [o.deps]  { fetch, now, sleep, random, log }
 */
export function createHttp({ provider, baseUrl, headers = () => ({}), rate, timeoutMs = 15000, maxAttempts = 3, maxWaitMs = 8000, deps = {} }) {
  const doFetch = deps.fetch || globalThis.fetch;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || realSleep;
  const random = deps.random || Math.random;
  const log = deps.log || null;
  const bucket = rate ? createTokenBucket({ ...rate, now }) : null;
  const say = (line) => { if (log) (log.info || log.log || (() => {})).call(log, line); };
  const fail = (code, message, extra) => new ProviderError(code, message, { provider, ...extra });

  /**
   * @param {string} method
   * @param {string} path           joined to baseUrl
   * @param {object} [opt] { body, query, headers, retry (default true), timeoutMs, attempts }
   * @returns {Promise<{status:number, data:any, headers:Headers}>}
   */
  async function request(method, path, opt = {}) {
    const url = new URL(baseUrl.replace(/\/+$/, '') + path);
    for (const [k, v] of Object.entries(opt.query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const attempts = opt.retry === false ? 1 : (opt.attempts || maxAttempts);
    const perTry = opt.timeoutMs || timeoutMs;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (bucket) {
        const wait = bucket.take();
        if (wait > 0) {
          if (wait > maxWaitMs) throw Object.assign(fail('RATE_LIMITED', `${provider}: local rate limit, retry in ${wait} ms`, { retryable: true, status: 429 }), { retryAfterMs: wait });
          await sleep(wait);
          bucket.take();
        }
      }
      const started = now();
      let res; let wait = null;
      try {
        res = await doFetch(url, {
          method,
          headers: { Accept: 'application/json', ...(opt.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers(), ...(opt.headers || {}) },
          body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
          signal: AbortSignal.timeout(perTry),
        });
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        say(`[sup:${provider}] ${method} ${safePath(path)} ${timedOut ? 'timeout' : 'network-error'} ${now() - started}ms try ${attempt}`);
        lastError = fail(timedOut ? 'TIMEOUT' : 'NETWORK', `${provider}: ${timedOut ? 'timeout' : 'network error'} on ${method} ${safePath(path)}`, { retryable: true });
      }
      if (res) {
        let data = null;
        try { const text = await res.text(); data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
        say(`[sup:${provider}] ${method} ${safePath(path)} ${res.status} ${now() - started}ms try ${attempt}`);
        if (res.status >= 200 && res.status < 300) return { status: res.status, data, headers: res.headers };
        const retryable = res.status === 429 || res.status >= 500;
        const detail = safeMessage(data);
        lastError = fail(`${provider.toUpperCase()}_HTTP_${res.status}`, `${provider}: ${method} ${safePath(path)} answered ${res.status}${detail ? ` (${detail})` : ''}`, { retryable, status: res.status });
        Object.defineProperty(lastError, 'body', { value: data, enumerable: false }); // for adapter logic only, never logged
        if (!retryable) throw lastError;
        if (res.status === 429) {
          if (bucket) bucket.drain();
          wait = retryAfterMs(res.headers && res.headers.get ? res.headers.get('retry-after') : null, now());
          if (wait !== null) lastError.retryAfterMs = wait;
        }
      }
      if (attempt === attempts) break;
      // Retry-After wins and gets jitter on top (Printful asks for it); otherwise exponential backoff.
      const backoff = wait !== null ? wait + Math.floor(random() * 250) : 500 * 3 ** (attempt - 1) + Math.floor(random() * 250);
      if (backoff > maxWaitMs) break; // too long for a web request: the job queue retries later
      await sleep(backoff);
    }
    throw lastError;
  }

  return { request, get: (p, o) => request('GET', p, o), post: (p, body, o) => request('POST', p, { ...o, body }), del: (p, o) => request('DELETE', p, o), bucket };
}
