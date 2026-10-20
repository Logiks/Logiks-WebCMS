import knexLib from 'knex';
import pg from 'pg';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Postgres returns BIGINT (oid 20) as string. We store epoch-ms in BIGINT columns, so parse to number.
pg.types.setTypeParser(20, (v) => Number(v));

export function migrationConfig() {
  return {
    directory: path.join(ROOT, 'migrations'),
    loadExtensions: ['.js'],
    tableName: 'knex_migrations',
  };
}

/** @param {import('../env.js').Env} env */
export function createDb(env) {
  let config;
  if (env.dbKind === 'sqlite') {
    try {
      createRequire(import.meta.url).resolve('better-sqlite3');
    } catch {
      throw new Error(
        'SQLite needs the optional "better-sqlite3" package, which is not installed (its native build may have failed). Use MySQL/PostgreSQL via DB_URL, or reinstall with build tools available.',
      );
    }
    const rel = env.DB_URL.replace(/^sqlite:(\/\/)?/, '');
    const filename = rel === ':memory:' ? rel : path.resolve(ROOT, rel);
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    config = {
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      // SQLite has a single writer; a tiny pool avoids "database is locked" churn.
      pool: {
        min: 1,
        max: 1,
        afterCreate(conn, done) {
          conn.pragma('journal_mode = WAL');
          conn.pragma('busy_timeout = 5000');
          conn.pragma('foreign_keys = ON');
          done(null, conn);
        },
      },
    };
  } else {
    config = {
      client: env.dbKind === 'mysql' ? 'mysql2' : 'pg',
      connection: env.DB_URL,
      pool: { min: env.DB_POOL_MIN, max: env.DB_POOL_MAX },
    };
  }
  return knexLib({ ...config, migrations: migrationConfig() });
}

export const now = () => Date.now();

/**
 * Dialect helpers — the only place engine differences are allowed to leak.
 * @param {import('knex').Knex} knex
 */
