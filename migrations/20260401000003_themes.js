/**
 * Phase 2, M2.3 — installed themes. Expand-only. Themes that ship with the app live in the repository's themes/ folder;
 * themes installed from a zip are stored here (not on disk) so every server in a cluster has them the moment they are installed.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('themes', (t) => {
    t.string('id', 32).primary();
    t.string('name', 80).notNullable();
    t.string('version', 32).notNullable();
    t.string('description', 400).notNullable().defaultTo('');
    t.string('author', 120).notNullable().defaultTo('');
    t.text('manifest', 'longtext').notNullable();
    t.string('content_hash', 64).notNullable();
    t.integer('installed_by').unsigned().nullable();
    t.bigInteger('installed_at').notNullable();
  });
  await knex.schema.createTable('theme_files', (t) => {
    t.increments('id');
    t.string('theme_id', 32).notNullable().references('id').inTable('themes').onDelete('CASCADE');
    t.string('path', 191).notNullable();
    t.string('encoding', 8).notNullable(); // utf8 | base64
    t.text('content', 'longtext').notNullable();
    t.integer('size').notNullable();
    t.unique(['theme_id', 'path']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('theme_files');
  await knex.schema.dropTableIfExists('themes');
}
