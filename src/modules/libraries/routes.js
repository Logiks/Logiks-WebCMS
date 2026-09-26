import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

/**
 * System → Libraries (D-054). A package name has a slash when it is scoped (@fortawesome/fontawesome-free), so it
 * travels as `?name=` rather than in the path.
 */
export default function librariesRoutes(ctx) {
  const r = Router();
  const { libraries, settings } = ctx;
  const nameOf = (req) => {
    const n = typeof req.query.name === 'string' ? req.query.name : '';
    if (!n)
      throw new HttpError(422, 'invalid_input', 'Say which library: ?name=bootstrap', {
        field: 'name',
      });
    return n;
  };

  r.get('/libraries', requirePermission('libraries.read'), (_req, res) => {
    res.json({
      libraries: libraries.list(),
      allowScripts: settings.get('libraries.allow_scripts'),
      registry: settings.get('libraries.registry_url'),
      maxPackageMb: settings.get('libraries.max_package_mb'),
    });
  });

  r.get('/libraries/export', requirePermission('libraries.read'), (_req, res) => {
    res.set('Content-Disposition', 'attachment; filename="libraries.json"');
    res.json(libraries.exportList());
  });

  r.post('/libraries/import', requirePermission('libraries.manage'), async (req, res) => {
    res.json(await libraries.importList(req.body ?? {}, actorOf(req)));
  });

  r.get('/libraries/search', requirePermission('libraries.manage'), async (req, res) => {
    res.json({ results: await libraries.search(req.query.q) });
  });

  r.get('/libraries/versions', requirePermission('libraries.manage'), async (req, res) => {
    res.json(await libraries.versions(nameOf(req)));
  });

  r.get('/libraries/one', requirePermission('libraries.read'), (req, res) => {
    res.json({ library: libraries.get(nameOf(req)) });
  });

  r.post('/libraries', requirePermission('libraries.manage'), async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().max(191),
        version: z.string().max(64).default('latest'),
        autoload: z.boolean().optional(),
      }),
      req.body,
    );
    res.status(201).json({ library: await libraries.install(body, actorOf(req)) });
  });

  r.put('/libraries/one', requirePermission('libraries.manage'), async (req, res) => {
    res.json({ library: await libraries.update(nameOf(req), req.body ?? {}, actorOf(req)) });
  });

  r.delete('/libraries/one', requirePermission('libraries.manage'), async (req, res) => {
    await libraries.remove(nameOf(req), actorOf(req));
    res.status(204).end();
  });

  return r;
}

/**
 * GET /lib/<name>@<version>/<path>: a file of an installed library, from this server's unpacked copy. Cookie-less and
 * immutable: the URL names the exact version, and a version's bytes are fixed by its integrity hash.
 */
export function libraryPublicRoute(ctx) {
  const r = Router();
  r.get(/^\/lib\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      const [name, version, rel] = [req.params[0], req.params[1], req.params[2]]; // Express has decoded them
      const f = await ctx.libraries.file(name, version, rel);
      if (!f) return next();
      res.sendFile(f.path, {
        dotfiles: 'allow', // the path is one the package lists, checked to be inside its folder
        headers: {
          'Content-Type': f.mime,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          ...(f.mime === 'image/svg+xml'
            ? {
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
              }
            : {}),
        },
      });
    } catch (e) {
      next(e);
    }
  });
  return r;
}
