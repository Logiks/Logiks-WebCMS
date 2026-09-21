import { Router } from 'express';
import { z } from 'zod';
import { forbidden, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const menuBody = z.object({
  title: z.string().max(120).optional(),
  items: z.array(z.any()).max(200),
});
const redirectBody = z.object({
  from: z.string(),
  to: z.string(),
  status: z.number().int().optional(),
});

/** Navigation menus, redirects, contact messages, draft previews and the search index. */
export default function siteRoutes(ctx) {
  const r = Router();
  const { site, content } = ctx;

  r.get('/menus', requirePermission('menus.manage'), async (_req, res) => {
    res.json({ menus: await site.menus.list() });
  });
  r.put('/menus/:name', requirePermission('menus.manage'), async (req, res) => {
    res.json({
      menu: await site.menus.save(req.params.name, parse(menuBody, req.body), actorOf(req)),
    });
  });
  r.delete('/menus/:name', requirePermission('menus.manage'), async (req, res) => {
    await site.menus.remove(req.params.name, actorOf(req));
    res.status(204).end();
  });

  r.get('/redirects', requirePermission('redirects.manage'), async (_req, res) => {
    res.json({ redirects: await site.redirects.list() });
  });
  r.post('/redirects', requirePermission('redirects.manage'), async (req, res) => {
    res
      .status(201)
      .json({ redirect: await site.redirects.create(parse(redirectBody, req.body), actorOf(req)) });
  });
  r.delete('/redirects/:id', requirePermission('redirects.manage'), async (req, res) => {
    await site.redirects.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  r.get('/messages', requirePermission('site.messages'), async (req, res) => {
    res.json({
      messages: await site.contact.list({ limit: req.query.limit, before: req.query.before }),
    });
  });
  r.delete('/messages/:id', requirePermission('site.messages'), async (req, res) => {
    await site.contact.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  /** A signed link that shows a draft as visitors would see it, for one hour. Needs permission to edit that type. */
  r.post('/content/entries/:id/preview-link', async (req, res) => {
    const entry = await content.get(req.params.id, actorOf(req));
    if (!req.user.can(`content.${entry.type}.write`))
      throw forbidden('Previews are for people who can edit this content.');
    const link = site.preview.link(entry.id);
    res.json({
      url: ctx.site.urls.absolute(link.path),
      path: link.path,
      expiresAt: link.expiresAt,
    });
  });

  r.post('/search/reindex', requirePermission('settings.write'), async (req, res) => {
    await ctx.jobs.enqueue('search.reindex', {});
    await ctx.audit.log({ actor: actorOf(req), action: 'search.reindex', entity: 'search' });
    res.status(202).json({ accepted: true });
  });

  return r;
}
