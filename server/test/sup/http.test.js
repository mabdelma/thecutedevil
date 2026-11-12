// Shared supplier HTTP helper: rate limit, retry and error mapping with a fake clock. Owner: sup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttp, createTokenBucket, retryAfterMs } from '../../suppliers/http.js';
import { ProviderError } from '../../lib/errors.js';
import { fakeClock, fakeFetch } from './helpers.js';

const make = (handler, extra = {}) => {
  const clock = fakeClock(); const fetch = fakeFetch(handler); const lines = [];
  const http = createHttp({ provider: 'printful', baseUrl: 'https://api.example.test', headers: () => ({ Authorization: 'Bearer SECRET-KEY' }), deps: { fetch, ...clock, log: { info: (l) => lines.push(l) } }, ...extra });
  return { http, fetch, clock, lines };
};

test('token bucket: capacity per window, refills with the clock', () => {
  const clock = fakeClock();
  const bucket = createTokenBucket({ capacity: 3, windowMs: 60000, now: clock.now });
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take()], [0, 0, 0]);
  assert.equal(bucket.take(), 20000); // one token every 20 s
  clock.advance(20000);
  assert.equal(bucket.take(), 0);
  bucket.drain();
  assert.equal(bucket.take(), 20000);
});

test('rate limit: the call past the budget waits for a token instead of hitting the supplier', async () => {
  const { http, fetch, clock } = make(() => ({ body: { ok: 1 } }), { rate: { capacity: 2, windowMs: 10000 } });
  await http.get('/a'); await http.get('/b');
  assert.deepEqual(clock.sleeps, []);
  await http.get('/c');
  assert.deepEqual(clock.sleeps, [5000]);
  assert.equal(fetch.calls.length, 3);
});

test('rate limit: a wait longer than a web request can afford becomes a retryable error', async () => {
  const { http } = make(() => ({}), { rate: { capacity: 1, windowMs: 60000 } });
  await http.get('/a');
  await assert.rejects(http.get('/b'), (e) => e instanceof ProviderError && e.code === 'RATE_LIMITED' && e.retryable === true && e.retryAfterMs === 60000);
});

test('429: waits for Retry-After, then succeeds', async () => {
  let n = 0;
  const { http, clock, fetch } = make(() => { n += 1; return n === 1 ? { status: 429, headers: { 'retry-after': '2' }, body: { code: 429 } } : { body: { code: 200, result: 'ok' } }; });
  const res = await http.get('/orders/1');
  assert.equal(res.data.result, 'ok');
  assert.deepEqual(clock.sleeps, [2000]);
  assert.equal(fetch.calls.length, 2);
});

test('429 with a long Retry-After: gives up at once, retryable, with retryAfterMs for the job queue', async () => {
  const { http, fetch, clock } = make(() => ({ status: 429, headers: { 'retry-after': '60' } }));
  await assert.rejects(http.get('/x'), (e) => e.retryable === true && e.status === 429 && e.retryAfterMs === 60000 && e.provider === 'printful');
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test('5xx: exponential backoff, three attempts, then a retryable ProviderError', async () => {
  const { http, fetch, clock } = make(() => ({ status: 503 }));
  await assert.rejects(http.get('/x'), (e) => e instanceof ProviderError && e.retryable === true && e.status === 503 && e.code === 'PRINTFUL_HTTP_503');
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(clock.sleeps, [500, 1500]);
});

test('4xx: no retry, not retryable, body kept for the adapter but not enumerable', async () => {
  const { http, fetch } = make(() => ({ status: 400, body: { code: 400, error: { message: 'Bad zip for buyer@example.com +34 600 000 000' } } }));
  await assert.rejects(http.post('/orders', { a: 1 }), (e) => {
    assert.equal(e.retryable, false); assert.equal(e.status, 400);
    assert.equal(e.body.code, 400);
    assert.ok(!JSON.stringify(e).includes('Bad zip'));
    assert.ok(!e.message.includes('buyer@example.com') && !e.message.includes('600 000'));
    return true;
  });
  assert.equal(fetch.calls.length, 1);
});

test('network error and timeout are retryable; retry:false makes one attempt only', async () => {
  const a = make(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(a.http.get('/x'), (e) => e.code === 'NETWORK' && e.retryable === true);
  assert.equal(a.fetch.calls.length, 3);
  const b = make(() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  await assert.rejects(b.http.post('/x', {}, { retry: false }), (e) => e.code === 'TIMEOUT' && e.retryable === true);
  assert.equal(b.fetch.calls.length, 1);
});

test('logging: method, path, status only. No key, no query, no body', async () => {
  const { http, lines } = make(() => ({ body: { email: 'buyer@example.com' } }));
  await http.post('/orders', { recipient: { address1: '1 Example Street' } }, { query: { confirm: 'true', key: 'URLSECRET' } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[sup:printful\] POST \/orders 200 \d+ms try 1$/);
  assert.ok(!/SECRET|Example Street|buyer@/.test(lines.join('\n')));
});

test('Retry-After parsing: seconds and HTTP date', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('2026-10-21T07:28:00Z')), 10000);
  assert.equal(retryAfterMs(null), null);
});
