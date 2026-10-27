/**
 * Restore points taken before an update is applied (D-127): the commit a server was on, so Operations → Updates can put the
 * code back. One row per update per server; only the last few are kept. Additive only.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('update_restore_points', (t) => {
    t.increments('id');
    t.string('server_key', 40).notNullable().index(); // sha1(host | app folder): a server keeps its id across restarts, a node id does not
    t.string('host', 190).notNullable();
    t.string('branch', 100).nullable();
    t.string('from_commit', 40).notNullable();
    t.string('to_commit', 40).notNullable();
    t.boolean('install_changed').notNullable().defaultTo(false);
    t.boolean('migrations_changed').notNullable().defaultTo(false);
    t.integer('backup_id').unsigned().nullable(); // the safety backup taken just before, if that setting was on
    t.string('status', 16).notNullable().defaultTo('available'); // available | rolled_back
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('update_restore_points');
}
