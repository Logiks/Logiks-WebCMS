import { performance } from 'node:perf_hooks';
import { Router } from 'express';

const withTimeout = (p, ms = 2000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/**
 *  /healthz  liveness  — the process is up. Never touches dependencies.
 *  /readyz   readiness — safe to receive traffic: config loaded, DB + Redis reachable, not draining.
 *            Point the ALB target group at /readyz.
 */
export function healthRoutes(ctx) {
  const r = Router();
  r.get('/healthz', (_req, res) => res.json({ status: 'ok', node: ctx.env.nodeId }));

  r.get('/readyz', async (_req, res) => {
    const checks = { draining: !ctx.state.draining, config: ctx.state.ready };
    try {
      await withTimeout(ctx.dialect.ping());
      checks.database = true;
    } catch {
      checks.database = false;
    }
    if (ctx.redis.enabled) {
      try {
        checks.redis = await withTimeout(ctx.redis.ping());
      } catch {
        checks.redis = false;
      }
    }
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ready' : 'not_ready',
      node: ctx.env.nodeId,
      configVersion: ctx.settings.version,
      checks,
    });
  });
  return r;
}

/** Detailed component health for the admin System screen (authenticated; never used by load balancers). */
export async function healthDetails(ctx) {
  const timed = async (fn) => {
    const t0 = performance.now();
    try {
      const value = await withTimeout(fn());
      return { ok: true, ms: Math.round(performance.now() - t0), value };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  const [database, redis, queue] = await Promise.all([
    timed(() => ctx.dialect.ping()),
    ctx.redis.enabled ? timed(() => ctx.redis.ping()) : null,
    timed(() => ctx.jobs.stats()),
  ]);
  const mem = process.memoryUsage();
  const mail = ctx.settings.ns('mail');
  return {
    version: ctx.version,
    node: ctx.env.nodeId,
    role: ctx.env.ROLE,
    environment: ctx.env.NODE_ENV,
    uptimeSeconds: Math.floor(process.uptime()),
    configVersion: ctx.settings.version,
    draining: ctx.state.draining,
    process: {
      node: process.version,
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
    },
    components: {
      database: { ok: database.ok, ms: database.ms, error: database.error, kind: ctx.dialect.kind },
      redis: redis ? { ok: redis.ok, ms: redis.ms, error: redis.error } : null,
      queue: { ok: queue.ok, ms: queue.ms, error: queue.error, ...(queue.value ?? {}) },
      mail: { enabled: ctx.mailer.enabled(), transport: mail.transport },
      metrics: { enabled: ctx.settings.get('system.metrics_enabled') },
    },
    cache: ctx.cache.stats(),
  };
}
