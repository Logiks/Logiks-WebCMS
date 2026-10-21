import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { HttpError, notFound } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';
import { createEngine } from '../themes/sandbox.js';
import { SiteFormatError, checkTemplate, compileComponent, parsePage } from './component.js';

const CHANNEL = 'site:files';
const MANAGED = ['pages', 'components', 'locales'];
const LOCALE_CODE = /^[a-z]{2}(-[A-Z]{2})?$/; // locales/en.json, locales/en-IN.json
/** The extension of the files in a managed folder. */
const extOf = (top) => (top === 'locales' ? '.json' : '.html');
const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PARAM = /^\[([a-z][a-z0-9_]{0,31})\]$/; // pages/blog/[slug].html
const CATCH_ALL = /^\[\.\.\.([a-z][a-z0-9_]{0,31})\]$/; // pages/[...path].html (last segment only)
// Addresses the server itself answers before it ever looks at a page.
const SERVER_OWNED = new Set([
  'admin',
  'api',
  'media',
  'theme',
  'preview',
  'healthz',
  'readyz',
  'metrics',
]);
const STATE_FILE = '.site-mirror.json';
export const LIMITS = { files: 2000, fileBytes: 200 * 1024 };

const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Which kind of file is this path, and what is it called? Throws a 422 for anything outside the site tree.
 *   pages/about.html             → page "about"
 *   pages/products/index.html    → page "products/index"
 *   pages/blog/[slug].html       → page "blog/[slug]"    (dynamic: `slug` is filled from the address)
 *   pages/[...path].html         → page "[...path]"      (catch-all: the rest of the address)
 *   components/hero.html         → component "hero"
 *   locales/fr.json              → locale "fr"           (translations for the site's own strings; merged with the theme's)
 * `components/plugin/…` is reserved the same way for plugins' own components (`{% render "plugin/<slug>/<name>" %}`).
 * `components/theme/…` is reserved: that is where the ACTIVE THEME's components appear to templates (`{% render "theme/header" %}`).
 * @param {unknown} p
 * @returns {{kind: 'page'|'component'|'locale', name: string, params: string[], catchAll: boolean}}
 */
export function classify(p) {
  const bad = (m) => new HttpError(422, 'invalid_path', m, { field: 'path' });
  if (typeof p !== 'string' || !p) throw bad('Give the file a path such as pages/about.html.');
  if (p.length > 191) throw bad('That path is too long (191 characters at most).');
  const segs = p.split('/');
  const top = segs[0];
  if (!MANAGED.includes(top))
    throw bad(`Files live under ${MANAGED.map((m) => `${m}/`).join(' or ')}.`);
  if (top === 'locales') {
    const m = /^([^/]+)\.json$/.exec(segs[1] ?? '');
    if (segs.length !== 2 || !m || !LOCALE_CODE.test(m[1]))
      throw bad('A language file is locales/<code>.json with a code such as en, hi or en-IN.');
    return { kind: 'locale', name: m[1], params: [], catchAll: false };
  }
  if (segs.length < 2 || segs.length > 6)
    throw bad('Use between one and five folder levels below pages/ or components/.');
  const file = segs[segs.length - 1];
  if (!file.endsWith('.html')) throw bad('Pages and components are .html files.');
  const names = [...segs.slice(1, -1), file.slice(0, -5)];
  const params = [];
  let catchAll = false;
  names.forEach((n, i) => {
    if (SEGMENT.test(n)) return;
    const dyn = top === 'pages' ? (CATCH_ALL.exec(n) ?? PARAM.exec(n)) : null;
    if (!dyn)
      throw bad(
        top === 'pages'
          ? 'Names use lowercase letters, numbers, dashes and underscores (start with a letter or number), or [name] / [...name] for a part of the address that varies.'
          : 'Names use lowercase letters, numbers, dashes and underscores, and start with a letter or number.',
      );
    if (CATCH_ALL.test(n)) {
      if (i !== names.length - 1) throw bad('[...name] can only be the last part of a page path.');
      catchAll = true;
    }
    if (params.includes(dyn[1])) throw bad(`The address part "${dyn[1]}" is used twice.`);
    params.push(dyn[1]);
  });
  const name = names.join('/');
  if (top === 'components' && (name === 'theme' || name.startsWith('theme/')))
    throw bad('The name "theme" is reserved for the active theme’s own components.');
  if (top === 'components' && (name === 'plugin' || name.startsWith('plugin/')))
    throw bad(
      'The name "plugin" is reserved for components that plugins ship in their own folders.',
    );
  if (top === 'pages' && SERVER_OWNED.has(names[0]))
    throw bad(
      `"${names[0]}" is an address the server answers itself, so a page there could never be shown.`,
    );
  return { kind: top === 'pages' ? 'page' : 'component', name, params, catchAll };
}

