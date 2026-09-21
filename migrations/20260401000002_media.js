/**
 * Phase 2, M2.2 — media library. Expand-only. Files live in the storage adapter (local folder or shared volume);
 * this table is the catalogue: what each file is, its size, alt text and the variants generated from it.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('media', (t) => {
    t.increments('id');
    t.string('filename', 255).notNullable();
    t.string('mime', 64).notNullable();
    t.string('kind', 16).notNullable(); // image | file
    t.bigInteger('size').notNullable();
    t.integer('width').nullable();
    t.integer('height').nullable();
    t.string('alt', 500).notNullable().defaultTo('');
    t.string('hash', 64).notNullable().index(); // sha256 of the stored original, for duplicate detection
    t.string('original_file', 64).notNullable();
    t.text('variants', 'longtext').notNullable(); // JSON: [{file, width, format, size}]
    t.integer('uploaded_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['kind', 'id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('media');
}
