/**
 * Older turns of a chat are summarised once (by a cheaper model) instead of being dropped (docs/DECISIONS.md D-073).
 * `summary` is the running summary; `summary_upto` is the id of the last message it covers.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('assistant_sessions', (t) => {
    t.text('summary', 'longtext').nullable();
    t.integer('summary_upto').unsigned().notNullable().defaultTo(0);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('assistant_sessions', (t) => {
    t.dropColumn('summary');
    t.dropColumn('summary_upto');
  });
}
