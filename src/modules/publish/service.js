import { now } from '../../core/db/index.js';
import { HttpError } from '../../core/http/errors.js';

const SYSTEM = { id: null, name: 'Auto-commit', email: null, can: () => true };
const asErr = (e) => {
  throw e instanceof HttpError ? e : new HttpError(422, 'git_failed', e.message);
};

/**
 * Publish & Git (docs/DECISIONS.md D-117). The database stays the truth: a **pull** or a **branch switch** imports the
 * branch's files into the live site as ONE recorded, revertible change, and **publish** commits, tags a release, bumps the
 * cache version and (optionally) pushes. Everything is built on the change history and its git copy
 * (`ctx.assistant.history`, `.git`, `.docstore`), so there is one history, not two.
 * @param {any} ctx
 */
export function createPublish(ctx) {
  const { db, settings, audit, cache, log } = ctx;
  const A = () => ctx.assistant;
  const history = () => A().history;
  const git = () => A().git;
  const docstore = () => A().docstore;

  const cfg = () => settings.ns('assistant');
  const branchName = () => cfg().git_branch || 'main';
  const isDoc = (p) => {
    try {
      docstore().parse(p);
      return docstore().canon(p) === p;
    } catch {
      return false;
    }
  };
  const needGit = () => {
    if (!git().enabled())
      throw new HttpError(
        409,
        'git_off',
        'The git copy is switched off. Turn it on under Settings → Assistant first.',
      );
  };
  const needRemote = () => {
    if (!cfg().git_remote)
      throw new HttpError(
        409,
        'no_remote',
        'Set the remote repository URL under Settings → Assistant first.',
      );
  };

  /** Refresh every cache that could show an old version of the site, and tell anyone listening (a CDN purge webhook, say). */
  async function bustCaches(reason, actor = null) {
    const version = Number(settings.get('publish.version') ?? 1) + 1;
    await settings.update('publish', { values: { version } }, null, { internal: true });
    await cache.invalidate(['sitefiles']).catch(() => {});
    await ctx.events?.emit('site.cache_busted', { version, reason }).catch(() => {});
    await audit.log({
      actor,
      action: 'publish.cache_busted',
      entity: 'site',
      meta: { version, reason },
    });
    return version;
  }

  /** What differs between the site now and the last commit. `tracking: false` before the first commit exists. */
  async function pending() {
    if (!(await db('site_commits').first('id'))) return { tracking: false, files: [] };
    const snap = await docstore().snapshot();
    const head = await history().headState();
    const files = [];
    for (const p of new Set([...snap.keys(), ...head.keys()])) {
      const a = head.get(p) ?? null;
      const b = snap.get(p) ?? null;
      if (a !== b)
        files.push({ path: p, status: a == null ? 'added' : b == null ? 'deleted' : 'changed' });
    }
    return { tracking: true, files: files.sort((x, y) => x.path.localeCompare(y.path)) };
  }

  /** Commit whatever is uncommitted, so no branch move or pull can lose it. Returns the entry, or null when clean. */
  async function commitPending(message, actor, kind = 'manual') {
    const out = await history().commitNow({ message, actor, kind });
    return out.commit ?? null;
  }

  const latestId = async () => Number((await db('site_commits').max({ m: 'id' }).first())?.m ?? 0);

  /** Write changes into the live site. All-or-nothing on permission; a document its module refuses is reported, not skipped silently. */
  async function apply(changes, actor) {
    for (const p of changes.keys()) docstore().require(actor, p, 'write');
    const order = [...changes].sort(
      ([, a], [, b]) => Number(a.after == null) - Number(b.after == null),
    );
    /** @type {Map<string, {before: string|null, after: string|null}>} */
    const applied = new Map();
    const failed = [];
    for (const [p, c] of order) {
      try {
        await docstore().write(p, c.after, actor);
        applied.set(p, c);
      } catch (e) {
        failed.push({ path: p, reason: e.message });
      }
    }
    return { applied, failed };
  }

  /** The files of a git tree that are documents the site knows, compared with the live site. */
  const diffTo = (live, target) => {
    const changes = new Map();
    for (const p of new Set([...live.keys(), ...target.keys()])) {
      if (!isDoc(p)) continue;
      const before = live.get(p) ?? null;
      const after = target.get(p) ?? null;
      if (before !== after) changes.set(p, { before, after });
    }
    return changes;
  };

  /** After git itself made the commit (pull, branch switch), record the entry without replaying it a second time. */
  async function recordGitMade({ changes, message, actor, kind, sha, prevLatest }) {
    const commit = await history().record({ changes, message, actor, kind, sha, mirror: false });
    if (commit && commit.id === prevLatest + 1) await git().markReplayed(commit.id);
    return commit;
  }

  const svc = {
    bustCaches,
    pending,

    async status({ refresh = false } = {}) {
      const s = cfg();
      const branch = branchName();
      const out = {
        git: git().enabled(),
        remote: s.git_remote ? s.git_remote.replace(/\/\/[^/@]*@/, '//') : '',
        branch,
        head: null,
        ahead: null,
        behind: null,
        remoteError: null,
        pendingFiles: [],
        tracking: true,
        cacheVersion: Number(settings.get('publish.version') ?? 1),
        release: Number((await db('site_versions').max({ m: 'version' }).first())?.m ?? 0),
        autoCommit: settings.get('publish.auto_commit') !== false,
        autoCommitMinutes: Number(settings.get('publish.auto_commit_minutes') ?? 30),
        autoPush: !!settings.get('publish.auto_push'),
      };
      const p = await pending();
      out.pendingFiles = p.files;
      out.tracking = p.tracking;
      if (!out.git) return out;
      await git()
        .sync()
        .catch(() => {});
      out.head = await git().head();
      if (refresh && s.git_remote) {
        try {
          await git().fetch(branch);
        } catch (e) {
          out.remoteError = e.message;
        }
      }
      const remoteSha = await git().resolve(`refs/cms/remote/${branch}`);
      if (remoteSha && out.head) Object.assign(out, await git().aheadBehind('HEAD', remoteSha));
      return out;
    },

    async branches() {
      const current = branchName();
      const local = git().enabled() ? await git().localBranches() : [];
      const remote = git().enabled() ? await git().remoteBranches() : [];
      const names = [...new Set([current, ...local, ...remote])].sort();
      return {
        current,
        branches: names.map((name) => ({
          name,
          local: local.includes(name),
          remote: remote.includes(name),
          current: name === current,
        })),
      };
    },

    versions: async () =>
      (await db('site_versions').orderBy('version', 'desc').limit(100)).map((r) => ({
        version: Number(r.version),
        note: r.note,
        branch: r.branch,
        sha: r.sha,
        author: r.author_name,
        pushed: !!r.pushed,
        createdAt: Number(r.created_at),
      })),

    /** Commit now. Returns the entry, or `{ clean: true }` when nothing changed. */
    async commit({ message, actor }) {
      const out = await history().commitNow({ message, actor });
      if (out.started) return { started: true };
      return out.commit ? { commit: out.commit } : { clean: true };
    },

    /**
     * Publish: commit what is pending, mark it as release v<N> (a git tag too), refresh every cache and, when asked, push.
     * A push that fails does not undo the release: it is reported next to it.
     */
    async publish({ note = '', push = false, actor }) {
      const number = Number((await db('site_versions').max({ m: 'version' }).first())?.m ?? 0) + 1;
      await commitPending(`Publish v${number}${note ? `: ${note}` : ''}`.slice(0, 300), actor);
      let sha = null;
      if (git().enabled()) {
        await git()
          .sync()
          .catch(() => {});
        sha = await git().head();
        if (sha)
          await git()
            .tag(`v${number}`, note || `Release ${number}`)
            .catch((e) => log?.warn({ err: e.message }, 'publish: tag failed'));
      }
      await db('site_versions').insert({
        version: number,
        note: String(note).slice(0, 500),
        branch: branchName(),
        sha,
        commit_id: (await latestId()) || null,
        author_name: String(actor?.name || actor?.email || 'Unknown').slice(0, 120),
        pushed: false,
        created_at: now(),
      });
      const cacheVersion = await bustCaches(`publish v${number}`, actor);
      let pushError = null;
      let pushed = false;
      if (push) {
        try {
          await svc.push(actor);
          pushed = true;
        } catch (e) {
          pushError = e.message;
        }
      }
      await ctx.events
        ?.emit('site.published', { version: number, branch: branchName(), sha, note })
        .catch(() => {});
      await audit.log({
        actor,
        action: 'publish.release',
        entity: 'site',
        meta: { version: number, pushed },
      });
      return { version: number, cacheVersion, sha, pushed, pushError };
    },

    async push(actor) {
      needGit();
      needRemote();
      const out = await git().push().catch(asErr);
      const sha = await git().head();
      if (sha) await db('site_versions').where({ sha }).update({ pushed: true });
      await audit.log({
        actor,
        action: 'publish.push',
        entity: 'site',
        meta: { branch: branchName() },
      });
      return out;
    },

    /**
     * Bring the remote's branch into the live site. Fast-forward when only the remote moved; otherwise a three-way merge
     * of the site's documents. Two sides changing the same document differently is a conflict: nothing is applied until
     * `prefer` says which side wins ('theirs' = the remote, 'ours' = this site).
     */
    async pull({ prefer = null, actor }) {
      needGit();
      needRemote();
      const branch = branchName();
      for (const p of (await pending()).files) docstore().require(actor, p.path, 'write');
      await commitPending(`Before pulling ${branch}`, actor);
      await git().sync();
      const remoteSha = await git().fetch(branch).catch(asErr);
      if (!remoteSha)
        throw new HttpError(
          409,
          'no_remote_branch',
          `The remote has no branch "${branch}" yet. Push first.`,
        );
      const head = await git().head();
      if (!head || remoteSha === head || (await git().isAncestor(remoteSha, head)))
        return { status: 'up_to_date', applied: 0, failed: [], conflicts: [] };

      const fastForward = await git().isAncestor(head, remoteSha);
      const base = fastForward ? head : await git().mergeBase(head, remoteSha);
      const [ours, theirs, baseFiles] = await Promise.all([
        docstore().snapshot(),
        git().files(remoteSha),
        base ? git().files(base) : new Map(),
      ]);
      const changes = new Map();
      const conflicts = [];
      for (const p of new Set([...ours.keys(), ...theirs.keys(), ...baseFiles.keys()])) {
        if (!isDoc(p)) continue;
        const o = ours.get(p) ?? null;
        const b = baseFiles.get(p) ?? null;
        const t = theirs.get(p) ?? null;
        if (t === b || o === t) continue; // the remote did not change it, or both already agree
        if (o === b || prefer === 'theirs') changes.set(p, { before: o, after: t });
        else if (prefer !== 'ours') conflicts.push(p);
      }
      if (conflicts.length)
        return { status: 'conflict', applied: 0, failed: [], conflicts: conflicts.sort() };

      const prevLatest = await latestId();
      const { applied, failed } = await apply(changes, actor);
      const clean = !failed.length && fastForward && !prefer;
      const sha = await git()
        .mergeCommit({
          remoteSha,
          files: clean ? null : new Map([...applied].map(([p, c]) => [p, c.after])),
          message: `Merge ${branch} from the remote\n\nCMS-Merge`,
          who: String(actor?.name || actor?.email || 'CMS'),
        })
        .catch(asErr);
      if (applied.size)
        await recordGitMade({
          changes: applied,
          message: `Pulled ${branch} from the remote (${applied.size} ${applied.size === 1 ? 'file' : 'files'})`,
          actor,
          kind: 'pull',
          sha,
          prevLatest,
        });
      else if (prevLatest === (await latestId())) await git().markReplayed(prevLatest);
      if (applied.size) await bustCaches(`pull ${branch}`, actor);
      await audit.log({
        actor,
        action: 'publish.pull',
        entity: 'site',
        meta: { branch, applied: applied.size, failed: failed.length },
      });
      return {
        status: applied.size ? (clean ? 'fast_forwarded' : 'merged') : 'up_to_date',
        applied: applied.size,
        failed,
        conflicts: [],
      };
    },

    /** Pull, then push. Stops at a conflict or a failed pull; nothing is pushed in that case. */
    async sync({ prefer = null, actor }) {
      const pulled = await svc.pull({ prefer, actor });
      if (pulled.status === 'conflict' || pulled.failed.length) return { pulled, pushed: false };
      await svc.push(actor);
      return { pulled, pushed: true };
    },

    /**
     * Move to another branch. Everything uncommitted is committed first (on the branch you are leaving). A new branch
     * starts from where you are; an existing one — here or on the remote — replaces the live site's documents with its own.
     */
    async switchBranch({ name, create = false, actor }) {
      needGit();
      const clean = String(name ?? '').trim();
      if (!git().branchOk(clean))
        throw new HttpError(
          422,
          'invalid_branch',
          'Branch names use letters, digits, dots, dashes, underscores and slashes.',
        );
      const current = branchName();
      if (clean === current)
        return { status: 'already_there', branch: clean, applied: 0, failed: [] };
      for (const p of (await pending()).files) docstore().require(actor, p.path, 'write');
      await commitPending(`Before switching to ${clean}`, actor);
      await git().sync();
      if (!create && !(await git().localBranches()).includes(clean)) {
        if (!(await git().fetch(clean).catch(asErr)))
          throw new HttpError(
            404,
            'no_such_branch',
            `There is no branch "${clean}" here or on the remote. Create it instead.`,
          );
      }
      const prevLatest = await latestId();
      const live = await docstore().snapshot();
      const sha = await git().checkout({ name: clean, create }).catch(asErr);
      let result = { applied: new Map(), failed: [] };
      if (!create) {
        const target = await git().files(sha);
        result = await apply(diffTo(live, target), actor);
      }
      await settings.update('assistant', { values: { git_branch: clean } }, null, {
        internal: true,
      });
      if (result.applied.size) {
        await recordGitMade({
          changes: result.applied,
          message: `Switched to branch ${clean} (${result.applied.size} ${result.applied.size === 1 ? 'file' : 'files'})`,
          actor,
          kind: 'branch',
          sha,
          prevLatest,
        });
        await bustCaches(`branch ${clean}`, actor);
      } else if (prevLatest === (await latestId())) await git().markReplayed(prevLatest);
      await audit.log({
        actor,
        action: 'publish.branch',
        entity: 'site',
        meta: { from: current, to: clean, create },
      });
      return {
        status: create ? 'created' : 'switched',
        branch: clean,
        applied: result.applied.size,
        failed: result.failed,
      };
    },

    /** Put the site back as it was at a release. Recorded as one entry, so it can itself be reverted. */
    async restore({ version, actor }) {
      needGit();
      const row = await db('site_versions')
        .where({ version: Number(version) })
        .first();
      if (!row?.sha)
        throw new HttpError(404, 'not_found', 'That release is not in this server’s git copy.');
      for (const p of (await pending()).files) docstore().require(actor, p.path, 'write');
      await commitPending(`Before restoring v${row.version}`, actor);
      await git().sync();
      const target = await git()
        .treeAt(row.sha)
        .catch(() => null);
      if (!target)
        throw new HttpError(
          404,
          'not_found',
          'That release’s files are not in this server’s git copy.',
        );
      const { applied, failed } = await apply(diffTo(await docstore().snapshot(), target), actor);
      const commit = await history().record({
        changes: applied,
        message: `Restore the site to v${row.version}`,
        actor,
        kind: 'restore',
      });
      if (applied.size) await bustCaches(`restore v${row.version}`, actor);
      await audit.log({
        actor,
        action: 'publish.restore',
        entity: 'site',
        meta: { version: row.version, applied: applied.size },
      });
      return { commit, applied: applied.size, failed };
    },

    /** The periodic commit (a scheduled job): only when switched on, and only when something changed. */
    async autoCommit() {
      if (settings.get('publish.auto_commit') === false || ctx.state?.draining)
        return { skipped: true };
      const c = await commitPending('Automatic commit', SYSTEM, 'auto');
      if (c && settings.get('publish.auto_push') && cfg().git_remote) {
        await git()
          .push()
          .catch((e) => log?.warn({ err: e.message }, 'publish: automatic push failed'));
      }
      return { committed: Boolean(c) };
    },

    /** (Re)arm the schedule from the settings. Safe to call on every change. */
    async rearm() {
      const on = settings.get('publish.auto_commit') !== false;
      if (!on) return ctx.jobs.unschedule('publish.auto_commit').catch(() => {});
      const minutes = Math.max(5, Number(settings.get('publish.auto_commit_minutes') ?? 30));
      return ctx.jobs.reschedule('publish.auto_commit', { everyMs: minutes * 60_000 }, {});
    },
  };
  return svc;
}
