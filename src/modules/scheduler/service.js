import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { HttpError, notFound, parse } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';

/**
 * Scheduler (docs/DECISIONS.md D-051, Phase 2 of the Events/Webhooks/Scheduler plan): admin-editable recurring
 * automation — run a saved Service, or fire a Webhook, on an interval or a cron schedule. Built entirely on top of
 * `ctx.jobs.reschedule()`/`unschedule()` (src/core/jobs/index.js), which this phase added specifically so a
 * schedule can be added, changed or removed at runtime instead of only being fixed at process boot.
 * @param {any} ctx
 */
export function createScheduler(ctx) {
  const { db, dialect, audit, jobs, services, webhooks } = ctx;

  const taskSchema = z
    .object({
      name: z.string().trim().min(1).max(200),
      kind: z.enum(['service', 'webhook']),
      target: z.string().trim().min(1).max(200),
      scheduleType: z.enum(['interval', 'cron']),
      // At least a minute — this runs real work (a Service, a Webhook), not a cheap housekeeping tick.
      everyMs: z
        .number()
        .int()
        .min(60_000)
        .max(30 * 86_400_000)
        .optional(),
      cronExpr: z.string().trim().min(1).max(100).optional(),
      enabled: z.boolean().default(true),
      params: z.record(z.string(), z.unknown()).default({}),
    })
    .refine((v) => (v.scheduleType === 'interval' ? v.everyMs != null : !!v.cronExpr), {
      message:
        'Give an interval (at least a minute) or a cron expression, matching the schedule type chosen.',
    });

  async function checkTarget(kind, target) {
    if (kind === 'service') {
      const defn = await services.get(target).catch(() => null);
      if (!defn)
        throw new HttpError(422, 'invalid_input', `There is no Service "${target}".`, {
          field: 'target',
        });
    } else {
      const webhook = await webhooks.get(target).catch(() => null);
      if (!webhook)
        throw new HttpError(422, 'invalid_input', `There is no webhook #${target}.`, {
          field: 'target',
        });
    }
  }

  function checkCron(expr) {
    try {
      CronExpressionParser.parse(expr);
    } catch {
      throw new HttpError(422, 'invalid_input', `"${expr}" isn't a valid cron expression.`, {
        field: 'cronExpr',
      });
    }
  }

  // Every task gets its own scheduleId (so it can be replaced/removed independently), but they all share ONE
  // registered job handler ('scheduler.run_task', see registerSchedulerJobs below) — told apart by { taskId }.
  const RUN_TASK_JOB = 'scheduler.run_task';
  const scheduleIdOf = (id) => `${RUN_TASK_JOB}:${id}`;

  /** Arms (enabled) or removes (disabled) this task's live schedule. Never touches the DB row. */
  async function arm(id, defn) {
    if (!defn.enabled) {
      await jobs.unschedule(scheduleIdOf(id));
      return;
    }
    const opts = defn.scheduleType === 'cron' ? { cron: defn.cronExpr } : { everyMs: defn.everyMs };
    await jobs.reschedule(scheduleIdOf(id), opts, { taskId: id }, RUN_TASK_JOB);
  }

  const row = (r) => ({
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    target: r.target,
    scheduleType: r.schedule_type,
    everyMs: r.every_ms ?? undefined,
    cronExpr: r.cron_expr ?? undefined,
    enabled: !!r.enabled,
    params: r.params ? JSON.parse(r.params) : {},
    lastRunAt: r.last_run_at ?? undefined,
    lastStatus: r.last_status ?? undefined,
    lastError: r.last_error ?? undefined,
    updatedAt: Number(r.updated_at),
  });

  const svc = {
    async list() {
      return (await db('scheduled_tasks').orderBy('name')).map(row);
    },
    async get(id) {
      const r = await db('scheduled_tasks')
        .where({ id: Number(id) })
        .first();
      if (!r) throw notFound('That scheduled task');
      return row(r);
    },
    async create(input, actor) {
      const defn = parse(taskSchema, input);
      await checkTarget(defn.kind, defn.target);
      if (defn.scheduleType === 'cron') checkCron(defn.cronExpr);
      const t = now();
      const id = await dialect.insertGetId(
        db('scheduled_tasks'),
        {
          name: defn.name,
          kind: defn.kind,
          target: defn.target,
          schedule_type: defn.scheduleType,
          every_ms: defn.everyMs ?? null,
          cron_expr: defn.cronExpr ?? null,
          enabled: defn.enabled,
          params: JSON.stringify(defn.params),
          created_by: actor?.id ?? null,
          updated_by: actor?.id ?? null,
          created_at: t,
          updated_at: t,
        },
        'id',
      );
      await arm(id, defn);
      await audit.log({
        actor,
        action: 'scheduler.task_created',
        entity: 'scheduled_task',
        entityId: id,
      });
      return svc.get(id);
    },
    async update(id, input, actor) {
      const existing = await db('scheduled_tasks')
        .where({ id: Number(id) })
        .first();
      if (!existing) throw notFound('That scheduled task');
      const defn = parse(taskSchema, input);
      await checkTarget(defn.kind, defn.target);
      if (defn.scheduleType === 'cron') checkCron(defn.cronExpr);
      await db('scheduled_tasks')
        .where({ id: Number(id) })
        .update({
          name: defn.name,
          kind: defn.kind,
          target: defn.target,
          schedule_type: defn.scheduleType,
          every_ms: defn.everyMs ?? null,
          cron_expr: defn.cronExpr ?? null,
          enabled: defn.enabled,
          params: JSON.stringify(defn.params),
          updated_by: actor?.id ?? null,
          updated_at: now(),
        });
      await arm(Number(id), defn);
      await audit.log({
        actor,
        action: 'scheduler.task_updated',
        entity: 'scheduled_task',
        entityId: id,
      });
      return svc.get(id);
    },
    async remove(id, actor) {
      const existing = await db('scheduled_tasks')
        .where({ id: Number(id) })
        .first();
      if (!existing) throw notFound('That scheduled task');
      await jobs.unschedule(scheduleIdOf(Number(id)));
      await db('scheduled_tasks')
        .where({ id: Number(id) })
        .del();
      await audit.log({
        actor,
        action: 'scheduler.task_deleted',
        entity: 'scheduled_task',
        entityId: id,
      });
    },

    /** Webmaster → Scheduler: "Run now" — bypasses the schedule, same execution path as a real firing. */
    async runNow(id, actor) {
      const task = await svc.get(id);
      await audit.log({
        actor,
        action: 'scheduler.task_run_now',
        entity: 'scheduled_task',
        entityId: id,
      });
      await jobs.enqueue('scheduler.run_task', { taskId: task.id });
    },

    /** Records the outcome of a run. Called by the job handler, never by the admin API directly. */
    async recordRun(id, { status, error }) {
      await db('scheduled_tasks')
        .where({ id: Number(id) })
        .update({ last_run_at: now(), last_status: status, last_error: error ?? null });
    },

    /**
     * Re-arms every enabled task's live schedule. Called once at boot on every process: harmless to call more
     * than once (arm() just re-upserts), and necessary because a schedule otherwise only exists in Redis (lost if
     * it's ever flushed/replaced) or, in local no-Redis mode, only in this one process's memory (lost on every
     * restart, since there is no separate persistent queue to remember it for you).
     */
    async reloadAll() {
      for (const task of await svc.list()) {
        if (task.enabled) await arm(task.id, task).catch(() => {});
      }
    },

    /** A cron expression's next few run times, or an error — the Scheduler editor's "what does this mean" preview. */
    previewCron(expr, count = 3) {
      try {
        const it = CronExpressionParser.parse(expr);
        return { next: Array.from({ length: count }, () => it.next().getTime()) };
      } catch (e) {
        return { error: e.message };
      }
    },
  };
  return svc;
}

