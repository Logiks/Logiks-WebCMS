import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

/**
 * System → Sitemap (D-053). The options are the `sitemap` settings namespace (plus `site.sitemap_enabled`, the on/off
 * switch that already existed), saved through the settings service so they are versioned, audited and reach every server.
 */
export default function sitemapRoutes(ctx) {
  const r = Router();
  const { sitemap, settings } = ctx;

  const view = () => ({
    settings: settings.describe('sitemap'),
    enabled: settings.get('site.sitemap_enabled'),
  });

  r.get('/sitemap', requirePermission('sitemap.read'), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({ ...view(), summary: await sitemap.summary({ q, offset, limit: 100 }) });
  });

  r.put('/sitemap', requirePermission('sitemap.manage'), async (req, res) => {
    const body = parse(
      z.object({
        enabled: z.boolean().optional(),
        values: z.record(z.string(), z.any()).default({}),
        versions: z.record(z.string(), z.number()).optional(),
      }),
      req.body,
    );
    const actor = actorOf(req);
    const out = await settings.update(
      'sitemap',
      { values: body.values, versions: body.versions },
      actor,
    );
    if (body.enabled !== undefined && body.enabled !== settings.get('site.sitemap_enabled'))
      await settings.update('site', { values: { sitemap_enabled: body.enabled } }, actor);
    res.json({ changed: out.changed, ...view(), summary: await sitemap.summary() });
  });

  r.post('/sitemap/regenerate', requirePermission('sitemap.manage'), async (req, res) => {
    await sitemap.regenerate(actorOf(req));
    res.json({ summary: await sitemap.summary() });
  });

  r.get('/sitemap/download', requirePermission('sitemap.read'), async (_req, res) => {
    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sitemap.xml"',
    });
    res.send(await sitemap.fullXml());
  });

  return r;
}
