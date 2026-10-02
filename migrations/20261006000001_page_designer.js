/**
 * Webmaster → AI Page Designer (docs/DECISIONS.md D-065): a chat session where Claude plans a whole new page,
 * picks or proposes components, generates images, and — with explicit approval — stands up a new table + Service
 * for structured data. Sessions/messages mirror `plugin_editor_sessions`/`plugin_editor_messages` (D-063) exactly:
 * the API is stateless, so every turn resends the full history, and these rows are that history, shaped to resend
 * directly (`{role, content}` matching `Anthropic.MessageParam`).
 *
 * `page_designer_proposals` is new (Plugin Editor has no equivalent, since it writes files immediately — nothing
 * it builds goes live until a separate human "Enable" in Plugin Manager). Here, a new component or a new
 * table+Service is staged as a proposal row and only actually created once the owner approves it from the chat UI
 * — `create_component`/`create_table_and_service` refuse to run otherwise. A proposal is small, structured JSON;
 * it is never the final page body itself (that stays in the conversation + live preview until "Save page").
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('page_designer_sessions', (t) => {
    t.increments('id');
    t.string('path', 191).nullable().unique(); // null until a target page path is chosen (new or existing)
    t.string('title', 191).notNullable().defaultTo('');
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('page_designer_messages', (t) => {
    t.increments('id');
    t.integer('session_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('page_designer_sessions')
      .onDelete('CASCADE');
    t.string('role', 16).notNullable(); // 'user' | 'assistant'
    t.text('content', 'longtext').notNullable(); // JSON content-block array
    t.bigInteger('created_at').notNullable();
  });
  await knex.schema.createTable('page_designer_proposals', (t) => {
    t.increments('id');
    t.integer('session_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('page_designer_sessions')
      .onDelete('CASCADE');
    t.string('kind', 32).notNullable(); // 'component' | 'table_service'
    t.text('payload', 'longtext').notNullable(); // JSON: the staged definition, shape depends on kind
    t.string('status', 16).notNullable().defaultTo('pending'); // 'pending' | 'approved' | 'rejected' | 'created'
    t.integer('decided_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('decided_at').nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('page_designer_proposals');
  await knex.schema.dropTableIfExists('page_designer_messages');
  await knex.schema.dropTableIfExists('page_designer_sessions');
}
