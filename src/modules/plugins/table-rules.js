/**
 * The rules for tables a plugin creates from now on (D-147). They are checked when a plugin is created — uploaded,
 * or saved in the Plugin Editor — never while it runs. They apply only to a plugin whose plugin.json says
 * `"tableRules": true`; older plugins, and the tables they already made, are left alone.
 *
 * - named `plugin_*`, so a plugin's table is never mistaken for a system one;
 * - `id` as `bigIncrements` (a BIGINT primary key), which is also what lets Deploy offer Sync for the table;
 * - `created_on`, `edited_on` (epoch milliseconds, BIGINT), `created_by`, `edited_by`.
 *
 * A listing table should also have a `sort_order` column. A table cannot be told to be "a listing" from its shape, so
 * that one is in the plugin editor's instructions, not checked here.
 */
export const REQUIRED_COLUMNS = ['id', 'created_on', 'edited_on', 'created_by', 'edited_by'];

/** Column builders that make a BIGINT. */
const BIG = new Set(['bigIncrements', 'bigInteger', 'bigint', 'specificType']);
const ID_OK = new Set(['bigIncrements', 'bigInteger', 'bigint', 'specificType']);

/**
 * Problems with one new table, as sentences that say how to fix them. Empty when it is fine.
 * @param {string} table @param {Map<string, string>} columns column name → the builder method that made it
 */
export function tableProblems(table, columns) {
  const out = [];
  if (!/^plugin_/.test(table))
    out.push(`"${table}" must be named plugin_<something>, so it is clear it belongs to a plugin.`);
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.has(c));
  if (missing.length)
    out.push(
      `"${table}" needs the column${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (every plugin table has id, created_on, edited_on, created_by and edited_by).`,
    );
  const id = columns.get('id');
  if (id && !ID_OK.has(id))
    out.push(`"${table}".id must be a BIGINT primary key (use t.bigIncrements('id')).`);
  for (const n of ['created_on', 'edited_on']) {
    const m = columns.get(n);
    if (m && !BIG.has(m))
      out.push(`"${table}".${n} must be a BIGINT of epoch milliseconds (t.bigInteger('${n}')).`);
  }
  return out;
}

/** Something that accepts any call, any property and any `await`, so a migration can run against it without a database. */
function sink() {
  const f = () => p;
  const p = new Proxy(f, {
    get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : p),
    apply: () => p,
  });
  return p;
}

/**
 * Runs a migrate.js module's migrations against a stand-in database that only remembers which tables are created and
 * with which columns. Nothing is written anywhere. A migration that cannot finish against the stand-in (it reads rows,
 * say) is checked for what it did create up to that point.
 * @param {any} mod the imported migrate.js
 * @returns {Promise<Map<string, Map<string, string>>>} table → column → builder method
 */
export async function recordTables(mod) {
  /** @type {Map<string, Map<string, string>>} */
  const tables = new Map();
  const create = async (name, cb) => {
    const cols = new Map();
    tables.set(String(name), cols);
    const t = new Proxy(
      {},
      {
        get: (_o, method) => (colName) => {
          if (typeof colName === 'string' && typeof method === 'string')
            cols.set(colName, String(method));
          return sink();
        },
      },
    );
    await cb?.(t);
  };
  const schema = new Proxy(
    {},
    {
      get: (_o, k) => {
        if (k === 'createTable' || k === 'createTableIfNotExists') return create;
        if (k === 'hasTable' || k === 'hasColumn') return async () => false;
        return () => sink();
      },
    },
  );
  const db = new Proxy(() => sink(), {
    get: (_o, k) => {
      if (k === 'schema') return schema;
      if (k === 'transaction') return async (fn) => fn(db);
      return sink();
    },
    apply: () => sink(),
  });
  const list = Array.isArray(mod.migrations) ? mod.migrations.map((m) => m?.up) : [mod.default];
  for (const up of list)
    if (typeof up === 'function') {
      try {
        await up(db, { kind: 'sqlite' });
      } catch {
        /* checked for what it created so far */
      }
    }
  return tables;
}

/**
 * Throws, naming the first table that breaks the rules.
 * @param {any} mod the imported migrate.js @param {(m: string) => Error} fail
 */
export async function assertTableRules(mod, fail) {
  for (const [table, cols] of await recordTables(mod)) {
    const problems = tableProblems(table, cols);
    if (problems.length) throw fail(`migrate.js: ${problems.join(' ')}`);
  }
}
