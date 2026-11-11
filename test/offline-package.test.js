import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { startNode, signedIn, ADMIN } from './helpers.js';
import { applyPackage, PackageError } from '../src/modules/deploy/package.js';

const actor = { id: 1, email: ADMIN.email };

/** A tiny application folder. Its CLI is a stub: it records what the real one would be asked to do. */
function makeApp(root, name, version) {
  fs.mkdirSync(path.join(root, 'src/cli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'migrations'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'offline-fixture', version, type: 'module' }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(root, 'src/cli/index.js'),
    `import fs from 'node:fs';
const [cmd, ...rest] = process.argv.slice(2);
fs.mkdirSync('data', { recursive: true });
fs.appendFileSync('data/cli.log', [cmd, ...rest].join(' ') + '\\n');
if (cmd === 'package:import') console.log('Imported: nothing new.');
`,
  );
  fs.writeFileSync(path.join(root, 'a.txt'), `${name} a v1`);
  fs.writeFileSync(path.join(root, 'b.txt'), `${name} b`);
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=keep-me');
  fs.writeFileSync(path.join(root, '.env.example'), 'APP_MASTER_KEY=');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/local.db'), 'database');
}

test('an offline package is built, checked, applied, and replaces only code; the server keeps .env, data and what it removed stays removed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-offline-'));
  const devDir = path.join(root, 'dev');
  const prodDir = path.join(root, 'prod');
  makeApp(devDir, 'dev', '0.1.0');
  makeApp(prodDir, 'prod', '0.1.0');
  fs.writeFileSync(path.join(prodDir, 'b.txt'), 'prod b');
  const dev = await startNode({ seed: true, appRoot: devDir });
  try {
    const build = async (body) => {
      const run = await dev.ctx.deploy.start(
        { package: true, data: false, media: false, ...body },
        actor,
      );
      await dev.ctx.deploy.idle();
      return (await dev.ctx.deploy.overview()).runs.find((r) => r.id === run.id);
    };

    const first = await build({ bump: 'minor', title: 'Launch' });
    assert.equal(first.status, 'done', first.message);
    assert.match(first.message, /Built cms-0\.2\.0\.zip/);
    const zip1 = path.join(devDir, 'data/packages/cms-0.2.0.zip');
    const z = new AdmZip(zip1);
    const names = z.getEntries().map((e) => e.entryName);
    const manifest = JSON.parse(z.readAsText('package-manifest.json'));
    assert.equal(manifest.version, '0.2.0');
    assert.ok(manifest.files['a.txt'] && manifest.files['deploy-notes/releases/0001.json']);
    assert.ok(
      !names.some((n) => n === '.env' || n.startsWith('data/') || n.startsWith('node_modules/')),
    );
    assert.equal(JSON.parse(z.readAsText('package.json')).version, '0.2.0');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(devDir, 'package.json'), 'utf8')).version,
      '0.1.0',
      "the building installation's own package.json is left alone",
    );
    assert.equal((await dev.ctx.deployReleases.list())[0].version, '0.2.0');
    assert.equal((await dev.ctx.deploy.overview()).packages[0].name, 'cms-0.2.0.zip');

    const same = await build({ bump: 'major' });
    assert.match(same.message, /Nothing changed since the last package \(v0\.2\.0\)/);

    // First install over an older server: code replaced, .env and data untouched, a snapshot kept, the new code asked to
    // migrate and to import.
    const lines = [];
    const r1 = await applyPackage({
      root: prodDir,
      zip: zip1,
      currentVersion: '0.1.0',
      log: (l) => lines.push(l),
    });
    assert.equal(r1.version, '0.2.0');
    assert.equal(fs.readFileSync(path.join(prodDir, 'a.txt'), 'utf8'), 'dev a v1');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(prodDir, 'package.json'), 'utf8')).version,
      '0.2.0',
    );
    assert.equal(fs.readFileSync(path.join(prodDir, '.env'), 'utf8'), 'SECRET=keep-me');
    assert.equal(fs.readFileSync(path.join(prodDir, 'data/local.db'), 'utf8'), 'database');
    const cli = fs.readFileSync(path.join(prodDir, 'data/cli.log'), 'utf8');
    assert.match(cli, /^migrate$/m);
    assert.match(cli, /^package:import .*package-staging.* --label package-0\.2\.0$/m);
    const snap = new AdmZip(r1.snapshot);
    assert.equal(snap.readAsText('b.txt'), 'prod b', 'what it replaced is saved first');
    assert.ok(
      fs.readdirSync(path.join(prodDir, 'data/package-staging')).length === 0,
      'the staging folder is cleaned up',
    );

    // Dev deletes a file and changes another; the next package removes the first on the server, and only files a package put there.
    fs.rmSync(path.join(devDir, 'b.txt'));
    fs.writeFileSync(path.join(devDir, 'a.txt'), 'dev a v2');
    fs.writeFileSync(path.join(prodDir, 'own.txt'), 'made on the server');
    const second = await build({});
    assert.match(second.message, /Built cms-0\.2\.1\.zip/);
    const r2 = await applyPackage({
      root: prodDir,
      zip: path.join(devDir, 'data/packages/cms-0.2.1.zip'),
      currentVersion: '0.2.0',
    });
    assert.equal(r2.removed, 1);
    assert.equal(fs.readFileSync(path.join(prodDir, 'a.txt'), 'utf8'), 'dev a v2');
    assert.ok(!fs.existsSync(path.join(prodDir, 'b.txt')));
    assert.equal(fs.readFileSync(path.join(prodDir, 'own.txt'), 'utf8'), 'made on the server');

    // An older package is refused unless asked for; the same package can be applied with --force.
    await assert.rejects(
      applyPackage({ root: prodDir, zip: zip1, currentVersion: '0.2.1' }),
      /older than the v0\.2\.1/,
    );
    await applyPackage({ root: prodDir, zip: zip1, currentVersion: '0.2.1', force: true });
    assert.equal(fs.readFileSync(path.join(prodDir, 'a.txt'), 'utf8'), 'dev a v1');

    // A damaged copy is refused before anything changes.
    const bad = new AdmZip(path.join(devDir, 'data/packages/cms-0.2.1.zip'));
    bad.updateFile('a.txt', Buffer.from('tampered'));
    const badFile = path.join(root, 'bad.zip');
    bad.writeZip(badFile);
    fs.writeFileSync(path.join(prodDir, 'a.txt'), 'untouched');
    await assert.rejects(
      applyPackage({ root: prodDir, zip: badFile, currentVersion: '0.2.0' }),
      (e) => e instanceof PackageError && /a\.txt does not match the manifest/.test(e.message),
    );
    assert.equal(fs.readFileSync(path.join(prodDir, 'a.txt'), 'utf8'), 'untouched');

    // A zip that is not a package, and a package for another application.
    const plain = new AdmZip();
    plain.addFile('x.txt', Buffer.from('x'));
    plain.writeZip(path.join(root, 'plain.zip'));
    await assert.rejects(
      applyPackage({ root: prodDir, zip: path.join(root, 'plain.zip'), currentVersion: '0.2.0' }),
      /not an offline package/,
    );
    fs.writeFileSync(
      path.join(prodDir, 'package.json'),
      '{"name":"someone-else","version":"0.2.0"}',
    );
    await assert.rejects(
      applyPackage({ root: prodDir, zip: zip1, currentVersion: '0.2.0', force: true }),
      /is for "offline-fixture", but this folder is "someone-else"/,
    );
  } finally {
    await dev.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packages are listed and downloaded with deploy.run; names are checked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-offline-http-'));
  makeApp(root, 'dev', '1.0.0');
  const dev = await startNode({ seed: true, appRoot: root });
  try {
    const run = await dev.ctx.deploy.start(
      { package: true, data: false, media: false, bump: 'fix' },
      actor,
    );
    await dev.ctx.deploy.idle();
    assert.ok(run.id);
    const admin = await signedIn(dev.app);
    const list = (await admin.get('/api/admin/deploy/packages')).body.packages;
    assert.deepEqual(
      list.map((p) => p.name),
      ['cms-1.0.1.zip'],
    );
    const dl = await admin
      .get('/api/admin/deploy/packages/cms-1.0.1.zip')
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(dl.status, 200);
    assert.equal(new AdmZip(dl.body).getEntry('package-manifest.json') !== null, true);
    assert.equal((await admin.get('/api/admin/deploy/packages/..%2Fpackage.json')).status, 404);
    assert.equal((await admin.get('/api/admin/deploy/packages/cms-9.9.9.zip')).status, 404);
    assert.equal((await admin.delete('/api/admin/deploy/packages/cms-1.0.1.zip')).status, 200);
    assert.equal((await admin.get('/api/admin/deploy/packages')).body.packages.length, 0);
    assert.equal((await admin.post('/api/admin/deploy/run').send({ package: 'yes' })).status, 422);
  } finally {
    await dev.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
