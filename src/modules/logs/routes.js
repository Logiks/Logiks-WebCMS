import { z } from 'zod';
import { Router } from 'express';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

const days = z.object({ days: z.number().int().min(0).max(3650) });

/** Automation → Log Manager: administrators only. */
export default function logRoutes(ctx) {
  const r = Router();
  const { logManager } = ctx;
  const need = requirePermission('logs.manage');

  r.get('/logs', need, async (_req, res) => {
    res.json({ logs: await logManager.sources() });
  });
  r.get('/logs/:id', need, async (req, res) => {
    const { limit, before } = req.query;
    res.json({ rows: await logManager.view(req.params.id, { limit, before }) });
  });
  r.put('/logs/:id/retention', need, docs({ body: days }), async (req, res) => {
    res.json({
      logs: await logManager.setRetention(req.params.id, parse(days, req.body).days, actorOf(req)),
    });
  });
  r.post('/logs/:id/prune', need, docs({ body: days }), async (req, res) => {
    res.json(await logManager.prune(req.params.id, parse(days, req.body).days, actorOf(req)));
  });
  return r;
}
