import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { siteGlobals } from '../site/public.js';

/**
 * Appearance → Themes, Customize and Theme editor.
 *   Themes are uploaded as a zip (the raw request body) and validated before anything is stored.
 *   The theme editor changes one file of an INSTALLED theme at a time; built-in themes are read-only (duplicate first).
 *   Customize edits the theme's settings namespace (`theme_<id>`, including `custom_css`) with a live preview.
 * A file's path travels as `?path=` because it has slashes in it.
 */
export default function themesRoutes(ctx) {
  const r = Router();
  const { themes, settings } = ctx;

  r.get('/themes', requirePermission('themes.read'), (_req, res) => {
    res.json({
      themes: themes.list(),
      allowJs: ctx.settings.get('themes.allow_js'),
      maxZipMb: ctx.settings.get('themes.max_zip_mb'),
    });
  });

  r.post(
    '/themes',
    requirePermission('themes.manage'),
    express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new HttpError(
          415,
          'unsupported_type',
          'Send the theme’s .zip file as the request body.',
        );
      res.status(201).json({ theme: await themes.install(req.body, actorOf(req)) });
    },
  );

  r.post('/themes/:id/activate', requirePermission('themes.manage'), async (req, res) => {
    res.json({ themes: await themes.activate(req.params.id, actorOf(req)) });
  });

  r.delete('/themes/:id', requirePermission('themes.manage'), async (req, res) => {
    await themes.uninstall(req.params.id, actorOf(req));
    res.status(204).end();
  });

  r.post('/themes/:id/duplicate', requirePermission('themes.manage'), async (req, res) => {
    const body = parse(
      z.object({ id: z.string().max(40), name: z.string().max(80).optional() }),
      req.body,
    );
    const theme = await themes.duplicate(
      req.params.id,
      { newId: body.id, name: body.name },
      actorOf(req),
    );
    res.status(201).json({ theme });
  });

  r.get('/themes/:id/export', requirePermission('themes.read'), async (req, res) => {
    const zip = await themes.exportZip(req.params.id);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="theme-${req.params.id}.zip"`,
    });
    res.send(zip);
  });

  // ───────── theme editor ─────────

  const filePath = (req) => {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p)
      throw new HttpError(422, 'invalid_input', 'Say which file: ?path=styles/site.css', {
        field: 'path',
      });
    return p;
  };

  r.get('/themes/:id/files', requirePermission('themes.read'), async (req, res) => {
    res.json(await themes.files(req.params.id));
  });

  r.get('/themes/:id/file', requirePermission('themes.read'), async (req, res) => {
    res.json({ file: await themes.file(req.params.id, filePath(req)) });
  });

  r.put('/themes/:id/file', requirePermission('themes.edit'), async (req, res) => {
    const { content } = parse(z.object({ content: z.string().max(1_000_000) }), req.body);
    res.json(await themes.saveFile(req.params.id, filePath(req), content, actorOf(req)));
  });

  // Images and fonts: the raw file as the request body.
  r.post(
    '/themes/:id/file',
    requirePermission('themes.edit'),
    express.raw({ type: () => true, limit: '3mb' }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new HttpError(415, 'unsupported_type', 'Send the file as the request body.');
      res.json(await themes.saveFile(req.params.id, filePath(req), req.body, actorOf(req)));
    },
  );

  r.delete('/themes/:id/file', requirePermission('themes.edit'), async (req, res) => {
    res.json(await themes.deleteFile(req.params.id, filePath(req), actorOf(req)));
  });

  // ───────── customize: the theme's options + custom CSS ─────────

  const known = (id) => {
    if (!themes.has(id)) throw new HttpError(404, 'not_found', 'That theme doesn’t exist.');
    return themes.nsOf(id);
  };

  r.get('/themes/:id/customize', requirePermission('themes.read'), (req, res) => {
    const ns = known(req.params.id);
    res.json({
      theme: themes.list().find((t) => t.id === req.params.id),
      settings: settings.describe(ns),
    });
  });

  r.put('/themes/:id/customize', requirePermission('themes.customize'), async (req, res) => {
    const ns = known(req.params.id);
    const body = parse(
      z.object({
        values: z.record(z.string(), z.any()).default({}),
        versions: z.record(z.string(), z.number()).optional(),
      }),
      req.body,
    );
    const out = await settings.update(ns, body, actorOf(req));
    res.json({ ...out, settings: settings.describe(ns) });
  });

  /**
   * Render one address of the site in this theme with DRAFT options and custom CSS, for Customize's live preview. Nothing
   * is saved, and the result is never cached: it goes straight back to the admin, which shows it in a sandboxed iframe.
   */
  r.post('/themes/:id/preview', requirePermission('themes.customize'), async (req, res) => {
    const themeId = req.params.id;
    const ns = known(themeId);
    const body = parse(
      z.object({
        path: z
          .string()
          .max(300)
          .regex(/^\/[^\s?#]*$/, 'A preview address starts with / and has no spaces.')
          .default('/'),
        values: z.record(z.string(), z.any()).default({}),
      }),
      req.body,
    );
    const fields = settings.registry.get(ns).fields;
    const draft = {};
    for (const [k, v] of Object.entries(body.values))
      if (fields[k] && !fields[k].secret) draft[k] = settings.registry.validate(ns, k, v);
    const locale = settings.get('general.default_locale');
    const found = ctx.sitePages.match(body.path);
    const globals = await siteGlobals(ctx, {
      locale,
      path: body.path,
      query: {},
      preview: true,
      themeId,
    });
    globals.settings = { ...globals.settings, ...draft };
    const out = await ctx.sitePages.render({
      file: found?.file ?? (ctx.sitePages.has404() ? 'pages/404.html' : null),
      params: found?.params ?? {},
      status: found ? 200 : 404,
      themeId,
      globals,
      customCss: draft.custom_css,
      request: {
        path: body.path,
        canonical: ctx.site.urls.absolute(body.path),
        query: {},
        locale,
        ip: req.ip,
      },
    });
    if (out.redirect) return res.json({ redirect: out.redirect });
    res.json({ status: out.status, html: out.html });
  });

  return r;
}
