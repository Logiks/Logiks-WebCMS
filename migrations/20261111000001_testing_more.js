/**
 * AI Testing, second part (docs/DECISIONS.md D-087): saved journeys, visual-regression baselines and cluster probes.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('test_journeys', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.text('steps', 'longtext').notNullable(); // the steps as the person wrote them, one per line
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('test_baselines', (t) => {
    t.increments('id');
    t.string('path', 191).notNullable();
    t.string('viewport', 12).notNullable();
    t.text('data', 'longtext').notNullable(); // base64 JPEG: how the page looked when it was last accepted
    t.bigInteger('updated_at').notNullable();
    t.unique(['path', 'viewport']);
  });
  await knex.schema.createTable('test_node_probes', (t) => {
    t.increments('id');
    t.integer('run_id').unsigned().notNullable();
    t.string('node_id', 64).notNullable();
    t.string('path', 191).notNullable();
    t.integer('status').notNullable();
    t.string('hash', 40).notNullable(); // of the page's HTML with per-request values removed
    t.integer('ms').notNullable();
    t.index(['run_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('test_node_probes');
  await knex.schema.dropTableIfExists('test_baselines');
  await knex.schema.dropTableIfExists('test_journeys');
}
