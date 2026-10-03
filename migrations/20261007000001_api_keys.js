/**
 * API keys for machine clients of the public API (docs/DECISIONS.md D-068). Additive: a new table, nothing else changes.
 * Only a hash of the secret is stored; the key itself is shown once, when it is created or rotated.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('api_keys', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('prefix', 16).notNullable().unique(); // the public part of the key: cms_<prefix>_<secret>
    t.string('hash', 64).notNullable(); // sha-256 of the whole key
    t.text('scopes', 'longtext').notNullable(); // JSON: module ids it may read, or ["*"]
    t.integer('rate_limit').notNullable().defaultTo(600); // requests per minute, for this key
    t.boolean('enabled').notNullable().defaultTo(true);
    t.bigInteger('expires_at').nullable();
    t.bigInteger('last_used_at').nullable();
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('api_keys');
}
