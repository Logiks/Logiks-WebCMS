import { createHash } from 'node:crypto';
import { now } from '../../core/db/index.js';

const MESSAGE_CHARS = 1000;
const STACK_CHARS = 6000;

/** First stack line that points at a file, minus line/column, so a code move does not split one error in two. */
const firstFrame = (stack) =>
  String(stack ?? '')
    .split('\n')
    .find((l) => /^\s*at /.test(l))
    ?.replace(/:\d+:\d+/g, '')
    .trim() ?? '';

/** Numbers and long hex/uuid ids out, so "Row 17 not found" and "Row 18 not found" count as one error. */
const shape = (msg) =>
  String(msg ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '#')
    .replace(/\b[0-9a-f]{16,}\b/gi, '#')
    .replace(/\d+/g, '#');

/**
 * Server errors, kept so an admin can see which ones keep happening. Recording is best-effort and never throws or
 * waits on the failing request. Query strings are never stored (they can carry tokens); neither are headers or bodies.
 * @param {{ db: import('knex').Knex, log?: any }} ctx
 */
export function createErrorLog({ db, log }) {
  return {
    /**
     * @param {{ source: 'http'|'job'|'process', err: any, req?: any, job?: string, status?: number }} e
     */
    async record({ source, err, req, job, status }) {
      try {
        /** @type {any} */
        const error = err instanceof Error ? err : new Error(String(err));
        const name = String(error.name || 'Error').slice(0, 64);
        const fingerprint = createHash('sha1')
          .update(
            `${source}|${job ?? ''}|${name}|${shape(error.message)}|${firstFrame(error.stack)}`,
          )
          .digest('hex');
        await db('error_log').insert({
          created_at: now(),
          fingerprint,
          source,
          status: status ?? null,
          code: typeof error.code === 'string' ? error.code.slice(0, 64) : null,
          name,
          message: String(error.message ?? '').slice(0, MESSAGE_CHARS),
          stack: error.stack ? String(error.stack).slice(0, STACK_CHARS) : null,
          method: req?.method ? String(req.method).slice(0, 10) : null,
          path: req
            ? String(req.originalUrl ?? req.url ?? '')
                .split('?')[0]
                .slice(0, 191)
            : null,
          job: job ? String(job).slice(0, 100) : null,
          user_id: req?.user?.id ?? null,
        });
      } catch (e) {
        log?.warn({ err: e.message }, 'error log: entry not recorded');
      }
    },

    /** The errors that happen most, newest-seen first among ties. */
    async top({ since, limit = 50 } = /** @type {any} */ ({})) {
      const q = db('error_log')
        .select('fingerprint')
        .count({ n: '*' })
        .min({ first: 'created_at' })
        .max({ last: 'created_at', id: 'id' })
        .groupBy('fingerprint')
        .orderBy([
          { column: 'n', order: 'desc' },
          { column: 'last', order: 'desc' },
        ])
        .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
      if (since) q.where('created_at', '>=', Number(since));
      const groups = await q;
      const out = [];
      for (const g of groups) {
        const latest = await db('error_log').where({ id: g.id }).first();
        out.push({
          fingerprint: g.fingerprint,
          count: Number(g.n),
          first: Number(g.first),
          last: Number(g.last),
          source: latest.source,
          name: latest.name,
          message: latest.message,
          path: latest.path,
          job: latest.job,
          status: latest.status,
          stack: latest.stack,
        });
      }
      return out;
    },

    async prune(days) {
      if (!(days > 0)) return 0;
      return db('error_log')
        .where('created_at', '<', now() - days * 86_400_000)
        .del();
    },
  };
}
