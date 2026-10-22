/**
 * AI Usage → messages: remember which person message a call answered, so token use can be shown per message.
 * `prompt` is a short excerpt (never the whole chat); `turn_key` ties together every call one message caused
 * (a tool loop makes several). Additive and nullable: old rows simply have no message.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('ai_usage_log', (t) => {
    t.text('prompt').nullable();
    t.string('turn_key', 64).nullable();
    t.index(['turn_key']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('ai_usage_log', (t) => {
    t.dropIndex(['turn_key']);
    t.dropColumn('turn_key');
    t.dropColumn('prompt');
  });
}
