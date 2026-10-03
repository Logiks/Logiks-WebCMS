import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const plugin_editorBody1 = z.object({ slug: z.string().max(191).optional() });

const plugin_editorQuery2 = z.object({ path: z.string().min(1).max(191) });

const plugin_editorBody3 = z.object({ text: z.string().max(20_000) });

const plugin_editorBody4 = z.object({
  path: z.string().min(1).max(191),
  content: z.string().max(200_000),
});

const plugin_editorQuery5 = z.object({ path: z.string().min(1).max(191) });

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

  r.post(
    '/plugin-editor/sessions',
    requirePermission('plugins.manage'),
    docs({ body: plugin_editorBody1 }),
    async (req, res) => {
      const body = parse(plugin_editorBody1, req.body);
      res.status(201).json({ session: await pluginEditor.create(body, actorOf(req)) });
    },
  );

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
    docs({ query: plugin_editorQuery2 }),
    async (req, res) => {
      const { path: p } = parse(plugin_editorQuery2, req.query);
      res.type('text/plain').send(await pluginEditor.readFile(Number(req.params.id), p));
    },
  );

  r.post(
    '/plugin-editor/sessions/:id/messages',
    requirePermission('plugins.manage'),
    docs({ body: plugin_editorBody3 }),
    async (req, res) => {
      const body = parse(plugin_editorBody3, req.body);
      res.json(await pluginEditor.sendMessage(Number(req.params.id), body.text, actorOf(req)));
    },
  );

  // Manual editing (docs/DECISIONS.md D-063 shipped read-only; the owner asked for this directly): the same
  // validated write/delete the AI's own tools use, reachable by hand from the Files panel.
  r.put(
    '/plugin-editor/sessions/:id/file',
    requirePermission('plugins.manage'),
    docs({ body: plugin_editorBody4 }),
    async (req, res) => {
      const body = parse(plugin_editorBody4, req.body);
      res.json(
        await pluginEditor.writeFile(Number(req.params.id), body.path, body.content, actorOf(req)),
      );
    },
  );

  r.delete(
    '/plugin-editor/sessions/:id/file',
    requirePermission('plugins.manage'),
    docs({ query: plugin_editorQuery5 }),
    async (req, res) => {
      const { path: p } = parse(plugin_editorQuery5, req.query);
      res.json(await pluginEditor.removeFile(Number(req.params.id), p, actorOf(req)));
    },
  );

  return r;
}
