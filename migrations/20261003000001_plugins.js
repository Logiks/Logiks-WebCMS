/**
 * Applications → Plugin Manager (docs/DECISIONS.md D-060). A plugin's files live at plugins/<slug>/ on this
 * server — same split as themes (D-031): a `source: 'disk'` row is a hand-authored/Plugin-Editor-written folder
 * that ships via git/deploy like the app's own code; a `source: 'db'` row was installed from an uploaded zip, so
 * its bytes are stored here (a cluster has no shared disk) and each node materializes them at that same path the
 * first time it needs them. Either way `enabled` is cluster-shared state that only the database can hold.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('plugins', (t) => {
    t.increments('id');
    t.string('slug', 191).notNullable().unique();
    t.string('name', 120).notNullable();
    t.string('version', 32).notNullable();
    t.string('author', 120).notNullable().defaultTo('');
    t.string('description', 400).notNullable().defaultTo('');
    t.text('manifest', 'longtext').notNullable(); // the full plugin.json
    t.string('source', 8).notNullable(); // 'disk' | 'db'
    t.string('integrity', 191).nullable(); // sha256 of the zip bytes; null for source: 'disk'
    t.text('package', 'longtext').nullable(); // base64 of the zip; null for source: 'disk'
    t.text('files', 'longtext').nullable(); // JSON [[path, size], …]; null for source: 'disk'
    t.bigInteger('size').nullable();
    t.bigInteger('unpacked_size').nullable();
    t.boolean('enabled').notNullable().defaultTo(false);
    t.integer('installed_by').unsigned().nullable();
    t.bigInteger('installed_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('plugin_migrations', (t) => {
    t.increments('id');
    t.string('plugin_slug', 191).notNullable();
    t.string('name', 191).notNullable();
    t.integer('batch').notNullable();
    t.bigInteger('applied_at').notNullable();
    t.unique(['plugin_slug', 'name']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('plugin_migrations');
  await knex.schema.dropTableIfExists('plugins');
}
