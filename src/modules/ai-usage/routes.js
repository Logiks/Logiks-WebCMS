import { Router } from 'express';
import { requirePermission } from '../../core/http/middleware.js';

const dates = (req) => ({
  from: typeof req.query.from === 'string' ? req.query.from : undefined,
  to: typeof req.query.to === 'string' ? req.query.to : undefined,
  kind: req.query.kind === 'text' || req.query.kind === 'media' ? req.query.kind : undefined,
});

/** System → AI Usage: read-only reporting over the AI call log. */
export default function aiUsageRoutes(ctx) {
  const r = Router();
  const { aiUsage } = ctx;

  r.get('/ai-usage/summary', requirePermission('aiusage.read'), async (req, res) => {
    res.json(await aiUsage.summary(dates(req)));
  });

  r.get('/ai-usage/recent', requirePermission('aiusage.read'), async (req, res) => {
    const { limit, before } = req.query;
    const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    res.json({ calls: await aiUsage.recent({ ...dates(req), provider, limit, before }) });
  });

  return r;
}
