import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

const commitBody = z.object({ message: z.string().max(300).optional() });
const publishBody = z.object({
  note: z.string().max(300).optional(),
  push: z.boolean().optional(),
});
const pullBody = z.object({ prefer: z.enum(['ours', 'theirs']).optional() });
const branchBody = z.object({ name: z.string().min(1).max(100), create: z.boolean().optional() });
const restoreBody = z.object({ version: z.number().int().min(1) });

/** Publish & Git (docs/DECISIONS.md D-117). */
export default function publishRoutes(ctx) {
  const r = Router();
  const read = requirePermission('publish.read');
  const manage = requirePermission('publish.manage');

  r.get('/publish/status', read, async (req, res) => {
    res.json(await ctx.publish.status({ refresh: req.query.refresh === 'true' }));
  });
  r.get('/publish/branches', read, async (_req, res) => {
    res.json(await ctx.publish.branches());
  });
  r.get('/publish/versions', read, async (_req, res) => {
    res.json({ versions: await ctx.publish.versions() });
  });
  r.get('/publish/log', read, async (_req, res) => {
    res.json({ commits: await ctx.assistant.history.list({ limit: 30 }) });
  });

  r.post(
    '/publish/commit',
    requirePermission('publish.commit'),
    docs({ body: commitBody }),
    async (req, res) => {
      const { message } = parse(commitBody, req.body ?? {});
      res.json(await ctx.publish.commit({ message, actor: actorOf(req) }));
    },
  );
  r.post('/publish/publish', manage, docs({ body: publishBody }), async (req, res) => {
    const b = parse(publishBody, req.body ?? {});
    res.json(await ctx.publish.publish({ note: b.note, push: b.push, actor: actorOf(req) }));
  });
  r.post('/publish/push', manage, docs({ noBody: true }), async (req, res) => {
    res.json(await ctx.publish.push(actorOf(req)));
  });
  r.post('/publish/pull', manage, docs({ body: pullBody }), async (req, res) => {
    res.json(await ctx.publish.pull({ ...parse(pullBody, req.body ?? {}), actor: actorOf(req) }));
  });
  r.post('/publish/sync', manage, docs({ body: pullBody }), async (req, res) => {
    res.json(await ctx.publish.sync({ ...parse(pullBody, req.body ?? {}), actor: actorOf(req) }));
  });
  r.post('/publish/branch', manage, docs({ body: branchBody }), async (req, res) => {
    const b = parse(branchBody, req.body);
    res.json(
      await ctx.publish.switchBranch({ name: b.name, create: b.create, actor: actorOf(req) }),
    );
  });
  r.post('/publish/restore', manage, docs({ body: restoreBody }), async (req, res) => {
    res.json(await ctx.publish.restore({ ...parse(restoreBody, req.body), actor: actorOf(req) }));
  });
  r.post('/publish/purge-cache', manage, docs({ noBody: true }), async (req, res) => {
    res.json({ cacheVersion: await ctx.publish.bustCaches('manual', actorOf(req)) });
  });
  return r;
}
