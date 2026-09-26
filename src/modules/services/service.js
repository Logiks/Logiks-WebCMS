import { z } from 'zod';
import AdmZip from 'adm-zip';
import { HttpError, forbidden, notFound } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';
import { assertSelectOnly, bindParams, paramsUsedIn } from './sql.js';

/**
 * Services (docs/DECISIONS.md D-045, D-046): admin-defined API endpoints beyond the content-type API.
 *   mode: 'query'   a saved, safe view — either over one registered content type (structurally bounded to
 *                   `content.listPublished`, no path to a join or an arbitrary table), or, behind `services.sql`,
 *                   over one database table/view (still built with Knex's query builder, never raw SQL text,
 *                   but the table can be anything not on the SENSITIVE_TABLES blocklist).
 *   mode: 'sql'     a read-only SELECT with named `:param` bindings (see sql.js for exactly what is and
 *                   isn't protected against, and why — it is asymmetric across SQLite/MySQL/PostgreSQL).
 *   mode: 'script'  complete, UNSANDBOXED Node.js: `async (req, ctx) => {...}` with the full platform context
 *                   (database, decrypted settings, mailer, everything). No isolation at all — this is the same
 *                   trust level as shell access to the server (D-046). Gated by `services.script`.
 * `services.write` is enough for query mode over a content type; `services.sql` is required on top of it for
 * SQL mode or a table-source query; `services.script` is required on top of it for script mode. None of the three
 * extra permissions should be granted in a seed role other than the wildcard administrator (permissions.js).
 * @param {any} ctx
 */
