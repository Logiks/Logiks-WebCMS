/**
 * System → Log Manager → Server errors: one row per server-side failure (an unhandled request error, a failed job,
 * an unhandled rejection), grouped later by `fingerprint` to show which errors keep coming back.
 * Also adds `context` to the AI usage log: the full message a person sent (`prompt` stays a 500-character excerpt),
 * so the usage export can carry everything. Both additive; old rows simply have no context.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('error_log', (t) => {
    t.increments('id');
    t.bigInteger('created_at').notNullable();
    t.string('fingerprint', 40).notNullable(); // same fingerprint = same kind of error
    t.string('source', 16).notNullable(); // 'http' | 'job' | 'process'
    t.integer('status').nullable();
    t.string('code', 64).nullable();
    t.string('name', 64).nullable(); // error class, e.g. TypeError
    t.text('message').notNullable();
    t.text('stack', 'longtext').nullable();
    t.string('method', 10).nullable();
    t.string('path', 191).nullable(); // no query string
    t.string('job', 100).nullable();
    t.integer('user_id').unsigned().nullable();
    t.index(['created_at']);
    t.index(['fingerprint']);
  });
  await knex.schema.alterTable('ai_usage_log', (t) => {
    t.text('context', 'longtext').nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('ai_usage_log', (t) => t.dropColumn('context'));
  await knex.schema.dropTableIfExists('error_log');
}
