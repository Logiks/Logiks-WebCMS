import { Router } from 'express';
import { z } from 'zod';
import { HttpError, forbidden, parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf } from '../../core/http/middleware.js';
import { runChecks } from './checks.js';
import { analyse, searchLinks } from './analysis.js';
import { markdownToBlocks } from './markdown.js';
import { editorStyle } from './editor-style.js';

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
  authorId: z.number().int().positive().nullable().optional(),
  unpublishAt: z.number().int().nullable().optional(),
  // Autosave: a draft is kept as the editor goes along, without a revision or an audit line each time.
  autosave: z.boolean().optional(),
  // The address of a live entry is changing: also redirect the old one to the new one.
  redirect: z.boolean().optional(),
});
const checksBody = z.object({
  title: z.string().optional(),
  slug: z.string().nullable().optional(),
  data: z.record(z.string(), z.any()).optional(),
  entryId: z.number().int().optional(),
});
const templateBody = z.object({
  name: z.string(),
  description: z.string().optional(),
  data: z.record(z.string(), z.any()),
});
const markdownBody = z.object({ markdown: z.string().max(500_000) });
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
        .filter((t) => req.user.can(`content.${t.id}.read`) && !ctx.features.typeOff(t.id))
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

  // A type or taxonomy of a feature that is switched off (the blog's posts, categories and tags) is not reachable.
  const featureOff = () =>
    new HttpError(
      404,
      'feature_disabled',
      'That is part of a feature that is switched off. Turn it on under Settings → Features.',
    );
  r.param('type', (_req, _res, next, type) =>
    ctx.features.typeOff(type) ? next(featureOff()) : next(),
  );
  r.param('tax', (_req, _res, next, tax) =>
    ctx.features.taxonomyOff(tax) ? next(featureOff()) : next(),
  );

  r.get('/content/types/:type/entries', async (req, res) => {
    const { status, q, parentId, termId, authorId, from, to, locale, limit, offset } = req.query;
    res.json(
      await content.list(
        req.params.type,
        { status, q, parentId, termId, authorId, from, to, locale, limit, offset },
        actorOf(req),
      ),
    );
  });
  r.post('/content/types/:type/entries', docs({ body: entryBody }), async (req, res) => {
    const entry = await content.create(req.params.type, parse(entryBody, req.body), actorOf(req));
    res.status(201).json({ entry });
  });
  r.get('/content/entries/:id', async (req, res) => {
    res.json({ entry: await content.get(req.params.id, actorOf(req)) });
  });
  r.put('/content/entries/:id', docs({ body: entryBody }), async (req, res) => {
    const body = parse(entryBody, req.body);
    const before = body.redirect ? await content.get(req.params.id, actorOf(req)) : null;
    const entry = await content.update(req.params.id, body, actorOf(req));
    // Leaving the old address of a live page behind breaks every link to it, so offer to redirect it. The save has
    // already succeeded; a redirect that can't be made (one exists already) is reported, not fatal.
    let redirect = null;
    if (before?.status === 'published') {
      const from = ctx.site.urls.entry(before);
      const to = ctx.site.urls.entry(entry);
      if (from && to && from !== to) {
        try {
          await ctx.site.redirects.create({ from, to, status: 301 }, actorOf(req));
          redirect = { from, to };
        } catch (e) {
          redirect = { from, to, error: e.message };
        }
      }
    }
    res.json({ entry, redirect });
  });
  r.delete('/content/entries/:id', async (req, res) => {
    await content.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });
  r.get('/content/entries/:id/revisions', async (req, res) => {
    res.json({ revisions: await content.revisions(req.params.id, actorOf(req)) });
  });
  r.get('/content/entries/:id/revisions/:rid', async (req, res) => {
    res.json({ revision: await content.revision(req.params.id, req.params.rid, actorOf(req)) });
  });
  r.post(
    '/content/entries/:id/revisions/:rid/restore',
    docs({ noBody: true }),
    async (req, res) => {
      res.json({ entry: await content.restore(req.params.id, req.params.rid, actorOf(req)) });
    },
  );

  r.get('/content/authors', async (_req, res) => {
    res.json({ authors: await content.authors() });
  });
  r.post('/content/types/:type/checks', docs({ body: checksBody }), async (req, res) => {
    if (!req.user.can(`content.${req.params.type}.write`))
      throw forbidden("You can't edit this kind of content.");
    const b = parse(checksBody, req.body);
    res.json(await runChecks(ctx, req.params.type, b, b.entryId ?? null));
  });

  // Focus keyword, readability, quality, duplicates and link suggestions for what the editor shows now.
  r.post('/content/types/:type/analysis', docs({ body: checksBody }), async (req, res) => {
    if (!req.user.can(`content.${req.params.type}.write`))
      throw forbidden("You can't edit this kind of content.");
    const b = parse(checksBody, req.body);
    res.json(await analyse(ctx, req.params.type, b, b.entryId ?? null));
  });
  // Published entries by title, for the link picker.
  r.get('/content/link-search', async (req, res) => {
    res.json({
      results: await searchLinks(ctx, String(req.query.q ?? '').slice(0, 100), {
        locale: typeof req.query.locale === 'string' ? req.query.locale : undefined,
      }),
    });
  });
  // The active theme's fonts and colours, so the editing area looks like the page will (D-126).
  r.get('/content/editor-style', async (_req, res) => {
    res.json(await editorStyle(ctx));
  });
  r.post('/content/markdown', docs({ body: markdownBody }), (req, res) => {
    const { markdown } = parse(markdownBody, req.body);
    // The browser still sends the blocks back through the normal save, which sanitises them.
    res.json({ blocks: markdownToBlocks(markdown).slice(0, 1000) });
  });

  r.get('/content/types/:type/templates', async (req, res) => {
    if (!req.user.can(`content.${req.params.type}.write`))
      throw forbidden("You can't edit this kind of content.");
    res.json({ templates: await content.templates.list(req.params.type) });
  });
  r.post('/content/types/:type/templates', docs({ body: templateBody }), async (req, res) => {
    if (!req.user.can(`content.${req.params.type}.write`))
      throw forbidden("You can't edit this kind of content.");
    res.status(201).json({
      template: await content.templates.create(
        req.params.type,
        parse(templateBody, req.body),
        actorOf(req),
      ),
    });
  });
  r.delete('/content/templates/:id', async (req, res) => {
    await content.templates.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  r.get('/content/taxonomies/:tax/terms', async (req, res) => {
    res.json({ terms: await content.terms(req.params.tax) });
  });
  r.post('/content/taxonomies/:tax/terms', docs({ body: termBody }), async (req, res) => {
    res.status(201).json({
      term: await content.createTerm(req.params.tax, parse(termBody, req.body), actorOf(req)),
    });
  });
  r.put('/content/terms/:id', docs({ body: termBody }), async (req, res) => {
    await content.updateTerm(req.params.id, parse(termBody, req.body), actorOf(req));
    res.json({ ok: true });
  });
  r.delete('/content/terms/:id', async (req, res) => {
    await content.deleteTerm(req.params.id, actorOf(req));
    res.status(204).end();
  });

  return r;
}
