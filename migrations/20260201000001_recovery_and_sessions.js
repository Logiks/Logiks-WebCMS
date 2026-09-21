/**
 * Expand-only migration (safe during a rolling deploy):
 *  - password_resets: single-use, hashed, expiring tokens for "forgot password"
 *  - sessions.user_id: lets us list and revoke a user's sessions
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('password_resets', (t) => {
    t.increments('id');
    t.integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique(); // sha256 hex of the emailed token; the token itself is never stored
    t.bigInteger('expires_at').notNullable().index();
    t.bigInteger('used_at').nullable();
    t.string('ip', 64).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['user_id']);
  });

  await knex.schema.alterTable('sessions', (t) => {
    t.integer('user_id').nullable().index();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('sessions', (t) => {
    t.dropColumn('user_id');
  });
  await knex.schema.dropTableIfExists('password_resets');
}
