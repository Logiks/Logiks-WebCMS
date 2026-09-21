import { Router } from 'express';
import { requirePermission } from '../../core/http/middleware.js';

export default function clusterRoutes(ctx) {
  const r = Router();
  r.get('/cluster', requirePermission('cluster.read'), async (_req, res) => {
    const cluster = await ctx.nodes.list();
    res.json({
      ...cluster,
      thisNode: {
        id: ctx.env.nodeId,
        role: ctx.env.ROLE,
        configVersion: ctx.settings.version,
        settingsStats: ctx.settings.stats,
      },
      runtime: {
        database: ctx.dialect.kind,
        redis: ctx.redis.enabled,
        bus: ctx.bus.kind,
        sessions: ctx.sessionStore.kind,
        jobs: ctx.jobs.kind,
        environment: ctx.env.NODE_ENV,
      },
    });
  });
  return r;
}
