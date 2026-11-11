/**
 * Deploy data sync (docs/DECISIONS.md D-134). Two small tables that let a server bring changes in from a deployment
 * without ever overwriting what someone changed here:
 *  - deploy_sync_state: the fingerprint of each record the last time a deployment set it, so the next deployment can tell
 *    "only dev changed it" (safe to update) from "someone changed it here too" (a conflict).
 *  - deploy_conflicts: changes that were NOT applied because the record differs here; they wait for a person to tick them.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('deploy_sync_state', (t) => {
    t.increments('id');
    t.string('tbl', 64).notNullable();
    t.string('row_key', 64).notNullable(); // sha-256 (first 40 hex) of the record's natural key
    t.string('label', 191).notNullable().defaultTo('');
    t.string('hash', 64).notNullable(); // fingerprint of the record as the deployment last left it
    t.bigInteger('updated_at').notNullable();
    t.unique(['tbl', 'row_key']);
  });
  await knex.schema.createTable('deploy_conflicts', (t) => {
    t.increments('id');
    t.string('tbl', 64).notNullable();
    t.string('row_key', 64).notNullable();
    t.string('label', 191).notNullable().defaultTo('');
    t.string('target_id', 191).nullable(); // the record's key here, when it has one
    t.text('incoming', 'longtext').notNullable(); // the deployment's version, already mapped to this server's ids (JSON)
    t.text('changes', 'longtext').notNullable(); // [{column, current, incoming}] with long values cut short (JSON)
    t.string('status', 12).notNullable().defaultTo('open'); // open | applied | dismissed
    t.string('deploy_ref', 64).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('resolved_at').nullable();
    t.string('resolved_by', 191).nullable();
    t.index(['status']);
    t.unique(['tbl', 'row_key']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('deploy_conflicts');
  await knex.schema.dropTableIfExists('deploy_sync_state');
}
