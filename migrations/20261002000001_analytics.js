/**
 * Activity/analytics (docs/DECISIONS.md D-056): page views, clicks and bounces, page-wise, session-wise and
 * user-wise, for the public site and the admin panel tracked separately (`surface`). `analytics_sessions` is the
 * fast-reporting aggregate (one row per visitor/admin session); `activity_log` is the raw event stream it's built
 * from. Expand-only.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('analytics_sessions', (t) => {
    t.string('token', 64).primary(); // the visitor cookie value (public) or req.sessionID (admin) — not a new identity
    t.string('surface', 16).notNullable().index(); // 'public' | 'admin'
    t.integer('user_id').unsigned().nullable().index(); // always set for admin; null for public until customer accounts
    t.bigInteger('first_seen').notNullable();
    t.bigInteger('last_seen').notNullable().index();
    t.integer('page_count').unsigned().notNullable().defaultTo(0);
    t.string('entry_path', 512).nullable();
    t.string('exit_path', 512).nullable();
    t.string('referrer', 512).nullable();
    t.string('user_agent', 512).nullable();
    t.string('device_type', 16).nullable(); // desktop | mobile | tablet | bot | unknown
    t.boolean('is_bounce').notNullable().defaultTo(true); // flipped false on the second page view
  });

  await knex.schema.createTable('activity_log', (t) => {
    t.bigIncrements('id');
    t.string('session_token', 64).notNullable().index();
    t.string('surface', 16).notNullable().index();
    t.integer('user_id').unsigned().nullable().index();
    t.string('event_type', 24).notNullable().index(); // pageview | click | dwell
    t.string('path', 512).notNullable();
    t.string('label', 191).nullable(); // a click's [data-track] label
    t.string('referrer', 512).nullable();
    t.integer('duration_ms').unsigned().nullable(); // filled in by the exit beacon against the matching pageview
    t.text('meta', 'longtext').nullable(); // JSON
    t.bigInteger('created_at').notNullable().index();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('activity_log');
  await knex.schema.dropTableIfExists('analytics_sessions');
}
