import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, forbidden } from '../../core/http/errors.js';
import { SENSITIVE_TABLES } from './service.js';

/**
 * System → Database → Export / Import (D-139). A table export is a Backups-format zip of the chosen tables (their structure
 * and, if asked, their records), so Backups can read it too; an import reads any such zip (or a full backup) and takes only the
 * tables the person picks and may touch. Both go through the Backups engine, which means an import ONLY ADDS: a missing table is
 * created, missing columns are added, records whose key is free are added, and nothing is dropped, replaced or deleted.
 * @param {any} ctx
 */
export const MAX_IMPORT_BYTES = 2 * 1024 ** 3;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Never exported or imported: migration bookkeeping and the engine's own tables. */
const NEVER = /^(knex_|sqlite_|search_fts)/;

export function createDbmsTransfer(ctx) {
  const { db, dialect, audit } = ctx;
  const backup = () => {
    if (!ctx.backup)
      throw new HttpError(
        409,
        'unavailable',
        'Export and import use the Backups module, which is switched off. Turn it on under Settings → Modules.',
      );
    return ctx.backup;
  };

  /** A table's name is valid, and the person may touch it: sensitive tables (users, settings…) need the SQL console right. */
  function allowed(name, actor) {
    if (!IDENT.test(name) || NEVER.test(name)) return `“${name}” cannot be exported or imported.`;
    if (SENSITIVE_TABLES.has(name) && !actor?.can('dbms.query'))
      return `“${name}” holds sensitive records; exporting or importing it needs the SQL console permission.`;
    return null;
  }

  async function realTables() {
    return new Set(
      (await dialect.listTables()).filter((t) => !t.view && !NEVER.test(t.name)).map((t) => t.name),
    );
  }

  return {
    /**
     * Makes the export and hands back the file as a stream. The temporary backup that carries it is removed when the
     * download ends. Secrets (encrypted values) are removed: they can only be read with this server's key.
     * @param {{ tables: string[], data?: boolean }} opts
     */
    async exportTables({ tables, data = true }, actor) {
      const bk = backup();
      const list = [...new Set(tables ?? [])];
      if (!list.length) throw new HttpError(422, 'invalid_input', 'Choose at least one table.');
      if (list.length > 300)
        throw new HttpError(422, 'invalid_input', 'Choose 300 tables or fewer at a time.');
      const have = await realTables();
      for (const t of list) {
        const why = allowed(t, actor);
        if (why)
          throw why.includes('sensitive')
            ? forbidden(why)
            : new HttpError(422, 'invalid_input', why);
        if (!have.has(t)) throw new HttpError(404, 'not_found', `“${t}” is not a table here.`);
      }
      const row = await bk.create(
        {
          name: `Export of ${list.length === 1 ? list[0] : `${list.length} tables`}`,
          source: 'table-export',
          tables: data ? list : [],
          schemaTables: list,
          includeMedia: false,
          folders: [],
          secrets: 'remove',
        },
        actor,
      );
      await bk.idle();
      const done = await bk.get(row.id);
      if (done.status !== 'ready')
        throw new HttpError(
          500,
          'export_failed',
          `The export could not be made (${done.error || 'unknown reason'}).`,
        );
      const { stream } = await bk.open(row.id);
      await audit.log({
        actor,
        action: 'dbms.exported',
        entity: 'table',
        meta: { tables: list.slice(0, 50), count: list.length, data },
      });
      const name = `${list.length === 1 ? list[0] : 'tables'}-${new Date().toISOString().slice(0, 10)}.zip`;
      return { stream, name, done: () => bk.remove(row.id, null).catch(() => {}) };
    },

    /** Receives the request body into a temporary file, never into memory. The caller deletes it. */
    async receive(req) {
      const declared = Number(req.headers['content-length'] ?? 0);
      const tooBig = () =>
        new HttpError(413, 'too_large', 'That file is too large to import (the limit is 2 GB).');
      if (declared > MAX_IMPORT_BYTES) throw tooBig();
      const tmp = path.join(os.tmpdir(), `cms-tableimport-${randomBytes(6).toString('hex')}.zip`);
      let bytes = 0;
      const guard = new Transform({
        transform(chunk, _e, cb) {
          bytes += chunk.length;
          cb(bytes > MAX_IMPORT_BYTES ? tooBig() : null, chunk);
        },
      });
      try {
        await pipeline(req, guard, createWriteStream(tmp));
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      if (!bytes) {
        await fs.rm(tmp, { force: true });
        throw new HttpError(
          415,
          'unsupported_type',
          'Send the exported .zip file itself as the request body.',
        );
      }
      return tmp;
    },

    /**
     * Reads the zip and says what an import would do; with `confirm` it does it. Either way the zip is kept only for the
     * length of the request.
     * @param {string} file @param {{ tables?: string[], confirm?: boolean }} opts
     */
    async importFile(file, { tables: asked, confirm = false }, actor) {
      const bk = backup();
      const item = await bk.upload(file, 'Table import', actor, { source: 'table-import' });
      try {
        const m = item.manifest;
        const have = await realTables();
        const names = [
          ...new Set([
            ...Object.keys(m.tables ?? {}),
            ...(m.schemaScoped ? Object.keys(m.schema ?? {}) : []),
          ]),
        ]
          .filter((t) => IDENT.test(t) && !NEVER.test(t))
          .sort();
        const plan = [];
        for (const t of names) {
          const exists = have.has(t);
          let hereRows = null;
          let newColumns = [];
          if (exists) {
            hereRows = Number((await db(t).count({ n: '*' }))[0].n);
            const here = new Set((await dialect.columnDetails(t)).map((c) => c.name));
            newColumns = (m.schema?.[t]?.columns ?? [])
              .map((c) => c.name)
              .filter((c) => !here.has(c));
          }
          plan.push({
            table: t,
            rows: m.tables?.[t]?.rows ?? 0,
            exists,
            hereRows,
            newColumns,
            sensitive: SENSITIVE_TABLES.has(t),
            blocked: allowed(t, actor),
          });
        }
        const pickable = plan.filter((p) => !p.blocked).map((p) => p.table);
        const chosen = asked ? asked.filter((t) => pickable.includes(t)) : pickable;
        if (asked) {
          const refused = asked.filter((t) => !pickable.includes(t));
          if (refused.length)
            throw forbidden(
              plan.find((p) => p.table === refused[0])?.blocked ??
                `“${refused[0]}” is not in this file.`,
            );
        }
        const report = await bk.inspect(item.id, { tables: chosen });
        if (!confirm)
          return {
            exportedAt: m.createdAt,
            engine: m.dialect,
            tables: plan,
            blockers: report.blockers,
            warnings: report.warnings.filter(
              (w) => !/uploaded files|Each server in a cluster/.test(w),
            ),
          };
        if (!chosen.length)
          throw new HttpError(422, 'invalid_input', 'Choose at least one table to import.');
        await bk.restore(item.id, { confirm: 'RESTORE', tables: chosen }, actor);
        await bk.idle();
        const status = await bk.status();
        if (status.error)
          throw new HttpError(500, 'import_failed', `${status.error} Nothing was changed.`);
        const result = status.result ?? {};
        await audit.log({
          actor,
          action: 'dbms.imported',
          entity: 'table',
          meta: {
            tables: chosen.slice(0, 50),
            count: chosen.length,
            rowsAdded: result.rowsAdded ?? 0,
            tablesCreated: result.tablesCreated ?? 0,
            columnsAdded: result.columnsAdded ?? 0,
          },
        });
        return { imported: chosen, result };
      } finally {
        await bk.remove(item.id, null).catch(() => {});
      }
    },
  };
}
