import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Weather Demo — a worked example of a plugin's backend (docs/DECISIONS.md D-060/D-061/D-062):
 *   - mounted by Plugin Manager's dynamic dispatcher at /api/admin/apps/weather-demo/* (src/modules/plugins/routes.js)
 *   - `ctx.require('express')`, not a top-level `import 'express'`: plugins/ isn't guaranteed to sit inside this
 *     app's own node_modules resolution chain, so a bare specifier is resolved through the app's own location instead
 *   - full, unsandboxed Node.js (same trust tier as services.script/dbms.query) — the global `fetch` and `ctx.db`
 *     are both used directly, exactly as any core module would
 *   - the manifest's own `weather_demo.view` permission is enforced here, by convention (a plugin is responsible
 *     for its own route-level checks; Plugin Manager only gates whether the plugin's nav entry appears at all)
 *   - reads its own `config` (plugin.json → the `plugin_weather_demo` settings namespace, D-061) the ordinary way,
 *     `ctx.settings.ns(...)` — nothing plugin-specific to it; Plugin Manager's "Configure" screen (or the generic
 *     Settings screen, since the namespace is registered either way) is where an admin changes these values
 *   - ships a front-end (public-site) component as a real file in its OWN folder, components/current.html, and
 *     a public-site Service it reads, seeded on load (D-062). The component is NOT copied into the site tree: a
 *     page renders it straight from this folder as {% render "plugin/weather-demo/current" %}, so exporting,
 *     copying or uninstalling the plugin takes its front-end with it and nothing is left behind in the site
 *     (the Service is the one thing seeded: Services are data in the database, an admin edits them there)
 * @param {any} ctx the whole platform context
 */
export default async function (ctx) {
  const { Router } = ctx.require('express');
  const r = Router();
  const config = () => ctx.settings.ns('plugin_weather_demo'); // { default_city, units }
  await ensureFrontend(ctx);

  const allowed = (req, res) => {
    if (req.user?.can('weather_demo.view')) return true;
    res.status(403).json({ error: { message: "You don't have permission to use this plugin." } });
    return false;
  };

  /** name → { name, country, latitude, longitude }, via Open-Meteo's free geocoding API (no key needed). */
  async function geocode(city) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('The geocoding service did not answer.');
    const hit = (await res.json()).results?.[0];
    if (!hit) throw new Error(`No place called "${city}" was found.`);
    return hit;
  }

  /** {latitude, longitude} → Open-Meteo's current_weather block. */
  async function currentWeather(latitude, longitude) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('The weather service did not answer.');
    const weather = (await res.json()).current_weather;
    if (!weather) throw new Error('The weather service returned nothing usable.');
    return weather;
  }

  /** Always stored in Celsius (so history stays comparable even if the units config changes later); converted
   * for display only, at response time, from the current `units` config value. */
  const display = (celsius, units) =>
    units === 'fahrenheit'
      ? { temperature: Math.round(((celsius * 9) / 5 + 32) * 10) / 10, unit: '°F' }
      : { temperature: celsius, unit: '°C' };

  // The "demo service" the admin component calls: resolves a city name (or this plugin's own configured default
  // when none is given), fetches its current weather from a real external API, and logs the result to this
  // plugin's own table — then returns it, converted to the configured units, for the UI to show.
  r.get('/weather', async (req, res) => {
    if (!allowed(req, res)) return;
    const { default_city, units } = config();
    const city = String(req.query.city || '').trim() || default_city;
    if (!city) return res.status(422).json({ error: { message: 'Enter a city name.' } });
    try {
      const place = await geocode(city);
      const weather = await currentWeather(place.latitude, place.longitude);
      const row = {
        city: place.name,
        country: place.country || '',
        latitude: place.latitude,
        longitude: place.longitude,
        temperature_c: weather.temperature,
        windspeed_kmh: weather.windspeed,
        looked_up_at: Date.now(),
        looked_up_by: req.user?.email ?? null,
      };
      await ctx.db('plugin_weather_demo_log').insert(row);
      res.json({ result: { ...row, ...display(row.temperature_c, units) } });
    } catch (e) {
      res.status(502).json({ error: { message: e.message } });
    }
  });

  r.get('/recent', async (req, res) => {
    if (!allowed(req, res)) return;
    const { units } = config();
    const rows = await ctx.db('plugin_weather_demo_log').orderBy('looked_up_at', 'desc').limit(10);
    res.json({ recent: rows.map((row) => ({ ...row, ...display(row.temperature_c, units) })) });
  });

  // What the admin screen prefills itself with before the visitor has looked anything up — this plugin's own
  // config, read the same way any core module reads its settings.
  r.get('/defaults', (req, res) => {
    if (!allowed(req, res)) return;
    res.json(config());
  });

  return r;
}

