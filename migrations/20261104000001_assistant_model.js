/**
 * A chat can use a different model from the installation's default (docs/DECISIONS.md D-074). Null = the default
 * set under Settings → AI.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('assistant_sessions', (t) => {
    t.string('model', 64).nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('assistant_sessions', (t) => {
    t.dropColumn('model');
  });
}
