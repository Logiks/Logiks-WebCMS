import { Router } from 'express';
import { z } from 'zod';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

/** Webmaster → Webhooks (docs/DECISIONS.md D-050). */
export default function webhooksRoutes(ctx) {
  const r = Router();
  const { webhooks } = ctx;

  r.get(
    '/webhooks',
    requirePermission('webhooks.read'),
    docs({
      response: z.object({
        webhooks: z.array(
          z.looseObject({ id: z.number(), name: z.string(), url: z.string(), event: z.string() }),
        ),
      }),
    }),
    async (_req, res) => {
      res.json({ webhooks: await webhooks.list() });
    },
  );

  r.post(
    '/webhooks',
    requirePermission('webhooks.write'),
    docs({ body: webhooks.schemas.webhook, status: 201 }),
    async (req, res) => {
      res.status(201).json({ webhook: await webhooks.create(req.body ?? {}, actorOf(req)) });
    },
  );

  r.get('/webhooks/:id', requirePermission('webhooks.read'), async (req, res) => {
    res.json({ webhook: await webhooks.get(req.params.id) });
  });

  r.put(
    '/webhooks/:id',
    requirePermission('webhooks.write'),
    docs({ body: webhooks.schemas.webhook }),
    async (req, res) => {
      res.json({ webhook: await webhooks.update(req.params.id, req.body ?? {}, actorOf(req)) });
    },
  );

  r.delete('/webhooks/:id', requirePermission('webhooks.write'), async (req, res) => {
    await webhooks.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  r.get('/webhooks/:id/deliveries', requirePermission('webhooks.read'), async (req, res) => {
    res.json({ deliveries: await webhooks.recentDeliveries(req.params.id) });
  });

  r.post(
    '/webhooks/:id/test',
    requirePermission('webhooks.write'),
    docs({ freeForm: 'Optional payload to send' }),
    async (req, res) => {
      await webhooks.sendTest(req.params.id, actorOf(req));
      res.status(202).end();
    },
  );

  return r;
}
