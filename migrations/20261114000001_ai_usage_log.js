/**
 * System → AI Usage: one row per call to any AI provider (Anthropic text models, OpenAI / Google / Stability image
 * generation), so cost and volume can be seen across providers and models. Additive only.
 * Error text is never stored (it can echo request content); `ok` says whether the call worked.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('ai_usage_log', (t) => {
    t.increments('id');
    t.bigInteger('created_at').notNullable();
    t.string('provider', 32).notNullable(); // 'anthropic' | 'openai' | 'google' | 'stability'
    t.string('model', 100).notNullable().defaultTo('');
    t.string('feature', 40).notNullable(); // which part of the CMS asked: 'assistant', 'page-designer', …
    t.integer('user_id').unsigned().nullable();
    t.bigInteger('input_tokens').notNullable().defaultTo(0);
    t.bigInteger('output_tokens').notNullable().defaultTo(0);
    t.bigInteger('cache_read_tokens').notNullable().defaultTo(0);
    t.integer('units').unsigned().notNullable().defaultTo(0); // images generated, for providers that bill per image
    t.boolean('ok').notNullable().defaultTo(true);
    t.index(['created_at']);
    t.index(['provider', 'model']);
    t.index(['feature']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('ai_usage_log');
}
