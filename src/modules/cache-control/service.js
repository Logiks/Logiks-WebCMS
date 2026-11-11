/**
 * System → Cache (D-136): clear what the servers keep so a change shows at once, and switch server-side caching off while
 * developing. It adds no cache of its own; it drives the ones that exist:
 *  - the shared cache (`ctx.cache`: rendered pages, public data, API answers; memory per server in front of Redis),
 *  - each server's compiled site (templates and components, rebuilt on the next request),
 *  - the theme and library lists each server keeps in memory.
 * "Switch off" is the existing setting `cache.enabled`, so it is cluster-wide, immediate and audited like any setting; with it
 * off nothing is stored or served from the cache, and pages, API answers and files are sent with no-store so a browser or CDN
 * does not keep them either.
 * @param {any} ctx
 */
export const COMPILED = 'site:clear-compiled';
export const SCOPES = {
  pages: 'Rendered pages',
  templates: 'Templates and components',
  everything: 'Everything',
};

export function createCacheControl(ctx) {
  const { cache, settings, audit, bus } = ctx;

  /** Every server drops its compiled site (they rebuild lazily from the site tree on the next request). */
  const clearCompiledEverywhere = async () => {
    ctx.sitePages?.clearCompiled?.();
    await bus.publish(COMPILED, {}).catch(() => {});
  };

  return {
    /** What this server knows. Counters are per server, not cluster-wide. */
    async status() {
      const recent = await audit.list({ action: 'cache.', limit: 8 }).catch(() => []);
      return {
        enabled: !!settings.get('cache.enabled'),
        pageSeconds: Number(settings.get('site.page_cache_seconds')),
        defaultSeconds: Number(settings.get('cache.default_ttl_seconds')),
        stats: cache.stats(),
        recent: recent.map((e) => ({
          at: e.at,
          action: e.action,
          scope: e.meta?.scope ?? null,
          enabled: e.meta?.enabled ?? null,
          by: e.meta?.by ?? e.actor ?? null,
        })),
        scopes: SCOPES,
      };
    },

    /** @param {'pages'|'templates'|'everything'} scope */
    async clear(scope, actor) {
      if (!SCOPES[scope]) throw new Error('Unknown scope.');
      if (scope === 'pages') await cache.invalidate(['sitefiles']);
      else if (scope === 'templates') {
        await clearCompiledEverywhere();
        await cache.invalidate(['sitefiles']);
      } else {
        await cache.flush();
        await clearCompiledEverywhere();
        await ctx.themes?.reload?.().catch(() => {});
        await bus.publish('libraries:changed', {}).catch(() => {});
      }
      await audit.log({
        actor,
        action: 'cache.cleared',
        entity: 'cache',
        meta: { scope, by: actor?.email ?? null },
      });
      return { cleared: scope };
    },

    /** Turns server-side caching off (or back on) for every server. */
    async setEnabled(enabled, actor) {
      await settings.update('cache', { values: { enabled: !!enabled } }, actor);
      // Whatever was stored must not come back when it is switched on again.
      if (!enabled) await cache.flush().catch(() => {});
      await audit.log({
        actor,
        action: 'cache.switched',
        entity: 'cache',
        meta: { enabled: !!enabled, by: actor?.email ?? null },
      });
      return { enabled: !!enabled };
    },
  };
}
