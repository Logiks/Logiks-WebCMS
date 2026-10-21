import { Router } from 'express';
import { z } from 'zod';
import { forbidden, parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { redact } from './service.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const applyBody = z.object({ restart: z.boolean().default(false) });

const sourceBody = z.object({
  url: z
    .string()
    .trim()
    .regex(/^[^\s-]\S*$/)
    .regex(/^(?![a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@)/i, 'Remove the password from the URL.')
    .max(300),
  branch: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)
    .max(100)
    .refine((b) => !b.includes('..')),
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
      source: {
        url: redact(ctx.settings.get('updates.source_url')),
        branch: ctx.settings.get('updates.source_branch'),
      },
      // This server knows its own state better than its last heartbeat does.
      nodes: cluster.nodes.map((n) =>
        n.self ? { ...n, commit: ctx.updates.bootCommit(), update: ctx.updates.snapshot() } : n,
      ),
    });
  });

  r.get('/updates/history', guard, async (_req, res) => {
    res.json({ entries: await ctx.audit.list({ limit: 15, action: 'updates.' }) });
  });

  r.put('/updates/source', docs({ body: sourceBody }), guard, async (req, res) => {
    const source = parse(sourceBody, req.body);
    await ctx.updates.setSource(source, actorOf(req));
    res.json({ source });
  });

  r.post('/updates/nodes/:nodeId/check', docs({ noBody: true }), guard, async (req, res) => {
    await ctx.updates.dispatch(req.params.nodeId, 'check', {}, actorOf(req));
    res.status(202).json({ accepted: true });
  });

  r.post('/updates/nodes/:nodeId/apply', docs({ body: applyBody }), guard, async (req, res) => {
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
    docs({ noBody: true }),
    async (req, res) => {
      await ctx.updates.dispatch(req.params.nodeId, 'restart', {}, actorOf(req));
      res.status(202).json({ accepted: true });
    },
  );

  return r;
}