/**
 * The site tree: pages and components.
 *
 * Source of truth: the `site_files` table. Every server keeps
 *  - an in-memory snapshot, which is what requests render from (no disk read on the request path), and
 *  - a mirror under SITE_DIR (public/), so the tree can be browsed, backed up or committed. The mirror is derived: it is
 *    rewritten from the database whenever it changes, and hand edits are kept as `<file>.local` (push them with `site:push`).
 * A write commits to the database, bumps `site_meta.version`, refreshes this server, and tells the others over the bus;
 * every server also polls the version, so a lost message heals by itself (same pattern as settings).
 */
export function createSiteFiles({
  env,
  db,
  bus,
  settings,
  audit,
  cache,
  log,
  dialect,
  defaultsDir,
}) {
  const d = dialect;
  const root = path.resolve(env.SITE_DIR);
  /** @type {{version: number, files: Map<string, {content: string, hash: string, size: number, updatedAt: number}>}} */
  let snap = { version: -1, files: new Map() };
  let chain = Promise.resolve();
  let timer = null;
  const listeners = new Set();

  // A parse-only engine: catches Liquid syntax errors when a file is saved instead of on a visitor's request.
  const lintEngine = () =>
    createEngine(new Map(), {
      limits: {
        renderMs: settings.get('themes.render_ms'),
        memoryMb: settings.get('themes.render_memory_mb'),
      },
      filters: {
        asset_url: (x) => x,
        library_url: (x) => x,
        t: (x) => x,
        absolute_url: (x) => x,
        handle: (x) => x,
      },
    });

  /** Validate one file completely. Returns what it is; throws a 422 whose message says what to fix. */
  function validate(p, content) {
    const info = classify(p);
    if (typeof content !== 'string')
      throw new HttpError(422, 'invalid_file', 'The file has no content.');
    if (content.includes('\0'))
      throw new HttpError(422, 'invalid_file', `${p}: binary content isn't allowed.`);
    if (Buffer.byteLength(content) > LIMITS.fileBytes)
      throw new HttpError(
        422,
        'invalid_file',
        `${p} is larger than ${LIMITS.fileBytes / 1024} KB. Split it into components.`,
      );
    if (info.kind === 'locale') {
      checkLocale(p, content);
      return info;
    }
    try {
      const engine = lintEngine();
      if (info.kind === 'page') {
        const { front, body } = parsePage(content);
        checkBinding(p, info, front);
        checkTemplate(engine, body, 'Template');
      } else {
        const c = compileComponent(`lint:${info.name}`, content);
        checkTemplate(engine, c.template, 'Template');
      }
    } catch (e) {
      if (e instanceof SiteFormatError)
        throw new HttpError(422, 'invalid_file', `${p}: ${e.message}`, { field: 'content' });
      throw e;
    }
    return info;
  }

  /** A language file is a JSON object of strings, nested up to 5 levels: {"blog": {"older": "Older"}}. */
  function checkLocale(p, content) {
    const bad = (m) => new HttpError(422, 'invalid_file', `${p}: ${m}`, { field: 'content' });
    let data;
    try {
      data = JSON.parse(content);
    } catch (e) {
      throw bad(`not valid JSON (${String(e.message).slice(0, 80)}).`);
    }
    let count = 0;
    const walk = (o, depth, at) => {
      if (o === null || typeof o !== 'object' || Array.isArray(o))
        throw bad(`${at || 'the file'} should be an object of strings.`);
      if (depth > 5) throw bad(`"${at}" is nested too deeply (5 levels at most).`);
      for (const [k, v] of Object.entries(o)) {
        const here = at ? `${at}.${k}` : k;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(k))
          throw bad(`"${here}": keys use letters, numbers, dashes and underscores.`);
        if (typeof v === 'string') {
          if (v.length > 2000) throw bad(`"${here}" is longer than 2000 characters.`);
          if (++count > 3000) throw bad('a language file can hold 3000 strings at most.');
        } else walk(v, depth + 1, here);
      }
    };
    walk(data, 1, '');
  }

  // A page that says which content it shows must have the address parts that content needs.
  function checkBinding(p, info, front) {
    const bad = (m) => new SiteFormatError(`${m}`);
    if (front.entry && !front.entry.includes(':')) {
      const need = front.entry === 'own' ? ['type'] : [];
      const has = (n) => info.params.includes(n);
      if (need.some((n) => !has(n)) || !(has('slug') || has('path') || has('id')))
        throw bad(
          front.entry === 'own'
            ? 'entry: own needs [type] and [...path] (or [slug]) in the file name, for example pages/[type]/[...path].html.'
            : `entry: ${front.entry} needs [slug], [id] or [...path] in the file name, for example pages/blog/[slug].html. For one fixed page write entry: ${front.entry}:the/path.`,
        );
    }
    if (front.terms && !info.params.includes('slug'))
      throw bad('terms: needs [slug] in the file name, for example pages/category/[slug].html.');
    if (front.entry && front.terms) throw bad('A page shows an entry or a term, not both.');
  }

  // ───────── the snapshot ─────────

  function reload(force = false) {
    const run = chain.then(async () => {
      const meta = await db('site_meta').where({ id: 1 }).first();
      const version = Number(meta?.version ?? 0);
      if (!force && version === snap.version) return;
      const rows = await db('site_files').select(
        'path',
        'content',
        'content_hash',
        'size',
        'updated_at',
      );
      snap = {
        version,
        files: new Map(
          rows.map((r) => [
            r.path,
            {
              content: r.content,
              hash: r.content_hash,
              size: Number(r.size),
              updatedAt: Number(r.updated_at),
            },
          ]),
        ),
      };
      for (const fn of listeners) fn(snap);
      await mirror().catch((e) =>
        log.warn({ err: e.message }, 'site: could not update the local public/ folder'),
      );
    });
    chain = run.catch(() => {});
    return run;
  }

  // ───────── the local public/ folder ─────────

  const inside = (p) => {
    const full = path.resolve(root, p);
    if (!full.startsWith(`${root}${path.sep}`))
      throw new Error(`Refusing to write outside ${root}`);
    return full;
  };

  async function walk(dir, rel = '') {
    const out = [];
    let entries;
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await walk(dir, r)));
      else if (e.isFile()) out.push(r);
    }
    return out;
  }

  /** Remove empty folders under `dir`, deepest first. `dir` itself stays unless `self`. */
  async function pruneEmptyDirs(dir, self = true) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory()) await pruneEmptyDirs(path.join(dir, e.name));
    if (self) await fs.rmdir(dir).catch(() => {}); // fails (and is ignored) if anything is still inside
  }

  async function mirror() {
    let state = {};
    try {
      state = JSON.parse(await fs.readFile(path.join(root, STATE_FILE), 'utf8'));
    } catch {
      /* first run */
    }
    const next = {};
    for (const [p, f] of snap.files) {
      const dest = inside(p);
      let onDisk = null;
      try {
        onDisk = await fs.readFile(dest, 'utf8');
      } catch {
        /* not there yet */
      }
      if (onDisk === f.content) {
        next[p] = f.hash;
        continue;
      }
      // Something else is in this file. If it is not what we wrote last time, someone edited it by hand: keep their copy.
      if (onDisk !== null && sha(onDisk) !== state[p]) {
        await fs.writeFile(`${dest}.local`, onDisk);
        log.warn(
          { file: p },
          'site: kept a hand-edited copy as .local (use site:push to save edits)',
        );
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      await fs.writeFile(tmp, f.content);
      await fs.rename(tmp, dest);
      next[p] = f.hash;
    }
    for (const top of MANAGED)
      for (const p of await walk(root, top)) {
        if (p.endsWith(extOf(top)) && !snap.files.has(p)) {
          if (sha(await fs.readFile(inside(p), 'utf8')) !== state[p])
            await fs.rename(inside(p), `${inside(p)}.local`).catch(() => {});
          else await fs.rm(inside(p), { force: true });
        }
      }
    // Deleting a file leaves its folder behind; the tree has no empty folders, so neither should the mirror. Only truly
    // empty ones go (rmdir refuses a folder that still holds anything, e.g. a hand-kept `.local` copy).
    for (const top of MANAGED) await pruneEmptyDirs(path.join(root, top), false);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, STATE_FILE), JSON.stringify(next, null, 1));
  }

  // ───────── changes ─────────

  /**
   * Save and delete files in one transaction with a single version bump.
   * `expected` (a content hash) makes a single write conditional: someone else's newer edit is refused, not overwritten.
   * @param {{writes?: {path: string, content: string, expected?: string}[], deletes?: string[]}} change
   * @param {{id?: number, email?: string, ip?: string} | null} actor
   */
  async function apply({ writes = [], deletes = [] }, actor) {
    for (const w of writes) validate(w.path, w.content);
    for (const p of deletes) classify(p);
    const written = [];
    const removed = [];
    await db.transaction(async (trx) => {
      const t = now();
      let created = 0;
      for (const w of writes) {
        const hash = sha(w.content);
        const existing = await d.lock(trx('site_files').where({ path: w.path })).first();
        if (w.expected !== undefined && (!existing || existing.content_hash !== w.expected))
          throw new HttpError(
            409,
            'conflict',
            'Someone changed this file since you opened it. Reload it and apply your change again.',
          );
        if (existing?.content_hash === hash) continue;
        const row = {
          content: w.content,
          content_hash: hash,
          size: Buffer.byteLength(w.content),
          updated_by: actor?.id ?? null,
          updated_at: t,
        };
        if (existing) await trx('site_files').where({ id: existing.id }).update(row);
        else {
          await trx('site_files').insert({ path: w.path, created_at: t, ...row });
          created++;
        }
        written.push(w.path);
        await audit.log(
          {
            actor,
            action: existing ? 'site.file_updated' : 'site.file_created',
            entity: 'site_file',
            entityId: w.path,
            meta: { bytes: row.size },
          },
          trx,
        );
      }
      for (const p of deletes) {
        const existing = await d.lock(trx('site_files').where({ path: p })).first();
        if (!existing) continue;
        await trx('site_files').where({ id: existing.id }).del();
        removed.push(p);
        await audit.log(
          { actor, action: 'site.file_deleted', entity: 'site_file', entityId: p },
          trx,
        );
      }
      if (created) {
        const n = Number((await trx('site_files').count({ n: '*' }).first()).n);
        if (n > LIMITS.files)
          throw new HttpError(
            422,
            'too_many_files',
            `A site can have ${LIMITS.files} files at most.`,
          );
      }
      if (written.length || removed.length)
        await trx('site_meta').where({ id: 1 }).increment('version', 1);
    });
    if (written.length || removed.length) {
      await reload(true);
      bus.publish(CHANNEL, { version: snap.version, by: env.nodeId }).catch(() => {});
      await cache.invalidate(['sitefiles']).catch(() => {});
    }
    return { written, removed };
  }

  const svc = {
    classify,
    validate,
    apply,
    get version() {
      return snap.version;
    },
    /** The current snapshot. Treat it as read-only. */
    snapshot: () => snap,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async start() {
      await db('site_meta').insert({ id: 1, version: 0 }).onConflict('id').ignore();
      await reload(true);
      // A site with no pages shows nothing at all (every address is a page), so an empty site tree gets the starter site.
      // Several servers may start together: paths are unique, so one wins and the others simply find the files there.
      if (!snap.files.size && defaultsDir) {
        try {
          await svc.seedDefaults(defaultsDir, null);
        } catch (e) {
          await reload(true);
          if (!snap.files.size) throw e;
        }
      }
      await bus.subscribe(CHANNEL, () =>
        reload(false).catch((e) => log.error({ err: e.message }, 'site: refresh failed')),
      );
      // A bus message can be lost: notice changes made on other servers by comparing the version.
      timer = setInterval(
        () => reload(false).catch((e) => log.warn({ err: e.message }, 'site: poll failed')),
        env.CONFIG_POLL_SECONDS * 1000,
      );
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      await chain;
    },
    /** Force a re-read (tests, and the poller's fast path). */
    refresh: () => reload(true),

    list(prefix = '') {
      return [...snap.files]
        .filter(([p]) => p.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, f]) => ({
          path: p,
          ...classify(p),
          size: f.size,
          hash: f.hash,
          updatedAt: f.updatedAt,
        }));
    },
    get(p) {
      classify(p);
      const f = snap.files.get(p);
      if (!f) throw notFound('That file');
      return { path: p, ...classify(p), content: f.content, hash: f.hash, updatedAt: f.updatedAt };
    },
    /** @param {string} expected the hash the editor loaded; omit to overwrite without checking */
    async put(p, content, actor, expected) {
      const r = await apply({ writes: [{ path: p, content, expected }] }, actor);
      return { path: p, hash: sha(content), changed: r.written.length > 0 };
    },
    async remove(p, actor) {
      classify(p);
      if (!snap.files.has(p)) throw notFound('That file');
      await apply({ deletes: [p] }, actor);
    },

    // ───────── folders (CLI: site:push / site:pull / site:seed) ─────────

    /** Write the whole tree into a folder (pages/, components/). */
    async exportTo(dir) {
      const out = path.resolve(dir);
      for (const [p, f] of snap.files) {
        const dest = path.join(out, p);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, f.content);
      }
      return { files: snap.files.size };
    },

    /**
     * Load the starter site (site/defaults/) into an EMPTY site. Pages here win over content pages at the same address, so
     * this never runs by itself: it is an explicit step (`setup`, `site:seed`), and it refuses to touch a site that has files.
     */
    async seedDefaults(dir, actor, { force = false } = {}) {
      if (snap.files.size && !force)
        return { skipped: true, written: 0, unchanged: 0, removed: 0, errors: [] };
      return { skipped: false, ...(await svc.importFrom(dir, actor)) };
    },

    /**
     * Read pages/ and components/ from a folder into the site. Files that fail validation are reported and skipped;
     * the rest are saved together. `prune` also deletes site files that are not in the folder.
     */
    async importFrom(dir, actor, { prune = false } = {}) {
      const src = path.resolve(dir);
      const writes = [];
      const errors = [];
      const seen = new Set();
      for (const top of MANAGED)
        for (const p of await walk(src, top)) {
          if (!p.endsWith(extOf(top))) continue;
          seen.add(p);
          const content = await fs.readFile(path.join(src, p), 'utf8');
          try {
            validate(p, content);
            writes.push({ path: p, content });
          } catch (e) {
            errors.push({ path: p, message: e.message });
          }
        }
      const deletes = prune ? [...snap.files.keys()].filter((p) => !seen.has(p)) : [];
      const r = await apply({ writes, deletes }, actor);
      return {
        written: r.written.length,
        unchanged: writes.length - r.written.length,
        removed: r.removed.length,
        errors,
      };
    },

    /** All files under one top-level folder (pages/ or components/), as a downloadable zip. */
    exportZip(prefix) {
      const zip = new AdmZip();
      for (const [p, f] of snap.files)
        if (p.startsWith(`${prefix}/`)) zip.addFile(p, Buffer.from(f.content));
      return zip.toBuffer();
    },

    /**
     * A zip of pages/ or components/ (Webmaster → Site pages / Components: Import). Same safety checks as a
     * theme zip (no path traversal, no symlinks, size limits) plus the usual per-file validation; a file that
     * fails is reported and skipped, the rest are saved together. `prune` also deletes files not in the zip.
     * @param {Buffer} buffer @param {any} actor @param {{prefix: 'pages'|'components', prune?: boolean}} opts
     */
    async importZip(buffer, actor, { prefix, prune = false }) {
      let zip;
      try {
        zip = new AdmZip(buffer);
      } catch {
        throw new HttpError(422, 'invalid_input', "That file isn't a valid zip archive.");
      }
      const entries = zip
        .getEntries()
        .filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX\/|\.DS_Store$)/.test(e.entryName));
      if (entries.length > LIMITS.files)
        throw new HttpError(422, 'invalid_input', `The zip has more than ${LIMITS.files} files.`);
      const writes = [];
      const errors = [];
      const seen = new Set();
      for (const e of entries) {
        const name = e.entryName;
        if (
          name.includes('\\') ||
          name.includes('\0') ||
          name.startsWith('/') ||
          /^[a-zA-Z]:/.test(name)
        ) {
          errors.push({ path: name, message: 'Unsafe file name.' });
          continue;
        }
        const norm = path.posix.normalize(name);
        if (norm.startsWith('..') || norm.split('/').includes('..') || norm !== name) {
          errors.push({ path: name, message: 'Unsafe file path.' });
          continue;
        }
        if (((e.header.attr >>> 16) & 0o170000) === 0o120000) {
          errors.push({ path: name, message: 'Symbolic links are not allowed.' });
          continue;
        }
        // Only files that actually belong to this kind: an "export pages" zip fed back into "import components"
        // (or a zip that mixes both) simply has its unrelated entries ignored, not flagged as errors.
        if (!name.startsWith(`${prefix}/`) || !name.endsWith(extOf(prefix))) continue;
        seen.add(name);
        try {
          const content = e.getData().toString('utf8');
          validate(name, content);
          writes.push({ path: name, content });
        } catch (err) {
          errors.push({ path: name, message: err.message });
        }
      }
      const deletes = prune
        ? [...snap.files.keys()].filter((p) => p.startsWith(`${prefix}/`) && !seen.has(p))
        : [];
      const r = await apply({ writes, deletes }, actor);
      return {
        written: r.written.length,
        unchanged: writes.length - r.written.length,
        removed: r.removed.length,
        errors,
      };
    },
  };
  return svc;
}