export function dialect(knex) {
  const client = String(knex.client.config.client);
  const kind = client.includes('sqlite') ? 'sqlite' : client.includes('mysql') ? 'mysql' : 'pg';
  return {
    kind,
    /** Row-lock inside a transaction (no-op on SQLite, which serialises writers anyway). */
    lock: (qb) => (kind === 'sqlite' ? qb : qb.forUpdate()),
    /** INSERT returning the new primary key on every engine. */
    async insertGetId(qb, row, idCol = 'id') {
      if (kind === 'mysql') {
        const [id] = await qb.insert(row);
        return Number(id);
      }
      const [r] = await qb.insert(row).returning(idCol);
      return Number(typeof r === 'object' ? r[idCol] : r);
    },
    /** Cheap connectivity probe for /readyz. */
    async ping() {
      await knex.raw('select 1');
    },
    /**
     * An epoch-ms BIGINT column truncated to its calendar day, as a 'YYYY-MM-DD' string — for a daily trend chart
     * (Analytics, D-057). `alias` bakes an `as <alias>` into the raw expression for a SELECT; leave it off to
     * reuse the identical expression in GROUP BY (grouping by an aliased column name is not portable everywhere).
     * `column` is always a fixed, code-supplied identifier — never user input.
     */
    dayBucket(column, alias) {
      // Each must yield a STRING, not an engine DATE type: mysql2 auto-converts date() to a JS Date object,
      // which breaks GROUP BY (a fresh object per row) and any caller expecting 'YYYY-MM-DD' text — date_format()
      // returns varchar instead. SQLite's date() and Postgres's to_char() are already text.
      const expr =
        kind === 'sqlite'
          ? `date(${column} / 1000, 'unixepoch')`
          : kind === 'mysql'
            ? `date_format(from_unixtime(${column} / 1000), '%Y-%m-%d')`
            : `to_char(to_timestamp(${column} / 1000.0), 'YYYY-MM-DD')`;
      return knex.raw(alias ? `${expr} as ${alias}` : expr);
    },
    /** Every table and view in this database (Services' table-source query mode, `src/modules/services/`). */
    async listTables() {
      if (kind === 'sqlite') {
        const rows = await knex.raw(
          "select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%'",
        );
        return rows.map((r) => ({ name: r.name, view: r.type === 'view' }));
      }
      if (kind === 'mysql') {
        const [rows] = await knex.raw(
          'select table_name as name, table_type as type from information_schema.tables where table_schema = database()',
        );
        return rows.map((r) => ({ name: r.name, view: r.type === 'VIEW' }));
      }
      const { rows } = await knex.raw(
        "select table_name as name, table_type as type from information_schema.tables where table_schema = 'public'",
      );
      return rows.map((r) => ({ name: r.name, view: r.type === 'VIEW' }));
    },
    /**
     * Run a validated read-only SELECT (Services, `src/modules/services/`) with named `:param` bindings, a
     * per-dialect statement timeout where the engine actually supports one, and a cap on the rows returned.
     * What this does and does NOT protect against is asymmetric across engines — see `src/modules/services/sql.js`.
     * @param {string} sql @param {Record<string, unknown>} bindings @param {{timeoutMs: number, rowLimit: number}} limits
     */
    async runSelect(sql, bindings, { timeoutMs, rowLimit }) {
      // PostgreSQL's SET does not accept a bound parameter ("syntax error at or near $1"), so the number is
      // inlined — safe because it is our own settings value, never attacker input, and forced to a plain integer.
      const ms = Math.max(0, Math.floor(Number(timeoutMs)) || 0);
      if (kind === 'pg') {
        return knex.transaction(async (trx) => {
          await trx.raw(`SET LOCAL statement_timeout = ${ms}`); // self-resets when the transaction ends
          const { rows } = await trx.raw(sql, bindings);
          return rows.slice(0, rowLimit);
        });
      }
      if (kind === 'mysql') {
        return knex.transaction(async (trx) => {
          await trx.raw('SET SESSION MAX_EXECUTION_TIME = ?', [timeoutMs]);
          try {
            const [rows] = await trx.raw(sql, bindings);
            return rows.slice(0, rowLimit);
          } finally {
            // SET SESSION, unlike Postgres's SET LOCAL, outlives the transaction on the pooled connection.
            await trx.raw('SET SESSION MAX_EXECUTION_TIME = 0');
          }
        });
      }
      // SQLite (better-sqlite3) is synchronous: nothing can interrupt a running query from outside it. Dev/test
      // only (D-018) — the keyword blocklist and row cap are what stand in for a timeout here.
      const rows = await knex.raw(sql, bindings);
      return rows.slice(0, rowLimit);
    },
    /**
     * A table's columns (System → Database, `src/modules/dbms/`). `table` is interpolated directly for SQLite's
     * PRAGMA (which does not accept a bound parameter there) — safe only because every caller has already
     * checked it against a real, introspected table name, never raw user text.
     * @param {string} table
     */
    async columnDetails(table) {
      if (kind === 'sqlite') {
        const rows = await knex.raw(`PRAGMA table_info("${table}")`);
        const pkCount = rows.filter((r) => r.pk > 0).length;
        return rows.map((r) => ({
          name: r.name,
          type: r.type,
          nullable: !r.notnull,
          default: r.dflt_value,
          primaryKey: r.pk > 0,
          // Only a single-column INTEGER key is the rowid alias; the first column of a composite key is not.
          autoIncrement: pkCount === 1 && r.pk === 1 && /int/i.test(r.type),
        }));
      }
      if (kind === 'mysql') {
        const [rows] = await knex.raw(
          'select column_name, data_type, is_nullable, column_default, column_key, extra from information_schema.columns where table_schema = database() and table_name = ? order by ordinal_position',
          [table],
        );
        return rows.map((r) => ({
          name: r.COLUMN_NAME,
          type: r.DATA_TYPE,
          nullable: r.IS_NULLABLE === 'YES',
          default: r.COLUMN_DEFAULT,
          primaryKey: r.COLUMN_KEY === 'PRI',
          autoIncrement: String(r.EXTRA).includes('auto_increment'),
        }));
      }
      const { rows } = await knex.raw(
        "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = ? order by ordinal_position",
        [table],
      );
      const { rows: pkRows } = await knex.raw(
        'select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = ?::regclass and i.indisprimary',
        [table],
      );
      const pk = new Set(pkRows.map((r) => r.attname));
      return rows.map((r) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        default: r.column_default,
        primaryKey: pk.has(r.column_name),
        autoIncrement: /^nextval\(/.test(r.column_default || ''),
      }));
    },
    /**
     * Every foreign key in the database as { table, column, refTable, refColumn } — the database mover
     * (`src/modules/dbms/migrate.js`) uses it to copy parents before children.
     */
    async foreignKeys() {
      if (kind === 'sqlite') {
        const out = [];
        for (const t of await this.listTables()) {
          if (t.view) continue;
          for (const f of await knex.raw(`PRAGMA foreign_key_list("${t.name}")`))
            out.push({ table: t.name, column: f.from, refTable: f.table, refColumn: f.to });
        }
        return out;
      }
      if (kind === 'mysql') {
        const [rows] = await knex.raw(
          'select table_name as t, column_name as c, referenced_table_name as rt, referenced_column_name as rc from information_schema.key_column_usage where table_schema = database() and referenced_table_name is not null',
        );
        return rows.map((r) => ({ table: r.t, column: r.c, refTable: r.rt, refColumn: r.rc }));
      }
      const { rows } = await knex.raw(
        `select kcu.table_name as t, kcu.column_name as c, ccu.table_name as rt, ccu.column_name as rc
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
           join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
          where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`,
      );
      return rows.map((r) => ({ table: r.t, column: r.c, refTable: r.rt, refColumn: r.rc }));
    },
    /**
     * Programmable objects that live beside the tables, as { kind, name, table?, sql }: 'view', 'trigger' and (where
     * the engine lets us read them back faithfully) 'function'. `sql` is a runnable CREATE statement for THIS engine.
     * Routines we can't rebuild (MySQL procedures) come back with `sql: null` so a mover can at least name them.
     */
    async objects() {
      if (kind === 'sqlite') {
        const rows = await knex.raw(
          "select type, name, tbl_name, sql from sqlite_master where type in ('view','trigger') and sql is not null",
        );
        return rows.map((r) => ({
          kind: r.type,
          name: r.name,
          table: r.type === 'trigger' ? r.tbl_name : undefined,
          sql: r.sql,
        }));
      }
      if (kind === 'mysql') {
        const [[{ db: schema }]] = await knex.raw('select database() as db');
        const [views] = await knex.raw(
          'select table_name as n, view_definition as d from information_schema.views where table_schema = database()',
        );
        const [triggers] = await knex.raw(
          'select trigger_name as n, event_object_table as t, action_timing as tm, event_manipulation as ev, action_statement as s from information_schema.triggers where trigger_schema = database()',
        );
        const [routines] = await knex.raw(
          'select routine_name as n, routine_type as t from information_schema.routines where routine_schema = database()',
        );
        // MySQL prints view bodies with the schema name in front of every table; drop it so the view moves.
        const unqualify = (sql) => sql.split(`\`${schema}\`.`).join('');
        return [
          ...views.map((v) => ({
            kind: 'view',
            name: v.n,
            sql: `CREATE VIEW \`${v.n}\` AS ${unqualify(v.d)}`,
          })),
          ...triggers.map((t) => ({
            kind: 'trigger',
            name: t.n,
            table: t.t,
            sql: `CREATE TRIGGER \`${t.n}\` ${t.tm} ${t.ev} ON \`${t.t}\` FOR EACH ROW ${unqualify(t.s)}`,
          })),
          ...routines.map((r) => ({ kind: String(r.t).toLowerCase(), name: r.n, sql: null })),
        ];
      }
      const { rows: views } = await knex.raw(
        "select viewname as n, definition as d from pg_views where schemaname = 'public'",
      );
      const { rows: triggers } = await knex.raw(
        `select t.tgname as n, c.relname as t, pg_get_triggerdef(t.oid) as s
           from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace ns on ns.oid = c.relnamespace
          where not t.tgisinternal and ns.nspname = 'public'`,
      );
      const { rows: fns } = await knex.raw(
        `select p.proname as n, pg_get_functiondef(p.oid) as s
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public' and p.prokind = 'f'
            and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
      );
      return [
        ...fns.map((f) => ({ kind: 'function', name: f.n, sql: f.s })),
        ...views.map((v) => ({ kind: 'view', name: v.n, sql: `CREATE VIEW "${v.n}" AS ${v.d}` })),
        ...triggers.map((t) => ({ kind: 'trigger', name: t.n, table: t.t, sql: t.s })),
      ];
    },
    /** A table's indexes: { name, columns, unique }[]. Same interpolation note as columnDetails. */
    async indexList(table) {
      if (kind === 'sqlite') {
        const idx = await knex.raw(`PRAGMA index_list("${table}")`);
        const out = [];
        for (const i of idx) {
          const cols = await knex.raw(`PRAGMA index_info("${i.name}")`);
          out.push({ name: i.name, unique: !!i.unique, columns: cols.map((c) => c.name) });
        }
        return out;
      }
      if (kind === 'mysql') {
        const [rows] = await knex.raw(
          'select index_name, column_name, non_unique from information_schema.statistics where table_schema = database() and table_name = ? order by index_name, seq_in_index',
          [table],
        );
        const byName = new Map();
        for (const r of rows) {
          const e = byName.get(r.INDEX_NAME) ?? {
            name: r.INDEX_NAME,
            unique: !r.NON_UNIQUE,
            columns: [],
          };
          e.columns.push(r.COLUMN_NAME);
          byName.set(r.INDEX_NAME, e);
        }
        return [...byName.values()];
      }
      const { rows } = await knex.raw(
        'select indexname, indexdef from pg_indexes where tablename = ?',
        [table],
      );
      // indexdef is a full CREATE INDEX statement; the column list is the only part worth showing here.
      return rows.map((r) => ({
        name: r.indexname,
        unique: /create unique index/i.test(r.indexdef),
        columns: (/\(([^)]+)\)/.exec(r.indexdef)?.[1] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }));
    },
    /**
     * Run ANY statement — the System → Database console (`dbms.query`). No restriction on statement type: that
     * is the point of a console. Normalises the very different per-driver result shapes into one: SELECT-like
     * results get `rows`; INSERT/UPDATE/DELETE get `rowCount` (and `lastInsertRowid` where the engine gives one).
     * @param {string} sql
     */
    async runAny(sql) {
      const r = await knex.raw(sql);
      if (kind === 'sqlite') {
        if (Array.isArray(r)) return { rows: r, rowCount: r.length, command: 'SELECT' };
        return {
          rows: [],
          rowCount: r.changes ?? 0,
          command: 'WRITE',
          lastInsertRowid: r.lastInsertRowid,
        };
      }
      if (kind === 'mysql') {
        if (Array.isArray(r[0])) return { rows: r[0], rowCount: r[0].length, command: 'SELECT' };
        return {
          rows: [],
          rowCount: r[0]?.affectedRows ?? 0,
          command: 'WRITE',
          lastInsertRowid: r[0]?.insertId || undefined,
        };
      }
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0, command: r.command ?? 'SELECT' };
    },
  };
}
