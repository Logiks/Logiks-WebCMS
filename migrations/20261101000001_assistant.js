/**
 * System → Assistant (docs/DECISIONS.md D-071): one chat panel for the whole admin. Sessions are per user; messages
 * are stored exactly as the Anthropic API wants them back (`{role, content}`), like the Page Designer's (D-065).
 * `assistant_docs` holds the site requirements document (a DB row, not a site-tree file: the site tree only
 * accepts pages/components/locales).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('assistant_sessions', (t) => {
    t.increments('id');
    t.string('title', 191).notNullable().defaultTo('');
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    // A turn in progress holds this until it ends (or times out), so two servers never interleave one conversation.
    t.bigInteger('busy_until').nullable();
    t.bigInteger('input_tokens').notNullable().defaultTo(0);
    t.bigInteger('output_tokens').notNullable().defaultTo(0);
    t.bigInteger('cache_read_tokens').notNullable().defaultTo(0);
    t.index(['created_by', 'updated_at']);
  });
  await knex.schema.createTable('assistant_messages', (t) => {
    t.increments('id');
    t.integer('session_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('assistant_sessions')
      .onDelete('CASCADE');
    t.string('role', 16).notNullable(); // 'user' | 'assistant'
    t.text('content', 'longtext').notNullable(); // string, or a JSON content-block array
    t.bigInteger('created_at').notNullable();
    t.index(['session_id', 'id']);
  });
  await knex.schema.createTable('assistant_docs', (t) => {
    t.string('name', 64).primary();
    t.text('content', 'longtext').notNullable();
    t.integer('updated_by').unsigned().nullable();
    t.bigInteger('updated_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('assistant_docs');
  await knex.schema.dropTableIfExists('assistant_messages');
  await knex.schema.dropTableIfExists('assistant_sessions');
}
