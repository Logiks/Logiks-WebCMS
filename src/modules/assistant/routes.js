import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const messageBody = z.object({
  text: z.string().max(20_000),
  images: z
    .array(z.object({ dataUrl: z.string().max(10_000_000), name: z.string().max(120).optional() }))
    .max(4)
    .optional(),
});
const updateBody = z
  .object({
    title: z.string().min(1).max(190).optional(),
    model: z.string().max(64).nullable().optional(), // '' or null = the installation's default
  })
  .refine((v) => v.title !== undefined || v.model !== undefined, 'Give a title or a model.');
const requirementsBody = z.object({ markdown: z.string().max(200_000) });

/**
 * System → Assistant (docs/DECISIONS.md D-071). The chat needs only `admin.access`: it is available to everybody
 * who can sign in to the admin, and every tool it calls checks the person's own permission, so it can never do
 * more than they could by hand. A chat belongs to the person who started it.
 */
export default function assistantRoutes(ctx) {
  const r = Router();
  const { assistant } = ctx;
  const chat = requirePermission('admin.access');

  r.get('/assistant/sessions', chat, async (req, res) => {
    res.json({ sessions: await assistant.list(actorOf(req)) });
  });
  r.post('/assistant/sessions', chat, docs({ noBody: true }), async (req, res) => {
    res.status(201).json({ session: await assistant.create(actorOf(req)) });
  });
  r.get('/assistant/sessions/:id', chat, async (req, res) => {
    res.json(await assistant.get(Number(req.params.id), actorOf(req)));
  });
  r.put('/assistant/sessions/:id', chat, docs({ body: updateBody }), async (req, res) => {
    const { title, model } = parse(updateBody, req.body);
    const id = Number(req.params.id);
    let session;
    if (title !== undefined) session = await assistant.rename(id, title, actorOf(req));
    if (model !== undefined) session = await assistant.setModel(id, model, actorOf(req));
    res.json({ session });
  });
  r.get('/assistant/models', chat, (_req, res) => {
    res.json(assistant.models());
  });
  r.delete('/assistant/sessions/:id', chat, async (req, res) => {
    await assistant.remove(Number(req.params.id), actorOf(req));
    res.status(204).end();
  });
  r.post(
    '/assistant/sessions/:id/messages',
    chat,
    docs({ body: messageBody }),
    async (req, res) => {
      const { text, images } = parse(messageBody, req.body);
      res.json(await assistant.sendMessage(Number(req.params.id), text, actorOf(req), images));
    },
  );

  r.get('/assistant/budget', chat, async (req, res) => {
    res.json(await assistant.budget(actorOf(req)));
  });

  // Change history (D-072). Reading needs history.read; Revert needs permission to write every document it touches.
  const hist = requirePermission('history.read');
  r.get('/assistant/history', hist, async (req, res) => {
    const sessionId = req.query.sessionId ? Number(req.query.sessionId) : undefined;
    const beforeId = req.query.before ? Number(req.query.before) : undefined;
    res.json({ commits: await assistant.history.list({ sessionId, beforeId }) });
  });
  r.get('/assistant/history/git', hist, async (_req, res) => {
    res.json(await assistant.history.gitStatus());
  });
  r.post(
    '/assistant/history/push',
    requirePermission('history.push'),
    docs({ noBody: true }),
    async (req, res) => {
      try {
        const out = await assistant.git.push();
        res.json({ ...out, status: await assistant.history.gitStatus() });
      } catch (e) {
        throw new HttpError(422, 'push_failed', e.message);
      }
    },
  );
  const commitBody = z.object({ message: z.string().max(300).optional() });
  r.post(
    '/assistant/history/commit',
    requirePermission('history.commit'),
    docs({ body: commitBody }),
    async (req, res) => {
      const { message } = parse(commitBody, req.body ?? {});
      const out = await assistant.history.commitNow({ message, actor: actorOf(req) });
      res.status(out.commit ? 201 : 200).json(out);
    },
  );
  r.get('/assistant/history/:id', hist, async (req, res) => {
    res.json(await assistant.history.get(Number(req.params.id), actorOf(req)));
  });
  r.post('/assistant/history/:id/revert', chat, docs({ noBody: true }), async (req, res) => {
    res.json(await assistant.history.revert(Number(req.params.id), actorOf(req)));
  });

  r.get('/assistant/requirements', requirePermission('requirements.read'), async (_req, res) => {
    res.json(await assistant.requirements.get());
  });
  r.put(
    '/assistant/requirements',
    requirePermission('requirements.write'),
    docs({ body: requirementsBody }),
    async (req, res) => {
      const { markdown } = parse(requirementsBody, req.body);
      await assistant.requirements.setAuthored(markdown, actorOf(req));
      res.json(await assistant.requirements.get());
    },
  );

  return r;
}
