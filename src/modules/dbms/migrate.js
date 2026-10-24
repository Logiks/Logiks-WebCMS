import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../../core/http/errors.js';
import { createDb, dialect as dialectOf } from '../../core/db/index.js';

const STATUS_KEY = 'dbmove:status';
const STATUS_TTL = 7 * 24 * 3600; // seconds; a finished copy stays readable until it is switched or started over
const STALE_MS = 2 * 60_000; // a "running" status that stopped updating this long ago belongs to a dead process
const BATCH_VARS = 900; // stays under SQLite's historic 999 bound-variable limit
const BATCH_BYTES = 4_000_000; // well under MySQL's smallest plausible max_allowed_packet
const READ_CHUNK = 1000;
/** Tables the running app writes to by itself (sessions, logs, heartbeats), so their size moves during a copy. */
const LIVE_TABLES = new Set([
  'sessions',
  'customer_sessions',
  'audit_logs',
  'activity_log',
  'analytics_sessions',
  'events_log',
  'webhook_deliveries',
  'cluster_nodes',
  'config_meta',
  'settings_revisions',
  'assistant_usage',
  'password_resets',
]);
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Tables the mover never copies: the migration bookkeeping is rebuilt by running our own migrations on the target,
 *  and SQLite's full-text tables are derived from `search_index`. */
const skip = (name) =>
  name === 'knex_migrations' ||
  name === 'knex_migrations_lock' ||
  name.startsWith('sqlite_') ||
  name === 'search_fts' ||
  name.startsWith('search_fts_');

/** Reads a connection string into the shape the DB factory wants. Throws a fixable message for anything else. */
export function parseTarget(url) {
  const u = String(url ?? '').trim();
  let kind;
  if (/^sqlite:/i.test(u)) kind = 'sqlite';
  else if (/^mysql2?:\/\//i.test(u)) kind = 'mysql';
  else if (/^postgres(ql)?:\/\//i.test(u)) kind = 'pg';
  else
    throw new HttpError(
      422,
      'invalid_input',
      'Use a connection string such as mysql://user:password@host:3306/dbname or postgres://user:password@host:5432/dbname.',
      { field: 'url' },
    );
  return { url: u, kind };
}

/** A connection string with the password hidden — the only form that is ever logged, audited or sent to the screen. */
export const redactUrl = (url) => String(url ?? '').replace(/(:\/\/[^:/@]*:)[^@]*@/, '$1***@');

const fingerprint = (url) => createHash('sha256').update(String(url)).digest('hex').slice(0, 32);

/** Parents before children. Cycles (rare) fall back to the original order for the tables left over. */
export function copyOrder(tables, fks) {
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const f of fks)
    if (f.table !== f.refTable && deps.has(f.table) && deps.has(f.refTable))
      deps.get(f.table).add(f.refTable);
  const out = [];
  const left = new Set(tables);
  while (left.size) {
    const ready = [...left].filter((t) => [...deps.get(t)].every((d) => !left.has(d)));
    const next = ready.length ? ready : [[...left][0]];
    for (const t of next) {
      out.push(t);
      left.delete(t);
    }
  }
  return out;
}

/** Rows of a table that points at itself, ordered so a row always comes after the row it references. */
export function selfRefOrder(rows, pk, fkCols) {
  const have = new Set(rows.map((r) => r[pk]));
  const done = new Set();
  const out = [];
  let left = rows;
  while (left.length) {
    const rest = [];
    for (const r of left) {
      const ok = fkCols.every((c) => r[c] == null || !have.has(r[c]) || done.has(r[c]));
      if (ok) {
        out.push(r);
        done.add(r[pk]);
      } else rest.push(r);
    }
    if (rest.length === left.length) return out.concat(rest); // a loop; let the database say what it thinks
    left = rest;
  }
  return out;
}

/**
 * Rewrites identifier quoting for another engine, leaving string literals alone. MySQL quotes with backticks; SQLite
 * and PostgreSQL with double quotes. This is the one translation that is safe to do blind — anything deeper (functions,
 * trigger bodies) is tried as written and reported if the new engine rejects it.
 */
export function requote(sql, from, to) {
  if (from === to || (from !== 'mysql' && to !== 'mysql')) return sql;
  const token = /'(?:[^']|'')*'|"[^"]*"|`[^`]*`/g;
  return String(sql).replace(token, (t) => {
    if (t[0] === "'") return t;
    const inner = t.slice(1, -1);
    if (from === 'mysql' && t[0] === '`') return `"${inner}"`;
    if (to === 'mysql' && t[0] === '"') return `\`${inner}\``;
    return t;
  });
}

