import { HttpError, forbidden, notFound } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Never touchable through the structured browse/edit/create/drop UI, whatever permission tier — the same idea
 * as `SENSITIVE_TABLES` in `src/modules/services/service.js` (D-045), kept as its own copy here rather than a
 * shared import so the two modules can diverge later without one quietly changing the other's guarantee. The
 * raw SQL console (`dbms.query`) is exempt on purpose: that is the entire point of a console (D-047).
 */
export const SENSITIVE_TABLES = new Set([
  'users',
  'sessions',
  'customer_sessions',
  'password_resets',
  'roles',
  'settings',
  'audit_logs',
  'services',
  'site_files',
  'site_meta',
  'contact_messages',
  'knex_migrations',
  'knex_migrations_lock',
  'dbms_saved_queries',
  'seo_rules',
  'analytics_sessions',
  'activity_log',
]);

const TYPE_LABELS = {
  string: 'Short text',
  text: 'Long text',
  integer: 'Whole number',
  bigInteger: 'Big whole number',
  boolean: 'On/off',
  float: 'Decimal number',
  json: 'JSON (stored as text)',
};

/** Column type → Knex schema-builder call. No native date/time type on purpose — this codebase stores every
 *  timestamp as epoch-ms in a bigint (see CLAUDE.md); "Big whole number" is how you add one. */
const BUILD = {
  string: (t, c) => t.string(c.name, Math.min(191, Number(c.length) || 191)),
  text: (t, c) => t.text(c.name, 'longtext'),
  integer: (t, c) => t.integer(c.name),
  bigInteger: (t, c) => t.bigInteger(c.name),
  boolean: (t, c) => t.boolean(c.name),
  float: (t, c) => t.float(c.name),
  json: (t, c) => t.text(c.name, 'longtext'),
};

