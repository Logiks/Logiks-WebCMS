import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

/** SEO Manager (docs/DECISIONS.md D-049): per-URL SEO override rules. */
export default function seoRoutes(ctx) {
  const r = Router();
  const { seo } = ctx;
  const rule = z.looseObject({
    id: z.number(),
    pattern: z.string(),
    priority: z.number(),
    enabled: z.boolean(),
  });

  r.get(
    '/seo/rules',
    requirePermission('seo.read'),
    docs({ response: z.object({ rules: z.array(rule) }) }),
    async (_req, res) => {
      res.json({ rules: await seo.list() });
    },
  );

  r.post(
    '/seo/rules',
    requirePermission('seo.write'),
    docs({ body: seo.schemas.rule, response: z.object({ rule }), status: 201 }),
    async (req, res) => {
      res.status(201).json({ rule: await seo.create(req.body ?? {}, actorOf(req)) });
    },
  );

  // Suggestions for the rule editor's form. Nothing is saved: the person reviews the fields and saves the rule.
  const suggestBody = z.object({
    pattern: z.string().trim().min(1).max(500),
    hint: z.string().trim().max(1000).optional(),
  });
  r.post(
    '/seo/suggest',
    requirePermission('seo.write'),
    docs({ body: suggestBody }),
    async (req, res) => {
      res.json(await ctx.aiSeoWriter.suggest(parse(suggestBody, req.body)));
    },
  );

  r.get('/seo/rules/:id', requirePermission('seo.read'), async (req, res) => {
    res.json({ rule: await seo.get(req.params.id) });
  });

  r.put(
    '/seo/rules/:id',
    requirePermission('seo.write'),
    docs({ body: seo.schemas.rule, response: z.object({ rule }) }),
    async (req, res) => {
      res.json({ rule: await seo.update(req.params.id, req.body ?? {}, actorOf(req)) });
    },
  );

  r.delete('/seo/rules/:id', requirePermission('seo.write'), async (req, res) => {
    await seo.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  return r;
}
