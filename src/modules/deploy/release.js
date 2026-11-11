import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dialect, now } from '../../core/db/index.js';
import { HttpError } from '../../core/http/errors.js';
import { scanMigration } from '../../core/migration-guard.js';

/**
 * Release notes for every deploy (D-138): what changed, and what a person may want to do by hand because a deploy never
 * removes or renames anything. Dev writes them into the deployment repository (`deploy-notes/releases/NNNN.json`, plus a
 * readable `deploy-notes/CHANGELOG.md`); a server that pulls the update stores them (`deploy_releases`) so they can be read
 * later, with the steps ticked off as they are done.
 */
export const NOTES_DIR = 'deploy-notes';
export const RELEASES_DIR = `${NOTES_DIR}/releases`;
const CAP = 40;
const cut = (v, n = 200) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const names = (list) => [...list].sort();

// ───────────────────────────── the version ─────────────────────────────

export const BUMPS = ['major', 'minor', 'fix'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (v) => (SEMVER.exec(String(v ?? '')) ?? []).slice(1).map(Number);

/** -1, 0 or 1; a value that is not x.y.z counts as 0.0.0. */
export function compareVersions(a, b) {
  const x = parts(a).length ? parts(a) : [0, 0, 0];
  const y = parts(b).length ? parts(b) : [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** major → 2.0.0, minor → 1.3.0, fix → 1.2.4 (from 1.2.3). Anything that is not x.y.z starts from 0.0.0. */
export function bumpVersion(version, kind) {
  const [maj, min, fix] = parts(version).length ? parts(version) : [0, 0, 0];
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'fix') return `${maj}.${min}.${fix + 1}`;
  throw new HttpError(422, 'invalid_input', 'Choose major, minor or issue fix.');
}

/**
 * The version a new deploy builds on: the newest of what the deployment repository last said and what this code says,
 * so a version bumped by hand in package.json is never taken back.
 */
export function currentVersion(last, packageVersion) {
  return last && compareVersions(last, packageVersion) > 0 ? last : packageVersion;
}

/**
 * Writes the version into the deployment folder's package.json (and package-lock.json), nothing else. Same indentation and
 * trailing newline Prettier keeps, so the file differs by that one line.
 */
export async function writeVersion(dir, version) {
  const set = async (rel, edit) => {
    const f = path.join(dir, rel);
    let text;
    try {
      text = await fs.readFile(f, 'utf8');
    } catch {
      return; // no lockfile: nothing to keep in step
    }
    const json = JSON.parse(text);
    edit(json);
    await fs.writeFile(f, `${JSON.stringify(json, null, 2)}\n`);
  };
  await set('package.json', (j) => {
    j.version = version;
  });
  await set('package-lock.json', (j) => {
    j.version = version;
    if (j.packages?.['']) j.packages[''].version = version;
  });
}

/**
 * A package.json or lockfile that differs ONLY in its own version needs no `npm ci`: every deploy bumps that line (D-144),
 * and reinstalling on each update would be slow for nothing. Anything else in either file still means install.
 */
export function sameWithoutVersion(a, b) {
  try {
    const strip = (text) => {
      const j = JSON.parse(text);
      delete j.version;
      if (j.packages?.['']) delete j.packages[''].version;
      return JSON.stringify(j);
    };
    return strip(a) === strip(b);
  } catch {
    return false;
  }
}

// ───────────────────────────── reading a deployment checkout ─────────────────────────────

/** What a deployment checkout says about the previous (or the new) state. Everything is optional: an old one has none of it. */
export async function readState(dir) {
  const read = (rel) => fs.readFile(path.join(dir, rel), 'utf8').catch(() => null);
  const json = async (rel) => {
    try {
      const t = await read(rel);
      return t ? JSON.parse(t) : null;
    } catch {
      return null;
    }
  };
  const list = (rel) => fs.readdir(path.join(dir, rel)).catch(() => null);
  const libText = await read('deploy-data/db/libraries.ndjson');
  const releases = [];
  for (const f of (await list(RELEASES_DIR)) ?? [])
    if (/^\d+\.json$/.test(f)) {
      const r = await json(`${RELEASES_DIR}/${f}`);
      if (r) releases.push(r);
    }
  return {
    schema: (await json('deploy-data/manifest.json'))?.schema ?? null,
    manifest: await json('deploy-data/manifest.json'),
    plan: await json('deploy-data/sync.json'),
    // An empty file means "no libraries" (every one was removed); only a missing file means "not part of this deploy".
    libraries:
      libText !== null
        ? libText
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              const r = JSON.parse(l);
              return {
                name: r.name,
                version: r.version,
                include: JSON.parse(r.include || '[]'),
                autoload: !!r.autoload,
              };
            })
        : null,
    migrations: await list('migrations'),
    plugins: await list('plugins'),
    releases: releases.sort((a, b) => a.seq - b.seq),
    changelog: await read(`${NOTES_DIR}/CHANGELOG.md`),
  };
}

