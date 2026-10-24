import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { HttpError, notFound } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';
import { buildColumn, copyOrder, selfRefOrder } from '../dbms/migrate.js';

const execFileP = promisify(execFile);

const FORMAT = 2;
const STATUS_KEY = 'backup:status';
const STALE_MS = 2 * 3_600_000; // a "running" backup that old belongs to a process that died
const READ_CHUNK = 1000;
const BATCH_VARS = 900; // under SQLite's historic bound-variable limit
const MAX_ENTRIES = 2_000_000; // a media library of this many files is far beyond what a zip should carry
/** The largest upload accepted, so a wrong file cannot fill the disk. */
export const MAX_UPLOAD_BYTES = 20 * 1024 ** 3;
const KEY = /^[a-z0-9][a-z0-9/_.-]{0,200}$/;
/** An encrypted secret as the database stores it (core/crypto.js). */
const ENVELOPE = /enc:v1:[A-Za-z0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*/g;
const ENTRY_NAME =
  /^(manifest\.json|db\/[A-Za-z0-9_]+\.ndjson|media\/[a-z0-9][a-z0-9/_.-]{0,200}|files\/(?:public|plugins|site)\/[^\0\\]{1,300})$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * The folders a developer or the AI Assistant change on disk (the same three File Manager edits): the site tree mirror
 * `public/`, `plugins/`, and `site/` (starter site, themes, wording). Others are derived from the database
 * (`data/libraries`, `data/versions`) and come back by themselves.
 */
export const FOLDER_IDS = ['public', 'plugins', 'site'];
const FOLDER_SKIP = new Set(['node_modules', '.git', '.DS_Store']);
const MAX_FOLDER_FILES = 200_000;

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
/** Tables people create (in System → Database, by the AI Assistant, by a plugin) are named with these prefixes. Their
 *  data is always backed up, whatever the scope, and no rule here may ever treat them as runtime state. */
export const DATA_PREFIX = /^(do|sys|data)_/;
const skipped = (name) =>
  !DATA_PREFIX.test(name) &&
  (SKIP.has(name) || name.startsWith('sqlite_') || name.startsWith('search_fts'));

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

// ───────────────────────────── zip reading (yauzl) ─────────────────────────────

/**
 * A zip opened from a file on disk. Entries are read by name, in any order, one at a time as a stream, so a backup of
 * any size is never held in memory.
 * @param {string} file
 * @returns {Promise<{ names: Map<string, any>, stream: (name: string) => Promise<import('node:stream').Readable>, close: () => void }>}
 */
function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip)
        return reject(
          new HttpError(
            422,
            'invalid_input',
            'That file is not a backup (it is not a readable zip file).',
          ),
        );
      const names = new Map();
      zip.on('error', () =>
        reject(new HttpError(422, 'invalid_input', 'That zip file is damaged and cannot be read.')),
      );
      zip.on('entry', (e) => {
        if (names.size >= MAX_ENTRIES) {
          zip.close();
          return reject(
            new HttpError(422, 'invalid_input', 'That zip has too many files to be a backup.'),
          );
        }
        names.set(e.fileName, e);
        zip.readEntry();
      });
      zip.on('end', () =>
        resolve({
          names,
          close: () => zip.close(),
          stream: (name) =>
            new Promise((res, rej) => {
              const e = names.get(name);
              if (!e) return rej(new Error(`"${name}" is not in the backup.`));
              zip.openReadStream(e, (er, s) => (er || !s ? rej(er) : res(s)));
            }),
        }),
      );
      zip.readEntry();
    });
  });
}

/** Everything in a stream, as one buffer. Only for the small manifest. */
async function drain(stream, limit = 256 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > limit) throw new Error('The manifest is unreasonably large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** The manifest of an opened zip, checked for shape; and every file name checked against what a backup contains. */
async function readManifest(zip) {
  for (const name of zip.names.keys()) {
    // `[...path].html` is a normal page file name, so a folder entry is judged by its path segments, not by a substring.
    const folder = /^files\/(?:public|plugins|site)\/(.+)$/.exec(name);
    const ok = ENTRY_NAME.test(name) && (folder ? safeRel(folder[1]) : !name.includes('..'));
    if (!ok)
      throw new HttpError(
        422,
        'invalid_input',
        `The backup contains an unexpected file ("${name.slice(0, 60)}"), so it was refused.`,
      );
  }
  if (!zip.names.has('manifest.json'))
    throw new HttpError(
      422,
      'invalid_input',
      'That zip is not a backup from this software (no manifest).',
    );
  let manifest;
  try {
    manifest = JSON.parse((await drain(await zip.stream('manifest.json'))).toString('utf8'));
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
  return manifest;
}

/** Pass-through that hashes and counts what flows by. */
function measure() {
  const hash = createHash('sha256');
  const result = { bytes: 0, sha256: '' };
  const transform = new Transform({
    transform(chunk, _e, cb) {
      hash.update(chunk);
      result.bytes += chunk.length;
      cb(null, chunk);
    },
    flush(cb) {
      result.sha256 = hash.digest('hex');
      cb();
    },
  });
  return { transform, result };
}

// ───────────────────────────── folders ─────────────────────────────

/** A path inside a folder, as the backup stores it: forward slashes, no way out of the folder. */
export function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 300) return false;
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return false;
  return rel.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}

