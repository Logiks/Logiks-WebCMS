import express, { Router } from 'express';
import { HttpError } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

/** Appearance → Themes. Themes are uploaded as a zip (the raw request body) and validated before anything is stored. */
export default function themesRoutes(ctx) {
  const r = Router();
  const { themes } = ctx;

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
  return r;
}
