/**
 * Files downloaded from a CDN once and served by the site itself (docs/DECISIONS.md D-076), so a live site needs no
 * internet and a visitor's browser never contacts the CDN. Stored in the database like library tarballs (a cluster has
 * no shared disk), as base64 text.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('library_mirrors', (t) => {
    t.increments('id');
    t.string('url_hash', 64).notNullable().unique(); // sha-256 of the source address (or of the bytes, for a data: file)
    t.text('url', 'longtext').notNullable(); // where it came from (for a data: file, a short description)
    t.string('path', 191).notNullable().unique(); // _cdn/<12 hex>/<file>, served at /lib/<path>
    t.string('mime', 100).notNullable();
    t.integer('size').unsigned().notNullable();
    t.text('body', 'longtext').notNullable(); // base64
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('library_mirrors');
}
