import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../updates/service.js';

/**
 * The git mirror of the change history (docs/DECISIONS.md D-072). The database (`site_commits`) is the truth; this
 * replays those rows into a real repository on this server so the history can be browsed with git and pushed.
 *
 * Replays are **deterministic** — the author, dates and message come from the rows, and the trees from the stored
 * file texts — so every server that replays the same rows produces the same commit ids. That is what lets any
 * server push, and a second server's push be a no-op fast-forward instead of a conflict.
 *
 * Git is run without a shell. A push token travels in the environment (`GIT_CONFIG_*`), never in an argument.
 * @param {{env: any, db: import('knex').Knex, settings: any, log: any}} deps
 */
export function createGitMirror({ env, db, settings, log }) {
  const dir = path.resolve(env.VERSIONS_DIR);
  let chain = Promise.resolve();

  function git(args, { cwd = dir, extraEnv = {} } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => reject(new Error(`git could not start: ${e.message}`)));
      child.on('close', (code) =>
        code === 0
          ? resolve(out.trim())
          : reject(
              new Error(
                redact(err.trim() || out.trim() || `git exited with ${code}`).slice(0, 400),
              ),
            ),
      );
    });
  }

  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function ensureRepo() {
    await fs.mkdir(dir, { recursive: true });
    const has = await fs.stat(path.join(dir, '.git')).then(
      () => true,
      () => false,
    );
    if (!has) await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'CMS Assistant']);
    await git(['config', 'user.email', 'assistant@cms.invalid']);
    await git(['config', 'commit.gpgsign', 'false']);
  }

  const safe = (rel) => {
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep))
      throw new Error(`Refusing to write outside the history folder: ${rel}`);
    return abs;
  };

  async function lastReplayed() {
    const has = await git(['rev-parse', '--verify', '-q', 'HEAD']).then(
      () => true,
      () => false,
    );
    if (!has) return 0;
    const m = /CMS-Commit: (\d+)/.exec(await git(['log', '-1', '--format=%B']));
    return m ? Number(m[1]) : 0;
  }

  const api = {
    dir,
    enabled: () => settings.get('assistant.git_mirror') !== false,

    /** Replay every commit this server hasn't seen. Safe to call any time, from any server. */
    sync: () =>
      serial(async () => {
        if (!api.enabled()) return { replayed: 0 };
        await ensureRepo();
        const from = await lastReplayed();
        const rows = await db('site_commits').where('id', '>', from).orderBy('id');
        for (const c of rows) {
          for (const f of await db('site_commit_files').where({ commit_id: c.id })) {
            const abs = safe(f.path);
            if (f.after_text == null) await fs.rm(abs, { force: true });
            else {
              await fs.mkdir(path.dirname(abs), { recursive: true });
              await fs.writeFile(abs, f.after_text);
            }
          }
          await git(['add', '-A']);
          const when = new Date(Number(c.created_at)).toISOString();
          const who = c.author_name || 'CMS Assistant';
          await git(
            ['commit', '-q', '--allow-empty', '-m', `${c.message}\n\nCMS-Commit: ${c.id}`],
            {
              extraEnv: {
                GIT_AUTHOR_NAME: who,
                GIT_AUTHOR_EMAIL: 'assistant@cms.invalid',
                GIT_AUTHOR_DATE: when,
                GIT_COMMITTER_NAME: 'CMS Assistant',
                GIT_COMMITTER_EMAIL: 'assistant@cms.invalid',
                GIT_COMMITTER_DATE: when,
              },
            },
          );
          const sha = await git(['rev-parse', 'HEAD']);
          await db('site_commits').where({ id: c.id }).whereNull('sha').update({ sha });
        }
        return { replayed: rows.length };
      }),

    /**
     * What one commit changed, straight from git: path → the diff as `{t, s}` lines (' ' context, '+', '-', '…' for a
     * hunk header). Null when the mirror is off or the commit is not in this server's repository yet.
     * @returns {Promise<Map<string, {hunks: {t: string, s: string}[], added: number, removed: number}>|null>}
     */
    async diff(sha) {
      if (!api.enabled() || !/^[0-9a-f]{40}$/.test(sha ?? '')) return null;
      let out;
      try {
        out = await git([
          '-c',
          'core.quotePath=false',
          'show',
          '--format=',
          '--no-color',
          '--no-renames',
          '-U3',
          sha,
        ]);
      } catch {
        return null;
      }
      const files = new Map();
      for (const block of out.split(/^diff --git /m).slice(1)) {
        const lines = block.split('\n');
        const plus = lines.find((l) => l.startsWith('+++ '));
        const minus = lines.find((l) => l.startsWith('--- '));
        const name = (plus && plus !== '+++ /dev/null' ? plus.slice(6) : minus?.slice(6)) ?? '';
        if (!name) continue;
        const hunks = [];
        let added = 0;
        let removed = 0;
        let inHunk = false;
        for (const l of lines) {
          if (l.startsWith('@@')) {
            inHunk = true;
            hunks.push({
              t: '…',
              s: l.replace(/^@@ .*? @@ ?/, '').trim() || l.split('@@')[1].trim(),
            });
          } else if (inHunk && l[0] === '+') {
            hunks.push({ t: '+', s: l.slice(1) });
            added++;
          } else if (inHunk && l[0] === '-') {
            hunks.push({ t: '-', s: l.slice(1) });
            removed++;
          } else if (inHunk && l[0] === ' ') hunks.push({ t: ' ', s: l.slice(1) });
        }
        files.set(name, { hunks, added, removed });
      }
      return files;
    },

    async head() {
      try {
        await ensureRepo();
        return await git(['rev-parse', '--verify', '-q', 'HEAD']);
      } catch {
        return null;
      }
    },

    /** Push the mirror's branch to the configured remote. Throws a message that says what to fix. */
    async push() {
      const { git_remote: remote, git_branch: branch, git_token: token } = settings.ns('assistant');
      if (!remote)
        throw new Error('Set the remote repository URL under Settings → Assistant first.');
      if (!/^[A-Za-z0-9._/-]+$/.test(branch || 'main'))
        throw new Error('The branch name has characters git does not allow.');
      await api.sync();
      const extraEnv = {};
      if (token && /^https?:\/\//i.test(remote)) {
        const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
        Object.assign(extraEnv, {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
        });
      }
      return serial(async () => {
        try {
          await git(['push', '-q', remote, `HEAD:refs/heads/${branch || 'main'}`], { extraEnv });
        } catch (e) {
          log?.warn({ err: e.message }, 'assistant: push failed');
          throw new Error(`The push did not go through: ${e.message}`, { cause: e });
        }
        const last = await db('site_commits').max({ m: 'id' }).first();
        const t = Date.now();
        const had = await db('assistant_docs').where({ name: 'git_pushed' }).first();
        const row = { content: String(last?.m ?? 0), updated_at: t };
        if (had) await db('assistant_docs').where({ name: 'git_pushed' }).update(row);
        else await db('assistant_docs').insert({ name: 'git_pushed', ...row });
        return { pushedUpTo: Number(last?.m ?? 0) };
      });
    },
  };
  return api;
}
