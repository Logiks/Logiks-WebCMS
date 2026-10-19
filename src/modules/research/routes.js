import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

/** Content → AI Research: browse and delete what the assistant saved. Creating happens through the assistant. */
export default function researchRoutes(ctx) {
  const r = Router();
  const { research } = ctx;

  const searchBody = z.object({
    query: z.string().trim().min(2, 'Type what to search for.').max(300),
    kind: z.enum(['web', 'images']).default('web'),
  });
  const imageBody = z.object({
    url: z.string().max(2000),
    name: z.string().max(100).optional(),
    alt: z.string().max(400).optional(),
    credit: z.string().max(300).optional(),
  });

  // Search without the assistant. Same engines, same private-network checks; it reads other sites, so it needs research.write.
  r.get('/research/engines', requirePermission('research.write'), (_req, res) => {
    res.json({ engines: research.web.engines() });
  });

  // The admin's security policy only lets it show pictures from itself, so previews of other sites' pictures come
  // through here: fetched with the same private-network checks, and passed on only if the bytes really are a raster picture.
  r.get('/research/thumb', requirePermission('research.write'), async (req, res) => {
    const { buffer } = await research.web.image(String(req.query.url ?? ''));
    /** @type {[string, number[]][]} */
    const magics = [
      ['image/jpeg', [0xff, 0xd8, 0xff]],
      ['image/png', [0x89, 0x50, 0x4e, 0x47]],
      ['image/gif', [0x47, 0x49, 0x46, 0x38]],
    ];
    const type =
      magics.find(([, magic]) => magic.every((b, i) => buffer[i] === b))?.[0] ??
      (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
        ? 'image/webp'
        : null);
    if (!type)
      throw new HttpError(415, 'unsupported_type', 'That is not a JPEG, PNG, GIF or WebP picture.');
    res
      .set({
        'content-type': type,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=3600',
      })
      .send(buffer);
  });

  r.post('/research/search', requirePermission('research.write'), async (req, res) => {
    const { query, kind } = parse(searchBody, req.body);
    res.json(
      kind === 'images'
        ? { results: await research.web.searchImages(query, 12) }
        : { results: await research.web.search(query, 10), engine: research.web.engine() },
    );
  });

  r.post(
    '/research/import-image',
    requirePermission('research.write'),
    requirePermission('media.upload'),
    async (req, res) => {
      const { item } = await research.downloadImage(parse(imageBody, req.body), actorOf(req));
      res.status(201).json({ item });
    },
  );

  r.post('/research', requirePermission('research.write'), async (req, res) => {
    res.status(201).json({ item: await research.create(req.body ?? {}, actorOf(req)) });
  });

  r.get('/research', requirePermission('research.read'), async (req, res) => {
    res.json({ items: await research.list({ limit: req.query.limit, offset: req.query.offset }) });
  });

  r.get('/research/:id', requirePermission('research.read'), async (req, res) => {
    res.json({ item: await research.get(req.params.id) });
  });

  r.delete('/research/:id', requirePermission('research.delete'), async (req, res) => {
    await research.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  return r;
}
