import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_PREFIX } from '../backup/service.js';

/**
 * Which data a deployment can carry, and how (D-134).
 *
 * Modes, per table: `skip` (not carried), `add` (records this server lacks are added, never changed), `sync` (records
 * this server lacks are added, and a record dev changed is updated here — unless someone changed it here too, which becomes
 * a conflict a person must tick). Nothing is ever deleted, whatever the mode.
 *
 * "Same record" is decided by a natural key (an email, a slug…), never by the numeric id: ids are handed out by each
 * server and collide. Tables with no natural key can only be added by their primary key.
 */

/**
 * Tables that can be matched by a natural key.
 *  key       columns that say "this is the same record" (after `fks` are translated to this server's ids)
 *  fks       column → table it points at. A record whose parent was not carried is skipped.
 *  optFks    like fks, but an unmapped value becomes NULL (an author who is not on this server)
 *  who       audit columns (who made it): never compared, never overwritten; NULL on a new record
 *  secret    columns that hold a secret: NULL on a new record, never compared, never overwritten
 *  ignore    columns never compared or written on update (per-server state)
 *  addOnly   only ever added, never updated (history rows)
 *  requires  tables that must be carried for this one to make sense
 * @type {Record<string, { group: string, label: string, key: string[], fks?: Record<string,string>, optFks?: Record<string,string>,
 *   self?: string, who?: string[], secret?: string[], ignore?: string[], addOnly?: boolean, requires?: string[], strId?: boolean }>}
 */
export const SPECS = {
  roles: { group: 'people', label: 'Roles and their permissions', key: ['name'] },
  users: {
    group: 'people',
    label: 'Users (including their password hashes)',
    key: ['email'],
    fks: { role_id: 'roles' },
    ignore: ['failed_attempts', 'locked_until', 'last_login_at'],
    requires: ['roles'],
  },
  terms: {
    group: 'content',
    label: 'Categories and tags',
    key: ['taxonomy', 'slug'],
    self: 'parent_id',
  },
  entries: {
    group: 'content',
    label: 'Content entries (posts, pages…)',
    key: ['type', 'locale', 'slug'],
    self: 'parent_id',
    optFks: { author_id: 'users' },
  },
  entry_terms: {
    group: 'content',
    label: 'Which category or tag each entry has',
    key: ['entry_id', 'term_id'],
    fks: { entry_id: 'entries', term_id: 'terms' },
    addOnly: true,
    requires: ['entries', 'terms'],
  },
  entry_revisions: {
    group: 'content',
    label: 'Entry revision history',
    key: ['entry_id', 'version'],
    fks: { entry_id: 'entries' },
    who: ['saved_by'],
    addOnly: true,
    requires: ['entries'],
  },
  menus: { group: 'build', label: 'Menus', key: ['name'] },
  redirects: { group: 'build', label: 'Redirects', key: ['from_path'], who: ['created_by'] },
  seo_rules: {
    group: 'build',
    label: 'SEO rules',
    key: ['pattern'],
    who: ['created_by', 'updated_by'],
  },
  services: {
    group: 'build',
    label: 'Services',
    key: ['slug'],
    who: ['created_by', 'updated_by'],
  },
  webhooks: {
    group: 'build',
    label: 'Webhooks (secrets stay on each server)',
    key: ['name'],
    secret: ['secret'],
    who: ['created_by', 'updated_by'],
  },
  scheduled_tasks: {
    group: 'build',
    label: 'Scheduled tasks',
    key: ['name'],
    who: ['created_by', 'updated_by'],
    ignore: ['last_run_at', 'last_status', 'last_error'],
  },
  content_templates: {
    group: 'build',
    label: 'Content templates',
    key: ['type', 'name'],
    who: ['created_by'],
  },
  dbms_saved_queries: {
    group: 'build',
    label: 'Saved database queries',
    key: ['name'],
    who: ['created_by'],
  },
  prompts: { group: 'build', label: 'AI prompts', key: ['key'], who: ['updated_by'] },
  libraries: {
    group: 'build',
    label: 'JavaScript libraries (name; a new version updates it)',
    key: ['name'],
    who: ['installed_by'],
  },
  library_mirrors: {
    group: 'build',
    label: 'Mirrored CDN files',
    key: ['url_hash'],
    who: ['created_by'],
  },
  themes: {
    group: 'build',
    label: 'Installed themes',
    key: ['id'],
    strId: true,
    who: ['installed_by'],
  },
  theme_files: {
    group: 'build',
    label: 'Installed theme files',
    key: ['theme_id', 'path'],
    fks: { theme_id: 'themes' },
    requires: ['themes'],
  },
};

