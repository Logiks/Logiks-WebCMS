import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createLogger } from './core/logger.js';
import { createDb, dialect } from './core/db/index.js';
import { createRedis } from './core/redis.js';
import { createBus } from './core/bus.js';
import { createCrypto } from './core/crypto.js';
import { createRegistry } from './core/settings/registry.js';
import { defineCoreSettings } from './core/settings/definitions.js';
import { SettingsService } from './core/settings/service.js';
import { createPermissions, defineCorePermissions } from './core/auth/permissions.js';
import { createAudit } from './core/audit.js';
import { createAccess } from './core/auth/access.js';
import { createSessionStore } from './core/auth/sessionStore.js';
import { createNodes } from './core/cluster/nodes.js';
import { createJobs, registerBuiltinJobs } from './core/jobs/index.js';
import { createUsersService } from './modules/users/service.js';
import { createMetrics } from './core/metrics.js';
import { createCache } from './core/cache/index.js';
import { createMailer } from './core/mail/index.js';
import { createRecovery } from './modules/auth/recovery.js';
import { createUpdatesService } from './modules/updates/service.js';
import { createContentRegistry, defineCoreContent } from './modules/content/registry.js';
import { createContentService } from './modules/content/service.js';
import { createLocalStorage } from './modules/media/storage.js';
import { createMediaService } from './modules/media/service.js';
import { createThemesService } from './modules/themes/service.js';
import { createServices } from './modules/services/service.js';
import { createDbms } from './modules/dbms/service.js';
import { createSeo } from './modules/seo/service.js';
import { createEvents } from './modules/events/service.js';
import { createWebhooks, registerWebhookJobs } from './modules/webhooks/service.js';
import { createScheduler, registerSchedulerJobs } from './modules/scheduler/service.js';
import { createSearchService } from './modules/search/service.js';
import { createSiteService } from './modules/site/service.js';
import { createSiteFiles } from './modules/site/files.js';
import { createSitePages } from './modules/site/sitepages.js';
import { createPublicData } from './modules/site/data.js';
import { createI18n } from './modules/site/i18n.js';
import { createSitemap, defineSitemapSettings } from './modules/sitemap/service.js';
import { createLibraries, defineLibrariesSettings } from './modules/libraries/service.js';
import { createAnalyticsService } from './modules/analytics/service.js';
import { createPlugins } from './modules/plugins/service.js';
import { createPluginEditor, defineAiSettings } from './modules/plugin-editor/service.js';
import {
  createMediaGenerator,
  defineMediaGeneratorSettings,
} from './modules/media-generator/service.js';
import { createPageDesigner } from './modules/page-designer/service.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * Builds every shared service once per process. Nothing here listens on a port;
 * server.js decides what to run based on ROLE.
 *
 * Modules extend the platform through the registries on the context:
 *   ctx.settings.registry.define(...)   ctx.permissions.define(...)   ctx.jobs.define(...)
 *
 * @param {{env: import('./core/env.js').Env, bus?: any, log?: import('pino').Logger, appRoot?: string}} opts
 *        `bus` can be injected (tests share one MemoryBus between simulated nodes); `appRoot` points the updates module at another checkout (tests).
 */
