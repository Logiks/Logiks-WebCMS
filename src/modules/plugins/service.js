import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import { readPluginZip, dryRun, hashBuffer, manifestSchema } from './package.js';

const CHANNEL = 'plugins:changed';

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Applications → Plugin Manager (docs/DECISIONS.md D-060).
 *
 * Every plugin's files sit at plugins/<slug>/ on this server — the same "built-in on disk vs. installed in the
 * database" split themes already use (D-031), just rooted at plugins/ instead of site/themes/:
 *   - source: 'disk'  — a folder placed directly under plugins/, hand-authored or (later) written by the Plugin
 *     Editor, checked into git like the rest of the codebase. No blob stored here; git/deploy is what gets it onto
 *     every node.
 *   - source: 'db'    — installed by uploading a zip through the admin. The bytes live in this table (a cluster has
 *     no shared disk), and each node materializes them at that same path the first time it needs them.
 * Either way `enabled` is cluster-shared state, reloaded over the bus and healed by polling (as themes/libraries
 * are) — CLAUDE.md's cluster-safety rule.
 *
 * A plugin's plugin.js is full, unsandboxed Node.js — same trust tier as services.script/dbms.query (D-046/D-047),
 * extended for the first time to an installable package. There is no sandbox to dry-run it inside; the dry run
 * only confirms the package structurally loads (see package.js's dryRun). `plugins.manage` must never be granted
 * to a non-wildcard seed role.
 *
 * Enabling loads a plugin into every node via `import(path + '?v=' + version)`: Node's ESM cache keys on the full
 * URL including the query string, so a version bump always resolves to a fresh module with no process restart and
 * no proliferation of versioned directories under plugins/. Disabling does not unload the module (Node can't
 * unmount an ES module) — it just becomes unreachable; re-enabling without a version bump reuses the already-
 * loaded instance, which is safe since nothing about it changed.
 *
 * A plugin's optional `config` (plugin.json) becomes a `plugin_<slug>` settings-registry namespace (D-061) —
 * exactly how an installed theme's `settings` becomes `theme_<id>` (D-031/D-052): registered for every KNOWN
 * plugin regardless of `enabled`, so it can be configured before first use, auto-appearing on the generic
 * Settings screen with no new UI code, plus a curated GET/PUT /admin/plugins/:slug/config pair (routes.js).
 *
 * @param {any} ctx the whole platform context, passed whole (not destructured) for the same reason ctx.services
 *        is (src/context.js): a plugin's plugin.js factory runs at load time, well after every service is built,
 *        and needs the complete ctx, not just what this module happens to depend on at construction time.
 * @param {{pluginsDir: string}} opts
 */
export function createPlugins(ctx, { pluginsDir }) {
  const { db, bus, audit, permissions, settings, log, env } = ctx;
  /** @type {any[]} */
  let rows = [];
  let fingerprint = '';
  let timer = null;
  /** @type {Map<string, {row: any, router: any, manifest: any, adminDir: string}>} */
  const active = new Map();
  /** @type {Map<string, string>} slug -> why an enabled plugin isn't running */
  const loadErrors = new Map();
  /** @type {Map<string, Promise<void>>} slug -> materializing */
  const materializing = new Map();
  /** @type {Map<string, string>} slug -> JSON of the config fields last registered into the settings registry */
  const registeredConfig = new Map();
  // Namespace names are restricted to [a-z][a-z0-9_]* (src/core/settings/registry.js); plugin slugs allow hyphens
  // but never underscores (PLUGIN_SLUG, package.js), so this substitution is lossless and collision-free.
  const nsOf = (slug) => `plugin_${slug.replace(/-/g, '_')}`;

  const COLS = [
    'id',
    'slug',
    'name',
    'version',
    'author',
    'description',
    'manifest',
    'source',
    'integrity',
    'size',
    'unpacked_size',
    'enabled',
    'installed_by',
    'installed_at',
    'updated_at',
  ];
  const fromRow = (r) => ({
    id: Number(r.id),
    slug: r.slug,
    name: r.name,
    version: r.version,
    author: r.author,
    description: r.description,
    manifest: JSON.parse(r.manifest),
    source: r.source,
    integrity: r.integrity,
    size: r.size === null ? null : Number(r.size),
    unpackedSize: r.unpacked_size === null ? null : Number(r.unpacked_size),
    enabled: !!r.enabled,
    installedAt: Number(r.installed_at),
    updatedAt: Number(r.updated_at),
  });
  const view = (p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    version: p.version,
    author: p.author,
    description: p.description,
    menu: p.manifest.menu ?? null,
    permissions: p.manifest.permissions ?? [],
    source: p.source,
    size: p.size,
    enabled: p.enabled,
    loaded: active.has(p.slug),
    loadError: loadErrors.get(p.slug) ?? null,
    requires: [
      ...(p.manifest.requires ?? []),
      ...(p.manifest.depends ?? []).map((d) => `plugin-${d}`),
    ],
    hasConfig: Object.keys(p.manifest.config ?? {}).length > 0,
    settingsNs: nsOf(p.slug),
    installedAt: p.installedAt,
    updatedAt: p.updatedAt,
  });

  const dbFingerprint = async () =>
    (await db('plugins').orderBy('id').select('id', 'version', 'enabled', 'updated_at'))
      .map((r) => `${r.id}:${r.version}:${r.enabled}:${r.updated_at}`)
      .join('|');

  const find = (slug) => rows.find((p) => p.slug === slug);
  const need = (slug) => {
    const p = find(slug);
    if (!p) throw notFound('That plugin');
    return p;
  };

  // ───────── disk discovery (source: 'disk', mirrors themes' built-in-on-disk listing) ─────────

  async function scanDisk() {
    await fs.mkdir(pluginsDir, { recursive: true });
    let entries;
    try {
      entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(pluginsDir, e.name);
      const manifestPath = path.join(dir, 'plugin.json');
      if (!(await exists(manifestPath))) continue;
      let manifest;
      try {
        manifest = manifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
      } catch (err) {
        log.warn({ dir, err: err.message }, 'plugins: skipping folder with an invalid plugin.json');
        continue;
      }
      if (manifest.slug !== e.name) {
        log.warn(
          { dir, slug: manifest.slug },
          'plugins: plugin.json slug does not match its folder name, skipping',
        );
        continue;
      }
      const existingRow = await db('plugins').where({ slug: manifest.slug }).first();
      if (existingRow && existingRow.source === 'db') continue; // a db-sourced install owns this slug
      const t = now();
      if (!existingRow) {
        await db('plugins').insert({
          slug: manifest.slug,
          name: manifest.name,
          version: manifest.version,
          author: manifest.author,
          description: manifest.description,
          manifest: JSON.stringify(manifest),
          source: 'disk',
          integrity: null,
          package: null,
          files: null,
          size: null,
          unpacked_size: null,
          enabled: false,
          installed_by: null,
          installed_at: t,
          updated_at: t,
        });
      } else if (
        existingRow.version !== manifest.version ||
        existingRow.manifest !== JSON.stringify(manifest)
      ) {
        await db('plugins')
          .where({ slug: manifest.slug })
          .update({
            name: manifest.name,
            version: manifest.version,
            author: manifest.author,
            description: manifest.description,
            manifest: JSON.stringify(manifest),
            updated_at: t,
          });
      }
    }
  }

  async function reload() {
    rows = (await db('plugins').select(COLS).orderBy('name')).map(fromRow);
    fingerprint = await dbFingerprint();
    await refreshSettings();
  }

  /**
   * Register/update/remove each plugin's `plugin_<slug>` settings namespace from its manifest's `config` block —
   * mirrors themes/service.js's `refresh()` exactly: `registry.define` isn't idempotent (it throws if the
   * namespace already exists), so a namespace whose config schema changed is `undefine`d first; anything no
   * longer known is undefined too. Runs for every known plugin regardless of `enabled`, same as themes registering
   * settings for an installed-but-inactive theme — configuring something is independent of switching it on.
   */
  async function refreshSettings() {
    let anyChange = false;
    const known = new Set();
    for (const p of rows) {
      known.add(p.slug);
      const fields = p.manifest.config ?? {};
      const hash = JSON.stringify(fields);
      if (registeredConfig.get(p.slug) === hash) continue;
      const ns = nsOf(p.slug);
      if (settings.registry.has(ns)) settings.registry.undefine(ns);
      if (Object.keys(fields).length)
        settings.registry.define(ns, { title: `Plugin: ${p.name}`, order: 70, fields });
      registeredConfig.set(p.slug, hash);
      anyChange = true;
    }
    for (const slug of [...registeredConfig.keys()]) {
      if (known.has(slug)) continue;
      const ns = nsOf(slug);
      if (settings.registry.has(ns)) {
        settings.registry.undefine(ns);
        anyChange = true;
      }
      registeredConfig.delete(slug);
    }
    if (anyChange) await settings.reloadDefinitions();
  }

  /** Take a plugin out of the active set and out of the module registry (with anything that needed it). */
  function drop(slug) {
    active.delete(slug);
    ctx.modules.unregister(`plugin-${slug}`);
  }

  /**
   * Load newly-enabled plugins, drop newly-disabled ones from the active set (never literally unloading code). A plugin
   * that needs another plugin is retried after the others in the same pass, so install order doesn't matter.
   */
  async function reconcile() {
    for (const slug of [...active.keys()])
      if (!rows.some((p) => p.slug === slug && p.enabled)) drop(slug);
    let pending = [];
    for (const p of rows) {
      const loaded = active.get(p.slug);
      if (!p.enabled) {
        loadErrors.delete(p.slug);
        continue;
      }
      if (loaded && loaded.row.version === p.version) continue; // already current
      pending.push(p);
    }
    for (let progress = true; pending.length && progress;) {
      progress = false;
      const stuck = [];
      for (const p of pending) {
        try {
          await load(p);
          loadErrors.delete(p.slug);
          progress = true;
        } catch (e) {
          if (e.code === 'module_requirement_missing') stuck.push(p);
          else {
            loadErrors.set(p.slug, e.message);
            log.error(
              { slug: p.slug, err: e.message },
              'plugins: failed to load an enabled plugin',
            );
          }
        }
      }
      pending = stuck;
    }
    for (const p of pending) {
      const msg = `${p.name} was not loaded: it needs a module or plugin that isn't installed or isn't on.`;
      loadErrors.set(p.slug, msg);
      log.error(
        { slug: p.slug },
        'plugins: a plugin was not loaded because its requirements are missing',
      );
    }
  }

  async function changed() {
    await reload();
    await reconcile();
    await bus.publish(CHANNEL, {}).catch(() => {});
  }

  // ───────── materialize (source: 'db' only) + load ─────────

  /** Swap plugins/<slug>/ for freshly-extracted contents, atomically enough for any concurrent reader. */
  async function swapIn(dir, tmp) {
    if (await exists(dir)) {
      const old = `${dir}.old-${randomBytes(4).toString('hex')}`;
      await fs.rename(dir, old);
      await fs.rename(tmp, dir);
      await fs.rm(old, { recursive: true, force: true });
    } else {
      await fs.rename(tmp, dir);
    }
  }

  async function materialize(p, dir) {
    let inFlight = materializing.get(p.slug);
    if (!inFlight) {
      inFlight = (async () => {
        const sentinel = path.join(dir, '.plugin-meta.json');
        if (await exists(sentinel)) {
          try {
            const meta = JSON.parse(await fs.readFile(sentinel, 'utf8'));
            if (meta.version === p.version && meta.integrity === p.integrity) return; // already current
          } catch {
            /* re-materialize */
          }
        }
        const row = await db('plugins').where({ slug: p.slug }).first('package', 'integrity');
        if (!row) throw notFound('That plugin');
        const buf = Buffer.from(row.package, 'base64');
        if (hashBuffer(buf) !== row.integrity)
          throw new HttpError(
            500,
            'integrity',
            `The stored copy of ${p.slug} doesn't match its hash. Reinstall it.`,
          );
        const { files } = readPluginZip(buf);
        const tmp = path.join(pluginsDir, `.tmp-${p.slug}-${randomBytes(4).toString('hex')}`);
        for (const [rel, f] of files) {
          const abs = path.join(tmp, rel);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(
            abs,
            f.encoding === 'utf8' ? f.content : Buffer.from(f.content, 'base64'),
          );
        }
        await fs.writeFile(
          path.join(tmp, '.plugin-meta.json'),
          JSON.stringify({ version: p.version, integrity: p.integrity }),
        );
        await swapIn(dir, tmp);
      })();
      materializing.set(p.slug, inFlight);
      inFlight.finally(() => materializing.delete(p.slug));
    }
    return inFlight;
  }

  /** The module-registry entry of a plugin: what it needs and what it adds (D-070). */
  function asModule(p) {
    const needs = [
      ...new Set([
        'plugins',
        ...(p.manifest.requires ?? []),
        ...(p.manifest.depends ?? []).map((d) => `plugin-${d}`),
      ]),
    ];
    return {
      id: `plugin-${p.slug}`,
      kind: 'plugin',
      label: p.name,
      description: p.description ?? '',
      version: p.version,
      requires: needs,
      provides: {
        permissions: (p.manifest.permissions ?? []).map((x) => x.key),
        settings: Object.keys(p.manifest.config ?? {}).length ? [nsOf(p.slug)] : [],
      },
      enabled: () => active.has(p.slug),
    };
  }

  async function load(p) {
    // Needs first, so a missing one says so before any of the plugin's code runs.
    for (const r of p.manifest.requires ?? [])
      if (!ctx.modules.isOn(r, ctx))
        throw new HttpError(
          422,
          'module_requirement_missing',
          `"${p.name}" needs the "${r}" module, which isn't installed or is switched off.`,
        );
    ctx.modules.registerDynamic(asModule(p)); // throws module_requirement_missing for a missing plugin
    try {
      await loadFiles(p);
    } catch (e) {
      ctx.modules.unregister(`plugin-${p.slug}`);
      throw e;
    }
  }

  async function loadFiles(p) {
    const dir = path.join(pluginsDir, p.slug);
    if (p.source === 'db') await materialize(p, dir);
    const entryPath = path.join(dir, 'plugin.js');
    let router = null;
    if (await exists(entryPath)) {
      const mod = await import(
        `${pathToFileURL(entryPath).href}?v=${encodeURIComponent(p.version)}`
      );
      if (typeof mod.default !== 'function')
        throw new HttpError(500, 'invalid_plugin', `${p.slug}'s plugin.js has no default export.`);
      // Awaited, not called bare: a plugin's factory may be async (e.g. to seed a Service or a site component it
      // depends on before its router is considered ready, D-062) — a plain synchronous return still resolves
      // immediately through await, so this is backward compatible with every existing plugin.js.
      router = await mod.default(ctx);
    }
    for (const perm of p.manifest.permissions ?? [])
      permissions.define(`Plugin: ${p.name}`, { [perm.key]: perm.label });
    active.set(p.slug, { row: p, router, manifest: p.manifest, adminDir: path.join(dir, 'admin') });
  }

  async function runMigration(p, actor) {
    const dir = path.join(pluginsDir, p.slug);
    const migratePath = path.join(dir, 'migrate.js');
    if (!(await exists(migratePath))) return;
    const already = await db('plugin_migrations')
      .where({ plugin_slug: p.slug, name: p.version })
      .first();
    if (already) return;
    const mod = await import(
      `${pathToFileURL(migratePath).href}?v=${encodeURIComponent(p.version)}`
    );
    if (typeof mod.default !== 'function') return;
    await db.transaction(async (trx) => {
      await mod.default(trx, ctx.dialect);
      await trx('plugin_migrations').insert({
        plugin_slug: p.slug,
        name: p.version,
        batch: now(),
        applied_at: now(),
      });
    });
    await audit.log({
      actor,
      action: 'plugin.migrated',
      entity: 'plugin',
      entityId: p.slug,
      meta: { version: p.version },
    });
  }

  const svc = {
    async start() {
      await scanDisk();
      await reload();
      await reconcile();
      await bus.subscribe(CHANNEL, () =>
        reload()
          .then(reconcile)
          .catch((e) => log.error({ err: e.message }, 'plugins: reload failed')),
      );
      // Bus messages can be lost: notice changes made on other servers with a cheap fingerprint.
      timer = setInterval(async () => {
        try {
          if ((await dbFingerprint()) !== fingerprint) {
            await reload();
            await reconcile();
          }
        } catch (e) {
          log.warn({ err: e.message }, 'plugins: poll failed');
        }
      }, env.CONFIG_POLL_SECONDS * 1000);
      timer.unref();
    },
    stop: () => clearInterval(timer),

    /** Look again at plugins/ for a disk-sourced folder that appeared (or changed) without a restart. */
    async rescanDisk() {
      await scanDisk();
      await changed();
    },
    list: () => rows.map(view),
    get(slug) {
      return view(need(slug));
    },
    /** Enabled plugins the caller may see in the nav, for the admin SPA's `GET /admin/plugins/menu`. */
    menu(can) {
      return rows
        .filter((p) => p.enabled && p.manifest.menu && active.has(p.slug))
        .filter((p) => {
          const perms = (p.manifest.permissions ?? []).map((x) => x.key);
          return perms.length === 0 || perms.some((k) => can(k));
        })
        .map((p) => ({
          slug: p.slug,
          label: p.manifest.menu.label,
          icon: p.manifest.menu.icon,
          perm: p.manifest.permissions?.[0]?.key ?? 'admin.access',
        }));
    },
    /** Currently enabled+loaded plugins, keyed by slug — the dynamic request dispatcher and admin-fragment
     * middleware read this directly (src/app.js), never mutating Express's own route stack at runtime. */
    active: () => active,
    /** The settings-registry namespace a plugin's `config` fields live under (routes.js's config endpoints). */
    settingsNs: (slug) => nsOf(need(slug).slug),

    async install(buffer, actor = null) {
      const { manifest, files } = readPluginZip(buffer);
      await dryRun(files);
      const integrity = hashBuffer(buffer);
      const fileList = [...files.entries()]
        .map(([p, f]) => [
          p,
          f.encoding === 'utf8' ? Buffer.byteLength(f.content) : (f.content.length * 3) / 4,
        ])
        .sort((a, b) => a[0].localeCompare(b[0]));
      const before = find(manifest.slug);
      if (before && before.source === 'disk')
        throw new HttpError(
          409,
          'conflict',
          `"${manifest.slug}" already exists as a disk-based plugin (plugins/${manifest.slug}/). Remove that folder first if you want to replace it with an uploaded package.`,
        );
      const t = now();
      const row = {
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        description: manifest.description,
        manifest: JSON.stringify(manifest),
        source: 'db',
        integrity,
        package: buffer.toString('base64'),
        files: JSON.stringify(fileList),
        size: buffer.length,
        unpacked_size: fileList.reduce((n, [, s]) => n + s, 0),
        updated_at: t,
      };
      await db.transaction(async (trx) => {
        if (before) await trx('plugins').where({ slug: manifest.slug }).update(row);
        else
          await trx('plugins').insert({
            ...row,
            slug: manifest.slug,
            enabled: false,
            installed_by: actor?.id ?? null,
            installed_at: t,
          });
        await audit.log(
          {
            actor,
            action: 'plugin.installed',
            entity: 'plugin',
            entityId: manifest.slug,
            meta: { version: manifest.version, previous: before?.version ?? null },
          },
          trx,
        );
      });
      await changed();
      return svc.get(manifest.slug);
    },

    async setEnabled(slug, enabled, actor = null) {
      need(slug); // throws notFound if there's no such plugin
      await db('plugins').where({ slug }).update({ enabled, updated_at: now() });
      await audit.log({
        actor,
        action: enabled ? 'plugin.enabled' : 'plugin.disabled',
        entity: 'plugin',
        entityId: slug,
      });
      if (enabled) {
        await reload();
        const fresh = need(slug);
        if (fresh.source === 'db') await materialize(fresh, path.join(pluginsDir, slug));
        await runMigration(fresh, actor);
      }
      await changed();
      return svc.get(slug);
    },

    async uninstall(slug, actor = null) {
      const p = need(slug);
      if (p.source !== 'db')
        throw new HttpError(
          422,
          'disk_sourced',
          'This plugin ships from plugins/ on disk. Remove its folder via git/deploy instead — Plugin Manager only uninstalls plugins it installed from a zip.',
        );
      if (p.enabled)
        throw new HttpError(409, 'conflict', 'Disable the plugin before uninstalling it.');
      await db('plugins').where({ slug }).del();
      await audit.log({ actor, action: 'plugin.uninstalled', entity: 'plugin', entityId: slug });
      await changed();
    },

    async exportZip(slug) {
      const p = need(slug);
      if (p.source === 'db') {
        const row = await db('plugins').where({ slug }).first('package');
        return Buffer.from(row.package, 'base64');
      }
      const dir = path.join(pluginsDir, slug);
      const zip = new AdmZip();
      const addDir = async (rel) => {
        const abs = path.join(dir, rel);
        for (const e of await fs.readdir(abs, { withFileTypes: true })) {
          const entryRel = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await addDir(entryRel);
          else zip.addFile(entryRel, await fs.readFile(path.join(abs, e.name)));
        }
      };
      await addDir('');
      return zip.toBuffer();
    },
  };
  return svc;
}
