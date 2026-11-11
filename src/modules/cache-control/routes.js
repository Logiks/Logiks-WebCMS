import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const clearBody = z.object({ scope: z.enum(['pages', 'templates', 'everything']) });
const switchBody = z.object({ enabled: z.boolean() });

/** System → Cache (D-136). */
export default function cacheControlRoutes(ctx) {
  const r = Router();
  const { cacheControl } = ctx;

  r.get('/cache', requirePermission('cache.read'), async (_req, res) => {
    res.json(await cacheControl.status());
  });
  r.post(
    '/cache/clear',
    docs({ body: clearBody }),
    requirePermission('cache.clear'),
    async (req, res) => {
      res.json(await cacheControl.clear(parse(clearBody, req.body).scope, actorOf(req)));
    },
  );
  r.put(
    '/cache/enabled',
    docs({ body: switchBody }),
    requirePermission('cache.manage'),
    async (req, res) => {
      res.json(await cacheControl.setEnabled(parse(switchBody, req.body).enabled, actorOf(req)));
    },
  );
  return r;
}
