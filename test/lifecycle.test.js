import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MASTER_KEY, sleep, tmpDbUrl, until } from './helpers.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function boot(extra = {}) {
  const db = tmpDbUrl();
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_MASTER_KEY: MASTER_KEY,
      DB_URL: db.url,
      PORT: String(port),
      HOST: '127.0.0.1',
      ROLE: 'all',
      ...extra,
    },
    stdio: 'ignore',
  });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  const url = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(`${url}/readyz`).catch(() => null))?.status === 200, {
    timeout: 8000,
    every: 100,
  });
  return { child, exited, url, db };
}

test('SIGTERM drains: /readyz fails first, /healthz stays green, then the process exits cleanly', async () => {
  const n = await boot({ SHUTDOWN_DELAY_MS: '1500' });
  try {
    assert.equal((await fetch(`${n.url}/readyz`)).status, 200);
    const t0 = Date.now();
    n.child.kill('SIGTERM');

    await until(async () => (await fetch(`${n.url}/readyz`).catch(() => null))?.status === 503, {
      timeout: 1000,
      every: 50,
    });
    const ready = await (await fetch(`${n.url}/readyz`)).json();
    assert.equal(ready.checks.draining, false);
    assert.equal(
      (await fetch(`${n.url}/healthz`)).status,
      200,
      'still serving traffic while draining',
    );
    assert.equal(
      (await fetch(`${n.url}/api/public/info`)).status,
      200,
      'in-flight/late requests are still answered during the drain window',
    );

    const { code } = await n.exited;
    assert.equal(code, 0);
    assert.ok(
      Date.now() - t0 >= 1400,
      'waited out the deregistration delay before closing the listener',
    );
    await assert.rejects(fetch(`${n.url}/healthz`), 'listener is closed after shutdown');
  } finally {
    n.child.kill('SIGKILL');
    n.db.cleanup();
  }
});

test('a worker-only process serves no HTTP and shuts down on SIGTERM', async () => {
  const db = tmpDbUrl();
  // web process creates the schema first
  const web = await boot({ DB_URL: db.url });
  web.child.kill('SIGTERM');
  await web.exited;
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_MASTER_KEY: MASTER_KEY,
      DB_URL: db.url,
      ROLE: 'worker',
      PORT: '1',
    },
    stdio: 'ignore',
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  await sleep(1200);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  web.db.cleanup();
  db.cleanup();
});

test('production refuses to start with pending migrations (they are a deploy step)', async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      ALLOW_SINGLE_NODE: 'true',
      LOG_LEVEL: 'silent',
      APP_MASTER_KEY: MASTER_KEY,
      DB_URL: tmpDbUrl().url,
      PORT: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => child.on('exit', r));
  assert.notEqual(code, 0);
  assert.match(err, /pending database migration/);
});

test('a SIGTERM that arrives while the process is still starting up still drains and exits cleanly', async () => {
  // The server logs "listening" before the rest of startup (job worker, heartbeat) finishes. Signal it right then.
  for (let i = 0; i < 4; i++) {
    const db = tmpDbUrl();
    const child = spawn(process.execPath, [SERVER], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        APP_MASTER_KEY: MASTER_KEY,
        DB_URL: db.url,
        PORT: String(await freePort()),
        HOST: '127.0.0.1',
        ROLE: 'all',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    try {
      await new Promise((/** @type {(v?: any) => void} */ resolve, reject) => {
        child.stdout.on('data', (d) => {
          if (String(d).includes('web server listening')) resolve();
        });
        child.on('exit', () => reject(new Error('server exited before it started listening')));
      });
      child.kill('SIGTERM');
      const { code, signal } = await exited;
      assert.deepEqual({ code, signal }, { code: 0, signal: null }, `run ${i + 1}: clean exit`);
    } finally {
      child.kill('SIGKILL');
      db.cleanup();
    }
  }
});
