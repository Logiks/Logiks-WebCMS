import { Router } from 'express';
import { z } from 'zod';
import { forbidden, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const applyBody = z.object({ restart: z.boolean().default(false) });

const remoteBody = z.object({
  remote: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/)
    .max(64),
});

/** Operations → Updates: see every server's version, pull new code onto one, restart one. Actions return 202 and run in the background. */
export default function updatesRoutes(ctx) {
  const r = Router();
  const guard = requirePermission('system.update');

  r.get('/updates', guard, async (_req, res) => {
    const cluster = await ctx.nodes.list();
    res.json({
      self: ctx.env.nodeId,
      version: ctx.version,
      restartMode: ctx.updates.restartMode(),
      remote: ctx.settings.get('updates.remote'),
      // This server knows its own state better than its last heartbeat does.
      nodes: cluster.nodes.map((n) =>
        n.self ? { ...n, commit: ctx.updates.bootCommit(), update: ctx.updates.snapshot() } : n,
      ),
    });
  });

  r.get('/updates/history', guard, async (_req, res) => {
    res.json({ entries: await ctx.audit.list({ limit: 15, action: 'updates.' }) });
  });

  r.put('/updates/remote', guard, async (req, res) => {
    const { remote } = parse(remoteBody, req.body);
    await ctx.updates.setRemote(remote, actorOf(req));
    res.json({ remote });
  });

  r.post('/updates/nodes/:nodeId/check', guard, async (req, res) => {
    await ctx.updates.dispatch(req.params.nodeId, 'check', {}, actorOf(req));
    res.status(202).json({ accepted: true });
  });

  r.post('/updates/nodes/:nodeId/apply', guard, async (req, res) => {
    const { restart } = parse(applyBody, req.body);
    if (restart && !req.user.can('system.restart'))
      throw forbidden(
        'You can update, but restarting needs the “Restart servers” permission. Update without restarting instead.',
      );
    await ctx.updates.dispatch(req.params.nodeId, 'apply', { restart }, actorOf(req));
    res.status(202).json({ accepted: true });
  });

  r.post(
    '/updates/nodes/:nodeId/restart',
    requirePermission('system.restart'),
    async (req, res) => {
      await ctx.updates.dispatch(req.params.nodeId, 'restart', {}, actorOf(req));
      res.status(202).json({ accepted: true });
    },
  );

  return r;
}
