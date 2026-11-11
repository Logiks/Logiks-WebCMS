/**
 * Finds what a migration's `up()` would remove or rename (D-135). Updates uses it to refuse an update that could lose data
 * unless an admin has said they understand; the repo's own test uses it so a destructive migration cannot be added by accident.
 *
 * Only `up` is read: a `down` that drops what `up` created is expected. This is a text scan, not a proof: it catches the
 * Knex calls and the SQL words that remove or rename tables and columns, and rows deleted wholesale. A migration that has
 * been reviewed and is meant to do so says why with a `// destructive-ok: <reason>` comment, which silences the scan for it.
 */
/** @type {[RegExp, (m: RegExpMatchArray) => string][]} */
const RULES = [
  [/\.dropTable(?:IfExists)?\(\s*(['"`][^'"`]+['"`])/g, (m) => `drops table ${m[1].slice(1, -1)}`],
  [/\.(?:dropColumns?)\(\s*([^)]*)\)/g, (m) => `drops column ${m[1].replace(/['"`\s[\]]/g, '')}`],
  [
    /\.renameTable\(\s*([^)]*)\)/g,
    (m) => `renames table ${m[1].replace(/['"`\s]/g, '').replace(',', ' to ')}`,
  ],
  [
    /\.renameColumn\(\s*([^)]*)\)/g,
    (m) => `renames column ${m[1].replace(/['"`\s]/g, '').replace(',', ' to ')}`,
  ],
  [/\.truncate\(/g, () => 'empties a table'],
  [/\bDROP\s+(?:TABLE|COLUMN)\b[^;'"`]*/gi, (m) => `SQL: ${m[0].trim().slice(0, 60)}`],
  [/\bRENAME\s+(?:TO|COLUMN)\b[^;'"`]*/gi, (m) => `SQL: ${m[0].trim().slice(0, 60)}`],
  [/\bTRUNCATE\s+TABLE\b[^;'"`]*/gi, (m) => `SQL: ${m[0].trim().slice(0, 60)}`],
  [/\bDELETE\s+FROM\s+\w+\s*(?:;|['"`])/gi, (m) => `SQL: ${m[0].trim().slice(0, 60)} (every row)`],
];

/** @param {string} source a migration file @returns {string[]} what its up() removes or renames (empty when nothing) */
export function scanMigration(source) {
  if (/\/\/\s*destructive-ok\b/.test(source)) return [];
  const down = source.search(/export\s+(?:async\s+)?function\s+down\b/);
  const up = down === -1 ? source : source.slice(0, down);
  const found = new Set();
  for (const [re, say] of RULES) for (const m of up.matchAll(re)) found.add(say(m));
  return [...found];
}
