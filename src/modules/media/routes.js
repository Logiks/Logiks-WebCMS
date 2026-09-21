import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const patch = z.object({
  alt: z.string().max(500).optional(),
  filename: z.string().min(1).max(255).optional(),
});

/** Media library admin API. Uploads are the raw file as the request body (fetch(url, { method: 'POST', body: file })). */
export default function mediaRoutes(ctx) {
  const r = Router();
  const { media } = ctx;

  r.get('/media', requirePermission('media.read'), async (req, res) => {
    const { q, kind, limit, offset } = req.query;
    res.json({
      ...(await media.list({ q, kind, limit, offset })),
      available: await media.available(),
    });
  });

  r.post(
    '/media',
    requirePermission('media.upload'),
    // The body limit is a hard ceiling; the real, adjustable limit (Settings → Media) is enforced by the service.
    express.raw({ type: () => true, limit: '55mb' }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body))
        throw new HttpError(
          415,
          'unsupported_type',
          'Send the file itself as the request body, not JSON.',
        );
      const item = await media.upload(
        {
          buffer: req.body,
          name: typeof req.query.name === 'string' ? req.query.name : 'upload',
          alt: typeof req.query.alt === 'string' ? req.query.alt : '',
        },
        actorOf(req),
      );
      res.status(201).json({ item });
    },
  );

  r.get('/media/:id', requirePermission('media.read'), async (req, res) => {
    const item = await media.get(req.params.id);
    res.json({ item, usage: await media.usage(item.id) });
  });
  r.put('/media/:id', requirePermission('media.upload'), async (req, res) => {
    res.json({ item: await media.update(req.params.id, parse(patch, req.body), actorOf(req)) });
  });
  r.delete('/media/:id', requirePermission('media.delete'), async (req, res) => {
    await media.remove(req.params.id, { force: req.query.force === 'true' }, actorOf(req));
    res.status(204).end();
  });
  return r;
}

/**
 * GET /media/:id/:file — public, cookie-less, immutable. A media id never changes what it points at, so browsers and CDNs
 * may keep a file for a year. Only files listed in the catalogue are served (no path is built from the URL).
 */
export function mediaPublicRoute(ctx) {
  return async (req, res, next) => {
    try {
      const f = await ctx.media.resolveFile(req.params.id, req.params.file);
      if (!f) return next(new HttpError(404, 'not_found', 'File not found.'));
      const etag = `"${f.hash.slice(0, 16)}-${req.params.file}"`;
      res.set({
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
        'Content-Type': f.mime,
        'X-Content-Type-Options': 'nosniff',
        // Whatever a browser does with the file, it may not run anything from it.
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ...(f.kind === 'file'
          ? { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}` }
          : {}),
      });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      const stream = ctx.storage.stream(f.key);
      stream.on('error', () =>
        res.headersSent ? res.destroy() : next(new HttpError(404, 'not_found', 'File not found.')),
      );
      stream.pipe(res);
    } catch (e) {
      next(e);
    }
  };
}
