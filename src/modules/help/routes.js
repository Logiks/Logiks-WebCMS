import { Router } from 'express';
import { z } from 'zod';
import { docs } from '../../core/http/docs.js';
import { parse } from '../../core/http/errors.js';
import { requirePermission } from '../../core/http/middleware.js';

const card = z.object({
  slug: z.string(),
  section: z.string(),
  title: z.string(),
  summary: z.string(),
});
const prompt = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  where: z.string(),
  body: z.string(),
  blanks: z.array(z.string()),
});

/** Help: guides and the prompt library, read from the markdown under docs/. Read-only, for anyone who can sign in. */
export default function helpRoutes(ctx) {
  const r = Router();
  const { help } = ctx;
  const can = requirePermission('admin.access');

  r.get(
    '/help',
    can,
    docs({
      response: z.object({
        sections: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            summary: z.string(),
            docs: z.array(card),
          }),
        ),
        promptCount: z.number(),
      }),
    }),
    (_req, res) => res.json(help.index()),
  );

  r.get(
    '/help/prompts',
    can,
    docs({ response: z.object({ categories: z.array(z.string()), items: z.array(prompt) }) }),
    (_req, res) => res.json(help.prompts()),
  );

  r.get(
    '/help/search',
    can,
    docs({
      query: z.object({ q: z.string().max(100).optional() }),
      response: z.object({ items: z.array(card.extend({ snippet: z.string() })) }),
    }),
    (req, res) => {
      const { q } = parse(z.object({ q: z.string().max(100).default('') }), req.query);
      res.json({ items: help.search(q) });
    },
  );

  r.get(
    '/help/:section/:slug',
    can,
    docs({
      response: z.object({
        doc: card.extend({
          html: z.string(),
          toc: z.array(z.object({ level: z.number(), id: z.string(), text: z.string() })),
          updatedAt: z.number(),
          previous: card.nullable(),
          next: card.nullable(),
        }),
      }),
    }),
    (req, res) => res.json({ doc: help.get(req.params.section, req.params.slug) }),
  );

  return r;
}
