import { z } from 'zod';
import { Router } from 'express';
import { parse } from '../../core/http/errors.js';
import { requirePermission } from '../../core/http/middleware.js';

/** Webmaster → Events (docs/DECISIONS.md D-050): the log, and firing a test event. */
export default function eventsRoutes(ctx) {
  const r = Router();
  const { events } = ctx;

  r.get('/events', requirePermission('events.read'), async (req, res) => {
    const { limit, before, name } = req.query;
    res.json({ events: await events.list({ limit, before, name }) });
  });

  const fireBody = z.object({
    name: z.string().trim().min(1).max(191),
    payload: z.record(z.string(), z.unknown()).default({}),
  });
  r.post('/events/fire', requirePermission('events.write'), async (req, res) => {
    const { name, payload } = parse(fireBody, req.body);
    await events.emit(name, payload);
    res.status(202).end();
  });

  return r;
}
