import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, MASTER_KEY, client, tmpDbUrl, until } from './helpers.js';
import { RESTART_EXIT_CODE } from '../src/core/lifecycle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src/server.js');
const CLI = path.join(ROOT, 'src/cli/index.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** A real server process (own database, seeded admin) whose restart method is fixed by a setting, so the result doesn't depend on the machine. */
async function boot(restartMode) {
  const db = tmpDbUrl();
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_MASTER_KEY: MASTER_KEY,
    DB_URL: db.url,
    PORT: String(port),
    HOST: '127.0.0.1',
    ROLE: 'all',
    SITE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cms-site-')), // never the repository's own public/
  };
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, stdio: 'pipe' });
  cli('setup', '--email', ADMIN.email, '--password', ADMIN.password);
  cli('config:set', 'updates.restart_mode', restartMode);
  const child = spawn(process.execPath, [SERVER], { env, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  const url = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(`${url}/readyz`).catch(() => null))?.status === 200, {
    timeout: 10000,
    every: 100,
  });
  const c = client(url);
  assert.equal((await c.post('/api/auth/login', ADMIN)).status, 200);
  await c.refresh(); // the CSRF token is bound to the session, which login replaced
  const first = (await c.get('/api/admin/updates')).body;
  return { child, exited, url, db, c, id: first.self, restartMode: first.restartMode };
}

test('restart under a supervisor: drains, then exits with a failure code so systemd/Docker start it again', async () => {
  const n = await boot('supervisor');
  try {
    assert.equal(n.restartMode, 'supervisor');
    const res = await n.c.post(`/api/admin/updates/nodes/${n.id}/restart`, {});
    assert.equal(res.status, 202);
    const { code } = await n.exited;
    assert.equal(code, RESTART_EXIT_CODE);
    await assert.rejects(fetch(`${n.url}/healthz`), 'the listener is closed');
  } finally {
    n.child.kill('SIGKILL');
    n.db.cleanup();
  }
});

test('restart without a supervisor: the process starts a fresh copy of itself on the same port', async () => {
  const n = await boot('self');
  let replacementPid;
  try {
    assert.equal(n.restartMode, 'self');
    const res = await n.c.post(`/api/admin/updates/nodes/${n.id}/restart`, {});
    assert.equal(res.status, 202);
    assert.equal((await n.exited).code, 0, 'the old process leaves cleanly');

    // The new process has its own node id; the admin session (stored in the database) is still valid on it.
    const back = await until(
      async () => {
        const r = await n.c.get('/api/admin/updates').catch(() => null);
        // The new process answers before its own heartbeat row exists, so also wait until it lists itself.
        return r?.status === 200 && r.body.self !== n.id && r.body.nodes?.some((x) => x.self)
          ? r.body
          : null;
      },
      { timeout: 20000, every: 200 },
    );
    replacementPid = back.nodes.find((x) => x.self).pid;
    assert.notEqual(replacementPid, n.child.pid);
    assert.equal((await fetch(`${n.url}/readyz`)).status, 200);
  } finally {
    if (replacementPid) {
      try {
        process.kill(replacementPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    n.child.kill('SIGKILL');
    n.db.cleanup();
  }
});
