import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';

const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES_PER_ADDRESS = 40; // a stylesheet and the fonts/imports it pulls in
const MAX_CSS_DEPTH = 2;
const MAX_REDIRECTS = 3;
// A current desktop browser: font CDNs (Google Fonts) answer with modern .woff2 only to one.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** What may be downloaded: things a page loads, never something that could be a page itself. */
const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};
/** @type {[RegExp, string][]} */
const BY_CONTENT_TYPE = [
  [/^text\/css/i, '.css'],
  [/^(text|application)\/(x-)?(java|ecma)script/i, '.js'],
  [/^(font\/woff2|application\/(x-)?font-woff2)/i, '.woff2'],
  [/^(font\/woff|application\/(x-)?font-woff)/i, '.woff'],
  [/^(font\/(ttf|sfnt|truetype)|application\/(x-)?(font-)?(ttf|truetype))/i, '.ttf'],
  [/^(font\/(otf|opentype)|application\/(x-)?font-otf)/i, '.otf'],
  [/^application\/vnd\.ms-fontobject/i, '.eot'],
  [/^image\/svg/i, '.svg'],
  [/^image\/png/i, '.png'],
  [/^image\/jpe?g/i, '.jpg'],
  [/^image\/gif/i, '.gif'],
  [/^image\/webp/i, '.webp'],
  [/^image\/avif/i, '.avif'],
];
const isScriptExt = (e) => e === '.js' || e === '.mjs';
const FONT_EXTS = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot']);

