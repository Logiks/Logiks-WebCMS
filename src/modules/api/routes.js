import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';
import { adminCoverage, adminSpec, publicSpec } from '../../core/api/openapi.js';

/** System → API: the reference for the public API, the admin route list, and API keys (D-068). */
export default function apiRoutes(ctx) {
  const r = Router();
  const { apiKeys, modules } = ctx;
  const idParam = z.object({ id: z.coerce.number().int().positive() });
  const keyView = z.object({
    id: z.number(),
    name: z.string(),
    prefix: z.string(),
    hint: z.string(),
    scopes: z.array(z.string()),
    rateLimit: z.number(),
    enabled: z.boolean(),
    expired: z.boolean(),
    expiresAt: z.number().nullable(),
    lastUsedAt: z.number().nullable(),
    createdAt: z.number(),
  });
  // A new or rotated key: the secret is in the answer once and nowhere else.
  const withSecret = z.object({ key: keyView, secret: z.string() });

  const publicDoc = () =>
    publicSpec({
      operations: modules.operations(),
      version: ctx.version,
      title: `${ctx.settings.get('general.site_name') || 'Site'} public API`,
    });

  r.get('/api-reference', requirePermission('api.read'), (_req, res) => {
    res.json({
      enabled: ctx.settings.get('features.public_api'),
      prefix: '/api/v1',
      adminCoverage: adminCoverage({ routesOf: (id) => modules.routesOf(id), ids: modules.ids() }),
      legacyPrefix: '/api/public',
      operations: modules.operations().map((o) => ({
        id: o.id,
        module: o.module,
        method: o.method,
        path: o.path,
        summary: o.summary,
        query: o.query,
        body: o.body,
        anonymous: o.anonymous,
        returns: o.returns,
        cacheable: o.cacheable,
        available: modules.isEnabled(o.module, ctx) && (!o.flag || ctx.settings.get(o.flag)),
      })),
      writable: [
        ...new Set(
          modules
            .operations()
            .filter((o) => o.method !== 'GET' && !o.anonymous)
            .map((o) => o.module),
        ),
      ].map((id) => ({ id, label: modules.get(id).label })),
      readable: [
        ...new Set(
          modules
            .operations()
            .filter((o) => o.method === 'GET')
            .map((o) => o.module),
        ),
      ].map((id) => ({
        id,
        label: modules.get(id).label,
      })),
    });
  });

  r.get('/api-reference/openapi.json', requirePermission('api.read'), (req, res) => {
    res.json(req.query.surface === 'admin' ? adminDoc() : publicDoc());
  });
  const adminDoc = () =>
    adminSpec({
      modules: modules.ids().map((id) => ({ id, label: modules.get(id).label })),
      routesOf: (id) => modules.routesOf(id),
      version: ctx.version,
    });

  r.get(
    '/api-keys',
    requirePermission('api.read'),
    docs({ response: z.object({ keys: z.array(keyView) }) }),
    async (_req, res) => {
      res.json({ keys: await apiKeys.list() });
    },
  );

  r.post(
    '/api-keys',
    requirePermission('api.keys.manage'),
    docs({ body: apiKeys.schemas.key, response: withSecret, status: 201 }),
    async (req, res) => {
      res.status(201).json(await apiKeys.create(req.body, actorOf(req)));
    },
  );

  r.put(
    '/api-keys/:id',
    requirePermission('api.keys.manage'),
    docs({ params: idParam, body: apiKeys.schemas.key, response: z.object({ key: keyView }) }),
    async (req, res) => {
      const { id } = parse(idParam, req.params);
      res.json({ key: await apiKeys.update(id, req.body, actorOf(req)) });
    },
  );

  r.post(
    '/api-keys/:id/rotate',
    requirePermission('api.keys.manage'),
    docs({ params: idParam, noBody: true, response: withSecret }),
    async (req, res) => {
      const { id } = parse(idParam, req.params);
      res.json(await apiKeys.rotate(id, actorOf(req)));
    },
  );

  r.delete(
    '/api-keys/:id',
    requirePermission('api.keys.manage'),
    docs({ params: idParam }),
    async (req, res) => {
      const { id } = parse(idParam, req.params);
      await apiKeys.remove(id, actorOf(req));
      res.status(204).end();
    },
  );

  return r;
}
