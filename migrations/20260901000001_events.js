/**
 * Events + Webhooks (D-050): a log of everything the platform (or an admin's own script Service, D-046) emitted,
 * and admin-defined HTTP callbacks that fire when one matches. Expand-only.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('events_log', (t) => {
    t.increments('id');
    t.string('name', 191).notNullable().index();
    t.text('payload', 'longtext').nullable(); // JSON
    t.bigInteger('created_at').notNullable();
  });
  await knex.schema.createTable('webhooks', (t) => {
    t.increments('id');
    t.string('name', 200).notNullable();
    t.string('event', 191).notNullable(); // exact ('content.published') or wildcard ('content.*', '**')
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('url', 500).notNullable();
    t.text('secret').nullable(); // encrypted envelope (ctx.crypto) — write-only, signs the delivery
    t.text('headers', 'longtext').nullable(); // JSON [{name, value}]
    t.text('payload', 'longtext').nullable(); // JSON object — a default merged under the real event's payload
    t.integer('created_by').unsigned().nullable();
    t.integer('updated_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('webhook_deliveries', (t) => {
    t.increments('id');
    t.integer('webhook_id').unsigned().notNullable().index();
    t.string('event', 191).notNullable();
    t.string('status', 20).notNullable(); // 'success' | 'failed'
    t.integer('response_code').unsigned().nullable();
    t.text('error').nullable();
    t.integer('duration_ms').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('webhook_deliveries');
  await knex.schema.dropTableIfExists('webhooks');
  await knex.schema.dropTableIfExists('events_log');
}
