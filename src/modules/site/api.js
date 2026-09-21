import { Router } from 'express';
import { HttpError } from '../../core/http/errors.js';

/**
 * Read-only public content API (/api/public/…), for headless front-ends and integrations. It is off until "Public content
 * API" is switched on under Settings → Features. It only ever returns published content, needs no sign-in, sets no cookies,
 * and answers CORS from the origins listed in Settings → Security. Responses are cached and refreshed by the same tags as pages.
 *
 * The answers come from the same data layer (data.js) that the site's own components read in-process, so a headless client
 * and a page always see the same thing. This file is only the HTTP wrapper: the switch, the cache headers, the routes.
 */
export default function publicContentApi(ctx) {
  const r = Router();
  const { settings } = ctx;

  r.use(['/content', '/menus', '/search', '/terms'], (_req, _res, next) =>
    settings.get('features.public_api')
      ? next()
      : next(new HttpError(404, 'not_found', 'The public content API is turned off.')),
  );

  const ttl = () => settings.get('site.page_cache_seconds');

  r.get('/*path', async (req, res, next) => {
    try {
      const out = await ctx.publicData.get(`/api/public${req.url}`);
      res.set(
        'Cache-Control',
        out.cacheable === false || ttl() <= 0
          ? 'no-store'
          : `public, max-age=30, s-maxage=${ttl()}, stale-while-revalidate=30`,
      );
      res.json(out.body);
    } catch (e) {
      next(e);
    }
  });

  return r;
}
