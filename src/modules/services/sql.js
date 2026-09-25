import { HttpError } from '../../core/http/errors.js';

/**
 * SQL-mode Services (docs/DECISIONS.md D-045): a stored, read-only SELECT with named `:param` bindings.
 *
 * What each check protects against, stated precisely rather than as one blanket "it's safe" (see D-045):
 *  - single statement + must-start-with SELECT/WITH: the real backstop on PostgreSQL specifically. Its simple-query
 *    protocol allows semicolon-stacked statements when a query has ZERO bindings — confirmed against a live
 *    instance: `select 1; drop table x` dropped the table. SQLite (better-sqlite3 `.prepare()`) and MySQL
 *    (`mysql2`'s `multipleStatements: false` default) already refuse this at the driver level; the app-level
 *    check is what closes the Postgres gap, not defense-in-depth on top of something else.
 *  - keyword blocklist: the PRIMARY defense against a write, since a rolled-back transaction is not reliable here
 *    (MySQL DDL auto-commits even inside one). Matched on the query with string/comment literals stripped, so a
 *    literal like 'update requested' in a WHERE clause is never a false positive.
 *  - `into outfile` / `into dumpfile`: MySQL can write a file from a statement that still starts with SELECT.
 *
 * A per-dialect statement timeout and a row cap are applied at execution time by `dialect(db).runSelect()`
 * (`src/core/db/index.js`) — not here, since those need a live connection.
 */

const fail = (msg, field) => {
  throw new HttpError(422, 'invalid_input', msg, field ? { field } : undefined);
};

const BLOCKED =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach|pragma|vacuum|replace|exec|execute|call|merge|reindex|analyze|copy|listen|notify|load_file)\b|into\s+outfile|into\s+dumpfile/i;

/** Strip string/quoted-identifier literals and comments so keyword/semicolon checks never see literal text. */
export function stripLiteralsAndComments(sql) {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      out += ' ';
      i++;
      while (i < sql.length) {
        if (sql[i] === c && sql[i + 1] === c) {
          i += 2;
          continue;
        }
        if (sql[i] === c) break;
        i++;
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Throws a friendly 422 for anything that isn't a single, plain SELECT/WITH. Returns the ORIGINAL sql unchanged. */
export function assertSelectOnly(sql) {
  const trimmed = String(sql ?? '').trim();
  if (!trimmed) fail('Write a SELECT query.', 'config.sql');
  const stripped = stripLiteralsAndComments(trimmed).trim();
  if (!/^(select|with)\b/i.test(stripped))
    fail('A Service query must start with SELECT or WITH.', 'config.sql');
  if (stripped.replace(/;\s*$/, '').includes(';'))
    fail('Only one statement is allowed — remove the extra ";".', 'config.sql');
  const hit = BLOCKED.exec(stripped);
  if (hit) fail(`"${hit[0]}" is not allowed — Services are read-only.`, 'config.sql');
  return sql;
}

/** Every `:name` the query text refers to (outside literals/comments), for cross-checking against declared params. */
export function paramsUsedIn(sql) {
  const stripped = stripLiteralsAndComments(sql);
  return [
    ...new Set([...stripped.matchAll(/:([a-z][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase())),
  ];
}

const TYPES = {
  string: (v) => String(v).slice(0, 2000),
  number: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) fail('Expected a number.', 'params');
    return n;
  },
  boolean: (v) => v === true || v === 'true' || v === '1' || v === 1,
};

/** Query-string values → typed, named bindings for `db.raw(sql, bindings)`. Never string-interpolated into the SQL. */
export function bindParams(declared, input) {
  const bindings = {};
  for (const p of declared) {
    const raw = input[p.name];
    if (raw === undefined || raw === '') {
      if (p.required) fail(`Missing required parameter "${p.name}".`, p.name);
      bindings[p.name] = null;
      continue;
    }
    bindings[p.name] = (TYPES[p.type] ?? TYPES.string)(raw);
  }
  return bindings;
}
