/**
 * Release notes of deployments (docs/DECISIONS.md D-138): the notes dev wrote for each deploy, kept on the server that pulled
 * them (and on dev itself) so they can be read later, with the optional steps ticked off as they are done.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('deploy_releases', (t) => {
    t.increments('id');
    t.string('uid', 64).notNullable().unique(); // "<seq>-<random>", written by the deploy; the same note is never stored twice
    t.integer('seq').notNullable();
    t.string('title', 200).notNullable();
    t.string('source', 8).notNullable().defaultTo('deploy'); // dev (made here) | deploy (arrived with an update)
    t.text('body', 'longtext').notNullable(); // the release (JSON)
    t.text('done', 'longtext').nullable(); // ids of the steps ticked off (JSON)
    t.text('result', 'longtext').nullable(); // what bringing it in did on this server (JSON)
    t.bigInteger('created_at').notNullable();
    t.bigInteger('received_at').notNullable();
    t.bigInteger('read_at').nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('deploy_releases');
}
