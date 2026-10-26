/**
 * Reusable content templates (D-126): a saved set of blocks a new entry can start from. Additive only.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('content_templates', (t) => {
    t.increments('id');
    t.string('type', 32).notNullable().index();
    t.string('name', 120).notNullable();
    t.string('description', 255).nullable();
    t.text('data', 'longtext').notNullable(); // JSON: the blocks (and summary) a new entry starts with
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('content_templates');
}
