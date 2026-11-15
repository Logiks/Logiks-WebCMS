/**
 * AI governance (D-146): what the gateway measures about every call. All additive and defaulted, so existing rows
 * read as "a successful, usable, cloud call" and old code keeps writing rows that way.
 * `cost_micro` is millionths of a US dollar, an integer, so sums stay exact on every engine.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('ai_usage_log', (t) => {
    t.boolean('is_local').notNullable().defaultTo(false);
    t.bigInteger('cost_micro').notNullable().defaultTo(0);
    t.boolean('usable').notNullable().defaultTo(true);
    t.boolean('truncated').notNullable().defaultTo(false);
    t.integer('latency_ms').notNullable().defaultTo(0);
    t.string('profile', 60).nullable();
    t.smallint('feedback').nullable(); // 1 = thumbs up, -1 = thumbs down, null = not rated
    t.index(['is_local', 'created_at']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('ai_usage_log', (t) => {
    t.dropIndex(['is_local', 'created_at']);
    for (const c of [
      'feedback',
      'profile',
      'latency_ms',
      'truncated',
      'usable',
      'cost_micro',
      'is_local',
    ])
      t.dropColumn(c);
  });
}
