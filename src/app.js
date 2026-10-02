import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hotSwap } from './core/http/hotswap.js';
import { createLimiters } from './core/http/limits.js';
import { createCsrf } from './core/http/csrf.js';
import { apiNotFound, errorHandler } from './core/http/errors.js';
import { healthRoutes } from './core/http/health.js';
import { loadPrincipal, requirePermission } from './core/http/middleware.js';
import authRoutes from './modules/auth/routes.js';
import settingsRoutes from './modules/settings/routes.js';
import usersRoutes from './modules/users/routes.js';
import auditRoutes from './modules/audit/routes.js';
import clusterRoutes from './modules/cluster/routes.js';
import systemRoutes from './modules/system/routes.js';
import updatesRoutes from './modules/updates/routes.js';
import contentRoutes from './modules/content/routes.js';
import mediaRoutes, { mediaPublicRoute } from './modules/media/routes.js';
import themesRoutes from './modules/themes/routes.js';
import siteRoutes from './modules/site/routes.js';
import siteFilesRoutes from './modules/site/files-routes.js';
import siteBuilderRoutes from './modules/site/builder-routes.js';
import siteLocalesRoutes from './modules/site/locales-routes.js';
import servicesRoutes from './modules/services/routes.js';
import dbmsRoutes from './modules/dbms/routes.js';
import seoRoutes from './modules/seo/routes.js';
import eventsRoutes from './modules/events/routes.js';
import webhooksRoutes from './modules/webhooks/routes.js';
import schedulerRoutes from './modules/scheduler/routes.js';
import sitemapRoutes from './modules/sitemap/routes.js';
import librariesRoutes, { libraryPublicRoute } from './modules/libraries/routes.js';
import analyticsRoutes from './modules/analytics/routes.js';
import pluginsRoutes, { pluginDispatcher, pluginAdminFragments } from './modules/plugins/routes.js';
import pluginEditorRoutes from './modules/plugin-editor/routes.js';
import mediaGeneratorRoutes from './modules/media-generator/routes.js';
import publicSite from './modules/site/public.js';
import publicContentApi from './modules/site/api.js';
import { metricsRoute } from './core/http/metricsRoute.js';
import { securityHeaders } from './core/http/securityHeaders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Not require.resolve(`${name}/package.json`): a package whose own "exports" map doesn't list "./package.json"
// (codejar, prismjs — unlike bootstrap/alpine/the fontsource fonts) makes Node refuse to resolve that subpath at
// all. A flat, single-package node_modules (no workspaces here) makes the plain join just as reliable.
const pkgDir = (name) => path.join(ROOT, 'node_modules', name);
// codejar ships ESM-only (`export function CodeJar`); it has no imports of its own, so turning it into a plain
// global script is a one-line swap rather than a real build step — read once at boot, served on every request.
const codejarRaw = fs.readFileSync(path.join(pkgDir('codejar'), 'dist/codejar.js'), 'utf8');
if (!/^export function CodeJar/m.test(codejarRaw))
  throw new Error(
    'codejar/dist/codejar.js no longer starts with "export function CodeJar" — update the swap in app.js for the new version.',
  );