export async function createContext({ env, bus: busOverride, log: logOverride, appRoot }) {
  const log = logOverride ?? createLogger(env);
  const db = createDb(env);
  const redis = createRedis(env, log);
  const bus = busOverride ?? createBus(env, redis, log);
  const crypto = createCrypto(env);

  // Migrations are a pipeline step in production. Everywhere else we apply them for convenience.
  const [, pending] = await db.migrate.list();
  if (pending.length) {
    if (env.isProd)
      throw new Error(
        `${pending.length} pending database migration(s). Run "npm run migrate" as a deploy step before starting servers.`,
      );
    log.info({ pending: pending.length }, 'applying pending migrations');
    await db.migrate.latest();
  }

  const registry = createRegistry();
  defineCoreSettings(registry);
  defineSitemapSettings(registry);
  defineLibrariesSettings(registry);
  defineAiSettings(registry);
  defineMediaGeneratorSettings(registry);
  const permissions = createPermissions();
  defineCorePermissions(permissions);

  const audit = createAudit({ db, log });
  const state = { draining: false, ready: false };
  const settings = new SettingsService({ env, db, crypto, bus, log, registry, audit });
  await settings.start();

  // Runtime log level is a cluster-wide setting (falls back to LOG_LEVEL).
  const applyLogLevel = (v) => {
    log.level = v.log_level === 'default' ? env.LOG_LEVEL : v.log_level;
  };
  settings.onChange('system', applyLogLevel);
  applyLogLevel(settings.ns('system'));

  const access = createAccess({ db, bus, permissions, log });
  const sessionStore = createSessionStore({ redis, db });
  const metrics = createMetrics({ env, version: pkg.version });
  const users = createUsersService({
    db,
    settings,
    access,
    audit,
    permissions,
    sessionStore,
    metrics,
    events: () => ctx.events, // the context is complete by the time a user is actually created
  });
  const nodes = createNodes({ env, db, settings, state, log, appVersion: pkg.version });
  const jobs = createJobs({ redis, log, backoffMs: env.JOB_BACKOFF_MS });
  registerBuiltinJobs({ jobs, db, settings, audit, sessionStore, nodes, log });
  const cache = createCache({ env, redis, bus, settings, log });
  const mailer = createMailer({ env, settings, jobs, crypto, log, metrics });
  mailer.register();
  const recovery = createRecovery({ db, settings, users, mailer, audit, log, metrics });
  const webhooks = createWebhooks({
    db,
    dialect: dialect(db),
    cache,
    audit,
    crypto,
    jobs,
    settings,
    log,
  });
  registerWebhookJobs({ jobs, webhooks });
  const events = createEvents({ db, dialect: dialect(db), jobs, log });
  jobs.define('events.prune', async () => {
    const n = await events.prune(settings.get('automation.events_retention_days'));
    if (n) log.info({ deleted: n }, 'old events pruned');
  });
  jobs.define('webhooks.prune_deliveries', async () => {
    const n = await webhooks.pruneDeliveries(
      settings.get('automation.webhook_delivery_retention_days'),
    );
    if (n) log.info({ deleted: n }, 'old webhook deliveries pruned');
  });
  jobs.schedule('events.prune', { everyMs: 24 * 3600_000 });
  jobs.schedule('webhooks.prune_deliveries', { everyMs: 24 * 3600_000 });

  // Activity/analytics (D-056): every record() call is queued (never inline), so a cached page's p95 never waits
  // on a write here — the same "queue it" principle as email (D-014) and webhook delivery (D-050).
  const analytics = createAnalyticsService({ db, dialect: dialect(db) });
  jobs.define('analytics.record', async (data) => {
    await analytics.record(data);
  });
  jobs.define('analytics.prune', async () => {
    const n = await analytics.prune(settings.get('analytics.retention_days'));
    if (n) log.info({ deleted: n }, 'old activity data pruned');
  });
  jobs.schedule('analytics.prune', { everyMs: 24 * 3600_000 });

  const updates = createUpdatesService({
    env,
    db,
    settings,
    bus,
    audit,
    nodes,
    state,
    log,
    appRoot: appRoot ?? fileURLToPath(new URL('..', import.meta.url)),
  });
  await updates.start();

  permissions.define('Content', {
    'content.terms.manage': 'Manage categories and tags',
    // Deliberately separate from audit.read (System, administrator-tier): an editor/author who has no business
    // seeing security-sensitive audit rows (logins, settings, webhooks…) can still see who created, edited,
    // published, restored or deleted a page, entry or piece of media — the same audit_logs data, filtered to
    // content-authoring actions only.
    'content.activity':
      'View content and page activity (who created, edited, published or deleted something)',
  });
  const contentRegistry = createContentRegistry({ permissions });
  defineCoreContent(contentRegistry);
  const content = Object.assign(
    createContentService({
      db,
      dialect: dialect(db),
      audit,
      cache,
      settings,
      registry: contentRegistry,
      log,
    }),
    { registry: contentRegistry },
  );
  // Built-in content events (docs/DECISIONS.md D-050) — reuses content's own change notifier (search already
  // subscribes to the same one to reindex), so content/service.js itself needed no changes.
  content.onChange(async ({ type, entry, before }) => {
    const wasPublished = before?.status === 'published';
    if (type === 'save' && entry.status === 'published')
      await events.emit(wasPublished ? 'content.updated' : 'content.published', {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        path: entry.path,
      });
    else if (type === 'delete' && wasPublished)
      await events.emit('content.deleted', { id: entry.id, type: entry.type, title: entry.title });
  });
  const storage = createLocalStorage(env.MEDIA_DIR);
  const media = createMediaService({
    db,
    dialect: dialect(db),
    storage,
    settings,
    audit,
    cache,
    log,
    fieldNames: () => [
      'mediaId',
      ...contentRegistry.types().flatMap((t) =>
        Object.values(t.fields)
          .filter((f) => f.type === 'media')
          .map((f) => f.key),
      ),
    ],
  });
  const themes = createThemesService({
    env,
    db,
    settings,
    bus,
    audit,
    cache,
    log,
    appRoot: fileURLToPath(new URL('..', import.meta.url)), // themes ship with the running code, whatever checkout the updater manages
  });
  await themes.start();
  const siteFiles = createSiteFiles({
    env,
    db,
    bus,
    settings,
    audit,
    cache,
    log,
    dialect: dialect(db),
    defaultsDir: fileURLToPath(new URL('../site/defaults', import.meta.url)),
  });
  await siteFiles.start();
  const libraries = createLibraries({ env, db, settings, bus, audit, cache, log });
  await libraries.start();
  const dbms = createDbms({ db, dialect: dialect(db), audit });
  const seo = createSeo({ db, dialect: dialect(db), cache, audit });
  const search = createSearchService({ db, dialect: dialect(db), content, log });
  search.attach();
  jobs.define('search.reindex', async () => {
    await search.reindex();
  });
  const site = createSiteService({
    db,
    dialect: dialect(db),
    settings,
    content,
    cache,
    audit,
    mailer,
    events,
    log,
    pages: () => ctx.sitePages, // addresses come from the site tree; the context is complete by the time this is called
  });
  // Site identity, theme choice and theme settings (incl. custom CSS) appear on every page, and so do library tags (whether
  // library scripts are allowed), so a change to any of them refreshes every cached page.
  settings.onChange('*', (_next, _prev, ns) => {
    if (
      ['general', 'site', 'seo', 'content', 'features', 'libraries', 'analytics'].includes(ns) ||
      ns.startsWith('theme_')
    )
      return cache.invalidate(['site']);
  });
  settings.onChange('sitemap', () => cache.invalidate(['sitemap']));
  jobs.define('content.publish_due', async () => {
    await content.publishDue();
  });
  jobs.schedule('content.publish_due', { everyMs: 60_000 });

  state.ready = true;

  const ctx = {
    env,
    log,
    // Bound to this file's own location, so a plugin's server.js can `ctx.require('express')` for an npm package
    // the app already depends on, regardless of where plugins/<slug>/ physically lives on disk (it needn't sit
    // inside the app's own node_modules resolution chain — a top-level `import 'express'` in a dynamically
    // `import()`-ed plugin file would fail to resolve; `node:`-prefixed built-ins are unaffected and need no help).
    require: createRequire(import.meta.url),
    db,
    dialect: dialect(db),
    redis,
    bus,
    crypto,
    registry,
    permissions,
    audit,
    settings,
    access,
    sessionStore,
    users,
    nodes,
    jobs,
    cache,
    mailer,
    recovery,
    updates,
    content,
    media,
    storage,
    themes,
    siteFiles,
    libraries,
    dbms,
    seo,
    events,
    webhooks,
    analytics,
    search,
    site,
    metrics,
    state,
    version: pkg.version,
    async shutdown() {
      settings.stop();
      updates.stop();
      themes.stop();
      libraries.stop();
      ctx.plugins.stop();
      await siteFiles.stop();
      await nodes.stop();
      await jobs.close();
      await mailer.close();
      await bus.close();
      await redis.close();
      await db.destroy();
    },
  };
  // These read the finished context (content, media, site, search…) on every call.
  ctx.i18n = createI18n(ctx, {
    shippedDir: fileURLToPath(new URL('../site/locales', import.meta.url)),
  });
  // Passed the whole ctx (not destructured deps) because a script Service (D-046) gets the full platform context
  // at RUN time, well after every one of these is finished — by construction time it only needs `content`.
  ctx.services = createServices(ctx);
  // Also needs the finished ctx: it runs an existing Service (ctx.services) or fires a Webhook (ctx.webhooks) on
  // an admin-editable schedule (D-051) built on ctx.jobs.reschedule()/unschedule().
  ctx.scheduler = createScheduler(ctx);
  registerSchedulerJobs(ctx);
  await ctx.scheduler.reloadAll();
  ctx.publicData = createPublicData(ctx);
  ctx.sitePages = createSitePages(ctx);
  // Also needs the finished ctx: a plugin's server.js factory runs at load time (well after every other service is
  // built) and gets the complete ctx, the same reasoning as ctx.services (D-046).
  ctx.plugins = createPlugins(ctx, { pluginsDir: env.PLUGINS_DIR });
  await ctx.plugins.start();
  // Also needs the finished ctx (db, settings, audit) and the same PLUGINS_DIR plugins itself uses — a Plugin
  // Editor session writes real plugin files on disk, it never touches the `plugins` table (D-063).
  ctx.pluginEditor = createPluginEditor(ctx, { pluginsDir: env.PLUGINS_DIR });
  // Media Manager → Media Generator (D-064): needs settings (provider keys) and media.upload (the actual save).
  ctx.mediaGenerator = createMediaGenerator(ctx);
  // Webmaster → AI Page Designer (D-065): needs the whole finished ctx — siteFiles/sitePages/themes/site (compose
  // and preview a page), content (site_context), media/mediaGenerator (image tools), dbms/services (the
  // table+Service proposal) and settings.ns('ai') (reuses Plugin Editor's Anthropic credentials, D-063).
  ctx.pageDesigner = createPageDesigner(ctx);
  ctx.sitemap = createSitemap({
    settings,
    content,
    cache,
    db,
    audit,
    site,
    pages: () => ctx.sitePages,
  });
  metrics.bind(ctx);
  return ctx;
}
