import { randomBytes, randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { HttpError } from '../../core/http/errors.js';
import { verifyPassword } from '../../core/auth/password.js';
import { copyOrder } from './migrate.js';

/**
 * Tables an erase never touches, whatever is asked: the migration bookkeeping, the list of backups (and so the
 * one-step-back snapshot itself), who can sign in and what they may do, the sessions of the people signed in, the audit
 * log (an erase must not be able to hide itself), the cluster's heartbeats, and the app's own configuration (below).
 * Everything else can be erased.
 */
export const PROTECTED = new Set([
  'knex_migrations',
  'knex_migrations_lock',
  'config_meta',
  'backups',
  'users',
  'roles',
  'sessions',
  'customer_sessions',
  'audit_logs',
  'cluster_nodes',
  // The app's own wiring, not data: the session secret and every setting live in `settings`, the site's version counter
  // in `site_meta`, the shipped AI instructions in `prompts`, installed plugins in `plugins`. Erasing any of them would
  // break the running site (an "all data" erase that emptied `settings` made every request fail on the missing secret).
  'settings',
  'site_meta',
  'prompts',
  'plugins',
  'plugin_migrations',
]);
const hidden = (n) => n.startsWith('sqlite_') || n.startsWith('search_fts');

const CHALLENGE_TTL_S = 300; // the typed words are good for five minutes, once
const MAX_ATTEMPTS = 3; // wrong words or password on one challenge
const FAIL_LIMIT = 5; // wrong passwords per person per window, across challenges
const FAIL_WINDOW_S = 900;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to mistype
const newPhrase = () =>
  `ERASE-${Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;

/**
 * Operations → System → Database (docs/DECISIONS.md D-122): how the database is doing, and a double-guarded way to
 * erase data (all of it, or chosen tables) that always leaves a one-step-back snapshot. The snapshot is the Backups
 * module's own (source 'flush'); undoing puts the erased records back through the same additive restore.
 * @param {any} ctx
 */
export function createDbOps(ctx) {
  const { db, dialect, cache, audit, log } = ctx;

  // The cache holds challenges so any server can finish one; a local copy covers a cache that is switched off.
  const local = new Map();
  const put = async (key, value, ttl) => {
    local.set(key, { value, until: Date.now() + ttl * 1000 });
    await cache.set(key, value, { ttl }).catch(() => {});
  };
  const get = async (key) => {
    const l = local.get(key);
    if (l && l.until > Date.now()) return l.value;
    local.delete(key);
    return (await cache.get(key).catch(() => null)) ?? null;
  };
  const drop = async (key) => {
    local.delete(key);
    await cache.del(key).catch(() => {});
  };

  const realTables = async () =>
    (await dialect.listTables()).filter((t) => !t.view && !hidden(t.name)).map((t) => t.name);
  const count = async (t) => Number((await db(t).count({ n: '*' }).first()).n);
  const first = async (sql, bindings) => {
    const r = await db.raw(sql, bindings);
    const rows = dialect.kind === 'mysql' ? r[0] : dialect.kind === 'pg' ? r.rows : r;
    return rows;
  };

  const svc = {
    /** How the database is doing. A figure an engine does not offer is null (the screen shows a dash). */
    async stats() {
      const t0 = performance.now();
      await db.raw('select 1');
      const pingMs = Math.round((performance.now() - t0) * 10) / 10;
      const all = await dialect.listTables();
      const names = all.filter((t) => !t.view && !hidden(t.name)).map((t) => t.name);
      const out = {
        engine: { kind: dialect.kind, version: null },
        pingMs,
        sizeBytes: null,
        tables: names.length,
        views: all.filter((t) => t.view).length,
        rows: 0,
        rowsApprox: false,
        biggest: [],
        connections: null,
        uptimeSec: null,
        cacheHitPct: null,
        memory: {
          app: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
          db: null,
        },
        pool: null,
      };
      const pool = /** @type {any} */ (db.client).pool;
      if (pool && typeof pool.numUsed === 'function')
        out.pool = {
          used: pool.numUsed(),
          free: pool.numFree(),
          pending: pool.numPendingAcquires(),
          max: pool.max ?? null,
        };

      if (dialect.kind === 'sqlite') {
        out.engine.version = (await first('select sqlite_version() as v'))[0].v;
        const pages = Number((await first('pragma page_count'))[0].page_count);
        const pageSize = Number((await first('pragma page_size'))[0].page_size);
        out.sizeBytes = pages * pageSize;
        const cs = Number((await first('pragma cache_size'))[0].cache_size);
        out.memory.db = { label: 'SQLite page cache', bytes: cs < 0 ? -cs * 1024 : cs * pageSize };
        const per = [];
        for (const n of names) per.push({ name: n, rows: await count(n), bytes: null });
        out.rows = per.reduce((n, t) => n + t.rows, 0);
        out.biggest = per.sort((a, b) => b.rows - a.rows).slice(0, 8);
      } else if (dialect.kind === 'mysql') {
        out.rowsApprox = true;
        out.engine.version = (await first('select version() as v'))[0].v;
        const tbl = await first(
          'select table_name as name, table_rows as r, data_length + index_length as b from information_schema.tables where table_schema = database() and table_type = ? order by b desc',
          ['BASE TABLE'],
        );
        out.sizeBytes = tbl.reduce((n, t) => n + Number(t.b ?? 0), 0);
        out.rows = tbl.reduce((n, t) => n + Number(t.r ?? 0), 0);
        out.biggest = tbl
          .slice(0, 8)
          .map((t) => ({ name: t.name, rows: Number(t.r ?? 0), bytes: Number(t.b ?? 0) }));
        const st = Object.fromEntries(
          (
            await first(
              "show global status where Variable_name in ('Threads_connected','Threads_running','Uptime','Innodb_buffer_pool_bytes_data')",
            )
          ).map((r) => [r.Variable_name, r.Value]),
        );
        const vr = Object.fromEntries(
          (
            await first(
              "show variables where Variable_name in ('max_connections','innodb_buffer_pool_size')",
            )
          ).map((r) => [r.Variable_name, r.Value]),
        );
        out.connections = {
          current: Number(st.Threads_connected),
          active: Number(st.Threads_running),
          max: Number(vr.max_connections),
        };
        out.uptimeSec = Number(st.Uptime);
        out.memory.db = {
          label: 'InnoDB buffer pool (in use of configured)',
          bytes: Number(st.Innodb_buffer_pool_bytes_data),
          of: Number(vr.innodb_buffer_pool_size),
        };
      } else {
        out.rowsApprox = true;
        out.engine.version = (await first('show server_version'))[0].server_version;
        out.sizeBytes = Number(
          (await first('select pg_database_size(current_database()) as s'))[0].s,
        );
        const tbl = await first(
          "select c.relname as name, greatest(c.reltuples, 0)::bigint as r, pg_total_relation_size(c.oid) as b from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by b desc",
        );
        out.rows = tbl.reduce((n, t) => n + Number(t.r), 0);
        out.biggest = tbl
          .slice(0, 8)
          .map((t) => ({ name: t.name, rows: Number(t.r), bytes: Number(t.b) }));
        const act = (
          await first(
            "select count(*)::int as total, (count(*) filter (where state = 'active'))::int as active from pg_stat_activity where datname = current_database()",
          )
        )[0];
        out.connections = {
          current: act.total,
          active: act.active,
          max: Number((await first('show max_connections'))[0].max_connections),
        };
        out.uptimeSec = Number(
          (
            await first(
              'select extract(epoch from now() - pg_postmaster_start_time())::bigint as u',
            )
          )[0].u,
        );
        const hit = (
          await first(
            'select round(100.0 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0), 1) as p from pg_stat_database where datname = current_database()',
          )
        )[0].p;
        out.cacheHitPct = hit === null ? null : Number(hit);
        out.memory.db = {
          label: 'PostgreSQL shared buffers (configured)',
          text: (await first('show shared_buffers'))[0].shared_buffers,
        };
      }
      return out;
    },

    /**
     * What an erase would remove. `mode: 'all'` is every table that may be erased; `mode: 'tables'` is the named ones.
     * A table another table (that has records) points at cannot go without it: in `all` it is kept and listed, in
     * `tables` it is a blocker the person must fix.
     * @param {{ mode: 'all'|'tables', tables?: string[] }} input
     */
    async plan({ mode, tables: want }) {
      const all = await realTables();
      const candidates = all.filter((n) => !PROTECTED.has(n));
      let selected;
      if (mode === 'all') selected = new Set(candidates);
      else {
        if (!Array.isArray(want) || !want.length)
          throw new HttpError(422, 'invalid_input', 'Choose at least one table.');
        const bad = want.filter((n) => !candidates.includes(n));
        if (bad.length)
          throw new HttpError(
            422,
            'invalid_input',
            `These cannot be erased here: ${bad.slice(0, 6).join(', ')}${PROTECTED.has(bad[0]) ? ' (accounts, roles, sessions, the audit log and the backups list are always kept)' : ''}.`,
            { field: 'tables' },
          );
        selected = new Set(want);
      }
      const counts = {};
      for (const n of all) counts[n] = await count(n);
      const fks = await dialect.foreignKeys();
      const kept = [];
      const blockers = new Set();
      for (let again = true; again;) {
        again = false;
        for (const f of fks) {
          if (!selected.has(f.refTable) || selected.has(f.table) || f.table === f.refTable)
            continue;
          if (!counts[f.table]) continue;
          if (mode === 'all') {
            selected.delete(f.refTable);
            kept.push({ table: f.refTable, because: f.table });
            again = true;
          } else
            blockers.add(
              `"${f.refTable}" is used by "${f.table}" (${counts[f.table]} records). Include "${f.table}" as well, or leave "${f.refTable}" out.`,
            );
        }
      }
      const tables = [...selected].sort();
      return {
        mode,
        tables,
        rows: Object.fromEntries(tables.map((t) => [t, counts[t]])),
        total: tables.reduce((n, t) => n + counts[t], 0),
        kept,
        blockers: [...blockers],
        // What cannot be erased, for the screen to say so.
        protected: all.filter((n) => PROTECTED.has(n)),
        candidates: candidates.map((n) => ({ name: n, rows: counts[n] })),
      };
    },

    /** Step one: check the request and hand back the words the person must type. Nothing is erased. */
    async challenge(input, actor) {
      const plan = await svc.plan(input);
      if (plan.blockers.length) throw new HttpError(409, 'conflict', plan.blockers[0]);
      if (!plan.tables.length || plan.total === 0)
        throw new HttpError(422, 'invalid_input', 'There are no records to erase in that choice.');
      if (!ctx.backup)
        throw new HttpError(
          409,
          'conflict',
          'Erasing needs the Backups module (it keeps the copy you can go back to). Switch it on under Settings → Modules first.',
        );
      const token = randomBytes(16).toString('hex');
      const phrase = newPhrase();
      const expiresAt = Date.now() + CHALLENGE_TTL_S * 1000;
      await put(
        `dbflush:${token}`,
        { actorId: actor.id, tables: plan.tables, phrase, expiresAt, attempts: 0 },
        CHALLENGE_TTL_S,
      );
      await audit.log({
        actor,
        action: 'database.flush_requested',
        entity: 'database',
        meta: { tables: plan.tables.length, rows: plan.total },
      });
      return { token, phrase, expiresAt, plan };
    },

    /**
     * Step two: the words, the person's own password, and then — only then — a snapshot, and the erase. The snapshot
     * must be complete and readable first; if it is not, nothing is erased.
     * @param {{ token: string, phrase: string, password: string }} input
     */
    async flush({ token, phrase, password }, actor) {
      const key = `dbflush:${token}`;
      const rec = await get(key);
      if (!rec || rec.expiresAt < Date.now()) {
        await drop(key);
        throw new HttpError(
          409,
          'conflict',
          'This confirmation has expired or was already used. Start again to get new words.',
        );
      }
      if (rec.actorId !== actor.id)
        throw new HttpError(403, 'forbidden', 'This confirmation was started by someone else.');
      const failKey = `dbflush:fails:${actor.id}`;
      const fails = Number((await get(failKey)) ?? 0);
      if (fails >= FAIL_LIMIT)
        throw new HttpError(
          429,
          'too_many_attempts',
          'Too many wrong attempts. Wait fifteen minutes before trying again.',
        );

      const user = await db('users').where({ id: actor.id }).first();
      const wordsOk = String(phrase ?? '').trim() === rec.phrase;
      const passwordOk =
        !!user && (await verifyPassword(user.password_hash, String(password ?? '')));
      if (!wordsOk || !passwordOk) {
        rec.attempts += 1;
        if (!passwordOk) await put(failKey, fails + 1, FAIL_WINDOW_S);
        if (rec.attempts >= MAX_ATTEMPTS) await drop(key);
        else await put(key, rec, Math.max(1, Math.round((rec.expiresAt - Date.now()) / 1000)));
        await audit.log({
          actor,
          action: 'database.flush_refused',
          entity: 'database',
          meta: { words: wordsOk, password: passwordOk },
        });
        throw new HttpError(
          422,
          'invalid_input',
          !wordsOk
            ? 'The words do not match. Type them exactly as shown.'
            : 'That password is not right.',
          { field: wordsOk ? 'password' : 'phrase' },
        );
      }
      await drop(key); // good for one erase only

      // Recheck what would be erased now: the data may have changed since the words were issued.
      const plan = await svc.plan({ mode: 'tables', tables: rec.tables });
      if (plan.blockers.length) throw new HttpError(409, 'conflict', plan.blockers[0]);

      const snap = await ctx.backup.snapshot(plan.tables, actor);
      const order = copyOrder(plan.tables, await dialect.foreignKeys()).reverse(); // children first
      const removed = {};
      try {
        await db.transaction(async (trx) => {
          for (const t of order) {
            // Records that arrived after the snapshot was taken are not in it; refuse rather than erase them.
            const now = Number((await trx(t).count({ n: '*' }).first()).n);
            if (now !== snap.manifest.tables[t].rows)
              throw new HttpError(
                409,
                'conflict',
                `"${t}" changed while the copy was being made, so nothing was erased. Try again.`,
              );
            await trx(t).del();
            removed[t] = now;
          }
        });
      } catch (e) {
        // Nothing was erased, so the copy is not needed.
        await ctx.backup.remove(snap.id, actor).catch(() => {});
        throw e;
      }
      await ctx.backup.dropOldFlush(snap.id);
      await cache.flush().catch(() => {});
      if (removed.site_files !== undefined) await ctx.siteFiles?.refresh?.().catch(() => {});
      if (removed.settings !== undefined) await ctx.settings.reloadDefinitions().catch(() => {});
      const total = Object.values(removed).reduce((n, v) => n + v, 0);
      await audit.log({
        actor,
        action: 'database.flushed',
        entity: 'database',
        meta: { tables: Object.keys(removed), rows: total, snapshotId: snap.id },
      });
      log?.warn(
        { tables: Object.keys(removed).length, rows: total },
        'database: erased by request',
      );
      return { snapshotId: snap.id, tables: Object.keys(removed), rows: removed, total };
    },

    /** The snapshot kept from the last erase, if there is one. */
    async last() {
      const b = await ctx.backup?.lastFlush();
      if (!b) return null;
      const t = b.manifest?.tables ?? {};
      return {
        id: b.id,
        createdAt: b.createdAt,
        tables: Object.keys(t),
        rows: Object.values(t).reduce((n, x) => n + x.rows, 0),
        size: b.size,
      };
    },

    /** Put back the records the last erase removed (additive: records made since stay). */
    async undo(actor) {
      const last = await svc.last();
      if (!last) throw new HttpError(404, 'not_found', 'There is no erase to go back from.');
      await ctx.backup.restore(last.id, { confirm: 'RESTORE' }, actor);
      await audit.log({
        actor,
        action: 'database.flush_undone',
        entity: 'database',
        meta: { snapshotId: last.id },
      });
      return { accepted: true, snapshotId: last.id };
    },
  };
  return svc;
}
