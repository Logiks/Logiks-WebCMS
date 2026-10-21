import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';

let node, admin, tmp, remote, work;
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=Other Dev', '-c', 'user.email=dev@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
const page = (title, body = '<h1>Hi</h1>') => `---\ntitle: "${title}"\n---\n${body}\n`;
const put = (p, text) => node.ctx.siteFiles.put(p, text, { id: 1, email: 'admin@example.com' });
const get = (p) => {
  try {
    return node.ctx.siteFiles.get(p).content;
  } catch {
    return null;
  }
};
const api = (m, url, body) => admin[m](`/api/admin/publish${url}`).send(body);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-publish-'));
  remote = path.join(tmp, 'remote.git');
  work = path.join(tmp, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  node = await makeNode({ env: { VERSIONS_DIR: path.join(tmp, 'versions') } });
  admin = await signedIn(node.app);
  await node.ctx.settings.update('assistant', {
    values: { git_remote: remote, git_branch: 'main' },
  });
  await put('pages/home-test.html', page('Home'));
  await api('post', '/commit', { message: 'start' }); // first call only starts tracking
});
after(async () => {
  await node.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('commit records what changed since the last commit, and says when nothing did', async () => {
  await put('pages/a.html', page('A'));
  const st = (await api('get', '/status')).body;
  assert.ok(st.pendingFiles.some((f) => f.path === 'pages/a.html'));
  const c = await api('post', '/commit', { message: 'add A' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.commit.message, 'add A');
  assert.equal((await api('post', '/commit', {})).body.clean, true);
  assert.equal((await api('get', '/status')).body.pendingFiles.length, 0);
});

test('publish commits, tags a release, bumps the cache version and the versioned filter follows it', async () => {
  await put(
    'pages/vtest.html',
    page('V', `<link rel="stylesheet" href="{{ '/x.css' | versioned }}">`),
  );
  const before_ = await request(node.app).get('/vtest');
  assert.equal(before_.status, 200, before_.text.slice(0, 200));
  const v0 = Number(before_.headers['x-site-version']);
  assert.match(before_.text, new RegExp(`/x\\.css\\?v=${v0}`));

  const res = await api('post', '/publish', { note: 'first release' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.version, 1);
  assert.equal(res.body.cacheVersion, v0 + 1);
  assert.equal(
    (await api('get', '/status')).body.pendingFiles.length,
    0,
    'publishing commits what was pending',
  );
  assert.match(git(path.join(tmp, 'versions'), 'tag', '--list'), /^v1$/m);

  const after_ = await request(node.app).get('/vtest');
  assert.equal(Number(after_.headers['x-site-version']), v0 + 1);
  assert.match(
    after_.text,
    new RegExp(`/x\\.css\\?v=${v0 + 1}`),
    'the cached page was dropped and re-rendered',
  );

  const versions = (await api('get', '/versions')).body.versions;
  assert.equal(versions[0].version, 1);
  assert.equal(versions[0].note, 'first release');
  assert.equal((await api('post', '/publish', { note: 'second' })).body.version, 2);

  const purge = await api('post', '/purge-cache');
  assert.equal(purge.body.cacheVersion, v0 + 3);
});

test('push sends the branch and its release tags; a second push is a no-op', async () => {
  const r = await api('post', '/push');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(git(remote, 'tag', '--list'), /v1/);
  assert.ok(git(remote, 'rev-parse', 'main'));
  assert.equal((await api('post', '/push')).status, 200);
  const st = (await api('get', '/status?refresh=true')).body;
  assert.equal(st.ahead, 0);
  assert.equal(st.behind, 0);
});

test('pull fast-forwards changes made elsewhere into the live site as one revertible entry', async () => {
  execFileSync('git', ['clone', '-q', remote, work]);
  fs.mkdirSync(path.join(work, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(work, 'pages/about.html'), page('About us'));
  fs.writeFileSync(path.join(work, 'README.md'), 'not a site document');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'add about page elsewhere');
  git(work, 'push', '-q', 'origin', 'main');

  const st = (await api('get', '/status?refresh=true')).body;
  assert.equal(st.behind, 1);
  const r = await api('post', '/pull', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'fast_forwarded');
  assert.match(get('pages/about.html'), /About us/);
  assert.equal(get('README.md'), null, 'files that are not site documents are left out');
  const log = (await api('get', '/log')).body.commits;
  assert.equal(log[0].kind, 'pull');
  assert.equal(
    git(path.join(tmp, 'versions'), 'rev-parse', 'HEAD'),
    git(remote, 'rev-parse', 'main'),
    'a fast-forward keeps the very same commit ids as the remote',
  );
  assert.equal((await api('post', '/pull', {})).body.status, 'up_to_date');

  const rev = await admin.post(`/api/admin/assistant/history/${log[0].id}/revert`).send({});
  assert.equal(rev.status, 200);
  assert.equal(get('pages/about.html'), null, 'the pull can be undone');
  await put('pages/about.html', page('About us')); // put it back for the next tests
  await api('post', '/commit', { message: 'restore about' });
});

test('both sides changed the same page: a conflict is listed and nothing changes until you choose', async () => {
  await put('pages/shared.html', page('Shared', '<p>base</p>'));
  await api('post', '/commit', { message: 'shared base' });
  await api('post', '/push');
  git(work, 'pull', '-q', '--ff-only', 'origin', 'main');
  fs.writeFileSync(path.join(work, 'pages/shared.html'), page('Shared', '<p>remote edit</p>'));
  fs.writeFileSync(path.join(work, 'pages/only-remote.html'), page('Only remote'));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'remote edit');
  git(work, 'push', '-q', 'origin', 'main');
  await put('pages/shared.html', page('Shared', '<p>local edit</p>')); // uncommitted: pull commits it first

  const c = await api('post', '/pull', {});
  assert.equal(c.body.status, 'conflict', JSON.stringify(c.body));
  assert.deepEqual(c.body.conflicts, ['pages/shared.html']);
  assert.match(get('pages/shared.html'), /local edit/);
  assert.equal(get('pages/only-remote.html'), null, 'nothing was applied');

  const ours = await api('post', '/pull', { prefer: 'ours' });
  assert.equal(ours.body.status, 'merged', JSON.stringify(ours.body));
  assert.match(get('pages/shared.html'), /local edit/);
  assert.match(
    get('pages/only-remote.html'),
    /Only remote/,
    'the non-conflicting change still came in',
  );
  assert.equal((await api('post', '/push')).status, 200, 'a merge can be pushed');

  git(work, 'pull', '-q', '--ff-only', 'origin', 'main');
  fs.writeFileSync(path.join(work, 'pages/shared.html'), page('Shared', '<p>remote again</p>'));
  git(work, 'commit', '-qam', 'again');
  git(work, 'push', '-q', 'origin', 'main');
  await put('pages/shared.html', page('Shared', '<p>local again</p>'));
  const theirs = await api('post', '/pull', { prefer: 'theirs' });
  assert.equal(theirs.body.status, 'merged', JSON.stringify(theirs.body));
  assert.match(get('pages/shared.html'), /remote again/);
});

test('branches: a new one starts from here, switching swaps the live pages, uncommitted work is saved first', async () => {
  const b = await api('post', '/branch', { name: 'redesign', create: true });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(node.ctx.settings.get('assistant.git_branch'), 'redesign');
  await put('pages/redesign-only.html', page('New look'));
  const back = await api('post', '/branch', { name: 'main' }); // commits the page on redesign first
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.status, 'switched');
  assert.equal(get('pages/redesign-only.html'), null, 'main does not have that page');
  assert.equal(node.ctx.settings.get('assistant.git_branch'), 'main');
  const fwd = await api('post', '/branch', { name: 'redesign' });
  assert.equal(fwd.body.status, 'switched');
  assert.match(get('pages/redesign-only.html'), /New look/);

  const list = (await api('get', '/branches')).body;
  assert.equal(list.current, 'redesign');
  assert.ok(list.branches.some((x) => x.name === 'main'));

  assert.equal(
    (await api('post', '/branch', { name: 'redesign', create: true })).body.status,
    'already_there',
  );
  assert.equal((await api('post', '/branch', { name: 'nope' })).status, 404);
  assert.equal((await api('post', '/branch', { name: 'bad name!' })).status, 422);
  await api('post', '/branch', { name: 'main' });
  // later commits still land on the branch we are on, one commit each, nothing replayed twice
  await put('pages/after-switch.html', page('After'));
  await api('post', '/commit', { message: 'after switch' });
  const subjects = git(path.join(tmp, 'versions'), 'log', '--format=%s', '-3').split('\n');
  assert.equal(subjects[0], 'after switch');
  assert.notEqual(subjects[1], 'after switch');
});

test('a release can be restored, as one entry that is itself revertible', async () => {
  assert.match(get('pages/after-switch.html'), /After/);
  const r = await api('post', '/restore', { version: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(get('pages/after-switch.html'), null, 'later pages are gone');
  assert.match(get('pages/vtest.html'), /versioned/);
  assert.equal((await api('get', '/log')).body.commits[0].kind, 'restore');
  assert.equal((await api('post', '/restore', { version: 99 })).status, 404);
});

test('automatic commits happen on the schedule when switched on, never when off, and are labelled', async () => {
  await put('pages/auto.html', page('Auto'));
  await node.ctx.settings.update('publish', { values: { auto_commit: false } });
  assert.equal((await node.ctx.publish.autoCommit()).skipped, true);
  assert.ok(
    (await api('get', '/status')).body.pendingFiles.some((f) => f.path === 'pages/auto.html'),
  );

  await node.ctx.settings.update('publish', { values: { auto_commit: true } });
  assert.equal((await node.ctx.publish.autoCommit()).committed, true);
  const top = (await api('get', '/log')).body.commits[0];
  assert.equal(top.kind, 'auto');
  assert.equal(top.message, 'Automatic commit');
  assert.equal(
    (await node.ctx.publish.autoCommit()).committed,
    false,
    'nothing changed, so nothing is committed',
  );
});

test('without a remote, pull and push say what to set; permissions are separate', async () => {
  await node.ctx.settings.update('assistant', { values: { git_remote: '' } });
  for (const url of ['/pull', '/push']) {
    const r = await api('post', url, {});
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /Settings → Assistant/);
  }
  await node.ctx.settings.update('assistant', { values: { git_remote: remote } });

  const role = await node.ctx.users.createRole(
    { name: 'Pub viewer', permissions: ['admin.access', 'publish.read'] },
    null,
  );
  await node.ctx.users.createUser(
    { email: 'pv@example.com', name: 'PV', password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  const v = await signedIn(node.app, { email: 'pv@example.com', password: 'Some-long-pass-12' });
  assert.equal((await v.get('/api/admin/publish/status')).status, 200);
  for (const [url, body] of [
    ['/commit', {}],
    ['/publish', {}],
    ['/pull', {}],
    ['/branch', { name: 'x' }],
    ['/purge-cache', {}],
  ])
    assert.equal((await v.post(`/api/admin/publish${url}`).send(body)).status, 403, url);
});
