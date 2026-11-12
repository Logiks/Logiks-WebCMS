import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { createWriteStream, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { DATA_DIR } from '../deploy/service.js';
import { sameWithoutVersion } from '../deploy/release.js';

export { sameWithoutVersion };
import { scanMigration } from '../../core/migration-guard.js';
import { dialect } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import {
  HEALTHY_AFTER_MS,
  clearPending,
  markPending,
  takeRolledBack,
} from '../../core/update-guard.js';

const CHANNEL = 'updates:cmd';
/** Updates always come from the configured source URL, through this git remote that the app keeps pointed at it. */
export const SOURCE_REMOTE = 'cms-source';
const MAX_INCOMING = 20;
/** Restore points kept per server (and the safety backups that went with them). */
export const KEEP_RESTORE_POINTS = 5;

/** Credentials that git or npm may echo back (https://user:token@host, npm auth tokens) never leave this module. */
export const redact = (text) =>
  String(text ?? '')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/(_auth(?:Token)?|_password)\s*=\s*\S+/gi, '$1=***');

/** 'auto' means: let a supervisor restart us if there is one, otherwise start a new copy ourselves. */
export const resolveRestartMode = (setting, supervised) =>
  setting === 'auto' ? (supervised ? 'supervisor' : 'self') : setting;

/** Which follow-up work a set of changed files needs. Paths are relative to the app folder. */
export function classifyChanges(files) {
  return {
    needsInstall: files.some((f) => f === 'package.json' || f === 'package-lock.json'),
    needsMigrate: files.some((f) => f.startsWith('migrations/')),
  };
}

const lastLine = (text) =>
  String(text).trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);

/**
 * Updates this server's own git checkout and restarts it. One server at a time: every server has its own copy of the code,
 * so the admin picks which one to act on and the request is routed to it over the bus (`updates:cmd`). Progress and the
 * outcome are written into the server's heartbeat row, which is how any other server (and the admin page) can read them.
 *
 * Before new code is applied the server records a restore point (the commit it was on), and can optionally take a backup; a
 * rollback puts that commit back (code only: migrations only add, so older code runs on the newer database). If the new code
 * will not even start, the update guard (core/update-guard.js) does the same before the app loads.
 *
 * Safe by construction: fast-forward only, refuses a checkout with local changes, never discards anything, runs git and npm
 * without a shell, and refuses to restart a production server that has pending migrations (it would not come back up).
 *
 * @param {{env: import('../../core/env.js').Env, db: import('knex').Knex, settings: any, bus: any, audit: any, nodes: any,
 *   state: any, log: import('pino').Logger, appRoot: string, getBackup?: () => any, getSiteFiles?: () => any, getDeploySync?: () => any, getDeployReleases?: () => any}} deps
 */
