import { now } from './db/index.js';

/**
 * Append-only audit trail. Pass `trx` to make the entry part of the same transaction as the change.
 * Never put secret values in `meta`.
 * @param {{db: import('knex').Knex, log: import('pino').Logger}} deps
 */
export function createAudit({ db, log }) {
  return {
    /**
     * @param {{actor?: {id?:number,email?:string,ip?:string}|null, action: string, entity?: string, entityId?: string|number, meta?: object, ip?: string}} e
     * @param {import('knex').Knex.Transaction} [trx]
     */
    async log(e, trx) {
      const row = {
        actor_id: e.actor?.id ?? null,
        actor_email: e.actor?.email ?? null,
        action: e.action,
        entity: e.entity ?? null,
        entity_id: e.entityId === undefined ? null : String(e.entityId),
        meta: e.meta ? JSON.stringify(e.meta) : null,
        ip: e.ip ?? e.actor?.ip ?? null,
        created_at: now(),
      };
      try {
        await (trx ?? db)('audit_logs').insert(row);
      } catch (err) {
        if (trx) throw err; // inside a transaction the audit entry is part of the change
        log.error({ err: err.message, action: e.action }, 'audit write failed');
      }
    },

    /** @param {{limit?: number|string, before?: number|string, action?: string, actorEmail?: string}} [f] */
    async list({ limit = 50, before, action, actorEmail } = {}) {
      const q = db('audit_logs')
        .orderBy('id', 'desc')
        .limit(Math.min(Number(limit) || 50, 200));
      if (before) q.where('id', '<', Number(before));
      if (action) q.where('action', 'like', `${action}%`);
      if (actorEmail) q.where('actor_email', actorEmail);
      return (await q).map((r) => ({
        id: Number(r.id),
        actor: r.actor_email ?? (r.actor_id ? `user #${r.actor_id}` : 'system'),
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        meta: r.meta ? JSON.parse(r.meta) : null,
        ip: r.ip,
        at: Number(r.created_at),
      }));
    },

    /** Delete entries older than `days` (0 = keep forever). Returns rows deleted. */
    async prune(days) {
      if (!days || days <= 0) return 0;
      return db('audit_logs')
        .where('created_at', '<', now() - days * 86_400_000)
        .del();
    },
  };
}