export function createServices(ctx) {
  const { db, dialect, settings, audit, content } = ctx;
  const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
  const NAME = /^[a-z][a-z0-9_]*$/;

  // Never selectable through the table-source query builder, however permissive the operator is otherwise:
  // credentials, session tokens, encrypted settings, and the platform's own bookkeeping tables.
  const SENSITIVE_TABLES = new Set([
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

  const paramSchema = z.object({
    name: z.string().regex(NAME, 'Parameter names are lowercase letters, numbers and underscores.'),
    type: z.enum(['string', 'number', 'boolean']).default('string'),
    required: z.boolean().default(false),
  });
  const queryTypeConfigSchema = z.object({
    source: z.literal('type').default('type'),
    type: z.string().regex(NAME),
    termId: z.number().int().positive().optional(),
    sort: z.enum(['newest', 'path']).default('newest'),
    perPage: z
      .object({
        default: z.number().int().min(1).max(200).default(10),
        max: z.number().int().min(1).max(200).default(50),
      })
      .default({ default: 10, max: 50 }),
    fields: z.array(z.string().regex(NAME)).max(50).optional(),
  });
  const queryTableConfigSchema = z.object({
    source: z.literal('table'),
    table: z.string().regex(NAME),
    columns: z.array(z.string().regex(NAME)).min(1).max(50),
    where: z
      .array(z.object({ column: z.string().regex(NAME), param: z.string().regex(NAME) }))
      .max(10)
      .default([]),
    params: z.array(paramSchema).max(20).default([]),
    sort: z
      .object({ column: z.string().regex(NAME), dir: z.enum(['asc', 'desc']).default('asc') })
      .optional(),
    perPage: z
      .object({
        default: z.number().int().min(1).max(200).default(10),
        max: z.number().int().min(1).max(200).default(50),
      })
      .default({ default: 10, max: 50 }),
  });
  const sqlConfigSchema = z.object({
    sql: z.string().min(1).max(20_000),
    params: z.array(paramSchema).max(20).default([]),
    rowLimit: z.number().int().min(1).max(10_000).optional(),
  });
  const scriptConfigSchema = z.object({
    code: z.string().min(1).max(50_000),
  });
  const baseSchema = z.object({
    slug: z
      .string()
      .regex(SLUG, 'Use lowercase letters, numbers and dashes, starting with a letter.'),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional().default(''),
    mode: z.enum(['query', 'sql', 'script']),
    access: z.enum(['public', 'customer']).default('public'),
    enabled: z.boolean().default(false),
  });

  const bad = (issue) =>
    new HttpError(422, 'invalid_input', issue.message, {
      field: issue.path.join('.') || undefined,
    });

  const parseConfig = (schema, input) => {
    const r = schema.safeParse(input);
    if (!r.success)
      throw bad({ ...r.error.issues[0], path: ['config', ...r.error.issues[0].path] });
    return r.data;
  };

  /** Column names an admin typed actually exist on the table — checked against the live schema, not guessed. */
  async function checkColumns(table, names) {
    // A nonexistent table doesn't always reject — better-sqlite3's PRAGMA just comes back empty — so "no columns
    // at all" is treated the same as "the lookup failed": there is no such table or view.
    const info = await db(table)
      .columnInfo()
      .catch(() => ({}));
    if (!info || !Object.keys(info).length)
      throw new HttpError(422, 'invalid_input', `There is no table or view "${table}".`, {
        field: 'config.table',
      });
    for (const n of names)
      if (!(n in info))
        throw new HttpError(422, 'invalid_input', `"${table}" has no column "${n}".`, {
          field: 'config.columns',
        });
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  /** Validate a full definition (base fields + mode-specific config). Does not touch an actor's permissions. */
  async function validate(input) {
    const base = baseSchema.safeParse(input);
    if (!base.success) throw bad(base.error.issues[0]);

    if (base.data.mode === 'query') {
      const source = input.config?.source === 'table' ? 'table' : 'type';
      if (source === 'table') {
        const config = parseConfig(queryTableConfigSchema, input.config);
        if (SENSITIVE_TABLES.has(config.table))
          throw new HttpError(
            422,
            'invalid_input',
            `"${config.table}" can't be used in a Service.`,
            {
              field: 'config.table',
            },
          );
        await checkColumns(config.table, [
          ...config.columns,
          ...config.where.map((w) => w.column),
          ...(config.sort ? [config.sort.column] : []),
        ]);
        const declared = new Set(config.params.map((p) => p.name));
        for (const w of config.where)
          if (!declared.has(w.param))
            throw new HttpError(
              422,
              'invalid_input',
              `The filter on "${w.column}" needs a declared parameter "${w.param}".`,
              {
                field: 'config.where',
              },
            );
        return { ...base.data, mode: /** @type {'query'} */ ('query'), config };
      }
      const config = parseConfig(queryTypeConfigSchema, input.config);
      if (!content.registry.has(config.type))
        throw new HttpError(422, 'invalid_input', `There is no content type "${config.type}".`, {
          field: 'config.type',
        });
      return { ...base.data, mode: /** @type {'query'} */ ('query'), config };
    }

    if (base.data.mode === 'sql') {
      const config = parseConfig(sqlConfigSchema, input.config);
      assertSelectOnly(config.sql);
      const used = paramsUsedIn(config.sql);
      const declared = new Set(config.params.map((p) => p.name));
      for (const paramName of used)
        if (!declared.has(paramName))
          throw new HttpError(
            422,
            'invalid_input',
            `The query uses :${paramName} but no such parameter is declared.`,
            {
              field: 'config.params',
            },
          );
      return { ...base.data, mode: /** @type {'sql'} */ ('sql'), config };
    }

    const config = parseConfig(scriptConfigSchema, input.config);
    try {
      new AsyncFunction('req', 'ctx', config.code);
    } catch (e) {
      throw new HttpError(
        422,
        'invalid_input',
        `The script doesn’t parse: ${String(e.message).slice(0, 200)}`,
        {
          field: 'config.code',
        },
      );
    }
    return { ...base.data, mode: /** @type {'script'} */ ('script'), config };
  }

  /**
   * `services.write` covers a query-builder Service over a content type. A query over a raw table, or raw SQL,
   * needs `services.sql` on top of it (both read "whatever is in the database", by construction or by text). A
   * script needs `services.script` on top of it (full, unsandboxed Node.js — a different, higher trust tier).
   */
  function checkPermission(defn, actor) {
    if (!actor?.can('services.write')) throw forbidden();
    if (defn.mode === 'sql' && !actor.can('services.sql'))
      throw forbidden('Creating or editing a raw-SQL Service needs the services.sql permission.');
    if (defn.mode === 'query' && defn.config.source === 'table' && !actor.can('services.sql'))
      throw forbidden('A Service over a database table needs the services.sql permission.');
    if (defn.mode === 'script' && !actor.can('services.script'))
      throw forbidden('Creating or editing a script Service needs the services.script permission.');
  }

  const row = (r) => ({
    id: Number(r.id),
    slug: r.slug,
    name: r.name,
    description: r.description ?? '',
    mode: r.mode,
    config: JSON.parse(r.config),
    access: r.access,
    customerRoles: r.customer_roles ? JSON.parse(r.customer_roles) : [],
    enabled: !!r.enabled,
    updatedAt: Number(r.updated_at),
  });

  /** Entries fields → only the type's own custom fields the config allow-lists (the envelope stays as-is). */
  function pick(item, fields) {
    if (!fields?.length) return item;
    const allowed = new Set(fields);
    return {
      ...item,
      fields: Object.fromEntries(Object.entries(item.fields).filter(([k]) => allowed.has(k))),
    };
  }

  const clamp = (v, d, min, max) => Math.min(max, Math.max(min, Math.floor(Number(v)) || d));

  async function runTypeQuery(config, query, locale, publicData) {
    content.registry.type(config.type); // throws 404 if the type has since been removed
    const perPage = clamp(query.per_page, config.perPage.default, 1, config.perPage.max);
    const page = clamp(query.page, 1, 1, 100000);
    const list = await content.listPublished(config.type, {
      termId: config.termId,
      locale,
      limit: perPage,
      offset: (page - 1) * perPage,
      sort: config.sort,
    });
    const { items } = await publicData.shape(list.entries, { safe: false });
    return {
      items: items.map((i) => pick(i, config.fields)),
      page,
      perPage,
      total: list.total,
      pages: Math.max(1, Math.ceil(list.total / perPage)),
    };
  }

  /** A table/view is queried entirely through Knex's query builder (parameterised, never raw SQL text). */
  async function runTableQuery(config, query) {
    const bindings = bindParams(config.params, query);
    const base = () => {
      let q = db(config.table);
      for (const w of config.where) q = q.where(w.column, bindings[w.param]);
      return q;
    };
    const perPage = clamp(query.per_page, config.perPage.default, 1, config.perPage.max);
    const page = clamp(query.page, 1, 1, 100000);
    const totalRow = await base().count({ n: '*' }).first();
    let itemsQ = base()
      .select(config.columns)
      .limit(perPage)
      .offset((page - 1) * perPage);
    if (config.sort) itemsQ = itemsQ.orderBy(config.sort.column, config.sort.dir);
    const items = await itemsQ;
    const total = Number(totalRow.n);
    return { items, page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  async function runSql(config, query) {
    const bindings = bindParams(config.params, query);
    const rowLimit = config.rowLimit ?? settings.get('security.services_sql_row_limit');
    const timeoutMs = settings.get('security.services_sql_timeout_ms');
    const items = await dialect.runSelect(config.sql, bindings, { timeoutMs, rowLimit });
    return { items };
  }

  /**
   * Full, unsandboxed Node.js. The script's return value IS the response body — no `{items}` envelope, since a
   * script is meant to be as free-form as a hand-written route handler. The timeout only stops WAITING for a
   * response; it cannot interrupt code that is already running (D-046) — that is a real limit of "no sandbox",
   * stated here rather than implied away.
   */
  async function runScript(config, req) {
    const fn = new AsyncFunction('req', 'ctx', config.code);
    const timeoutMs = settings.get('security.services_script_timeout_ms');
    let timer;
    try {
      return await Promise.race([
        fn(req, ctx),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new HttpError(504, 'script_timeout', 'The script did not respond in time.')),
            timeoutMs,
          );
        }),
      ]);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, 'script_error', 'The script failed while running.', { cause: e });
    } finally {
      clearTimeout(timer);
    }
  }

  const svc = {
    validate,
    SENSITIVE_TABLES,

    async list() {
      return (await db('services').orderBy('name')).map(row);
    },

    /** Every table/view this database has, minus the ones a table-source query is never allowed to read. */
    async listTables() {
      return (await dialect.listTables()).filter((t) => !SENSITIVE_TABLES.has(t.name));
    },
    /** A table's actual columns, for the admin editor's column picker (checked again at save time regardless). */
    async tableColumns(table) {
      if (SENSITIVE_TABLES.has(table)) throw notFound('That table');
      const info = await db(table)
        .columnInfo()
        .catch(() => ({}));
      if (!info || !Object.keys(info).length) throw notFound('That table');
      return Object.keys(info);
    },

    /** Any definition, whatever its enabled/access state (the admin editor). */
    async get(slug) {
      const r = await db('services').where({ slug }).first();
      if (!r) throw notFound('That Service');
      return row(r);
    },

    /** Enabled + public only — what the anonymous/in-process request path may use. */
    async getPublic(slug) {
      const r = await db('services').where({ slug, enabled: true, access: 'public' }).first();
      if (!r) throw notFound('There is no such data.');
      return row(r);
    },

    async create(input, actor) {
      const defn = await validate(input);
      checkPermission(defn, actor);
      const existing = await db('services').where({ slug: defn.slug }).first();
      if (existing)
        throw new HttpError(
          422,
          'invalid_input',
          `"${defn.slug}" is already used by another Service.`,
          {
            field: 'slug',
          },
        );
      const t = now();
      await db('services').insert({
        slug: defn.slug,
        name: defn.name,
        description: defn.description,
        mode: defn.mode,
        config: JSON.stringify(defn.config),
        access: defn.access,
        customer_roles: JSON.stringify([]),
        enabled: defn.enabled,
        created_by: actor?.id ?? null,
        updated_by: actor?.id ?? null,
        created_at: t,
        updated_at: t,
      });
      await audit.log({ actor, action: 'service.created', entity: 'service', entityId: defn.slug });
      return svc.get(defn.slug);
    },

    async update(slug, input, actor) {
      const existing = await db('services').where({ slug }).first();
      if (!existing) throw notFound('That Service');
      const defn = await validate({ ...input, slug: input.slug ?? slug });
      checkPermission(defn, actor);
      if (defn.slug !== slug) {
        const clash = await db('services').where({ slug: defn.slug }).first();
        if (clash)
          throw new HttpError(
            422,
            'invalid_input',
            `"${defn.slug}" is already used by another Service.`,
            {
              field: 'slug',
            },
          );
      }
      await db('services')
        .where({ slug })
        .update({
          slug: defn.slug,
          name: defn.name,
          description: defn.description,
          mode: defn.mode,
          config: JSON.stringify(defn.config),
          access: defn.access,
          enabled: defn.enabled,
          updated_by: actor?.id ?? null,
          updated_at: now(),
        });
      await audit.log({ actor, action: 'service.updated', entity: 'service', entityId: defn.slug });
      return svc.get(defn.slug);
    },

    async remove(slug, actor) {
      const existing = await db('services').where({ slug }).first();
      if (!existing) throw notFound('That Service');
      if (!actor?.can('services.write')) throw forbidden();
      await db('services').where({ slug }).del();
      await audit.log({ actor, action: 'service.deleted', entity: 'service', entityId: slug });
    },

    /** Every definition, one `<slug>.json` file each, as a downloadable zip — Webmaster → Services: Export. */
    async exportZip() {
      const zip = new AdmZip();
      for (const defn of (await db('services').orderBy('slug')).map(row))
        zip.addFile(`${defn.slug}.json`, Buffer.from(JSON.stringify(defn, null, 2)));
      return zip.toBuffer();
    },

    /**
     * A zip from Export, fed back in: each `<slug>.json` is created if the slug is new, else updated in place —
     * through the exact same `create`/`update`, so importing a `mode: 'sql'` or `mode: 'script'` definition still
     * needs the importing actor to hold `services.sql`/`services.script`, same as building it by hand would.
     */
    async importZip(buffer, actor) {
      let zip;
      try {
        zip = new AdmZip(buffer);
      } catch {
        throw new HttpError(422, 'invalid_input', "That file isn't a valid zip archive.");
      }
      const result = { created: 0, updated: 0, errors: [] };
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !e.entryName.endsWith('.json')) continue;
        try {
          const input = JSON.parse(e.getData().toString('utf8'));
          const existing = await db('services').where({ slug: input.slug }).first();
          await (existing ? svc.update(input.slug, input, actor) : svc.create(input, actor));
          result[existing ? 'updated' : 'created']++;
        } catch (err) {
          result.errors.push({ path: e.entryName, message: err.message });
        }
      }
      return result;
    },

    /**
     * Run a saved definition. `publicData` is passed in (not imported) to avoid a construction-order cycle.
     * @param {any} defn
     * @param {{query?: Record<string,string>, locale?: string, publicData?: any}} [opts]
     */
    async run(defn, opts = {}) {
      const { query = {}, locale, publicData } = opts;
      const loc = locale ?? settings.get('general.default_locale');
      if (defn.mode === 'sql') return runSql(defn.config, query);
      if (defn.mode === 'script') return runScript(defn.config, { query, locale: loc });
      return defn.config.source === 'table'
        ? runTableQuery(defn.config, query)
        : runTypeQuery(defn.config, query, loc, publicData);
    },

    /**
     * Try an in-progress, unsaved definition (the admin editor's "Test run") — same validation as Save.
     * @param {any} input
     * @param {{query?: Record<string,string>, locale?: string, publicData?: any}} [opts]
     */
    async preview(input, opts = {}) {
      const defn = await validate(input);
      return svc.run(defn, opts);
    },
  };
  return svc;
}
