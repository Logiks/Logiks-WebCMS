import client from 'prom-client';

/**
 * Prometheus metrics. One registry per context (not the global one), so tests can run several
 * simulated nodes in one process. Expose with the /metrics route (token-protected, off by default).
 *
 * Static instruments are created up front so services can record into them; gauges that read live
 * state (queue depth, pool usage, config version…) are attached later by bind(ctx).
 */
export function createMetrics({ env, version }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ role: env.ROLE });
  client.collectDefaultMetrics({ register: registry, prefix: 'cms_' });

  new client.Gauge({
    name: 'cms_build_info',
    help: 'Build information',
    labelNames: ['version'],
    registers: [registry],
  }).set({ version }, 1);

  const http = new client.Histogram({
    name: 'cms_http_request_duration_seconds',
    help: 'HTTP request duration by route group',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const mail = new client.Counter({
    name: 'cms_mail_total',
    help: 'Emails by outcome',
    labelNames: ['result'],
    registers: [registry],
  });
  const logins = new client.Counter({
    name: 'cms_auth_logins_total',
    help: 'Sign-in attempts by outcome',
    labelNames: ['result'],
    registers: [registry],
  });
  const pageCache = new client.Counter({
    name: 'cms_page_cache_total',
    help: 'Public page requests by cache result (hit, miss, bypass)',
    labelNames: ['result'],
    registers: [registry],
  });
  const resets = new client.Counter({
    name: 'cms_auth_password_resets_total',
    help: 'Password reset events',
    labelNames: ['event'],
    registers: [registry],
  });

  /** Bounded label values: never put ids, tokens or free text into a label. */
  const routeOf = (req) => {
    const path = req.originalUrl.split('?')[0];
    if (!path.startsWith('/api/'))
      return path.startsWith('/admin') ? '/admin' : path === '/' ? '/' : '/other';
    const parts = path
      .split('/')
      .slice(0, 5)
      .map((seg) => (/^\d+$/.test(seg) || seg.length > 24 ? ':id' : seg));
    return parts.join('/');
  };

  // Express middleware: time every request except probes and scrapes.
  const middleware = (req, res, next) => {
    const end = http.startTimer();
    res.on('finish', () =>
      end({ method: req.method, route: routeOf(req), status: String(res.statusCode) }),
    );
    next();
  };

  /** A counter mirroring a monotonically increasing number owned by another service. */
  const mirror = (name, help, labelNames, read) => {
    const last = new Map();
    const c = new client.Counter({
      name,
      help,
      labelNames,
      registers: [registry],
      collect() {
        for (const [labels, value] of read()) {
          const key = JSON.stringify(labels);
          const delta = value - (last.get(key) ?? 0);
          if (delta > 0) this.inc(labels, delta);
          last.set(key, value);
        }
      },
    });
    return c;
  };

  return {
    registry,
    http,
    mail,
    logins,
    resets,
    pageCache,
    middleware,
    contentType: registry.contentType,
    render: () => registry.metrics(),

    /** Attach gauges that read live state from the assembled context. */
    bind(ctx) {
      const g = (name, help, labelNames, collect) =>
        new client.Gauge({ name, help, labelNames, registers: [registry], collect });

      g('cms_config_version', 'Config version this node has applied', [], function () {
        this.set(ctx.settings.version);
      });
      g('cms_node_draining', '1 while this node is draining for shutdown', [], function () {
        this.set(ctx.state.draining ? 1 : 0);
      });
      mirror('cms_settings_events_total', 'Settings sync events on this node', ['kind'], () => [
        [{ kind: 'bus_applied' }, ctx.settings.stats.busApplied],
        [{ kind: 'poll_heal' }, ctx.settings.stats.pollHeals],
        [{ kind: 'full_reload' }, ctx.settings.stats.fullReloads],
      ]);

      g('cms_db_pool_connections', 'Database pool connections by state', ['state'], function () {
        const p = ctx.db.client.pool;
        if (!p) return;
        this.set({ state: 'used' }, p.numUsed());
        this.set({ state: 'free' }, p.numFree());
        this.set({ state: 'pending' }, p.numPendingAcquires());
      });

      g('cms_cache_l1_entries', "Entries in this node's in-memory cache", [], function () {
        this.set(ctx.cache.stats().l1Entries);
      });
      mirror('cms_cache_requests_total', 'Cache lookups by result', ['result'], () => {
        const s = ctx.cache.stats();
        return [
          [{ result: 'l1_hit' }, s.l1Hits],
          [{ result: 'l2_hit' }, s.l2Hits],
          [{ result: 'miss' }, s.misses],
          [{ result: 'error' }, s.errors],
        ];
      });

      g('cms_queue_jobs', 'Background jobs by state', ['state'], async function () {
        try {
          const { counts } = await ctx.jobs.stats();
          for (const [state, n] of Object.entries(counts)) this.set({ state }, n);
        } catch {
          /* queue unreachable: leave the last values */
        }
      });
    },
  };
}
