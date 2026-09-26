import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import { SITE_DIRS, createEngine, Safe } from './sandbox.js';
import { SiteFormatError, compileComponent } from '../site/component.js';
import {
  ASSET_MIME,
  THEME_ID,
  checkThemeFile,
  checkThemeFiles,
  hashFiles,
  manifestSchema,
  readThemeZip,
  settingsFields,
} from './package.js';

const CHANNEL = 'themes:changed';
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const nsOf = (id) => `theme_${id}`;
const isTextPath = (p) => /\.(liquid|html|json|css|js|txt|md)$/i.test(p);

/**
 * Themes: the ones in the repository (themes/<id>/) and the ones installed from a zip (stored in the database, so every
 * server has them at once). One theme is active, chosen by the `site.theme` setting, which already reaches every server.
 *
 * Each theme's own settings (declared in its theme.json) become a settings namespace `theme_<id>`, so they are edited on
 * the ordinary Settings screen, versioned and audited like everything else.
 */
export function createThemesService({ env, db, settings, bus, audit, cache, log, appRoot }) {
  const themesDir = path.join(appRoot, 'site', 'themes'); // built-in themes ship with the code
  /** @type {Map<string, any>} id -> { id, name, version, description, author, source, hash, manifest } */
  let meta = new Map();
  /** @type {Map<string, any>} */
  const runtimes = new Map();
  let fingerprint = '';
  let timer = null;
  let chain = Promise.resolve();

  const limits = () => ({
    renderMs: settings.get('themes.render_ms'),
    memoryMb: settings.get('themes.render_memory_mb'),
  });

  async function readDisk() {
    const out = [];
    let dirs;
    try {
      dirs = await fs.readdir(themesDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of dirs.filter((x) => x.isDirectory())) {
      try {
        const files = await readTree(path.join(themesDir, d.name));
        const manifest = manifestSchema.parse(JSON.parse(files.get('theme.json').content));
        if (manifest.id !== d.name)
          throw new Error(`folder name and theme id differ (${d.name} / ${manifest.id})`);
        out.push({ manifest, files, hash: hashFiles(files) });
      } catch (e) {
        log.error(
          { theme: d.name, err: e.message },
          'themes: a built-in theme is invalid and was skipped',
        );
      }
    }
    return out;
  }

  async function readTree(root, rel = '', files = new Map()) {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await readTree(root, r, files);
      else if (e.isFile()) {
        const buf = await fs.readFile(path.join(root, r));
        files.set(
          r,
          isTextPath(r)
            ? { encoding: 'utf8', content: buf.toString('utf8') }
            : { encoding: 'base64', content: buf.toString('base64') },
        );
      }
    }
    return files;
  }

  const runtimeSetting = (m) => ({
    title: `Theme: ${m.name}`,
    description: `Settings for the ${m.name} theme, from its theme.json.`,
    order: 60,
    fields: settingsFields(m),
  });

  /** Re-read what is installed, define settings for any new theme, and drop what changed. */
  function refresh() {
    chain = chain.then(async () => {
      const next = new Map();
      for (const t of await readDisk())
        next.set(t.manifest.id, {
          ...t.manifest,
          source: 'disk',
          hash: t.hash,
          manifest: t.manifest,
          installedAt: null,
        });
      for (const r of await db('themes')) {
        const manifest = JSON.parse(r.manifest);
        next.set(r.id, {
          ...manifest,
          source: 'db',
          hash: r.content_hash,
          manifest,
          installedAt: Number(r.installed_at),
        });
      }
      let defined = false;
      const registry = settings.registry;
      for (const [id, m] of next) {
        if (!registry.has(nsOf(id))) {
          registry.define(nsOf(id), runtimeSetting(m.manifest));
          defined = true;
        } else if (meta.get(id)?.hash !== m.hash && meta.has(id)) {
          registry.undefine(nsOf(id)); // fields may have changed: redefine
          registry.define(nsOf(id), runtimeSetting(m.manifest));
          defined = true;
        }
      }
      for (const id of meta.keys())
        if (!next.has(id)) {
          registry.undefine(nsOf(id));
          defined = true;
        }
      for (const [id, rt] of runtimes) if (next.get(id)?.hash !== rt.hash) runtimes.delete(id);
      meta = next;
      if (defined) await settings.reloadDefinitions();
      fingerprint = await dbFingerprint();
    });
    return chain;
  }

  const dbFingerprint = async () =>
    (await db('themes').orderBy('id').select('id', 'content_hash'))
      .map((r) => `${r.id}:${r.content_hash}`)
      .join('|');

  async function build(id) {
    const m = meta.get(id);
    if (!m) throw notFound('That theme');
    let files;
    if (m.source === 'disk') files = await readTree(path.join(themesDir, id));
    else {
      files = new Map();
      for (const r of await db('theme_files').where({ theme_id: id }))
        files.set(r.path, { encoding: r.encoding, content: r.content });
    }
    const text = new Map(
      [...files].filter(([, f]) => f.encoding === 'utf8').map(([p, f]) => [p, f.content]),
    );
    const locales = {};
    for (const [p, c] of text)
      if (/^locales\/[a-z-]+\.json$/i.test(p))
        try {
          locales[path.posix.basename(p, '.json')] = JSON.parse(c);
        } catch {
          /* ignore a broken locale file */
        }
    const hash12 = m.hash.slice(0, 12);
    const lookup = (obj, key) =>
      String(key)
        .split('.')
        .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
    const filters = {
      // "styles/site.css" and "scripts/app.js" address those folders; anything else is under assets/
      asset_url: (p) => {
        const clean = String(p).replace(/^\/+/, '');
        return `/theme/${id}/${hash12}/${/^(styles|scripts)\//.test(clean) ? clean : `assets/${clean}`}`;
      },
      t: /** @this {any} */ function (key) {
        const loc = String(this.context.getSync(['site', 'locale']) ?? 'en');
        const v =
          lookup(locales[loc], key) ??
          lookup(locales[loc.split('-')[0]], key) ??
          lookup(locales.en, key);
        return typeof v === 'string' ? v : key;
      },
      absolute_url: (p) =>
        `${settings.get('general.site_url').replace(/\/+$/, '')}/${String(p ?? '').replace(/^\/+/, '')}`,
      handle: (s) => slug(s),
    };
    return { id, hash: m.hash, manifest: m.manifest, filters, locales, text, files };
  }

  /**
   * Compile every layout and component (a component's css and meta are checked too) and render the default layout once,
   * so a broken or hostile theme is refused when it is installed or edited, not on a visitor's page view.
   * @param {Map<string, {encoding: string, content: string}>} files
   */
  async function dryRun(files) {
    const text = new Map(
      [...files].filter(([, f]) => f.encoding === 'utf8').map(([p, f]) => [p, f.content]),
    );
    const probeFilters = {
      asset_url: (p) => String(p),
      library_url: (p) => String(p),
      t: (k) => String(k),
      absolute_url: (p) => String(p),
      handle: (s) => slug(s),
    };
    const probeFiles = new Map();
    const origin = new Map(); // what the author wrote, for messages
    for (const [p, src] of text) {
      if (!p.endsWith('.html') || !/^(layouts|components)\//.test(p)) continue;
      try {
        if (p.startsWith('components/')) {
          const key = `components/theme/${p.slice('components/'.length)}`;
          probeFiles.set(key, compileComponent(`probe:${p}`, src).template);
          origin.set(key, p);
        } else probeFiles.set(p, src);
      } catch (e) {
        if (!(e instanceof SiteFormatError)) throw e;
        throw new HttpError(422, 'invalid_theme', `${p}: ${e.message}`);
      }
    }
    const probe = createEngine(probeFiles, {
      limits: limits(),
      filters: probeFilters,
      dirs: SITE_DIRS,
    });
    for (const [p, src] of probeFiles) {
      try {
        const tpl = probe.parse(src);
        if (p === 'layouts/default.html')
          await probe.render(
            tpl,
            { content_for_layout: '', content_for_header: '', content_for_footer: '' },
            { globals: sample() },
          );
      } catch (e) {
        throw new HttpError(
          422,
          'invalid_theme',
          `${origin.get(p) ?? p}: ${String(e.message).split('\n')[0].slice(0, 200)}`,
        );
      }
    }
  }

  /** Replace a database theme with these files (all of them, in one transaction), then tell every server. */
  async function store(manifest, files, actor, action, extra = {}) {
    const id = manifest.id;
    const hash = hashFiles(files);
    await db.transaction(async (trx) => {
      await trx('theme_files').where({ theme_id: id }).del();
      await trx('themes').where({ id }).del();
      await trx('themes').insert({
        id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        manifest: JSON.stringify(manifest),
        content_hash: hash,
        installed_by: actor?.id ?? null,
        installed_at: now(),
      });
      for (const [p, f] of files)
        await trx('theme_files').insert({
          theme_id: id,
          path: p,
          encoding: f.encoding,
          content: f.content,
          size: f.content.length,
        });
      await audit.log(
        {
          actor,
          action,
          entity: 'theme',
          entityId: id,
          meta: { name: manifest.name, version: manifest.version, files: files.size, ...extra },
        },
        trx,
      );
    });
    await refresh_();
    await cache.invalidate(['theme']);
    await bus.publish(CHANNEL, { id }).catch(() => {});
  }

  /** The editable (database) theme `id`, or why it can't be edited. */
  function editable(id) {
    const m = meta.get(id);
    if (!m) throw notFound('That theme');
    if (m.source === 'disk')
      throw new HttpError(
        409,
        'built_in',
        `"${m.name}" is a built-in theme and ships read-only with the code. Duplicate it to get a copy you can edit.`,
      );
    return m;
  }

  /** Apply one change to a copy of a database theme's files, check the result exactly like an upload, and save it. */
  async function edit(id, change, actor, action, auditMeta) {
    editable(id);
    // Straight from the database, not this server's cached runtime: another server may have saved a file a moment ago.
    const files = new Map((await build(id)).files);
    change(files);
    const manifest = checkThemeFiles(files);
    if (manifest.id !== id)
      throw new HttpError(
        422,
        'invalid_theme',
        `theme.json: the id must stay "${id}". To make a theme with another id, duplicate this one.`,
      );
    await dryRun(files);
    await store(manifest, files, actor, action, auditMeta);
  }

  const svc = {
    nsOf,
    async start() {
      await refresh_();
      settings.onChange('themes', () => runtimes.clear()); // limits changed: engines are rebuilt on next use
      await bus.subscribe(CHANNEL, () =>
        refresh_().catch((e) => log.error({ err: e.message }, 'themes: refresh failed')),
      );
      // Bus messages can be lost: notice installs from other servers by comparing a cheap fingerprint.
      timer = setInterval(async () => {
        try {
          if ((await dbFingerprint()) !== fingerprint) await refresh_();
        } catch (e) {
          log.warn({ err: e.message }, 'themes: poll failed');
        }
      }, env.CONFIG_POLL_SECONDS * 1000);
      timer.unref();
    },
    stop: () => clearInterval(timer),

    list() {
      const active = svc.activeId();
      return [...meta.values()]
        .map((m) => ({
          id: m.id,
          name: m.name,
          version: m.version,
          description: m.description,
          author: m.author,
          source: m.source,
          active: m.id === active,
          settingsNamespace: nsOf(m.id),
          hasSettings: Object.keys(m.manifest.settings).length > 0,
          installedAt: m.installedAt,
        }))
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    },
    has: (id) => meta.has(id),
    hash: (id) => meta.get(id)?.hash ?? null,

    /** The active theme's id: the setting, or the built-in default if the chosen theme has been removed. */
    activeId() {
      const id = settings.get('site.theme');
      return meta.has(id) ? id : 'default';
    },

    async runtime(id = svc.activeId()) {
      const hit = runtimes.get(id);
      if (hit) return hit;
      const rt = await build(id);
      runtimes.set(id, rt);
      return rt;
    },

    /** @param {string} [dir] assets (default), styles or scripts */
    async asset(id, file, dir = 'assets') {
      const m = meta.get(id);
      if (!m || !['assets', 'styles', 'scripts'].includes(dir)) return null;
      const rt = await svc.runtime(id);
      const f = rt.files.get(`${dir}/${file}`);
      const ext = path.posix.extname(file).toLowerCase();
      if (!f || !ASSET_MIME[ext]) return null;
      return {
        mime: ASSET_MIME[ext],
        body:
          f.encoding === 'utf8' ? Buffer.from(f.content, 'utf8') : Buffer.from(f.content, 'base64'),
        hash: m.hash,
      };
    },

    /** Install (or update) a theme from a zip. Nothing is written until every check has passed. */
    async install(buffer, actor = null) {
      const max = settings.get('themes.max_zip_mb') * 1024 * 1024;
      if (buffer.length > max)
        throw new HttpError(
          413,
          'too_large',
          `That zip is larger than the ${settings.get('themes.max_zip_mb')} MB limit (Settings → Themes).`,
        );
      const { manifest, files } = readThemeZip(buffer, {
        allowJs: settings.get('themes.allow_js'),
      });
      const id = manifest.id;
      if (meta.get(id)?.source === 'disk')
        throw new HttpError(
          409,
          'built_in',
          `"${id}" is a built-in theme and can't be replaced. Give your theme another id in theme.json.`,
        );

      await dryRun(files);
      await store(manifest, files, actor, 'theme.install');
      return svc.list().find((t) => t.id === id);
    },

    // ───────── theme file editor (Appearance → Theme editor) ─────────

    /** Every file of a theme, without contents. Built-in themes are listed too (read-only). */
    async files(id) {
      const m = meta.get(id);
      if (!m) throw notFound('That theme');
      const rt = await svc.runtime(id);
      return {
        theme: svc.list().find((t) => t.id === id),
        editable: m.source === 'db',
        files: [...rt.files]
          .map(([p, f]) => ({
            path: p,
            text: f.encoding === 'utf8',
            size:
              f.encoding === 'utf8'
                ? Buffer.byteLength(f.content)
                : Math.floor((f.content.length * 3) / 4),
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      };
    },

    /** One file: text files with their content; binary ones only described (they are served at their asset URL). */
    async file(id, p) {
      if (!meta.has(id)) throw notFound('That theme');
      const f = (await svc.runtime(id)).files.get(p);
      if (!f) throw notFound('That file');
      return f.encoding === 'utf8'
        ? { path: p, text: true, content: f.content }
        : { path: p, text: false, size: Math.floor((f.content.length * 3) / 4) };
    },

    /**
     * Create or replace one file of an installed theme. Text files arrive as a string, others (images, fonts) as a Buffer.
     * The whole theme is re-checked as if it had been uploaded again, so the editor can't save what the installer refuses.
     * @param {string|Buffer} content
     */
    async saveFile(id, p, content, actor = null) {
      const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
      const { text } = checkThemeFile(p, size, { allowJs: settings.get('themes.allow_js') });
      if (text !== !Buffer.isBuffer(content))
        throw new HttpError(
          422,
          'invalid_input',
          text
            ? `"${p}" is a text file. Edit it in the editor instead of uploading it.`
            : `"${p}" is not a text file. Upload it instead.`,
        );
      await edit(
        id,
        (files) =>
          files.set(
            p,
            Buffer.isBuffer(content)
              ? { encoding: 'base64', content: content.toString('base64') }
              : { encoding: 'utf8', content },
          ),
        actor,
        'theme.file.save',
        { path: p, size },
      );
      return svc.files(id);
    },

    async deleteFile(id, p, actor = null) {
      editable(id);
      if (!(await svc.runtime(id)).files.has(p)) throw notFound('That file');
      if (p === 'theme.json' || p === 'layouts/default.html')
        throw new HttpError(409, 'required_file', `"${p}" is required: every theme needs it.`);
      await edit(id, (files) => files.delete(p), actor, 'theme.file.delete', { path: p });
      return svc.files(id);
    },

    /**
     * Copy any theme (built-in or installed) into a new installed theme, which can then be edited. The only way to change
     * a built-in theme: `site/` ships read-only with the code (D-043), so an edit would be lost on the next update.
     */
    async duplicate(id, { newId, name }, actor = null) {
      if (!meta.has(id)) throw notFound('That theme');
      if (!THEME_ID.test(newId ?? ''))
        throw new HttpError(
          422,
          'invalid_input',
          'The new id is lowercase letters, numbers and underscores, starting with a letter (2–32 characters).',
          { field: 'id' },
        );
      if (meta.has(newId))
        throw new HttpError(409, 'exists', `A theme with the id "${newId}" already exists.`, {
          field: 'id',
        });
      const files = new Map((await svc.runtime(id)).files);
      const raw = JSON.parse(files.get('theme.json').content);
      raw.id = newId;
      raw.name = String(name || `${raw.name} (copy)`).slice(0, 80);
      files.set('theme.json', { encoding: 'utf8', content: `${JSON.stringify(raw, null, 2)}\n` });
      const allowJs = settings.get('themes.allow_js');
      for (const [p, f] of files)
        checkThemeFile(
          p,
          f.encoding === 'utf8' ? Buffer.byteLength(f.content) : (f.content.length * 3) / 4,
          { allowJs },
        );
      const manifest = checkThemeFiles(files);
      await dryRun(files);
      await store(manifest, files, actor, 'theme.duplicate', { from: id });
      // The copy starts with the original's options (and custom CSS), so it looks the same until someone changes it.
      const values = { ...settings.ns(nsOf(id)) };
      const fields = settings.registry.get(nsOf(newId)).fields;
      for (const k of Object.keys(values)) if (!fields[k]) delete values[k];
      if (Object.keys(values).length)
        await settings
          .update(nsOf(newId), { values }, actor)
          .catch((e) =>
            log.warn({ err: e.message, theme: newId }, 'themes: could not copy theme settings'),
          );
      return svc.list().find((t) => t.id === newId);
    },

    /** The theme as a .zip that Appearance → Themes → Install accepts (on this or another installation). */
    async exportZip(id) {
      if (!meta.has(id)) throw notFound('That theme');
      const zip = new AdmZip();
      for (const [p, f] of (await svc.runtime(id)).files)
        zip.addFile(p, Buffer.from(f.content, f.encoding === 'utf8' ? 'utf8' : 'base64'));
      return zip.toBuffer();
    },

    async activate(id, actor = null) {
      if (!meta.has(id)) throw notFound('That theme');
      if (svc.activeId() === id && settings.get('site.theme') === id) return svc.list();
      await settings.update('site', { values: { theme: id } }, actor);
      await audit.log({ actor, action: 'theme.activate', entity: 'theme', entityId: id });
      await cache.invalidate(['theme']);
      return svc.list();
    },

    async uninstall(id, actor = null) {
      const m = meta.get(id);
      if (!m) throw notFound('That theme');
      if (m.source === 'disk')
        throw new HttpError(409, 'built_in', "Built-in themes can't be removed.");
      if (svc.activeId() === id)
        throw new HttpError(409, 'active', 'This theme is in use. Switch to another theme first.');
      await db.transaction(async (trx) => {
        await trx('theme_files').where({ theme_id: id }).del();
        await trx('themes').where({ id }).del();
        await audit.log(
          { actor, action: 'theme.delete', entity: 'theme', entityId: id, meta: { name: m.name } },
          trx,
        );
      });
      await refresh_();
      await bus.publish(CHANNEL, { id }).catch(() => {});
    },
  };

  const refresh_ = refresh;
  return svc;
}

/** Just enough for a dry run of a layout: the globals every page gets. */
function sample() {
  return {
    site: {
      name: 'Site',
      tagline: '',
      url: 'http://localhost',
      locale: 'en',
      home: '/',
      year: 2026,
    },
    menus: {},
    settings: {},
    request: { path: '/', query: {} },
    params: {},
    query: {},
    page: {
      title: 'Sample',
      description: '',
      url: '/',
      file: 'pages/index.html',
      layout: 'default',
      front: {},
    },
    seo: {
      head: new Safe(''),
      title: 'Sample',
      description: '',
      canonical: 'http://localhost/',
      image: null,
    },
    contact: { enabled: false, token: '', sent: false, error: '' },
  };
}

export { THEME_ID };
