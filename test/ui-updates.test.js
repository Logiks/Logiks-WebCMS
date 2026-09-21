import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

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
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  ).trim();

test('Updates screen: check, see what is coming, update without restarting, then restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-uiupd-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const server = path.join(root, 'server');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, work);
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"f","type":"module"}');
  fs.mkdirSync(path.join(work, 'src/cli'), { recursive: true });
  fs.writeFileSync(
    path.join(work, 'src/cli/index.js'),
    '// migrations are stubbed in this fixture\n',
  );
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'First');
  git(work, 'push', 'origin', 'HEAD:main');
  git(root, 'clone', origin, server);

  const node = await startNode({ seed: true, appRoot: server });
  let restarts = 0;
  node.ctx.state.requestRestart = () => restarts++;
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const row = () => b.$$('section[x-data="updatesPage"] .upd')[0];
    const rowText = () => row()?.textContent.replace(/\s+/g, ' ') ?? '';
    const wait = (fn) => until(fn, { timeout: 15000, every: 100 });

    b.click(b.button('Operations'));
    await wait(() => b.$$('.nav-sub-link').find((a) => a.textContent.trim() === 'Updates'));
    b.click(b.$$('.nav-sub-link').find((a) => a.textContent.trim() === 'Updates'));
    await wait(() => /Not checked yet/.test(rowText()));
    assert.ok(rowText().includes(os.hostname()));
    assert.match(rowText(), /this server/);
    assert.equal(b.$('.nav-sub-link.active').textContent.trim(), 'Updates');

    fs.writeFileSync(path.join(work, 'src/new.js'), '// new\n');
    fs.mkdirSync(path.join(work, 'migrations'));
    fs.writeFileSync(path.join(work, 'migrations/002.js'), '// m\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'Add the reports page');
    git(work, 'push', 'origin', 'HEAD:main');

    b.click(b.button('Check for updates'));
    await wait(() => /1 update available/.test(rowText()));
    assert.match(rowText(), /Add the reports page/);
    assert.match(rowText(), /Includes database migrations\./);
    assert.match(rowText(), /Last checked/);

    // Update only: the code changes, the running process does not, and the row says a restart is needed.
    b.click(b.$('#restart-after'));
    assert.equal(b.$('#restart-after').checked, false);
    b.click(b.button('Update'));
    await wait(() => /Restart needed/.test(rowText()));
    assert.match(rowText(), /Restart this server to run it/);
    assert.equal(restarts, 0);
    assert.equal(
      git(server, 'rev-parse', 'HEAD'),
      git(work, 'rev-parse', 'HEAD'),
      'the checkout moved to the new commit',
    );

    b.click(b.button('Restart'));
    await wait(() => /Restarting…/.test(rowText()));
    await until(() => restarts === 1);
    await wait(() => b.$$('section[x-data="updatesPage"] table tbody tr').length >= 2);
    const history = b.$$('section[x-data="updatesPage"] table tbody tr').map((r) => r.textContent);
    assert.ok(
      history.some((t) => /updated [0-9a-f]{7,12} → [0-9a-f]{7,12}/.test(t)),
      history.join('|'),
    );
    assert.ok(history.some((t) => /Restarted/.test(t)));
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