/**
 * Registers the one job handler every scheduled task runs on top of. Takes the whole `ctx` (not destructured
 * dependencies) because `ctx.publicData` — needed by a query-mode Service over a content type — is itself built
 * right after `ctx.scheduler` (it reads the finished context), so it must be looked up at RUN time, well after
 * this function is called during context construction — same reasoning as the `pages: () => ctx.sitePages`
 * lazy accessor already used elsewhere in context.js.
 * @param {any} ctx
 */
export function registerSchedulerJobs(ctx) {
  const { jobs, scheduler, services } = ctx;
  jobs.define('scheduler.run_task', async ({ taskId }) => {
    const task = await scheduler.get(taskId).catch(() => null);
    if (!task) return; // deleted since enqueue
    try {
      if (task.kind === 'service') {
        const defn = await services.get(task.target);
        if (!defn.enabled) throw new Error(`Service "${task.target}" is disabled.`);
        // Services normally read string query params (an HTTP query string is always strings); a scheduled run
        // has no request, so its own JSON-typed params are stringified the same way before reaching the same code.
        const query = Object.fromEntries(
          Object.entries(task.params).map(([k, v]) => [k, String(v)]),
        );
        await services.run(defn, { query, publicData: ctx.publicData });
      } else {
        await jobs.enqueue('webhooks.deliver', {
          webhookId: Number(task.target),
          event: 'scheduled',
          payload: task.params,
        });
      }
      await scheduler.recordRun(taskId, { status: 'ok' });
    } catch (e) {
      await scheduler.recordRun(taskId, {
        status: 'error',
        error: String(e.message).slice(0, 500),
      });
    }
  });
}
