import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { createSearchService } from './modules/search/service.js';
import { createSiteService } from './modules/site/service.js';
import { createSiteFiles } from './modules/site/files.js';
import { createSitePages } from './modules/site/sitepages.js';
import { createPublicData } from './modules/site/data.js';
import { createI18n } from './modules/site/i18n.js';

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
  });
  const nodes = createNodes({ env, db, settings, state, log, appVersion: pkg.version });
  const jobs = createJobs({ redis, log, backoffMs: env.JOB_BACKOFF_MS });
  registerBuiltinJobs({ jobs, db, settings, audit, sessionStore, nodes, log });
  const cache = createCache({ env, redis, bus, settings, log });
  const mailer = createMailer({ env, settings, jobs, crypto, log, metrics });
  mailer.register();
  const recovery = createRecovery({ db, settings, users, mailer, audit, log, metrics });

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

  permissions.define('Content', { 'content.terms.manage': 'Manage categories and tags' });
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
    log,
    pages: () => ctx.sitePages, // addresses come from the site tree; the context is complete by the time this is called
  });
  // Site identity, theme choice and theme settings appear on every page, so a change to any of them refreshes every cached page.
  settings.onChange('*', (_next, _prev, ns) => {
    if (['general', 'site', 'content', 'features'].includes(ns) || ns.startsWith('theme_'))
      return cache.invalidate(['site']);
  });
  jobs.define('content.publish_due', async () => {
    await content.publishDue();
  });
  jobs.schedule('content.publish_due', { everyMs: 60_000 });

  state.ready = true;

  const ctx = {
    env,
    log,
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
    search,
    site,
    metrics,
    state,
    version: pkg.version,
    async shutdown() {
      settings.stop();
      updates.stop();
      themes.stop();
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
  ctx.publicData = createPublicData(ctx);
  ctx.sitePages = createSitePages(ctx);
  metrics.bind(ctx);
  return ctx;
}