const codejarSrc = `${codejarRaw.replace(/^export function CodeJar/m, 'function CodeJar')}\nwindow.CodeJar = CodeJar;\n`;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** @param {Awaited<ReturnType<typeof import('./context.js').createContext>>} ctx */
export function createApp(ctx) {
  const { env, settings, log } = ctx;
  ctx.limiters = createLimiters(ctx);
  ctx.csrf = createCsrf(ctx);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS); // number of proxy hops (1 = a single ALB)

  // Health first: no logging noise, no session, no rate limit.
  app.use(healthRoutes(ctx));
  app.get('/metrics', metricsRoute(ctx)); // token-protected, off by default; not timed or logged
  app.use(ctx.metrics.middleware);

  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req, res) => {
        const id = req.headers['x-amzn-trace-id'] || req.headers['x-request-id'] || randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      serializers: {
        req: (r) => ({ id: r.id, method: r.method, url: r.url }),
        res: (r) => ({ status: r.statusCode }),
      },
    }),
  );

  // CSP is rebuilt live when the admin edits the extra-source lists.
  app.use(
    hotSwap(settings, 'security', (v) => securityHeaders(env, v), [
      'csp_img_sources',
      'csp_connect_sources',
    ]),
  );

  // ── Admin SPA (static, no build step; vendor assets self-hosted from node_modules) ──
  const cache = { maxAge: env.isProd ? '7d' : 0, immutable: env.isProd };
  app.use('/admin/vendor/bootstrap', express.static(path.join(pkgDir('bootstrap'), 'dist'), cache));
  app.use(
    '/admin/vendor/bootstrap-icons',
    express.static(path.join(pkgDir('bootstrap-icons'), 'font'), cache),
  );
  app.use('/admin/vendor/alpine', express.static(path.join(pkgDir('alpinejs'), 'dist'), cache));
  app.get('/admin/vendor/codejar/dist/codejar.js', (_req, res) => {
    res
      .type('application/javascript')
      .set('Cache-Control', env.isProd ? 'public, max-age=604800, immutable' : 'no-cache')
      .send(codejarSrc);
  });
  app.use('/admin/vendor/codejar', express.static(pkgDir('codejar'), cache));
  app.use('/admin/vendor/prismjs', express.static(pkgDir('prismjs'), cache));
  app.use('/admin/vendor/plex-sans', express.static(pkgDir('@fontsource/ibm-plex-sans'), cache));
  app.use('/admin/vendor/plex-mono', express.static(pkgDir('@fontsource/ibm-plex-mono'), cache));
  app.use(
    '/admin/static',
    express.static(path.join(ROOT, 'admin/static'), { maxAge: env.isProd ? '5m' : 0 }),
  );
  // Each module's own admin-screen HTML fragments (fetched lazily by the SPA, `H.mountFragment` in
  // app.js) — a module owns its admin markup under its own directory rather than one central file,
  // so it stays self-contained if it's ever copied/removed between installations. Auto-discovered:
  // adding or removing a module's admin/ folder needs no change here.
  for (const name of fs.readdirSync(path.join(ROOT, 'src/modules'))) {
    const dir = path.join(ROOT, 'src/modules', name, 'admin');
    if (fs.existsSync(dir)) app.use(`/admin/modules/${name}`, express.static(dir, cache));
  }
  // A plugin's own admin/*.html, unlike the fixed loop above, can appear or disappear after boot (install/enable),
  // so it's served by a small dynamic middleware (src/modules/plugins/routes.js) instead of a fixed static mount.
  app.use(pluginAdminFragments(ctx));
  app.get(['/admin', '/admin/*splat'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(ROOT, 'admin/static/index.html'));
  });

  // Uploaded files and installed libraries (public, cookie-less, immutable)
  app.get('/media/:id/:file', mediaPublicRoute(ctx));
  app.use(libraryPublicRoute(ctx));

  // ── API ──
  const api = express.Router();
  api.use(express.json({ limit: '1mb' })); // rich content is sent as one JSON document
  api.use(ctx.limiters.api);

  // Public, cookie-less, CORS-enabled surface (headless clients). Origins come from settings, live.
  const publicApi = express.Router();
  publicApi.use(
    cors({
      origin: (origin, cb) =>
        cb(null, !origin || settings.get('security.cors_origins').includes(origin)),
      methods: ['GET', 'HEAD', 'OPTIONS'],
      maxAge: 600,
    }),
  );
  publicApi.get('/info', async (_req, res) => {
    const g = settings.ns('general');
    const l = settings.ns('login');
    const media = await ctx.media.describeMany(
      [l.logo, l.favicon, l.background_image].filter(Boolean),
    );
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      siteName: g.site_name,
      tagline: g.tagline,
      maintenance: g.maintenance_mode,
      passwordReset: ctx.mailer.enabled(),
      passwordMinLength: settings.get('security.password_min_length'),
      login: {
        logoUrl: media.get(l.logo)?.src || null,
        faviconUrl: media.get(l.favicon)?.src || null,
        backgroundType: l.background_type,
        backgroundColor: l.background_color,
        backgroundImageUrl: media.get(l.background_image)?.src || null,
        welcomeHeading: l.welcome_heading,
        welcomeText: l.welcome_text,
        customCss: l.custom_css,
      },
    });
  });
  publicApi.use(publicContentApi(ctx));
  api.use('/public', publicApi);

  // Cookie-session surface: sessions are rebuilt live when the secret / cookie name / TTL change.
  api.use(
    hotSwap(settings, 'security', (v) =>
      session({
        name: v.session_cookie_name,
        secret: v.session_secret,
        store: ctx.sessionStore,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
          httpOnly: true,
          sameSite: 'lax',
          secure: 'auto',
          maxAge: v.session_ttl_hours * 3600_000,
        },
      }),
    ),
  );
  api.use(cookieParser());
  api.use(ctx.csrf.doubleCsrfProtection); // every non-GET below this line needs a valid token
  api.use(loadPrincipal(ctx));
  api.use('/auth', authRoutes(ctx));

  const admin = express.Router();
  admin.use(requirePermission('admin.access'));
  for (const mod of [
    settingsRoutes,
    usersRoutes,
    auditRoutes,
    clusterRoutes,
    systemRoutes,
    updatesRoutes,
    contentRoutes,
    mediaRoutes,
    themesRoutes,
    siteRoutes,
    siteFilesRoutes,
    siteBuilderRoutes,
    siteLocalesRoutes,
    servicesRoutes,
    dbmsRoutes,
    seoRoutes,
    eventsRoutes,
    webhooksRoutes,
    schedulerRoutes,
    sitemapRoutes,
    librariesRoutes,
    analyticsRoutes,
    pluginsRoutes,
    pluginEditorRoutes,
    mediaGeneratorRoutes,
  ])
    admin.use(mod(ctx));
  // A plugin's own admin/backend routes (src/modules/plugins/routes.js) — dispatched dynamically since plugins
  // can be installed/enabled after boot, unlike the fixed module list above.
  admin.use(pluginDispatcher(ctx));
  api.use('/admin', admin);
  api.use(apiNotFound);
  app.use('/api', api);

  // ── Public website: pages, blog, search, sitemap, theme assets (server-rendered with the active theme) ──
  app.use(publicSite(ctx));

  app.use((_req, res) =>
    res.status(404).type('html').send(page('Not found', '<h1>Page not found</h1>')),
  );
  app.use(errorHandler(log, env.isProd));
  return app;
}

const page = (title, body) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1.25rem;color:#1b2b30}a{color:#2b59c3}</style>${body}</html>`;
