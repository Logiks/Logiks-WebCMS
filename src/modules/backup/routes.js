import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { MAX_UPLOAD_BYTES } from './service.js';

const createBody = z.object({
  name: z.string().max(190).optional(),
  includeMedia: z.boolean().optional(),
  secrets: z.enum(['keep', 'remove']).optional(),
  folders: z.array(z.enum(['public', 'plugins', 'site'])).optional(),
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

  // The request body goes to a temporary file as it arrives (never into memory), is checked, then moved into storage.
  r.post(
    '/backups/upload',
    requirePermission('backup.restore'),
    docs({ binary: 'application/zip' }),
    async (req, res) => {
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_UPLOAD_BYTES)
        throw new HttpError(
          413,
          'too_large',
          'That file is too large to be a backup (the limit is 20 GB).',
        );
      const tmp = path.join(os.tmpdir(), `cms-upload-${randomBytes(6).toString('hex')}.zip`);
      let bytes = 0;
      const guard = new Transform({
        transform(chunk, _e, cb) {
          bytes += chunk.length;
          if (bytes > MAX_UPLOAD_BYTES)
            return cb(
              new HttpError(
                413,
                'too_large',
                'That file is too large to be a backup (the limit is 20 GB).',
              ),
            );
          cb(null, chunk);
        },
      });
      try {
        await pipeline(req, guard, createWriteStream(tmp));
        if (!bytes)
          throw new HttpError(
            415,
            'unsupported_type',
            'Send the backup .zip file itself as the request body.',
          );
        const name = typeof req.query.name === 'string' ? req.query.name : 'Uploaded backup';
        res.status(201).json({ item: await backup.upload(tmp, name, actorOf(req)) });
      } finally {
        await rm(tmp, { force: true });
      }
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
