/**
 * Plans the assistant proposes before a big build (docs/DECISIONS.md D-083). The person approves, asks for changes or
 * rejects each one in the chat; until one is approved, the assistant's write tools refuse a build-sized change.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('assistant_plans', (t) => {
    t.increments('id');
    t.integer('session_id').unsigned().notNullable();
    t.text('payload', 'longtext').notNullable(); // the plan, as JSON
    t.string('status', 16).notNullable().defaultTo('pending'); // pending | approved | changes | rejected | superseded
    t.text('note').nullable(); // what the person asked to change
    t.integer('decided_by').unsigned().nullable();
    t.bigInteger('decided_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['session_id', 'id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('assistant_plans');
}
