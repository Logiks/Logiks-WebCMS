import { Router } from 'express';
import { z } from 'zod';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

/** Automation → Scheduler (docs/DECISIONS.md D-051). */
export default function schedulerRoutes(ctx) {
  const r = Router();
  const { scheduler } = ctx;

  r.get(
    '/scheduler/tasks',
    requirePermission('scheduler.read'),
    docs({
      response: z.object({ tasks: z.array(z.looseObject({ id: z.number(), name: z.string() })) }),
    }),
    async (_req, res) => {
      res.json({ tasks: await scheduler.list() });
    },
  );

  r.post(
    '/scheduler/tasks',
    requirePermission('scheduler.write'),
    docs({ body: scheduler.schemas.task, status: 201 }),
    async (req, res) => {
      res.status(201).json({ task: await scheduler.create(req.body ?? {}, actorOf(req)) });
    },
  );

  r.get('/scheduler/cron-preview', requirePermission('scheduler.read'), (req, res) => {
    res.json(scheduler.previewCron(String(req.query.expr ?? '')));
  });

  r.get('/scheduler/tasks/:id', requirePermission('scheduler.read'), async (req, res) => {
    res.json({ task: await scheduler.get(req.params.id) });
  });

  r.put(
    '/scheduler/tasks/:id',
    requirePermission('scheduler.write'),
    docs({ body: scheduler.schemas.task }),
    async (req, res) => {
      res.json({ task: await scheduler.update(req.params.id, req.body ?? {}, actorOf(req)) });
    },
  );

  r.delete('/scheduler/tasks/:id', requirePermission('scheduler.write'), async (req, res) => {
    await scheduler.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  r.post(
    '/scheduler/tasks/:id/run',
    requirePermission('scheduler.write'),
    docs({ noBody: true }),
    async (req, res) => {
      await scheduler.runNow(req.params.id, actorOf(req));
      res.status(202).end();
    },
  );

  return r;
}
