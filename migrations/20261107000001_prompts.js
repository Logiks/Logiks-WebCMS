/**
 * Prompt management (docs/DECISIONS.md D-082): the instructions the AI builders follow, editable in the admin.
 * `builtin` rows come from src/modules/prompts/defaults.js; `edited` marks one an admin changed, so a newer shipped
 * text never overwrites it. `shipped_v` is the shipped version the row was last synced to.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('prompts', (t) => {
    t.increments('id');
    t.string('key', 120).notNullable().unique();
    t.string('kind', 24).notNullable(); // master | workflow | project_type
    t.string('label', 120).notNullable();
    t.string('description', 400).notNullable().defaultTo('');
    t.text('body', 'longtext').notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.boolean('builtin').notNullable().defaultTo(false);
    t.boolean('edited').notNullable().defaultTo(false);
    t.integer('shipped_v').notNullable().defaultTo(0);
    t.integer('updated_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['kind']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('prompts');
}