/** Form-submitted strings → typed values, based on the column's actual SQL type. */
function coerce(value, sqlType) {
  if (value === '' || value === null || value === undefined) return null;
  const t = String(sqlType).toLowerCase();
  if (/int|serial|numeric|real|float|double|decimal/.test(t)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (/bool|tinyint\(1\)/.test(t))
    return value === true || value === 'true' || value === '1' || value === 1;
  return value;
}

/** @param {any} ctx */
export function createDbms(ctx) {
  const { db, dialect, audit } = ctx;

  /** What each engine can say about its tables without scanning them all (SQLite counts, being a single file). */
  async function tableFacts(names) {
    const out = new Map();
    const rowsOf = (r) => (dialect.kind === 'mysql' ? r[0] : dialect.kind === 'pg' ? r.rows : r);
    try {
      if (dialect.kind === 'mysql') {
        const rows = rowsOf(
          await db.raw(
            'select table_name as name, engine, table_rows as r, data_length + index_length as b from information_schema.tables where table_schema = database() and table_type = ?',
            ['BASE TABLE'],
          ),
        );
        for (const r of rows)
          out.set(r.name ?? r.NAME ?? r.TABLE_NAME, {
            engine: r.engine ?? r.ENGINE ?? null,
            rows: r.r === null || r.r === undefined ? null : Number(r.r ?? r.R),
            approx: true,
            bytes: r.b === null || r.b === undefined ? null : Number(r.b ?? r.B),
          });
      } else if (dialect.kind === 'pg') {
        const rows = rowsOf(
          await db.raw(
            "select c.relname as name, coalesce(am.amname, 'heap') as engine, greatest(c.reltuples, 0)::bigint as r, pg_total_relation_size(c.oid) as b from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_am am on am.oid = c.relam where n.nspname = current_schema() and c.relkind in ('r', 'p')",
          ),
        );
        for (const r of rows)
          out.set(r.name, {
            engine: r.engine,
            rows: Number(r.r),
            approx: true,
            bytes: Number(r.b),
          });
      } else {
        const sizes = new Map();
        try {
          // dbstat is a SQLite option; where it is missing the size is simply not shown.
          const owner = new Map(
            rowsOf(await db.raw('select name, tbl_name from sqlite_master')).map((r) => [
              r.name,
              r.tbl_name,
            ]),
          );
          for (const r of rowsOf(
            await db.raw('select name, sum(pgsize) as b from dbstat group by name'),
          )) {
            const t = owner.get(r.name) ?? r.name;
            sizes.set(t, (sizes.get(t) ?? 0) + Number(r.b));
          }
        } catch {
          /* no dbstat */
        }
        for (const n of names) {
          out.set(n, {
            engine: 'SQLite',
            rows: Number((await db(n).count({ n: '*' }).first()).n),
            approx: false,
            bytes: sizes.get(n) ?? null,
          });
        }
      }
    } catch {
      /* the list still works, with dashes */
    }
    return out;
  }

  function checkIdent(name, field) {
    if (!IDENT.test(name))
      throw new HttpError(422, 'invalid_input', `"${name}" isn't a valid name.`, { field });
  }
  function checkEditable(table) {
    checkIdent(table, 'table');
    if (SENSITIVE_TABLES.has(table))
      throw new HttpError(
        422,
        'invalid_input',
        `"${table}" can't be changed here — the SQL console can, if you really need to.`,
        { field: 'table' },
      );
  }

  const svc = {
    typeLabels: TYPE_LABELS,

    /**
     * Every table/view (minus the ones the structured UI never shows) with what the list screen shows: the number of
     * records (exact on SQLite, the engine's own estimate on MySQL/PostgreSQL, marked `approx`), the storage engine, and the
     * size on disk. A figure an engine does not offer is null (the screen shows a dash).
     */
    async listTables() {
      const base = (await dialect.listTables()).filter((t) => !SENSITIVE_TABLES.has(t.name));
      const facts = await tableFacts(base.filter((t) => !t.view).map((t) => t.name));
      return base.map((t) => ({
        name: t.name,
        view: !!t.view,
        engine: t.view ? null : (facts.get(t.name)?.engine ?? null),
        rows: t.view ? null : (facts.get(t.name)?.rows ?? null),
        approx: !t.view && !!facts.get(t.name)?.approx,
        bytes: t.view ? null : (facts.get(t.name)?.bytes ?? null),
      }));
    },

    /**
     * Keeps a table in good shape: `optimize` rebuilds it and its indexes where the engine can (MySQL OPTIMIZE TABLE, PostgreSQL
     * VACUUM ANALYZE, SQLite REINDEX + ANALYZE: SQLite reclaims space only for the whole file), `analyze` refreshes the figures the
     * query planner uses. Neither changes a record. Needs `dbms.write`, and is refused for the tables the browser hides.
     * @param {string} table @param {'optimize'|'analyze'} action
     */
    async maintain(table, action, actor) {
      if (!actor?.can('dbms.write')) throw forbidden();
      checkEditable(table);
      if (!['optimize', 'analyze'].includes(action))
        throw new HttpError(422, 'invalid_input', 'Choose optimise or analyse.', {
          field: 'action',
        });
      const known = (await dialect.listTables()).find((t) => t.name === table);
      if (!known) throw notFound('That table');
      if (known.view)
        throw new HttpError(
          422,
          'invalid_input',
          `“${table}” is a view, which has nothing to optimise.`,
        );
      let message;
      if (dialect.kind === 'mysql') {
        const verb = action === 'optimize' ? 'optimize' : 'analyze';
        const [rows] = await db.raw(`${verb} table ??`, [table]);
        const bad = rows.find((r) => String(r.Msg_type).toLowerCase() === 'error');
        if (bad) throw new HttpError(500, 'maintenance_failed', String(bad.Msg_text));
        const note = rows.find((r) => String(r.Msg_type).toLowerCase() === 'note');
        message =
          action === 'optimize'
            ? `Optimised${note ? ` (${String(note.Msg_text).replace(/\.$/, '')})` : ''}.`
            : 'Analysed.';
      } else if (dialect.kind === 'pg') {
        await db.raw(action === 'optimize' ? 'vacuum (analyze) ??' : 'analyze ??', [table]);
        message = action === 'optimize' ? 'Cleaned up and analysed.' : 'Analysed.';
      } else {
        if (action === 'optimize') await db.raw('reindex ??', [table]);
        await db.raw('analyze ??', [table]);
        message =
          action === 'optimize'
            ? 'Indexes rebuilt and analysed. SQLite gives space back for the whole file only, not per table.'
            : 'Analysed.';
      }
      await audit.log({
        actor,
        action: 'dbms.table_maintained',
        entity: 'table',
        entityId: table,
        meta: { action },
      });
      return { table, action, message };
    },

    /** Columns + indexes. Read-only, so a sensitive table's STRUCTURE (not its data) can still be inspected. */
    async tableInfo(table) {
      checkIdent(table, 'table');
      if (!(await db.schema.hasTable(table))) throw notFound('That table');
      const [columns, indexes] = await Promise.all([
        dialect.columnDetails(table),
        dialect.indexList(table),
      ]);
      return { table, sensitive: SENSITIVE_TABLES.has(table), columns, indexes };
    },

    /**
     * Paginated row browse. Read-only — same reasoning as tableInfo: browsing a sensitive table's shape is fine.
     * @param {string} table
     * @param {{page?: number|string, perPage?: number|string, sort?: string, sortDir?: string}} [opts]
     */
    async listRows(table, { page = 1, perPage = 25, sort, sortDir = 'asc' } = {}) {
      const { columns } = await svc.tableInfo(table);
      const colNames = new Set(columns.map((c) => c.name));
      const p = Math.min(200, Math.max(1, Math.floor(Number(perPage)) || 25));
      const pg = Math.max(1, Math.floor(Number(page)) || 1);
      const totalRow = await db(table).count({ n: '*' }).first();
      let q = db(table)
        .limit(p)
        .offset((pg - 1) * p);
      if (sort && colNames.has(sort)) q = q.orderBy(sort, sortDir === 'desc' ? 'desc' : 'asc');
      const rows = await q;
      const total = Number(totalRow.n);
      return {
        columns,
        rows,
        page: pg,
        perPage: p,
        total,
        pages: Math.max(1, Math.ceil(total / p)),
      };
    },

    async createRecord(table, data, actor) {
      checkEditable(table);
      if (!actor?.can('dbms.write')) throw forbidden();
      const { columns } = await svc.tableInfo(table);
      const clean = Object.fromEntries(
        columns.filter((c) => c.name in data).map((c) => [c.name, coerce(data[c.name], c.type)]),
      );
      const pkCol = columns.find((c) => c.primaryKey)?.name ?? 'id';
      const id = await dialect.insertGetId(db(table), clean, pkCol);
      await audit.log({ actor, action: 'dbms.record_created', entity: table, entityId: id });
      return { [pkCol]: id, ...clean };
    },

    async updateRecord(table, pkValues, data, actor) {
      checkEditable(table);
      if (!actor?.can('dbms.write')) throw forbidden();
      const { columns } = await svc.tableInfo(table);
      const clean = Object.fromEntries(
        columns.filter((c) => c.name in data).map((c) => [c.name, coerce(data[c.name], c.type)]),
      );
      const n = await db(table).where(pkValues).update(clean);
      if (!n) throw notFound('That record');
      await audit.log({
        actor,
        action: 'dbms.record_updated',
        entity: table,
        entityId: Object.values(pkValues).join(','),
      });
    },

    async deleteRecord(table, pkValues, actor) {
      checkEditable(table);
      if (!actor?.can('dbms.write')) throw forbidden();
      const n = await db(table).where(pkValues).del();
      if (!n) throw notFound('That record');
      await audit.log({
        actor,
        action: 'dbms.record_deleted',
        entity: table,
        entityId: Object.values(pkValues).join(','),
      });
    },

    async createTable({ name, columns }, actor) {
      if (!actor?.can('dbms.write')) throw forbidden();
      checkIdent(name, 'name');
      if (SENSITIVE_TABLES.has(name))
        throw new HttpError(422, 'invalid_input', `"${name}" is a reserved name.`, {
          field: 'name',
        });
      if (await db.schema.hasTable(name))
        throw new HttpError(422, 'invalid_input', `"${name}" already exists.`, { field: 'name' });
      if (!columns?.length)
        throw new HttpError(422, 'invalid_input', 'Add at least one column.', { field: 'columns' });
      const seen = new Set();
      for (const c of columns) {
        checkIdent(c.name, 'columns');
        if (seen.has(c.name))
          throw new HttpError(422, 'invalid_input', `"${c.name}" is used twice.`, {
            field: 'columns',
          });
        seen.add(c.name);
        if (!BUILD[c.type] && !(c.primaryKey && c.autoIncrement))
          throw new HttpError(422, 'invalid_input', `"${c.type}" isn't a column type.`, {
            field: 'columns',
          });
      }
      const primaryKeys = columns
        .filter((c) => c.primaryKey && !c.autoIncrement)
        .map((c) => c.name);
      await db.schema.createTable(name, (t) => {
        for (const c of columns) {
          if (c.primaryKey && c.autoIncrement) {
            c.type === 'bigInteger' ? t.bigIncrements(c.name) : t.increments(c.name);
            continue;
          }
          const col = BUILD[c.type](t, c);
          if (!c.nullable) col.notNullable();
          if (c.default !== undefined && c.default !== '') col.defaultTo(coerce(c.default, c.type));
        }
        if (primaryKeys.length) t.primary(primaryKeys);
      });
      await audit.log({ actor, action: 'dbms.table_created', entity: 'table', entityId: name });
    },

    async dropTable(name, actor) {
      if (!actor?.can('dbms.write')) throw forbidden();
      checkEditable(name);
      if (!(await db.schema.hasTable(name))) throw notFound('That table');
      await db.schema.dropTable(name);
      await audit.log({ actor, action: 'dbms.table_dropped', entity: 'table', entityId: name });
    },

    /** Add one column to an existing table (nullable unless it has a default: existing rows must stay valid). */
    async addColumn(table, column, actor) {
      checkEditable(table);
      if (!actor?.can('dbms.write')) throw forbidden();
      checkIdent(column?.name, 'column');
      if (!BUILD[column.type])
        throw new HttpError(422, 'invalid_input', `"${column.type}" isn't a column type.`, {
          field: 'column',
        });
      const { columns } = await svc.tableInfo(table);
      if (columns.some((c) => c.name === column.name))
        throw new HttpError(422, 'invalid_input', `"${column.name}" already exists.`, {
          field: 'column',
        });
      const hasDefault = column.default !== undefined && column.default !== '';
      if (column.nullable === false && !hasDefault)
        throw new HttpError(
          422,
          'invalid_input',
          'A required column needs a default value, because the existing rows have none.',
          { field: 'column' },
        );
      await db.schema.alterTable(table, (t) => {
        const col = BUILD[column.type](t, column);
        if (column.nullable === false) col.notNullable();
        if (hasDefault) col.defaultTo(coerce(column.default, column.type));
      });
      await audit.log({
        actor,
        action: 'dbms.column_added',
        entity: table,
        entityId: column.name,
      });
    },

    /** Remove a column and its data. The primary key cannot go: the row editor addresses rows by it. */
    async dropColumn(table, name, actor) {
      checkEditable(table);
      if (!actor?.can('dbms.write')) throw forbidden();
      checkIdent(name, 'column');
      const { columns } = await svc.tableInfo(table);
      const col = columns.find((c) => c.name === name);
      if (!col) throw notFound('That column');
      if (col.primaryKey)
        throw new HttpError(
          422,
          'invalid_input',
          `"${name}" is the primary key and cannot be removed.`,
          {
            field: 'column',
          },
        );
      if (columns.length === 1)
        throw new HttpError(422, 'invalid_input', 'A table needs at least one column.', {
          field: 'column',
        });
      await db.schema.alterTable(table, (t) => t.dropColumn(name));
      await audit.log({ actor, action: 'dbms.column_dropped', entity: table, entityId: name });
    },

    async createIndex(table, { name, columns: cols, unique }, actor) {
      checkEditable(table);
      if (!actor?.can('dbms.write')) throw forbidden();
      checkIdent(name, 'name');
      if (!Array.isArray(cols) || !cols.length)
        throw new HttpError(422, 'invalid_input', 'Choose at least one column to index.', {
          field: 'columns',
        });
      const info = await svc.tableInfo(table);
      const have = new Set(info.columns.map((c) => c.name));
      for (const c of cols)
        if (!have.has(c))
          throw new HttpError(422, 'invalid_input', `"${c}" isn't a column of ${table}.`, {
            field: 'columns',
          });
      if (info.indexes.some((i) => i.name === name))
        throw new HttpError(422, 'invalid_input', `An index named "${name}" already exists.`, {
          field: 'name',
        });
      await db.schema.alterTable(table, (t) =>
        unique ? t.unique(cols, { indexName: name }) : t.index(cols, name),
      );
      await audit.log({ actor, action: 'dbms.index_created', entity: table, entityId: name });
    },

    async dropIndex(table, name, actor) {
      checkEditable(table);
      if (!actor?.can('dbms.write')) throw forbidden();
      checkIdent(name, 'name');
      const info = await svc.tableInfo(table);
      const idx = info.indexes.find((i) => i.name === name);
      if (!idx) throw notFound('That index');
      if (/^primary$|_pkey$|^sqlite_autoindex_/i.test(name))
        throw new HttpError(422, 'invalid_input', 'The primary key index cannot be removed.', {
          field: 'name',
        });
      await db.schema.alterTable(table, (t) => t.dropIndex([], name));
      await audit.log({ actor, action: 'dbms.index_dropped', entity: table, entityId: name });
    },

    /** The console: literally anything the engine allows. `dbms.query` is the top permission tier (D-047). */
    async runQuery(sql, actor) {
      if (!actor?.can('dbms.query')) throw forbidden();
      const trimmed = String(sql ?? '').trim();
      if (!trimmed)
        throw new HttpError(422, 'invalid_input', 'Write a query first.', { field: 'sql' });
      const started = now();
      try {
        const result = await dialect.runAny(trimmed);
        // The query text itself is logged (truncated) for accountability — this is an admin's own authored
        // text, not a secret value in the sense CLAUDE.md means (a password, a key); a query COULD embed one as
        // a literal, so treat the audit log itself as sensitive, same as any other place SQL text is stored.
        await audit.log({
          actor,
          action: 'dbms.query_run',
          meta: { sql: trimmed.slice(0, 500), rowCount: result.rowCount, ms: now() - started },
        });
        return result;
      } catch (e) {
        await audit.log({
          actor,
          action: 'dbms.query_failed',
          meta: { sql: trimmed.slice(0, 500), message: String(e.message).slice(0, 300) },
        });
        throw new HttpError(400, 'query_error', String(e.message).slice(0, 500));
      }
    },

    async listSavedQueries() {
      return (await db('dbms_saved_queries').orderBy('name')).map((r) => ({
        id: Number(r.id),
        name: r.name,
        sql: r.sql,
        createdAt: Number(r.created_at),
      }));
    },
    async saveQuery({ name, sql }, actor) {
      if (!actor?.can('dbms.query')) throw forbidden();
      const id = await dialect.insertGetId(db('dbms_saved_queries'), {
        name,
        sql,
        created_by: actor?.id ?? null,
        created_at: now(),
      });
      await audit.log({
        actor,
        action: 'dbms.query_saved',
        entity: 'dbms_saved_query',
        entityId: name,
      });
      return { id, name, sql };
    },
    async deleteSavedQuery(id, actor) {
      if (!actor?.can('dbms.query')) throw forbidden();
      await db('dbms_saved_queries')
        .where({ id: Number(id) })
        .del();
    },
  };
  return svc;
}
