import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const targetBody = z.object({
  url: z.string().trim().max(300),
  branch: z.string().trim().min(1).max(100),
});
const selectionBody = z.object({
  tables: z.record(z.string().max(64), z.enum(['skip', 'add', 'sync'])).optional(),
  settings: z.array(z.string().max(200)).max(2000).optional(),
  libraries: z.array(z.string().max(191)).max(200).nullable().optional(),
});
const stepBody = z.object({ step: z.string().min(1).max(300), done: z.boolean() });
const idsBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });
const runBody = z.object({
  themes: z.array(z.string().max(32)).max(100).optional(),
  plugins: z.array(z.string().max(191)).max(100).optional(),
  siteTree: z.boolean().optional(),
  data: z.boolean().optional(),
  media: z.boolean().optional(),
  title: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
  bump: z.enum(['major', 'minor', 'fix']).optional(),
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

  // Which data a deploy carries (saved as a setting, so it is the same next time and on every server).
  r.get('/deploy/data', requirePermission('deploy.read'), async (_req, res) => {
    res.json(await ctx.deploySync.overview());
  });
  r.put(
    '/deploy/data',
    docs({ body: selectionBody }),
    requirePermission('deploy.run'),
    async (req, res) => {
      const body = parse(selectionBody, req.body);
      await ctx.deploySync.saveSelection(body, actorOf(req));
      res.json(await ctx.deploySync.overview());
    },
  );

  // Changes a deployment brought that differ from what is here. Nothing is applied until a person ticks it.
  r.get('/deploy/conflicts', requirePermission('deploy.read'), async (req, res) => {
    const status = ['open', 'applied', 'dismissed'].includes(String(req.query.status))
      ? String(req.query.status)
      : 'open';
    res.json({ conflicts: await ctx.deploySync.listConflicts(status) });
  });
  r.post(
    '/deploy/conflicts/apply',
    docs({ body: idsBody }),
    requirePermission('deploy.run'),
    async (req, res) => {
      res.json(await ctx.deploySync.applyConflicts(parse(idsBody, req.body).ids, actorOf(req)));
    },
  );
  r.post(
    '/deploy/conflicts/dismiss',
    docs({ body: idsBody }),
    requirePermission('deploy.run'),
    async (req, res) => {
      res.json(await ctx.deploySync.dismissConflicts(parse(idsBody, req.body).ids, actorOf(req)));
    },
  );

  // Release notes: written by the deploy, kept on every server that pulls it, readable later.
  r.get('/deploy/releases', requirePermission('deploy.read'), async (_req, res) => {
    res.json({
      releases: await ctx.deployReleases.list(),
      unread: await ctx.deployReleases.unread(),
    });
  });
  r.get('/deploy/releases/:id', requirePermission('deploy.read'), async (req, res) => {
    res.json(await ctx.deployReleases.get(req.params.id));
  });
  r.post(
    '/deploy/releases/:id/read',
    docs({ noBody: true }),
    requirePermission('deploy.read'),
    async (req, res) => {
      await ctx.deployReleases.markRead(req.params.id);
      res.json({ ok: true });
    },
  );
  r.put(
    '/deploy/releases/:id/steps',
    docs({ body: stepBody }),
    requirePermission('deploy.read'),
    async (req, res) => {
      const b = parse(stepBody, req.body);
      await ctx.deployReleases.setStepDone(req.params.id, b.step, b.done, actorOf(req));
      res.json({ ok: true });
    },
  );

  return r;
}
