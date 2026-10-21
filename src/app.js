import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { pinoHttp } from 'pino-http';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hotSwap } from './core/http/hotswap.js';
import { createLimiters } from './core/http/limits.js';
import { createCsrf } from './core/http/csrf.js';
import { apiNotFound, errorHandler } from './core/http/errors.js';
import { healthRoutes } from './core/http/health.js';
import { loadPrincipal, requirePermission } from './core/http/middleware.js';
import { mediaPublicRoute } from './modules/media/routes.js';
import { libraryPublicRoute } from './modules/libraries/routes.js';
import { pluginDispatcher, pluginAdminFragments } from './modules/plugins/routes.js';
import publicSite from './modules/site/public.js';
import publicContentApi from './modules/site/api.js';
import { apiKeyAuth } from './modules/api/middleware.js';
import { envelope } from './core/api/envelope.js';
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
      'csp_font_sources',
      'csp_style_sources',
      'csp_script_sources',
      'csp_object_sources',
      'csp_form_actions',
      'csp_base_uri',
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
  // Monaco (the page editor's code editor, D-105): the prebuilt AMD build, served as-is. Its language workers have
  // content-hashed file names, so a small redirect turns "the html worker" into whatever this install's file is called
  // (same origin, so the CSP needs no `blob:`).
  const monacoDir = path.join(pkgDir('monaco-editor'), 'min/vs');
  app.use('/admin/vendor/monaco/vs', express.static(monacoDir, cache));
  app.get('/admin/vendor/monaco-worker/:label', (req, res) => {
    const label =
      {
        typescript: 'ts',
        javascript: 'ts',
        handlebars: 'html',
        razor: 'html',
        less: 'css',
        scss: 'css',
      }[req.params.label] ?? req.params.label;
    const file = fs.existsSync(path.join(monacoDir, 'assets'))
      ? fs.readdirSync(path.join(monacoDir, 'assets')).find((f) => f.startsWith(`${label}.worker-`))
      : null;
    if (!file) return res.status(404).end();
    res.redirect(302, `/admin/vendor/monaco/vs/assets/${file}`);
  });
  app.use('/admin/vendor/prismjs', express.static(pkgDir('prismjs'), cache));
  app.use('/admin/vendor/plex-sans', express.static(pkgDir('@fontsource/ibm-plex-sans'), cache));
  app.use('/admin/vendor/plex-mono', express.static(pkgDir('@fontsource/ibm-plex-mono'), cache));
  // The admin's own screens (app.js, CSS, each module's HTML fragments) change with every update, unlike the vendor files
  // above, which are versioned by package. They must be revalidated on every load (ETag, so an unchanged file costs a 304):
  // a browser that kept an old fragment for days simply never showed buttons added since (Templates, Library).
  const revalidate = {
    etag: true,
    setHeaders: (/** @type {any} */ res) => res.setHeader('Cache-Control', 'no-cache'),
  };
  app.use('/admin/static', express.static(path.join(ROOT, 'admin/static'), revalidate));
  // Each module's own admin-screen HTML fragments (fetched lazily by the SPA, `H.mountFragment` in
  // app.js) — a module owns its admin markup under its own directory rather than one central file,
  // so it stays self-contained if it's ever copied/removed between installations. Auto-discovered:
  // adding or removing a module's admin/ folder needs no change here.
  for (const name of fs.readdirSync(path.join(ROOT, 'src/modules'))) {
    const dir = path.join(ROOT, 'src/modules', name, 'admin');
    if (fs.existsSync(dir)) app.use(`/admin/modules/${name}`, express.static(dir, revalidate));
  }
  // A plugin's own admin/*.html, unlike the fixed loop above, can appear or disappear after boot (install/enable),
  // so it's served by a small dynamic middleware (src/modules/plugins/routes.js) instead of a fixed static mount.
  app.use(pluginAdminFragments(ctx));
  // Cache buster: the shell's own assets and the SPA's fragment fetches carry ?v=<fingerprint of the admin files>, so a
  // browser (or CDN/ALB) never pairs a new index.html with an old app.js. Computed once at boot: an update restarts the node.
  const adminVersion = adminFingerprint(
    path.join(ROOT, 'admin/static'),
    path.join(ROOT, 'src/modules'),
  );
  const adminShell = fs
    .readFileSync(path.join(ROOT, 'admin/static/index.html'), 'utf8')
    .replace(/(["'])(\/admin\/static\/[^"'?]+)\1/g, `$1$2?v=${adminVersion}$1`)
    .replace('<head>', `<head>\n  <meta name="admin-version" content="${adminVersion}">`);
  app.get(['/admin', '/admin/*splat'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(adminShell);
  });

  // Uploaded files and installed libraries (public, cookie-less, immutable)
  app.get('/media/:id/:file', mediaPublicRoute(ctx));
  app.use(libraryPublicRoute(ctx));

  // ── API ──
  const api = express.Router();
  api.use(express.json({ limit: '1mb' })); // rich content is sent as one JSON document
  api.use(['/public', '/v1'], apiKeyAuth(ctx)); // identify a machine client before counting the request
  api.use(ctx.limiters.api);

  // Public, cookie-less, CORS-enabled surface (headless clients). Origins come from settings, live. Two addresses, one
  // implementation (D-068): /api/v1 wraps successes in { data, meta }; /api/public is the original, raw-body address.
  const publicApi = (v1) => {
    const router = express.Router();
    router.use(
      cors({
        origin: (origin, cb) =>
          cb(null, !origin || settings.get('security.cors_origins').includes(origin)),
        methods: v1 ? ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'] : ['GET', 'HEAD', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'X-API-Key', 'Content-Type'],
        maxAge: 600,
      }),
    );
    router.get('/info', async (_req, res) => {
      const g = settings.ns('general');
      const l = settings.ns('login');
      const media = await ctx.media.describeMany(
        [l.logo, l.favicon, l.background_image].filter(Boolean),
      );
      res.set('Cache-Control', 'public, max-age=30');
      const info = {
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
      };
      res.json(v1 ? envelope(info) : info);
    });
    router.use(publicContentApi(ctx, { v1 }));
    return router;
  };
  api.use('/public', publicApi(false));
  api.use('/v1', publicApi(true));

  // Cookie-session surface: sessions are rebuilt live when the secret / cookie name / TTL change.
  api.use(
    hotSwap(settings, 'security', (v) =>
      session({
        name: v.session_cookie_name,
        secret: v.session_secret,
        store: ctx.sessionStore,
        resave: false,
        saveUninitialized: false,
        // Not rolling: the maximum session length counts from sign-in. Inactivity is tracked below instead, because
        // rolling renewed the session on every request, including a screen's own background refreshes, so it never ended.
        rolling: false,
        cookie: {
          httpOnly: true,
          sameSite: 'lax',
          secure: 'auto',
          maxAge: v.session_ttl_hours * 3600_000,
        },
      }),
    ),
  );
  // Inactivity sign-out. A browser tab says how long its person has been idle (X-User-Idle, seconds); a request from a
  // screen refreshing itself arrives with a long idle time and so does not keep the session alive. Requests without the
  // header (scripts, API clients) count as activity.
  api.use((req, _res, next) => {
    const s = /** @type {any} */ (req.session);
    if (!s?.userId) return next();
    const idleMs = Number(settings.get('security.session_idle_minutes')) * 60_000;
    const t = Date.now();
    const last = Number(s.lastActive) || t;
    if (idleMs > 0 && t - last > idleMs) return s.regenerate(() => next());
    const header = req.headers['x-user-idle'];
    const active = header === undefined || Number(header) < 30;
    if (active && t - last > 15_000) s.lastActive = t;
    else if (!s.lastActive) s.lastActive = t;
    next();
  });
  api.use(cookieParser());
  api.use(ctx.csrf.doubleCsrfProtection); // every non-GET below this line needs a valid token
  api.use(loadPrincipal(ctx));
  ctx.modules.mount('auth', api, ctx, '/auth');

  const admin = express.Router();
  admin.use(requirePermission('admin.access'));
  // Every module's admin routers, in module order (src/modules/index.js, ordered by each manifest's `requires`; D-067).
  ctx.modules.mount('admin', admin, ctx);
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

/** Short hash of every admin file's path, size and mtime (static dir + each module's admin/ fragments). */
function adminFingerprint(/** @type {string} */ staticDir, /** @type {string} */ modulesDir) {
  const h = createHash('sha1');
  const walk = (/** @type {string} */ dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else {
        const st = fs.statSync(f);
        h.update(`${f}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(staticDir);
  for (const m of fs.readdirSync(modulesDir)) walk(path.join(modulesDir, m, 'admin'));
  return h.digest('hex').slice(0, 10);
}
