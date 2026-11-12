// Smoke tests for the scaffolding. Owner: core. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './harness.js';
import { loadConfig } from '../config.js';

const TABLES = ['orders', 'order_items', 'payments', 'fulfilments', 'shipments', 'jobs', 'webhook_events', 'email_log', 'order_events'];

test('no env: boots, commerce is off, no database is opened', async () => {
  const s = await startTestServer({ COMMERCE_MODE: '', DATABASE_URL: '' });
  try {
    assert.equal(s.db, null);
    const { status, body } = await s.api('/api/config');
    assert.equal(status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.mode, 'off');
    assert.equal(body.whatsappFallback, true);
  } finally { await s.close(); }
});

test('mock mode: migration creates every table; unknown API path answers JSON 404', async () => {
  const s = await startTestServer();
  try {
    for (const name of TABLES) assert.equal(await s.db.schema.hasTable(name), true, name);
    const { status, body } = await s.api('/api/nope');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  } finally { await s.close(); }
});

test('config: a provider group is null until all of its variables are set', () => {
  assert.equal(loadConfig({}).mode, 'off');
  assert.equal(loadConfig({ COMMERCE_MODE: 'live' }).mode, 'off'); // live needs DATABASE_URL
  assert.equal(loadConfig({ STRIPE_ES_SECRET_KEY: 'x' }).stripe.es, null);
  assert.ok(loadConfig({ STRIPE_ES_SECRET_KEY: 'x', STRIPE_ES_WEBHOOK_SECRET: 'y' }).stripe.es);
});