// ───────────────────────────── what changed ─────────────────────────────

export function diffSchema(prev, next) {
  if (!prev || !next) return null;
  const out = {
    tablesAdded: [],
    tablesRemoved: [],
    columnsAdded: [],
    columnsRemoved: [],
    typeChanged: [],
  };
  for (const t of Object.keys(next)) if (!prev[t]) out.tablesAdded.push(t);
  for (const t of Object.keys(prev)) if (!next[t]) out.tablesRemoved.push(t);
  for (const t of Object.keys(next)) {
    if (!prev[t]) continue;
    const a = new Map((prev[t].columns ?? []).map((c) => [c.name, c]));
    const b = new Map((next[t].columns ?? []).map((c) => [c.name, c]));
    for (const [c, def] of b) {
      if (!a.has(c)) out.columnsAdded.push(`${t}.${c}`);
      else if (a.get(c).type !== def.type)
        out.typeChanged.push({ column: `${t}.${c}`, from: a.get(c).type, to: def.type });
    }
    for (const c of a.keys()) if (!b.has(c)) out.columnsRemoved.push(`${t}.${c}`);
  }
  for (const k of ['tablesAdded', 'tablesRemoved', 'columnsAdded', 'columnsRemoved']) out[k].sort();
  return out;
}

export function diffLibraries(prev, next) {
  if (!prev || !next) return null;
  const a = new Map(prev.map((l) => [l.name, l]));
  const b = new Map(next.map((l) => [l.name, l]));
  const out = { added: [], updated: [], removed: [] };
  for (const [n, l] of b) {
    const p = a.get(n);
    if (!p) out.added.push({ name: n, version: l.version, files: l.include, autoload: l.autoload });
    else if (
      p.version !== l.version ||
      JSON.stringify(p.include) !== JSON.stringify(l.include) ||
      p.autoload !== l.autoload
    )
      out.updated.push({
        name: n,
        from: { version: p.version, files: p.include, autoload: p.autoload },
        to: { version: l.version, files: l.include, autoload: l.autoload },
      });
  }
  for (const n of a.keys()) if (!b.has(n)) out.removed.push(n);
  return out;
}

export function diffSettings(prev, next) {
  if (!next) return null;
  const a = new Map((prev ?? []).map((s) => [s.id, s.value]));
  const out = [];
  for (const s of next)
    if (!a.has(s.id) || JSON.stringify(a.get(s.id)) !== JSON.stringify(s.value))
      out.push({ id: s.id, from: a.has(s.id) ? cut(a.get(s.id)) : null, to: cut(s.value) });
  return out.slice(0, 200);
}