/** The order parents come before children. */
export const SYNC_ORDER = [
  'roles',
  'users',
  'themes',
  'theme_files',
  'terms',
  'entries',
  'entry_terms',
  'entry_revisions',
  'menus',
  'redirects',
  'seo_rules',
  'services',
  'webhooks',
  'scheduled_tasks',
  'content_templates',
  'dbms_saved_queries',
  'prompts',
  'libraries',
  'library_mirrors',
];

export const GROUPS = [
  {
    id: 'build',
    label: 'What you built',
    help: 'Menus, redirects, SEO rules, services, libraries, themes… Safe to keep in step with dev.',
  },
  {
    id: 'data',
    label: 'Your own tables and media',
    help: 'Tables named do_, sys_ or data_, and the media library. Production only adds what it lacks.',
  },
  {
    id: 'content',
    label: 'Content',
    help: 'Entries and categories are matched by slug, never by id. Production may have its own content: keep this off unless dev is where content is written.',
  },
  {
    id: 'people',
    label: 'People',
    help: 'Roles and users. Turning users on copies dev password hashes to production.',
  },
  {
    id: 'plugins',
    label: 'Plugin tables',
    help: 'Tables a plugin created. A plugin keeps its own records on each server, so these are off by default.',
  },
];

/** Every setting that can travel is picked by default; a person unticks what should stay different on production.
 *  Secret settings (API keys, passwords, tokens) can never travel: they are encrypted with each server's own key. */
export const isDefaultSetting = () => true;

/** Tables made by the core migrations. Anything else that is not a do_/sys_/data_ table was made by a plugin. */
export function coreTableNames() {
  const out = new Set(['knex_migrations', 'knex_migrations_lock', 'sqlite_sequence']);
  // The migrations that ship with the code this server runs (not the app folder a test or a tool points at).
  const dir = fileURLToPath(new URL('../../../migrations', import.meta.url));
  try {
    for (const f of fs.readdirSync(dir))
      if (f.endsWith('.js'))
        for (const m of fs
          .readFileSync(path.join(dir, f), 'utf8')
          .matchAll(/createTable\(\s*'([\w]+)'/g))
          out.add(m[1]);
  } catch {
    /* no migrations folder (an unusual layout): every table then looks like a plugin's, which is the safe reading */
  }
  return out;
}

/** Tables that are never offered: runtime state, logs, sessions, and the site tree (which public/ carries). */
const MEDIA = new Set(['media', 'media_folders']);

/**
 * One entry per table a person can choose about.
 * @param {string[]} present table names in this database
 */
export function buildCatalog(present) {
  const core = coreTableNames();
  const have = new Set(present);
  const out = [];
  for (const t of present.sort()) {
    if (t.startsWith('sqlite_') || t.startsWith('search_fts')) continue;
    const spec = SPECS[t];
    if (spec) {
      out.push({
        table: t,
        group: spec.group,
        label: spec.label,
        modes: ['skip', 'add', 'sync'],
        spec: true,
        requires: (spec.requires ?? []).filter((r) => have.has(r)),
      });
    } else if (DATA_PREFIX.test(t) || MEDIA.has(t)) {
      out.push({ table: t, group: 'data', label: t, modes: ['skip', 'add'], requires: [] });
    } else if (!core.has(t)) {
      out.push({ table: t, group: 'plugins', label: t, modes: ['skip', 'add'], requires: [] });
    }
  }
  return out;
}

/** What a table does when nobody chose: build things sync, own tables and media add, everything else stays home. */
export function defaultMode(entry) {
  if (entry.group === 'build') return 'sync';
  if (entry.group === 'data') return 'add';
  return 'skip';
}

/**
 * A saved choice made safe: unknown tables dropped, a mode the table cannot do falls back to its default, and a table
 * whose parents are not carried gets them added (a child record cannot be placed without its parent).
 * @param {any} raw
 * @param {ReturnType<typeof buildCatalog>} catalog
 * @param {Set<string>} knownSettings every setting a person may choose, as "namespace.key"
 */
export function normalizeSelection(raw, catalog, knownSettings) {
  const asked = raw && typeof raw === 'object' ? raw : {};
  const tables = {};
  for (const e of catalog) {
    const m = asked.tables?.[e.table];
    tables[e.table] = e.modes.includes(m) ? m : defaultMode(e);
  }
  // Parents first: a child needs them at least added.
  for (let again = true; again;) {
    again = false;
    for (const e of catalog)
      if (tables[e.table] !== 'skip')
        for (const r of e.requires)
          if (tables[r] === 'skip') {
            tables[r] = 'add';
            again = true;
          }
  }
  const settings = Array.isArray(asked.settings)
    ? [...new Set(asked.settings.filter((s) => typeof s === 'string' && knownSettings.has(s)))]
    : [...knownSettings].filter(isDefaultSetting);
  return { tables, settings };
}
