import { now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import { lineDiff } from './diff.js';

const CHUNK = 50;

/**
 * The change history (docs/DECISIONS.md D-072): one entry per assistant turn that changed anything, plus Reverts.
 *
 * Each entry stores the text of every changed document before and after. That is enough to show a diff and to undo
 * the change *safely*: a Revert puts a document back only if it is still exactly as that change left it; if someone
 * has edited it since, it is skipped and reported, never overwritten.
 *
 * The first entry is a **baseline** (the whole site as it was before the assistant's first change), so the git
 * mirror starts from a complete tree and every later entry is a small diff against it.
 * @param {any} ctx
 * @param {{docstore: any, git: any}} deps
 */
export function createHistory(ctx, { docstore, git }) {
  const { db, dialect, audit, settings, log } = ctx;

  const commitRow = (c, revertedBy) => ({
    id: Number(c.id),
    kind: c.kind,
    message: c.message,
    author: c.author_name,
    sessionId: c.session_id == null ? null : Number(c.session_id),
    revertsId: c.reverts_id == null ? null : Number(c.reverts_id),
    sha: c.sha ?? null,
    files: Number(c.file_count),
    createdAt: Number(c.created_at),
    revertedBy: revertedBy ?? null,
  });

  async function insertFiles(trx, commitId, files) {
    const rows = files.map((f) => ({
      commit_id: commitId,
      path: f.path,
      before_text: f.before,
      after_text: f.after,
    }));
    for (let i = 0; i < rows.length; i += CHUNK)
      await trx('site_commit_files').insert(rows.slice(i, i + CHUNK));
  }

  /** Mirror into git. Commits are never pushed from here: pushing is its own, separate action. */
  async function afterCommit() {
    if (!git.enabled()) return;
    try {
      await git.sync();
    } catch (e) {
      log?.warn({ err: e.message }, 'assistant: git mirror failed');
    }
  }

  const svc = {
    /**
     * @param {{changes: Map<string, {before: string|null, after: string|null}>, message: string, actor: any, sessionId?: number|null, kind?: string, revertsId?: number|null, sha?: string|null, mirror?: boolean}} input
     *   `sha` + `mirror: false` = git already holds this entry (a pull or branch switch made the commit itself), so don't replay it
     * @returns {Promise<any|null>} the new entry, or null when nothing actually changed
     */
    async record({
      changes,
      message,
      actor,
      sessionId = null,
      kind = 'change',
      revertsId = null,
      sha = null,
      mirror = true,
    }) {
      const files = [...changes]
        .filter(([, c]) => c.before !== c.after)
        .map(([path, c]) => ({ path, before: c.before, after: c.after }));
      if (!files.length) return null;
      const author = actor?.name || actor?.email || 'Unknown';
      const t = now();
      let id;
      // Read the whole site *before* the transaction opens: the snapshot queries the database itself, and on SQLite
      // (one connection) a transaction waiting for a query that waits for the transaction never ends.
      let baseline = null;
      if (!(await db('site_commits').first('id'))) {
        // The site as it was before this change: today's snapshot with this change taken back out.
        baseline = await docstore.snapshot();
        for (const f of files) {
          if (f.before == null) baseline.delete(f.path);
          else baseline.set(f.path, f.before);
        }
      }
      await db.transaction(async (trx) => {
        if (baseline && !(await trx('site_commits').first('id'))) {
          const bid = await dialect.insertGetId(trx('site_commits'), {
            kind: 'baseline',
            message: 'Site before the assistant’s first change',
            author_name: 'CMS',
            file_count: baseline.size,
            created_at: t - 1,
          });
          await insertFiles(
            trx,
            bid,
            [...baseline].map(([path, text]) => ({ path, before: null, after: text })),
          );
        }
        id = await dialect.insertGetId(trx('site_commits'), {
          kind,
          message: String(message).slice(0, 500),
          author_id: actor?.id ?? null,
          author_name: String(author).slice(0, 120),
          session_id: sessionId,
          reverts_id: revertsId,
          sha,
          file_count: files.length,
          created_at: t,
        });
        await insertFiles(trx, id, files);
      });
      await audit.log({
        actor,
        action: kind === 'revert' ? 'assistant.reverted' : 'assistant.committed',
        entity: 'site_commit',
        entityId: id,
        meta: { files: files.length },
      });
      if (mirror) await afterCommit();
      return svc.summary(id);
    },

    async summary(id) {
      const c = await db('site_commits').where({ id }).first();
      if (!c) throw notFound('That change');
      const rev = await db('site_commits').where({ reverts_id: id }).first('id');
      return commitRow(c, rev ? Number(rev.id) : null);
    },

    /** @param {{sessionId?: number, limit?: number, beforeId?: number}} [opts] */
    async list({ sessionId, limit = 50, beforeId } = {}) {
      const q = db('site_commits')
        .where('kind', '!=', 'baseline')
        .orderBy('id', 'desc')
        .limit(Math.min(200, limit));
      if (sessionId) q.where({ session_id: sessionId });
      if (beforeId) q.where('id', '<', beforeId);
      const rows = await q;
      const reverts = rows.length
        ? await db('site_commits')
            .whereIn(
              'reverts_id',
              rows.map((r) => r.id),
            )
            .select('id', 'reverts_id')
        : [];
      const by = new Map(reverts.map((r) => [Number(r.reverts_id), Number(r.id)]));
      return rows.map((r) => commitRow(r, by.get(Number(r.id))));
    },

    /** One entry with a diff per file. A file the person may not read is listed without its text. */
    async get(id, actor) {
      const c = await svc.summary(id);
      const files = await db('site_commit_files').where({ commit_id: id }).orderBy('path');
      // Git's own diff when this server's mirror has the commit (it is the same history, shown the way git shows it).
      let fromGit = null;
      if (c.kind !== 'baseline' && git.enabled()) {
        if (!c.sha) await git.sync().catch(() => {});
        fromGit = await git.diff((await svc.summary(id)).sha);
      }
      return {
        commit: await svc.summary(id),
        files: files.map((f) => {
          let readable = true;
          try {
            docstore.require(actor, f.path, 'read');
          } catch {
            readable = false;
          }
          const status =
            f.before_text == null ? 'added' : f.after_text == null ? 'deleted' : 'changed';
          if (!readable) return { path: f.path, status, hidden: true };
          const g = fromGit?.get(f.path);
          const d = g ?? lineDiff(f.before_text, f.after_text);
          return {
            path: f.path,
            status,
            added: d.added,
            removed: d.removed,
            diff: g ? g.hunks : d.hunks,
            source: g ? 'git' : 'text',
          };
        }),
      };
    },

    /**
     * Undo one entry by writing a new one. Only documents still exactly as that entry left them are put back.
     * @returns {Promise<{commit: any|null, reverted: string[], conflicts: {path: string, reason: string}[]}>}
     */
    async revert(id, actor, sessionId = null) {
      const c = await svc.summary(id);
      if (c.kind === 'baseline')
        throw new HttpError(422, 'invalid_input', 'The starting point cannot be reverted.');
      if (c.revertedBy)
        throw new HttpError(
          409,
          'already_reverted',
          `That change was already reverted (change #${c.revertedBy}).`,
        );
      const files = await db('site_commit_files').where({ commit_id: id }).orderBy('path');
      for (const f of files) docstore.require(actor, f.path, 'write'); // all or nothing on permission
      const changes = new Map();
      const conflicts = [];
      for (const f of files) {
        const now_ = await docstore.read(f.path);
        if (now_ !== f.after_text) {
          conflicts.push({
            path: f.path,
            reason: 'It was edited after this change, so it was left as it is now.',
          });
          continue;
        }
        try {
          await docstore.write(f.path, f.before_text, actor);
          changes.set(f.path, { before: now_, after: f.before_text });
        } catch (e) {
          conflicts.push({ path: f.path, reason: e.message });
        }
      }
      const commit = await svc.record({
        changes,
        message: `Revert: ${c.message}`.slice(0, 500),
        actor,
        sessionId,
        kind: 'revert',
        revertsId: id,
      });
      return { commit, reverted: [...changes.keys()], conflicts };
    },

    /** The newest committed text of every document, rebuilt from the entries (a deleted document is absent). */
    async headState() {
      /** @type {Map<string, string>} */
      const state = new Map();
      const rows = await db('site_commit_files')
        .join('site_commits', 'site_commits.id', 'site_commit_files.commit_id')
        .orderBy([{ column: 'site_commits.id' }, { column: 'site_commit_files.id' }])
        .select('site_commit_files.path as path', 'site_commit_files.after_text as after_text');
      for (const r of rows) {
        if (r.after_text == null) state.delete(r.path);
        else state.set(r.path, r.after_text);
      }
      return state;
    },

    /**
     * Commit the site as it is now: whatever differs from the last entry — the assistant's work, but also anything a
     * person changed by hand in the admin since — becomes one entry, whenever they choose. Before any entry exists it
     * only starts tracking (the baseline), because there is nothing to compare with yet.
     * @returns {Promise<{commit: any|null, started?: boolean}>}
     */
    async commitNow({ message, actor, kind = 'manual' }) {
      const snap = await docstore.snapshot();
      if (!(await db('site_commits').first('id'))) {
        await db.transaction(async (trx) => {
          if (await trx('site_commits').first('id')) return; // another server started tracking first
          const bid = await dialect.insertGetId(trx('site_commits'), {
            kind: 'baseline',
            message: 'Site when tracking started',
            author_name: 'CMS',
            file_count: snap.size,
            created_at: now(),
          });
          await insertFiles(
            trx,
            bid,
            [...snap].map(([path, text]) => ({ path, before: null, after: text })),
          );
        });
        await afterCommit();
        return { commit: null, started: true };
      }
      const head = await svc.headState();
      const changes = new Map();
      for (const path of new Set([...snap.keys(), ...head.keys()])) {
        const before = head.get(path) ?? null;
        const after = snap.get(path) ?? null;
        if (before !== after) changes.set(path, { before, after });
      }
      const commit = await svc.record({
        changes,
        message: String(message || '').trim() || 'Manual commit',
        actor,
        kind,
      });
      return { commit };
    },

    /** Where the git mirror and the remote stand, for the Change history screen. */
    async gitStatus() {
      const s = settings.ns('assistant');
      const last = await db('site_commits').max({ m: 'id' }).first();
      const pushed = await db('assistant_docs').where({ name: 'git_pushed' }).first();
      return {
        mirror: git.enabled(),
        remote: s.git_remote ? s.git_remote.replace(/\/\/[^/@]*@/, '//') : '',
        branch: s.git_branch || 'main',
        latest: Number(last?.m ?? 0),
        pushedUpTo: pushed ? Number(pushed.content) : 0,
        head: git.enabled() ? await git.head() : null,
      };
    },
  };
  return svc;
}
