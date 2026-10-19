import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { now } from '../../core/db/index.js';
import { HttpError, notFound, parse } from '../../core/http/errors.js';
import { createMirror } from './mirror.js';
import { TarballError, readTarball, verifyIntegrity } from './tarball.js';

const CHANNEL = 'libraries:changed';
const MAX_FILES = 10_000;
export const LIB_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION_OR_TAG = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
/** What /lib/ serves. No .html or .md: a page from a package must never run on the site's own address. */
export const LIB_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
};
const isScript = (p) => /\.(m?js)$/i.test(p);
const attr = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** Where one installed version is unpacked on this server: stable per (name, version, integrity), safe as a folder name. */
const dirName = (l) =>
  `${l.name.replace('/', '+')}@${l.version}-${createHash('sha256').update(l.integrity).digest('hex').slice(0, 12)}`;

const importSchema = z.object({
  format: z.literal('cms-libraries', {
    error: 'This isn’t a libraries list exported from this CMS.',
  }),
  version: z.literal(1).optional(),
  libraries: z
    .array(
      z.object({
        name: z.string().max(191),
        version: z.string().max(64),
        integrity: z.string().max(191).optional(),
        include: z.array(z.string().max(300)).max(50).default([]),
        autoload: z.boolean().default(false),
        position: z.number().int().min(0).max(10_000).optional(),
      }),
    )
    .max(100),
});

/**
 * System → Libraries (docs/DECISIONS.md D-054): npm packages for the public site.
 *
 * Installing fetches the package from the registry (Settings → Libraries), checks its published integrity hash, reads
 * the tarball in memory with our own strict reader, and stores the tarball in the database — the source of truth, like
 * the site tree. Each server unpacks it on first use into LIBRARY_DIR (a derived, disposable mirror, like public/),
 * re-checking the hash, and serves the files at `/lib/<name>@<version>/<path>` with a year-long cache (the URL carries
 * the exact version). Templates reach a file with `{{ 'pkg/path' | library_url }}`; a library set to load on every page
 * has its chosen CSS/JS added to every page's <head>/<body>.
 *
 * The installed list lives in memory on each server, reloaded over the bus and healed by polling (as themes are).
 * Scripts are off unless Settings → Libraries allows them: package JavaScript runs on the admin's own address.
 * @param {{env: any, db: any, settings: any, bus: any, audit: any, cache: any, log: any, fetch?: typeof fetch, lookup?: (host: string) => Promise<{address: string}[]>}} deps
 */
