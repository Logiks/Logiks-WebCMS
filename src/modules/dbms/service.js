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

    /** Every table/view (minus the ones the structured UI never shows) — the table list screen. */
    async listTables() {
      return (await dialect.listTables()).filter((t) => !SENSITIVE_TABLES.has(t.name));
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
