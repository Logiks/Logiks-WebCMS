import { z } from 'zod';
import { Router } from 'express';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

/** Webmaster → Events (docs/DECISIONS.md D-050): the log, and firing a test event. */
export default function eventsRoutes(ctx) {
  const r = Router();
  const { events, audit } = ctx;

  r.get(
    '/events',
    requirePermission('events.read'),
    docs({
      response: z.object({
        events: z.array(z.looseObject({ id: z.number(), name: z.string(), payload: z.unknown() })),
      }),
    }),
    async (req, res) => {
      const { limit, before, name } = req.query;
      res.json({ events: await events.list({ limit, before, name }) });
    },
  );

  const fireBody = z.object({
    name: z.string().trim().min(1).max(191),
    payload: z.record(z.string(), z.unknown()).default({}),
  });
  r.post(
    '/events/fire',
    requirePermission('events.write'),
    docs({ body: fireBody }),
    async (req, res) => {
      const { name, payload } = parse(fireBody, req.body);
      await events.emit(name, payload);
      // Can trigger real webhooks with real side effects at the receiving end (D-050), so it's audited like
      // webhooks.sendTest's 'webhook.test_sent' rather than treated as a harmless read.
      await audit.log({
        actor: actorOf(req),
        action: 'events.fired',
        entity: 'event',
        entityId: name,
      });
      res.status(202).end();
    },
  );

  return r;
}
