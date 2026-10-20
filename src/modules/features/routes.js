import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

/** Settings → Features (docs/DECISIONS.md D-100). */
export default function featuresRoutes(ctx) {
  const r = Router();
  const feature = z.looseObject({
    id: z.string(),
    label: z.string(),
    enabled: z.boolean(),
    ready: z.boolean(),
  });
  const body = z.object({ enabled: z.boolean() });

  r.get(
    '/features',
    requirePermission('features.read'),
    docs({ response: z.object({ features: z.array(feature) }) }),
    (_req, res) => {
      res.json({ features: ctx.features.list() });
    },
  );

  // What switching a feature on or off would do, so the screen can say so before asking.
  r.get('/features/:id/plan', requirePermission('features.read'), (req, res) => {
    res.json(ctx.features.plan(req.params.id, req.query.enabled !== 'false'));
  });

  r.put(
    '/features/:id',
    requirePermission('features.manage'),
    docs({ body, response: z.object({ features: z.array(feature) }) }),
    async (req, res) => {
      const { enabled } = parse(body, req.body);
      res.json({ features: await ctx.features.setEnabled(req.params.id, enabled, actorOf(req)) });
    },
  );

  return r;
}
