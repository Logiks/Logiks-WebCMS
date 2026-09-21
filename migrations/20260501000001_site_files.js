/**
 * Site tree (docs/SITE-STRUCTURE.md). Expand-only.
 *  - site_files: the pages and components of the public site. The database is the source of truth; every server keeps an
 *    in-memory snapshot to render from and a mirror in its local public/ folder.
 *  - site_meta:  one row with a version counter bumped by every change, so servers notice edits made elsewhere
 *    (bus message + polling, like config_version).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('site_files', (t) => {
    t.increments('id');
    t.string('path', 191).notNullable().unique(); // pages/about.html, components/hero.html
    t.text('content', 'longtext').notNullable();
    t.string('content_hash', 64).notNullable(); // sha256 hex; also the optimistic-lock token for editors
    t.integer('size').notNullable();
    t.integer('updated_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('site_meta', (t) => {
    t.integer('id').primary();
    t.bigInteger('version').notNullable().defaultTo(0);
  });
  await knex('site_meta').insert({ id: 1, version: 0 });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('site_meta');
  await knex.schema.dropTableIfExists('site_files');
}
