/**
 * Scheduler (D-051, Phase 2 of the Events/Webhooks/Scheduler plan): admin-editable recurring automation — run a
 * saved Service, or fire a Webhook, on an interval or a cron schedule. Expand-only.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('scheduled_tasks', (t) => {
    t.increments('id');
    t.string('name', 200).notNullable();
    t.string('kind', 20).notNullable(); // 'service' | 'webhook'
    t.string('target', 200).notNullable(); // a service slug, or a webhook id (as text)
    t.string('schedule_type', 20).notNullable(); // 'interval' | 'cron'
    t.integer('every_ms').unsigned().nullable();
    t.string('cron_expr', 100).nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.text('params', 'longtext').nullable(); // JSON — query params (service) or payload (webhook) for this run
    t.bigInteger('last_run_at').unsigned().nullable();
    t.string('last_status', 20).nullable(); // 'ok' | 'error'
    t.text('last_error').nullable();
    t.integer('created_by').unsigned().nullable();
    t.integer('updated_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('scheduled_tasks');
}
