import { Router } from 'express';
import { z } from 'zod';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const item = z.object({
  key: z.string(),
  kind: z.string(),
  label: z.string(),
  description: z.string(),
  body: z.string(),
  enabled: z.boolean(),
  builtin: z.boolean(),
  edited: z.boolean(),
  updatedAt: z.number(),
});
const editBody = z.object({
  label: z.string(),
  description: z.string().optional(),
  body: z.string(),
  enabled: z.boolean().optional(),
});
const createBody = editBody.extend({ id: z.string() });

/** System → Prompts: the instructions the AI builders follow, and the project types the site can choose from. */
export default function promptRoutes(ctx) {
  const r = Router();
  const { prompts } = ctx;

  r.get(
    '/prompts',
    requirePermission('prompts.read'),
    docs({ response: z.object({ items: z.array(item), projectType: z.string() }) }),
    async (_req, res) => {
      res.json({
        items: await prompts.list(),
        projectType: ctx.settings.get('general.project_type'),
      });
    },
  );

  // What the builders would be told right now (or for a project type / planning mode being tried), exactly as sent.
  r.get(
    '/prompts/compose',
    requirePermission('prompts.read'),
    docs({
      query: z.object({ projectType: z.string().optional(), planning: z.string().optional() }),
      response: z.object({
        text: z.string(),
        projectType: z.string(),
        planning: z.string(),
        parts: z.array(z.string()),
      }),
    }),
    async (req, res) => {
      res.json(
        await prompts.compose({
          projectType: req.query.projectType ? String(req.query.projectType) : undefined,
          planning: req.query.planning ? String(req.query.planning) : undefined,
        }),
      );
    },
  );

  r.post(
    '/prompts',
    requirePermission('prompts.write'),
    docs({ body: createBody, response: z.object({ item }), status: 201 }),
    async (req, res) => {
      res.status(201).json({ item: await prompts.create(req.body, actorOf(req)) });
    },
  );

  r.put(
    '/prompts/:key',
    requirePermission('prompts.write'),
    docs({ body: editBody, response: z.object({ item }) }),
    async (req, res) => {
      res.json({ item: await prompts.update(req.params.key, req.body, actorOf(req)) });
    },
  );

  r.post(
    '/prompts/:key/reset',
    requirePermission('prompts.write'),
    docs({ noBody: true, response: z.object({ item }) }),
    async (req, res) => {
      res.json({ item: await prompts.reset(req.params.key, actorOf(req)) });
    },
  );

  r.delete('/prompts/:key', requirePermission('prompts.write'), async (req, res) => {
    await prompts.remove(req.params.key, actorOf(req));
    res.status(204).end();
  });

  return r;
}
