import { HttpError } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';

/**
 * Events (docs/DECISIONS.md D-050): a log of everything that happened, built-in or admin/script-defined. There is
 * no fixed event-type registry — `emit()` accepts any name, and a Webhook subscribes to it by exact name or
 * wildcard pattern (`src/modules/webhooks/service.js`). This is deliberate: a script-mode Service (D-046) already
 * has the full platform `ctx`, so `ctx.events.emit('my.custom.event', {...})` IS the custom-event feature — no
 * separate "define an event type" form is needed.
 * @param {{db: import('knex').Knex, dialect: any, jobs: any, log: import('pino').Logger, enabled?: () => boolean}} deps
 */
export function createEvents({ db, dialect, jobs, log, enabled = () => true }) {
  return {
    /**
     * Records the event, then hands it to the job queue to dispatch to matching webhooks — never inline, so
     * emitting an event during a request can never be slowed down by a webhook receiver (D-014's principle).
     * @param {string} name @param {object} [payload]
     */
    async emit(name, payload = {}) {
      if (!enabled()) return; // the Events module is switched off (D-070): nothing is logged or dispatched
      const clean = String(name ?? '').trim();
      if (!clean || clean.length > 191)
        throw new HttpError(
          422,
          'invalid_input',
          'An event name is required (at most 191 characters).',
          {
            field: 'name',
          },
        );
      await dialect.insertGetId(
        db('events_log'),
        { name: clean, payload: JSON.stringify(payload ?? {}), created_at: now() },
        'id',
      );
      try {
        await jobs.enqueue('webhooks.dispatch_event', { event: clean, payload });
      } catch (e) {
        // The event is already durably logged; a queueing hiccup shouldn't fail whatever triggered it.
        log.warn({ event: clean, err: e.message }, 'events: could not enqueue webhook dispatch');
      }
      return clean;
    },

    /** @param {{limit?: number|string, before?: number|string, name?: string}} [f] */
    async list({ limit = 50, before, name } = {}) {
      const q = db('events_log')
        .orderBy('id', 'desc')
        .limit(Math.min(Number(limit) || 50, 200));
      if (before) q.where('id', '<', Number(before));
      if (name) q.where('name', 'like', `${name}%`);
      return (await q).map((r) => ({
        id: Number(r.id),
        name: r.name,
        payload: r.payload ? JSON.parse(r.payload) : {},
        at: Number(r.created_at),
      }));
    },

    async prune(days) {
      if (!days || days <= 0) return 0;
      return db('events_log')
        .where('created_at', '<', now() - days * 86_400_000)
        .del();
    },
  };
}
