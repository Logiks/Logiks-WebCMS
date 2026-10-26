/**
 * Automatic unpublishing: a published (or scheduled) entry can carry the time it goes back to draft.
 * Additive only (expand/contract): old code ignores the column.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('entries', (t) => {
    t.bigInteger('unpublish_at').nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('entries', (t) => {
    t.dropColumn('unpublish_at');
  });
}
