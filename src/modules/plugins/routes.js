import express, { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

const configWriteBody = z.object({
  values: z.record(z.string(), z.any()).optional(),
  versions: z.record(z.string(), z.number()).optional(),
  reset: z.array(z.string()).optional(),
});

/** Applications → Plugin Manager (docs/DECISIONS.md D-060). Zip upload/export mirrors themes/routes.js exactly. */
export default function pluginsRoutes(ctx) {
  const r = Router();
  const { plugins } = ctx;

  r.get('/plugins', requirePermission('plugins.read'), (_req, res) => {
    res.json({ plugins: plugins.list() });
  });

  r.post('/plugins/rescan', requirePermission('plugins.manage'), async (_req, res) => {
    await plugins.rescanDisk();
    res.json({ plugins: plugins.list() });
  });

  r.post(
    '/plugins',
    requirePermission('plugins.manage'),
    express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new HttpError(
          415,
          'unsupported_type',
          'Send the plugin’s .zip file as the request body.',
        );
      res.status(201).json({ plugin: await plugins.install(req.body, actorOf(req)) });
    },
  );

  r.post('/plugins/:slug/enable', requirePermission('plugins.manage'), async (req, res) => {
    res.json({ plugin: await plugins.setEnabled(req.params.slug, true, actorOf(req)) });
  });

  r.post('/plugins/:slug/disable', requirePermission('plugins.manage'), async (req, res) => {
    res.json({ plugin: await plugins.setEnabled(req.params.slug, false, actorOf(req)) });
  });

  r.delete('/plugins/:slug', requirePermission('plugins.manage'), async (req, res) => {
    await plugins.uninstall(req.params.slug, actorOf(req));
    res.status(204).end();
  });

  r.get('/plugins/:slug/export', requirePermission('plugins.read'), async (req, res) => {
    const zip = await plugins.exportZip(req.params.slug);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="plugin-${req.params.slug}.zip"`,
    });
    res.send(zip);
  });

  // A plugin's own `config` (plugin.json → a `plugin_<slug>` settings-registry namespace, D-061): curated routes
  // gated by plugins.manage rather than settings.read/write, calling the settings service directly — the same
  // bypass-the-generic-endpoint pattern Appearance → Customize uses for a theme's own settings namespace
  // (src/modules/themes/routes.js). The generic GET/PUT /admin/settings/:ns still also reaches this namespace for
  // anyone holding settings.read/write, exactly as a theme's theme_<id> namespace is reachable both ways today.
  r.get('/plugins/:slug/config', requirePermission('plugins.manage'), (req, res) => {
    res.json(ctx.settings.describe(plugins.settingsNs(req.params.slug)));
  });

  r.put('/plugins/:slug/config', requirePermission('plugins.manage'), async (req, res) => {
    const ns = plugins.settingsNs(req.params.slug);
    const body = parse(configWriteBody, req.body);
    const out = await ctx.settings.update(ns, body, actorOf(req));
    res.json({ ...out, settings: ctx.settings.describe(ns) });
  });

  // Every signed-in admin user calls this (not gated by plugins.read, which is the Plugin Manager screen itself)
  // to know which of the currently-enabled plugins their own permissions let them open.
  r.get('/plugins/menu', (req, res) => {
    res.json({ items: plugins.menu((p) => req.user.can(p)) });
  });

  return r;
}

/**
 * A plugin's own admin/backend routes, dispatched by a plain lookup against the in-memory active-plugins map
 * (never mutating Express's own route stack at runtime, which would need attaching after boot for a just-installed
 * plugin). Mounted separately from pluginsRoutes above, at /admin/apps/:slug/* — a distinct prefix so it can never
 * collide with the Plugin Manager's own CRUD paths under /admin/plugins.
 */
export function pluginDispatcher(ctx) {
  const r = Router();
  r.use('/apps/:slug', (req, res, next) => {
    const active = ctx.plugins.active().get(req.params.slug);
    if (!active || !active.router) return next(new HttpError(404, 'not_found', 'No such plugin.'));
    return active.router(req, res, next);
  });
  return r;
}

/**
 * Each active plugin's own admin/*.html fragments, served the same way core modules' are (src/app.js's boot-time
 * `express.static` loop) — except plugins can appear/disappear after boot, so this is a small dynamic middleware
 * instead of a fixed mount, with the same path-traversal guard libraries/routes.js already uses.
 */
export function pluginAdminFragments(ctx) {
  return async (req, res, next) => {
    const m = /^\/admin\/modules\/plugin-([a-z0-9-]+)\/(.+)$/.exec(req.path);
    if (!m) return next();
    const active = ctx.plugins.active().get(m[1]);
    if (!active) return next();
    const abs = path.resolve(active.adminDir, m[2]);
    if (!abs.startsWith(path.resolve(active.adminDir) + path.sep)) return next();
    try {
      res.type(path.extname(abs) || '.html').send(await fs.readFile(abs, 'utf8'));
    } catch {
      next();
    }
  };
}
