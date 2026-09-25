/**
 * SEO Manager (D-049): per-URL SEO overrides, exact address or wildcard pattern. The list is small enough to load
 * whole and cached under the `seo_rules` tag (same pattern as `redirects` in `src/modules/site/service.js`).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('seo_rules', (t) => {
    t.increments('id');
    t.string('pattern', 500).notNullable().unique(); // '/about' (exact) or '/blog/*' / '/docs/**' (wildcard)
    t.integer('priority').notNullable().defaultTo(0);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('title', 200).nullable();
    t.string('description', 400).nullable();
    t.integer('image').unsigned().nullable(); // media id
    t.string('type', 40).nullable(); // og:type
    t.boolean('noindex').nullable(); // null = inherit, true/false = force
    t.boolean('nofollow').nullable();
    t.string('canonical', 500).nullable();
    t.string('twitter_card', 40).nullable();
    t.text('meta_tags', 'longtext').nullable(); // JSON [{name|property, content}]
    t.text('ld_json', 'longtext').nullable(); // JSON [ {...schema.org object} ], appended to the page's own
    t.integer('created_by').unsigned().nullable();
    t.integer('updated_by').unsigned().nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('seo_rules');
}
