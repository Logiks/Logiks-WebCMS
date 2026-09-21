import { Router } from 'express';
import { requirePermission } from '../../core/http/middleware.js';

export default function auditRoutes(ctx) {
  const r = Router();
  r.get('/audit', requirePermission('audit.read'), async (req, res) => {
    const { limit, before, action } = req.query;
    res.json({
      entries: await ctx.audit.list({
        limit,
        before,
        action: typeof action === 'string' ? action : undefined,
      }),
    });
  });
  return r;
}
