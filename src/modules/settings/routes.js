import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const writeBody = z.object({
  values: z.record(z.string(), z.any()).optional(),
  versions: z.record(z.string(), z.number()).optional(),
  reset: z.array(z.string()).optional(),
});

export default function settingsRoutes(ctx) {
  const r = Router();
  const { settings } = ctx;

  r.get('/settings', requirePermission('settings.read'), (_req, res) => {
    res.json({ configVersion: settings.version, namespaces: settings.describeAll() });
  });

  r.get('/settings/history', requirePermission('settings.read'), async (req, res) => {
    const ns = typeof req.query.namespace === 'string' ? req.query.namespace : undefined;
    res.json({
      revisions: await settings.revisions({ namespace: ns, limit: Number(req.query.limit) || 50 }),
    });
  });

  r.post('/settings/history/:id/restore', requirePermission('settings.write'), async (req, res) => {
    const out = await settings.rollback(Number(req.params.id), actorOf(req));
    res.json(out);
  });

  r.get('/settings/:ns', requirePermission('settings.read'), (req, res) => {
    res.json(settings.describe(req.params.ns));
  });

  r.put('/settings/:ns', requirePermission('settings.write'), async (req, res) => {
    const body = parse(writeBody, req.body);
    const out = await settings.update(req.params.ns, body, actorOf(req));
    const view = settings.describe(req.params.ns);
    const restartRequired = view.fields
      .filter((f) => f.restartRequired && out.changed.includes(f.key))
      .map((f) => f.label);
    res.json({ ...out, restartRequired, settings: view });
  });

  r.post('/settings/:ns/tests/:test', requirePermission('settings.write'), async (req, res) => {
    const { values } = parse(
      z.object({ values: z.record(z.string(), z.any()).optional() }),
      req.body,
    );
    res.json(await settings.runTest(req.params.ns, req.params.test, values, actorOf(req)));
  });

  return r;
}
