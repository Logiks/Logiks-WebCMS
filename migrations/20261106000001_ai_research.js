/**
 * Content → AI Research: what the assistant found on the web, with the links it came from.
 * JSON columns are TEXT (portable). `sources` is [{url, title, note}], `media_ids` the images saved with it.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('ai_research', (t) => {
    t.increments('id');
    t.string('title', 191).notNullable();
    t.text('topic', 'longtext').notNullable(); // what was asked
    t.text('summary', 'longtext').notNullable(); // markdown
    t.text('sources', 'longtext').notNullable();
    t.text('media_ids', 'longtext').notNullable();
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['created_at']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('ai_research');
}