/**
 * The files in `dir` that differ from the code release, when `dir` is inside a git checkout at `top`: modified tracked
 * files and files git does not track (including ones it ignores, like plugins you made). Anything else is identical
 * to what an update would bring, so keeping it would only let an old backup overwrite newer shipped code. Returns
 * null when that cannot be told (no git, not a checkout, outside it): the caller then keeps every file.
 * @returns {Promise<Set<string> | null>} paths relative to `dir`, with forward slashes
 */
export async function gitChangedFiles(top, dir) {
  const relDir = path.relative(top, dir);
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) return null;
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', top, 'ls-files', '-m', '-o', '-z', '--', relDir || '.'],
      { maxBuffer: 512 * 1024 * 1024 },
    );
    return new Set(
      stdout
        .split('\0')
        .filter(Boolean)
        .map((f) => path.relative(relDir, f).split(path.sep).join('/')),
    );
  } catch {
    return null;
  }
}

/** Every regular file under `dir` as a forward-slash path. Symlinks are never followed or kept. */
async function walkFiles(dir) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue; // the folder may not exist on this server
    }
    for (const e of entries) {
      if (FOLDER_SKIP.has(e.name) || e.name.endsWith('.tmp')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) {
        out.push(r);
        if (out.length > MAX_FOLDER_FILES)
          throw new Error(
            `A folder has more than ${MAX_FOLDER_FILES} files, which is too many to back up.`,
          );
      }
    }
  }
  return out.sort();
}

/** A column default we can recreate on any engine: a plain number or text. Functions and sequences are left out. */
function parseDefault(c) {
  const d = c.default;
  if (d === null || d === undefined || c.autoIncrement) return undefined;
  const raw = String(d)
    .replace(/::[a-z ]+(\([0-9, ]*\))?(\[\])?$/i, '')
    .trim();
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const q = /^'((?:[^']|'')*)'$/.exec(raw);
  return q ? q[1].replace(/''/g, "'") : undefined;
}

// ───────────────────────────── the service ─────────────────────────────