// Addresses an administrator-triggered download must never reach: this server's own network. The person who asks for a
// URL may not be the person who wrote it (a page can carry text that asks the assistant to fetch something).
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  // An IPv4 address written as IPv6 reaches the same machine, in dotted form or (as URL parsing normalises it) in hex.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (dotted) return isPrivateIp(dotted[1]);
  const hexed = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (hexed) {
    const hi = parseInt(hexed[1], 16);
    const lo = parseInt(hexed[2], 16);
    return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

const hex = (s, n = 64) => createHash('sha256').update(s).digest('hex').slice(0, n);
const safeName = (s) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'file';

/**
 * Downloaded copies of files from a CDN, served at `/lib/_cdn/<id>/<file>`.
 *
 * An address on jsdelivr/unpkg that names an npm package is installed from npm instead (a hashed, versioned package in
 * System → Libraries); anything else is fetched once, checked, and stored. A stylesheet is rewritten so the fonts and
 * stylesheets it names are downloaded too and point at the site itself.
 * @param {{db: any, audit: any, settings: any, fetchImpl: typeof fetch, libraries: any, lookup?: (host: string) => Promise<{address: string}[]>}} deps
 */
export function createMirror({ db, audit, settings, fetchImpl, libraries, lookup }) {
  const resolveHost = lookup ?? ((host) => dns.lookup(host, { all: true }));
  /** Immutable files are small and requested often: a few stay in memory. */
  const hot = new Map();
  const remember = (rel, v) => {
    hot.set(rel, v);
    if (hot.size > 40) hot.delete(hot.keys().next().value);
  };
  const allowScripts = () => !!settings.get('libraries.allow_scripts');
  const localOf = (rel) => `/lib/${rel}`;
  const fail = (m, status = 422) => new HttpError(status, 'mirror_failed', m);

  async function assertPublic(u) {
    if (u.protocol !== 'https:') throw fail('Only https:// addresses can be downloaded.');
    if (u.username || u.password)
      throw fail('An address with a password in it cannot be downloaded.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host)
      ? [{ address: host }]
      : await resolveHost(host).catch(() => {
          throw fail(
            `Could not find "${host}". This server needs internet access to download it.`,
            502,
          );
        });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
      throw fail('That address points at a private network, so it cannot be downloaded.');
  }

  /** @returns {Promise<{buf: Buffer, type: string, finalUrl: string}>} */
  async function download(url) {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublic(current);
      let res;
      try {
        res = await fetchImpl(current, {
          headers: { 'user-agent': BROWSER_UA, accept: '*/*' },
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        throw fail(
          `Could not download ${current.hostname} (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message}). This server needs internet access for this one step.`,
          502,
        );
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current);
        continue;
      }
      if (!res.ok) throw fail(`${current.hostname} answered ${res.status} for that file.`, 502);
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > MAX_FILE) throw fail('That file is larger than 5 MB.');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FILE) throw fail('That file is larger than 5 MB.');
      return { buf, type: res.headers.get('content-type') || '', finalUrl: current.toString() };
    }
    throw fail('That address redirects too many times.');
  }

  function extensionFor(u, contentType) {
    const ext = path.posix.extname(u.pathname).toLowerCase();
    if (TYPES[ext]) return ext;
    return BY_CONTENT_TYPE.find(([re]) => re.test(contentType))?.[1] ?? null;
  }

  async function store({ urlHash, url, rel, mime, buf, actor }) {
    try {
      await db('library_mirrors').insert({
        url_hash: urlHash,
        url: url.slice(0, 4000),
        path: rel,
        mime,
        size: buf.length,
        body: buf.toString('base64'),
        created_by: actor?.id ?? null,
        created_at: now(),
      });
      await audit.log({
        actor,
        action: 'library.mirror',
        entity: 'library_mirror',
        entityId: rel,
        meta: { size: buf.length },
      });
    } catch (e) {
      // Another server (or request) stored the same address first: use theirs.
      if (!(await db('library_mirrors').where({ url_hash: urlHash }).first())) throw e;
    }
    return db('library_mirrors').where({ url_hash: urlHash }).first();
  }

  const view = (r) => ({
    id: Number(r.id),
    url: r.url,
    path: r.path,
    localUrl: localOf(r.path),
    mime: r.mime,
    size: Number(r.size),
    createdAt: Number(r.created_at),
  });

  // jsdelivr and unpkg serve npm packages: take those from npm itself, where the package is hash-checked and versioned.
  function npmPartsOf(u) {
    let m = null;
    if (u.hostname === 'cdn.jsdelivr.net')
      m = /^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/.exec(u.pathname);
    else if (u.hostname === 'unpkg.com')
      m = /^\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/.exec(u.pathname);
    return m
      ? { name: decodeURIComponent(m[1]), version: m[2], file: decodeURIComponent(m[3]) }
      : null;
  }

  async function viaNpm(u, actor) {
    const p = npmPartsOf(u);
    if (!p || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(p.version)) return null;
    try {
      const lib = await libraries.install({ name: p.name, version: p.version }, actor);
      const full = libraries.get(lib.name);
      if (!full.files.some((f) => f.path === p.file)) return null;
      return {
        url: `/lib/${lib.name}@${lib.version}/${p.file}`,
        via: 'npm',
        note:
          isScriptExt(path.posix.extname(p.file)) && !allowScripts()
            ? 'It is a script, and library scripts are off (Settings → Libraries).'
            : undefined,
      };
    } catch {
      return null; // not on the registry, or it cannot be reached: fall back to downloading the file itself
    }
  }

  const svc = {
    /**
     * Make one remote file local. Returns the address to use instead.
     * @returns {Promise<{url: string, via: string, note?: string, failed?: {url: string, reason: string}[]}>}
     */
    mirror: (url, actor) => run(url, actor, { files: 0, failed: [] }, 0),

    /** A font embedded in a page as `data:font/…;base64,…`, stored as a real file (the policy blocks data: fonts). */
    async mirrorData(dataUrl, actor) {
      const m = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
      const ext = m && BY_CONTENT_TYPE.find(([re]) => re.test(m[1]))?.[1];
      if (!ext || !FONT_EXTS.has(ext)) throw fail('Only embedded fonts can be turned into files.');
      const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      if (!buf.length || buf.length > MAX_FILE)
        throw fail('That embedded font is empty or larger than 5 MB.');
      const urlHash = hex(buf);
      const have = await db('library_mirrors').where({ url_hash: urlHash }).first();
      if (have) return { url: localOf(have.path), via: 'cached' };
      const row = await store({
        urlHash,
        url: `embedded font (${buf.length} bytes)`,
        rel: `_cdn/${urlHash.slice(0, 12)}/font-${urlHash.slice(12, 20)}${ext}`,
        mime: TYPES[ext],
        buf,
        actor,
      });
      return { url: localOf(row.path), via: 'download' };
    },

    async list() {
      return (
        await db('library_mirrors')
          .orderBy('id', 'desc')
          .select('id', 'url', 'path', 'mime', 'size', 'created_at')
      ).map(view);
    },

    async remove(id, actor) {
      const r = await db('library_mirrors').where({ id }).first();
      if (!r) throw notFound('That file');
      await db('library_mirrors').where({ id }).delete();
      hot.delete(r.path);
      await audit.log({
        actor,
        action: 'library.mirror_removed',
        entity: 'library_mirror',
        entityId: r.path,
      });
    },

    /** For the public route: the stored bytes of `_cdn/<id>/<file>`, or null (also null for a script while scripts are off). */
    async file(rel) {
      if (!/^_cdn\/[0-9a-f]{12}\/[A-Za-z0-9._-]+$/.test(rel)) return null;
      let v = hot.get(rel);
      if (!v) {
        const r = await db('library_mirrors').where({ path: rel }).first();
        if (!r) return null;
        v = { buf: Buffer.from(r.body, 'base64'), mime: r.mime };
        remember(rel, v);
      }
      if (v.mime.startsWith('text/javascript') && !allowScripts()) return null;
      return v;
    },
  };

  /**
   * @returns {Promise<{url: string, via: string, note?: string, failed?: {url: string, reason: string}[]}>}
   */
  async function run(url, actor, state, depth) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw fail('That is not a web address.');
    }
    const urlHash = hex(u.toString());
    const have = await db('library_mirrors').where({ url_hash: urlHash }).first();
    if (have) return { url: localOf(have.path), via: 'cached' };
    const npm = depth === 0 ? await viaNpm(u, actor) : null;
    if (npm) return npm;
    if (++state.files > MAX_FILES_PER_ADDRESS)
      throw fail('That stylesheet pulls in too many files.');

    const { buf: raw, type, finalUrl } = await download(u.toString());
    const ext = extensionFor(new URL(finalUrl), type);
    if (!ext)
      throw fail(
        "That kind of file can't be served by the site (only stylesheets, scripts, fonts and images).",
      );
    let buf = raw;
    const failed = state.failed;
    if (ext === '.css' && depth < MAX_CSS_DEPTH) {
      // Fonts and imported stylesheets named inside it are downloaded too, and the stylesheet is pointed at them.
      let css = raw.toString('utf8');
      const refs = new Set();
      for (const m of css.matchAll(
        /url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/gi,
      )) {
        const ref = (m[2] ?? m[4] ?? '').trim();
        if (ref && !/^(data:|#|\/lib\/|about:)/i.test(ref)) refs.add(ref);
      }
      for (const ref of refs) {
        let abs;
        try {
          abs = new URL(ref, finalUrl).toString();
        } catch {
          continue;
        }
        try {
          const sub = await run(abs, actor, state, depth + 1);
          css = css.split(ref).join(sub.url);
        } catch (e) {
          failed.push({ url: abs.slice(0, 120), reason: e.message });
        }
      }
      buf = Buffer.from(css, 'utf8');
    }
    const base = safeName(path.posix.basename(new URL(finalUrl).pathname) || 'file');
    const name = path.posix.extname(base).toLowerCase() === ext ? base : `${base}${ext}`;
    const rel = `_cdn/${hex(u.toString(), 12)}/${name}`;
    const row = await store({ urlHash, url: u.toString(), rel, mime: TYPES[ext], buf, actor });
    return {
      url: localOf(row.path),
      via: 'download',
      ...(isScriptExt(ext) && !allowScripts()
        ? { note: 'It is a script, and library scripts are off (Settings → Libraries).' }
        : {}),
      ...(failed.length && depth === 0 ? { failed } : {}),
    };
  }

  return svc;
}