/** @param {{status: string, file: string}[]} changed what `git diff --name-status` listed */
export function classifyFiles(changed) {
  const kinds = {
    pages: [],
    components: [],
    wording: [],
    themes: [],
    plugins: [],
    migrations: [],
    data: 0,
    code: 0,
    other: 0,
  };
  for (const { file, status } of changed) {
    const tag = `${status} ${file}`;
    if (file.startsWith(`${NOTES_DIR}/`)) continue;
    if (file.startsWith('deploy-data/')) kinds.data++;
    else if (file.startsWith('public/pages/')) kinds.pages.push(tag);
    else if (file.startsWith('public/components/')) kinds.components.push(tag);
    else if (file.startsWith('public/locales/')) kinds.wording.push(tag);
    else if (file.startsWith('site/themes/')) kinds.themes.push(tag);
    else if (file.startsWith('plugins/')) kinds.plugins.push(tag);
    else if (file.startsWith('migrations/')) kinds.migrations.push(tag);
    else if (file.startsWith('public/')) kinds.other++;
    else kinds.code++;
  }
  const lst = (a) => ({ count: a.length, examples: a.slice(0, CAP) });
  return {
    pages: lst(kinds.pages),
    components: lst(kinds.components),
    wording: lst(kinds.wording),
    themes: lst(kinds.themes),
    plugins: lst(kinds.plugins),
    migrations: lst(kinds.migrations),
    dataFiles: kinds.data,
    codeFiles: kinds.code,
    otherSiteFiles: kinds.other,
  };
}

// ───────────────────────────── the steps a person may want to do ─────────────────────────────

/** A deploy never removes or renames anything, so these are listed for the admin to do (or not). */
export function buildSteps({ schema, libraries, plugins, migrations }) {
  const steps = [];
  const renamed = schema?.tablesAdded?.length
    ? ` If it was renamed on dev (a rename shows up as one table removed and one added: ${schema.tablesAdded.slice(0, 5).join(', ')}), move its records into the new table first.`
    : '';
  for (const t of schema?.tablesRemoved ?? [])
    steps.push({
      id: `drop-table:${t}`,
      kind: 'drop-table',
      subject: t,
      title: `Table “${t}” no longer exists on dev`,
      detail: `This server still has it, with its records; nothing was dropped.${renamed} If you no longer need it, take a backup (Operations → Backups) and then drop it.`,
      where: 'System → Database',
    });
  for (const c of schema?.columnsRemoved ?? [])
    steps.push({
      id: `drop-column:${c}`,
      kind: 'drop-column',
      subject: c,
      title: `Column “${c}” no longer exists on dev`,
      detail: `This server still has the column and its values. A column renamed on dev appears here as removed, and under "added" with its new name; copy the values across before removing the old one. Take a backup first.`,
      where: 'System → Database',
    });
  for (const c of schema?.typeChanged ?? [])
    steps.push({
      id: `retype-column:${c.column}`,
      kind: 'retype-column',
      subject: c.column,
      title: `Column “${c.column}” changed type on dev (${c.from} → ${c.to})`,
      detail:
        'This server keeps its own column type. Change it only if the new code needs the new type.',
      where: 'System → Database',
    });
  for (const n of libraries?.removed ?? [])
    steps.push({
      id: `remove-library:${n}`,
      kind: 'remove-library',
      subject: n,
      title: `Library “${n}” was removed on dev`,
      detail:
        'It is still installed here and still loads on pages if "load on every page" is on. Remove it if pages no longer use it.',
      where: 'System → Libraries',
    });
  for (const p of plugins?.removed ?? [])
    steps.push({
      id: `remove-plugin:${p}`,
      kind: 'remove-plugin',
      subject: p,
      title: `Plugin “${p}” was removed on dev`,
      detail:
        'Its folder and records are still here. Switch it off and uninstall it if it is not needed.',
      where: 'Settings → Plugin Manager',
    });
  for (const m of migrations ?? [])
    if (m.destructive?.length)
      steps.push({
        id: `review-migration:${m.file}`,
        kind: 'review-migration',
        subject: m.file,
        title: `Database change “${m.file}” removes or renames data`,
        detail: `${m.destructive.join('; ')}. Update refuses it until you take a backup and turn on "Allow updates that remove or rename tables or columns" in Settings → Updates.`,
        where: 'Settings → Updates',
      });
  return steps;
}

