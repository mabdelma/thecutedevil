// In-memory fixed-window rate limiter (one process, per IP). Owner: core. Contract: section f.
import { AppError } from './errors.js';

export function createLimiter({ now = Date.now, maxKeys = 20000 } = {}) {
  const windows = new Map(); // `${bucket}|${key}` → { start, count }
  const blocks = new Map(); // `${bucket}|${key}` → blockedUntil

  const sweep = (t) => {
    if (windows.size + blocks.size <= maxKeys) return;
    for (const [k, w] of windows) if (t - w.start > 3600e3) windows.delete(k);
    for (const [k, until] of blocks) if (until <= t) blocks.delete(k);
    if (windows.size > maxKeys) windows.clear(); // last resort: never grow without bound
  };

  return {
    /** Count one hit. → { ok, remaining, retryAfterMs } */
    hit(bucket, key, limit, windowMs) {
      const t = now();
      const id = `${bucket}|${key}`;
      let w = windows.get(id);
      if (!w || t - w.start >= windowMs) { w = { start: t, count: 0 }; windows.set(id, w); sweep(t); }
      w.count += 1;
      const ok = w.count <= limit;
      return { ok, remaining: Math.max(0, limit - w.count), retryAfterMs: ok ? 0 : w.start + windowMs - t };
    },
    /** Milliseconds left on a block, or 0. */
    blockedFor(bucket, key) {
      const until = blocks.get(`${bucket}|${key}`) || 0;
      const left = until - now();
      if (left <= 0) { blocks.delete(`${bucket}|${key}`); return 0; }
      return left;
    },
    block(bucket, key, ms) { blocks.set(`${bucket}|${key}`, now() + ms); },
    /** Forget one counter (e.g. failed logins after a good one). */
    clear(bucket, key) { windows.delete(`${bucket}|${key}`); },
    reset() { windows.clear(); blocks.clear(); },
  };
}

export const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/** Express middleware: at most `limit` requests per `windowMs` per IP, else 429 RATE_LIMITED. */
export function rateLimit(limiter, bucket, limit, windowMs) {
  return (req, res, next) => {
    const r = limiter.hit(bucket, clientIp(req), limit, windowMs);
    if (r.ok) return next();
    res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
    return next(new AppError('RATE_LIMITED', 429, 'Too many requests. Please try again in a moment.'));
  };
}
