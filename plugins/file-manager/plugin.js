import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * File Manager — a worked example of how much a plugin can do (docs/DECISIONS.md D-060/D-061): its own backend
 * routes, admin screen, permissions, settings and audit trail, with no change to core.
 *
 * It edits two places, and they are NOT the same kind of thing:
 *   - `public`  — the site tree. The database is the truth and public/ is a derived mirror (D-035), so writes go
 *                 through `ctx.siteFiles` (validated, versioned, cluster-wide) and never touch the disk directly.
 *   - `plugins` — every plugin's source (PLUGINS_DIR). Plain files on THIS server's disk.
 * On a cluster, `plugins` edits reach only the server that took the request; the screen says so.
 * The shipped `site/` folder (starter site, built-in themes, wording) is deliberately NOT reachable from here: it is
 * code, changed through git and a deploy (D-043, D-121).
 *
 * Everything runs as the signed-in user's own permissions (`file_manager.view | edit | delete`).
 * Deleting is the one dangerous action, so it is validated on the server, not just in the screen: the exact name
 * must be typed back, a folder with contents needs an explicit "recursive", and protected paths are refused.
 */

const DENY = new Set(['node_modules', '.git']); // never listed, searched, read or written
const SKIP_NAMES = new Set(['.DS_Store']);
const MAX_SEARCH_FILE = 1024 * 1024; // larger files are skipped by content search
const MAX_SCAN_FILES = 30000;
const SEARCH_BUDGET_MS = 8000;
const sha = (s) => createHash('sha1').update(s).digest('hex');

