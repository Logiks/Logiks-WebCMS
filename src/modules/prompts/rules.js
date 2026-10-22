/**
 * Rules the AI builders must follow, by area (D-118). Each area has a prompt (`rules.<area>`, edited under
 * System → Prompts → Rules) that tells the model; areas whose rule MUST hold also have a check here that rejects a
 * non-compliant proposal with a message the model can act on. The prompt text and the check are built from the same
 * setting, so what the model is told and what is enforced cannot drift apart.
 */

/** Areas an AI builder can ask for. A new area needs an entry here and a caller that passes it to `compose`. */
export const RULE_AREAS = [
  {
    id: 'tables',
    label: 'Database tables',
    hint: 'Columns and naming for every table the AI creates.',
  },
  { id: 'pages', label: 'Pages', hint: 'Structure and conventions for every page the AI writes.' },
  { id: 'components', label: 'Components', hint: 'Conventions for every component the AI writes.' },
  { id: 'services', label: 'Services', hint: 'Conventions for every Service the AI creates.' },
  { id: 'content', label: 'Content', hint: 'Conventions for content types and entries.' },
];

export const RULE_PREFIX = 'rules.';

/** Columns every AI-created table gets unless Settings → AI behaviour says otherwise. Timestamps are epoch-ms (CLAUDE.md). */
export const DEFAULT_TABLE_COLUMNS = [
  { name: 'id', type: 'bigInteger', primaryKey: true, autoIncrement: true },
  { name: 'created_at', type: 'bigInteger', nullable: true },
  { name: 'updated_at', type: 'bigInteger', nullable: true },
  { name: 'created_by', type: 'bigInteger', nullable: true },
];

const describeColumn = (c) =>
  `- \`${c.name}\` — ${c.type}${c.primaryKey ? ', primary key' : ''}${c.autoIncrement ? ', auto-increment' : ''}${c.nullable ? ', nullable' : ', required'}`;

/**
 * Per-area checks. `check(input, config)` returns a list of problems (empty = fine); `describe(config)` is text appended
 * to the area's prompt so the model knows exactly what will be checked.
 */
export const RULE_CHECKS = {
  tables: {
    describe(config) {
      const cols = config.tableColumns;
      if (!cols.length) return '';
      return `Every table must include these columns exactly as written. This is checked automatically and a table without them is rejected, so include them in the proposal:\n${cols.map(describeColumn).join('\n')}`;
    },
    /** @param {{ name?: string, columns?: any[] }} table */
    check(table, config) {
      const problems = [];
      const have = new Map((table?.columns ?? []).map((c) => [c.name, c]));
      for (const want of config.tableColumns) {
        const c = have.get(want.name);
        if (!c) {
          problems.push(`Add the column "${want.name}" (${want.type}).`);
          continue;
        }
        if (c.type !== want.type)
          problems.push(`Column "${want.name}" must be type ${want.type}, not ${c.type}.`);
        if (!!want.primaryKey !== !!c.primaryKey || !!want.autoIncrement !== !!c.autoIncrement)
          problems.push(
            want.primaryKey
              ? `Column "${want.name}" must be the auto-increment primary key.`
              : `Column "${want.name}" must not be a primary key.`,
          );
      }
      return problems;
    },
  },
};

/** Settings value → usable list; anything malformed falls back to the defaults rather than disabling the rule. */
export function normaliseTableColumns(value) {
  if (!Array.isArray(value)) return DEFAULT_TABLE_COLUMNS;
  const ok = value.filter(
    (c) =>
      c &&
      typeof c.name === 'string' &&
      /^[a-z][a-z0-9_]*$/.test(c.name) &&
      typeof c.type === 'string',
  );
  return ok.length === value.length ? ok : DEFAULT_TABLE_COLUMNS;
}
