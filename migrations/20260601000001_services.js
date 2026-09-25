/**
 * Services (docs/SITE-STRUCTURE.md, D-045): admin-defined API endpoints components (and, later, signed-in customers)
 * call for data beyond the content-type API. Two modes stored in one table:
 *   query  a saved, safe view over one registered content type (config: {type, termId?, sort, perPage, fields?})
 *   sql    a read-only SQL SELECT with named :params (config: {sql, params, rowLimit})
 * `enabled` defaults false so a service can be built and previewed before it answers real requests.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('services', (t) => {
    t.increments('id');
    t.string('slug', 191).notNullable().unique();
    t.string('name', 200).notNullable();
    t.text('description').nullable();
    t.string('mode', 16).notNullable(); // 'query' | 'sql'
    t.text('config', 'longtext').notNullable();
    t.string('access', 16).notNullable().defaultTo('public'); // 'public' | 'customer'
    t.text('customer_roles', 'longtext').nullable(); // JSON array; unused until customer accounts (Phase 2)
    t.boolean('enabled').notNullable().defaultTo(false);
    t.integer('created_by').unsigned().nullable();
    t.integer('updated_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('services');
}
