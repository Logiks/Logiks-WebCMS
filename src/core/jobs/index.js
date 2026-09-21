import { Queue, Worker } from 'bullmq';
import { now } from '../db/index.js';

const QUEUE = 'cms-default';
const ATTEMPTS = 3;

/**
 * Background jobs.
 *  - Redis present → BullMQ. Handlers run only on processes that call `startWorker()`
 *    (ROLE=worker|all). Schedules are upserted by id, so N workers registering the same
 *    schedule still produce ONE run per tick cluster-wide. Failed jobs retry with exponential backoff.
 *  - No Redis (dev / single node) → in-process timers with the same API and the same retry policy.
 *
 *   jobs.define('audit.prune', async (data) => {...})
 *   jobs.schedule('audit.prune', { everyMs: 86_400_000 })
 *   jobs.enqueue('mail.send', { ... })
 *   jobs.stats() / jobs.failed() / jobs.retry(id) / jobs.discard(id)     ← for the admin System page
 */
export function createJobs({ redis, log, backoffMs = 2000 }) {
  const handlers = new Map();
  const schedules = new Map();
  const local = {
    timers: [],
    seq: 0,
    counts: { waiting: 0, active: 0, completed: 0, failed: 0 },
    failed: new Map(),
  };
  let queue = null;
  let worker = null;

  const useBull = redis.enabled;
  const getQueue = () =>
    (queue ??= new Queue(QUEUE, {
      connection: redis.queueConn(),
      prefix: 'cms:bull',
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 500,
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: backoffMs },
      },
    }));

  const run = async (name, data) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`No handler registered for job "${name}"`);
    return h(data ?? {});
  };

  /** In-process execution with the same retry policy as BullMQ. */
  async function runLocal(name, data, id = ++local.seq) {
    local.counts.waiting++;
    for (let attempt = 1; ; attempt++) {
      local.counts.waiting = Math.max(0, local.counts.waiting - (attempt === 1 ? 1 : 0));
      local.counts.active++;
      try {
        await run(name, data);
        local.counts.active--;
        local.counts.completed++;
        return;
      } catch (e) {
        local.counts.active--;
        if (attempt >= ATTEMPTS) {
          local.counts.failed++;
          local.failed.set(String(id), {
            id: String(id),
            name,
            failedReason: e.message,
            attemptsMade: attempt,
            data,
            timestamp: now(),
          });
          if (local.failed.size > 100) local.failed.delete(local.failed.keys().next().value);
          log.error({ job: name, err: e.message }, 'job failed');
          return;
        }
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
      }
    }
  }

  return {
    kind: useBull ? 'bullmq' : 'local',

    define(name, handler) {
      handlers.set(name, handler);
    },

    schedule(name, { everyMs, data = {} }) {
      schedules.set(name, { everyMs, data });
    },

    async enqueue(name, data = {}, opts = {}) {
      if (useBull) return getQueue().add(name, data, opts);
      setImmediate(() => runLocal(name, data));
    },

    /** Begin processing jobs and (re)register schedules. Call only on worker-capable processes. */
    async startWorker() {
      if (useBull) {
        for (const [name, s] of schedules) {
          await getQueue().upsertJobScheduler(
            `sched:${name}`,
            { every: s.everyMs },
            { name, data: s.data },
          );
        }
        worker = new Worker(QUEUE, (job) => run(job.name, job.data), {
          connection: redis.queueConn(),
          prefix: 'cms:bull',
          concurrency: 5,
        });
        worker.on('failed', (job, err) =>
          log.error({ job: job?.name, err: err.message }, 'job failed'),
        );
        worker.on('error', (err) => log.error({ err: err.message }, 'worker error'));
      } else {
        log.warn('No Redis: running jobs in-process (dev/single-node only)');
        for (const [name, s] of schedules) {
          const t = setInterval(() => runLocal(name, s.data), s.everyMs);
          t.unref();
          local.timers.push(t);
        }
      }
      log.info(
        { driver: this.kind, jobs: [...handlers.keys()], scheduled: [...schedules.keys()] },
        'job worker started',
      );
    },

    // ───────── observability + operations ─────────

    /** Queue depth by state, plus the registered schedules. */
    async stats() {
      const scheduled = [...schedules].map(([name, s]) => ({ name, everyMs: s.everyMs }));
      if (!useBull) return { driver: 'local', counts: { ...local.counts, delayed: 0 }, scheduled };
      const counts = await getQueue().getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      );
      return { driver: 'bullmq', counts, scheduled };
    },

    /** Recent failures. Job data is deliberately not returned (it can hold personal data). */
    async failed(limit = 50) {
      const shape = (j) => ({
        id: String(j.id),
        name: j.name,
        failedReason: j.failedReason,
        attemptsMade: j.attemptsMade,
        at: j.finishedOn ?? j.timestamp,
      });
      if (!useBull)
        return [...local.failed.values()]
          .reverse()
          .slice(0, limit)
          .map((j) => shape({ ...j, id: j.id }));
      return (await getQueue().getFailed(0, limit - 1)).map(shape);
    },

    async retry(id) {
      if (!useBull) {
        const j = local.failed.get(String(id));
        if (!j) return false;
        local.failed.delete(String(id));
        local.counts.failed = Math.max(0, local.counts.failed - 1);
        setImmediate(() => runLocal(j.name, j.data));
        return true;
      }
      const job = await getQueue().getJob(String(id));
      if (!job) return false;
      await job.retry();
      return true;
    },

    async discard(id) {
      if (!useBull) return local.failed.delete(String(id));
      const job = await getQueue().getJob(String(id));
      if (!job) return false;
      await job.remove();
      return true;
    },

    /** Finish in-flight jobs, then close. */
    async close() {
      local.timers.forEach(clearInterval);
      await worker?.close();
      await queue?.close();
    },
  };
}

/** Housekeeping jobs every install needs. */
export function registerBuiltinJobs({ jobs, db, settings, audit, sessionStore, nodes, log }) {
  jobs.define('sessions.cleanup', async () => {
    const n = await sessionStore.cleanup();
    if (n) log.info({ deleted: n }, 'expired sessions removed');
  });
  jobs.define('audit.prune', async () => {
    const n = await audit.prune(settings.get('system.audit_retention_days'));
    if (n) log.info({ deleted: n }, 'old audit entries removed');
  });
  jobs.define('nodes.prune', async () => {
    await nodes.prune();
  });
  jobs.define('auth.cleanup', async () => {
    // reset tokens are useless once expired; keep used ones a week for the audit trail
    await db('password_resets')
      .where('expires_at', '<', now() - 7 * 86_400_000)
      .del();
  });
  jobs.schedule('sessions.cleanup', { everyMs: 15 * 60_000 });
  jobs.schedule('audit.prune', { everyMs: 24 * 3600_000 });
  jobs.schedule('nodes.prune', { everyMs: 3600_000 });
  jobs.schedule('auth.cleanup', { everyMs: 24 * 3600_000 });
}
