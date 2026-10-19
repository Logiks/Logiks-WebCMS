/**
 * What a chat is pinned to (docs/DECISIONS.md D-085): a document path such as pages/about.html, or plugins/<slug> for a
 * whole plugin. Null = not pinned.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('assistant_sessions', (t) => {
    t.string('focus', 191).nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('assistant_sessions', (t) => {
    t.dropColumn('focus');
  });
}