const approxBytes = (row) => {
  let n = 0;
  for (const v of Object.values(row))
    n += typeof v === 'string' || Buffer.isBuffer(v) ? v.length : 16;
  return n;
};

/** Column types for a table that only exists in the source (made in the SQL console), mapped to portable ones. */
export function buildColumn(t, c) {
  const type = String(c.type).toLowerCase();
  let col;
  if (c.autoIncrement) col = t.increments(c.name);
  else if (/bigint/.test(type)) col = t.bigInteger(c.name);
  else if (/int|serial/.test(type) && !/point/.test(type)) col = t.integer(c.name);
  else if (/bool|tinyint\(1\)/.test(type)) col = t.boolean(c.name);
  else if (/real|float|double|decimal|numeric/.test(type)) col = t.float(c.name);
  else if (/text|json|blob|clob/.test(type)) col = t.text(c.name, 'longtext');
  else col = t.string(c.name, 191);
  if (!c.autoIncrement) {
    // SQLite calls a text primary key nullable; MySQL refuses a nullable key column.
    if (c.nullable && !c.primaryKey) col.nullable();
    else col.notNullable();
  }
  return col;
}

/**
 * System → Database → Copy database (called "Move database" until D-123): copies everything from the database this server runs on into another, empty
 * one (SQLite → MySQL/PostgreSQL, or between those), checks the copy, and — only when asked — points this server at
 * the new database. It never changes the source, and nothing it does is half-way visible: the new database is only
 * used once someone presses Switch.
 *
 * The target is built by running this app's own migrations, so its schema is exactly what a fresh install on that
 * engine would have; the copy then only moves rows. Secrets are copied as stored (encrypted), so the same
 * APP_MASTER_KEY keeps working on the new database.
 *
 * The connection string (it holds a password) is never stored: progress lives in the cache under a fingerprint of it,
 * and Switch asks for the string again and checks it against that fingerprint.
 *
 * @param {{env: import('../../core/env.js').Env, db: import('knex').Knex, dialect: any, cache: any, audit: any,
 *   log: import('pino').Logger, state: any, appRoot: string}} deps
 */
