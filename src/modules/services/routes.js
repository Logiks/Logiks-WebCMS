import express, { Router } from 'express';
import { z } from 'zod';
import { parse, HttpError } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

const definitionBody = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  mode: z.enum(['query', 'sql', 'script']),
  access: z.enum(['public', 'customer']).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()),
});

/** Webmaster → Services (docs/DECISIONS.md D-045): admin-defined API endpoints. */
export default function servicesRoutes(ctx) {
  const r = Router();
  const { services, content } = ctx;

  r.get('/services', requirePermission('services.read'), async (_req, res) => {
    res.json({ services: await services.list() });
  });

  r.get('/services/meta', requirePermission('services.read'), async (req, res) => {
    res.json({
      entryTypes: content.registry.types().map((t) => ({
        id: t.id,
        label: t.label,
        fields: Object.values(t.fields).map((f) => ({ key: f.key, label: f.label })),
      })),
      // The table picker (services.sql only) never lists what's on the blocklist in the first place.
      tables: req.user.can('services.sql') ? await services.listTables() : [],
    });
  });

  r.get('/services/tables/:table/columns', requirePermission('services.sql'), async (req, res) => {
    res.json({ columns: await services.tableColumns(req.params.table) });
  });

  r.get('/services/export', requirePermission('services.read'), async (_req, res) => {
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="services.zip"',
    });
    res.send(await services.exportZip());
  });

  r.post(
    '/services/import',
    requirePermission('services.write'),
    docs({ binary: 'application/zip' }),
    express.raw({ type: () => true, limit: '10mb' }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new HttpError(415, 'unsupported_type', 'Send the .zip file as the request body.');
      res.json(await services.importZip(req.body, actorOf(req)));
    },
  );

  // "New service" → "Write it for me": a query-mode Service over one content type, saved switched OFF.
  const generateBody = z.object({
    description: z
      .string()
      .trim()
      .min(10, 'Say what the Service should return, for example "the latest 6 blog posts".')
      .max(2000),
  });
  r.post(
    '/services/generate',
    requirePermission('services.write'),
    docs({ body: generateBody }),
    async (req, res) => {
      const b = parse(generateBody, req.body);
      const defn = await ctx.aiServiceWriter.generate(b);
      const saved = await services.create(defn, actorOf(req));
      await ctx.audit.log({
        actor: actorOf(req),
        action: 'services.ai_generated',
        entity: 'service',
        entityId: defn.slug,
        meta: { mode: defn.mode },
      });
      res.status(201).json({ slug: saved.slug ?? defn.slug });
    },
  );

  r.get('/services/:slug', requirePermission('services.read'), async (req, res) => {
    res.json(await services.get(req.params.slug));
  });

  r.post(
    '/services',
    requirePermission('services.write'),
    docs({ body: definitionBody }),
    async (req, res) => {
      const body = parse(definitionBody, req.body);
      res.status(201).json(await services.create(body, actorOf(req)));
    },
  );

  r.put(
    '/services/:slug',
    requirePermission('services.write'),
    docs({ body: definitionBody }),
    async (req, res) => {
      const body = parse(definitionBody, { ...req.body, slug: req.body.slug ?? req.params.slug });
      res.json(await services.update(req.params.slug, body, actorOf(req)));
    },
  );

  r.delete('/services/:slug', requirePermission('services.write'), async (req, res) => {
    await services.remove(req.params.slug, actorOf(req));
    res.status(204).end();
  });

  const previewBody = definitionBody.extend({
    query: z.record(z.string(), z.string().max(200)).default({}),
  });
  r.post(
    '/services/preview',
    requirePermission('services.write'),
    docs({ body: previewBody }),
    async (req, res) => {
      const body = parse(previewBody, req.body);
      const result = await services.preview(body, {
        query: body.query,
        publicData: ctx.publicData,
      });
      res.json(result);
    },
  );

  return r;
}