export function createUpdatesService({
  env,
  db,
  settings,
  bus,
  audit,
  nodes,
  state,
  log,
  appRoot,
  getBackup = () => null,
  getSiteFiles = () => null,
  getDeploySync = () => null,
  getDeployReleases = () => null,
}) {
  let stopped = false;
  let bootCommit = null;
  let healthyTimer = null;
  // Names this checkout on this host: unlike the node id it survives restarts, so restore points stay with the server.
  const serverKey = createHash('sha1').update(`${os.hostname()}|${appRoot}`).digest('hex');
  let st = {
    key: serverKey,
    op: null,
    status: 'idle',
    step: null,
    message: null,
    at: null,
    git: null,
  };

  const set = (patch) => {
    if (stopped) return;
    st = { ...st, ...patch, at: Date.now() };
    nodes.refresh();
  };

  /** Runs a program without a shell; resolves (never rejects) with its exit code and redacted output. */
  function run(cmd, args, { timeoutMs = 60_000, onOutput = null } = {}) {
    return new Promise((/** @type {(v: any) => void} */ resolve) => {
      let out = '';
      let timedOut = false;
      let child;
      try {
        child = spawn(cmd, args, {
          cwd: appRoot,
          env: env.childEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        return resolve({ code: -1, out: e.message, missing: e.code === 'ENOENT' });
      }
      const take = (b) => {
        onOutput?.(String(b));
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
        const missing = e.code === 'ENOENT';
        resolve({
          code: -1,
          out: missing ? `${cmd} is not installed or not on PATH` : e.message,
          missing,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? -2 : code, out: redact(out).trim(), timedOut });
      });
    });
  }
  const git = (...args) => run('git', args);

  /** Shows what `npm ci` is doing on the Updates page (at most once a second), so a slow install doesn't look like a hang. */
  function installProgress() {
    let last = 0;
    return (chunk) => {
      const line = redact(chunk).trim().split('\n').filter(Boolean).pop();
      if (!line || Date.now() - last < 1000) return;
      last = Date.now();
      alive();
      set({ step: `Installing dependencies: ${line.replace(/^npm /, '').slice(0, 100)}` });
    };
  }

  /** One file as it is at a commit, whole (`run` keeps only the tail of long output, and a lockfile is long). */
  const showFile = (ref, file) =>
    new Promise((resolve) =>
      execFile(
        'git',
        ['show', `${ref}:${file}`],
        { cwd: appRoot, env: env.childEnv(), maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : stdout),
      ),
    );

  /**
   * A file this server created by hand (say a `.nvmrc`) that the incoming commits also add would make `git merge` refuse
   * ("untracked working tree files would be overwritten"). When the content is identical the local copy is simply removed (the
   * update brings it back); otherwise it is renamed to `<name>.local-<time>` so nothing is lost.
   * @returns {Promise<string[]>} the files that were renamed
   */
  async function clearUntrackedCollisions(ref) {
    const added = (
      await git('diff', '--name-only', '--relative', '--diff-filter=A', 'HEAD', ref)
    ).out
      .split('\n')
      .filter(Boolean);
    if (!added.length) return [];
    const local = (await git('ls-files', '--others', '--', ...added)).out
      .split('\n')
      .filter(Boolean);
    const renamed = [];
    for (const f of local) {
      const abs = path.join(appRoot, f);
      try {
        const incoming = await showFile(ref, `./${f}`);
        if (incoming !== null && fs.readFileSync(abs, 'utf8') === incoming) fs.rmSync(abs);
        else {
          fs.renameSync(abs, `${abs}.local-${Date.now()}`);
          renamed.push(f);
        }
      } catch {
        // unreadable or already gone: git reports it if it still gets in the way
      }
    }
    return renamed;
  }

  /** `classifyChanges`, but a dependency file that only had its version bumped does not count as an install. */
  async function classifyBetween(files, from, to) {
    const c = classifyChanges(files);
    if (!c.needsInstall) return c;
    for (const f of ['package.json', 'package-lock.json'])
      if (files.includes(f)) {
        const [a, b] = await Promise.all([showFile(from, f), showFile(to, f)]);
        if (a === null || b === null || !sameWithoutVersion(a, b)) return c;
      }
    return { ...c, needsInstall: false };
  }

  /** The site mirror (SITE_DIR) as a git pathspec to leave out, when it sits inside this checkout. */
  function mirrorPathspec() {
    const rel = path.relative(appRoot, path.resolve(env.SITE_DIR)).split(path.sep).join('/');
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? [`:(exclude)${rel}`] : [];
  }

  /**
   * Local edits to tracked files (typically `npm install` rewriting package.json / package-lock.json, or a hand edit) must not
   * make an admin run git commands. They are stashed before the code moves and popped right after; when they no longer apply
   * on top of the new code, the checkout is cleaned and they stay in the stash (never dropped), with a note in the result.
   */
  async function stashLocal() {
    const spec = ['.', ...mirrorPathspec()];
    if ((await git('status', '--porcelain', '--untracked-files=no', '--', ...spec)).out === '')
      return false;
    const r = await git(
      'stash',
      'push',
      '-m',
      'CMS update: local changes set aside',
      '--',
      ...spec,
    );
    return r.code === 0 && !/No local changes/i.test(r.out);
  }

  /** @returns {Promise<string>} a sentence for the result message ('' when nothing was stashed) */
  async function restoreLocal(stashed) {
    if (!stashed) return '';
    if ((await git('stash', 'pop')).code === 0)
      return ' Your local changes to tracked files were put back.';
    await git('reset', '--hard', 'HEAD'); // a failed pop leaves conflict markers; the stash itself is kept
    return ' Your local changes to tracked files no longer apply on top of this version, so they were left in "git stash" (see git stash list).';
  }

  /** Reads the checkout. `git` is fast and local here; nothing touches the network. */
  async function readGit() {
    const top = await git('rev-parse', '--show-toplevel');
    if (top.missing)
      return {
        supported: false,
        reason: 'no_git',
        message: 'Git is not installed on this server, so it cannot update itself.',
      };
    if (top.code !== 0)
      return /dubious ownership/i.test(top.out)
        ? {
            supported: false,
            reason: 'unsafe_owner',
            message:
              'Git will not use this folder because it belongs to a different user than the one running the app. Run "git config --global --add safe.directory <folder>" as that user.',
          }
        : {
            supported: false,
            reason: 'not_a_repo',
            message:
              "This server isn't running from a git checkout, so it can't update itself. Deploy a new build instead (for Docker: rebuild the image and roll the containers).",
          };

    const remote = SOURCE_REMOTE;
    const sourceBranch = settings.get('updates.source_branch');
    const sourceUrl = settings.get('updates.source_url');
    const head = (await git('rev-parse', 'HEAD')).out;
    const branchRes = await git('symbolic-ref', '--short', '-q', 'HEAD');
    const branch = branchRes.code === 0 ? branchRes.out : null;
    const [meta] = (await git('log', '-1', '--format=%h%x1f%s%x1f%an%x1f%at')).out.split('\n');
    const [short, subject, author, at] = (meta ?? '').split('\x1f');
    // A deployed checkout tracks the site mirror (Operations → Deploy). The app rewrites it whenever the site is edited, which
    // is not a change anyone made to the code, so it never counts as "local changes".
    const mirror = mirrorPathspec();
    const dirty =
      (await git('status', '--porcelain', '--untracked-files=no', '--', '.', ...mirror)).out !== '';
    const url = { code: 0, out: redact(sourceUrl) };

    const info = {
      supported: true,
      head: short ?? null,
      headFull: head,
      subject: subject ?? '',
      author: author ?? '',
      committedAt: Number(at) * 1000 || null,
      branch,
      remote,
      sourceUrl: redact(sourceUrl),
      sourceBranch,
      remoteUrl: url.out,
      dirty,
      ahead: null,
      behind: null,
      incoming: [],
      needsInstall: false,
      needsMigrate: false,
      fetchedAt: null,
      blocker: null,
    };
    if (!branch) info.blocker = 'detached';

    if (branch) {
      const ref = `refs/remotes/${remote}/${sourceBranch}`;
      if ((await git('rev-parse', '--verify', '-q', ref)).code === 0) {
        const [ahead, behind] = (
          await git('rev-list', '--left-right', '--count', `HEAD...${ref}`)
        ).out
          .split(/\s+/)
          .map(Number);
        info.ahead = ahead;
        info.behind = behind;
        if (behind > 0) {
          info.incoming = (
            await git(
              'log',
              `--format=%h%x1f%s%x1f%an%x1f%at`,
              '-n',
              String(MAX_INCOMING),
              `HEAD..${ref}`,
            )
          ).out
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              const [sha, subj, who, when] = l.split('\x1f');
              return { sha, subject: subj, author: who, at: Number(when) * 1000 };
            });
          const files = (await git('diff', '--name-only', '--relative', 'HEAD', ref)).out
            .split('\n')
            .filter(Boolean);
          Object.assign(info, await classifyBetween(files, 'HEAD', ref));
          if (ahead > 0 && !info.blocker) info.blocker = 'diverged';
        }
      }
      const fh = (await git('rev-parse', '--git-path', 'FETCH_HEAD')).out;
      try {
        if (fh) info.fetchedAt = statSync(path.resolve(appRoot, fh)).mtimeMs;
      } catch {
        /* never fetched */
      }
    }
    return info;
  }

  const blockerMessage = (g) =>
    ({
      detached:
        'This server is on a detached commit, not a branch. Check out a branch (git checkout <branch>) and try again.',
      diverged:
        "This checkout has commits that aren't on the remote, so it can't fast-forward. Push or remove them, then try again.",
    })[g.blocker];

  const actorInfo = (a) => (a ? { id: a.id, email: a.email, ip: a.ip } : null);
  const alive = () => {
    if (state.draining) throw new StepError('This server is shutting down.');
  };

  async function fail(op, actor, e) {
    const message =
      e instanceof StepError ? e.message : 'Something unexpected went wrong. See the server log.';
    if (!(e instanceof StepError)) log.error({ err: e }, `updates: ${op} crashed`);
    await audit.log({
      actor: actorInfo(actor),
      action: `updates.${op}_failed`,
      entity: 'server',
      entityId: env.nodeId,
      meta: { host: hostName(), message },
    });
    // Published after the audit entry, so "failed" always means "recorded".
    set({ status: 'failed', step: null, message });
  }

  const hostName = () => os.hostname();

  async function check(actor) {
    try {
      set({ op: 'check', status: 'running', step: 'Fetching from the remote', message: null });
      const g = await readGit();
      if (!g.supported) throw new StepError(g.message);
      if (!g.branch) throw new StepError(blockerMessage(g));
      await fetchRemote(g);
      const after = await readGit();
      const risky = after.behind > 0 ? await destructiveIncoming(after) : [];
      const warning = risky.length
        ? ` Warning: it changes the database in a way that removes or renames data: ${destructiveMessage(risky)}. It will not be applied until Settings → Updates allows it.`
        : '';
      await audit.log({
        actor: actorInfo(actor),
        action: 'updates.check',
        entity: 'server',
        entityId: env.nodeId,
        meta: { host: hostName(), behind: after.behind },
      });
      // Every outcome is published after its audit entry, so "done" always means "recorded".
      set({
        status: 'done',
        step: null,
        git: after,
        message: after.behind
          ? `${after.behind} update${after.behind === 1 ? '' : 's'} available.${warning}`
          : 'Up to date.',
      });
    } catch (e) {
      await fail('check', actor, e);
    }
  }

  /**
   * Database changes in the incoming commits that would remove or rename data (D-135): the NEW migration files between this
   * checkout and the remote branch, scanned by core/migration-guard.js. Read from git, so nothing is applied to find out.
   */
  async function destructiveIncoming(g) {
    const ref = `refs/remotes/${g.remote}/${g.sourceBranch}`;
    const diff = await git(
      'diff',
      '--name-only',
      '--diff-filter=A',
      'HEAD',
      ref,
      '--',
      'migrations',
    );
    if (diff.code !== 0) return [];
    const out = [];
    for (const file of diff.out.split('\n').filter((f) => /^migrations\/[\w.-]+\.js$/.test(f))) {
      const shown = await git('show', `${ref}:${file}`);
      if (shown.code !== 0) continue;
      const found = scanMigration(shown.out);
      if (found.length) out.push({ file: file.slice('migrations/'.length), found });
    }
    return out;
  }
  const destructiveMessage = (list) =>
    `${list.map((d) => `${d.file} (${d.found.join('; ')})`).join(', ')}`;

  async function fetchRemote(g) {
    alive();
    // Keep the managed remote pointing at the configured source, so the URL is only ever set here.
    const url = settings.get('updates.source_url');
    const set = (await git('remote', 'get-url', SOURCE_REMOTE)).code === 0 ? 'set-url' : 'add';
    const pointed = await git('remote', set, SOURCE_REMOTE, url);
    if (pointed.code !== 0)
      throw new StepError(`Couldn't use the update source: ${lastLine(pointed.out)}.`);
    const b = g.sourceBranch;
    const r = await run(
      'git',
      ['fetch', SOURCE_REMOTE, `+refs/heads/${b}:refs/remotes/${SOURCE_REMOTE}/${b}`],
      { timeoutMs: 120_000 },
    );
    if (r.code !== 0)
      throw new StepError(
        `Couldn't fetch branch "${b}" from ${g.sourceUrl}: ${r.timedOut ? 'it took too long' : lastLine(r.out) || 'unknown error'}. Check the source URL and branch, and that this server can reach it and has read access.`,
      );
  }

  /**
   * The steps that complete an update once the code is in place: reinstall dependencies when the lockfile changed, then
   * run the database migrations the new code brings. `onlyIfPending` skips the migration run when there is nothing to do.
   */
  async function finishInstall({ needsInstall, onlyIfPending = false }, done) {
    const codeNow = `Code is now at the new version, but`;
    if (needsInstall && settings.get('updates.install_dependencies')) {
      alive();
      set({ step: 'Installing dependencies' });
      const r = await run(
        'npm',
        ['ci', '--no-audit', '--no-fund', '--loglevel=http', ...(env.isProd ? ['--omit=dev'] : [])],
        { timeoutMs: 15 * 60_000, onOutput: installProgress() },
      );
      if (r.code !== 0)
        throw new StepError(
          `${codeNow} installing dependencies failed: ${lastLine(r.out) || 'npm did not finish'}. Run "npm ci" in the app folder, then restart.`,
        );
      done('install');
    }
    if (settings.get('updates.run_migrations')) {
      if (onlyIfPending) {
        const pending = await db.migrate.list().then(
          ([, p]) => p.length,
          () => 0,
        );
        if (!pending) return;
      }
      alive();
      set({ step: 'Running database migrations' });
      const r = await run(process.execPath, ['src/cli/index.js', 'migrate'], {
        timeoutMs: 10 * 60_000,
      });
      if (r.code !== 0)
        throw new StepError(
          `${codeNow} the database migration failed: ${lastLine(r.out) || 'no output'}. Fix it and run "npm run migrate" before restarting.`,
        );
      done('migrate');
    }
  }

  /** Every file under a folder, as paths relative to it (forward slashes), sorted. */
  async function listFiles(root, rel = '') {
    const out = [];
    for (const e of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await listFiles(root, r)));
      else if (e.isFile()) out.push(r);
    }
    return out.sort();
  }

  /** Packs the unpacked data snapshot (deploy-data/) back into a backup zip; the manifest goes last, as Backups expects. */
  async function zipSnapshot(dir, file) {
    const zip = new yazl.ZipFile();
    const names = await listFiles(dir);
    // sync.json is the deployer's plan for the records step, not part of a backup.
    for (const n of names.filter((x) => x !== 'manifest.json' && x !== 'sync.json'))
      zip.addFile(path.join(dir, n), n);
    zip.addFile(path.join(dir, 'manifest.json'), 'manifest.json');
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(file));
  }

  /**
   * After a pull from a deployment repository (Operations → Deploy), bring in what the repository carries besides code:
   * (1) the site pages and components that CHANGED between the old and the new commit, written to this server's site tree
   * (the change history can revert them); pages only edited here are left alone; (2) the data snapshot, which only ADDS
   * what this server lacks. Nothing here deletes or overwrites a record. Problems are returned, not thrown: the code is
   * already updated and the admin should see exactly what did not come across.
   */
  async function importDeployment(from, actor) {
    const out = { pages: null, data: null, sync: null, notes: 0, problems: [] };
    const diff = await git(
      'diff',
      '--name-status',
      '--no-renames',
      from,
      'HEAD',
      '--',
      'public',
      DATA_DIR,
      'deploy-notes',
    );
    if (diff.code !== 0) return out;
    const changes = diff.out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [status, file] = l.split('\t');
        return { status: status[0], file };
      });
    return importChanges(
      changes,
      appRoot,
      (await git('rev-parse', 'HEAD')).out.slice(0, 40),
      actor,
    );
  }

  /**
   * Brings in what a deployment carries besides code, from files under `root`: pages (`public/`), the data snapshot
   * (`deploy-data/`) and the release notes (`deploy-notes/`). `changes` says which of them to read, as `git diff --name-status`
   * would: a git update passes what changed between two commits, an offline package passes everything it holds.
   * @param {{status: string, file: string}[]} changes @param {string} root @param {string} label names this deployment in the records step
   */
  async function importChanges(changes, root, label, actor) {
    const out = { pages: null, data: null, sync: null, notes: 0, problems: [] };
    const siteFiles = getSiteFiles();
    if (settings.get('updates.import_site') && siteFiles) {
      const res = { written: 0, removed: 0 };
      // Everything goes in ONE save. Each save makes this server rewrite its public/ mirror from the database, and a rewrite that
      // runs while some incoming files are not saved yet sees them as hand edits: it keeps them as `<file>.local` and puts the old
      // page back. After one save the database and the files just merged agree, so the mirror has nothing to change.
      /** @type {{path: string, content: string}[]} */
      const writes = [];
      /** @type {string[]} */
      const deletes = [];
      for (const c of changes.filter((x) => x.file.startsWith('public/'))) {
        const rel = c.file.slice('public/'.length);
        if (rel === '.site-mirror.json' || rel.endsWith('.local')) continue;
        try {
          if (c.status === 'D') {
            if (siteFiles.list().some((f) => f.path === rel)) deletes.push(rel);
          } else {
            const content = await fsp.readFile(path.join(root, c.file), 'utf8');
            siteFiles.validate(rel, content); // one bad page is reported, not allowed to stop the others
            writes.push({ path: rel, content });
          }
        } catch (e) {
          out.problems.push(`${rel}: ${e.message}`);
        }
      }
      try {
        const r = await siteFiles.apply({ writes, deletes }, actor);
        res.written = r?.written?.length ?? writes.length;
        res.removed = r?.removed?.length ?? deletes.length;
      } catch (e) {
        out.problems.push(`pages: ${e.message}`);
      }
      if (res.written || res.removed) out.pages = res;
    }

    const backup = getBackup();
    if (
      settings.get('updates.import_data') &&
      changes.some((c) => c.file.startsWith(`${DATA_DIR}/`) && c.status !== 'D')
    ) {
      if (!backup)
        out.problems.push('data: Backups is switched off here, so the data was not added.');
      else {
        const tmp = path.join(os.tmpdir(), `deploy-import-${process.pid}-${Date.now()}.zip`);
        let id = null;
        try {
          set({ step: 'Adding the data that came with the update' });
          await zipSnapshot(path.join(root, DATA_DIR), tmp);
          id = (await backup.upload(tmp, 'Deployed data', actor, { source: 'deploy' })).id;
          await backup.restore(id, { confirm: 'RESTORE' }, actor);
          await backup.idle();
          const status = await backup.status();
          if (status.error) throw new Error(status.error);
          out.data = status.result ?? { restored: true };
        } catch (e) {
          out.problems.push(`data: ${e.message}`);
        } finally {
          await fsp.rm(tmp, { force: true });
          if (id) await backup.remove(id, null).catch(() => {});
        }
      }
    }
    // Records matched by their natural key (content, users, menus, settings…): added, updated only when nobody changed them
    // here, otherwise left as a conflict for a person to tick. Nothing is deleted. Which tables is the deployer's choice.
    const sync = getDeploySync();
    if (
      settings.get('updates.import_data') &&
      sync &&
      changes.some((c) => c.file.startsWith(`${DATA_DIR}/`) && c.status !== 'D')
    ) {
      try {
        set({ step: 'Bringing in the chosen records' });
        const r = await sync.importFrom(path.join(root, DATA_DIR), actor, label);
        const tot = Object.values(r.tables).reduce(
          (a, t) => ({ added: a.added + t.added, updated: a.updated + t.updated }),
          { added: 0, updated: 0 },
        );
        if (tot.added || tot.updated || r.conflicts)
          out.sync = { ...tot, conflicts: r.conflicts, removedOnDev: r.removedOnDev };
        out.problems.push(...r.problems);
      } catch (e) {
        out.problems.push(`records: ${e.message}`);
      }
    }

    // The deployer's release notes: stored so they can be read later (Operations → Deploy → Release notes). The newest one
    // also records what bringing this update in did here.
    const releases = getDeployReleases();
    const noteFiles = changes
      .filter((c) => c.status !== 'D' && /^deploy-notes\/releases\/\d+\.json$/.test(c.file))
      .map((c) => c.file)
      .sort();
    if (releases && noteFiles.length) {
      const result = {
        added: out.sync?.added ?? 0,
        updated: out.sync?.updated ?? 0,
        conflicts: out.sync?.conflicts ?? 0,
        removedOnDev: out.sync?.removedOnDev ?? {},
        problems: out.problems.length,
      };
      for (const f of noteFiles)
        try {
          const release = JSON.parse(await fsp.readFile(path.join(root, f), 'utf8'));
          await releases.store(release, {
            source: 'deploy',
            result: f === noteFiles.at(-1) ? result : null,
          });
          out.notes++;
        } catch (e) {
          out.problems.push(`release notes ${f}: ${e.message}`);
        }
    }
    return out;
  }

  async function apply({ restart }, actor) {
    const steps = [];
    const done = (name) => steps.push(name);
    let from;
    try {
      set({ op: 'update', status: 'running', step: 'Checking the checkout', message: null });
      let g = await readGit();
      if (!g.supported) throw new StepError(g.message);
      from = g.headFull;
      if (g.blocker === 'detached') throw new StepError(blockerMessage(g));

      set({ step: 'Fetching from the remote' });
      await fetchRemote(g);
      done('fetch');
      g = await readGit();
      if (g.blocker) throw new StepError(blockerMessage(g));

      let pulled = false;
      let localNote = '';
      let point = null;
      let imported = null;
      if (g.behind > 0) {
        // Updates never drop or rename a table or column without the admin saying so: the refusal comes before anything changes.
        if (!settings.get('updates.allow_destructive_migrations')) {
          const risky = await destructiveIncoming(g);
          if (risky.length)
            throw new StepError(
              `This update changes the database in a way that removes or renames data: ${destructiveMessage(risky)}. Nothing was changed. Take a backup (Operations → Backups), then turn on "Allow updates that remove or rename tables or columns" in Settings → Updates and update again.`,
            );
        }
        alive();
        const backupId = await safetyBackup(actor);
        alive();
        // The mirror is derived from the database and rewritten after the merge, so a stale copy must not block it.
        for (const spec of mirrorPathspec())
          await git('checkout', '--', spec.replace(':(exclude)', ''));
        const renamedLocal = await clearUntrackedCollisions(
          `refs/remotes/${g.remote}/${g.sourceBranch}`,
        );
        const stashed = await stashLocal();
        set({ step: `Applying ${g.behind} update${g.behind === 1 ? '' : 's'}` });
        const m = await git('merge', '--ff-only', `refs/remotes/${g.remote}/${g.sourceBranch}`);
        if (m.code !== 0) {
          await restoreLocal(stashed);
          throw new StepError(
            `Git couldn't apply the update: ${lastLine(m.out)}. Nothing was changed.`,
          );
        }
        localNote =
          (await restoreLocal(stashed)) +
          (renamedLocal.length
            ? ` Files you had created that the update also adds were renamed to <name>.local-<time>: ${renamedLocal.slice(0, 3).join(', ')}.`
            : '');
        done('merge');
        pulled = true;
        // Recorded right after the merge and before install/migrate: those are the steps that can fail, and the point is
        // what lets an admin put the old code back afterwards.
        point = await recordRestorePoint({ from, g, backupId }, actor);
        if (point && settings.get('updates.auto_rollback'))
          try {
            markPending(appRoot, {
              from,
              to: (await readGit()).headFull,
              installChanged: g.needsInstall,
              autoRollback: true,
              pointId: point.id,
            });
          } catch (e) {
            log.warn({ err: e.message }, 'updates: could not arm the automatic rollback');
          }
        await finishInstall({ needsInstall: g.needsInstall }, done);
        imported = await importDeployment(from, actor);
        if (imported.pages) done('site');
        if (imported.data) done('data');
        if (imported.sync) done('records');
      } else {
        // The code may already be at the new version without this server having installed or migrated it (a manual
        // `git pull`, or a pipeline that stopped halfway), so finish that here instead of leaving it to someone.
        const head = (await git('rev-parse', 'HEAD')).out;
        const needsInstall =
          !!bootCommit &&
          head !== bootCommit &&
          (
            await classifyBetween(
              (await git('diff', '--name-only', '--relative', bootCommit, head)).out
                .split('\n')
                .filter(Boolean),
              bootCommit,
              head,
            )
          ).needsInstall;
        await finishInstall({ needsInstall, onlyIfPending: true }, done);
      }

      const after = await readGit();
      const runningOld = bootCommit && after.headFull !== bootCommit;
      const willRestart = restart && (pulled || runningOld);
      const did = [
        steps.includes('install') && 'installed dependencies',
        steps.includes('migrate') && 'ran database migrations',
        imported?.pages &&
          `imported ${imported.pages.written} page file${imported.pages.written === 1 ? '' : 's'}${imported.pages.removed ? ` and removed ${imported.pages.removed}` : ''}`,
        imported?.data && 'added the data that came with it',
        imported?.notes && `release notes: ${imported.notes} new, read them in Operations → Deploy`,
        imported?.sync &&
          `brought in records (${imported.sync.added} new, ${imported.sync.updated} updated${imported.sync.conflicts ? `, ${imported.sync.conflicts} waiting for you in Operations → Deploy` : ''})`,
      ].filter(Boolean);
      const detail = did.length ? ` (${did.join(' and ')})` : '';
      const problems = imported?.problems.length
        ? ` Not everything came across: ${imported.problems.slice(0, 3).join('; ')}${imported.problems.length > 3 ? ` (and ${imported.problems.length - 3} more)` : ''}.`
        : '';
      const message = pulled
        ? `Updated to ${after.head}${detail}.${problems}${localNote}${willRestart ? '' : ' Restart this server to run it.'}`
        : runningOld
          ? `Already at ${after.head}${detail}, but this server is still running an older version.${willRestart ? '' : ' Restart it.'}`
          : 'Already up to date.';
      await audit.log({
        actor: actorInfo(actor),
        action: 'updates.apply',
        entity: 'server',
        entityId: env.nodeId,
        meta: {
          host: hostName(),
          from: from?.slice(0, 12),
          to: after.headFull.slice(0, 12),
          branch: after.branch,
          steps,
          restart: willRestart,
          restore_point: point?.id ?? null,
          backup: point?.backup_id ?? null,
          imported: imported
            ? {
                pages: imported.pages,
                data: !!imported.data,
                sync: imported.sync && {
                  added: imported.sync.added,
                  updated: imported.sync.updated,
                  conflicts: imported.sync.conflicts,
                },
                problems: imported.problems.length,
              }
            : null,
        },
      });
      if (willRestart) {
        set({ git: after });
        await restartNow(actor, 'update');
      } else set({ status: 'done', step: null, git: after, message });
    } catch (e) {
      await fail('apply', actor, e);
    }
  }

  /** Optional: a backup just before new code lands. If it cannot be made, the update does not start. Returns its id. */
  async function safetyBackup(actor) {
    if (!settings.get('updates.backup_before_update')) return null;
    const backup = getBackup();
    if (!backup)
      throw new StepError(
        'Backups are switched off on this server, so the backup before the update cannot be made. Turn the Backups module on, or turn off "Take a backup before every update" in Settings → Updates.',
      );
    set({ step: 'Taking a backup first' });
    try {
      const files = settings.get('updates.backup_include_files');
      const row = await backup.create(
        {
          name: `Before update ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          source: 'update',
          includeMedia: files,
          folders: files ? undefined : [],
        },
        actor,
      );
      await backup.idle();
      const done = await backup.get(row.id);
      if (done.status !== 'ready')
        throw new StepError(
          `The backup before the update failed (${done.error || 'unknown error'}), so nothing was changed. Fix that in Operations → Backups, or turn off "Take a backup before every update".`,
        );
      return done.id;
    } catch (e) {
      if (e instanceof StepError) throw e;
      throw new StepError(
        `The backup before the update could not start (${e.message}), so nothing was changed. Try again once it is free.`,
      );
    }
  }

  async function recordRestorePoint({ from, g, backupId }, actor) {
    try {
      const id = await dialect(db).insertGetId(db('update_restore_points'), {
        server_key: serverKey,
        host: hostName().slice(0, 190),
        branch: g.branch ?? null,
        from_commit: from,
        to_commit: (await readGit()).headFull,
        install_changed: !!g.needsInstall,
        migrations_changed: !!g.needsMigrate,
        backup_id: backupId,
        status: 'available',
        created_by: actor?.id ?? null,
        created_at: Date.now(),
      });
      await pruneRestorePoints();
      return { id, backup_id: backupId };
    } catch (e) {
      // The update itself already happened; a missing restore point must not turn it into a failure.
      log.warn({ err: e.message }, 'updates: could not record a restore point');
      return null;
    }
  }

  /** Keeps the newest KEEP_RESTORE_POINTS for this server, together with the backups that were made for the dropped ones. */
  async function pruneRestorePoints() {
    const old = (
      await db('update_restore_points').where({ server_key: serverKey }).orderBy('id', 'desc')
    ).slice(KEEP_RESTORE_POINTS);
    const backup = getBackup();
    for (const r of old) {
      if (r.backup_id && backup)
        try {
          const b = await backup.get(r.backup_id);
          if (b.source === 'update') await backup.remove(r.backup_id, null);
        } catch {
          /* already gone */
        }
      await db('update_restore_points').where({ id: r.id }).delete();
    }
  }

  /**
   * Puts this server's code back to the commit a restore point recorded. Code only: the database is not touched (migrations
   * only add, so the older code runs on it). Refuses to run over local changes, since `reset --hard` would discard them.
   */
  async function rollback({ pointId, restart }, actor) {
    let from;
    try {
      set({ op: 'rollback', status: 'running', step: 'Checking the checkout', message: null });
      const g = await readGit();
      if (!g.supported) throw new StepError(g.message);
      if (g.blocker === 'detached') throw new StepError(blockerMessage(g));
      const point = await db('update_restore_points')
        .where({ id: Number(pointId), server_key: serverKey })
        .first();
      if (!point) throw new StepError('That restore point is not on this server (or was removed).');
      from = g.headFull;
      const target = point.from_commit;
      if ((await git('cat-file', '-e', `${target}^{commit}`)).code !== 0)
        throw new StepError(
          `This checkout no longer has commit ${target.slice(0, 7)} (it was cleaned up), so it cannot go back to it.`,
        );
      if (target === from)
        throw new StepError(`Already on ${target.slice(0, 7)}. Nothing to roll back.`);
      if ((await git('merge-base', '--is-ancestor', target, 'HEAD')).code !== 0)
        throw new StepError(
          `${target.slice(0, 7)} is not an earlier version of this checkout, so it cannot be rolled back to.`,
        );
      alive();
      const changed = (await git('diff', '--name-only', '--relative', target, 'HEAD')).out
        .split('\n')
        .filter(Boolean);
      const { needsInstall, needsMigrate } = await classifyBetween(changed, target, 'HEAD');

      set({ step: `Putting back ${target.slice(0, 7)}` });
      const stashed = await stashLocal();
      const reset = await git('reset', '--hard', target);
      if (reset.code !== 0) {
        await restoreLocal(stashed);
        throw new StepError(`Git couldn't go back: ${lastLine(reset.out)}. Nothing was changed.`);
      }
      const localNote = await restoreLocal(stashed);
      const steps = ['reset'];
      // Whatever an update was waiting to verify is moot now.
      clearPending(appRoot);

      if (needsInstall && settings.get('updates.install_dependencies')) {
        alive();
        set({ step: 'Installing dependencies' });
        const r = await run(
          'npm',
          [
            'ci',
            '--no-audit',
            '--no-fund',
            '--loglevel=http',
            ...(env.isProd ? ['--omit=dev'] : []),
          ],
          { timeoutMs: 15 * 60_000, onOutput: installProgress() },
        );
        if (r.code !== 0)
          throw new StepError(
            `The code is back at ${target.slice(0, 7)}, but reinstalling dependencies failed: ${lastLine(r.out) || 'npm did not finish'}. Run "npm ci" in the app folder, then restart.`,
          );
        steps.push('install');
      }

      // This point and every later one describe updates that are now undone.
      await db('update_restore_points')
        .where({ server_key: serverKey })
        .andWhere('id', '>=', point.id)
        .update({ status: 'rolled_back' });
      const after = await readGit();
      const willRestart = restart;
      await audit.log({
        actor: actorInfo(actor),
        action: 'updates.rollback',
        entity: 'server',
        entityId: env.nodeId,
        meta: {
          host: hostName(),
          from: from.slice(0, 12),
          to: target.slice(0, 12),
          steps,
          restart: willRestart,
          restore_point: point.id,
          database_kept: needsMigrate,
        },
      });
      const note = needsMigrate
        ? ' The database keeps the newer tables and columns, which the older code ignores.'
        : '';
      if (willRestart) {
        set({ git: after });
        await restartNow(actor, 'rollback');
      } else
        set({
          status: 'done',
          step: null,
          git: after,
          message: `Rolled back to ${target.slice(0, 7)}.${note}${localNote} Restart this server to run it.`,
        });
    } catch (e) {
      await fail('rollback', actor, e);
    }
  }

  /** Newest first. `rolledBack` points describe updates that were already undone. */
  async function listRestorePoints() {
    const rows = await db('update_restore_points').orderBy('id', 'desc').limit(100);
    const backups = new Map();
    const backup = getBackup();
    for (const r of rows)
      if (r.backup_id && backup)
        backups.set(r.backup_id, await backup.get(r.backup_id).catch(() => null));
    return rows.map((r) => ({
      id: Number(r.id),
      serverKey: r.server_key,
      host: r.host,
      branch: r.branch,
      from: r.from_commit,
      to: r.to_commit,
      installChanged: !!r.install_changed,
      migrationsChanged: !!r.migrations_changed,
      backupId: r.backup_id ?? null,
      backupReady: r.backup_id ? backups.get(r.backup_id)?.status === 'ready' : false,
      status: r.status,
      createdAt: Number(r.created_at),
    }));
  }

  /** Production refuses to boot with pending migrations, so restarting into them would take the server down. */
  async function checkMigrationsBeforeRestart() {
    if (!env.isProd) return;
    let pending;
    try {
      [, pending] = await db.migrate.list();
    } catch {
      throw new StepError(
        "The migration list doesn't match the database, so the server would not start. Fix that (npm run migrate:status), then restart.",
      );
    }
    if (pending.length)
      throw new StepError(
        `${pending.length} database migration${pending.length === 1 ? ' is' : 's are'} pending, and a production server won't start with those. Run "npm run migrate" first, or turn on "Run database migrations after a pull" in Settings → Updates.`,
      );
  }

  async function restartNow(actor, reason) {
    try {
      set({ op: 'restart', status: 'running', step: 'Restarting', message: null });
      if (!state.requestRestart)
        throw new StepError(
          "This process can't restart itself. Restart it from wherever it was started.",
        );
      await checkMigrationsBeforeRestart();
      await audit.log({
        actor: actorInfo(actor),
        action: 'updates.restart',
        entity: 'server',
        entityId: env.nodeId,
        meta: { host: hostName(), reason },
      });
      set({ message: 'Restarting. This server drops out of the pool and comes back in a moment.' });
      // Let the heartbeat carrying "restarting" land and the HTTP response go out before the drain begins.
      setTimeout(() => state.requestRestart(), 300).unref();
    } catch (e) {
      await fail('restart', actor, e);
    }
  }

  /**
   * Changes where updates come from: a git URL and a branch, cluster-wide settings, so every server follows.
   * Each server needs read access to the URL; a bad one shows up as a failed fetch on the next check.
   */
  async function setSource({ url, branch }, actor) {
    if (st.status === 'running')
      throw new HttpError(
        409,
        'busy',
        'An update is already running on this server. Wait for it to finish.',
      );
    const from = {
      url: redact(settings.get('updates.source_url')),
      branch: settings.get('updates.source_branch'),
    };
    if (from.url === redact(url) && from.branch === branch) return;
    await settings.update('updates', { values: { source_url: url, source_branch: branch } }, actor);
    await audit.log({
      actor: actorInfo(actor),
      action: 'updates.source',
      entity: 'server',
      entityId: env.nodeId,
      // redact(): a URL may carry a token; it must not reach the audit log.
      meta: { host: hostName(), from, to: { url: redact(url), branch } },
    });
    set({
      git: await readGit(),
      message: `Updates now come from ${redact(url)} (${branch}). Check for updates to refresh.`,
    });
  }

  /** Validates and launches an action on THIS server; the work continues in the background. */
  function begin(action, opts, actor) {
    if (!['check', 'apply', 'restart', 'rollback'].includes(action))
      throw new HttpError(400, 'bad_action', 'Unknown update action.');
    // Every action flips the status to 'running' synchronously, so this is also the lock.
    if (st.status === 'running')
      throw new HttpError(
        409,
        'busy',
        'An update is already running on this server. Wait for it to finish.',
      );
    // Not awaited: the caller gets its 202 now and follows progress through the heartbeat. These never reject.
    if (action === 'check') void check(actor);
    else if (action === 'apply') void apply({ restart: opts?.restart === true }, actor);
    else if (action === 'rollback')
      void rollback({ pointId: opts?.pointId, restart: opts?.restart === true }, actor);
    else void restartNow(actor, 'manual');
  }

  /** The update guard may have put the old version back before this process loaded; record it now that there is an audit log. */
  async function reportAutoRollback() {
    try {
      const note = takeRolledBack(appRoot);
      if (!note) return;
      if (note.pointId)
        await db('update_restore_points')
          .where({ server_key: serverKey })
          .andWhere('id', '>=', note.pointId)
          .update({ status: 'rolled_back' });
      await audit.log({
        actor: null,
        action: 'updates.auto_rollback',
        entity: 'server',
        entityId: env.nodeId,
        meta: {
          host: hostName(),
          from: String(note.to).slice(0, 12),
          to: String(note.from).slice(0, 12),
          message: 'The new version failed to start, so the previous one was put back.',
        },
      });
      set({
        status: 'failed',
        message: `The update to ${String(note.to).slice(0, 7)} would not start, so this server went back to ${String(note.from).slice(0, 7)}. Look at the server log before updating again.`,
      });
    } catch (e) {
      log.warn({ err: e.message }, 'updates: could not record the automatic rollback');
    }
  }

  return {
    /** Subscribes to commands, reports the running commit with every heartbeat, and reads the checkout once. */
    async start() {
      nodes.reportExtras(() => ({ app_commit: bootCommit, update_state: JSON.stringify(st) }));
      await bus.subscribe(CHANNEL, (msg) => {
        if (msg?.nodeId !== env.nodeId) return;
        try {
          begin(msg.action, msg.opts, msg.actor);
        } catch (e) {
          log.warn({ err: e.message, action: msg.action }, 'updates: command ignored');
        }
      });
      void reportAutoRollback();
      void readGit()
        .then((g) => {
          bootCommit = g.supported ? g.headFull : null;
          set({ git: g });
        })
        .catch((e) => log.warn({ err: e.message }, 'updates: could not read the git checkout'));
    },
    /** Called once this process is serving: after it has stayed up a while, the update it started on counts as good. */
    markHealthy() {
      healthyTimer = setTimeout(() => {
        try {
          clearPending(appRoot);
        } catch {
          /* nothing was pending */
        }
      }, HEALTHY_AFTER_MS);
      healthyTimer.unref();
    },
    stop() {
      stopped = true;
      clearTimeout(healthyTimer);
    },
    restorePoints: listRestorePoints,
    /**
     * Imports pages, data and release notes from a folder that holds `public/`, `deploy-data/` and `deploy-notes/`
     * (an unpacked offline package), the same way an update does after a pull. Returns what it did and what went wrong.
     * @param {string} root @param {string} label @param {any} actor
     */
    async importFolder(root, label, actor = null) {
      const changes = [];
      for (const top of ['public', DATA_DIR, 'deploy-notes'])
        for (const f of await listFiles(root, top).catch(() => []))
          changes.push({ status: 'A', file: f });
      return importChanges(changes, root, label, actor);
    },
    serverKey: () => serverKey,
    snapshot: () => st,
    setSource,
    bootCommit: () => bootCommit,
    restartMode: () => resolveRestartMode(settings.get('updates.restart_mode'), env.supervised),

    /** Route an action to a server. Returns as soon as it is accepted; progress shows in that server's heartbeat. */
    async dispatch(nodeId, action, opts, actor) {
      if (nodeId === env.nodeId) return begin(action, opts, actor);
      const target = (await nodes.list()).nodes.find((n) => n.id === nodeId);
      if (!target) throw notFound('That server');
      if (target.status !== 'up')
        throw new HttpError(
          409,
          'node_unavailable',
          `${target.host} isn't reporting in (${target.status}). Try again once it's back.`,
        );
      if (target.update?.status === 'running')
        throw new HttpError(409, 'busy', `An update is already running on ${target.host}.`);
      await bus.publish(CHANNEL, {
        nodeId,
        action,
        opts: { restart: opts?.restart === true, pointId: opts?.pointId },
        actor: actorInfo(actor),
      });
    },
  };
}

/** A failure whose message is fit to show an admin as-is. */
class StepError extends Error {}
