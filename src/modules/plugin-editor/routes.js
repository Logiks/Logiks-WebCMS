import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

/**
 * Applications → Plugin Editor (docs/DECISIONS.md D-063). Gated by the same `plugins.manage` permission Plugin
 * Manager itself uses — "may write a plugin's code" and "may install one from a zip" are the same capability.
 */
export default function pluginEditorRoutes(ctx) {
  const r = Router();
  const { pluginEditor } = ctx;

  r.get('/plugin-editor/sessions', requirePermission('plugins.manage'), async (_req, res) => {
    res.json({ sessions: await pluginEditor.list() });
  });

  r.post('/plugin-editor/sessions', requirePermission('plugins.manage'), async (req, res) => {
    const body = parse(z.object({ slug: z.string().max(191).optional() }), req.body);
    res.status(201).json({ session: await pluginEditor.create(body, actorOf(req)) });
  });

  r.get('/plugin-editor/sessions/:id', requirePermission('plugins.manage'), async (req, res) => {
    res.json(await pluginEditor.get(Number(req.params.id)));
  });

  r.get(
    '/plugin-editor/sessions/:id/files',
    requirePermission('plugins.manage'),
    async (req, res) => {
      res.json({ files: await pluginEditor.listFiles(Number(req.params.id)) });
    },
  );

  r.get(
    '/plugin-editor/sessions/:id/file',
    requirePermission('plugins.manage'),
    async (req, res) => {
      const { path: p } = parse(z.object({ path: z.string().min(1).max(191) }), req.query);
      res.type('text/plain').send(await pluginEditor.readFile(Number(req.params.id), p));
    },
  );

  r.post(
    '/plugin-editor/sessions/:id/messages',
    requirePermission('plugins.manage'),
    async (req, res) => {
      const body = parse(z.object({ text: z.string().max(20_000) }), req.body);
      res.json(await pluginEditor.sendMessage(Number(req.params.id), body.text, actorOf(req)));
    },
  );

  return r;
}
