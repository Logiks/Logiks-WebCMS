/**
 * Phase 2, M2.5 — site search. Expand-only. One portable table holds the searchable text of each published entry; each
 * engine adds its own full-text index over it (the only place this codebase is engine-specific on purpose):
 *   SQLite      an FTS5 virtual table mirroring title/body
 *   MySQL       a FULLTEXT index on (title, body)
 *   PostgreSQL  a GIN index over to_tsvector('simple', title || ' ' || body)
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('search_index', (t) => {
    t.increments('id');
    t.integer('entry_id').unsigned().notNullable().unique();
    t.string('type', 64).notNullable();
    t.string('locale', 16).notNullable();
    t.string('title', 255).notNullable();
    t.text('body', 'longtext').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
  const client = String(knex.client.config.client);
  if (client.includes('sqlite'))
    await knex.raw(
      "CREATE VIRTUAL TABLE search_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2')",
    );
  else if (client.includes('mysql'))
    await knex.raw('ALTER TABLE search_index ADD FULLTEXT INDEX search_index_ft (title, body)');
  else
    await knex.raw(
      "CREATE INDEX search_index_fts ON search_index USING GIN (to_tsvector('simple', title || ' ' || body))",
    );
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const client = String(knex.client.config.client);
  if (client.includes('sqlite')) await knex.raw('DROP TABLE IF EXISTS search_fts');
  await knex.schema.dropTableIfExists('search_index');
}
