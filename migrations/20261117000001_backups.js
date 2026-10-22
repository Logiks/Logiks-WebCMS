/**
 * Operations → Backups (docs/DECISIONS.md D-120): one row per backup file kept on this installation. The file itself is
 * in storage under `backups/<id>.zip`. Additive.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('backups', (t) => {
    t.increments('id');
    t.string('name', 191).notNullable();
    t.string('status', 16).notNullable().defaultTo('running'); // running | ready | failed
    t.string('source', 16).notNullable().defaultTo('created'); // created | uploaded | safety
    t.string('secrets', 16).notNullable().defaultTo('keep'); // keep | remove
    t.bigInteger('size').notNullable().defaultTo(0);
    t.text('manifest', 'longtext').nullable(); // JSON: what is inside
    t.string('error', 400).nullable();
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('backups');
}