/**
 * Operations → Backups (docs/DECISIONS.md D-120). A backup is one zip of what people change on this installation:
 * every database table that is not server runtime state, and the uploaded media files. Code, `.env`, shipped themes and
 * the derived `public/` mirror are not in it — a restore brings the data back onto whatever code the target runs.
 * The zip is database-neutral (rows as JSON lines), so a backup from SQLite restores onto MySQL or PostgreSQL.
 * Everything is streamed: a backup is written straight into storage while it is read, and a restore reads one entry at
 * a time from the file on disk, so neither the size of the database nor of the media library is held in memory.
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
  const folderDir = (id) =>
    ({
      public: () => path.resolve(ctx.env.SITE_DIR),
      plugins: () => path.resolve(ctx.env.PLUGINS_DIR),
      site: () => path.resolve(ctx.appRoot, 'site'),
    })[id]();

  /** The files of one folder that belong in a backup, and whether they were limited to what differs from the code. */
  async function folderFiles(id) {
    const dir = folderDir(id);
    let files = await walkFiles(dir);
    let changesOnly = false;
    // `public/` is derived from the database and not in git; the other two ship with the code, so only changes count.
    if (id !== 'public') {
      const changed = await gitChangedFiles(path.resolve(ctx.appRoot), dir);
      if (changed) {
        files = files.filter((f) => changed.has(f));
        changesOnly = true;
      }
    }
    return { dir, files: files.filter(safeRel), changesOnly };
  }

  /**
   * Run `fn` with a path to the stored backup on disk. A storage that keeps files locally is used in place; any other
   * is copied to a temporary file first (still no memory), which is removed afterwards.
   */
  async function withFile(key, fn) {
    if (storage.localPath) return fn(storage.localPath(key));
    const tmp = path.join(os.tmpdir(), `cms-backup-${randomBytes(6).toString('hex')}.zip`);
    try {
      await pipeline(storage.stream(key), fs.createWriteStream(tmp));
      return await fn(tmp);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
  async function withZip(key, fn) {
    return withFile(key, async (file) => {
      const zip = await openZip(file);
      try {
        return await fn(zip);
      } finally {
        zip.close();
      }
    });
  }

  async function userTables() {
    return (await dialect.listTables())
      .filter((t) => !t.view && !skipped(t.name))
      .map((t) => t.name);
  }
  /** Every real table, runtime ones included (a snapshot taken before an erase may hold a log table). */
  async function allTables() {
    return (await dialect.listTables())
      .filter((t) => !t.view && !t.name.startsWith('sqlite_') && !t.name.startsWith('search_fts'))
      .map((t) => t.name);
  }
  const appliedMigrations = async () =>
    (await db('knex_migrations').select('name').orderBy('id')).map((r) => r.name);

  /** Takes the encrypted secrets out of one row's text unless `keepIf` says to keep it. Returns how many were taken out. */
  function scrub(row, keepIf, seen) {
    let removed = 0;
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== 'string' || !v.includes('enc:v1:')) continue;
      row[k] = v.replace(ENVELOPE, (m) => {
        if (keepIf(m)) {
          if (seen) {
            const id = m.split(':')[2];
            seen[id] = (seen[id] ?? 0) + 1;
          }
          return m;
        }
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

  /**
   * Write the zip into storage while reading the database and the media, one chunk at a time. Each zip entry is a
   * stream that yazl pulls in turn, so memory use is a few chunks whatever the size. The manifest is the last entry:
   * it holds the checksums, which are only known once everything before it has been written.
   */
  async function build(id, { includeMedia, secrets, folders = [], tables: only }, actor) {
    // Data comes only from the tables people create (do_, sys_, data_). The schema below is every table.
    // (A snapshot taken before an erase names its tables and carries ALL their data, whatever they are called.)
    const names = only ? [...only] : (await userTables()).filter((n) => DATA_PREFIX.test(n));
    const skippedNames = (await dialect.listTables())
      .filter((x) => !x.view && skipped(x.name))
      .map((x) => x.name);
    // Table shapes are read first: on SQLite the pool is one connection, which the transaction below holds.
    const shapes = new Map();
    const indexes = new Map();
    for (const name of names) {
      shapes.set(name, await dialect.columnDetails(name));
      // The primary key's own index is rebuilt with the table.
      indexes.set(
        name,
        (await dialect.indexList(name)).filter(
          (i) => !/^sqlite_autoindex|^primary$|_pkey$/i.test(i.name),
        ),
      );
    }
    // The definition of EVERY table (runtime ones too), so the backup documents the whole database structure and a
    // restore can build any user table the target lacks. Defaults are kept only when they are plain values; foreign
    // keys are recorded but not recreated.
    const everyTable = (await dialect.listTables())
      .filter((t) => !t.view && !t.name.startsWith('sqlite_') && !t.name.startsWith('search_fts'))
      .map((t) => t.name);
    const allFks = await dialect.foreignKeys();
    const schema = {};
    for (const name of everyTable) {
      const details = shapes.get(name) ?? (await dialect.columnDetails(name));
      const idx =
        indexes.get(name) ??
        (await dialect.indexList(name)).filter(
          (i) => !/^sqlite_autoindex|^primary$|_pkey$/i.test(i.name),
        );
      schema[name] = {
        columns: details.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: !!c.nullable,
          primaryKey: !!c.primaryKey,
          autoIncrement: !!c.autoIncrement,
          default: parseDefault(c) ?? null,
        })),
        indexes: idx.map((i) => ({ name: i.name, unique: !!i.unique, columns: i.columns })),
        foreignKeys: allFks
          .filter((f) => f.table === name)
          .map((f) => ({ column: f.column, refTable: f.refTable, refColumn: f.refColumn })),
      };
    }
    const mediaKeys = includeMedia ? await mediaFiles() : [];
    const migrations = await appliedMigrations();

    const tables = {};
    const mediaIndex = {};
    const secretKeys = {};
    const counters = { secretsRemoved: 0, rows: 0, missing: 0, mediaBytes: 0 };

    if (!storage.putStream)
      throw new Error('This storage cannot take a stream, so a backup cannot be written.');
    const zip = new yazl.ZipFile();
    // The zip goes to storage as it is produced.
    const stored = storage.putStream(fileKey(id), zip.outputStream);
    stored.catch(() => {});

    async function* tableRows(trx, name) {
      const details = shapes.get(name);
      const cols = details.map((c) => c.name);
      const pks = details.filter((c) => c.primaryKey).map((c) => c.name);
      const hash = createHash('sha256');
      let rows = 0;
      let bytes = 0;
      let last = null;
      for (let offset = 0; ; offset += READ_CHUNK) {
        const q = trx(name).select(cols).limit(READ_CHUNK);
        if (pks.length) {
          for (const c of pks) q.orderBy(c);
          // "the rows after the last one", for a key of any width: no OFFSET, so a huge table is not re-scanned.
          if (last)
            q.where((b) => {
              pks.forEach((c, i) =>
                b.orWhere((w) => {
                  for (let j = 0; j < i; j++) w.where(pks[j], '=', last[pks[j]]);
                  w.where(c, '>', last[c]);
                }),
              );
            });
        } else {
          q.orderBy(cols[0]).offset(offset);
        }
        const batch = await q;
        if (!batch.length) break;
        const lines = [];
        for (const r of batch) {
          if (secrets === 'remove') counters.secretsRemoved += scrub(r, () => false);
          else scrub(r, () => true, secretKeys);
          lines.push(JSON.stringify(r, replacer));
        }
        const buf = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
        hash.update(buf);
        bytes += buf.length;
        rows += batch.length;
        counters.rows += batch.length;
        last = batch[batch.length - 1];
        yield buf;
        if (batch.length < READ_CHUNK) break;
      }
      tables[name] = {
        rows,
        bytes,
        sha256: hash.digest('hex'),
        columns: cols,
      };
    }

    async function* fileBytes(folder, rel, dir) {
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const c of fs.createReadStream(path.join(dir, rel))) {
        hash.update(c);
        bytes += c.length;
        yield c;
      }
      const f = folderIndex[folder];
      f.index[rel] = { bytes, sha256: hash.digest('hex') };
      f.files++;
      f.bytes += bytes;
    }

    async function* mediaBytes(key) {
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const c of storage.stream(key)) {
        hash.update(c);
        bytes += c.length;
        yield c;
      }
      mediaIndex[key] = { bytes, sha256: hash.digest('hex') };
      counters.mediaBytes += bytes;
    }

    const folderIndex = {};

    const manifest = () => ({
      format: FORMAT,
      app: ctx.version,
      dialect: dialect.kind,
      createdAt: now(),
      createdBy: actor?.email ?? null,
      secrets,
      secretsRemoved: counters.secretsRemoved,
      secretKeys,
      includeMedia,
      migrations,
      tables,
      skippedTables: skippedNames,
      rows: counters.rows,
      media: {
        files: Object.keys(mediaIndex).length,
        bytes: counters.mediaBytes,
        missing: counters.missing,
        index: mediaIndex,
      },
      folders: folderIndex,
      dataScope: only ? 'tables' : 'prefixed',
      schema,
    });

    // If the copy fails part-way (storage full, the snapshot transaction ends), streams still waiting to be read raise
    // errors of their own; they are already covered by the failure being reported, so they must not crash the process.
    const noop = () => {};
    zip.on('error', noop);
    const fromGen = (gen) => {
      const r = Readable.from(gen, { objectMode: false });
      r.on('error', noop);
      return r;
    };
    // The snapshot has to stay open until the last entry has been read, so the transaction waits for storage to finish.
    await db.transaction(
      async (trx) => {
        let step = 0;
        for (const name of names) {
          zip.addReadStream(
            fromGen(
              (async function* () {
                await setStatus({ step: `Reading ${name}`, done: step++, total: names.length });
                yield* tableRows(trx, name);
              })(),
            ),
            `db/${name}.ndjson`,
          );
        }
        let n = 0;
        for (const key of mediaKeys) {
          if (!(await storage.exists(key))) {
            counters.missing++;
            continue;
          }
          zip.addReadStream(
            fromGen(
              (async function* () {
                if (n++ % 25 === 0)
                  await setStatus({ step: `Reading media (${n} of ${mediaKeys.length})` });
                yield* mediaBytes(key);
              })(),
            ),
            `media/${key}`,
            { compress: false }, // pictures and documents are already compressed
          );
        }
        for (const folder of folders) {
          const { dir, files, changesOnly } = await folderFiles(folder);
          folderIndex[folder] = { files: 0, bytes: 0, changesOnly, index: {} };
          let k = 0;
          for (const rel of files) {
            zip.addReadStream(
              fromGen(
                (async function* () {
                  if (k++ % 25 === 0)
                    await setStatus({ step: `Reading ${folder}/ (${k} of ${files.length})` });
                  yield* fileBytes(folder, rel, dir);
                })(),
              ),
              `files/${folder}/${rel}`,
            );
          }
        }
        zip.addReadStream(
          fromGen(
            (async function* () {
              yield Buffer.from(JSON.stringify(manifest(), null, 2), 'utf8');
            })(),
          ),
          'manifest.json',
        );
        zip.end();
        await stored;
      },
      { isolationLevel: dialect.kind === 'sqlite' ? undefined : 'repeatable read' },
    );
    return { manifest: manifest(), size: await stored };
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
     * @param {{ includeMedia?: boolean, secrets?: 'keep'|'remove', folders?: string[], tables?: string[], name?: string, source?: string }} [opts]
     * @param {any} [actor]
     */
    async create(opts = {}, actor = null) {
      await assertIdle();
      const includeMedia = opts.includeMedia !== false;
      const secrets = opts.secrets === 'remove' ? 'remove' : 'keep';
      const folders = (opts.folders ?? FOLDER_IDS).filter((f) => FOLDER_IDS.includes(f));
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
          const { manifest, size } = await build(
            id,
            { includeMedia, secrets, folders, tables: opts.tables },
            actor,
          );
          await finish(id, { status: 'ready', size, manifest: JSON.stringify(manifest) });
          await audit.log({
            actor,
            action: 'backup.created',
            entity: 'backup',
            entityId: id,
            meta: {
              rows: manifest.rows,
              media: manifest.media.files,
              folders: Object.keys(manifest.folders ?? {}),
              secrets,
            },
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

    /**
     * Accept a backup made elsewhere. `source` is a file on disk (the upload route streams the request into one) or,
     * for small cases, a buffer. It is checked before it is kept, then moved into storage as a stream.
     * @param {string | Buffer} source
     * @param {string} name
     * @param {any} actor
     */
    async upload(source, name, actor) {
      let file = typeof source === 'string' ? source : null;
      let temp = null;
      if (!file) {
        temp = path.join(os.tmpdir(), `cms-upload-${randomBytes(6).toString('hex')}.zip`);
        await fsp.writeFile(temp, source);
        file = temp;
      }
      try {
        const zip = await openZip(file);
        let manifest;
        try {
          manifest = await readManifest(zip);
        } finally {
          zip.close();
        }
        const size = (await fsp.stat(file)).size;
        const id = await dialect.insertGetId(db('backups'), {
          name: String(name || 'Uploaded backup').slice(0, 190),
          status: 'running',
          source: 'uploaded',
          secrets: manifest.secrets === 'remove' ? 'remove' : 'keep',
          size,
          manifest: JSON.stringify(manifest),
          created_by: actor?.id ?? null,
          created_at: now(),
        });
        try {
          await storage.putStream(fileKey(id), fs.createReadStream(file));
        } catch (e) {
          await db('backups').where({ id }).delete();
          throw e;
        }
        await finish(id, { status: 'ready' });
        await audit.log({ actor, action: 'backup.uploaded', entity: 'backup', entityId: id });
        return svc.get(id);
      } finally {
        if (temp) await fsp.rm(temp, { force: true });
      }
    },

    /**
     * The one-step-back copy taken just before records are erased: ALL the data of `tables`, nothing else. Resolves
     * when it is complete and readable, and throws if it is not, so the caller can refuse to erase anything.
     * @param {string[]} tables
     * @param {any} actor
     */
    async snapshot(tables, actor) {
      const b = await svc.create(
        {
          tables,
          folders: [],
          includeMedia: false,
          secrets: 'keep',
          source: 'flush',
          name: 'Before erasing data',
        },
        actor,
      );
      await jobs.get(b.id);
      const done = await svc.get(b.id);
      if (done.status !== 'ready')
        throw new HttpError(
          500,
          'snapshot_failed',
          `The copy taken before erasing could not be made (${done.error ?? 'unknown reason'}), so nothing was erased.`,
        );
      return done;
    },

    /** The newest one-step-back snapshot, or null. */
    async lastFlush() {
      const r = await db('backups')
        .where({ source: 'flush', status: 'ready' })
        .orderBy('id', 'desc')
        .first();
      return r ? toRow(r) : null;
    },

    /** One step back only: when a newer snapshot exists the older ones are removed. */
    async dropOldFlush(keepId) {
      const old = await db('backups').where({ source: 'flush' }).whereNot({ id: keepId });
      for (const r of old) {
        await storage.delete(fileKey(r.id)).catch(() => {});
        await db('backups').where({ id: r.id }).delete();
      }
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
     * What restoring this backup here would do, and what stops it. Nothing is changed. Reads only the manifest.
     * @returns {Promise<{ backup: any, blockers: string[], warnings: string[], adds: { tables: number, rows: number }, secretsNotReadable: number, creates: string[] }>}
     */
    async inspect(id) {
      const backup = await svc.get(id);
      if (backup.status !== 'ready')
        throw new HttpError(409, 'conflict', 'That backup is not ready.');
      const manifest = await withZip(fileKey(backup.id), (zip) => readManifest(zip));
      const blockers = [];
      const warnings = [];
      const have = new Set(await appliedMigrations());
      const newer = manifest.migrations.filter((m) => !have.has(m));
      if (newer.length)
        blockers.push(
          `This backup comes from a newer version of the software (${newer.length} database change${newer.length === 1 ? '' : 's'} this server does not have yet). Update this server first, then restore.`,
        );
      const here = new Set(backup.source === 'flush' ? await allTables() : await userTables());
      const missing = Object.keys(manifest.tables).filter((t) => !here.has(t) && !skipped(t));
      // Tables the backup defines (data or not) that this server lacks and does not run on its own.
      const defined = Object.keys(manifest.schema ?? {}).filter(
        (t) => !here.has(t) && !skipped(t) && IDENT.test(t),
      );
      const creates = defined;
      // Existing tables that lack columns the backup has get them added (never changed or removed).
      const alters = [];
      for (const t of Object.keys(manifest.schema ?? {})) {
        if (!here.has(t) || skipped(t) || !IDENT.test(t)) continue;
        const have = new Set((await dialect.columnDetails(t)).map((c) => c.name));
        const add = manifest.schema[t].columns.filter((c) => !have.has(c.name)).map((c) => c.name);
        if (add.length) alters.push({ table: t, columns: add });
      }
      warnings.push(
        'Records are added only where they are missing (matched by primary key). Anything already here is kept exactly as it is; nothing is deleted or replaced.',
      );
      if (alters.length)
        warnings.push(
          `${alters.length} table${alters.length === 1 ? '' : 's'} here will get columns added that they do not have yet: ${alters
            .slice(0, 4)
            .map((a) => `${a.table} (${a.columns.join(', ')})`)
            .join(
              '; ',
            )}${alters.length > 4 ? '…' : ''}. Existing columns are never changed or removed.`,
        );
      const unbuildable = missing.filter((t) => !creates.includes(t) && !defined.includes(t));
      if (creates.length)
        warnings.push(
          `${creates.length} table${creates.length === 1 ? '' : 's'} in the backup do not exist here and will be created from the backup's own definition: ${creates.slice(0, 6).join(', ')}${creates.length > 6 ? '…' : ''}. Column defaults that are not plain values, and foreign keys, are not recreated.`,
        );
      if (unbuildable.length)
        warnings.push(
          `${unbuildable.length} table${unbuildable.length === 1 ? '' : 's'} in the backup do not exist here and have no definition to build them from, so they will be skipped: ${unbuildable.slice(0, 6).join(', ')}.`,
        );
      for (const [folder, f] of Object.entries(manifest.folders ?? {}))
        if (f.files)
          warnings.push(
            `${f.files} file${f.files === 1 ? '' : 's'} not already in ${folder}/ on this server will be written. A file that already exists there is never overwritten${f.changesOnly ? ' (only files that differ from the code were saved)' : ''}. Each server in a cluster keeps its own copy of these folders, so restore on every server that needs them.`,
          );
      if (!manifest.includeMedia)
        warnings.push(
          'This backup has no uploaded files. Pictures that point at files this server does not have will show as missing.',
        );
      // The manifest counts the saved secrets per master key, so this needs no reading of the data.
      let unreadable = 0;
      if (manifest.secrets === 'keep')
        for (const [keyId, n] of Object.entries(manifest.secretKeys ?? {}))
          if (!crypto.canDecrypt(`enc:v1:${keyId}:`)) unreadable += Number(n);
      if (unreadable)
        warnings.push(
          `${unreadable} saved secret${unreadable === 1 ? '' : 's'} (passwords and API keys, such as the mail password) were encrypted with a key this server does not have. They will be cleared; enter them again under Settings after restoring.`,
        );
      return {
        backup,
        blockers,
        warnings,
        adds: {
          tables: Object.keys(manifest.tables).filter((t) => here.has(t) || creates.includes(t))
            .length,
          rows: Object.entries(manifest.tables)
            .filter(([t]) => here.has(t) || creates.includes(t))
            .reduce((n, [, v]) => n + v.rows, 0),
        },
        secretsNotReadable: unreadable,
        creates,
      };
    },

    /**
     * Bring a backup onto this installation, ADDING only: missing tables are created, missing columns are added with
     * ALTER TABLE, missing records and files are added. Nothing is ever deleted, dropped, replaced or overwritten. The
     * records go in as ONE transaction (all or nothing). A safety backup first is optional.
     * @param {number | string} id
     * @param {{ confirm: string, safety?: boolean }} opts
     * @param {any} actor
     */
    async restore(id, opts, actor) {
      if (opts?.confirm !== 'RESTORE')
        throw new HttpError(
          422,
          'invalid_input',
          'Type RESTORE to confirm. A restore only adds what is missing here (tables, columns and records); nothing is deleted or replaced.',
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
          if (opts.safety === true) {
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

  /** Stream one entry through a hash and compare it with what the manifest recorded. */
  async function verify(zip, name, expected) {
    const m = measure();
    const sink = new Transform({ transform: (_c, _e, cb) => cb() });
    await pipeline(await zip.stream(name), m.transform, sink);
    if (m.result.sha256 !== expected)
      throw new Error(
        `The backup is damaged ("${name.replace(/^(db|media)\//, '')}" does not match its checksum). Nothing was restored.`,
      );
  }

  async function apply(id, actor) {
    const backup = await svc.get(id);
    return withZip(fileKey(backup.id), async (zip) => {
      const manifest = await readManifest(zip);
      // A snapshot this server made itself before an erase (source 'flush') restores every table it carries. Any other
      // backup, which may have come from anywhere, only ever restores the do_ / sys_ / data_ tables.
      const trusted = backup.source === 'flush';
      let here = new Set(trusted ? await allTables() : await userTables());
      // The tables the backup defines that this server may have: never a runtime table, which the target owns.
      const defined = Object.keys(manifest.schema ?? {}).filter(
        (t) => !skipped(t) && IDENT.test(t),
      );
      const creatable = defined.filter((t) => !here.has(t));
      // Data is only ever restored for the tables people create, even if a hand-made backup carries more.
      const wanted = Object.keys(manifest.tables).filter(
        (t) => (trusted || DATA_PREFIX.test(t)) && (here.has(t) || creatable.includes(t)),
      );
      const folderEntries = Object.entries(manifest.folders ?? {})
        .filter(([id]) => FOLDER_IDS.includes(id))
        .flatMap(([id, f]) =>
          Object.keys(f.index ?? {})
            .filter(safeRel)
            .map((rel) => [id, rel, f.index[rel].sha256]),
        );
      const mediaKeys = Object.keys(manifest.media?.index ?? {});

      // 1. Every file must match what the manifest recorded, before anything is touched.
      let n = 0;
      const total = wanted.length + mediaKeys.length + folderEntries.length;
      for (const t of wanted) {
        await setStatus({ step: `Checking the backup (${++n} of ${total})` });
        if (!zip.names.has(`db/${t}.ndjson`))
          throw new Error(`The backup is damaged (table "${t}" is missing). Nothing was restored.`);
        await verify(zip, `db/${t}.ndjson`, manifest.tables[t].sha256);
      }
      for (const key of mediaKeys) {
        if (n++ % 25 === 0) await setStatus({ step: `Checking the backup (${n} of ${total})` });
        if (!zip.names.has(`media/${key}`))
          throw new Error(
            `The backup is damaged (file "${key}" is missing). Nothing was restored.`,
          );
        await verify(zip, `media/${key}`, manifest.media.index[key].sha256);
      }
      for (const [folder, rel, sha] of folderEntries) {
        if (n++ % 25 === 0) await setStatus({ step: `Checking the backup (${n} of ${total})` });
        if (!zip.names.has(`files/${folder}/${rel}`))
          throw new Error(
            `The backup is damaged (file "${folder}/${rel}" is missing). Nothing was restored.`,
          );
        await verify(zip, `files/${folder}/${rel}`, sha);
      }

      // 2. Uploaded files that are not already stored. A file that exists is never replaced.
      const result = {
        tables: wanted.length,
        rowsInBackup: 0,
        rowsAdded: 0,
        rowsAlreadyThere: 0,
        rowsSkippedNoKey: 0,
        tablesCreated: 0,
        columnsAdded: 0,
        indexesAdded: 0,
        files: 0,
        filesKept: 0,
        folderFiles: 0,
        folderFilesKept: 0,
        secretsCleared: 0,
      };
      n = 0;
      for (const key of mediaKeys) {
        if (n++ % 25 === 0)
          await setStatus({ step: `Restoring files (${n} of ${mediaKeys.length})` });
        if (!KEY.test(key) || key.includes('..')) continue;
        if (await storage.exists(key)) result.filesKept++;
        else {
          await storage.putStream(key, await zip.stream(`media/${key}`));
          result.files++;
        }
      }

      // 3. The structure, additions only: tables this server lacks are created, and an existing table gets the columns
      //    and indexes it lacks with ALTER TABLE. Nothing is dropped, renamed or changed.
      for (const t of creatable) {
        await setStatus({ step: `Creating table ${t}` });
        await createTable(t, manifest.schema[t]);
        result.tablesCreated++;
      }
      for (const t of defined.filter((x) => here.has(x))) {
        const added = await addMissingColumns(t, manifest.schema[t]);
        result.columnsAdded += added;
      }
      here = new Set(trusted ? await allTables() : await userTables());
      for (const t of defined)
        result.indexesAdded += await addMissingIndexes(t, manifest.schema[t]);

      // 4. The records, all or nothing: only those whose key is not already here. Parents before children.
      const fks = await dialect.foreignKeys();
      const order = copyOrder([...here], fks).filter((t) => wanted.includes(t));
      const unreadable = { n: 0 };
      const shapes = new Map();
      for (const t of wanted) shapes.set(t, await dialect.columnDetails(t));
      await db.transaction(async (trx) => {
        for (const t of order) {
          await setStatus({ step: `Adding records to ${t}` });
          const r = await insertTable(
            trx,
            t,
            shapes.get(t),
            await zip.stream(`db/${t}.ndjson`),
            fks,
            unreadable,
            manifest.tables[t].rows,
          );
          result.rowsInBackup += manifest.tables[t].rows;
          result.rowsAdded += r.added;
          result.rowsAlreadyThere += r.already;
          result.rowsSkippedNoKey += r.noKey;
        }
      });
      result.secretsCleared = unreadable.n;

      // Folder files: only those not already on this server.
      await setStatus({ step: 'Restoring files in folders' });
      const w = await writeFolders(zip, folderEntries);
      result.folderFiles = w.written;
      result.folderFilesKept = w.kept;
      if (w.written && folderEntries.some(([id]) => id === 'plugins'))
        await ctx.plugins?.rescanDisk?.().catch(() => {});

      // PostgreSQL does not move a sequence when rows arrive with their own ids.
      await fixSequences(order);
      await audit.log({
        actor: null,
        action: 'backup.restored',
        entity: 'backup',
        entityId: backup.id,
        meta: { by: actor?.email ?? null, ...result },
      });
      return result;
    });
  }

  /** Build a table from the definition a backup carries. Names and types are checked; defaults are plain values only. */
  async function createTable(name, schema) {
    const cols = schema.columns ?? [];
    if (!cols.length || !cols.every((c) => IDENT.test(c.name)))
      throw new Error(
        `The backup's definition of table "${name}" is not valid. Nothing was restored.`,
      );
    const pks = cols.filter((c) => c.primaryKey && !c.autoIncrement);
    await db.schema.createTable(name, (b) => {
      for (const c of cols) {
        const col = buildColumn(b, c);
        const d = c.autoIncrement ? undefined : c.default;
        if (d !== null && d !== undefined) col.defaultTo(d);
      }
      if (pks.length) b.primary(pks.map((c) => c.name));
    });
  }

  /**
   * ALTER TABLE … ADD COLUMN for each column the backup defines and this table lacks. The new column is nullable unless
   * it has a plain default, because rows already in the table have no value for it. An existing column is left alone.
   */
  async function addMissingColumns(table, schema) {
    const have = new Set((await dialect.columnDetails(table)).map((c) => c.name));
    const missing = (schema.columns ?? []).filter((c) => !have.has(c.name));
    if (missing.some((c) => !IDENT.test(c.name)))
      throw new Error(
        `The backup's definition of table "${table}" is not valid. Nothing was restored.`,
      );
    let n = 0;
    for (const c of missing) {
      await setStatus({ step: `Adding column ${c.name} to ${table}` });
      const d = c.autoIncrement ? undefined : c.default;
      await db.schema.alterTable(table, (b) => {
        const col = buildColumn(b, {
          ...c,
          nullable: true,
          primaryKey: false,
          autoIncrement: false,
        });
        if (d !== null && d !== undefined) {
          col.defaultTo(d);
          if (c.nullable === false) col.notNullable();
        }
      });
      n++;
    }
    return n;
  }

  /** Indexes the backup defines that this table lacks (by name), when all their columns exist here. Never fails the restore. */
  async function addMissingIndexes(table, schema) {
    const idx = schema.indexes ?? [];
    if (!idx.length || !(await db.schema.hasTable(table))) return 0;
    const have = new Set((await dialect.indexList(table)).map((i) => i.name));
    const cols = new Set((await dialect.columnDetails(table)).map((c) => c.name));
    let n = 0;
    for (const i of idx) {
      if (have.has(i.name) || !IDENT.test(i.name)) continue;
      if (!i.columns?.length || !i.columns.every((c) => IDENT.test(c) && cols.has(c))) continue;
      try {
        await db.schema.alterTable(table, (b) =>
          i.unique ? b.unique(i.columns, { indexName: i.name }) : b.index(i.columns, i.name),
        );
        n++;
      } catch (e) {
        // A unique index cannot be added over rows that already break it; that is left as it is, and said in the log.
        log?.warn({ err: friendly(e), table, index: i.name }, 'backup: index not added');
      }
    }
    return n;
  }

  /**
   * Write the folder files of a backup that are not already on this server. Never overwrites, never deletes, never
   * follows a symlink, never leaves the folder.
   */
  async function writeFolders(zip, entries) {
    let written = 0;
    let kept = 0;
    for (const [id, rel] of entries) {
      const dir = folderDir(id);
      await fsp.mkdir(dir, { recursive: true });
      const realRoot = await fsp.realpath(dir);
      const target = path.resolve(dir, ...rel.split('/'));
      if (!target.startsWith(dir + path.sep)) continue;
      if (
        await fsp.lstat(target).then(
          () => true,
          () => false,
        )
      ) {
        kept++;
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const realParent = await fsp.realpath(path.dirname(target));
      if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) continue;
      const tmp = `${target}.cms-restore.tmp`;
      await pipeline(await zip.stream(`files/${id}/${rel}`), fs.createWriteStream(tmp));
      await fsp.rename(tmp, target);
      written++;
    }
    return { written, kept };
  }

  /**
   * Add one table's records from the zip, in batches: a record whose key is already in the table is left untouched
   * (INSERT … ON CONFLICT DO NOTHING, INSERT IGNORE on MySQL). A table with no primary key cannot say which records are
   * already there, so records are added only when the table is empty. Only a table that points at itself is held whole.
   */
  async function insertTable(trx, name, targetCols, input, fks, unreadable, expected) {
    const cols = new Set(targetCols.map((c) => c.name));
    const pks = targetCols.filter((c) => c.primaryKey).map((c) => c.name);
    const count = async () => Number((await trx(name).count({ n: '*' }).first()).n);
    const before = await count();
    if (!pks.length && before > 0) {
      input.destroy();
      return { added: 0, already: 0, noKey: expected };
    }
    const selfFks = fks.filter((f) => f.table === name && f.refTable === name).map((f) => f.column);
    const whole = selfFks.length > 0 && pks.length === 1;
    let width = 0;
    let batch = [];
    let held = [];
    const flush = async () => {
      if (!batch.length) return;
      const all = [...new Set(batch.flatMap((r) => Object.keys(r)))];
      await trx(name)
        .insert(batch.map((r) => Object.fromEntries(all.map((k) => [k, r[k] ?? null]))))
        .onConflict()
        .ignore();
      batch = [];
    };
    const put = async (row) => {
      width ||= Math.max(1, Object.keys(row).length);
      batch.push(row);
      if (batch.length >= Math.max(1, Math.floor(BATCH_VARS / width))) await flush();
    };
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const l of lines) {
      if (!l) continue;
      const row = JSON.parse(l, reviver);
      for (const k of Object.keys(row)) if (!cols.has(k)) delete row[k];
      unreadable.n += scrub(row, (m) => crypto.canDecrypt(m));
      if (whole) held.push(row);
      else await put(row);
    }
    if (whole) {
      held = selfRefOrder(held, pks[0], selfFks);
      for (const row of held) await put(row);
    }
    await flush();
    const added = (await count()) - before;
    return { added, already: Math.max(0, expected - added), noKey: 0 };
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
