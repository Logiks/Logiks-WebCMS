/**
 * Automation → Testing (docs/DECISIONS.md D-086): site-wide checks and their stored reports.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('test_runs', (t) => {
    t.increments('id');
    t.string('status', 12).notNullable(); // queued | running | done | failed | cancelled
    t.string('trigger', 12).notNullable().defaultTo('manual'); // manual | schedule
    t.text('config', 'longtext').notNullable();
    t.text('summary', 'longtext').nullable();
    t.text('error').nullable();
    t.integer('units_total').notNullable().defaultTo(0); // pages x viewports
    t.integer('units_done').notNullable().defaultTo(0);
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.bigInteger('updated_at').notNullable(); // heartbeat: a "running" run that stops updating is treated as failed
    t.index(['created_at']);
  });
  await knex.schema.createTable('test_findings', (t) => {
    t.increments('id');
    t.integer('run_id').unsigned().notNullable();
    t.string('path', 191).notNullable();
    t.string('viewport', 12).notNullable(); // mobile | tablet | desktop | site
    t.string('category', 24).notNullable();
    t.string('severity', 8).notNullable(); // error | warn | info
    t.string('rule', 48).notNullable();
    t.text('message').notNullable();
    t.text('detail', 'longtext').nullable();
    t.string('fingerprint', 40).notNullable(); // the same problem in the next run has the same fingerprint
    t.index(['run_id', 'severity']);
    t.index(['run_id', 'path']);
    t.index(['fingerprint']);
  });
  await knex.schema.createTable('test_shots', (t) => {
    t.increments('id');
    t.integer('run_id').unsigned().notNullable();
    t.string('path', 191).notNullable();
    t.string('viewport', 12).notNullable();
    t.text('data', 'longtext').notNullable(); // base64 JPEG
    t.index(['run_id', 'path']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('test_shots');
  await knex.schema.dropTableIfExists('test_findings');
  await knex.schema.dropTableIfExists('test_runs');
}