export function createDbMover({ env, db, dialect, cache, audit, log, state, appRoot }) {
  /** @type {import('knex').Knex | null} */
  let working = null;

  const connect = (parsed) =>
    createDb(
      /** @type {any} createDb only reads these four fields; the rest of Env is the running server's. */ ({
        dbKind: parsed.kind,
        DB_URL: parsed.url,
        DB_POOL_MIN: 1,
        DB_POOL_MAX: 4,
      }),
    );

  // The cache is what lets any server in a cluster answer "how far along is it?"; the local copy keeps a
  // single server working when the cache is switched off in settings.
  let local = null;
  async function readStatus() {
    return (await cache.get(STATUS_KEY)) ?? local ?? { state: 'idle' };
  }
  async function writeStatus(patch) {
    const next = { ...(await readStatus()), ...patch, updatedAt: Date.now() };
    local = next;
    await cache.set(STATUS_KEY, next, { ttl: STATUS_TTL });
    return next;
  }

  function sameDatabase(parsed) {
    if (parsed.kind !== dialect.kind) return false;
    if (parsed.kind === 'sqlite')
      return (
        path.resolve(appRoot, parsed.url.replace(/^sqlite:(\/\/)?/i, '')) ===
        path.resolve(appRoot, env.DB_URL.replace(/^sqlite:(\/\/)?/i, ''))
      );
    return parsed.url === env.DB_URL;
  }

  const friendly = (e) => {
    // Knex errors read "<the whole SQL statement> - <the database's reason>"; the reason is what helps.
    const full = String(e?.message ?? e).split('\n')[0];
    const m =
      full.length > 200 && full.includes(' - ') ? full.slice(full.lastIndexOf(' - ') + 3) : full;
    return m.replace(/(:\/\/[^:/@\s]*:)[^@\s]*@/g, '$1***@').slice(0, 400);
  };

  /** Opens the target and reports whether it can receive a copy. Always closes what it opened. */
  async function test(url) {
    const parsed = parseTarget(url);
    if (sameDatabase(parsed))
      throw new HttpError(
        422,
        'invalid_input',
        'That is the database this server already uses. Enter the new, empty database.',
        { field: 'url' },
      );
    let target;
    try {
      target = connect(parsed);
      await target.raw('select 1');
    } catch (e) {
      await target?.destroy().catch(() => {});
      throw new HttpError(
        422,
        'db_unreachable',
        `Could not connect: ${friendly(e)}. Check the host, port, user, password and that the database exists.`,
        { field: 'url' },
      );
    }
    try {
      const tables = (await dialectOf(target).listTables()).filter((t) => !skip(t.name));
      return {
        kind: parsed.kind,
        target: redactUrl(parsed.url),
        empty: tables.length === 0,
        existingTables: tables.length,
      };
    } finally {
      await target.destroy().catch(() => {});
    }
  }

  async function status() {
    const s = await readStatus();
    if (s.state === 'running' && Date.now() - (s.updatedAt ?? 0) > STALE_MS)
      return {
        ...s,
        sourceKind: dialect.kind,
        state: 'failed',
        error: 'The copy stopped without finishing (the server running it restarted). Start again.',
      };
    return { ...s, sourceKind: dialect.kind };
  }

  /**
   * Starts the copy in the background; progress is read from `status()`. With `resume`, carries on a copy that
   * stopped part-way (the tables already finished are kept; the one that failed was rolled back).
   */
  async function start(url, actor, { resume = false } = {}) {
    const parsed = parseTarget(url);
    const cur = await status();
    if (cur.state === 'running')
      throw new HttpError(409, 'conflict', 'A copy is already running. Wait for it to finish.');
    if (resume) {
      if (cur.state !== 'failed' || !cur.resumable || fingerprint(parsed.url) !== cur.fingerprint)
        throw new HttpError(
          409,
          'conflict',
          'There is no stopped copy to continue for that database. Start a new copy instead.',
        );
      await test(url); // reachable, and not this server's own database
      await writeStatus({ state: 'running', step: 'Resuming', error: null, resumable: false });
    } else {
      const info = await test(url);
      if (!info.empty)
        throw new HttpError(
          422,
          'target_not_empty',
          `That database already has ${info.existingTables} table(s). Create a new, empty database and use that one — nothing existing is ever overwritten.`,
          { field: 'url' },
        );
      local = null;
      await writeStatus({
        state: 'running',
        step: 'Starting',
        target: redactUrl(parsed.url),
        targetKind: parsed.kind,
        fingerprint: fingerprint(parsed.url),
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        built: false,
        resumable: false,
        tables: [],
        mismatches: [],
        extraTables: [],
        objects: [],
        sourceChanged: false,
        switched: false,
      });
    }
    await audit.log({
      actor,
      action: resume ? 'dbms.move_resumed' : 'dbms.move_started',
      entity: 'database',
      entityId: parsed.kind,
      meta: { from: dialect.kind, to: parsed.kind, target: redactUrl(parsed.url) },
    });
    void run(parsed, actor, resume);
    return status();
  }

  async function run(parsed, actor, resume) {
    let target = null;
    const step = (s) => writeStatus({ step: s });
    /** Where the failure happened decides what is left behind: before the schema is built, nothing. */
    let phase = 'build';
    let tables = [];
    try {
      working = target = connect(parsed);
      const tdial = dialectOf(target);
      const sourceTables = (await dialect.listTables()).filter((t) => !t.view && !skip(t.name));

      if (!resume) {
        await step('Checking this database is up to date');
        const [, pending] = await db.migrate.list();
        if (pending.length)
          throw new Error(
            `${pending.length} migration(s) are pending on this database. Run "npm run migrate", then try again.`,
          );

        await step('Building the new database');
        await target.migrate.latest();
        const targetNames = new Set((await tdial.listTables()).map((t) => t.name));

        // Tables someone made in the SQL console exist only in the source. Recreate their columns so their data
        // comes along; the screen lists them so nobody is surprised.
        const extra = [];
        for (const t of sourceTables) {
          if (targetNames.has(t.name)) continue;
          const cols = await dialect.columnDetails(t.name);
          await target.schema.createTable(t.name, (b) => {
            const pks = cols.filter((c) => c.primaryKey && !c.autoIncrement);
            for (const c of cols) buildColumn(b, c);
            if (pks.length) b.primary(pks.map((c) => c.name));
          });
          extra.push(t.name);
        }

        const fks = await tdial.foreignKeys();
        const order = copyOrder(
          sourceTables.map((t) => t.name),
          fks,
        );
        // Our migrations seed a few rows (settings version, default prompts…). The source's rows replace them,
        // children first so a foreign key never objects.
        await target.transaction(async (trx) => {
          for (const name of [...order].reverse()) await trx(name).del();
        });
        tables = [];
        for (const name of order)
          tables.push({ name, source: await count(db, name), copied: 0, done: false });
        await writeStatus({
          built: true,
          extraTables: extra,
          tables,
          fks,
          ownedTables: (await tdial.listTables()).map((t) => t.name),
        });
      } else {
        const s = await readStatus();
        tables = s.tables;
        // The source may have been fixed between attempts; unfinished tables are counted again.
        for (const t of tables) if (!t.done) t.source = await count(db, t.name);
      }

      phase = 'copy';
      const fks = (await readStatus()).fks ?? [];
      let lastWrite = 0;
      for (const t of tables) {
        if (t.done) continue;
        await step(`Copying ${t.name}`);
        // One transaction per table: a failure rolls back only that table, and resuming picks up from it.
        t.copied = await target.transaction((trx) =>
          copyTable(t.name, trx, fks, async (n) => {
            t.copied = n;
            if (Date.now() - lastWrite > 1000) {
              lastWrite = Date.now();
              await writeStatus({ tables });
            }
          }),
        );
        t.done = true;
        await writeStatus({ tables });
      }

      await step('Resetting counters');
      await fixSequences(
        target,
        tdial,
        tables.map((t) => t.name),
      );
      if (parsed.kind === 'sqlite')
        await target.raw(
          'INSERT INTO search_fts(rowid, title, body) SELECT entry_id, title, body FROM search_index',
        );

      phase = 'extras';
      const objects = [];
      await step('Copying indexes');
      objects.push(
        ...(await copyIndexes(
          target,
          tdial,
          tables.map((t) => t.name),
        )),
      );
      await step('Copying views, triggers and functions');
      objects.push(...(await copyObjects(target, tdial, parsed.kind)));
      await writeStatus({ objects });

      await step('Checking the copy');
      const mismatches = [];
      let sourceChanged = false;
      for (const t of tables) {
        const [src, dst] = [await count(db, t.name), await count(target, t.name)];
        // The copy is checked against what was read from the source. A live site keeps writing to its own logs and
        // sessions meanwhile, so only a change to a content table counts as "the source changed".
        if (src !== t.source && !LIVE_TABLES.has(t.name)) sourceChanged = true;
        if (dst !== t.copied) mismatches.push({ name: t.name, source: t.copied, target: dst });
      }
      const ok = !mismatches.length && !sourceChanged;
      await writeStatus({
        state: ok ? 'ready' : 'failed',
        step: ok ? 'Copy checked' : 'Copy finished with problems',
        finishedAt: Date.now(),
        mismatches,
        sourceChanged,
        resumable: false,
        error: ok
          ? null
          : sourceChanged
            ? 'Content changed in this database while it was being copied. Put the site in maintenance mode (Settings → General), choose Start over, and copy again.'
            : 'Some tables have a different number of rows after the copy. See the list below, then choose Start over.',
      });
      await audit.log({
        actor,
        action: ok ? 'dbms.move_checked' : 'dbms.move_problem',
        entity: 'database',
        entityId: parsed.kind,
        meta: { tables: tables.length, target: redactUrl(parsed.url) },
      });
    } catch (e) {
      log.error({ err: friendly(e), phase }, 'database move failed');
      const keep = phase !== 'build' && target; // the schema is built: keep the finished tables so Resume is possible
      if (!keep && target) await wipe(target).catch(() => {});
      await writeStatus({
        state: 'failed',
        step: 'Failed',
        finishedAt: Date.now(),
        resumable: Boolean(keep),
        built: Boolean(keep),
        error: keep
          ? `${friendly(e)} The tables copied so far are kept. Fix the cause, then choose Resume — or Start over to clear the new database.`
          : `${friendly(e)} The new database was left empty, so you can fix this and try again.`,
      });
    } finally {
      working = null;
      await target?.destroy().catch(() => {});
    }
  }

  const count = async (conn, table) => Number((await conn(table).count({ n: '*' }).first()).n);

  /**
   * Copies one table into the open target transaction and returns the number of rows written. Reads the source in
   * key order, a page at a time, so memory stays flat and a table of any size costs the same per row. A table with no
   * primary key can only be paged by offset, which slows down on very large ones.
   */
  async function copyTable(name, trx, fks, onProgress) {
    const srcCols = await dialect.columnDetails(name);
    const dstCols = new Set((await dialectOf(trx).columnDetails(name)).map((c) => c.name));
    const cols = srcCols.map((c) => c.name).filter((c) => dstCols.has(c));
    if (!cols.length) return 0;
    const perStatement = Math.max(1, Math.floor(BATCH_VARS / cols.length));
    const pks = srcCols.filter((c) => c.primaryKey).map((c) => c.name);
    const selfFks = fks.filter((f) => f.table === name && f.refTable === name).map((f) => f.column);
    let written = 0;
    const put = async (rows) => {
      let i = 0;
      while (i < rows.length) {
        let bytes = 0;
        let n = 0;
        while (i + n < rows.length && n < perStatement && (n === 0 || bytes < BATCH_BYTES))
          bytes += approxBytes(rows[i + n++]);
        await trx(name).insert(rows.slice(i, i + n));
        i += n;
        written += n;
        await onProgress(written);
      }
    };

    if (selfFks.length && pks.length === 1) {
      // A table that points at itself must load a row after the row it references, which needs it all in memory.
      // The built-in ones are small; a huge console-made self-referencing table is the one case this would strain.
      await put(selfRefOrder(await db(name).select(cols), pks[0], selfFks));
      return written;
    }
    if (pks.length) {
      let last = null;
      for (;;) {
        const q = db(name).select(cols).limit(READ_CHUNK);
        for (const c of pks) q.orderBy(c);
        // (a > x) OR (a = x AND b > y) …: "the rows after this one" for a key of any width.
        if (last)
          q.where((b) => {
            pks.forEach((c, i) =>
              b.orWhere((w) => {
                for (let j = 0; j < i; j++) w.where(pks[j], '=', last[pks[j]]);
                w.where(c, '>', last[c]);
              }),
            );
          });
        const rows = await q;
        if (!rows.length) break;
        await put(rows);
        last = rows[rows.length - 1];
        if (rows.length < READ_CHUNK) break;
      }
      return written;
    }
    for (let offset = 0; ; offset += READ_CHUNK) {
      const rows = await db(name).select(cols).orderBy(cols[0]).limit(READ_CHUNK).offset(offset);
      if (!rows.length) break;
      await put(rows);
      if (rows.length < READ_CHUNK) break;
    }
    return written;
  }

  const objectEntry = (o, status, reason, sql) => ({
    kind: o.kind,
    name: o.name,
    table: o.table,
    status,
    ...(reason ? { reason: String(reason).slice(0, 300) } : {}),
    ...(status === 'skipped' && sql ? { sql: String(sql).slice(0, 4000) } : {}),
  });

  /** Indexes someone added to a table (in the SQL console, say) that the migrations don't know about. After the
   *  data, because building an index on loaded rows is much faster than maintaining it row by row. */
  async function copyIndexes(target, tdial, names) {
    const out = [];
    for (const name of names) {
      const srcCols = new Map((await dialect.columnDetails(name)).map((c) => [c.name, c]));
      const have = new Set(
        (await tdial.indexList(name)).map((i) => `${i.unique ? 'u' : 'i'}:${i.columns.join(',')}`),
      );
      let n = 0;
      for (const ix of await dialect.indexList(name)) {
        const cols = ix.columns;
        if (/^sqlite_autoindex|^PRIMARY$|_pkey$/.test(ix.name)) continue;
        const key = `${ix.unique ? 'u' : 'i'}:${cols.join(',')}`;
        if (have.has(key)) continue;
        // Expression indexes and full-text indexes belong to an engine; the migrations make the right ones there.
        if (!cols.length || cols.some((c) => !IDENT.test(c))) continue;
        if (cols.some((c) => /text|blob|clob/i.test(srcCols.get(c)?.type ?? ''))) continue;
        const o = { kind: 'index', name: ix.name, table: name };
        try {
          await target.schema.alterTable(name, (b) => {
            const idxName = `${name}_${cols.join('_')}_mv${++n}`.slice(0, 60);
            return ix.unique ? b.unique(cols, { indexName: idxName }) : b.index(cols, idxName);
          });
          out.push(objectEntry(o, 'created'));
          have.add(key);
        } catch (e) {
          out.push(
            objectEntry(
              o,
              'skipped',
              friendly(e),
              `${ix.unique ? 'UNIQUE ' : ''}INDEX on ${name} (${cols.join(', ')})`,
            ),
          );
        }
      }
    }
    return out;
  }

  /**
   * Functions, views and triggers, in that order, after the data (so a trigger never fires on the copy itself).
   * Between the same engine they are recreated as read. Between engines the SQL is requoted and tried as written;
   * anything the new engine rejects is listed with its original SQL for a person to port. Nothing here can fail the move.
   */
  async function copyObjects(target, tdial, targetKind) {
    const source = await dialect.objects();
    const there = new Set((await tdial.objects()).map((o) => `${o.kind}:${o.name}`));
    const same = dialect.kind === targetKind;
    const out = [];
    const attempt = async (o) => {
      const sql = requote(o.sql, dialect.kind, targetKind);
      try {
        await target.raw(sql.replace(/\?/g, '\\?'));
        return true;
      } catch (e) {
        out.push(objectEntry(o, 'skipped', friendly(e), o.sql));
        return false;
      }
    };
    const todo = source.filter((o) => {
      if (there.has(`${o.kind}:${o.name}`)) {
        out.push(objectEntry(o, 'exists'));
        return false;
      }
      if (!o.sql) {
        out.push(
          objectEntry(o, 'skipped', 'Stored procedures cannot be read back; recreate it by hand.'),
        );
        return false;
      }
      if (o.kind === 'function' && !same) {
        out.push(
          objectEntry(
            o,
            'skipped',
            'Functions cannot be translated between database engines.',
            o.sql,
          ),
        );
        return false;
      }
      return true;
    });
    for (const o of todo.filter((x) => x.kind === 'function'))
      if (await attempt(o)) out.push(objectEntry(o, 'created'));
    // A view may read another view, so retry the leftovers until a pass makes no progress.
    let views = todo.filter((x) => x.kind === 'view');
    const failed = new Map();
    for (let progress = true; views.length && progress;) {
      progress = false;
      const next = [];
      for (const o of views) {
        const sql = requote(o.sql, dialect.kind, targetKind);
        try {
          await target.raw(sql.replace(/\?/g, '\\?'));
          out.push(objectEntry(o, 'created'));
          progress = true;
        } catch (e) {
          failed.set(o.name, friendly(e));
          next.push(o);
        }
      }
      views = next;
    }
    for (const o of views) out.push(objectEntry(o, 'skipped', failed.get(o.name), o.sql));
    for (const o of todo.filter((x) => x.kind === 'trigger'))
      if (await attempt(o)) out.push(objectEntry(o, 'created'));
    return out;
  }

  /** PostgreSQL does not advance a serial's counter when rows arrive with explicit ids; without this the first new
   *  record after the switch would collide with an existing id. MySQL and SQLite catch up on their own. */
  async function fixSequences(target, tdial, order) {
    if (tdial.kind !== 'pg') return;
    for (const name of order) {
      for (const c of await tdial.columnDetails(name)) {
        if (!c.autoIncrement) continue;
        await target.raw(
          `select setval(pg_get_serial_sequence(?, ?), coalesce((select max("${c.name}") from "${name}"), 1), (select count(*) > 0 from "${name}"))`,
          [`"${name}"`, c.name],
        );
      }
    }
  }

  /** Removes what a copy built in the target: views first (they depend on tables), then tables. `only` limits it to
   *  the tables this run created, so a database someone has since put other things in is never swept. */
  async function wipe(target, only) {
    const tdial = dialectOf(target);
    const all = (await tdial.listTables()).filter(
      (t) => !t.name.startsWith('sqlite_') && !t.name.startsWith('search_fts_'),
    );
    const mine = all.filter((t) => !only || only.includes(t.name));
    const views = mine.filter((t) => t.view).map((t) => t.name);
    const names = mine.filter((t) => !t.view).map((t) => t.name);
    for (const v of views) await target.raw(`drop view if exists ${q(tdial.kind, v)}`);
    if (tdial.kind === 'pg') {
      for (const n of names) await target.raw(`drop table if exists ${q('pg', n)} cascade`);
    } else if (tdial.kind === 'mysql') {
      const conn = await target.client.acquireConnection();
      try {
        await target.client.query(conn, { sql: 'SET FOREIGN_KEY_CHECKS = 0' });
        for (const n of names)
          await target.client.query(conn, { sql: `drop table if exists ${q('mysql', n)}` });
        await target.client.query(conn, { sql: 'SET FOREIGN_KEY_CHECKS = 1' });
      } finally {
        target.client.releaseConnection(conn);
      }
    } else {
      await target.raw('PRAGMA foreign_keys = OFF');
      for (const n of names) await target.raw(`drop table if exists ${q('sqlite', n)}`);
      await target.raw('PRAGMA foreign_keys = ON');
    }
  }
  const q = (kind, ident) => (kind === 'mysql' ? `\`${ident}\`` : `"${ident}"`);

  /**
   * Start over. Clears the status; and, when the new database was already built, empties it again (only the tables
   * this copy created) — which needs its connection string, as proof it is the one that was copied to.
   */
  async function discard(url, actor) {
    const s = await status();
    if (s.state === 'running')
      throw new HttpError(409, 'conflict', 'A copy is running. Wait for it to finish.');
    if (s.built && !s.switched) {
      const parsed = parseTarget(url);
      if (fingerprint(parsed.url) !== s.fingerprint)
        throw new HttpError(
          422,
          'invalid_input',
          'Enter the connection string of the database that was copied to, so it can be cleared.',
          { field: 'url' },
        );
      const target = connect(parsed);
      try {
        await wipe(target, s.ownedTables);
      } finally {
        await target.destroy().catch(() => {});
      }
      await audit.log({
        actor,
        action: 'dbms.move_discarded',
        entity: 'database',
        entityId: parsed.kind,
        meta: { target: redactUrl(parsed.url) },
      });
    }
    local = null;
    await cache.del(STATUS_KEY);
    return { state: 'idle' };
  }

  /**
   * Points THIS server at the copied database by rewriting DB_URL in its .env file (a dated backup is kept), and
   * restarts if asked. The string must be the one that was copied to. Other servers in a cluster each have their own
   * .env, so the answer includes the line to put there.
   */
  async function switchTo(url, { restart }, actor) {
    const s = await status();
    if (s.state !== 'ready')
      throw new HttpError(
        409,
        'conflict',
        'Copy the data and let it pass its checks before switching.',
      );
    const parsed = parseTarget(url);
    if (fingerprint(parsed.url) !== s.fingerprint)
      throw new HttpError(
        422,
        'invalid_input',
        'That is not the database that was copied to. Enter the same connection string.',
        { field: 'url' },
      );
    if (s.switched)
      throw new HttpError(409, 'conflict', 'This server was already switched. Restart it.');

    const file = path.join(appRoot, '.env');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* no .env: DB_URL comes from the real environment */
    }
    const line = `DB_URL=${parsed.url}`;
    const fileWritable = text !== '';
    if (fileWritable) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(`${file}.bak-${stamp}`, text, { mode: 0o600 });
      const next = /^DB_URL=.*$/m.test(text)
        ? text.replace(/^DB_URL=.*$/m, () => line)
        : `${text.replace(/\n?$/, '\n')}${line}\n`;
      fs.writeFileSync(file, next, { mode: 0o600 });
    }
    await writeStatus({ switched: true });
    await audit.log({
      actor,
      action: 'dbms.move_switched',
      entity: 'database',
      entityId: parsed.kind,
      meta: {
        from: dialect.kind,
        to: parsed.kind,
        target: redactUrl(parsed.url),
        restart: !!restart,
      },
    });
    const willRestart = !!restart && fileWritable && !!state.requestRestart;
    if (willRestart) setTimeout(() => state.requestRestart(), 400).unref();
    return {
      envUpdated: fileWritable,
      restarting: willRestart,
      otherServers: `DB_URL=${redactUrl(parsed.url)}`,
      message: fileWritable
        ? "This server's .env now points at the new database. Restart it to start using it."
        : 'This server has no .env file, so DB_URL comes from its environment (Docker, systemd, …). Set it there to the new connection string, then restart.',
    };
  }

  return { test, start, status, discard, switchTo, isRunning: () => working !== null };
}
