import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

/** Media Manager → Media Generator (docs/DECISIONS.md D-064). Reuses `media.upload` — generating-and-saving one
 * image is the same capability as uploading one, not a new permission. */
export default function mediaGeneratorRoutes(ctx) {
  const r = Router();
  const { mediaGenerator } = ctx;

  r.get('/media-generator/providers', requirePermission('media.upload'), (_req, res) => {
    res.json({ providers: mediaGenerator.providers() });
  });

  r.post('/media-generator/generate', requirePermission('media.upload'), async (req, res) => {
    const body = parse(
      z.object({ provider: z.string().max(20), prompt: z.string().max(2000) }),
      req.body,
    );
    res.json(await mediaGenerator.generate(body));
  });

  r.post('/media-generator/save', requirePermission('media.upload'), async (req, res) => {
    const body = parse(
      z.object({
        dataUrl: z.string().max(20_000_000),
        filename: z.string().max(200).optional(),
        alt: z.string().max(500).optional(),
      }),
      req.body,
    );
    const item = await mediaGenerator.save(body, actorOf(req));
    res.status(201).json({ item });
  });

  return r;
}