// ───────── front-end (public-site) component (D-062) ─────────

const SERVICE_SLUG = 'weather-demo-latest';
// Where this plugin ships on disk, regardless of where the running process's cwd is or how it was loaded
// (source: 'disk' or materialized from a zip, D-060) — `import.meta.url` always points at THIS file.
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
// No `.can`-checking actor exists for seeded-at-load system actions (unlike an HTTP request, there's no signed-in
// user); `can: () => true` plays the same role a wildcard administrator's permissions already do everywhere else
// in this full-trust tier (services.script, dbms.query) — this plugin is, by construction, as trusted as one.
const systemActor = { id: null, email: null, can: () => true };

// Runs as a Service (Webmaster → Services, script mode) — same `new AsyncFunction('req','ctx', code)` execution
// services.js itself uses, so it gets the full ctx exactly like this plugin's own routes do. Reads the plugin's
// own config and its own log table; never calls the external weather API itself (a public, unauthenticated
// Service re-fetching from a third party on every page view would be a real abuse vector — D-045's own reasoning
// for Services' safety layers applies here too), only the most recent admin-triggered lookup.
const SERVICE_CODE = `
const { units } = ctx.settings.ns('plugin_weather_demo');
const row = await ctx.db('plugin_weather_demo_log').orderBy('looked_up_at', 'desc').first();
if (!row) return { available: false };
const f = units === 'fahrenheit';
return {
  available: true,
  city: row.city,
  country: row.country,
  temperature: f ? Math.round(((row.temperature_c * 9) / 5 + 32) * 10) / 10 : row.temperature_c,
  unit: f ? '\\u00b0F' : '\\u00b0C',
  windspeedKmh: row.windspeed_kmh,
};
`.trim();

/** Idempotent: safe to run on every load() (every enable, and every version-bump hot-reload on every node in a
 * cluster) — each half checks for its own existence first and never touches anything an admin already owns. */
async function ensureFrontend(ctx) {
  try {
    await ctx.services.get(SERVICE_SLUG);
  } catch {
    try {
      await ctx.services.create(
        {
          slug: SERVICE_SLUG,
          name: 'Weather Demo: latest lookup',
          description:
            "Returns the Weather Demo plugin's most recent lookup, for its front-end component (plugin/weather-demo/current).",
          mode: 'script',
          access: 'public',
          enabled: true,
          config: { code: SERVICE_CODE },
        },
        systemActor,
      );
    } catch (e) {
      ctx.log.warn({ err: e.message }, 'weather-demo: could not seed its Service');
    }
  }
  await removeLegacyCopy(ctx);
}

/** Before 1.4.0 this plugin copied its component into the site tree (components/weather-demo/current.html). Now it is
 * rendered from the plugin's own folder, so that old copy is removed — but only if nobody edited it; an edited copy
 * is the admin's own and stays (and keeps working under its old name). */
async function removeLegacyCopy(ctx) {
  const dest = 'components/weather-demo/current.html';
  try {
    const old = ctx.siteFiles.snapshot().files.get(dest);
    if (!old) return;
    const shipped = await readFile(path.join(PLUGIN_DIR, 'components', 'current.html'), 'utf8');
    if (old.content === shipped) await ctx.siteFiles.remove(dest, systemActor);
    else ctx.log.warn({ dest }, 'weather-demo: left an edited copy of its component in the site tree');
  } catch (err) {
    ctx.log.warn({ err: err.message }, 'weather-demo: could not clean up its old component copy');
  }
}
