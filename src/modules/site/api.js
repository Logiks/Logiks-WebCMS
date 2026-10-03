import { Router } from 'express';
import { HttpError } from '../../core/http/errors.js';
import { envelope } from '../../core/api/envelope.js';
import { publicSpec } from '../../core/api/openapi.js';

/**
 * The public API over HTTP (D-068), on two addresses that share every handler:
 *   /api/v1/…      the versioned surface: every success is `{ data, meta }`, and /api/v1/openapi.json describes it
 *   /api/public/…  the original address, raw bodies as before (kept so existing clients and components keep working)
 *
 * Who may call: anyone while "Public content API" is on (Settings → Features); a valid API key always, whatever that
 * switch says, but only for the modules the key is scoped to. Everything is read-only and published-only.
 *
 * The answers come from the same data layer (data.js) that the site's own components read in-process, so a headless
 * client and a page always see the same thing. This file is only the HTTP wrapper: access, cache headers, envelope.
 * @param {any} ctx @param {{v1?: boolean}} [o]
 */
export default function publicContentApi(ctx, { v1 = false } = {}) {
  const r = Router();
  const { settings } = ctx;
  const ttl = () => settings.get('site.page_cache_seconds');

  if (v1)
    r.get('/openapi.json', (_req, res) => {
      res.set('Cache-Control', 'public, max-age=60');
      res.json(
        publicSpec({
          operations: ctx.modules.operations(),
          version: ctx.version,
          title: `${settings.get('general.site_name') || 'Site'} public API`,
        }),
      );
    });

  // A bad key is refused here, AFTER the address limiter has counted the attempt (see apiKeyAuth).
  r.use((req, _res, next) =>
    req.badApiKey
      ? next(
          new HttpError(
            401,
            'invalid_api_key',
            'That API key is invalid, disabled or expired. Create a new one under System → API.',
          ),
        )
      : next(),
  );
  r.use(ctx.limiters.apiKey);
  // A Service can be expensive (a SQL query), so it gets its own budget on top of the general API limit.
  r.use('/services', ctx.limiters.services);

  /** @param {any} req @param {{id: string, module: string, method: string, anonymous?: boolean}} op */
  const allowed = (req, op) => {
    const write = op.method !== 'GET';
    if (req.apiKey) {
      const { scopes } = req.apiKey;
      // "*" is read-everything only: writing is always named, module by module ("content:write").
      const ok = write
        ? scopes.includes(`${op.module}:write`)
        : scopes.includes('*') || scopes.includes(op.module);
      if (!ok)
        throw new HttpError(
          403,
          'api_key_scope',
          write
            ? `This API key can't write to the "${op.module}" module. Add "${op.module}:write" to the key's scopes under System → API.`
            : `This API key can't read the "${op.module}" module. Add it to the key's scopes under System → API.`,
        );
    } else if (write && !(op.anonymous && settings.get('features.public_api'))) {
      throw new HttpError(
        401,
        'api_key_required',
        'This needs an API key with write access. Create one under System → API and send it as "Authorization: Bearer …".',
      );
    } else if (!settings.get('features.public_api')) {
      throw new HttpError(404, 'not_found', 'The public content API is turned off.');
    }
  };

  r.get('/*path', async (req, res, next) => {
    try {
      const full = `${req.baseUrl}${req.url}`;
      const hit = ctx.publicData.resolve(full);
      if (hit) allowed(req, hit.op);
      const out = await ctx.publicData.get(full);
      // An answer a key was needed for must not be kept by a shared cache and handed to someone without one.
      res.set('Vary', 'Authorization, X-API-Key');
      res.set(
        'Cache-Control',
        req.apiKey
          ? 'private, no-store'
          : out.cacheable === false || ttl() <= 0
            ? 'no-store'
            : `public, max-age=30, s-maxage=${ttl()}, stale-while-revalidate=30`,
      );
      res.json(v1 ? envelope(out.body) : out.body);
    } catch (e) {
      next(e);
    }
  });

  // Writes exist only on /api/v1 (the older /api/public address stays read-only). The caller is a key (or, for the
  // contact form, anyone while the public API is on); there are no cookies here, so there is nothing for CSRF to protect.
  if (v1) {
    // The contact form is open to anyone, so it has its own per-address budget on top of the general one.
    r.post('/contact', ctx.limiters.contactApi);
    /** @param {'POST'|'PUT'} method */
    const write =
      (method) =>
      async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
        try {
          const full = `${req.baseUrl}${req.url}`;
          const hit = ctx.publicData.resolve(full, method);
          if (!hit) throw new HttpError(404, 'not_found', 'There is no such operation.');
          allowed(req, hit.op);
          const out = await ctx.publicData.write(method, full, {
            body: req.body,
            apiKey: req.apiKey,
            ip: req.ip,
          });
          res.set('Cache-Control', 'no-store');
          res.status(out.status).json(envelope(out.body));
        } catch (e) {
          next(e);
        }
      };
    r.post('/*path', write('POST'));
    r.put('/*path', write('PUT'));
  }

  return r;
}