// ───────────────────────────── building and writing a release ─────────────────────────────

/**
 * @param {{ prev: any, next: any, changed: {status: string, file: string}[], migrationsNew: {file: string, destructive: string[]}[],
 *   title?: string, notes?: string, devCommit?: string|null, commits?: string[], by?: string|null, added?: any,
 *   version?: string|null, bump?: string|null }} i
 */
export function buildRelease({
  prev,
  next,
  changed,
  migrationsNew,
  title,
  notes,
  devCommit,
  commits,
  by,
  added,
  version,
  bump,
}) {
  const seq = (prev.releases.at(-1)?.seq ?? 0) + 1;
  const schema = diffSchema(prev.schema, next.schema);
  const libraries = diffLibraries(prev.libraries, next.libraries);
  const settings = diffSettings(prev.plan?.settings, next.plan?.settings);
  const plugins =
    prev.plugins && next.plugins
      ? {
          added: names(next.plugins.filter((p) => !prev.plugins.includes(p))),
          removed: names(prev.plugins.filter((p) => !next.plugins.includes(p))),
        }
      : null;
  const files = classifyFiles(changed);
  const rows = next.manifest?.rows ?? null;
  const release = {
    version: 1,
    uid: `${seq}-${randomBytes(4).toString('hex')}`,
    seq,
    /** The application version this deploy made (x.y.z), and which kind of release it was. Older releases have neither. */
    appVersion: version ?? null,
    bump: bump ?? null,
    title: (title || '').trim().slice(0, 200) || `Release ${seq}`,
    notes: (notes || '').trim().slice(0, 4000),
    createdAt: now(),
    by: by ?? null,
    devCommit: devCommit ?? null,
    commits: (commits ?? []).slice(0, 50),
    summary: {
      files,
      data: added?.data ?? null,
      records: rows,
      themes: added?.themes ?? [],
      plugins: added?.plugins ?? [],
    },
    changes: {
      schema,
      libraries,
      settings,
      plugins,
      migrations: migrationsNew,
      tables: next.plan?.tables ?? null,
    },
    steps: buildSteps({ schema, libraries, plugins, migrations: migrationsNew }),
  };
  return release;
}

const when = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const list = (items, f) => items.map((x) => `  - ${f(x)}`).join('\n');

/** The same notes as readable text, newest first, for anyone looking at the repository. */
export function renderMarkdown(releases) {
  const out = [
    '# Deploy notes',
    '',
    'Written by Operations → Deploy, one section per deploy, newest first. A deploy never removes or renames anything on a server: the "To do (optional)" lists are for you to do by hand if you want to.',
    '',
  ];
  for (const r of [...releases].sort((a, b) => b.seq - a.seq)) {
    out.push(
      `## ${r.appVersion ? `v${r.appVersion} · ` : ''}${r.seq}. ${r.title} (${when(r.createdAt)} UTC)`,
      '',
    );
    if (r.notes) out.push(r.notes, '');
    const f = r.summary.files;
    const bits = [
      f.pages.count && `${f.pages.count} page file${f.pages.count === 1 ? '' : 's'}`,
      f.components.count &&
        `${f.components.count} component file${f.components.count === 1 ? '' : 's'}`,
      f.themes.count && `${f.themes.count} theme file${f.themes.count === 1 ? '' : 's'}`,
      f.plugins.count && `${f.plugins.count} plugin file${f.plugins.count === 1 ? '' : 's'}`,
      f.migrations.count &&
        `${f.migrations.count} database migration${f.migrations.count === 1 ? '' : 's'}`,
      f.codeFiles && `${f.codeFiles} code file${f.codeFiles === 1 ? '' : 's'}`,
    ].filter(Boolean);
    out.push(`Changed: ${bits.join(', ') || 'nothing but data'}.`, '');
    const s = r.changes.schema;
    if (s && (s.tablesAdded.length || s.columnsAdded.length))
      out.push(
        'New structure (added automatically):',
        ...[
          ...s.tablesAdded.map((t) => `table ${t}`),
          ...s.columnsAdded.map((c) => `column ${c}`),
        ].map((x) => `  - ${x}`),
        '',
      );
    const l = r.changes.libraries;
    if (l && (l.added.length || l.updated.length))
      out.push(
        'Libraries:',
        ...l.added.map((x) => `  - added ${x.name} ${x.version}`),
        ...l.updated.map((x) => `  - updated ${x.name} ${x.from.version} → ${x.to.version}`),
        '',
      );
    if (r.changes.settings?.length)
      out.push(
        'Settings carried:',
        list(r.changes.settings.slice(0, 30), (x) => `${x.id}: ${x.from ?? '(not set)'} → ${x.to}`),
        '',
      );
    if (r.commits.length)
      out.push(
        'Source changes:',
        list(r.commits.slice(0, 20), (c) => c),
        '',
      );
    if (r.steps.length)
      out.push(
        'To do (optional):',
        ...r.steps.map((x) => `  - [ ] ${x.title}. ${x.detail} (${x.where})`),
        '',
      );
  }
  return `${out.join('\n')}\n`;
}

