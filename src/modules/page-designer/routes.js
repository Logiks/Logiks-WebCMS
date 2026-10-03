import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

const pageDesignerBody1 = z.object({ path: z.string().max(191).optional() });

const pageDesignerBody2 = z.object({ text: z.string().max(20_000) });

/**
 * Webmaster → AI Page Designer (docs/DECISIONS.md D-065). The whole screen requires `pages.write` — the same
 * permission opening the Pages editor needs — since this surface can ultimately produce a live page; individual
 * tool calls inside a session additionally check `components.write` / `media.upload` / `dbms.write` /
 * `services.write` at the point they're used (service.js's `requirePerm`), so a lower-privileged admin still gets
 * full value from simpler pages rather than being locked out of the whole feature.
 */
export default function pageDesignerRoutes(ctx) {
  const r = Router();
  const { pageDesigner } = ctx;

  r.get('/page-designer/sessions', requirePermission('pages.write'), async (_req, res) => {
    res.json({ sessions: await pageDesigner.list() });
  });

  r.post(
    '/page-designer/sessions',
    requirePermission('pages.write'),
    docs({ body: pageDesignerBody1 }),
    async (req, res) => {
      const body = parse(pageDesignerBody1, req.body);
      res.status(201).json({ session: await pageDesigner.create(body, actorOf(req)) });
    },
  );

  r.get('/page-designer/sessions/:id', requirePermission('pages.write'), async (req, res) => {
    res.json(await pageDesigner.get(Number(req.params.id)));
  });

  r.post(
    '/page-designer/sessions/:id/messages',
    requirePermission('pages.write'),
    docs({ body: pageDesignerBody2 }),
    async (req, res) => {
      const body = parse(pageDesignerBody2, req.body);
      res.json(await pageDesigner.sendMessage(Number(req.params.id), body.text, actorOf(req)));
    },
  );

  r.post(
    '/page-designer/sessions/:id/proposals/:proposalId/approve',
    requirePermission('pages.write'),
    docs({ noBody: true }),
    async (req, res) => {
      res.json(
        await pageDesigner.decideProposal(
          Number(req.params.id),
          Number(req.params.proposalId),
          'approved',
          actorOf(req),
        ),
      );
    },
  );

  r.post(
    '/page-designer/sessions/:id/proposals/:proposalId/reject',
    requirePermission('pages.write'),
    docs({ noBody: true }),
    async (req, res) => {
      res.json(
        await pageDesigner.decideProposal(
          Number(req.params.id),
          Number(req.params.proposalId),
          'rejected',
          actorOf(req),
        ),
      );
    },
  );

  r.post(
    '/page-designer/sessions/:id/preview',
    requirePermission('pages.write'),
    docs({ noBody: true }),
    async (req, res) => {
      res.json(await pageDesigner.preview(Number(req.params.id)));
    },
  );

  const saveBody = z.object({
    path: z.string().min(1).max(191),
    frontMatter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    body: z.string().max(400_000),
  });
  r.post(
    '/page-designer/sessions/:id/save',
    requirePermission('pages.write'),
    docs({ body: saveBody }),
    async (req, res) => {
      const input = parse(saveBody, req.body);
      res.json(await pageDesigner.save(Number(req.params.id), input, actorOf(req)));
    },
  );

  return r;
}
