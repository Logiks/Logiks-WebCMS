import { Router } from 'express';
import { z } from 'zod';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { parse } from '../../core/http/errors.js';
import { FEATURES } from './features.js';
import { STATEMENT, GENERAL } from './statement.js';

const profileBody = z.object({
  provider: z.enum(['anthropic', 'openai-compatible']),
  base_url: z.string().max(300).optional(),
  model: z.string().min(1).max(100),
  api_key: z.string().max(500).optional(),
  clear_key: z.boolean().optional(),
  is_local: z.boolean().optional(),
  tools: z.boolean().optional(),
  enabled: z.boolean().optional(),
  price_in: z.number().min(0).optional(),
  price_out: z.number().min(0).optional(),
});

const SETTING_KEYS = [
  'daily_token_cap',
  'monthly_token_cap',
  'daily_cost_cap',
  'monthly_cost_cap',
  'default_price_in',
  'default_price_out',
  'local_timeout_seconds',
];

/** Settings → AI & data. Administrators only (aigov.manage): this page decides which model sees the site's content. */
export default function aigovRoutes(ctx) {
  const r = Router();
  const { aigov, settings, audit } = ctx;
  const can = requirePermission('aigov.manage');

  r.get('/aigov', can, async (_req, res) => {
    res.json({
      disabled: !!ctx.env.AI_DISABLED,
      features: FEATURES,
      profiles: aigov.profiles(),
      routes: aigov.routes(),
      settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, settings.get(`ai.${k}`)])),
      keyIsSet: !!settings.get('ai.anthropic_api_key'),
      model: settings.get('ai.model'),
      spend: await aigov.spendNow(),
    });
  });

  r.put('/aigov/settings', can, async (req, res) => {
    const values = parse(
      z.object(Object.fromEntries(SETTING_KEYS.map((k) => [k, z.number().min(0).optional()]))),
      req.body,
    );
    const out = await settings.update('ai', { values }, actorOf(req));
    res.json(out);
  });

  r.put('/aigov/profiles/:name', can, async (req, res) => {
    const body = parse(profileBody, req.body);
    const p = await aigov.saveProfile({ ...body, name: req.params.name }, actorOf(req));
    await audit.log({
      actor: actorOf(req),
      action: 'aigov.profile.saved',
      entity: 'aigov',
      meta: { name: p.name, provider: p.provider, local: p.is_local },
    });
    res.json(p);
  });

  r.delete('/aigov/profiles/:name', can, async (req, res) => {
    await aigov.deleteProfile(req.params.name, actorOf(req));
    await audit.log({
      actor: actorOf(req),
      action: 'aigov.profile.deleted',
      entity: 'aigov',
      meta: { name: req.params.name },
    });
    res.json({ ok: true });
  });

  // An unsaved draft may be tested too (the form's own values), so a typo is found before it is saved.
  r.post('/aigov/profiles/:name/test', can, async (req, res) => {
    const draft = req.body?.draft ? parse(profileBody, req.body.draft) : null;
    res.json(await aigov.test(req.params.name, draft));
  });

  r.put('/aigov/routes', can, async (req, res) => {
    const table = parse(z.record(z.string(), z.array(z.string())), req.body?.routes);
    const saved = await aigov.saveRoutes(table, actorOf(req));
    await audit.log({
      actor: actorOf(req),
      action: 'aigov.routes.saved',
      entity: 'aigov',
      meta: { routes: saved },
    });
    res.json({ routes: saved });
  });

  r.post('/aigov/routes/reset', can, async (req, res) => {
    await aigov.resetRoutes(actorOf(req));
    await audit.log({
      actor: actorOf(req),
      action: 'aigov.routes.reset',
      entity: 'aigov',
      meta: {},
    });
    res.json({ routes: {} });
  });

  r.post('/aigov/routes/recommended', can, async (req, res) => {
    const { profile } = parse(z.object({ profile: z.string().min(1) }), req.body);
    const merged = { ...aigov.routes(), ...aigov.recommendedRoutes(profile) };
    const saved = await aigov.saveRoutes(merged, actorOf(req));
    await audit.log({
      actor: actorOf(req),
      action: 'aigov.routes.saved',
      entity: 'aigov',
      meta: { routes: saved },
    });
    res.json({ routes: saved });
  });

  r.post('/aigov/plan', can, async (req, res) => {
    const { feature } = parse(z.object({ feature: z.string() }), req.body);
    res.json(await aigov.plan({ feature }, { max_tokens: 1000, messages: [] }));
  });

  r.get('/aigov/report', can, async (req, res) => {
    res.json(
      await aigov.report({
        from: typeof req.query.from === 'string' ? req.query.from : undefined,
        to: typeof req.query.to === 'string' ? req.query.to : undefined,
      }),
    );
  });

  r.post('/aigov/feedback', can, async (req, res) => {
    const b = parse(
      z.object({ usage_id: z.number().int(), rating: z.union([z.literal(1), z.literal(-1)]) }),
      req.body,
    );
    await aigov.rate(b.usage_id, b.rating);
    res.json({ ok: true });
  });

  r.get('/aigov/statement', can, (_req, res) => {
    res.json({
      ...GENERAL,
      features: FEATURES.map((f) => ({
        id: f.id,
        label: f.label,
        sends: STATEMENT[f.id]?.sends ?? [],
      })),
    });
  });

  return r;
}
