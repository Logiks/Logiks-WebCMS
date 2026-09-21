/**
 * Phase 1 core schema. Portable across SQLite / MySQL / PostgreSQL:
 *  - timestamps are epoch-milliseconds in BIGINT (UTC, no timezone ambiguity)
 *  - JSON is stored as TEXT and parsed in the app
 *  - indexed strings stay <= 191 chars (utf8mb4 index limit on older MySQL)
 * Migrations are expand/contract: only additive changes ship with a release that
 * still runs against the previous schema; destructive steps ship one release later.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('config_meta', (t) => {
    t.integer('id').primary();
    t.bigInteger('config_version').notNullable().defaultTo(0);
  });
  await knex('config_meta').insert({ id: 1, config_version: 0 });

  await knex.schema.createTable('settings', (t) => {
    t.increments('id');
    t.string('namespace', 64).notNullable();
    t.string('name', 128).notNullable();
    t.text('value', 'longtext').nullable();
    t.boolean('is_secret').notNullable().defaultTo(false);
    t.string('key_id', 16).nullable();
    t.integer('version').notNullable().defaultTo(1);
    t.integer('updated_by').nullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['namespace', 'name']);
  });

  await knex.schema.createTable('settings_revisions', (t) => {
    t.bigIncrements('id');
    t.string('namespace', 64).notNullable();
    t.string('name', 128).notNullable();
    t.text('old_value', 'longtext').nullable();
    t.text('new_value', 'longtext').nullable();
    t.boolean('is_secret').notNullable().defaultTo(false);
    t.integer('version').notNullable();
    t.integer('changed_by').nullable();
    t.bigInteger('changed_at').notNullable();
    t.index(['namespace', 'name']);
    t.index(['changed_at']);
  });

  await knex.schema.createTable('roles', (t) => {
    t.increments('id');
    t.string('name', 64).notNullable().unique();
    t.string('description', 255).nullable();
    t.boolean('is_system').notNullable().defaultTo(false);
    t.text('permissions').notNullable(); // JSON array of permission strings
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('email', 191).notNullable().unique(); // stored lower-cased
    t.string('name', 128).notNullable();
    t.string('password_hash', 255).notNullable();
    t.integer('role_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('roles')
      .onDelete('RESTRICT');
    t.string('status', 16).notNullable().defaultTo('active'); // active | disabled
    t.integer('failed_attempts').notNullable().defaultTo(0);
    t.bigInteger('locked_until').nullable();
    t.bigInteger('last_login_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('sessions', (t) => {
    t.string('sid', 128).primary();
    t.text('sess', 'longtext').notNullable();
    t.bigInteger('expires_at').notNullable().index();
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id');
    t.integer('actor_id').nullable();
    t.string('actor_email', 191).nullable();
    t.string('action', 96).notNullable();
    t.string('entity', 64).nullable();
    t.string('entity_id', 64).nullable();
    t.text('meta', 'longtext').nullable();
    t.string('ip', 64).nullable();
    t.bigInteger('created_at').notNullable().index();
    t.index(['entity', 'entity_id']);
    t.index(['action']);
  });

  await knex.schema.createTable('cluster_nodes', (t) => {
    t.string('node_id', 128).primary();
    t.string('role', 16).notNullable();
    t.string('host', 191).notNullable();
    t.integer('pid').notNullable();
    t.string('app_version', 32).notNullable();
    t.bigInteger('started_at').notNullable();
    t.bigInteger('last_seen').notNullable().index();
    t.bigInteger('config_version').notNullable().defaultTo(0);
    t.boolean('draining').notNullable().defaultTo(false);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  for (const t of [
    'cluster_nodes',
    'audit_logs',
    'sessions',
    'users',
    'roles',
    'settings_revisions',
    'settings',
    'config_meta',
  ]) {
    await knex.schema.dropTableIfExists(t);
  }
}
