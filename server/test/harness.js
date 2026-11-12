// Shared end-to-end harness. Owner: core. Contract: web/COMMERCE_ARCH.md section k.
// Starts the real server on a free port with COMMERCE_MODE=mock and a throw-away SQLite file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../index.js';

const quiet = { log() {}, info() {}, warn() {}, error() {} };

/**
 * @param {object} [env]  extra env; pass { COMMERCE_MODE: '' } to test the "nothing configured" boot
 * @param {object} [overrides]  optional fakes passed to start(): { payments, suppliers, mapping, rules, routers, now, catalogue }.
 *   Without them the real registries are used (mock payment provider + mock supplier in mock mode).
 *   The in-process job timer is off in tests: drive jobs with POST /api/cron/tick (header Authorization: Bearer test-cron)
 *   and time with `ctx.now = () => <epoch ms>`. `ctx.outbox` holds the e-mails "sent" in mock mode;
 *   `ctx.limiter.reset()` clears the rate limits.
 * @returns {Promise<{url: string, ctx: object, db: object|null, api(path: string, init?: object): Promise<{status: number, body: any}>, close(): Promise<void>}>}
 */
export async function startTestServer(env = {}, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tcd-test-'));
  const running = await start({
    env: { COMMERCE_MODE: 'mock', DATABASE_URL: `sqlite:${join(dir, 'test.sqlite')}`, CRON_SECRET: 'test-cron', ADMIN_USER: 'admin', ADMIN_PASS: 'test-admin', ...env },
    port: 0,
    host: '127.0.0.1',
    log: quiet,
    timer: false,
    ...overrides,
  });
  const api = async (path, init = {}) => {
    const hasBody = init.body !== undefined && typeof init.body !== 'string' && !(init.body instanceof Uint8Array);
    const res = await fetch(running.url + path, {
      ...init,
      headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
      body: hasBody ? JSON.stringify(init.body) : init.body,
    });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch (err) { /* not JSON */ }
    return { status: res.status, body, headers: res.headers };
  };
  return {
    url: running.url,
    ctx: running.ctx,
    db: running.ctx.db,
    api,
    async close() { await running.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
