/**
 * Media folders, "uploaded uncompressed" and video. Expand-only: new columns have defaults, so a server still running
 * the previous release keeps working against this schema during a rolling deploy.
 * `media.folder` is a slash path ('' = the top level); `media_folders` only exists so an EMPTY folder can be kept —
 * a folder that holds files is known from the files themselves.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('media', (t) => {
    t.string('folder', 191).notNullable().defaultTo('');
    t.boolean('compressed').notNullable().defaultTo(true); // false = stored byte-for-byte as uploaded
    t.index(['folder', 'id']);
  });
  await knex.schema.createTable('media_folders', (t) => {
    t.increments('id');
    t.string('path', 191).notNullable().unique();
    t.bigInteger('created_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('media_folders');
  await knex.schema.alterTable('media', (t) => {
    t.dropIndex(['folder', 'id']);
    t.dropColumn('compressed');
    t.dropColumn('folder');
  });
}
