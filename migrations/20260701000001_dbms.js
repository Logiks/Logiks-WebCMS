/**
 * System → Database (D-047): saved SQL queries for the raw console (Webmaster/System is where they're browsed;
 * the console itself is dbms.query-only). The console doesn't otherwise persist anything of its own.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('dbms_saved_queries', (t) => {
    t.increments('id');
    t.string('name', 200).notNullable();
    t.text('sql', 'longtext').notNullable();
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('dbms_saved_queries');
}
