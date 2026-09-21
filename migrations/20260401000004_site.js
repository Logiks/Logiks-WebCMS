/**
 * Phase 2, M2.4 — navigation menus, redirects and contact-form messages. Expand-only.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('menus', (t) => {
    t.increments('id');
    t.string('name', 64).notNullable().unique(); // what themes call it: menus.main
    t.string('title', 120).notNullable();
    t.text('items', 'longtext').notNullable(); // JSON tree: [{label, url | entryId, children: []}]
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('redirects', (t) => {
    t.increments('id');
    t.string('from_path', 191).notNullable().unique();
    t.string('to_url', 500).notNullable();
    t.integer('status_code').notNullable().defaultTo(301);
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
  });
  await knex.schema.createTable('contact_messages', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('email', 200).notNullable();
    t.text('message', 'longtext').notNullable();
    t.string('ip', 64).nullable();
    t.string('page', 191).nullable();
    t.boolean('emailed').notNullable().defaultTo(false);
    t.bigInteger('created_at').notNullable().index();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  for (const t of ['contact_messages', 'redirects', 'menus'])
    await knex.schema.dropTableIfExists(t);
}
