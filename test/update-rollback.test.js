import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, signedIn, until, ADMIN } from './helpers.js';
import {
  runUpdateGuard,
  markPending,
  pendingFile,
  takeRolledBack,
} from '../src/core/update-guard.js';

// Real git repositories, as in updates.test.js: an "origin", a "work" clone that plays the developer, and a server checkout.
const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: 'pipe' },
  ).trim();

const LOCK = (v) =>
  JSON.stringify({
    name: 'fixture',
    version: v,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture', version: v } },
  });

function makeRepos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-rb-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const server = path.join(root, 'server');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, work);
  const push = (files, message) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), text);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '-m', message);
    git(work, 'push', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  push(
    {
      'package.json': '{"name":"fixture","version":"1.0.0","type":"module"}',
      'package-lock.json': LOCK('1.0.0'),
      'src/cli/index.js':
        "import fs from 'node:fs';\nfs.appendFileSync('migrate.log', process.argv.slice(2).join(' ') + '\\n');\n",
      'app.txt': 'v1',
    },
    'First version',
  );
  git(root, 'clone', origin, server);
  return {
    root,
    work,
    server,
    push,
    head: (d) => git(d, 'rev-parse', 'HEAD'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function nodeFor(appRoot, settings = {}) {
  const node = await startNode({ seed: true, appRoot });
  await node.ctx.settings.update('updates', {
    values: {
      source_url: git(appRoot, 'remote', 'get-url', 'origin'),
      source_branch: 'main',
      ...settings,
    },
  });
  await until(() => node.ctx.updates.snapshot().git);
  return node;
}

const finished = (node) =>
  until(() => ['done', 'failed'].includes(node.ctx.updates.snapshot().status), { timeout: 30000 });
const id = (node) => node.env.nodeId;
const run = async (node, action, opts = {}) => {
  await node.ctx.updates.dispatch(id(node), action, opts, { id: 1, email: ADMIN.email });
  await finished(node);
  return node.ctx.updates.snapshot();
};
const actions = async (node) =>
  (await node.ctx.audit.list({ action: 'updates.' })).map((e) => e.action);

test('an update records a restore point, and rolling back puts the code back without touching the database', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    const before = repos.head(repos.server);
    const next = repos.push(
      { 'app.txt': 'v2', 'package-lock.json': LOCK('1.1.0'), 'migrations/002_more.js': '// x\n' },
      'Second',
    );
    assert.equal((await run(node, 'apply')).status, 'done');

    const [point] = await node.ctx.updates.restorePoints();
    assert.equal(point.from, before);
    assert.equal(point.to, next);
    assert.equal(point.status, 'available');
    assert.equal(point.migrationsChanged, true);
    assert.equal(point.installChanged, true);
    const [applied] = await node.ctx.audit.list({ action: 'updates.apply' });
    assert.equal(applied.meta.restore_point, point.id);
    const migrateLog = fs.readFileSync(path.join(repos.server, 'migrate.log'), 'utf8');

    const snap = await run(node, 'rollback', { pointId: point.id });
    assert.equal(snap.status, 'done', snap.message);
    assert.match(snap.message, /Rolled back to .*database keeps the newer tables/);
    assert.equal(repos.head(repos.server), before);
    assert.equal(fs.readFileSync(path.join(repos.server, 'app.txt'), 'utf8'), 'v1');
    assert.equal(
      fs.readFileSync(path.join(repos.server, 'migrate.log'), 'utf8'),
      migrateLog,
      'rolling back never runs migrations',
    );
    assert.equal((await node.ctx.updates.restorePoints())[0].status, 'rolled_back');
    const [entry] = await node.ctx.audit.list({ action: 'updates.rollback' });
    assert.equal(entry.meta.to, before.slice(0, 12));
    assert.equal(entry.meta.database_kept, true);

    // It is offered again as an ordinary update, and applying it records a fresh restore point.
    assert.equal((await run(node, 'check')).git.behind, 1);
    assert.equal((await run(node, 'apply')).status, 'done');
    assert.equal((await node.ctx.updates.restorePoints())[0].status, 'available');
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('rollback with restart asks the process to restart once; the database lists migrations the older code does not know', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  let restarts = 0;
  node.ctx.state.requestRestart = () => restarts++;
  try {
    repos.push({ 'app.txt': 'v2' }, 'Second');
    await run(node, 'apply');
    const [point] = await node.ctx.updates.restorePoints();
    await node.ctx.updates.dispatch(
      id(node),
      'rollback',
      { pointId: point.id, restart: true },
      null,
    );
    await until(() => restarts === 1);

    // Older code on a database that has run a migration the older code has no file for must still boot (D-127).
    await node.ctx
      .db('knex_migrations')
      .insert({ name: '29990101000000_from_the_future.js', batch: 99, migration_time: new Date() });
    const [done, pending] = await node.ctx.db.migrate.list();
    assert.ok(done.length > 0);
    assert.equal(pending.length, 0);
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('rollback refuses local changes, an unknown point, a point from another server and the version already running', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    repos.push({ 'app.txt': 'v2' }, 'Second');
    await run(node, 'apply');
    const [point] = await node.ctx.updates.restorePoints();

    fs.writeFileSync(path.join(repos.server, 'app.txt'), 'edited here');
    let snap = await run(node, 'rollback', { pointId: point.id });
    assert.equal(snap.status, 'failed');
    assert.match(snap.message, /would discard them/);
    assert.equal(fs.readFileSync(path.join(repos.server, 'app.txt'), 'utf8'), 'edited here');
    git(repos.server, 'checkout', '--', 'app.txt');

    snap = await run(node, 'rollback', { pointId: 99999 });
    assert.match(snap.message, /not on this server/);

    await node.ctx
      .db('update_restore_points')
      .where({ id: point.id })
      .update({ server_key: 'someone-else' });
    snap = await run(node, 'rollback', { pointId: point.id });
    assert.match(snap.message, /not on this server/);
    await node.ctx
      .db('update_restore_points')
      .where({ id: point.id })
      .update({ server_key: node.ctx.updates.serverKey() });

    await node.ctx
      .db('update_restore_points')
      .where({ id: point.id })
      .update({ from_commit: repos.head(repos.server) });
    snap = await run(node, 'rollback', { pointId: point.id });
    assert.match(snap.message, /Nothing to roll back/);
    assert.equal((await actions(node)).filter((a) => a === 'updates.rollback_failed').length, 4);
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('only the last 5 restore points and their safety backups are kept', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server, { backup_before_update: true });
  try {
    for (let i = 2; i <= 7; i++) {
      repos.push({ 'app.txt': `v${i}` }, `Version ${i}`);
      const snap = await run(node, 'apply');
      assert.equal(snap.status, 'done', snap.message);
    }
    const points = await node.ctx.updates.restorePoints();
    assert.equal(points.length, 5);
    assert.ok(
      points.every((p) => p.backupReady),
      'each point has a ready backup',
    );
    const backups = (await node.ctx.backup.list()).filter((b) => b.source === 'update');
    assert.equal(backups.length, 5);
    assert.deepEqual(backups.map((b) => b.id).sort(), points.map((p) => p.backupId).sort());
    const [applied] = await node.ctx.audit.list({ action: 'updates.apply' });
    assert.equal(applied.meta.backup, points[0].backupId);
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('if the backup before an update cannot be made, nothing is changed', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server, { backup_before_update: true });
  try {
    const before = repos.head(repos.server);
    repos.push({ 'app.txt': 'v2' }, 'Second');
    const real = node.ctx.backup;
    node.ctx.backup = null;
    const snap = await run(node, 'apply');
    node.ctx.backup = real;
    assert.equal(snap.status, 'failed');
    assert.match(
      snap.message,
      /backup before the update cannot be made.*nothing|Backups are switched off/i,
    );
    assert.equal(repos.head(repos.server), before);
    assert.equal((await node.ctx.updates.restorePoints()).length, 0);
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('HTTP: restore points and rollback need system.update; rollback with restart needs system.restart too', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  node.ctx.state.requestRestart = () => {};
  try {
    repos.push({ 'app.txt': 'v2' }, 'Second');
    await run(node, 'apply');
    const [point] = await node.ctx.updates.restorePoints();
    const viewer = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
    await node.ctx.users.createUser(
      {
        email: 'v@example.com',
        name: 'V',
        password: 'Some-long-pass-12',
        roleId: Number(viewer.id),
      },
      null,
    );
    const deployer = await node.ctx.users.createRole(
      { name: 'Deployer', permissions: ['admin.access', 'system.update'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'd@example.com',
        name: 'D',
        password: 'Some-long-pass-12',
        roleId: Number(deployer.id),
      },
      null,
    );

    const v = await signedIn(node.app, { email: 'v@example.com', password: 'Some-long-pass-12' });
    assert.equal((await v.get('/api/admin/updates/restore-points')).status, 403);
    assert.equal(
      (await v.post(`/api/admin/updates/nodes/${id(node)}/rollback`).send({ pointId: point.id }))
        .status,
      403,
    );

    const d = await signedIn(node.app, { email: 'd@example.com', password: 'Some-long-pass-12' });
    const list = await d.get('/api/admin/updates/restore-points');
    assert.equal(list.status, 200);
    assert.equal(list.body.items[0].id, point.id);
    assert.equal(
      (
        await d
          .post(`/api/admin/updates/nodes/${id(node)}/rollback`)
          .send({ pointId: point.id, restart: true })
      ).status,
      403,
    );
    assert.equal(
      (await d.post(`/api/admin/updates/nodes/${id(node)}/rollback`).send({ pointId: 'x' })).status,
      422,
    );
    const ok = await d
      .post(`/api/admin/updates/nodes/${id(node)}/rollback`)
      .send({ pointId: point.id });
    assert.equal(ok.status, 202);
    await finished(node);
    assert.equal(node.ctx.updates.snapshot().status, 'done');
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('update guard: a server that keeps crashing on new code is put back on the old version before the app loads', () => {
  const repos = makeRepos();
  try {
    const from = repos.head(repos.server);
    const to = repos.push({ 'app.txt': 'broken', 'package-lock.json': LOCK('2.0.0') }, 'Broken');
    git(repos.server, 'pull', '--ff-only');
    const quiet = () => {};

    assert.deepEqual(runUpdateGuard(repos.server, quiet), { rolledBack: false }, 'nothing pending');

    markPending(repos.server, { from, to, installChanged: true, autoRollback: true, pointId: 1 });
    assert.equal(runUpdateGuard(repos.server, quiet).rolledBack, false, 'first boot');
    assert.equal(runUpdateGuard(repos.server, quiet).rolledBack, false, 'second boot');
    assert.equal(repos.head(repos.server), to);
    const res = runUpdateGuard(repos.server, quiet);
    assert.equal(res.rolledBack, true, res.error);
    assert.equal(repos.head(repos.server), from);
    assert.equal(fs.existsSync(pendingFile(repos.server)), false);
    const note = takeRolledBack(repos.server);
    assert.equal(note.from, from);
    assert.equal(note.to, to);
    assert.equal(takeRolledBack(repos.server), null, 'read once');
  } finally {
    repos.cleanup();
  }
});

test('update guard: does nothing when automatic rollback is off, and a healthy start clears the count', () => {
  const repos = makeRepos();
  try {
    const from = repos.head(repos.server);
    const to = repos.push({ 'app.txt': 'v2' }, 'Second');
    git(repos.server, 'pull', '--ff-only');
    markPending(repos.server, { from, to, autoRollback: false });
    for (let i = 0; i < 5; i++)
      assert.equal(runUpdateGuard(repos.server, () => {}).rolledBack, false);
    assert.equal(repos.head(repos.server), to);
  } finally {
    repos.cleanup();
  }
});

test('an update arms the guard when automatic rollback is on, and not when it is off', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    repos.push({ 'app.txt': 'v2' }, 'Second');
    await run(node, 'apply');
    const marker = JSON.parse(fs.readFileSync(pendingFile(repos.server), 'utf8'));
    assert.equal(marker.to, repos.head(repos.server));
    assert.equal(marker.autoRollback, true);
    fs.rmSync(pendingFile(repos.server));
    await node.ctx.settings.update('updates', { values: { auto_rollback: false } });
    repos.push({ 'app.txt': 'v3' }, 'Third');
    await run(node, 'apply');
    assert.equal(fs.existsSync(pendingFile(repos.server)), false);
  } finally {
    await node.close();
    repos.cleanup();
  }
});
