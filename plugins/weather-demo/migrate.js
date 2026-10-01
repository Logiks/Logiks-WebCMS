/**
 * Weather Demo's own table (docs/DECISIONS.md D-060: a plugin's schema changes run through its own migrate.js,
 * tracked in `plugin_migrations`, separate from the core `knex_migrations`). Named `plugin_weather_demo_*` by
 * convention, so it reads unambiguously as this plugin's own data if it's ever uninstalled and the table is
 * dropped by hand.
 * @param {import('knex').Knex} db
 */
export default async function (db) {
  await db.schema.createTable('plugin_weather_demo_log', (t) => {
    t.increments('id');
    t.string('city', 120).notNullable();
    t.string('country', 120).notNullable().defaultTo('');
    t.double('latitude').notNullable();
    t.double('longitude').notNullable();
    t.double('temperature_c').notNullable();
    t.double('windspeed_kmh').notNullable();
    t.bigInteger('looked_up_at').notNullable(); // epoch-ms, same convention as the core schema
    t.string('looked_up_by', 191).nullable();
  });
}
