/**
 * Expand-only migration (safe during a rolling deploy): each server now reports which git commit it is running and how its
 * last update went, so Operations → Updates can show every server and target one. Old code ignores the new columns.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('cluster_nodes', (t) => {
    t.string('app_commit', 64).nullable();
    t.text('update_state', 'longtext').nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('cluster_nodes', (t) => {
    t.dropColumn('update_state');
    t.dropColumn('app_commit');
  });
}
