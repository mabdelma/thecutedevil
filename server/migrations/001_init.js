// First migration: the whole v1 schema. Owner: core. Contract: web/COMMERCE_ARCH.md section b.
// Conventions: *_at = epoch milliseconds (BIGINT); money = integer minor units; status columns are
// short strings checked in code (server/orders/states.js), not DB enums, so MySQL and SQLite agree.

export async function up(knex) {
  await knex.schema.createTable('orders', (t) => {
    t.increments('id');
    t.string('public_id', 20).notNullable().unique(); // TCD-YYMMDD-XXXX
    t.string('checkout_id', 36).notNullable().unique(); // client UUID: makes POST /api/checkout idempotent
    t.string('token_hash', 64).notNullable(); // sha256 hex of the order access token
    t.string('status', 24).notNullable().defaultTo('pending_payment');
    t.string('payment_status', 24).notNullable().defaultTo('unpaid');
    t.boolean('needs_attention').notNullable().defaultTo(false);
    t.string('attention_reason', 191);
    t.string('country', 2).notNullable();
    t.string('region', 8).notNullable(); // EU UK CA US AE GCC EG
    t.string('currency', 3).notNullable();
    t.string('lang', 5).notNullable().defaultTo('en');
    t.string('email', 191).notNullable();
    t.string('phone', 32);
    t.string('ship_name', 120).notNullable();
    t.string('ship_line1', 191).notNullable();
    t.string('ship_line2', 191);
    t.string('ship_city', 120).notNullable();
    t.string('ship_state', 120);
    t.string('ship_postcode', 20);
    t.string('note', 300);
    t.string('payment_method', 16).notNullable(); // card | wallet | cod
    t.string('payment_provider', 24).notNullable(); // stripe_es | stripe_ae | paymob | cod | mock | ...
    t.string('shipping_option', 24).notNullable().defaultTo('standard');
    t.integer('subtotal').notNullable();
    t.integer('shipping_total').notNullable().defaultTo(0);
    t.integer('discount_total').notNullable().defaultTo(0);
    t.integer('tax_total').notNullable().defaultTo(0);
    t.boolean('tax_included').notNullable().defaultTo(true);
    t.integer('tax_rate_bp').notNullable().defaultTo(0); // basis points: 2100 = 21%
    t.text('tax_details'); // JSON from the tax module
    t.integer('total').notNullable();
    t.bigInteger('terms_accepted_at');
    t.bigInteger('expires_at'); // unpaid orders only
    t.bigInteger('confirmed_at');
    t.bigInteger('anonymised_at');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['status', 'expires_at'], 'orders_status_expires_idx');
    t.index(['needs_attention', 'created_at'], 'orders_attention_idx');
    t.index('email', 'orders_email_idx');
    t.index('created_at', 'orders_created_idx');
  });

  await knex.schema.createTable('fulfilments', (t) => {
    t.increments('id');
    t.integer('order_id').unsigned().notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.integer('seq').notNullable(); // 1, 2, ... within the order
    t.string('supplier', 24).notNullable(); // current supplier (changes on reroute)
    t.text('candidates').notNullable(); // JSON array: ordered supplier ids from the routing engine
    t.integer('candidate_index').notNullable().defaultTo(0);
    t.string('status', 24).notNullable().defaultTo('pending');
    t.string('external_id', 32).notNullable().unique(); // sent to the supplier: <public_id>-F<seq>-<candidate_index>
    t.string('supplier_order_ref', 100);
    t.string('shipping_method', 40);
    t.integer('cost_amount'); // what the supplier charges us (items + shipping), minor units
    t.string('cost_currency', 3);
    t.integer('eta_min_days');
    t.integer('eta_max_days');
    t.integer('submit_attempts').notNullable().defaultTo(0);
    t.string('raw_status', 60);
    t.text('last_error');
    t.bigInteger('submitted_at');
    t.bigInteger('next_poll_at');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['order_id', 'seq'], { indexName: 'fulfilments_order_seq_uq' });
    t.index(['status', 'next_poll_at'], 'fulfilments_status_poll_idx');
    t.index(['supplier', 'supplier_order_ref'], 'fulfilments_supplier_ref_idx');
  });

  await knex.schema.createTable('order_items', (t) => {
    t.increments('id');
    t.integer('order_id').unsigned().notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.integer('fulfilment_id').unsigned().references('id').inTable('fulfilments').onDelete('SET NULL');
    t.string('product_id', 80).notNullable();
    t.string('variant_key', 120).notNullable(); // "size=M" | "default"
    t.string('name', 160).notNullable(); // snapshot, never translated
    t.string('category', 24).notNullable();
    t.integer('qty').notNullable();
    t.integer('unit_price').notNullable();
    t.integer('line_total').notNullable();
    t.integer('tax_amount').notNullable().defaultTo(0);
    t.integer('weight_g').notNullable().defaultTo(0);
    t.text('options'); // JSON { size: 'M' }
    t.text('personalisation'); // JSON { name: 'ALEX' } or null
    t.index('order_id', 'order_items_order_idx');
    t.index('fulfilment_id', 'order_items_fulfilment_idx');
  });

  await knex.schema.createTable('payments', (t) => {
    t.increments('id');
    t.integer('order_id').unsigned().notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.string('provider', 24).notNullable();
    t.string('method', 16).notNullable();
    t.string('status', 24).notNullable().defaultTo('created');
    t.integer('amount').notNullable();
    t.string('currency', 3).notNullable();
    t.integer('refunded_amount').notNullable().defaultTo(0);
    t.string('provider_ref', 191); // checkout session / intention id
    t.string('provider_payment_ref', 191); // payment intent / transaction id (used for refunds)
    t.text('redirect_url');
    t.string('raw_status', 60);
    t.string('idem_key', 80).notNullable().unique(); // checkout:<order id>:<n>
    t.text('last_error');
    t.bigInteger('expires_at');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index('order_id', 'payments_order_idx');
    t.unique(['provider', 'provider_ref'], { indexName: 'payments_provider_ref_uq' });
  });

  await knex.schema.createTable('shipments', (t) => {
    t.increments('id');
    t.integer('order_id').unsigned().notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.integer('fulfilment_id').unsigned().notNullable().references('id').inTable('fulfilments').onDelete('CASCADE');
    t.string('supplier_shipment_ref', 100).notNullable(); // supplier's id, or the tracking number
    t.string('status', 16).notNullable().defaultTo('shipped'); // shipped | delivered | returned
    t.string('carrier', 80);
    t.string('tracking_number', 100);
    t.string('tracking_url', 500);
    t.bigInteger('shipped_at');
    t.bigInteger('delivered_at');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['fulfilment_id', 'supplier_shipment_ref'], { indexName: 'shipments_fulfilment_ref_uq' });
    t.index('order_id', 'shipments_order_idx');
  });

  await knex.schema.createTable('jobs', (t) => {
    t.increments('id');
    t.string('type', 40).notNullable();
    t.text('payload').notNullable(); // JSON
    t.string('status', 12).notNullable().defaultTo('queued'); // queued | running | done | dead
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(5);
    t.bigInteger('run_after').notNullable();
    t.bigInteger('locked_at');
    t.text('last_error');
    t.string('idem_key', 120).notNullable().unique();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['status', 'run_after'], 'jobs_status_run_idx');
  });

  await knex.schema.createTable('webhook_events', (t) => {
    t.increments('id');
    t.string('source', 32).notNullable(); // pay:stripe_es | sup:printful | ...
    t.string('event_id', 191).notNullable();
    t.string('type', 80);
    t.string('status', 12).notNullable().defaultTo('received'); // received | processed | ignored | failed
    t.string('payload_hash', 64); // sha256 of the raw body; the body itself is not stored
    t.text('last_error');
    t.bigInteger('received_at').notNullable();
    t.bigInteger('processed_at');
    t.unique(['source', 'event_id'], { indexName: 'webhook_events_source_event_uq' });
  });

  await knex.schema.createTable('email_log', (t) => {
    t.increments('id');
    t.integer('order_id').unsigned().references('id').inTable('orders').onDelete('SET NULL');
    t.string('template', 40).notNullable();
    t.string('lang', 5).notNullable().defaultTo('en');
    t.string('to_email', 191).notNullable();
    t.string('status', 12).notNullable().defaultTo('queued'); // queued | sent | failed | skipped
    t.string('idem_key', 120).notNullable().unique(); // e.g. order_confirmed:42, shipped:shipment:7
    t.string('message_id', 191);
    t.text('vars'); // JSON: non-secret template variables
    t.text('last_error');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('sent_at');
    t.index('order_id', 'email_log_order_idx');
  });

  await knex.schema.createTable('order_events', (t) => {
    t.increments('id');
    t.integer('order_id').unsigned().notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.string('type', 40).notNullable(); // status_changed | payment | fulfilment | shipment | email | alert | note
    t.string('from_status', 24);
    t.string('to_status', 24);
    t.string('message', 500); // never contains secrets or card data
    t.bigInteger('created_at').notNullable();
    t.index(['order_id', 'created_at'], 'order_events_order_idx');
  });
}

export async function down(knex) {
  for (const name of ['order_events', 'email_log', 'webhook_events', 'jobs', 'shipments', 'payments', 'order_items', 'fulfilments', 'orders']) {
    await knex.schema.dropTableIfExists(name);
  }
}
