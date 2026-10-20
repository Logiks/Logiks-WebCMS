import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { CHECKS, DEFAULT_CHECKS } from './service.js';
import { renderPdf } from './report-pdf.js';

const startBody = z.object({
  viewports: z.array(z.string()).optional(),
  maxPages: z.number().optional(),
  spelling: z.boolean().optional(),
  checks: z.array(z.string()).optional(),
});
const journeyBody = z.object({
  name: z.string(),
  steps: z.string(),
  enabled: z.boolean().optional(),
});
const run = z.object({ id: z.number(), status: z.string() }).passthrough();

/** Automation → Testing: start a site check and read its reports. */
export default function testingRoutes(ctx) {
  const r = Router();
  const { testing } = ctx;

  r.get(
    '/testing/status',
    requirePermission('testing.read'),
    docs({
      response: z.object({
        browser: z.object({ ok: z.boolean(), reason: z.string() }),
        running: z.any(),
      }),
    }),
    async (_req, res) => {
      res.json({
        browser: await testing.status(),
        running: await testing.running(),
        checks: CHECKS,
        defaults: ctx.settings.get('testing.checks')?.length
          ? ctx.settings.get('testing.checks')
          : DEFAULT_CHECKS,
      });
    },
  );

  r.get(
    '/testing/runs',
    requirePermission('testing.read'),
    docs({ response: z.object({ runs: z.array(run) }) }),
    async (_req, res) => {
      res.json({ runs: await testing.list() });
    },
  );

  r.post(
    '/testing/runs',
    requirePermission('testing.run'),
    docs({ body: startBody, response: z.object({ run }), status: 201 }),
    async (req, res) => {
      res.status(201).json({ run: await testing.start(req.body ?? {}, actorOf(req)) });
    },
  );

  r.get('/testing/runs/:id', requirePermission('testing.read'), async (req, res) => {
    const q = req.query;
    res.json(
      await testing.get(req.params.id, {
        severity: q.severity ? String(q.severity) : undefined,
        category: q.category ? String(q.category) : undefined,
        viewport: q.viewport ? String(q.viewport) : undefined,
        q: q.q ? String(q.q).slice(0, 100) : undefined,
        offset: Number(q.offset) || 0,
        limit: Number(q.limit) || 500,
      }),
    );
  });

  r.post(
    '/testing/runs/:id/cancel',
    requirePermission('testing.run'),
    docs({ noBody: true }),
    async (req, res) => {
      await testing.cancel(req.params.id, actorOf(req));
      res.status(204).end();
    },
  );

  r.delete('/testing/runs/:id', requirePermission('testing.run'), async (req, res) => {
    await testing.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  // A picture of the top of a page that had problems, kept with the report.
  r.get('/testing/runs/:id/shot', requirePermission('testing.read'), async (req, res) => {
    const path = String(req.query.path ?? '');
    const viewport = String(req.query.viewport ?? '');
    if (!path || !viewport)
      throw new HttpError(422, 'invalid_input', 'Give the page and the screen size.');
    res
      .set({
        'content-type': 'image/jpeg',
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=3600',
      })
      .send(await testing.shot(req.params.id, path, viewport));
  });

  r.get('/testing/runs/:id/export', requirePermission('testing.read'), async (req, res) => {
    const { name, text } = await testing.csv(req.params.id);
    res
      .set({
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
      })
      .send(text);
  });

  r.get('/testing/runs/:id/export.pdf', requirePermission('testing.read'), async (req, res) => {
    const pdf = await renderPdf(await testing.reportData(req.params.id));
    res
      .set({
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="ai-testing-report-${Number(req.params.id)}.pdf"`,
        'cache-control': 'private, no-store',
      })
      .send(pdf);
  });

  // Saved journeys: click-through tests written one step per line.
  r.get('/testing/journeys', requirePermission('testing.read'), async (_req, res) => {
    res.json({ journeys: await testing.journeys() });
  });
  r.post(
    '/testing/journeys',
    requirePermission('testing.run'),
    docs({ body: journeyBody, status: 201 }),
    async (req, res) => {
      res.status(201).json({ journey: await testing.saveJourney(null, req.body, actorOf(req)) });
    },
  );
  r.put(
    '/testing/journeys/:id',
    requirePermission('testing.run'),
    docs({ body: journeyBody }),
    async (req, res) => {
      res.json({ journey: await testing.saveJourney(req.params.id, req.body, actorOf(req)) });
    },
  );
  r.delete('/testing/journeys/:id', requirePermission('testing.run'), async (req, res) => {
    await testing.removeJourney(req.params.id, actorOf(req));
    res.status(204).end();
  });
  r.post(
    '/testing/journeys/:id/try',
    requirePermission('testing.run'),
    docs({ noBody: true }),
    async (req, res) => {
      res.json(await testing.tryJourney(req.params.id));
    },
  );

  // Visual-regression: the version of each page a person last accepted.
  r.get('/testing/baselines', requirePermission('testing.read'), async (_req, res) => {
    res.json({ baselines: await testing.baselines() });
  });
  r.get('/testing/baselines/shot', requirePermission('testing.read'), async (req, res) => {
    const path = String(req.query.path ?? '');
    const viewport = String(req.query.viewport ?? '');
    if (!path || !viewport)
      throw new HttpError(422, 'invalid_input', 'Give the page and the screen size.');
    res
      .set({
        'content-type': 'image/jpeg',
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=60',
      })
      .send(
        await testing.baselineShot(String(req.query.path ?? ''), String(req.query.viewport ?? '')),
      );
  });
  r.post(
    '/testing/baselines/accept',
    requirePermission('testing.run'),
    docs({
      body: z.object({ path: z.string(), viewport: z.string() }),
      response: z.object({ ok: z.boolean() }),
    }),
    async (req, res) => {
      await testing.acceptBaseline(
        String(req.body?.path ?? ''),
        String(req.body?.viewport ?? 'desktop'),
        actorOf(req),
      );
      res.json({ ok: true });
    },
  );

  // Which page file answers an address ("Fix with the assistant").
  r.get('/testing/resolve', requirePermission('testing.read'), (req, res) => {
    res.json(testing.resolve(String(req.query.path ?? '/')));
  });

  return r;
}
