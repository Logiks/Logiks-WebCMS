/**
 * Applications → Plugin Editor (docs/DECISIONS.md D-063): a chat-based session where Claude creates or edits a
 * plugin's files under plugins/<slug>/. The API is stateless, so every turn resends the full history — these two
 * tables are that history, shaped to resend directly as `messages` (role + a JSON content-block array, matching
 * `Anthropic.MessageParam` exactly; a tool result travels as a 'user'-role message in the API's own shape).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('plugin_editor_sessions', (t) => {
    t.increments('id');
    t.string('slug', 191).nullable().unique(); // null until the first successful plugin.json write names one
    t.string('title', 191).notNullable().defaultTo('');
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('plugin_editor_messages', (t) => {
    t.increments('id');
    t.integer('session_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('plugin_editor_sessions')
      .onDelete('CASCADE');
    t.string('role', 16).notNullable(); // 'user' | 'assistant'
    t.text('content', 'longtext').notNullable(); // JSON content-block array
    t.bigInteger('created_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('plugin_editor_messages');
  await knex.schema.dropTableIfExists('plugin_editor_sessions');
}
