import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import yauzl from 'yauzl';
import { dialect, now } from '../../core/db/index.js';
import { HttpError } from '../../core/http/errors.js';
import { DATA_PREFIX } from '../backup/service.js';
import { THEME_ID } from '../themes/package.js';
import { redact } from '../updates/service.js';

/** A run that has been "running" this long is taken to have died with its server, and no longer blocks a new one. */
const STALE_MS = 60 * 60_000;
const KEEP_RUNS = 30;

/** What the deployment repository's own .gitignore says: secrets and per-server data stay out, everything else goes in. */
export const DEPLOY_GITIGNORE = `# Written by Operations → Deploy. Everything the CMS needs to run is committed (including plugins/ and public/);
# what a server owns stays on that server and is never deployed.
node_modules/
/data/
.env
.env.*
*.log
.DS_Store
`;

/** Top-level folders and files that are never copied. `data/` holds media, libraries and the local database of the server it is on. */
const TOP_EXCLUDE = new Set(['data', '.git', '.claude', '.logs', 'logs', 'temp']);
const ANYWHERE_EXCLUDE = new Set(['node_modules', '.git', '.DS_Store']);

/** @param {string} rel path relative to the app folder, with forward slashes */
export function isExcluded(rel) {
  const parts = rel.split('/');
  if (TOP_EXCLUDE.has(parts[0])) return true;
  if (parts.some((p) => ANYWHERE_EXCLUDE.has(p))) return true;
  const name = parts[parts.length - 1];
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.log')) return true;
  // The site mirror's bookkeeping and hand-kept copies belong to the server they are on.
  if (parts[0] === 'public' && (name === '.site-mirror.json' || name.endsWith('.local')))
    return true;
  return false;
}

/** Where the data snapshot lives in the deployment repository. Production's Updates reads it back from here (D-131). */
export const DATA_DIR = 'deploy-data';

const safeJoin = (root, rel) => {
  const dest = path.resolve(root, rel);
  if (dest !== root && !dest.startsWith(root + path.sep))
    throw new Error(`"${rel}" would be written outside the deploy folder`);
  return dest;
};

/**
 * Operations → Deploy (D-130): copies this installation's code, plus what it keeps only in the database (installed themes
 * and plugins, the site tree), into a temporary folder tied to a deployment repository and pushes it.
 *
 * Nothing on the target is ever touched by this module. The repository holds code only; a production server pulls it
 * (Operations → Updates) and keeps its own database, `data/` folder and `.env`, so what it has gathered is never lost.
 *
 * @param {any} ctx
 */
