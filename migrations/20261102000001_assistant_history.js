/**
 * System → Assistant phases 2–5 (docs/DECISIONS.md D-072): a change history the assistant (and Revert) write to, and
 * per-user daily token usage for budgets.
 *
 * `site_commits` is the source of truth for history, in the database like everything else here; the git repository
 * on each server is a mirror replayed from these rows. `site_commit_files` keeps the text before and after each
 * change, which is what makes a diff and a safe Revert possible without reading git.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('site_commits', (t) => {
    t.increments('id');
    t.string('kind', 16).notNullable(); // 'baseline' | 'change' | 'revert'
    t.string('message', 500).notNullable();
    t.integer('author_id').unsigned().nullable();
    t.string('author_name', 120).notNullable().defaultTo('');
    t.integer('session_id').unsigned().nullable();
    t.integer('reverts_id').unsigned().nullable();
    t.string('sha', 64).nullable(); // filled in when a server's git mirror replays this commit
    t.integer('file_count').unsigned().notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.index(['session_id']);
  });
  await knex.schema.createTable('site_commit_files', (t) => {
    t.increments('id');
    t.integer('commit_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('site_commits')
      .onDelete('CASCADE');
    t.string('path', 191).notNullable();
    t.text('before_text', 'longtext').nullable(); // null = the file did not exist
    t.text('after_text', 'longtext').nullable(); // null = the file was deleted
    t.index(['commit_id']);
  });
  await knex.schema.createTable('assistant_usage', (t) => {
    t.integer('user_id').unsigned().notNullable();
    t.integer('day').unsigned().notNullable(); // whole days since the epoch (UTC)
    t.bigInteger('tokens').notNullable().defaultTo(0); // input + output, cache reads excluded
    t.primary(['user_id', 'day']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('assistant_usage');
  await knex.schema.dropTableIfExists('site_commit_files');
  await knex.schema.dropTableIfExists('site_commits');
}
