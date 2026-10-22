import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { HttpError, notFound } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';
import { copyOrder, selfRefOrder } from '../dbms/migrate.js';

const FORMAT = 1;
const STATUS_KEY = 'backup:status';
const STALE_MS = 2 * 3_600_000; // a "running" backup that old belongs to a process that died
const READ_CHUNK = 1000;
const BATCH_VARS = 900; // under SQLite's historic bound-variable limit
const KEY = /^[a-z0-9][a-z0-9/_.-]{0,200}$/;
/** An encrypted secret as the database stores it (core/crypto.js). */
const ENVELOPE = /enc:v1:[A-Za-z0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*/g;

/**
 * Tables a backup never holds: what the running servers write by themselves (sessions, heartbeats, logs, usage),
 * the migration bookkeeping (the target runs its own), derived search tables, and this module's own list of backups.
 * Everything else, including tables created by plugins and by people in System → Database, is user data.
 */
const SKIP = new Set([
  'knex_migrations',
  'knex_migrations_lock',
  'config_meta',
  'backups',
  'sessions',
  'customer_sessions',
  'password_resets',
  'cluster_nodes',
  'audit_logs',
  'activity_log',
  'analytics_sessions',
  'events_log',
  'webhook_deliveries',
  'assistant_usage',
  'ai_usage_log',
  'settings_revisions',
]);
const skipped = (name) =>
  SKIP.has(name) || name.startsWith('sqlite_') || name.startsWith('search_fts');

/** JSON that keeps binary and date values exact. */
function replacer(key, value) {
  const raw = this[key];
  if (Buffer.isBuffer(raw)) return { $b64: raw.toString('base64') };
  if (raw instanceof Date) return { $date: raw.toISOString() };
  return value;
}
function reviver(_key, value) {
  if (value && typeof value === 'object') {
    if (typeof value.$b64 === 'string') return Buffer.from(value.$b64, 'base64');
    if (typeof value.$date === 'string') return new Date(value.$date);
  }
  return value;
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Operations → Backups (docs/DECISIONS.md D-120). A backup is one zip of what people change on this installation:
 * every database table that is not server runtime state, and the uploaded media files. Code, `.env`, shipped themes and
 * the derived `public/` mirror are not in it — a restore brings the data back onto whatever code the target runs.
 * The zip is database-neutral (rows as JSON lines), so a backup from SQLite restores onto MySQL or PostgreSQL.
 * @param {any} ctx
 */
export function createBackup(ctx) {
  const { db, dialect, storage, cache, audit, log, crypto } = ctx;
  const pending = new Set();
  /** backup id → its running job, so a restore can wait for its own safety copy and nothing else. */
  const jobs = new Map();

  // The cache lets any server answer "how far along is it?"; the local copy covers a cache that is switched off.
  let local = null;
  const readStatus = async () => (await cache.get(STATUS_KEY)) ?? local ?? { state: 'idle' };
  async function setStatus(patch) {
    const next = { ...(await readStatus()), ...patch, updatedAt: Date.now() };
    local = next;
    await cache.set(STATUS_KEY, next, { ttl: 3600 }).catch(() => {});
    return next;
  }

  const friendly = (e) => {
    const full = String(e?.message ?? e).split('\n')[0];
    const m =
      full.length > 200 && full.includes(' - ') ? full.slice(full.lastIndexOf(' - ') + 3) : full;
    return m.slice(0, 380);
  };

  const toRow = (r) => ({
    id: Number(r.id),
    name: r.name,
    status: r.status,
    source: r.source,
    secrets: r.secrets,
    size: Number(r.size),
    createdAt: Number(r.created_at),
    error: r.error || null,
    manifest: r.manifest ? JSON.parse(r.manifest) : null,
  });
  const fileKey = (id) => `backups/${id}.zip`;

  async function readAll(key) {
    const chunks = [];
    for await (const c of storage.stream(key)) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async function userTables() {
    return (await dialect.listTables())
      .filter((t) => !t.view && !skipped(t.name))
      .map((t) => t.name);
  }
  const appliedMigrations = async () =>
    (await db('knex_migrations').select('name').orderBy('id')).map((r) => r.name);

  /** Removes or keeps the encrypted secrets in one row's text. Returns how many were taken out. */
  function scrub(row, keepIf) {
    let removed = 0;
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== 'string' || !v.includes('enc:v1:')) continue;
      row[k] = v.replace(ENVELOPE, (m) => {
        if (keepIf(m)) return m;
        removed++;
        return '';
      });
    }
    return removed;
  }

  async function mediaFiles() {
    const out = [];
    for (const m of await db('media').select('id', 'original_file', 'variants')) {
      const names = new Set([m.original_file]);
      try {
        for (const v of JSON.parse(m.variants || '[]')) if (v?.file) names.add(v.file);
      } catch {
        /* a row with unreadable variants still has its original */
      }
      for (const f of names) out.push(`m/${m.id}/${f}`);
    }
    return out;
  }

  /** @param {number} id @param {Record<string, any>} patch */
  async function finish(id, patch) {
    await db('backups').where({ id }).update(patch);
  }

  async function assertIdle() {
    const live = await db('backups')
      .where({ status: 'running' })
      .where('created_at', '>', now() - STALE_MS)
      .first();
    if (live)
      throw new HttpError(
        409,
        'conflict',
        'A backup is already being made. Wait for it to finish, then try again.',
      );
  }

  async function build(id, { includeMedia, secrets }, actor) {
    const zip = new AdmZip();
    const tables = {};
    const skippedNames = [];
    let secretsRemoved = 0;
    let rowsTotal = 0;
    // Table shapes are read first: on SQLite the pool is one connection, which the transaction below would be holding.
    const names = await userTables();
    for (const t of (await dialect.listTables()).filter((x) => !x.view && skipped(x.name)))
      skippedNames.push(t.name);
    const shapes = new Map();
    for (const name of names) shapes.set(name, await dialect.columnDetails(name));
    // One read transaction, so the tables agree with each other on engines that give a snapshot.
    await db.transaction(
      async (trx) => {
        let step = 0;
        for (const name of names) {
          await setStatus({ step: `Reading ${name}`, done: step++, total: names.length });
          const details = shapes.get(name);
          const cols = details.map((c) => c.name);
          const pks = details.filter((c) => c.primaryKey).map((c) => c.name);
          const order = pks.length ? pks : [cols[0]];
          const lines = [];
          for (let offset = 0; ; offset += READ_CHUNK) {
            const q = trx(name).select(cols).limit(READ_CHUNK).offset(offset);
            for (const c of order) q.orderBy(c);
            const rows = await q;
            for (const r of rows) {
              if (secrets === 'remove') secretsRemoved += scrub(r, () => false);
              lines.push(JSON.stringify(r, replacer));
            }
            if (rows.length < READ_CHUNK) break;
          }
          const data = Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
          zip.addFile(`db/${name}.ndjson`, data);
          tables[name] = { rows: lines.length, sha256: sha256(data), columns: cols };
          rowsTotal += lines.length;
        }
      },
      { isolationLevel: dialect.kind === 'sqlite' ? undefined : 'repeatable read' },
    );

    const media = { files: 0, bytes: 0, missing: 0 };
    if (includeMedia) {
      const keys = await mediaFiles();
      let n = 0;
      for (const key of keys) {
        if (n++ % 25 === 0) await setStatus({ step: `Reading media (${n} of ${keys.length})` });
        try {
          const data = await readAll(key);
          zip.addFile(`media/${key}`, data);
          media.files++;
          media.bytes += data.length;
        } catch {
          media.missing++;
        }
      }
    }

    const manifest = {
      format: FORMAT,
      app: ctx.version,
      dialect: dialect.kind,
      createdAt: now(),
      createdBy: actor?.email ?? null,
      secrets,
      secretsRemoved,
      includeMedia,
      migrations: await appliedMigrations(),
      tables,
      skippedTables: skippedNames,
      rows: rowsTotal,
      media,
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    const buffer = zip.toBuffer();
    await storage.put(fileKey(id), buffer);
    return { manifest, size: buffer.length };
  }

  const svc = {
    /** Waits for background work to finish (tests, and a clean shutdown). */
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },

    async status() {
      return readStatus();
    },

    async list() {
      const rows = await db('backups').orderBy('id', 'desc');
      return rows.map(toRow);
    },

    async get(id) {
      const r = await db('backups')
        .where({ id: Number(id) })
        .first();
      if (!r) throw notFound('That backup');
      return toRow(r);
    },

    /**
     * Start a backup. Returns at once with the new row; the work runs in the background and the row turns `ready`
     * (or `failed` with a reason).
     * @param {{ includeMedia?: boolean, secrets?: 'keep'|'remove', name?: string, source?: string }} [opts]
     * @param {any} [actor]
     */
    async create(opts = {}, actor = null) {
      await assertIdle();
      const includeMedia = opts.includeMedia !== false;
      const secrets = opts.secrets === 'remove' ? 'remove' : 'keep';
      const t = now();
      const id = await dialect.insertGetId(db('backups'), {
        name:
          String(opts.name ?? '')
            .trim()
            .slice(0, 190) || `Backup ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}`,
        status: 'running',
        source: opts.source ?? 'created',
        secrets,
        size: 0,
        created_by: actor?.id ?? null,
        created_at: t,
      });
      const job = (async () => {
        try {
          await setStatus({
            state: 'running',
            op: 'backup',
            backupId: id,
            step: 'Starting',
            error: null,
          });
          const { manifest, size } = await build(id, { includeMedia, secrets }, actor);
          await finish(id, { status: 'ready', size, manifest: JSON.stringify(manifest) });
          await audit.log({
            actor,
            action: 'backup.created',
            entity: 'backup',
            entityId: id,
            meta: { rows: manifest.rows, media: manifest.media.files, secrets },
          });
          await setStatus({ state: 'idle', step: 'Done' });
        } catch (e) {
          log?.warn({ err: e.message }, 'backup: failed');
          await storage.delete(fileKey(id)).catch(() => {});
          await finish(id, { status: 'failed', error: friendly(e) }).catch(() => {});
          await setStatus({ state: 'idle', error: friendly(e) });
        }
      })();
      pending.add(job);
      jobs.set(id, job);
      job.finally(() => {
        pending.delete(job);
        jobs.delete(id);
      });
      return svc.get(id);
    },

    /** The file, for download. */
    async open(id) {
      const b = await svc.get(id);
      if (b.status !== 'ready') throw new HttpError(409, 'conflict', 'That backup is not ready.');
      return { backup: b, stream: storage.stream(fileKey(b.id)) };
    },

    /** Accept a backup made elsewhere (the file from a download). Checked before it is kept. */
    async upload(buffer, name, actor) {
      const { manifest } = readZip(buffer);
      const id = await dialect.insertGetId(db('backups'), {
        name: String(name || 'Uploaded backup').slice(0, 190),
        status: 'ready',
        source: 'uploaded',
        secrets: manifest.secrets === 'remove' ? 'remove' : 'keep',
        size: buffer.length,
        manifest: JSON.stringify(manifest),
        created_by: actor?.id ?? null,
        created_at: now(),
      });
      await storage.put(fileKey(id), buffer);
      await audit.log({ actor, action: 'backup.uploaded', entity: 'backup', entityId: id });
      return svc.get(id);
    },

    async remove(id, actor) {
      const b = await svc.get(id);
      if (b.status === 'running')
        throw new HttpError(409, 'conflict', 'That backup is still being made.');
      await storage.delete(fileKey(b.id)).catch(() => {});
      await db('backups').where({ id: b.id }).delete();
      await audit.log({ actor, action: 'backup.deleted', entity: 'backup', entityId: b.id });
    },

    /**
     * What restoring this backup here would do, and what stops it. Nothing is changed.
     * @returns {Promise<{ backup: any, blockers: string[], warnings: string[], replaces: { tables: number, rows: number }, secretsNotReadable: number }>}
     */
    async inspect(id) {
      const backup = await svc.get(id);
      if (backup.status !== 'ready')
        throw new HttpError(409, 'conflict', 'That backup is not ready.');
      const { manifest, zip } = readZip(await readAll(fileKey(backup.id)));
      const blockers = [];
      const warnings = [];
      const have = new Set(await appliedMigrations());
      const newer = manifest.migrations.filter((m) => !have.has(m));
      if (newer.length)
        blockers.push(
          `This backup comes from a newer version of the software (${newer.length} database change${newer.length === 1 ? '' : 's'} this server does not have yet). Update this server first, then restore.`,
        );
      const here = new Set(await userTables());
      const missing = Object.keys(manifest.tables).filter((t) => !here.has(t));
      if (missing.length)
        warnings.push(
          `${missing.length} table${missing.length === 1 ? '' : 's'} in the backup do not exist here and will be skipped: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}. They belong to a plugin or a table made in System → Database that this server does not have.`,
        );
      if (!manifest.includeMedia)
        warnings.push(
          'This backup has no uploaded files. Pictures that point at files this server does not have will show as missing.',
        );
      let unreadable = 0;
      if (manifest.secrets === 'keep')
        for (const t of Object.keys(manifest.tables)) {
          const entry = zip.getEntry(`db/${t}.ndjson`);
          const text = entry ? entry.getData().toString('utf8') : '';
          if (!text.includes('enc:v1:')) continue;
          for (const m of text.match(ENVELOPE) ?? []) if (!crypto.canDecrypt(m)) unreadable++;
        }
      if (unreadable)
        warnings.push(
          `${unreadable} saved secret${unreadable === 1 ? '' : 's'} (passwords and API keys, such as the mail password) were encrypted with a key this server does not have. They will be cleared; enter them again under Settings after restoring.`,
        );
      return {
        backup,
        blockers,
        warnings,
        replaces: {
          tables: Object.keys(manifest.tables).filter((t) => here.has(t)).length,
          rows: Object.entries(manifest.tables)
            .filter(([t]) => here.has(t))
            .reduce((n, [, v]) => n + v.rows, 0),
        },
        secretsNotReadable: unreadable,
      };
    },

    /**
     * Replace this installation's data with the backup's. The data swap is ONE transaction: it completes or nothing
     * changes. Everyone is signed out afterwards. A safety backup of the current state is made first (unless asked not
     * to), so a restore can itself be undone.
     * @param {{ confirm: string, safety?: boolean }} opts
     */
    async restore(id, opts, actor) {
      if (opts?.confirm !== 'RESTORE')
        throw new HttpError(
          422,
          'invalid_input',
          'Type RESTORE to confirm. This replaces everything people have changed on this installation.',
          { field: 'confirm' },
        );
      const report = await svc.inspect(id);
      if (report.blockers.length) throw new HttpError(409, 'conflict', report.blockers[0]);
      await assertIdle();
      await setStatus({
        state: 'running',
        op: 'restore',
        backupId: Number(id),
        step: 'Starting',
        error: null,
      });
      const job = (async () => {
        try {
          if (opts.safety !== false) {
            await setStatus({ step: 'Making a safety backup of the current data' });
            const safe = await svc.create(
              { name: `Before restoring backup ${id}`, source: 'safety' },
              actor,
            );
            await jobs.get(safe.id);
            const done = await svc.get(safe.id);
            if (done.status !== 'ready')
              throw new Error(
                `The safety backup failed (${done.error ?? 'unknown reason'}); nothing was restored.`,
              );
            await setStatus({ state: 'running', op: 'restore', backupId: Number(id) });
          }
          const result = await apply(id, actor);
          await setStatus({ state: 'idle', step: 'Done', result });
        } catch (e) {
          log?.warn({ err: e.message }, 'backup: restore failed');
          await setStatus({ state: 'idle', step: 'Failed', error: friendly(e) });
        }
      })();
      pending.add(job);
      job.finally(() => pending.delete(job));
      return { accepted: true };
    },
  };

  function readZip(buffer) {
    let zip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      throw new HttpError(
        422,
        'invalid_input',
        'That file is not a backup (it is not a zip file).',
      );
    }
    const entry = zip.getEntry('manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(entry.getData().toString('utf8'));
    } catch {
      throw new HttpError(
        422,
        'invalid_input',
        'That zip is not a backup from this software (no manifest).',
      );
    }
    if (manifest?.format !== FORMAT || !manifest.tables || !Array.isArray(manifest.migrations))
      throw new HttpError(
        422,
        'invalid_input',
        'That backup has a format this version cannot read. Restore it with the version that made it, or make a new backup.',
      );
    for (const e of zip.getEntries()) {
      const n = e.entryName;
      if (
        n.includes('..') ||
        n.startsWith('/') ||
        !/^(manifest\.json|db\/[A-Za-z0-9_]+\.ndjson|media\/.+)$/.test(n)
      )
        throw new HttpError(
          422,
          'invalid_input',
          `The backup contains an unexpected file ("${n.slice(0, 60)}"), so it was refused.`,
        );
    }
    return { manifest, zip };
  }

  async function apply(id, actor) {
    const backup = await svc.get(id);
    const { manifest, zip } = readZip(await readAll(fileKey(backup.id)));

    // 1. Every table file must match what the manifest recorded, before anything is touched.
    await setStatus({ step: 'Checking the backup' });
    const here = new Set(await userTables());
    const wanted = Object.keys(manifest.tables).filter((t) => here.has(t));
    for (const t of wanted) {
      const e = zip.getEntry(`db/${t}.ndjson`);
      if (!e || sha256(e.getData()) !== manifest.tables[t].sha256)
        throw new Error(
          `The backup is damaged (table "${t}" does not match its checksum). Nothing was restored.`,
        );
    }

    // 2. Uploaded files first: a restore that then fails leaves some extra files, never rows pointing at missing ones.
    const files = zip
      .getEntries()
      .filter((e) => e.entryName.startsWith('media/') && !e.isDirectory);
    let n = 0;
    for (const e of files) {
      if (n++ % 25 === 0) await setStatus({ step: `Restoring files (${n} of ${files.length})` });
      const key = e.entryName.slice('media/'.length);
      if (KEY.test(key) && !key.includes('..')) await storage.put(key, e.getData());
    }

    // 3. The data, all or nothing. Children are emptied before parents, parents filled before children.
    const fks = await dialect.foreignKeys();
    const order = copyOrder([...here], fks);
    // Runtime tables that point at user tables (sessions → users) must be emptied first or the foreign key objects.
    const dependents = [
      ...new Set(
        fks
          .filter(
            (f) =>
              here.has(f.refTable) &&
              !here.has(f.table) &&
              skipped(f.table) &&
              f.table !== 'knex_migrations',
          )
          .map((f) => f.table),
      ),
    ];
    const unreadable = { n: 0 };
    const usersBefore = (await db('users').select('id')).map((r) => r.id);
    const shapes = new Map();
    for (const t of wanted) shapes.set(t, await dialect.columnDetails(t));
    await db.transaction(async (trx) => {
      await setStatus({ step: 'Replacing the data' });
      for (const t of dependents) await trx(t).del();
      for (const t of [...order].reverse()) await trx(t).del();
      for (const t of order) {
        if (!wanted.includes(t)) continue;
        await setStatus({ step: `Restoring ${t}` });
        await insertTable(
          trx,
          t,
          shapes.get(t),
          zip.getEntry(`db/${t}.ndjson`).getData().toString('utf8'),
          fks,
          unreadable,
        );
      }
      await trx('config_meta')
        .where({ id: 1 })
        .update({ config_version: trx.raw('config_version + 1') });
    });

    // 4. What the database does not do by itself, and what every other server must pick up.
    await setStatus({ step: 'Finishing' });
    await fixSequences(order);
    const usersAfter = (await db('users').select('id')).map((r) => r.id);
    for (const uid of new Set([...usersBefore, ...usersAfter]))
      await ctx.sessionStore.destroyForUser(uid).catch(() => {});
    await ctx.siteFiles?.refresh?.().catch(() => {});
    await ctx.settings.reloadDefinitions().catch(() => {});
    await cache.flush().catch(() => {});
    await audit.log({
      actor: null,
      action: 'backup.restored',
      entity: 'backup',
      entityId: backup.id,
      meta: {
        by: actor?.email ?? null,
        tables: wanted.length,
        rows: manifest.rows,
        secretsCleared: unreadable.n,
      },
    });
    return {
      tables: wanted.length,
      rows: manifest.rows,
      files: files.length,
      secretsCleared: unreadable.n,
    };
  }

  async function insertTable(trx, name, targetCols, text, fks, unreadable) {
    const cols = new Set(targetCols.map((c) => c.name));
    const pks = targetCols.filter((c) => c.primaryKey).map((c) => c.name);
    const selfFks = fks.filter((f) => f.table === name && f.refTable === name).map((f) => f.column);
    let rows = text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const row = JSON.parse(l, reviver);
        for (const k of Object.keys(row)) if (!cols.has(k)) delete row[k];
        unreadable.n += scrub(row, (m) => crypto.canDecrypt(m));
        return row;
      });
    if (!rows.length) return;
    if (selfFks.length && pks.length === 1) rows = selfRefOrder(rows, pks[0], selfFks);
    const width = Math.max(1, Object.keys(rows[0]).length);
    const per = Math.max(1, Math.floor(BATCH_VARS / width));
    for (let i = 0; i < rows.length; i += per) {
      const chunk = rows.slice(i, i + per);
      // Rows are written with the same columns each, as one statement needs.
      const all = [...new Set(chunk.flatMap((r) => Object.keys(r)))];
      await trx(name).insert(
        chunk.map((r) => Object.fromEntries(all.map((k) => [k, r[k] ?? null]))),
      );
    }
  }

  async function fixSequences(order) {
    if (dialect.kind !== 'pg') return;
    for (const name of order)
      for (const c of await dialect.columnDetails(name)) {
        if (!c.autoIncrement) continue;
        await db.raw(
          `select setval(pg_get_serial_sequence(?, ?), coalesce((select max("${c.name}") from "${name}"), 1), (select count(*) > 0 from "${name}"))`,
          [`"${name}"`, c.name],
        );
      }
  }

  return svc;
}