/** Writes the carried-over releases, the new one and the readable file into the deployment folder. */
export async function writeReleases(dir, releases) {
  const base = path.join(dir, RELEASES_DIR);
  await fs.mkdir(base, { recursive: true });
  for (const r of releases)
    await fs.writeFile(
      path.join(base, `${String(r.seq).padStart(4, '0')}.json`),
      JSON.stringify(r, null, 1),
    );
  await fs.writeFile(path.join(dir, NOTES_DIR, 'CHANGELOG.md'), renderMarkdown(releases));
}

/** New migration files since the last deploy, each read for what it would remove or rename (core/migration-guard.js). */
export async function newMigrations(appRoot, prevNames) {
  const have = new Set(prevNames ?? []);
  const out = [];
  const files = await fs.readdir(path.join(appRoot, 'migrations')).catch(() => []);
  for (const f of files.sort())
    if (f.endsWith('.js') && !have.has(f)) {
      const text = await fs.readFile(path.join(appRoot, 'migrations', f), 'utf8').catch(() => '');
      out.push({ file: f, destructive: scanMigration(text) });
    }
  return prevNames ? out : [];
}

// ───────────────────────────── the server's copy of the notes ─────────────────────────────

/** @param {any} ctx */
export function createDeployReleases(ctx) {
  const { db, audit } = ctx;
  const dia = dialect(db);

  const row = (r) => ({
    id: Number(r.id),
    uid: r.uid,
    seq: Number(r.seq),
    title: r.title,
    source: r.source,
    createdAt: Number(r.created_at),
    receivedAt: Number(r.received_at),
    unread: !r.read_at,
    version: JSON.parse(r.body).appVersion ?? null,
    bump: JSON.parse(r.body).bump ?? null,
    stepCount: JSON.parse(r.body).steps?.length ?? 0,
    stepsDone: JSON.parse(r.done || '[]').length,
    result: r.result ? JSON.parse(r.result) : null,
  });

  /** Does this server still have the thing a step is about? (Shown next to the step so a done step is visibly done.) */
  async function stillHere(step) {
    try {
      if (step.kind === 'drop-table')
        return (await dia.listTables()).some((t) => t.name === step.subject);
      if (step.kind === 'drop-column') {
        const [t, c] = step.subject.split('.');
        return (await dia.columnDetails(t)).some((x) => x.name === c);
      }
      if (step.kind === 'remove-library')
        return !!(await db('libraries').where({ name: step.subject }).first('id'));
      if (step.kind === 'remove-plugin')
        return !!(await db('plugins').where({ slug: step.subject }).first('id'));
    } catch {
      return null;
    }
    return null; // not something that can be checked
  }

  return {
    /** Stores a release read from the deployment repository (or just made here). Safe to call again for the same one. */
    async store(release, { source = 'deploy', result = null } = {}) {
      const exists = await db('deploy_releases').where({ uid: release.uid }).first('id');
      const base = {
        seq: release.seq,
        title: String(release.title).slice(0, 200),
        body: JSON.stringify(release),
        source,
        created_at: release.createdAt,
      };
      if (exists) {
        if (result)
          await db('deploy_releases')
            .where({ id: exists.id })
            .update({ result: JSON.stringify(result) });
        return Number(exists.id);
      }
      return dia.insertGetId(db('deploy_releases'), {
        uid: release.uid,
        ...base,
        received_at: now(),
        // The one who made it has read it; one that arrives by update is new to whoever updates.
        read_at: source === 'dev' ? now() : null,
        done: '[]',
        result: result ? JSON.stringify(result) : null,
      });
    },

    async list() {
      return (
        await db('deploy_releases').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(100)
      ).map(row);
    },

    /** Every release this server has, oldest first, as written (what a new package carries forward). */
    async allBodies() {
      return (await db('deploy_releases').orderBy('seq', 'asc').orderBy('id', 'asc')).map((r) =>
        JSON.parse(r.body),
      );
    },

    /** The version of the newest release this server has (made here or received), or null before any carried one. */
    async latestVersion() {
      let best = null;
      for (const r of await db('deploy_releases').orderBy('seq', 'desc').limit(20)) {
        const v = JSON.parse(r.body).appVersion;
        if (v && (!best || compareVersions(v, best) > 0)) best = v;
      }
      return best;
    },

    /** What changed in each version, newest first, for the Updates screen. Steps stay in Deploy → Release notes. */
    async changelog() {
      return (
        await db('deploy_releases').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(100)
      ).map((r) => {
        const b = JSON.parse(r.body);
        return {
          id: Number(r.id),
          seq: Number(r.seq),
          version: b.appVersion ?? null,
          bump: b.bump ?? null,
          title: r.title,
          notes: b.notes ?? '',
          by: b.by ?? null,
          createdAt: Number(r.created_at),
          receivedAt: Number(r.received_at),
          summary: b.summary?.files ?? null,
          schema: b.changes?.schema ?? null,
          libraries: b.changes?.libraries ?? null,
          commits: (b.commits ?? []).slice(0, 20),
          stepCount: b.steps?.length ?? 0,
        };
      });
    },

    async unread() {
      return Number((await db('deploy_releases').whereNull('read_at').count({ n: '*' }))[0].n);
    },

    async get(id) {
      const r = await db('deploy_releases')
        .where({ id: Number(id) })
        .first();
      if (!r) throw new HttpError(404, 'not_found', 'That release note was not found.');
      const body = JSON.parse(r.body);
      const done = new Set(JSON.parse(r.done || '[]'));
      const steps = [];
      for (const s of body.steps ?? [])
        steps.push({ ...s, done: done.has(s.id), stillHere: await stillHere(s) });
      return { ...row(r), release: { ...body, steps } };
    },

    async markRead(id) {
      await db('deploy_releases')
        .where({ id: Number(id) })
        .whereNull('read_at')
        .update({ read_at: now() });
    },

    async setStepDone(id, stepId, value, actor) {
      const r = await db('deploy_releases')
        .where({ id: Number(id) })
        .first();
      if (!r) throw new HttpError(404, 'not_found', 'That release note was not found.');
      if (!(JSON.parse(r.body).steps ?? []).some((s) => s.id === stepId))
        throw new HttpError(422, 'invalid_input', 'That step is not part of this release.');
      const done = new Set(JSON.parse(r.done || '[]'));
      if (value) done.add(stepId);
      else done.delete(stepId);
      await db('deploy_releases')
        .where({ id: r.id })
        .update({ done: JSON.stringify([...done]) });
      await audit.log({
        actor,
        action: 'deploy.step_done',
        entity: 'deploy',
        meta: { release: Number(r.seq), step: stepId, done: !!value },
      });
    },
  };
}
