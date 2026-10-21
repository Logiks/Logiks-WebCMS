import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';
import { isInline } from './service.js';

const patch = z.object({
  alt: z.string().max(500).optional(),
  filename: z.string().min(1).max(255).optional(),
  folder: z.string().max(191).optional(),
});
const folderBody = z.object({ path: z.string().min(1).max(191) });
const renameBody = z.object({ from: z.string().min(1).max(191), to: z.string().min(1).max(191) });
const compressBody = z.object({ mode: z.enum(['copy', 'replace']) });
const thumbBody = z.object({ at: z.number().min(0).max(86400) });

/** Media library admin API. Uploads are the raw file as the request body (fetch(url, { method: 'POST', body: file })). */
export default function mediaRoutes(ctx) {
  const r = Router();
  const { media } = ctx;

  r.get('/media', requirePermission('media.read'), async (req, res) => {
    const { q, kind, folder, limit, offset } = req.query;
    res.json({
      ...(await media.list({ q, kind, folder, limit, offset })),
      available: await media.available(),
      videoThumbnails: await media.videoAvailable(),
    });
  });

  r.post(
    '/media',
    requirePermission('media.upload'),
    docs({ binary: 'application/octet-stream' }),
    // The body limit is a hard ceiling (the largest a video may be); the real, adjustable limits (Settings → Media) are enforced by the service.
    express.raw({ type: () => true, limit: '205mb' }),
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
          folder: typeof req.query.folder === 'string' ? req.query.folder : '',
          // ?compress=false keeps an image exactly as uploaded
          compress: req.query.compress !== 'false',
          at: req.query.at === undefined ? undefined : Number(req.query.at),
        },
        actorOf(req),
      );
      res.status(201).json({ item });
    },
  );

  r.get('/media/folders', requirePermission('media.read'), async (_req, res) => {
    res.json({ folders: await media.folders() });
  });
  r.post(
    '/media/folders',
    requirePermission('media.upload'),
    docs({ body: folderBody }),
    async (req, res) => {
      res
        .status(201)
        .json(await media.createFolder(parse(folderBody, req.body).path, actorOf(req)));
    },
  );
  r.put(
    '/media/folders',
    requirePermission('media.upload'),
    docs({ body: renameBody }),
    async (req, res) => {
      const { from, to } = parse(renameBody, req.body);
      res.json(await media.renameFolder(from, to, actorOf(req)));
    },
  );
  r.delete('/media/folders', requirePermission('media.delete'), async (req, res) => {
    await media.removeFolder(String(req.query.path ?? ''), actorOf(req));
    res.status(204).end();
  });

  r.get('/media/analytics', requirePermission('media.read'), async (_req, res) => {
    res.json(await media.analytics());
  });

  r.get('/media/:id', requirePermission('media.read'), async (req, res) => {
    const item = await media.get(req.params.id);
    res.json({ item, usage: await media.usage(item.id) });
  });
  r.put(
    '/media/:id',
    requirePermission('media.upload'),
    docs({ body: patch }),
    async (req, res) => {
      res.json({ item: await media.update(req.params.id, parse(patch, req.body), actorOf(req)) });
    },
  );
  r.post(
    '/media/:id/compress',
    requirePermission('media.upload'),
    docs({ body: compressBody }),
    async (req, res) => {
      const item = await media.compress(req.params.id, parse(compressBody, req.body), actorOf(req));
      res.json({ item });
    },
  );
  r.post(
    '/media/:id/thumbnail',
    requirePermission('media.upload'),
    docs({ body: thumbBody }),
    async (req, res) => {
      res.json({
        item: await media.setThumbnail(req.params.id, parse(thumbBody, req.body), actorOf(req)),
      });
    },
  );
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
        // Documents a browser can show (PDF, text) open in the tab; Word, zip and the rest are downloads.
        ...(f.kind === 'file'
          ? {
              'Content-Disposition': `${isInline(f.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
            }
          : {}),
      });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.set('Accept-Ranges', 'bytes');
      // Browsers seek inside a video by asking for byte ranges; one range is all they ever send.
      const rm = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      let range;
      if (rm && (rm[1] || rm[2])) {
        const size = await ctx.storage.size(f.key).catch(() => null);
        if (size == null) return next(new HttpError(404, 'not_found', 'File not found.'));
        const start = rm[1] ? Number(rm[1]) : Math.max(0, size - Number(rm[2]));
        const end = rm[1] && rm[2] ? Math.min(Number(rm[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.set('Content-Range', `bytes */${size}`);
          return res.status(416).end();
        }
        range = { start, end };
        res.status(206).set({
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        });
      }
      const stream = ctx.storage.stream(f.key, range);
      stream.on('error', () =>
        res.headersSent ? res.destroy() : next(new HttpError(404, 'not_found', 'File not found.')),
      );
      stream.pipe(res);
    } catch (e) {
      next(e);
    }
  };
}
