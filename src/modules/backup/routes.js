import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const createBody = z.object({
  name: z.string().max(190).optional(),
  includeMedia: z.boolean().optional(),
  secrets: z.enum(['keep', 'remove']).optional(),
});
const restoreBody = z.object({ confirm: z.string(), safety: z.boolean().optional() });

/** Operations → Backups: make, download, upload, check and restore backups of the data people change (D-120). */
export default function backupRoutes(ctx) {
  const r = Router();
  const { backup } = ctx;

  r.get('/backups', requirePermission('backup.read'), async (_req, res) => {
    res.json({ items: await backup.list(), status: await backup.status() });
  });

  r.get('/backups/status', requirePermission('backup.read'), async (_req, res) => {
    res.json(await backup.status());
  });

  r.post(
    '/backups',
    requirePermission('backup.create'),
    docs({ body: createBody }),
    async (req, res) => {
      res
        .status(202)
        .json({ item: await backup.create(parse(createBody, req.body), actorOf(req)) });
    },
  );

  // A backup holds every record on the site, so downloading one needs the create permission, not just read.
  r.get('/backups/:id/download', requirePermission('backup.create'), async (req, res) => {
    const { backup: b, stream } = await backup.open(req.params.id);
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-length', String(b.size));
    res.setHeader(
      'content-disposition',
      `attachment; filename="backup-${b.id}-${new Date(b.createdAt).toISOString().slice(0, 10)}.zip"`,
    );
    res.setHeader('cache-control', 'no-store');
    stream.pipe(res);
  });

  r.post(
    '/backups/upload',
    requirePermission('backup.restore'),
    docs({ binary: 'application/zip' }),
    express.raw({ type: () => true, limit: '1gb' }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new HttpError(
          415,
          'unsupported_type',
          'Send the backup .zip file itself as the request body.',
        );
      const name = typeof req.query.name === 'string' ? req.query.name : 'Uploaded backup';
      res.status(201).json({ item: await backup.upload(req.body, name, actorOf(req)) });
    },
  );

  r.get('/backups/:id/inspect', requirePermission('backup.restore'), async (req, res) => {
    res.json(await backup.inspect(req.params.id));
  });

  r.post(
    '/backups/:id/restore',
    requirePermission('backup.restore'),
    docs({ body: restoreBody }),
    async (req, res) => {
      res
        .status(202)
        .json(await backup.restore(req.params.id, parse(restoreBody, req.body), actorOf(req)));
    },
  );

  r.delete('/backups/:id', requirePermission('backup.create'), async (req, res) => {
    await backup.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  return r;
}
