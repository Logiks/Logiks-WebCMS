/**
 * Operations → Deploy (D-130): one row per run that pushed this installation's code to a deployment repository. Additive only.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('deploy_runs', (t) => {
    t.increments('id');
    t.string('status', 16).notNullable(); // running | done | failed
    t.string('step', 120).nullable();
    t.text('message').nullable();
    t.string('repo', 300).notNullable(); // credentials removed
    t.string('branch', 100).notNullable();
    t.string('commit', 40).nullable(); // the commit pushed (or the branch tip when nothing changed)
    t.string('dev_commit', 40).nullable(); // the commit this installation's own checkout was on
    t.integer('changed').unsigned().nullable(); // files that differ from the last deploy
    t.text('include').nullable(); // JSON: which themes, plugins and the site tree were added
    t.string('node_id', 64).nullable();
    t.string('host', 190).nullable();
    t.integer('created_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('deploy_runs');
}