export function createDeploy(ctx) {
  const { db, settings, audit, log, env, siteFiles, themes } = ctx;
  const insertGetId = dialect(db).insertGetId;
  const pending = new Set();

  /** Runs a program without a shell; resolves (never rejects) with its exit code and redacted output. */
  function run(cmd, args, cwd, { timeoutMs = 120_000 } = {}) {
    return new Promise((/** @type {(v: any) => void} */ resolve) => {
      let out = '';
      let timedOut = false;
      let child;
      try {
        child = spawn(cmd, args, { cwd, env: env.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return resolve({ code: -1, out: e.message });
      }
      const take = (b) => {
        out += b;
        if (out.length > 64_000) out = out.slice(-32_000);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({
          code: -1,
          out: e.code === 'ENOENT' ? `${cmd} is not installed or not on PATH` : e.message,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? -2 : code, out: redact(out).trim(), timedOut });
      });
    });
  }
  const lastLine = (t) =>
    String(t).trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);

  const toRow = (r) => ({
    id: Number(r.id),
    status: r.status,
    step: r.step,
    message: r.message,
    repo: r.repo,
    branch: r.branch,
    commit: r.commit,
    devCommit: r.dev_commit,
    changed: r.changed ?? null,
    include: r.include ? JSON.parse(r.include) : null,
    host: r.host,
    createdAt: Number(r.created_at),
    finishedAt: r.finished_at ? Number(r.finished_at) : null,
  });

  const target = () => ({
    url: redact(settings.get('deploy.repo_url')),
    branch: settings.get('deploy.branch'),
  });

  /** Things only this installation's database holds, which a copy of the folder would miss. */
  async function available() {
    return {
      data: !!ctx.backup,
      themes: themes
        .list()
        .filter((t) => t.source === 'db')
        .map((t) => ({ id: t.id, name: t.name })),
      plugins: (
        await db('plugins').where({ source: 'db' }).orderBy('slug').select('slug', 'name')
      ).map((p) => ({ slug: p.slug, name: p.name })),
    };
  }

  async function setStep(id, step) {
    await db('deploy_runs').where({ id }).update({ step });
  }

  async function copyCode(dest) {
    const root = ctx.appRoot;
    await fs.cp(root, dest, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = path.relative(root, src).split(path.sep).join('/');
        return rel === '' || !isExcluded(rel);
      },
    });
  }

  async function addThemes(dir, ids) {
    const written = [];
    for (const id of ids) {
      if (!THEME_ID.test(id) || !themes.list().some((t) => t.id === id && t.source === 'db'))
        continue;
      const base = safeJoin(dir, `site/themes/${id}`);
      await fs.rm(base, { recursive: true, force: true });
      for (const [p, f] of (await themes.runtime(id)).files) {
        const dest = safeJoin(base, p);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, Buffer.from(f.content, f.encoding === 'utf8' ? 'utf8' : 'base64'));
      }
      written.push(id);
    }
    return written;
  }

  async function addPlugins(dir, slugs) {
    const written = [];
    for (const slug of slugs) {
      const row = await db('plugins').where({ slug, source: 'db' }).first('package');
      if (!row?.package) continue;
      const base = safeJoin(dir, `plugins/${slug}`);
      await fs.rm(base, { recursive: true, force: true });
      for (const e of new AdmZip(Buffer.from(row.package, 'base64')).getEntries()) {
        if (e.isDirectory) continue;
        const dest = safeJoin(base, e.entryName);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, e.getData());
      }
      written.push(slug);
    }
    return written;
  }

  /** Unpacks a zip into a folder, entry by entry, refusing anything that would land outside it. */
  function unzipTo(file, dest) {
    return new Promise((resolve, reject) => {
      yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('The snapshot could not be read.'));
        zip.on('error', reject);
        zip.on('end', resolve);
        zip.on('entry', async (entry) => {
          try {
            if (!entry.fileName.endsWith('/')) {
              const out = safeJoin(dest, entry.fileName);
              await fs.mkdir(path.dirname(out), { recursive: true });
              const stream = await new Promise((res, rej) =>
                zip.openReadStream(entry, (e, st) => (e || !st ? rej(e) : res(st))),
              );
              await pipeline(stream, createWriteStream(out));
            }
            zip.readEntry();
          } catch (e) {
            zip.close();
            reject(e);
          }
        });
        zip.readEntry();
      });
    });
  }

  /**
   * A snapshot of the data people create (do_/sys_/data_ tables, plus the media records and files when asked), in the Backups
   * format but unpacked into the repository, so git stores a media file once however many deploys carry it. Secrets are
   * removed: an encrypted value is only readable with the master key of the server that wrote it.
   */
  async function addData(dir, { media }) {
    const backup = ctx.backup;
    if (!backup)
      throw new Error(
        'Backups are switched off on this server, so the data cannot be included. Turn the Backups module on, or untick the data option.',
      );
    const present = (await dialect(db).listTables()).filter((t) => !t.view).map((t) => t.name);
    const tables = present.filter((n) => DATA_PREFIX.test(n));
    if (media) tables.push(...['media', 'media_folders'].filter((n) => present.includes(n)));
    let row;
    try {
      row = await backup.create(
        {
          name: 'Deploy snapshot',
          source: 'deploy',
          includeMedia: media,
          secrets: 'remove',
          folders: [],
          tables,
        },
        null,
      );
    } catch (e) {
      throw new Error(
        `The data snapshot could not start (${e.message}). Try again once Backups is free.`,
        { cause: e },
      );
    }
    await backup.idle();
    const done = await backup.get(row.id);
    if (done.status !== 'ready')
      throw new Error(
        `The data snapshot failed (${done.error || 'unknown error'}), so nothing was deployed.`,
      );
    const tmp = path.join(os.tmpdir(), `deploy-snapshot-${row.id}.zip`);
    try {
      const { stream } = await backup.open(row.id);
      await pipeline(stream, createWriteStream(tmp));
      const out = path.join(dir, DATA_DIR);
      await fs.rm(out, { recursive: true, force: true });
      await unzipTo(tmp, out);
      // When and by whom it was made is not data; leaving it in would make every deploy look different.
      const file = path.join(out, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.createdAt = 0;
      manifest.createdBy = null;
      await fs.writeFile(file, JSON.stringify(manifest));
      return {
        tables: Object.keys(manifest.tables ?? {}).length,
        rows: manifest.rows ?? 0,
        media: manifest.media?.files ?? 0,
      };
    } finally {
      await fs.rm(tmp, { force: true });
      await backup.remove(row.id, null).catch(() => {});
    }
  }

  async function execute(runId, { include, actor }) {
    const dir = path.join(os.tmpdir(), 'deploy');
    const url = settings.get('deploy.repo_url');
    const branch = settings.get('deploy.branch');
    const g = (...args) => run('git', args, dir);
    const step = (s) => setStep(runId, s);
    try {
      await step('Preparing the deploy folder');
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      if ((await g('init')).code !== 0)
        throw new Error('Git is not installed on this server, so it cannot deploy.');
      await g('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
      await g('remote', 'add', 'origin', url);

      await step('Reading the deployment repository');
      const heads = await run(
        'git',
        ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
        dir,
      );
      if (heads.code !== 0)
        throw new Error(
          `Couldn't reach ${redact(url)}: ${heads.timedOut ? 'it took too long' : lastLine(heads.out) || 'unknown error'}. Check the URL, and that this server has push access (an SSH key or a stored credential).`,
        );
      let previous = null;
      if (heads.out) {
        const f = await run(
          'git',
          ['fetch', '--depth', '1', 'origin', `refs/heads/${branch}`],
          dir,
          {
            timeoutMs: 600_000,
          },
        );
        if (f.code !== 0) throw new Error(`Couldn't fetch "${branch}": ${lastLine(f.out)}.`);
        await g('reset', '--hard', 'FETCH_HEAD');
        previous = (await g('rev-parse', 'HEAD')).out;
      }

      // Start from an empty working tree so a file deleted here is deleted in the repository too.
      for (const e of await fs.readdir(dir))
        if (e !== '.git') await fs.rm(path.join(dir, e), { recursive: true, force: true });

      await step('Copying the code');
      await copyCode(dir);

      const added = { siteTree: false, themes: [], plugins: [], data: null };
      if (include.siteTree) {
        await step('Writing the site pages and components');
        await fs.rm(path.join(dir, 'public'), { recursive: true, force: true });
        await siteFiles.exportTo(path.join(dir, 'public'));
        added.siteTree = true;
      }
      if (include.themes.length) {
        await step('Adding installed themes');
        added.themes = await addThemes(dir, include.themes);
      }
      if (include.plugins.length) {
        await step('Adding installed plugins');
        added.plugins = await addPlugins(dir, include.plugins);
      }
      if (include.data) {
        await step(
          include.media
            ? 'Taking a snapshot of the data and media'
            : 'Taking a snapshot of the data',
        );
        added.data = await addData(dir, { media: include.media });
      }
      await fs.writeFile(path.join(dir, '.gitignore'), DEPLOY_GITIGNORE);

      await step('Committing');
      await g('add', '-A');
      const changedFiles = (await g('diff', '--cached', '--name-only')).out
        .split('\n')
        .filter(Boolean);
      const dev = await run('git', ['rev-parse', 'HEAD'], ctx.appRoot);
      const devCommit = dev.code === 0 ? dev.out.slice(0, 40) : null;
      let commit = previous;
      if (changedFiles.length) {
        const who = actor?.email ?? 'the scheduler';
        const c = await run(
          'git',
          [
            '-c',
            'user.name=CMS Deploy',
            '-c',
            'user.email=deploy@cms.invalid',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-q',
            '-m',
            `Deploy from ${os.hostname()} by ${who}${devCommit ? `\n\nSource commit: ${devCommit}` : ''}`,
          ],
          dir,
        );
        if (c.code !== 0) throw new Error(`Git couldn't commit: ${lastLine(c.out)}.`);
        commit = (await g('rev-parse', 'HEAD')).out;

        await step('Pushing');
        const push = await run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], dir, {
          timeoutMs: 600_000,
        });
        if (push.code !== 0)
          throw new Error(
            /non-fast-forward|rejected|fetch first/i.test(push.out)
              ? `Someone else pushed to "${branch}" while this deploy was running. Nothing was overwritten; run the deploy again.`
              : `Couldn't push to ${redact(url)}: ${push.timedOut ? 'it took too long' : lastLine(push.out) || 'unknown error'}. This server needs push access to the repository.`,
          );
      }
      const message = changedFiles.length
        ? `Deployed ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'} to ${branch} (${commit.slice(0, 7)}).`
        : `Nothing changed since the last deploy (${(commit ?? '').slice(0, 7) || 'empty repository'}).`;
      await db('deploy_runs')
        .where({ id: runId })
        .update({
          status: 'done',
          step: null,
          message,
          commit,
          dev_commit: devCommit,
          changed: changedFiles.length,
          include: JSON.stringify(added),
          finished_at: now(),
        });
      await audit.log({
        actor,
        action: 'deploy.run',
        entity: 'deploy',
        entityId: runId,
        meta: {
          repo: redact(url),
          branch,
          commit: commit?.slice(0, 12),
          changed: changedFiles.length,
          ...added,
        },
      });
    } catch (e) {
      log?.warn({ err: e.message }, 'deploy: failed');
      const message = redact(e.message);
      await db('deploy_runs')
        .where({ id: runId })
        .update({ status: 'failed', step: null, message, finished_at: now() })
        .catch(() => {});
      await audit
        .log({
          actor,
          action: 'deploy.failed',
          entity: 'deploy',
          entityId: runId,
          meta: { repo: redact(url), branch, message },
        })
        .catch(() => {});
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      const old = await db('deploy_runs')
        .orderBy('id', 'desc')
        .offset(KEEP_RUNS)
        .select('id')
        .catch(() => []);
      if (old.length)
        await db('deploy_runs')
          .whereIn(
            'id',
            old.map((r) => r.id),
          )
          .delete()
          .catch(() => {});
    }
  }

  return {
    /** Waits for a running deploy (tests, and a clean shutdown). */
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },

    target,

    async overview() {
      const runs = (await db('deploy_runs').orderBy('id', 'desc').limit(15)).map(toRow);
      return { target: target(), runs, available: await available() };
    },

    /** Saves where deploys go. Credentials in a URL are refused by the setting's own validation. */
    async setTarget({ url, branch }, actor) {
      await settings.update('deploy', { values: { repo_url: url, branch } }, actor);
      await audit.log({
        actor,
        action: 'deploy.target',
        entity: 'deploy',
        meta: { repo: redact(url), branch },
      });
    },

    /**
     * Starts a deploy. Returns the new run at once; the work continues in the background and the row turns done or failed.
     * @param {{ themes?: string[], plugins?: string[], siteTree?: boolean, data?: boolean, media?: boolean }} include
     */
    async start(include, actor) {
      const url = settings.get('deploy.repo_url');
      if (!url)
        throw new HttpError(
          409,
          'no_target',
          'Choose the deployment repository first (a git URL and a branch), save it, then deploy.',
        );
      const busy = await db('deploy_runs')
        .where({ status: 'running' })
        .andWhere('created_at', '>', now() - STALE_MS)
        .first();
      if (busy)
        throw new HttpError(409, 'busy', 'A deploy is already running. Wait for it to finish.');
      await db('deploy_runs').where({ status: 'running' }).update({
        status: 'failed',
        message: 'The server running this deploy stopped before it finished.',
        finished_at: now(),
      });
      const chosen = {
        themes: [...new Set(include.themes ?? [])],
        plugins: [...new Set(include.plugins ?? [])],
        siteTree: include.siteTree !== false,
        data: include.data !== false && !!ctx.backup,
        media: include.media !== false,
      };
      const id = await insertGetId(db('deploy_runs'), {
        status: 'running',
        step: 'Starting',
        repo: redact(url),
        branch: settings.get('deploy.branch'),
        node_id: env.nodeId,
        host: os.hostname().slice(0, 190),
        created_by: actor?.id ?? null,
        created_at: now(),
      });
      const job = execute(id, { include: chosen, actor });
      pending.add(job);
      job.finally(() => pending.delete(job));
      return toRow(await db('deploy_runs').where({ id }).first());
    },
  };
}
