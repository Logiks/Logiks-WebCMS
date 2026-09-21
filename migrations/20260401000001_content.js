/**
 * Phase 2, M2.1 — content model. Expand-only: new tables, nothing existing is touched.
 *  entries           one row per page/post/…; type-specific fields live in `data` (JSON text)
 *  entry_revisions   a snapshot per save, for history and restore
 *  terms/entry_terms taxonomies (categories, tags)
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('entries', (t) => {
    t.increments('id');
    t.string('type', 64).notNullable();
    t.string('locale', 16).notNullable().defaultTo('en');
    t.string('translation_group', 64).nullable().index();
    t.string('slug', 191).notNullable();
    t.string('path', 191).notNullable(); // slug for flat types, parent path + slug for hierarchical ones
    t.string('title', 255).notNullable();
    t.string('status', 16).notNullable().defaultTo('draft'); // draft | scheduled | published | archived
    t.integer('parent_id').unsigned().nullable().index();
    t.integer('position').notNullable().defaultTo(0);
    t.text('data', 'longtext').notNullable();
    t.integer('author_id').unsigned().nullable().index();
    t.bigInteger('publish_at').nullable();
    t.bigInteger('published_at').nullable();
    t.integer('version').notNullable().defaultTo(1);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['type', 'locale', 'path']);
    t.index(['type', 'status', 'published_at']);
    t.index(['status', 'publish_at']);
  });

  await knex.schema.createTable('entry_revisions', (t) => {
    t.increments('id');
    t.integer('entry_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('entries')
      .onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('title', 255).notNullable();
    t.string('slug', 191).notNullable();
    t.string('status', 16).notNullable();
    t.text('data', 'longtext').notNullable();
    t.integer('saved_by').unsigned().nullable();
    t.string('note', 255).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['entry_id', 'id']);
  });

  await knex.schema.createTable('terms', (t) => {
    t.increments('id');
    t.string('taxonomy', 32).notNullable();
    t.string('slug', 191).notNullable();
    t.string('name', 191).notNullable();
    t.integer('parent_id').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['taxonomy', 'slug']);
  });

  await knex.schema.createTable('entry_terms', (t) => {
    t.integer('entry_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('entries')
      .onDelete('CASCADE');
    t.integer('term_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('terms')
      .onDelete('CASCADE');
    t.primary(['entry_id', 'term_id']);
    t.index(['term_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  for (const t of ['entry_terms', 'terms', 'entry_revisions', 'entries'])
    await knex.schema.dropTableIfExists(t);
}