export function createLibraries({
  env,
  db,
  settings,
  bus,
  audit,
  cache,
  log,
  fetch: fetchImpl = fetch,
  lookup,
}) {
  /** @type {any[]} */
  let libs = [];
  let fingerprint = '';
  let timer = null;
  /** @type {Map<string, Promise<string>>} dirName → unpacking */
  const unpacking = new Map();

  const COLS = [
    'id',
    'name',
    'version',
    'integrity',
    'size',
    'unpacked_size',
    'files',
    'include',
    'autoload',
    'position',
    'description',
    'license',
    'homepage',
    'installed_at',
    'updated_at',
  ];
  const fromRow = (r) => {
    const files = JSON.parse(r.files);
    return {
      id: Number(r.id),
      name: r.name,
      version: r.version,
      integrity: r.integrity,
      size: Number(r.size),
      unpackedSize: Number(r.unpacked_size),
      fileCount: files.length,
      fileSet: new Map(files),
      include: JSON.parse(r.include),
      autoload: !!r.autoload,
      position: Number(r.position),
      description: r.description,
      license: r.license,
      homepage: r.homepage,
      installedAt: Number(r.installed_at),
      updatedAt: Number(r.updated_at),
    };
  };
  const view = ({ fileSet: _files, ...l }) => ({
    ...l,
    url: `/lib/${l.name}@${l.version}/`,
  });

  const dbFingerprint = async () =>
    (await db('libraries').orderBy('id').select('id', 'version', 'updated_at'))
      .map((r) => `${r.id}:${r.version}:${r.updated_at}`)
      .join('|');

  async function reload() {
    const rows = await db('libraries')
      .select(COLS)
      .orderBy([{ column: 'position' }, { column: 'name' }]);
    libs = rows.map(fromRow);
    fingerprint = await dbFingerprint();
  }

  /** After any change: every server reloads its list, and cached pages (which carry the library tags) are refreshed. */
  async function changed() {
    await reload();
    await cache.invalidate(['theme']);
    await bus.publish(CHANNEL, {}).catch(() => {});
  }

  const find = (name) => libs.find((l) => l.name === name);
  const need = (name) => {
    const l = find(name);
    if (!l) throw notFound('That library');
    return l;
  };
  const allowScripts = () => settings.get('libraries.allow_scripts');
  const maxBytes = () => settings.get('libraries.max_package_mb') * 1024 * 1024;
  const registry = () => settings.get('libraries.registry_url').replace(/\/+$/, '');
  const encName = (name) => name.replace('/', '%2f');
  const checkName = (name) => {
    if (typeof name !== 'string' || name.length > 191 || !LIB_NAME.test(name))
      throw new HttpError(
        422,
        'invalid_input',
        'That isn’t an npm package name (lowercase, like bootstrap or @fortawesome/fontawesome-free).',
        { field: 'name' },
      );
  };

  // ───────── the registry ─────────

  async function registryGet(url, { accept = 'application/json', binary = false } = {}) {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { accept },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new HttpError(
        502,
        'registry_unreachable',
        `The package registry didn’t answer (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message}). Check the registry address under Settings → Libraries and this server’s internet access.`,
      );
    }
    if (res.status === 404) return null;
    if (!res.ok)
      throw new HttpError(
        502,
        'registry_error',
        `The package registry answered ${res.status}. Try again, or check the registry address under Settings → Libraries.`,
      );
    if (!binary) return res.json();
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes()) throw tooBig();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes()) throw tooBig();
    return buf;
  }
  const tooBig = () =>
    new HttpError(
      413,
      'too_large',
      `That package is larger than ${settings.get('libraries.max_package_mb')} MB (Settings → Libraries).`,
    );

  async function packument(name) {
    checkName(name);
    const p = await registryGet(`${registry()}/${encName(name)}`, {
      accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
    });
    if (!p)
      throw new HttpError(
        404,
        'not_found',
        `There is no package called "${name}" on the registry.`,
      );
    return p;
  }

  /** Which files of a package to load on every page, when nobody has chosen yet: its stylesheet, and its browser build. */
  function suggest(pkg, files) {
    const has = (p) => typeof p === 'string' && files.has(p.replace(/^\.\//, ''));
    const out = [];
    const short = String(pkg.name ?? '')
      .split('/')
      .pop();
    const css = [
      pkg.style,
      'css/all.min.css',
      `dist/css/${short}.min.css`,
      `dist/${short}.min.css`,
      `css/${short}.min.css`,
      `${short}.min.css`,
      'index.css',
    ].find(has);
    if (css) out.push(css.replace(/^\.\//, ''));
    if (allowScripts()) {
      const js = [
        pkg.jsdelivr,
        pkg.unpkg,
        typeof pkg.browser === 'string' ? pkg.browser : null,
      ].find((p) => has(p) && isScript(p));
      if (js) out.push(js.replace(/^\.\//, ''));
    }
    return out;
  }

  /** @returns {string[]} the include list, checked against the package's files and the scripts setting */
  function checkInclude(lib, include) {
    const out = [];
    for (const p of include) {
      if (!lib.fileSet.has(p))
        throw new HttpError(422, 'invalid_input', `"${p}" isn't a file of ${lib.name}.`, {
          field: 'include',
        });
      if (!/\.(css|m?js)$/i.test(p))
        throw new HttpError(
          422,
          'invalid_input',
          `"${p}" isn't a stylesheet or script, so it can't be loaded on every page.`,
          { field: 'include' },
        );
      if (isScript(p) && !allowScripts())
        throw new HttpError(
          422,
          'scripts_off',
          `"${p}" is JavaScript. Allow library scripts under Settings → Libraries first.`,
          { field: 'include' },
        );
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  // ───────── this server's unpacked copy ─────────

  /** Unpack a library into LIBRARY_DIR once (per server), from the database copy, re-checking its hash. */
  function unpacked(lib) {
    const dir = path.join(env.LIBRARY_DIR, dirName(lib));
    let p = unpacking.get(dir);
    if (!p) {
      p = (async () => {
        try {
          await fs.access(path.join(dir, '.complete'));
          return dir;
        } catch {
          /* not unpacked yet */
        }
        const row = await db('libraries')
          .where({ name: lib.name, version: lib.version })
          .first('tarball', 'integrity');
        if (!row) throw notFound('That library');
        const buf = Buffer.from(row.tarball, 'base64');
        if (!verifyIntegrity(buf, row.integrity))
          throw new HttpError(
            500,
            'integrity',
            `The stored copy of ${lib.name} doesn't match its hash. Reinstall it.`,
          );
        // The same bytes passed the install-time limits; its recorded size bounds the unpack here.
        const files = readTarball(buf, { maxBytes: lib.unpackedSize, maxFiles: MAX_FILES });
        const tmp = `${dir}.tmp-${randomBytes(4).toString('hex')}`;
        for (const [rel, data] of files) {
          const abs = path.join(tmp, rel);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, data);
        }
        await fs.writeFile(path.join(tmp, '.complete'), lib.integrity);
        try {
          await fs.rename(tmp, dir);
        } catch {
          // Another process on this machine unpacked it first: theirs is identical.
          await fs.rm(tmp, { recursive: true, force: true });
        }
        return dir;
      })();
      unpacking.set(dir, p);
      p.catch(() => unpacking.delete(dir));
    }
    return p;
  }

  const svc = {
    async start() {
      await reload();
      await bus.subscribe(CHANNEL, () =>
        reload().catch((e) => log.error({ err: e.message }, 'libraries: reload failed')),
      );
      // Bus messages can be lost: notice changes made on other servers with a cheap fingerprint.
      timer = setInterval(async () => {
        try {
          if ((await dbFingerprint()) !== fingerprint) await reload();
        } catch (e) {
          log.warn({ err: e.message }, 'libraries: poll failed');
        }
      }, env.CONFIG_POLL_SECONDS * 1000);
      timer.unref();
    },
    stop: () => clearInterval(timer),

    list: () => libs.map(view),
    /** @returns {any} */
    get(name) {
      const l = need(name);
      return { ...view(l), files: [...l.fileSet].map(([p, size]) => ({ path: p, size })) };
    },

    /** The <link>/<script> tags of libraries that load on every page, in their order. */
    tags() {
      const head = [];
      const foot = [];
      const scripts = allowScripts();
      for (const l of libs) {
        if (!l.autoload) continue;
        for (const p of l.include) {
          const href = attr(`/lib/${l.name}@${l.version}/${p}`);
          if (/\.css$/i.test(p)) head.push(`<link rel="stylesheet" href="${href}">`);
          else if (scripts && isScript(p))
            foot.push(
              `<script src="${href}"${/\.mjs$/i.test(p) ? ' type="module"' : ''} defer></script>`,
            );
        }
      }
      return { head, foot };
    },

    /** `pkg/path/in/it` (or just `pkg`) → its URL at the installed version; '' when no such library is installed. */
    url(spec) {
      let best = null;
      for (const l of libs)
        if (
          (spec === l.name || spec.startsWith(`${l.name}/`)) &&
          (!best || l.name.length > best.name.length)
        )
          best = l;
      if (!best) return '';
      return `/lib/${best.name}@${best.version}/${spec.slice(best.name.length + 1)}`;
    },

    /**
     * The file on this server's disk for /lib/<name>@<version>/<rel>, or null (unknown library or version, a file the
     * package doesn't have, a type we don't serve, or a script while scripts are off).
     */
    async file(name, version, rel) {
      const l = find(name);
      if (!l || l.version !== version || !l.fileSet.has(rel)) return null;
      const mime = LIB_MIME[path.posix.extname(rel).toLowerCase()];
      if (!mime || (isScript(rel) && !allowScripts())) return null;
      const dir = await unpacked(l);
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) return null;
      return { path: abs, mime };
    },

    // ───────── the registry, for the admin ─────────

    async search(q) {
      const text = String(q ?? '')
        .trim()
        .slice(0, 100);
      if (!text) return [];
      const r = await registryGet(
        `${registry()}/-/v1/search?text=${encodeURIComponent(text)}&size=20`,
      );
      return (r?.objects ?? []).map((o) => ({
        name: o.package.name,
        version: o.package.version,
        description: String(o.package.description ?? '').slice(0, 300),
        homepage: o.package.links?.homepage ?? o.package.links?.npm ?? '',
        installed: find(o.package.name)?.version ?? null,
      }));
    },

    async versions(name) {
      const p = await packument(name);
      const all = Object.keys(p.versions ?? {});
      return {
        name,
        tags: p['dist-tags'] ?? {},
        versions: all.slice(-60).reverse(),
        installed: find(name)?.version ?? null,
      };
    },

    /**
     * Install (or change the version of) a package. `integrity`, when given, must equal what the registry publishes for
     * that version — an imported list uses this so another installation gets byte-for-byte the same package.
     * @param {{name: string, version?: string, integrity?: string, autoload?: boolean, include?: string[]}} opts
     */
    async install(
      { name, version = 'latest', integrity: expected, autoload, include },
      actor = null,
    ) {
      checkName(name);
      if (!VERSION_OR_TAG.test(version))
        throw new HttpError(
          422,
          'invalid_input',
          'That isn’t a version or tag, like 6.5.2 or latest.',
          { field: 'version' },
        );
      const p = await packument(name);
      const resolved = p['dist-tags']?.[version] ?? version;
      const meta = p.versions?.[resolved];
      if (!meta?.dist?.tarball)
        throw new HttpError(404, 'not_found', `${name} has no version or tag "${version}".`, {
          field: 'version',
        });
      const sri =
        meta.dist.integrity ??
        (meta.dist.shasum
          ? `sha1-${Buffer.from(meta.dist.shasum, 'hex').toString('base64')}`
          : null);
      if (!sri)
        throw new HttpError(
          422,
          'no_integrity',
          `${name}@${resolved} is published without a hash, so it can't be checked.`,
        );
      if (expected && expected !== sri)
        throw new HttpError(
          409,
          'integrity_mismatch',
          `${name}@${resolved} on this registry is not the package that was exported (its hash differs). Nothing was installed.`,
        );
      const buf = await registryGet(meta.dist.tarball, {
        accept: 'application/octet-stream',
        binary: true,
      });
      if (!buf)
        throw new HttpError(
          502,
          'registry_error',
          `The registry has no file for ${name}@${resolved}.`,
        );
      if (!verifyIntegrity(buf, sri))
        throw new HttpError(
          502,
          'integrity',
          `The download of ${name}@${resolved} doesn't match its published hash. Nothing was installed.`,
        );
      let files;
      try {
        files = readTarball(buf, { maxBytes: maxBytes(), maxFiles: MAX_FILES });
      } catch (e) {
        if (e instanceof TarballError) throw new HttpError(422, 'invalid_package', e.message);
        throw e;
      }
      let pkg = {};
      try {
        pkg = JSON.parse(files.get('package.json')?.toString('utf8') ?? '{}');
      } catch {
        /* a broken package.json only costs the description */
      }
      const fileList = /** @type {[string, number][]} */ (
        [...files].map(([f, b]) => [f, b.length])
      ).sort((a, b) => a[0].localeCompare(b[0]));
      const shape = { name, fileSet: new Map(fileList) };
      const before = find(name);
      // Reinstalling keeps what was chosen, minus files the new version doesn't have.
      const chosen =
        include ??
        (before ? before.include.filter((f) => files.has(f)) : suggest({ ...pkg, name }, files));
      const finalInclude = checkInclude(
        shape,
        chosen.filter((f) => allowScripts() || !isScript(f)),
      );
      const t = now();
      const row = {
        version: resolved,
        integrity: sri,
        tarball: buf.toString('base64'),
        size: buf.length,
        unpacked_size: fileList.reduce((n, [, s]) => n + s, 0),
        files: JSON.stringify(fileList),
        include: JSON.stringify(finalInclude),
        autoload: autoload ?? before?.autoload ?? false,
        description: String(pkg.description ?? '').slice(0, 400),
        license: String(
          typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? ''),
        ).slice(0, 100),
        homepage: String(typeof pkg.homepage === 'string' ? pkg.homepage : '').slice(0, 500),
        updated_at: t,
      };
      await db.transaction(async (trx) => {
        if (before) await trx('libraries').where({ name }).update(row);
        else {
          const last = await trx('libraries').max({ m: 'position' }).first();
          await trx('libraries').insert({
            ...row,
            name,
            position: Number(last?.m ?? -1) + 1,
            installed_by: actor?.id ?? null,
            installed_at: t,
          });
        }
        await audit.log(
          {
            actor,
            action: 'library.install',
            entity: 'library',
            entityId: name,
            meta: { version: resolved, previous: before?.version ?? null, files: fileList.length },
          },
          trx,
        );
      });
      await changed();
      return svc.get(name);
    },

    /** What to load on every page, whether to, and the order among libraries. */
    async update(name, body, actor = null) {
      const l = need(name);
      const b = parse(
        z.object({
          include: z.array(z.string().max(300)).max(50).optional(),
          autoload: z.boolean().optional(),
          position: z.number().int().min(0).max(10_000).optional(),
        }),
        body,
      );
      const patch = { updated_at: now() };
      if (b.include) patch.include = JSON.stringify(checkInclude(l, b.include));
      if (b.autoload !== undefined) patch.autoload = b.autoload;
      if (b.position !== undefined) patch.position = b.position;
      await db('libraries').where({ name }).update(patch);
      await audit.log({
        actor,
        action: 'library.update',
        entity: 'library',
        entityId: name,
        meta: b,
      });
      await changed();
      return svc.get(name);
    },

    async remove(name, actor = null) {
      need(name);
      await db('libraries').where({ name }).del();
      await audit.log({ actor, action: 'library.delete', entity: 'library', entityId: name });
      await changed();
    },

    /** The list, to install the same packages on another installation (System → Libraries → Import list). */
    exportList() {
      return {
        format: 'cms-libraries',
        version: 1,
        exportedAt: new Date().toISOString(),
        libraries: libs.map((l) => ({
          name: l.name,
          version: l.version,
          integrity: l.integrity,
          include: l.include,
          autoload: l.autoload,
          position: l.position,
        })),
      };
    },

    /**
     * Install every package of an exported list, one after the other, each checked against its exported hash. Adds and
     * updates; never removes a library that isn't in the list. One failure doesn't stop the rest.
     */
    async importList(doc, actor = null) {
      const list = parse(importSchema, doc);
      const installed = [];
      const failed = [];
      for (const item of list.libraries) {
        try {
          const include = item.include.filter((f) => allowScripts() || !isScript(f));
          const lib = await svc.install(
            {
              name: item.name,
              version: item.version,
              integrity: item.integrity,
              autoload: item.autoload,
              include: [],
            },
            actor,
          );
          const known = new Set(lib.files.map((f) => f.path));
          await svc.update(
            item.name,
            {
              include: include.filter((f) => known.has(f)),
              ...(item.position !== undefined ? { position: item.position } : {}),
            },
            actor,
          );
          installed.push({
            name: item.name,
            version: lib.version,
            ...(include.length < item.include.length
              ? { note: 'Scripts were skipped: library scripts are off.' }
              : {}),
          });
        } catch (e) {
          failed.push({ name: item.name, version: item.version, error: e.message });
        }
      }
      return { installed, failed };
    },
  };
  /** Files downloaded from a CDN once and served by the site itself (docs/DECISIONS.md D-076). */
  svc.mirrors = createMirror({ db, audit, settings, fetchImpl, libraries: svc, lookup });
  return svc;
}

/** The `libraries` settings namespace. */
export function defineLibrariesSettings(registry) {
  registry.define('libraries', {
    title: 'Libraries',
    description: 'Where System → Libraries downloads npm packages from, and what they may contain.',
    order: 28,
    fields: {
      registry_url: {
        type: 'string',
        label: 'Registry address',
        default: 'https://registry.npmjs.org',
        format: 'url',
        required: true,
        help: 'The npm registry, or a mirror your servers can reach.',
      },
      max_package_mb: {
        type: 'number',
        label: 'Largest package (MB, unpacked)',
        default: 50,
        min: 1,
        max: 200,
      },
      allow_scripts: {
        type: 'boolean',
        label: 'Let libraries add JavaScript to the site',
        default: false,
        help: 'A library script runs in your visitors’ browsers, on the same address as the admin. Only turn this on for packages you would trust with your own admin session.',
      },
    },
  });
}