export default async function (ctx) {
  const { Router } = ctx.require('express');
  const r = Router();
  const cfg = () => ctx.settings.ns('plugin_file_manager');

  // ───────── errors ─────────
  const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
  const bad = (m) => fail(422, 'invalid_request', m);

  // ───────── roots ─────────
  const ROOTS = {
    public: {
      id: 'public',
      label: 'public',
      kind: 'tree',
      note: 'The site tree (pages, components, wording). Saved to the database and shared by every server.',
    },
    plugins: {
      id: 'plugins',
      label: 'plugins',
      kind: 'disk',
      dir: path.resolve(ctx.env.PLUGINS_DIR),
      note: 'Plugin source. Edits change this server only; a changed plugin runs new code after it is disabled and enabled again in Plugin Manager.',
    },
  };
  const rootOf = (id) => {
    const root = ROOTS[id];
    if (!root) throw bad('Choose one of: public, plugins.');
    return root;
  };

  /** A relative path → clean segments. Rejects anything that could leave the root. '' is the root itself. */
  function segsOf(rel) {
    if (rel == null || rel === '') return [];
    if (typeof rel !== 'string' || rel.length > 1000) throw bad('That path is not valid.');
    if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/'))
      throw bad('Use forward slashes and a path relative to the folder, like "pages/index.html".');
    const segs = rel.split('/').filter((s) => s && s !== '.');
    if (segs.some((s) => s === '..')) throw bad('A path can’t contain "..".');
    if (segs.some((s) => DENY.has(s))) throw bad('node_modules and .git are off limits here.');
    return segs;
  }

  const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);

  /** The absolute disk path, after checking no symlink on the way leads outside the root. */
  async function absOf(root, segs) {
    const abs = path.join(root.dir, ...segs);
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const realRoot = await fs.realpath(root.dir).catch(() => root.dir);
        if (!within(realRoot, real)) throw bad('That path leads outside the folder.');
        break;
      } catch (e) {
        if (e.status) throw e;
        const up = path.dirname(probe);
        if (up === probe || !within(root.dir, up)) break;
        probe = up;
      }
    }
    return abs;
  }

  const lstatOrNull = (p) => fs.lstat(p).catch(() => null);

  /** Is the file text? No NUL byte in the first 8 KB is the usual, cheap answer. */
  const isText = (buf) => !buf.subarray(0, 8000).includes(0);

  const actorOf = (req) => ({ id: req.user?.id ?? null, email: req.user?.email ?? null, ip: req.ip });
  const note = (req, action, root, rel, meta = {}) =>
    ctx.audit.log({
      actor: actorOf(req),
      action: `file_manager.${action}`,
      entity: 'file',
      entityId: `${root}:${rel}`.slice(0, 190),
      meta,
    });

  const need = (perm) => (req, res, next) => {
    if (req.user?.can(perm)) return next();
    res
      .status(403)
      .json({ error: { code: 'forbidden', message: `You need the "${perm}" permission to do that.` } });
  };

  // ───────── the public tree (via ctx.siteFiles) ─────────
  const tree = () => ctx.siteFiles.snapshot().files; // Map<path, {content,size,hash,updatedAt}>

  function treeList(segs) {
    const prefix = segs.length ? segs.join('/') + '/' : '';
    const dirs = new Map();
    const files = [];
    for (const [p, f] of tree()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push({ name: rest, type: 'file', size: f.size, mtime: f.updatedAt });
      else {
        const d = rest.slice(0, slash);
        const cur = dirs.get(d) ?? { name: d, type: 'dir', size: 0, mtime: 0 };
        cur.size += 1; // for a folder, "size" is its file count
        cur.mtime = Math.max(cur.mtime, f.updatedAt ?? 0);
        dirs.set(d, cur);
      }
    }
    return [...dirs.values(), ...files];
  }

  /** Every file path at or under `segs`, for the tree. */
  function treeFilesUnder(segs) {
    const p = segs.join('/');
    return [...tree().keys()].filter((k) => k === p || k.startsWith(p + '/'));
  }

  // ───────── disk walking (delete preview, search) ─────────
  async function* walk(dir, rel = '') {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (DENY.has(e.name) || SKIP_NAMES.has(e.name) || e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) yield* walk(path.join(dir, e.name), childRel);
      else if (e.isFile()) yield { rel: childRel, abs: path.join(dir, e.name) };
    }
  }

  // ───────── protected paths (delete / rename) ─────────
  function protectedReason(rootId, segs) {
    if (!segs.length) return 'That is the top folder itself.';
    if (rootId === 'public' && segs.length === 1)
      return `"${segs[0]}" is one of the site tree’s main folders. Delete the files inside it instead.`;
    if (rootId === 'plugins') {
      const slug = segs[0];
      if (slug === 'file-manager')
        return 'File Manager can’t delete or move itself — uninstall it in Plugin Manager if you really want it gone.';
      const known = ctx.plugins.list().find((p) => p.slug === slug);
      if (segs.length === 1 && known)
        return `"${slug}" is an installed plugin. Use Plugin Manager → Uninstall so its data and menu entry are cleaned up too.`;
      if (known?.enabled && segs.length === 2 && ['plugin.json', 'plugin.js'].includes(segs[1]))
        return `"${slug}" is enabled and needs ${segs[1]} to run. Disable the plugin in Plugin Manager first.`;
    }
    return null;
  }

  // ───────── routes ─────────

  r.get('/roots', need('file_manager.view'), (req, res) => {
    res.json({
      roots: Object.values(ROOTS).map(({ id, label, kind, note: n }) => ({ id, label, kind, note: n })),
      can: { edit: !!req.user.can('file_manager.edit'), delete: !!req.user.can('file_manager.delete') },
      maxEditKb: Number(cfg().max_edit_kb) || 512,
    });
  });

  r.get('/list', need('file_manager.view'), async (req, res) => {
    const root = rootOf(req.query.root);
    const segs = segsOf(req.query.path);
    let entries;
    if (root.kind === 'tree') entries = treeList(segs);
    else {
      const abs = await absOf(root, segs);
      let dirents;
      try {
        dirents = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        throw fail(404, 'not_found', 'That folder doesn’t exist.');
      }
      entries = [];
      for (const e of dirents) {
        if (DENY.has(e.name) || SKIP_NAMES.has(e.name)) continue;
        const st = await lstatOrNull(path.join(abs, e.name));
        if (!st) continue;
        entries.push({
          name: e.name,
          type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file',
          size: st.isDirectory() ? null : st.size,
          mtime: Math.round(st.mtimeMs),
        });
      }
    }
    entries.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
    res.json({ root: root.id, path: segs.join('/'), entries });
  });

  r.get('/file', need('file_manager.view'), async (req, res) => {
    const root = rootOf(req.query.root);
    const segs = segsOf(req.query.path);
    if (!segs.length) throw bad('Choose a file.');
    const limit = (Number(cfg().max_edit_kb) || 512) * 1024;
    const rel = segs.join('/');
    if (root.kind === 'tree') {
      const f = tree().get(rel);
      if (!f) throw fail(404, 'not_found', 'That file doesn’t exist.');
      return res.json({ path: rel, content: f.content, size: f.size, hash: f.hash, mtime: f.updatedAt });
    }
    const abs = await absOf(root, segs);
    const st = await lstatOrNull(abs);
    if (!st || st.isDirectory()) throw fail(404, 'not_found', 'That file doesn’t exist.');
    if (st.isSymbolicLink()) throw bad('That is a link, not a file. Open the file it points to instead.');
    if (st.size > limit)
      throw fail(
        413,
        'too_large',
        `That file is ${Math.round(st.size / 1024)} KB; the editor opens up to ${Math.round(limit / 1024)} KB. Raise "Largest editable file" in the plugin’s settings, or use search to find what you need.`,
      );
    const buf = await fs.readFile(abs);
    if (!isText(buf)) throw fail(415, 'binary', 'That looks like a binary file (an image, font or archive), so it can’t be edited as text.');
    const content = buf.toString('utf8');
    res.json({ path: rel, content, size: st.size, hash: sha(content), mtime: Math.round(st.mtimeMs) });
  });

  function checkContent(rel, content) {
    if (typeof content !== 'string') throw bad('Send the file’s text as "content".');
    const limit = (Number(cfg().max_edit_kb) || 512) * 1024;
    if (Buffer.byteLength(content) > limit)
      throw fail(413, 'too_large', `The file is over the ${Math.round(limit / 1024)} KB editing limit.`);
    if (rel.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (e) {
        throw bad(`${path.posix.basename(rel)} isn’t valid JSON (${String(e.message).slice(0, 100)}). Fix it and save again.`);
      }
    }
  }

  const pluginHint = (rootId) =>
    rootId === 'plugins'
      ? 'Saved. A running plugin picks up the change when you disable and enable it in Plugin Manager.'
      : 'Saved.';

  r.put('/file', need('file_manager.edit'), async (req, res) => {
    const { root: rootId, path: rel0, content, expectedHash } = req.body ?? {};
    const root = rootOf(rootId);
    const segs = segsOf(rel0);
    if (!segs.length) throw bad('Choose a file.');
    const rel = segs.join('/');
    checkContent(rel, content);
    if (root.kind === 'tree') {
      if (!tree().has(rel)) throw fail(404, 'not_found', 'That file doesn’t exist. Use New file to create it.');
      const out = await ctx.siteFiles.put(rel, content, actorOf(req), expectedHash || undefined);
      await note(req, 'write', root.id, rel, { bytes: Buffer.byteLength(content) });
      return res.json({ ok: true, hash: out.hash, message: pluginHint('public') });
    }
    const abs = await absOf(root, segs);
    const st = await lstatOrNull(abs);
    if (!st || !st.isFile()) throw fail(404, 'not_found', 'That file doesn’t exist. Use New file to create it.');
    if (expectedHash) {
      const now = sha(await fs.readFile(abs, 'utf8'));
      if (now !== expectedHash)
        throw fail(409, 'conflict', 'This file changed on disk after you opened it. Reload it to see the newer version, then re-apply your edit.');
    }
    await writeAtomic(abs, content);
    await note(req, 'write', root.id, rel, { bytes: Buffer.byteLength(content) });
    res.json({ ok: true, hash: sha(content), message: pluginHint(root.id) });
  });

  async function writeAtomic(abs, content) {
    const tmp = `${abs}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, abs);
  }

  r.post('/create', need('file_manager.edit'), async (req, res) => {
    const { root: rootId, path: rel0, type = 'file', content = '' } = req.body ?? {};
    const root = rootOf(rootId);
    const segs = segsOf(rel0);
    if (!segs.length) throw bad('Enter a name for the new item.');
    if (segs.some((s) => s.length > 120 || /[<>:"|?*]/.test(s) || [...s].some((c) => c.charCodeAt(0) < 32)))
      throw bad('Names can’t contain < > : " | ? * or control characters.');
    const rel = segs.join('/');
    if (!['file', 'dir'].includes(type)) throw bad('Type must be "file" or "dir".');
    if (root.kind === 'tree') {
      if (type === 'dir')
        throw bad('A folder in the site tree exists only while it holds files — create a file inside the folder instead (for example "components/mine/card.html").');
      checkContent(rel, content);
      if (tree().has(rel)) throw fail(409, 'exists', 'A file with that name already exists.');
      await ctx.siteFiles.put(rel, content, actorOf(req));
      await note(req, 'create', root.id, rel);
      return res.status(201).json({ ok: true, path: rel });
    }
    const abs = await absOf(root, segs);
    if (await lstatOrNull(abs)) throw fail(409, 'exists', 'Something with that name already exists.');
    if (type === 'dir') await fs.mkdir(abs, { recursive: true });
    else {
      checkContent(rel, content);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, { flag: 'wx' });
    }
    await note(req, 'create', root.id, rel, { type });
    res.status(201).json({ ok: true, path: rel });
  });

  r.post('/rename', need('file_manager.edit'), async (req, res) => {
    const { root: rootId, from, to } = req.body ?? {};
    const root = rootOf(rootId);
    const a = segsOf(from);
    const b = segsOf(to);
    if (!a.length || !b.length) throw bad('Give both the current and the new path.');
    const why = protectedReason(root.id, a);
    if (why) throw fail(409, 'protected', why);
    const fromRel = a.join('/');
    const toRel = b.join('/');
    if (toRel === fromRel || toRel.startsWith(fromRel + '/')) throw bad('Choose a different destination.');
    if (root.kind === 'tree') {
      const srcs = treeFilesUnder(a);
      if (!srcs.length) throw fail(404, 'not_found', 'That doesn’t exist.');
      const writes = srcs.map((p) => ({ path: toRel + p.slice(fromRel.length), content: tree().get(p).content }));
      if (writes.some((w) => tree().has(w.path))) throw fail(409, 'exists', 'Something already exists at the destination.');
      await ctx.siteFiles.apply({ writes, deletes: srcs }, actorOf(req));
    } else {
      const absFrom = await absOf(root, a);
      const absTo = await absOf(root, b);
      if (!(await lstatOrNull(absFrom))) throw fail(404, 'not_found', 'That doesn’t exist.');
      // On a case-insensitive disk (macOS default) "readme.md" → "README.md" finds the file itself at the destination:
      // that is the same file (same device + inode), so it's a rename, not a collision.
      const there = await lstatOrNull(absTo);
      const src = await lstatOrNull(absFrom);
      if (there && !(there.ino === src.ino && there.dev === src.dev))
        throw fail(409, 'exists', 'Something already exists at the destination.');
      await fs.mkdir(path.dirname(absTo), { recursive: true });
      await fs.rename(absFrom, absTo);
    }
    await note(req, 'rename', root.id, fromRel, { to: toRel });
    res.json({ ok: true, path: toRel });
  });

  // What a delete would remove, and whether it is allowed — the screen shows this before asking for confirmation,
  // and /delete re-checks all of it (the screen is never the only gate).
  async function inspect(rootId, rel0) {
    const root = rootOf(rootId);
    const segs = segsOf(rel0);
    const rel = segs.join('/');
    const blocked = protectedReason(root.id, segs);
    let kind;
    let files = 0;
    let bytes = 0;
    if (root.kind === 'tree') {
      const under = treeFilesUnder(segs);
      if (!under.length) throw fail(404, 'not_found', 'That doesn’t exist.');
      kind = tree().has(rel) ? 'file' : 'dir';
      files = under.length;
      for (const p of under) bytes += tree().get(p).size ?? 0;
    } else {
      const abs = await absOf(root, segs);
      const st = await lstatOrNull(abs);
      if (!st) throw fail(404, 'not_found', 'That doesn’t exist.');
      if (st.isDirectory()) {
        kind = 'dir';
        for await (const f of walk(abs)) {
          files += 1;
          bytes += (await lstatOrNull(f.abs))?.size ?? 0;
        }
      } else {
        kind = st.isSymbolicLink() ? 'link' : 'file';
        files = 1;
        bytes = st.size;
      }
    }
    return {
      root: root.id,
      path: rel,
      name: segs[segs.length - 1] ?? '',
      kind,
      files,
      bytes,
      needsRecursive: kind === 'dir' && files > 0,
      blockedReason: blocked,
    };
  }

  r.post('/delete-preview', need('file_manager.delete'), async (req, res) => {
    res.json(await inspect(req.body?.root, req.body?.path));
  });

  r.post('/delete', need('file_manager.delete'), async (req, res) => {
    const { root: rootId, path: rel, confirm, recursive } = req.body ?? {};
    const info = await inspect(rootId, rel);
    if (info.blockedReason) throw fail(409, 'protected', info.blockedReason);
    if (confirm !== info.name)
      throw fail(422, 'confirm_mismatch', `Type the exact name "${info.name}" to confirm the delete.`);
    if (info.needsRecursive && recursive !== true)
      throw fail(
        422,
        'needs_recursive',
        `"${info.name}" is a folder with ${info.files} file${info.files === 1 ? '' : 's'} (${Math.max(1, Math.round(info.bytes / 1024))} KB) in it. Tick “delete everything inside” to remove it.`,
      );
    const root = rootOf(rootId);
    const segs = segsOf(rel);
    if (root.kind === 'tree') await ctx.siteFiles.apply({ deletes: treeFilesUnder(segs) }, actorOf(req));
    else await fs.rm(await absOf(root, segs), { recursive: true, force: false });
    await note(req, 'delete', root.id, info.path, { files: info.files, bytes: info.bytes });
    res.json({ ok: true, removed: info.files });
  });

  // ───────── file-wide search ─────────
  // Text matches inside files, or file names. Regex is optional; plain text is escaped. A regex run is cut off by
  // time and by line length, because an admin-typed pattern can otherwise hang a server with a catastrophic one.
  r.get('/search', need('file_manager.view'), async (req, res) => {
    const q = String(req.query.q ?? '');
    if (!q.trim()) throw bad('Type something to search for.');
    if (q.length > 200) throw bad('Search for 200 characters or fewer.');
    const mode = req.query.mode === 'name' ? 'name' : 'content';
    const useRegex = req.query.regex === '1';
    const caseSensitive = req.query.case === '1';
    const whole = req.query.word === '1';
    const scope = String(req.query.root || 'all');
    const roots = scope === 'all' ? Object.values(ROOTS) : [rootOf(scope)];
    const sub = segsOf(req.query.path).join('/');
    const only = String(req.query.glob || '').trim();
    const limit = Math.max(1, Math.min(2000, Number(cfg().max_search_results) || 500));

    let re;
    try {
      let src = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (whole) src = `\\b(?:${src})\\b`;
      re = new RegExp(src, caseSensitive ? 'g' : 'gi');
    } catch (e) {
      throw bad(`That isn’t a valid pattern (${String(e.message).slice(0, 80)}).`);
    }
    // "*.js, *.html" → a name filter
    const globs = only
      ? only.split(',').map((g) => g.trim()).filter(Boolean).map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'))
      : null;
    const nameOk = (rel) => !globs || globs.some((g) => g.test(path.posix.basename(rel)));

    const started = Date.now();
    const results = [];
    let scanned = 0;
    let truncated = null;

    const scanText = (rootId, rel, text) => {
      let lineNo = 0;
      for (const line of text.split('\n')) {
        lineNo += 1;
        if (line.length > 2000) continue;
        re.lastIndex = 0;
        const m = re.exec(line);
        if (!m) continue;
        const from = Math.max(0, m.index - 60);
        results.push({
          root: rootId,
          path: rel,
          line: lineNo,
          col: m.index + 1,
          text: (from ? '…' : '') + line.slice(from, m.index + m[0].length + 100).trimEnd(),
        });
        if (results.length >= limit) return (truncated = `Stopped at ${limit} results — narrow the search.`);
        if (Date.now() - started > SEARCH_BUDGET_MS)
          return (truncated = 'Stopped after 8 seconds — narrow the search or simplify the pattern.');
      }
      return null;
    };

    outer: for (const root of roots) {
      const candidates = [];
      if (root.kind === 'tree') {
        for (const [p, f] of tree()) if (scope === 'all' || !sub || p === sub || p.startsWith(sub + '/')) candidates.push({ rel: p, text: f.content });
      }
      const iter = root.kind === 'tree' ? candidates : walk(path.join(root.dir, ...(scope === 'all' ? [] : segsOf(sub))), scope === 'all' ? '' : sub);
      for await (const f of iter) {
        if (++scanned > MAX_SCAN_FILES) {
          truncated = `Stopped after looking at ${MAX_SCAN_FILES} files — narrow the search to a folder.`;
          break outer;
        }
        if (!nameOk(f.rel)) continue;
        if (mode === 'name') {
          re.lastIndex = 0;
          if (re.test(path.posix.basename(f.rel))) results.push({ root: root.id, path: f.rel, line: 0, col: 0, text: '' });
          if (results.length >= limit) {
            truncated = `Stopped at ${limit} results — narrow the search.`;
            break outer;
          }
          continue;
        }
        let text = f.text;
        if (text === undefined) {
          const st = await lstatOrNull(f.abs);
          if (!st || st.size > MAX_SEARCH_FILE) continue;
          const buf = await fs.readFile(f.abs);
          if (!isText(buf)) continue;
          text = buf.toString('utf8');
        }
        if (scanText(root.id, f.rel, text)) break outer;
      }
    }
    res.json({ results, scanned, truncated, tookMs: Date.now() - started });
  });

  // Our errors are plain Errors carrying a status; the app's handler would turn those into a bare 500 and hide the
  // message, so answer them here in the same { error: { code, message } } shape everything else uses.
  r.use((err, _req, res, next) => {
    if (!err?.status) return next(err);
    res.status(err.status).json({ error: { code: err.code ?? 'error', message: err.message } });
  });

  return r;
}
