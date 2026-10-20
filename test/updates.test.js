import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, signedIn, tmpDb, sharedBus, busFor, sleep, until, ADMIN } from './helpers.js';
import { loadEnv, detectSupervisor } from '../src/core/env.js';
import { redact, classifyChanges, resolveRestartMode } from '../src/modules/updates/service.js';

// Real git, real repositories: an "origin" (bare), a "work" clone that plays the developer, and one or more server checkouts.
const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
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

function makeRepos({ servers = ['server'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-upd-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, work);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text);
  };
  const push = (files, message) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git(work, 'add', '-A');
    git(work, 'commit', '-m', message);
    git(work, 'push', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  write('package.json', '{"name":"fixture","version":"1.0.0","type":"module"}');
  write('package-lock.json', LOCK('1.0.0'));
  // Stands in for the app's own CLI: the real one is what the update runs after a pull, here we only record that it was called.
  write(
    'src/cli/index.js',
    "import fs from 'node:fs';\nfs.appendFileSync('migrate.log', process.argv.slice(2).join(' ') + '\\n');\n",
  );
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'First version');
  git(work, 'push', 'origin', 'HEAD:main');
  const checkouts = Object.fromEntries(
    servers.map((s) => {
      const dir = path.join(root, s);
      git(root, 'clone', origin, dir);
      return [s, dir];
    }),
  );
  return {
    root,
    origin,
    work,
    ...checkouts,
    push,
    head: (dir) => git(dir, 'rev-parse', 'HEAD'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** A node whose updates module manages `appRoot`; resolves once it has read the checkout. */
async function nodeFor(appRoot, opts = {}) {
  const node = await startNode({ seed: true, appRoot, ...opts });
  // The source is a setting (default: the GitHub repo); the fixture's "origin" stands in for it.
  await node.ctx.settings.update('updates', {
    values: { source_url: git(appRoot, 'remote', 'get-url', 'origin'), source_branch: 'main' },
  });
  await until(() => node.ctx.updates.snapshot().git);
  return node;
}

const finished = (node) =>
  until(() => ['done', 'failed'].includes(node.ctx.updates.snapshot().status), { timeout: 30000 });
const self = (node) => node.env.nodeId;
const auditActions = async (node) =>
  (await node.ctx.audit.list({ action: 'updates.' })).map((e) => e.action);

test('a checkout in sync reports its running commit and nothing to update', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    const snap = node.ctx.updates.snapshot();
    assert.equal(snap.git.supported, true);
    assert.equal(snap.git.branch, 'main');
    assert.equal(node.ctx.updates.bootCommit(), repos.head(repos.server));

    await node.ctx.updates.dispatch(self(node), 'check', {}, null);
    await finished(node);
    assert.equal(node.ctx.updates.snapshot().status, 'done');
    assert.equal(node.ctx.updates.snapshot().message, 'Up to date.');
    assert.equal(node.ctx.updates.snapshot().git.behind, 0);
    assert.ok(
      node.ctx.updates.snapshot().git.fetchedAt,
      'the last fetch time comes from git itself',
    );
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('check finds new commits and says what they will need', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    repos.push(
      { 'package-lock.json': LOCK('1.1.0'), 'migrations/002_more.js': '// x\n' },
      'Add reports',
    );
    repos.push({ 'src/a.js': '// a\n' }, 'Tweak a');
    await node.ctx.updates.dispatch(self(node), 'check', {}, null);
    await finished(node);
    const g = node.ctx.updates.snapshot().git;
    assert.equal(g.behind, 2);
    assert.deepEqual(
      g.incoming.map((c) => c.subject),
      ['Tweak a', 'Add reports'],
    );
    assert.equal(g.needsInstall, true);
    assert.equal(g.needsMigrate, true);
    assert.equal(
      repos.head(repos.server),
      node.ctx.updates.bootCommit(),
      'a check changes nothing',
    );
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('update pulls, installs and migrates; the running commit stays until a restart, and the heartbeat says so', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  let restarts = 0;
  node.ctx.state.requestRestart = () => restarts++;
  try {
    const before = repos.head(repos.server);
    const next = repos.push(
      { 'package-lock.json': LOCK('1.1.0'), 'migrations/002_more.js': '// x\n' },
      'Add reports',
    );

    await node.ctx.updates.dispatch(
      self(node),
      'apply',
      { restart: false },
      { id: 1, email: ADMIN.email },
    );
    await finished(node);
    const snap = node.ctx.updates.snapshot();
    assert.equal(snap.status, 'done', snap.message);
    assert.match(snap.message, /Updated to .*Restart this server to run it/);
    assert.equal(repos.head(repos.server), next);
    assert.equal(fs.readFileSync(path.join(repos.server, 'migrate.log'), 'utf8'), 'migrate\n');

    const [entry] = await node.ctx.audit.list({ action: 'updates.apply' });
    assert.equal(entry.actor, ADMIN.email);
    assert.equal(entry.meta.from, before.slice(0, 12));
    assert.equal(entry.meta.to, next.slice(0, 12));
    assert.deepEqual(entry.meta.steps, ['fetch', 'merge', 'install', 'migrate']);

    // The process still runs the old code: the reported commit is the boot commit, the checkout is ahead of it.
    assert.equal(node.ctx.updates.bootCommit(), before);
    await node.ctx.nodes.start();
    const me = (await node.ctx.nodes.list()).nodes.find((n) => n.self);
    assert.equal(me.commit, before);
    assert.equal(me.update.git.headFull, next);
    await sleep(500);
    assert.equal(restarts, 0, 'no restart was asked for');
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('dependency and migration steps are skipped when nothing needs them, or when switched off', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    repos.push({ 'src/a.js': '// only code\n' }, 'Code only');
    await node.ctx.updates.dispatch(self(node), 'apply', {}, null);
    await finished(node);
    const [a] = await node.ctx.audit.list({ action: 'updates.apply' });
    assert.deepEqual(
      a.meta.steps,
      ['fetch', 'merge', 'migrate'],
      'no dependency change, no npm ci',
    );

    await node.ctx.settings.update('updates', { values: { run_migrations: false } });
    repos.push({ 'package-lock.json': LOCK('1.2.0') }, 'Bump deps');
    await node.ctx.updates.dispatch(self(node), 'apply', {}, null);
    await finished(node);
    const [b] = await node.ctx.audit.list({ action: 'updates.apply' });
    assert.deepEqual(b.meta.steps, ['fetch', 'merge', 'install']);
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('update with restart asks the process to restart once; nothing new means no restart', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  let restarts = 0;
  node.ctx.state.requestRestart = () => restarts++;
  try {
    await node.ctx.updates.dispatch(self(node), 'apply', { restart: true }, null);
    await finished(node);
    assert.equal(node.ctx.updates.snapshot().message, 'Already up to date.');
    await sleep(600);
    assert.equal(restarts, 0);

    repos.push({ 'src/a.js': '// new\n' }, 'Change');
    await node.ctx.updates.dispatch(self(node), 'apply', { restart: true }, null);
    await until(() => restarts === 1, { timeout: 30000 });
    assert.match(node.ctx.updates.snapshot().message, /Restarting/);
    assert.ok((await auditActions(node)).includes('updates.restart'));
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('a manual restart works, and reports honestly when the process cannot restart itself', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    await node.ctx.updates.dispatch(self(node), 'restart', {}, null);
    await finished(node);
    assert.equal(node.ctx.updates.snapshot().status, 'failed');
    assert.match(node.ctx.updates.snapshot().message, /can't restart itself/);

    let restarts = 0;
    node.ctx.state.requestRestart = () => restarts++;
    await node.ctx.updates.dispatch(self(node), 'restart', {}, null);
    await until(() => restarts === 1);
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('local changes to tracked files block an update and are left exactly as they were', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    fs.writeFileSync(path.join(repos.server, 'package.json'), '{"name":"edited on the server"}');
    fs.writeFileSync(path.join(repos.server, 'scratch.txt'), 'untracked files never block');
    const before = repos.head(repos.server);
    repos.push(
      { 'package.json': '{"name":"fixture","version":"2.0.0","type":"module"}' },
      'Conflicting change',
    );

    await node.ctx.updates.dispatch(self(node), 'apply', {}, null);
    await finished(node);
    const snap = node.ctx.updates.snapshot();
    assert.equal(snap.status, 'failed');
    assert.match(snap.message, /uncommitted changes.*commit or stash/i);
    assert.equal(repos.head(repos.server), before);
    assert.equal(
      fs.readFileSync(path.join(repos.server, 'package.json'), 'utf8'),
      '{"name":"edited on the server"}',
    );
    assert.ok((await auditActions(node)).includes('updates.apply_failed'));
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('a checkout with its own commits is not fast-forwarded', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    fs.writeFileSync(path.join(repos.server, 'local.txt'), 'only here');
    git(repos.server, 'add', '-A');
    git(repos.server, 'commit', '-m', 'Hotfix on the server');
    const mine = repos.head(repos.server);
    repos.push({ 'src/a.js': '// upstream\n' }, 'Upstream change');

    await node.ctx.updates.dispatch(self(node), 'apply', {}, null);
    await finished(node);
    assert.equal(node.ctx.updates.snapshot().status, 'failed');
    assert.match(node.ctx.updates.snapshot().message, /aren't on the remote/);
    assert.equal(repos.head(repos.server), mine);
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('a server that is not a git checkout says so and cannot update', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-nogit-'));
  const node = await nodeFor(dir);
  try {
    const g = node.ctx.updates.snapshot().git;
    assert.equal(g.supported, false);
    assert.equal(g.reason, 'not_a_repo');
    assert.equal(node.ctx.updates.bootCommit(), null);
    await node.ctx.updates.dispatch(self(node), 'apply', {}, null);
    await finished(node);
    assert.equal(node.ctx.updates.snapshot().status, 'failed');
    assert.match(node.ctx.updates.snapshot().message, /isn't running from a git checkout/);
  } finally {
    await node.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed fetch changes nothing, says how to fix it, and never shows credentials in the remote URL', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    await node.ctx.settings.update('updates', {
      values: { source_url: 'https://deploy:hunter2secret@127.0.0.1:1/repo.git' },
    });
    const before = repos.head(repos.server);
    await until(() => /\*\*\*@/.test(node.ctx.updates.snapshot().git?.sourceUrl ?? ''));
    assert.match(node.ctx.updates.snapshot().git.sourceUrl, /^https:\/\/\*\*\*@127\.0\.0\.1/);

    await node.ctx.updates.dispatch(self(node), 'apply', {}, null);
    await finished(node);
    const snap = node.ctx.updates.snapshot();
    assert.equal(snap.status, 'failed');
    assert.match(snap.message, /Couldn't fetch branch "main" from https:\/\/\*\*\*@.*read access/);
    assert.equal(repos.head(repos.server), before);

    await node.ctx.nodes.start();
    const everything = JSON.stringify([
      snap,
      await node.ctx.audit.list({ limit: 50 }),
      await node.ctx.db('cluster_nodes'),
    ]);
    assert.doesNotMatch(everything, /hunter2secret/);
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('one action at a time per server', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  try {
    const first = node.ctx.updates.dispatch(self(node), 'check', {}, null);
    await assert.rejects(node.ctx.updates.dispatch(self(node), 'check', {}, null), {
      code: 'busy',
      status: 409,
    });
    await first;
    await finished(node);
    await assert.rejects(node.ctx.updates.dispatch(self(node), 'format-disk', {}, null), {
      code: 'bad_action',
    });
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('the update source defaults to the official repository, and only accepts a URL and a branch, never a git option', async () => {
  const node = await startNode({ seed: true });
  try {
    assert.equal(
      node.ctx.settings.get('updates.source_url'),
      'https://github.com/Logiks/Logiks-WebCMS.git',
    );
    assert.equal(node.ctx.settings.get('updates.source_branch'), 'master');
    for (const bad of ['--upload-pack=touch /tmp/pwned', '-x', 'a b', '']) {
      await assert.rejects(
        node.ctx.settings.update('updates', { values: { source_url: bad } }),
        undefined,
        `should refuse URL ${JSON.stringify(bad)}`,
      );
    }
    for (const bad of ['--x', 'a b', 'a..b', 'x;ls', '']) {
      await assert.rejects(
        node.ctx.settings.update('updates', { values: { source_branch: bad } }),
        undefined,
        `should refuse branch ${JSON.stringify(bad)}`,
      );
    }
    await node.ctx.settings.update('updates', { values: { source_branch: 'release/2.x' } });
    assert.equal(node.ctx.settings.get('updates.source_branch'), 'release/2.x');
  } finally {
    await node.close();
  }
});

test('HTTP: viewing needs system.update, restarting needs system.restart on top, and everything is audited', async () => {
  const repos = makeRepos();
  const node = await nodeFor(repos.server);
  let restarts = 0;
  node.ctx.state.requestRestart = () => restarts++;
  try {
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
    const id = self(node);

    const v = await signedIn(node.app, { email: 'v@example.com', password: 'Some-long-pass-12' });
    assert.equal((await v.get('/api/admin/updates')).status, 403);
    assert.equal((await v.post(`/api/admin/updates/nodes/${id}/check`).send({})).status, 403);

    const d = await signedIn(node.app, { email: 'd@example.com', password: 'Some-long-pass-12' });
    const list = await d.get('/api/admin/updates');
    assert.equal(list.status, 200);
    assert.equal(list.body.self, id);
    const listed = (await d.get('/api/admin/updates')).body;
    assert.equal(listed.nodes[0].commit, repos.head(repos.server));
    assert.equal(listed.nodes[0].update.git.branch, 'main');
    assert.match(listed.restartMode, /^(supervisor|self)$/);

    const denied = await d.post(`/api/admin/updates/nodes/${id}/apply`).send({ restart: true });
    assert.equal(denied.status, 403);
    assert.match(denied.body.error.message, /Restart servers/);
    assert.equal((await d.post(`/api/admin/updates/nodes/${id}/restart`).send({})).status, 403);
    assert.equal(
      (await d.post(`/api/admin/updates/nodes/${id}/apply`).send({ restart: 'yes' })).status,
      422,
    );
    assert.equal(
      (await d.post('/api/admin/updates/nodes/no-such-node/check').send({})).status,
      404,
    );

    const ok = await d.post(`/api/admin/updates/nodes/${id}/apply`).send({ restart: false });
    assert.equal(ok.status, 202);
    await finished(node);
    assert.equal(restarts, 0);

    const admin = await signedIn(node.app);
    const restarted = await admin.post(`/api/admin/updates/nodes/${id}/restart`).send({});
    assert.equal(restarted.status, 202);
    await until(() => restarts === 1);

    const history = await d.get('/api/admin/updates/history');
    assert.equal(history.status, 200);
    assert.deepEqual(
      history.body.entries.map((e) => e.action),
      ['updates.restart', 'updates.apply'],
    );
    assert.equal(history.body.entries[1].actor, 'd@example.com');
  } finally {
    await node.close();
    repos.cleanup();
  }
});

test('cluster: an update requested on one server runs on the server you picked, and the other one sees the result', async () => {
  const repos = makeRepos({ servers: ['one', 'two'] });
  const db = tmpDb();
  const emitter = sharedBus();
  const a = await startNode({
    dbUrl: db.url,
    seed: true,
    bus: busFor(emitter),
    appRoot: repos.one,
  });
  const b = await startNode({ dbUrl: db.url, bus: busFor(emitter), appRoot: repos.two });
  try {
    await until(() => a.ctx.updates.snapshot().git && b.ctx.updates.snapshot().git);
    await a.ctx.nodes.start();
    await b.ctx.nodes.start();
    const next = repos.push({ 'src/a.js': '// new\n' }, 'Ship it');
    const before = repos.head(repos.one);

    const admin = await signedIn(a.app);
    const res = await admin
      .post(`/api/admin/updates/nodes/${b.env.nodeId}/apply`)
      .send({ restart: false });
    assert.equal(res.status, 202);
    await finished(b);
    assert.equal(b.ctx.updates.snapshot().status, 'done', b.ctx.updates.snapshot().message);
    assert.equal(repos.head(repos.two), next, 'the picked server was updated');
    assert.equal(repos.head(repos.one), before, 'the server that took the request was not');

    // …and the requesting server can read the outcome from the shared heartbeat table.
    await until(async () => {
      const seen = (await admin.get('/api/admin/updates')).body.nodes.find(
        (n) => n.id === b.env.nodeId,
      );
      return seen?.update?.status === 'done' && seen.update.git.headFull === next;
    });
    const [entry] = await a.ctx.audit.list({ action: 'updates.apply' });
    assert.equal(
      entry.actor,
      ADMIN.email,
      'the audit entry names the admin who asked, not the server that ran it',
    );

    // Unknown or stale servers are refused instead of the message vanishing into the bus.
    await a.ctx.db('cluster_nodes').where({ node_id: b.env.nodeId }).update({ last_seen: 1 });
    const stale = await admin.post(`/api/admin/updates/nodes/${b.env.nodeId}/check`).send({});
    assert.equal(stale.status, 409);
    assert.match(stale.body.error.message, /isn't reporting in/);
  } finally {
    await Promise.all([a.close(), b.close()]);
    db.cleanup();
    repos.cleanup();
  }
});

test('helpers: credentials are redacted, changed files are classified, the restart method resolves sensibly', () => {
  assert.equal(
    redact('From https://user:tok3n@github.com/x/y.git\nfatal: ssh://git:pw@host/repo'),
    'From https://***@github.com/x/y.git\nfatal: ssh://***@host/repo',
  );
  assert.equal(redact('//reg/:_authToken=abc123 x'), '//reg/:_authToken=*** x');
  assert.equal(redact('no secrets here'), 'no secrets here');

  assert.deepEqual(classifyChanges(['src/a.js']), { needsInstall: false, needsMigrate: false });
  assert.deepEqual(classifyChanges(['package-lock.json', 'migrations/9.js']), {
    needsInstall: true,
    needsMigrate: true,
  });
  assert.equal(
    classifyChanges(['docs/package.json']).needsInstall,
    false,
    'only the app own manifest counts',
  );

  assert.equal(resolveRestartMode('auto', true), 'supervisor');
  assert.equal(resolveRestartMode('auto', false), 'self');
  assert.equal(resolveRestartMode('supervisor', false), 'supervisor');
  assert.equal(resolveRestartMode('self', true), 'self');

  assert.equal(detectSupervisor({ INVOCATION_ID: 'abc' }), true, 'systemd');
  assert.equal(detectSupervisor({ pm_id: '0' }), true, 'PM2');
  assert.equal(detectSupervisor({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }), true);
  const env = loadEnv({ NODE_ENV: 'test', DB_URL: 'sqlite:x', GIT_TERMINAL_PROMPT: '1' });
  assert.equal(env.childEnv().GIT_TERMINAL_PROMPT, '0', 'git must never wait for a password');
  assert.ok(!JSON.stringify(env).includes('APP_MASTER_KEY=') && typeof env.childEnv === 'function');
});

test('the update source can be changed to another repository and branch, and updates then come from it', async () => {
  const repos = makeRepos();
  // A second repository: a clone of origin with one extra commit only it has.
  const mirror = path.join(path.dirname(repos.origin), 'mirror.git');
  git(path.dirname(repos.origin), 'clone', '--bare', repos.origin, mirror);
  const extra = path.join(path.dirname(repos.origin), 'extra');
  git(path.dirname(repos.origin), 'clone', mirror, extra);
  fs.writeFileSync(path.join(extra, 'mirror-only.txt'), 'x');
  git(extra, 'add', '.');
  git(extra, 'commit', '-m', 'mirror only');
  git(extra, 'push', 'origin', 'HEAD:main');
  const node = await nodeFor(repos.server);
  try {
    await node.ctx.updates.dispatch(self(node), 'check', {}, null);
    await finished(node);
    assert.equal(node.ctx.updates.snapshot().git.behind, 0);

    await node.ctx.updates.setSource({ url: mirror, branch: 'main' }, null);
    assert.equal(node.ctx.settings.get('updates.source_url'), mirror);
    assert.equal(node.ctx.updates.snapshot().git.sourceUrl, mirror);
    assert.ok((await auditActions(node)).includes('updates.source'));

    await node.ctx.updates.dispatch(self(node), 'check', {}, null);
    await finished(node);
    assert.equal(node.ctx.updates.snapshot().git.behind, 1);

    // A branch that doesn't exist at the source is a clear failure, not a silent "up to date".
    await node.ctx.updates.setSource({ url: mirror, branch: 'nope' }, null);
    await node.ctx.updates.dispatch(self(node), 'check', {}, null);
    await finished(node);
    assert.equal(node.ctx.updates.snapshot().status, 'failed');
    assert.match(node.ctx.updates.snapshot().message, /branch "nope"/);
  } finally {
    await node.close();
    repos.cleanup();
  }
});
