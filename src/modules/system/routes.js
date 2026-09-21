import { Router } from 'express';
import { HttpError } from '../../core/http/errors.js';
import { healthDetails } from '../../core/http/health.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

/** Operational screen: component health, cache and background queue. */
export default function systemRoutes(ctx) {
  const r = Router();

  r.get('/system', requirePermission('cluster.read'), async (_req, res) => {
    res.json(await healthDetails(ctx));
  });

  r.post('/system/cache/flush', requirePermission('cache.flush'), async (req, res) => {
    await ctx.cache.flush();
    await ctx.audit.log({ actor: actorOf(req), action: 'cache.flush', entity: 'cache' });
    res.json({ ok: true });
  });

  r.get('/system/jobs/failed', requirePermission('cluster.read'), async (_req, res) => {
    res.json({ jobs: await ctx.jobs.failed(50) });
  });

  r.post('/system/jobs/:id/retry', requirePermission('jobs.manage'), async (req, res) => {
    if (!(await ctx.jobs.retry(req.params.id)))
      throw new HttpError(404, 'not_found', 'That job no longer exists.');
    await ctx.audit.log({
      actor: actorOf(req),
      action: 'job.retry',
      entity: 'job',
      entityId: req.params.id,
    });
    res.json({ ok: true });
  });

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
