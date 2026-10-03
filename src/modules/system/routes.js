import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { healthDetails } from '../../core/http/health.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

/** Operational screen: component health, cache and background queue. */
export default function systemRoutes(ctx) {
  const r = Router();
  const moduleView = z.looseObject({
    id: z.string(),
    kind: z.enum(['core', 'plugin']),
    label: z.string(),
    version: z.string(),
    requires: z.array(z.string()),
    enabled: z.boolean(),
    optional: z.boolean(),
    dependents: z.array(z.string()),
    provides: z.looseObject({ services: z.array(z.string()), permissions: z.array(z.string()) }),
  });

  r.get('/system', requirePermission('cluster.read'), async (_req, res) => {
    res.json(await healthDetails(ctx));
  });

  // Everything the platform is made of: the built-in modules (from their manifests, D-067) and installed plugins.
  r.get(
    '/system/modules',
    requirePermission('cluster.read'),
    docs({ response: z.object({ modules: z.array(moduleView) }) }),
    (_req, res) => {
      const listed = ctx.modules.list(ctx).map((m) => ({
        ...m,
        routes: ctx.modules.routesOf(m.id),
      }));
      // Plugins that are installed but not running (off, or missing something they need) are not in the registry; show them too.
      const known = new Set(listed.map((m) => m.id));
      const idle = ctx.plugins
        .list()
        .filter((p) => !known.has(`plugin-${p.slug}`))
        .map((p) => ({
          id: `plugin-${p.slug}`,
          kind: 'plugin',
          label: p.name,
          description: p.loadError || p.description,
          version: p.version,
          requires: p.requires,
          enabled: false,
          optional: false,
          dependents: [],
          provides: { services: [], permissions: p.permissions.map((x) => x.key), api: [] },
          routes: [],
        }));
      res.json({ modules: [...listed, ...idle] });
    },
  );

  // Which optional modules are switched off — the admin menu hides their entries (D-070). Any signed-in admin may ask.
  r.get(
    '/system/modules/state',
    requirePermission('admin.access'),
    docs({ response: z.object({ disabled: z.array(z.string()) }) }),
    (_req, res) => {
      res.json({ disabled: ctx.settings.get('modules.disabled') ?? [] });
    },
  );

  const toggleBody = z.object({ enabled: z.boolean() });
  r.put(
    '/system/modules/:id',
    requirePermission('modules.manage'),
    docs({ body: toggleBody }),
    async (req, res) => {
      const { enabled } = parse(toggleBody, req.body);
      await ctx.modules.setEnabled(req.params.id, enabled, ctx, actorOf(req));
      res.json({ disabled: ctx.settings.get('modules.disabled') ?? [] });
    },
  );

  r.post(
    '/system/cache/flush',
    requirePermission('cache.flush'),
    docs({ noBody: true }),
    async (req, res) => {
      await ctx.cache.flush();
      await ctx.audit.log({ actor: actorOf(req), action: 'cache.flush', entity: 'cache' });
      res.json({ ok: true });
    },
  );

  r.get('/system/jobs/failed', requirePermission('cluster.read'), async (_req, res) => {
    res.json({ jobs: await ctx.jobs.failed(50) });
  });

  r.post(
    '/system/jobs/:id/retry',
    requirePermission('jobs.manage'),
    docs({ noBody: true }),
    async (req, res) => {
      if (!(await ctx.jobs.retry(req.params.id)))
        throw new HttpError(404, 'not_found', 'That job no longer exists.');
      await ctx.audit.log({
        actor: actorOf(req),
        action: 'job.retry',
        entity: 'job',
        entityId: req.params.id,
      });
      res.json({ ok: true });
    },
  );

  r.delete('/system/jobs/:id', requirePermission('jobs.manage'), async (req, res) => {
    if (!(await ctx.jobs.discard(req.params.id)))
      throw new HttpError(404, 'not_found', 'That job no longer exists.');
    await ctx.audit.log({
      actor: actorOf(req),
      action: 'job.discard',
      entity: 'job',
      entityId: req.params.id,
    });
    res.status(204).end();
  });

  return r;
}
