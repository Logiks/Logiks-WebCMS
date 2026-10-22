/**
 * Double confirmation for deletions the assistant asks for (docs/DECISIONS.md D-119). The assistant stages a deletion
 * here; only the person, through two separate clicks in the chat, can move it to `confirmed`; the delete tool then
 * consumes it once. Additive.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('assistant_confirmations', (t) => {
    t.increments('id');
    t.integer('session_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('assistant_sessions')
      .onDelete('CASCADE');
    t.string('kind', 16).notNullable(); // table | column | index | row
    t.text('target', 'longtext').notNullable(); // JSON: { table, name?, pk? }
    t.string('summary', 400).notNullable();
    t.string('status', 16).notNullable().defaultTo('pending'); // pending | first | confirmed | cancelled | used
    t.integer('decided_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('decided_at').nullable();
    t.index(['session_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('assistant_confirmations');
}
