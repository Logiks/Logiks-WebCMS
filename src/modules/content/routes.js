import { Router } from 'express';
import { z } from 'zod';
import { forbidden, parse } from '../../core/http/errors.js';
import { actorOf } from '../../core/http/middleware.js';

const entryBody = z.object({
  title: z.string().optional(),
  slug: z.string().nullable().optional(),
  status: z.string().optional(),
  parentId: z.number().int().nullable().optional(),
  position: z.number().int().optional(),
  data: z.record(z.string(), z.any()).optional(),
  termIds: z.array(z.number().int()).optional(),
  publishAt: z.number().int().nullable().optional(),
  version: z.number().int().optional(),
  locale: z.string().optional(),
  translationOf: z.number().int().optional(),
  note: z.string().max(255).optional(),
});
const termBody = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  parentId: z.number().int().nullable().optional(),
});

/**
 * Content admin API. Which type a person may touch is decided per type inside the service
 * (content.<type>.read / write / others / publish / delete); this guard only asks "can they use content at all".
 */
export default function contentRoutes(ctx) {
  const r = Router();
  const { content } = ctx;
  const usesContent = (req, _res, next) =>
    req.user && content.registry.types().some((t) => req.user.can(`content.${t.id}.read`))
      ? next()
      : next(forbidden());

  r.use('/content', usesContent);

  r.get('/content/types', (req, res) => {
    res.json({
      types: content.registry
        .types()
        .filter((t) => req.user.can(`content.${t.id}.read`))
        .map((t) => ({
          ...content.registry.describe(t.id),
          can: Object.fromEntries(
            ['write', 'others', 'publish', 'delete'].map((a) => [
              a,
              req.user.can(`content.${t.id}.${a}`),
            ]),
          ),
        })),
      multilingual: ctx.settings.get('features.multilingual'),
      locales: [
        ctx.settings.get('general.default_locale'),
        ...ctx.settings.get('content.locales'),
      ].filter((v, i, a) => a.indexOf(v) === i),
      canManageTerms: req.user.can('content.terms.manage'),
    });
  });

  // The Overview dashboard's KPI tile — aggregated across whatever types this actor can read, not a per-type report.
  r.get('/content/summary', async (req, res) => {
    res.json(await content.dashboardSummary(actorOf(req)));
  });

  r.get('/content/types/:type/entries', async (req, res) => {
    const { status, q, parentId, termId, locale, limit, offset } = req.query;
    res.json(
      await content.list(
        req.params.type,
        { status, q, parentId, termId, locale, limit, offset },
        actorOf(req),
      ),
    );
  });
  r.post('/content/types/:type/entries', async (req, res) => {
    const entry = await content.create(req.params.type, parse(entryBody, req.body), actorOf(req));
    res.status(201).json({ entry });
  });
  r.get('/content/entries/:id', async (req, res) => {
    res.json({ entry: await content.get(req.params.id, actorOf(req)) });
  });
  r.put('/content/entries/:id', async (req, res) => {
    res.json({
      entry: await content.update(req.params.id, parse(entryBody, req.body), actorOf(req)),
    });
  });
  r.delete('/content/entries/:id', async (req, res) => {
    await content.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });
  r.get('/content/entries/:id/revisions', async (req, res) => {
    res.json({ revisions: await content.revisions(req.params.id, actorOf(req)) });
  });
  r.post('/content/entries/:id/revisions/:rid/restore', async (req, res) => {
    res.json({ entry: await content.restore(req.params.id, req.params.rid, actorOf(req)) });
  });

  r.get('/content/taxonomies/:tax/terms', async (req, res) => {
    res.json({ terms: await content.terms(req.params.tax) });
  });
  r.post('/content/taxonomies/:tax/terms', async (req, res) => {
    res.status(201).json({
      term: await content.createTerm(req.params.tax, parse(termBody, req.body), actorOf(req)),
    });
  });
  r.put('/content/terms/:id', async (req, res) => {
    await content.updateTerm(req.params.id, parse(termBody, req.body), actorOf(req));
    res.json({ ok: true });
  });
  r.delete('/content/terms/:id', async (req, res) => {
    await content.deleteTerm(req.params.id, actorOf(req));
    res.status(204).end();
  });

  return r;
}
