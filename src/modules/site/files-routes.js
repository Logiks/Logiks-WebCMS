import { Router } from 'express';
import { z } from 'zod';
import { forbidden } from '../../core/http/errors.js';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { classify } from './files.js';

const pathQuery = z.object({ path: z.string().min(1).max(191) });
const putBody = z.object({
  path: z.string().min(1).max(191),
  content: z.string().max(400_000),
  // The hash of what the editor loaded. If someone saved a newer version meanwhile, the save is refused (409), not lost.
  expectedHash: z.string().length(64).optional(),
});

/**
 * The site tree over HTTP (pages/ and components/): what the page manager and the component builder use.
 * Permissions follow the kind of file: pages.read / pages.write for pages, components.read / components.write for components.
 */
export default function siteFilesRoutes(ctx) {
  const r = Router();
  const { siteFiles } = ctx;
  const need = (req, path, verb) => {
    const group = { page: 'pages', component: 'components', locale: 'locales' }[
      classify(path).kind
    ];
    const perm = `${group}.${verb}`;
    if (!req.user.can(perm)) throw forbidden();
  };

  r.get('/site/files', requirePermission('admin.access'), (req, res) => {
    const allowed = {
      page: req.user.can('pages.read'),
      component: req.user.can('components.read'),
      locale: req.user.can('locales.read'),
    };
    if (!Object.values(allowed).some(Boolean)) throw forbidden();
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    res.json({
      version: siteFiles.version,
      files: siteFiles.list(prefix).filter((f) => allowed[f.kind]),
    });
  });

  r.get('/site/file', (req, res) => {
    const { path } = parse(pathQuery, req.query);
    need(req, path, 'read');
    res.json(siteFiles.get(path));
  });

  r.put('/site/file', async (req, res) => {
    const body = parse(putBody, req.body);
    need(req, body.path, 'write');
    res.json(await siteFiles.put(body.path, body.content, actorOf(req), body.expectedHash));
  });

  r.delete('/site/file', async (req, res) => {
    const { path } = parse(pathQuery, req.query);
    need(req, path, 'write');
    await siteFiles.remove(path, actorOf(req));
    res.status(204).end();
  });

  return r;
}
