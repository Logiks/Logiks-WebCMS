/**
 * System → Libraries (D-054): npm packages installed for the public site (Font Awesome, a slider, a font…). The
 * verified package tarball is stored here, so every server can unpack the exact same bytes into its own local mirror
 * without reaching the registry itself; the list (name, version, integrity, what to load) exports as JSON.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('libraries', (t) => {
    t.increments('id');
    t.string('name', 191).notNullable().unique(); // one version of a package at a time
    t.string('version', 64).notNullable();
    t.string('integrity', 191).notNullable(); // sha512-<base64> as published (verified on install and on unpack)
    t.text('tarball', 'longtext').notNullable(); // base64 of the .tgz
    t.bigInteger('size').notNullable(); // tarball bytes
    t.bigInteger('unpacked_size').notNullable();
    t.text('files', 'longtext').notNullable(); // JSON [[path, size], …]
    t.text('include', 'longtext').notNullable(); // JSON [path, …]: css/js files added to every page when autoload is on
    t.boolean('autoload').notNullable().defaultTo(false);
    t.integer('position').notNullable().defaultTo(0);
    t.string('description', 400).notNullable().defaultTo('');
    t.string('license', 100).notNullable().defaultTo('');
    t.string('homepage', 500).notNullable().defaultTo('');
    t.integer('installed_by').unsigned().nullable();
    t.bigInteger('installed_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('libraries');
}
