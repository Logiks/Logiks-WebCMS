import { now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';

const DAY = 86_400_000;

/**
 * Every log the platform keeps, in one place: what is in it, how long it is kept, and a manual prune. The retention
 * settings are the ones the nightly prune jobs already read, so changing a number here changes what those jobs do.
 * `view` turns a row into a one-line summary for the viewer; it never includes secrets (none of these tables hold any).
 */
const SOURCES = [
  {
    id: 'audit',
    label: 'Audit log',
    help: 'Who changed what: sign-ins, settings, users, content.',
    table: 'audit_logs',
    setting: ['system', 'audit_retention_days'],
    forever: true,
    view: (r) => ({
      title: r.action,
      detail: [r.actor_email, r.entity && `${r.entity}${r.entity_id ? ` #${r.entity_id}` : ''}`]
        .filter(Boolean)
        .join(' · '),
    }),
  },
  {
    id: 'events',
    label: 'Events',
    help: 'Everything emitted with ctx.events.emit().',
    table: 'events_log',
    setting: ['automation', 'events_retention_days'],
    view: (r) => ({ title: r.name, detail: String(r.payload ?? '').slice(0, 160) }),
  },
  {
    id: 'webhooks',
    label: 'Webhook deliveries',
    help: 'Each attempt to call a webhook, and how it went.',
    table: 'webhook_deliveries',
    setting: ['automation', 'webhook_delivery_retention_days'],
    view: (r) => ({
      title: `${r.event} · ${r.status}`,
      detail: [r.response_code && `HTTP ${r.response_code}`, r.error].filter(Boolean).join(' · '),
    }),
  },
  {
    id: 'activity',
    label: 'Visitor and admin activity',
    help: 'Page views, clicks and time on page behind Analytics.',
    table: 'activity_log',
    setting: ['analytics', 'retention_days'],
    view: (r) => ({ title: `${r.surface} · ${r.event_type}`, detail: r.path }),
  },
  {
    id: 'ai',
    label: 'AI usage',
    help: 'Every call to a text or image AI provider.',
    table: 'ai_usage_log',
    setting: ['system', 'ai_usage_retention_days'],
    forever: true,
    view: (r) => ({
      title: `${r.provider} · ${r.model || '–'}`,
      detail: `${r.feature} · ${r.units ? `${r.units} image` : `${Number(r.input_tokens) + Number(r.output_tokens)} tokens`}${r.ok ? '' : ' · failed'}`,
    }),
  },
];

/**
 * System → Log Manager. Administrators only (`logs.manage`).
 * @param {{ db: import('knex').Knex, settings: any, audit: any }} ctx
 */
export function createLogManager({ db, settings, audit }) {
  const find = (id) => {
    const s = SOURCES.find((x) => x.id === id);
    if (!s) throw notFound('That log');
    return s;
  };
  const retention = (s) => Number(settings.get(s.setting.join('.')));

  const svc = {
    async sources() {
      const out = [];
      for (const s of SOURCES) {
        const r = await db(s.table)
          .count({ n: '*' })
          .min({ oldest: 'created_at' })
          .max({ newest: 'created_at' })
          .first();
        out.push({
          id: s.id,
          label: s.label,
          help: s.help,
          count: Number(r.n),
          oldest: r.oldest ? Number(r.oldest) : null,
          newest: r.newest ? Number(r.newest) : null,
          retentionDays: retention(s),
          canKeepForever: !!s.forever,
        });
      }
      return out;
    },

    /** The newest rows, one line each. */
    async view(id, /** @type {{ limit?: any, before?: any }} */ { limit = 50, before } = {}) {
      const s = find(id);
      const q = db(s.table)
        .orderBy('id', 'desc')
        .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
      if (before) q.where('id', '<', Number(before));
      return (await q).map((r) => ({ id: r.id, at: Number(r.created_at), ...s.view(r) }));
    },

    /** How long to keep a log. The registry's own limits apply (some logs can't be kept forever). */
    async setRetention(id, days, actor = null) {
      const s = find(id);
      if (!Number.isInteger(days) || days < 0)
        throw new HttpError(422, 'invalid_input', 'Enter a whole number of days.');
      if (days === 0 && !s.forever)
        throw new HttpError(
          422,
          'invalid_input',
          `${s.label} can't be kept forever. Enter 1 or more days.`,
        );
      await settings.update(s.setting[0], { values: { [s.setting[1]]: days } }, actor, {
        internal: true,
      });
      await audit.log({
        actor,
        action: 'logs.retention',
        entity: 'log',
        entityId: s.id,
        meta: { days },
      });
      return svc.sources();
    },

    /** Delete entries older than `days`; 0 empties the log. Returns how many went. */
    async prune(id, days, actor = null) {
      const s = find(id);
      if (!Number.isInteger(days) || days < 0)
        throw new HttpError(422, 'invalid_input', 'Enter a whole number of days (0 empties the log).');
      const q = db(s.table);
      if (days > 0) q.where('created_at', '<', now() - days * DAY);
      const deleted = await q.del();
      // Logged after the delete, so pruning the audit log leaves a record of having done so.
      await audit.log({
        actor,
        action: 'logs.prune',
        entity: 'log',
        entityId: s.id,
        meta: { olderThanDays: days, deleted },
      });
      return { deleted };
    },
  };
  return svc;
}
