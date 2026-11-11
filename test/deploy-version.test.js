import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, signedIn, ADMIN } from './helpers.js';
import { bumpVersion, compareVersions, currentVersion } from '../src/modules/deploy/release.js';
import { sameWithoutVersion } from '../src/modules/updates/service.js';

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
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: 'pipe' },
  ).trim();
const actor = { id: 1, email: ADMIN.email };

test('major, minor and fix bump the right part and reset what follows', () => {
  assert.equal(bumpVersion('1.2.3', 'fix'), '1.2.4');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('not-a-version', 'fix'), '0.0.1');
  assert.throws(() => bumpVersion('1.0.0', 'huge'), /major, minor or issue fix/);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1, 'numbers, not text');
  // A version bumped by hand in package.json is never taken back by an older deployed one.
  assert.equal(currentVersion('0.2.1', '0.1.0'), '0.2.1');
  assert.equal(currentVersion('0.2.1', '1.0.0'), '1.0.0');
  assert.equal(currentVersion(null, '0.1.0'), '0.1.0');
});

test('a package file that differs only in its version does not call for npm ci', () => {
  const a = JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { a: '1' } });
  assert.ok(sameWithoutVersion(a, a.replace('1.0.0', '1.0.1')));
  assert.ok(!sameWithoutVersion(a, a.replace('"a":"1"', '"a":"2"')));
  const lock = (v, dep) =>
    JSON.stringify({
      version: v,
      packages: { '': { version: v }, 'node_modules/a': { version: dep } },
    });
  assert.ok(sameWithoutVersion(lock('1.0.0', '1'), lock('1.0.1', '1')));
  assert.ok(!sameWithoutVersion(lock('1.0.0', '1'), lock('1.0.1', '2')), 'a dependency changed');
  assert.ok(!sameWithoutVersion('not json', a));
});

test('each deploy asks for its kind, bumps the version in the deployed package.json, and keeps it when nothing changed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-ver-'));
  const app = path.join(root, 'app');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(
    path.join(app, 'package.json'),
    '{\n  "name": "project",\n  "version": "0.1.0"\n}\n',
  );
  fs.writeFileSync(
    path.join(app, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'project',
        version: '0.1.0',
        packages: { '': { name: 'project', version: '0.1.0' } },
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(path.join(app, 'a.txt'), 'one');
  git(root, 'init', '--bare', origin);
  const deployed = () => {
    const d = fs.mkdtempSync(path.join(root, 'check-'));
    git(root, 'clone', origin, d);
    return d;
  };
  const dev = await startNode({ seed: true, appRoot: app });
  try {
    await dev.ctx.settings.update('deploy', { values: { repo_url: origin, branch: 'main' } });
    const deploy = async (body) => {
      const run = await dev.ctx.deploy.start({ data: false, media: false, ...body }, actor);
      await dev.ctx.deploy.idle();
      const row = (await dev.ctx.deploy.overview()).runs.find((r) => r.id === run.id);
      assert.equal(row.status, 'done', row.message);
      return row;
    };
    const pkgOf = (d) => JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));

    const before = (await dev.ctx.deploy.overview()).version;
    assert.equal(before.current, '0.1.0');
    assert.deepEqual(before.next, { major: '1.0.0', minor: '0.2.0', fix: '0.1.1' });

    const first = await deploy({ bump: 'minor', title: 'Launch' });
    assert.match(first.message, /Deployed v0\.2\.0/);
    const one = deployed();
    assert.equal(pkgOf(one).version, '0.2.0');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(one, 'package-lock.json'), 'utf8')).packages[''].version,
      '0.2.0',
    );
    const r1 = JSON.parse(
      fs.readFileSync(path.join(one, 'deploy-notes/releases/0001.json'), 'utf8'),
    );
    assert.equal(r1.appVersion, '0.2.0');
    assert.equal(r1.bump, 'minor');
    assert.match(
      fs.readFileSync(path.join(one, 'deploy-notes/CHANGELOG.md'), 'utf8'),
      /v0\.2\.0 · 1\. Launch/,
    );
    assert.equal(pkgOf(app).version, '0.1.0', "this installation's own package.json is left alone");

    // Nothing changed: no new version, no new release.
    const same = await deploy({ bump: 'major' });
    assert.match(same.message, /Nothing changed/);
    assert.equal(pkgOf(deployed()).version, '0.2.0');
    assert.equal((await dev.ctx.deployReleases.list()).length, 1);

    // Unclassified (a scheduled deploy) is an issue fix, built on the DEPLOYED version, not on the older local file.
    fs.writeFileSync(path.join(app, 'a.txt'), 'two');
    await deploy({});
    assert.equal(pkgOf(deployed()).version, '0.2.1');

    fs.writeFileSync(path.join(app, 'a.txt'), 'three');
    await deploy({ bump: 'major' });
    assert.equal(pkgOf(deployed()).version, '1.0.0');
    assert.equal((await dev.ctx.deploy.overview()).version.current, '1.0.0');

    // The Updates screen's changelog lists every version, newest first, with its notes.
    const admin = await signedIn(dev.app);
    const log = (await admin.get('/api/admin/updates/changelog')).body;
    assert.deepEqual(
      log.releases.map((r) => [r.version, r.bump]),
      [
        ['1.0.0', 'major'],
        ['0.2.1', 'fix'],
        ['0.2.0', 'minor'],
      ],
    );
    assert.equal(log.releases[2].title, 'Launch');

    // The run body only accepts the three kinds.
    const bad = await admin.post('/api/admin/deploy/run').send({ bump: 'huge' });
    assert.equal(bad.status, 422);
  } finally {
    await dev.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
