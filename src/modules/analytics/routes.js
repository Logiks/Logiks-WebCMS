import { z } from 'zod';
import { Router } from 'express';
import { parse } from '../../core/http/errors.js';
import { requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

const rangeQuery = (req) => ({
  from: typeof req.query.from === 'string' ? req.query.from : undefined,
  to: typeof req.query.to === 'string' ? req.query.to : undefined,
  surface:
    req.query.surface === 'admin' || req.query.surface === 'public' ? req.query.surface : undefined,
});

const beaconBody = z.object({
  type: z.enum(['pageview']),
  path: z.string().min(1).max(512),
});

/** Automation → Analytics (D-056): reporting screens, plus the admin (backend) screen-view beacon. */
export default function analyticsRoutes(ctx) {
  const r = Router();
  const { analytics, jobs } = ctx;

  r.get('/analytics/overview', requirePermission('analytics.read'), async (req, res) => {
    res.json(await analytics.overview(rangeQuery(req)));
  });

  r.get('/analytics/pages', requirePermission('analytics.read'), async (req, res) => {
    res.json({ pages: await analytics.pagesReport(rangeQuery(req)) });
  });

  r.get('/analytics/trend', requirePermission('analytics.read'), async (req, res) => {
    res.json({ trend: await analytics.dailyTrend(rangeQuery(req)) });
  });

  r.get('/analytics/devices', requirePermission('analytics.read'), async (req, res) => {
    res.json({ devices: await analytics.deviceBreakdown(rangeQuery(req)) });
  });

  r.get('/analytics/referrers', requirePermission('analytics.read'), async (req, res) => {
    res.json(await analytics.referrersReport(rangeQuery(req)));
  });

  r.get('/analytics/active', requirePermission('analytics.read'), async (req, res) => {
    const { surface } = rangeQuery(req);
    let windowMs = Number(req.query.windowMs);
    windowMs =
      Number.isFinite(windowMs) && windowMs > 0
        ? Math.min(Math.max(windowMs, 30_000), 60 * 60_000) // clamp 30s..60min — a live snapshot, not a report range
        : undefined;
    res.json(await analytics.activeReport({ surface, windowMs }));
  });

  r.get('/analytics/sessions', requirePermission('analytics.read'), async (req, res) => {
    const { limit, before } = req.query;
    res.json({ sessions: await analytics.sessionsReport({ ...rangeQuery(req), limit, before }) });
  });

  r.get('/analytics/users', requirePermission('analytics.read'), async (req, res) => {
    res.json({ users: await analytics.usersReport(rangeQuery(req)) });
  });

  // Any signed-in admin (gated by admin.access already, app.js) can be tracked — reading analytics is a
  // separate, stronger permission (analytics.read) than merely appearing in it.
  r.post('/analytics/beacon', docs({ body: beaconBody }), async (req, res) => {
    const { type, path } = parse(beaconBody, req.body);
    if (ctx.settings.get('analytics.enabled'))
      await jobs
        .enqueue('analytics.record', {
          type,
          surface: 'admin',
          sessionToken: req.sessionID,
          userId: req.user?.id ?? null,
          path,
        })
        .catch(() => {});
    res.status(202).end();
  });

  return r;
}
