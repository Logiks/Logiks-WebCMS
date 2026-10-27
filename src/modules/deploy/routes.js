import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const targetBody = z.object({
  url: z.string().trim().max(300),
  branch: z.string().trim().min(1).max(100),
});
const runBody = z.object({
  themes: z.array(z.string().max(32)).max(100).optional(),
  plugins: z.array(z.string().max(191)).max(100).optional(),
  siteTree: z.boolean().optional(),
  data: z.boolean().optional(),
  media: z.boolean().optional(),
});

/** Operations → Deploy: choose a repository and branch, push this installation's code to it, see past deploys. */
export default function deployRoutes(ctx) {
  const r = Router();
  const { deploy } = ctx;

  r.get('/deploy', requirePermission('deploy.read'), async (_req, res) => {
    res.json(await deploy.overview());
  });

  r.put(
    '/deploy/target',
    docs({ body: targetBody }),
    requirePermission('deploy.run'),
    async (req, res) => {
      const body = parse(targetBody, req.body);
      await deploy.setTarget(body, actorOf(req));
      res.json({ target: deploy.target() });
    },
  );

  r.post(
    '/deploy/run',
    docs({ body: runBody }),
    requirePermission('deploy.run'),
    async (req, res) => {
      const include = parse(runBody, req.body);
      res.status(202).json({ run: await deploy.start(include, actorOf(req)) });
    },
  );

  return r;
}
