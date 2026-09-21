import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError, notFound } from '../../core/http/errors.js';

const CHANNEL = 'updates:cmd';
const MAX_INCOMING = 20;

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
 * Safe by construction: fast-forward only, refuses a checkout with local changes, never discards anything, runs git and npm
 * without a shell, and refuses to restart a production server that has pending migrations (it would not come back up).
 *
 * @param {{env: import('../../core/env.js').Env, db: import('knex').Knex, settings: any, bus: any, audit: any, nodes: any,
 *   state: any, log: import('pino').Logger, appRoot: string}} deps
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
}) {
  let stopped = false;
  let bootCommit = null;
  let st = { op: null, status: 'idle', step: null, message: null, at: null, git: null };

  const set = (patch) => {
    if (stopped) return;
    st = { ...st, ...patch, at: Date.now() };
    nodes.refresh();
  };

  /** Runs a program without a shell; resolves (never rejects) with its exit code and redacted output. */
  function run(cmd, args, { timeoutMs = 60_000 } = {}) {
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

    const remote = settings.get('updates.remote');
    const head = (await git('rev-parse', 'HEAD')).out;
    const branchRes = await git('symbolic-ref', '--short', '-q', 'HEAD');
    const branch = branchRes.code === 0 ? branchRes.out : null;
    const [meta] = (await git('log', '-1', '--format=%h%x1f%s%x1f%an%x1f%at')).out.split('\n');
    const [short, subject, author, at] = (meta ?? '').split('\x1f');
    const dirty = (await git('status', '--porcelain', '--untracked-files=no')).out !== '';
    const url = await git('remote', 'get-url', remote);

    const info = {
      supported: true,
      head: short ?? null,
      headFull: head,
      subject: subject ?? '',
      author: author ?? '',
      committedAt: Number(at) * 1000 || null,
      branch,
      remote,
      remoteUrl: url.code === 0 ? url.out : null,
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
    else if (url.code !== 0) info.blocker = 'no_remote';
    else if (dirty) info.blocker = 'dirty';

    if (branch && url.code === 0) {
      const ref = `refs/remotes/${remote}/${branch}`;
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
          Object.assign(info, classifyChanges(files));
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
      no_remote: `The git remote "${g.remote}" doesn't exist in this checkout. Fix the name under Settings → Updates, or add it with "git remote add".`,
      dirty:
        'This checkout has uncommitted changes to tracked files, and updating would overwrite them. Commit or stash them (git stash), then try again.',
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
      if (!g.branch || g.blocker === 'no_remote') throw new StepError(blockerMessage(g));
      await fetchRemote(g);
      const after = await readGit();
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
          ? `${after.behind} update${after.behind === 1 ? '' : 's'} available.`
          : 'Up to date.',
      });
    } catch (e) {
      await fail('check', actor, e);
    }
  }

  async function fetchRemote(g) {
    alive();
    const r = await run(
      'git',
      ['fetch', g.remote, `+refs/heads/${g.branch}:refs/remotes/${g.remote}/${g.branch}`],
      {
        timeoutMs: 120_000,
      },
    );
    if (r.code !== 0)
      throw new StepError(
        `Couldn't fetch from "${g.remote}": ${r.timedOut ? 'it took too long' : lastLine(r.out) || 'unknown error'}. Check that this server can reach the remote and has read access to it.`,
      );
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
      if (['detached', 'no_remote', 'dirty'].includes(g.blocker))
        throw new StepError(blockerMessage(g));

      set({ step: 'Fetching from the remote' });
      await fetchRemote(g);
      done('fetch');
      g = await readGit();
      if (g.blocker) throw new StepError(blockerMessage(g));

      let pulled = false;
      if (g.behind > 0) {
        alive();
        set({ step: `Applying ${g.behind} update${g.behind === 1 ? '' : 's'}` });
        const m = await git('merge', '--ff-only', `refs/remotes/${g.remote}/${g.branch}`);
        if (m.code !== 0)
          throw new StepError(
            `Git couldn't apply the update: ${lastLine(m.out)}. Nothing was changed.`,
          );
        done('merge');
        pulled = true;
        const codeNow = `Code is now at the new version, but`;

        if (g.needsInstall && settings.get('updates.install_dependencies')) {
          alive();
          set({ step: 'Installing dependencies' });
          const r = await run(
            'npm',
            ['ci', '--no-audit', '--no-fund', ...(env.isProd ? ['--omit=dev'] : [])],
            {
              timeoutMs: 15 * 60_000,
            },
          );
          if (r.code !== 0)
            throw new StepError(
              `${codeNow} installing dependencies failed: ${lastLine(r.out) || 'npm did not finish'}. Run "npm ci" in the app folder, then restart.`,
            );
          done('install');
        }
        if (settings.get('updates.run_migrations')) {
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

      const after = await readGit();
      const runningOld = bootCommit && after.headFull !== bootCommit;
      const willRestart = restart && (pulled || runningOld);
      const message = pulled
        ? `Updated to ${after.head}.${willRestart ? '' : ' Restart this server to run it.'}`
        : runningOld
          ? `Already at ${after.head}, but this server is still running an older version.${willRestart ? '' : ' Restart it.'}`
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

  /** Validates and launches an action on THIS server; the work continues in the background. */
  function begin(action, opts, actor) {
    if (!['check', 'apply', 'restart'].includes(action))
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
    else void restartNow(actor, 'manual');
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
      void readGit()
        .then((g) => {
          bootCommit = g.supported ? g.headFull : null;
          set({ git: g });
        })
        .catch((e) => log.warn({ err: e.message }, 'updates: could not read the git checkout'));
    },
    stop() {
      stopped = true;
    },
    snapshot: () => st,
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
        opts: { restart: opts?.restart === true },
        actor: actorInfo(actor),
      });
    },
  };
}

/** A failure whose message is fit to show an admin as-is. */
class StepError extends Error {}
