/**
 * Publish → Git (D-117): the releases of the site. A release is a named point (v1, v2…) that points at a commit in the
 * change history and at a git tag. Expand-only.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('site_versions', (t) => {
    t.increments('id');
    t.integer('version').notNullable().unique();
    t.string('note', 500).notNullable().defaultTo('');
    t.string('branch', 120).notNullable().defaultTo('main');
    t.string('sha', 64).nullable(); // the git commit, when the git copy is on
    t.integer('commit_id').nullable(); // the newest change-history entry at that moment
    t.string('author_name', 120).notNullable().defaultTo('');
    t.boolean('pushed').notNullable().defaultTo(false);
    t.bigInteger('created_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('site_versions');
}
