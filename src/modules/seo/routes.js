import { Router } from 'express';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

/** SEO Manager (docs/DECISIONS.md D-049): per-URL SEO override rules. */
export default function seoRoutes(ctx) {
  const r = Router();
  const { seo } = ctx;

  r.get('/seo/rules', requirePermission('seo.read'), async (_req, res) => {
    res.json({ rules: await seo.list() });
  });

  r.post('/seo/rules', requirePermission('seo.write'), async (req, res) => {
    res.status(201).json({ rule: await seo.create(req.body ?? {}, actorOf(req)) });
  });

  r.get('/seo/rules/:id', requirePermission('seo.read'), async (req, res) => {
    res.json({ rule: await seo.get(req.params.id) });
  });

  r.put('/seo/rules/:id', requirePermission('seo.write'), async (req, res) => {
    res.json({ rule: await seo.update(req.params.id, req.body ?? {}, actorOf(req)) });
  });

  r.delete('/seo/rules/:id', requirePermission('seo.write'), async (req, res) => {
    await seo.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  return r;
}
