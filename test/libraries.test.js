import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { makeNode, startNode, signedIn, tmpDb } from './helpers.js';
import { startRegistry, tgz } from './fake-registry.js';
import { readTarball } from '../src/modules/libraries/tarball.js';

let node, admin, reg, db;
const get = (p) => request(node.app).get(p);
const one = (name) => `/api/admin/libraries/one?name=${encodeURIComponent(name)}`;
const install = (name, version = 'latest', extra = {}) =>
  admin.post('/api/admin/libraries').send({ name, version, ...extra });

const ICONS = (css = '.i{background:url(../fonts/x.woff2)}') => ({
  'package.json': { description: 'Demo icons', license: 'MIT', style: 'css/icons.css' },
  'css/icons.css': css,
  'fonts/x.woff2': 'wOF2-font-bytes',
  'js/icons.js': 'window.icons = 1;',
  'index.html': '<script>alert(1)</script>',
  'README.md': '# icons',
});

before(async () => {
  reg = await startRegistry();
  reg.add('demo-icons', '1.0.0', ICONS());
  reg.add('@scope/widget', '1.2.3', { 'package.json': {}, 'widget.css': '.w{}' });
  reg.add('tampered', '1.0.0', { 'package.json': {}, 'a.css': 'a{}' }, { tamper: true });
  reg.add(
    'evil-pkg',
    '1.0.0',
    { 'package.json': {} },
    { raw: [['package/../../evil.css', 'x', '0']] },
  );
  db = tmpDb();
  node = await makeNode({ dbUrl: db.url });
  admin = await signedIn(node.app);
  await node.ctx.settings.update('libraries', { values: { registry_url: reg.url } }, null);
});
after(async () => {
  await node.close();
  await reg.close();
  db.cleanup();
});

describe('the tarball reader', () => {
  test('strips the top folder, skips links and directories, refuses traversal and bombs', () => {
    const files = readTarball(
      tgz(
        { 'a.css': 'a{}', 'sub/b.js': 'x' },
        {
          raw: [
            ['package/link', '', '2'],
            ['package/dir/', '', '5'],
          ],
        },
      ),
      { maxBytes: 1e6, maxFiles: 10 },
    );
    assert.deepEqual([...files.keys()].sort(), ['a.css', 'sub/b.js']);
    assert.throws(
      () =>
        readTarball(tgz({}, { raw: [['package/../../x', 'x', '0']] }), {
          maxBytes: 1e6,
          maxFiles: 10,
        }),
      /Unsafe/,
    );
    assert.throws(
      () => readTarball(tgz({ 'big.css': 'x'.repeat(5000) }), { maxBytes: 1000, maxFiles: 10 }),
      /larger than/,
    );
    assert.throws(
      () => readTarball(tgz({ a: '1', b: '2', c: '3' }), { maxBytes: 1e6, maxFiles: 2 }),
      /more than 2 files/,
    );
    assert.throws(
      () => readTarball(Buffer.from('not gzip'), { maxBytes: 1e6, maxFiles: 2 }),
      /valid \.tgz/,
    );
  });
});

describe('System → Libraries', () => {
  test('search the registry, install a package, and see its stylesheet suggested', async () => {
    const s = await admin.get('/api/admin/libraries/search?q=icons');
    assert.equal(s.status, 200);
    assert.equal(s.body.results[0].name, 'demo-icons');

    const r = await install('demo-icons');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const lib = r.body.library;
    assert.equal(lib.version, '1.0.0');
    assert.equal(lib.license, 'MIT');
    assert.deepEqual(lib.include, ['css/icons.css'], 'the package.json "style" file is suggested');
    assert.equal(lib.autoload, false);
    assert.match(lib.integrity, /^sha512-/);
    assert.ok(await node.ctx.db('audit_logs').where({ action: 'library.install' }).first());
  });

  test('files are served at /lib/<name>@<version>/…, immutable; nothing else is', async () => {
    const css = await get('/lib/demo-icons@1.0.0/css/icons.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    assert.match(css.headers['cache-control'], /immutable/);
    assert.equal(css.headers['x-content-type-options'], 'nosniff');
    assert.equal(css.text, '.i{background:url(../fonts/x.woff2)}');
    const font = await get('/lib/demo-icons@1.0.0/fonts/x.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers['content-type'], 'font/woff2');

    assert.equal((await get('/lib/demo-icons@9.9.9/css/icons.css')).status, 404, 'other version');
    assert.equal((await get('/lib/demo-icons@1.0.0/index.html')).status, 404, 'no html pages');
    assert.equal((await get('/lib/demo-icons@1.0.0/js/icons.js')).status, 404, 'scripts are off');
    assert.equal((await get('/lib/demo-icons@1.0.0/nope.css')).status, 404);
    assert.equal((await get('/lib/demo-icons@1.0.0/.complete')).status, 404);
    assert.equal((await get('/lib/demo-icons@1.0.0/../../../etc/passwd')).status, 404);
  });

  test('a library set to load on every page is in <head> before the theme; library_url reaches any file', async () => {
    assert.equal((await admin.put(one('demo-icons')).send({ autoload: true })).status, 200);
    const html = (await get('/')).text;
    const lib = html.indexOf('<link rel="stylesheet" href="/lib/demo-icons@1.0.0/css/icons.css">');
    const theme = html.indexOf('<link rel="stylesheet" href="/theme/');
    assert.ok(lib > 0 && theme > lib, 'library first, so the theme can override it');

    await node.ctx.siteFiles.put(
      'pages/lib-demo.html',
      `<p id="u">{{ 'demo-icons/fonts/x.woff2' | library_url }}</p><p id="none">[{{ 'not-installed/x.css' | library_url }}]</p>`,
      null,
    );
    const page = (await get('/lib-demo')).text;
    assert.match(page, /<p id="u">\/lib\/demo-icons@1\.0\.0\/fonts\/x\.woff2<\/p>/);
    assert.match(page, /<p id="none">\[\]<\/p>/);
  });

  test('scripts are refused until Settings → Libraries allows them', async () => {
    const r = await admin
      .put(one('demo-icons'))
      .send({ include: ['css/icons.css', 'js/icons.js'] });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /Settings → Libraries/);
    assert.equal((await admin.put(one('demo-icons')).send({ include: ['nope.css'] })).status, 422);
    assert.equal((await admin.put(one('demo-icons')).send({ include: ['README.md'] })).status, 422);

    await node.ctx.settings.update('libraries', { values: { allow_scripts: true } }, null);
    assert.equal(
      (await admin.put(one('demo-icons')).send({ include: ['css/icons.css', 'js/icons.js'] }))
        .status,
      200,
    );
    assert.match(
      (await get('/')).text,
      /<script src="\/lib\/demo-icons@1\.0\.0\/js\/icons\.js" defer><\/script>/,
    );
    assert.equal((await get('/lib/demo-icons@1.0.0/js/icons.js')).status, 200);
    await node.ctx.settings.update('libraries', { values: { allow_scripts: false } }, null);
    assert.doesNotMatch(
      (await get('/')).text,
      /icons\.js/,
      'turning scripts off removes them at once',
    );
  });

  test('scoped packages work', async () => {
    const r = await install('@scope/widget', '1.2.3');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const w = await get('/lib/@scope/widget@1.2.3/widget.css');
    assert.equal(w.status, 200);
    assert.equal(w.text, '.w{}');
  });

  test('a download that does not match its published hash, or an unsafe package, installs nothing', async () => {
    const t = await install('tampered');
    assert.equal(t.status, 502);
    assert.match(t.body.error.message, /doesn't match its published hash/);
    const e = await install('evil-pkg');
    assert.equal(e.status, 422);
    assert.match(e.body.error.message, /Unsafe/);
    assert.equal((await install('no-such-package')).status, 404);
    assert.equal((await install('demo-icons', '7.7.7')).status, 404);
    assert.equal((await install('Not A Name')).status, 422);
    const names = (await admin.get('/api/admin/libraries')).body.libraries.map((l) => l.name);
    assert.deepEqual(names.sort(), ['@scope/widget', 'demo-icons']);
  });

  test('updating to another version keeps what was chosen; the old URLs stop', async () => {
    reg.add('demo-icons', '2.0.0', ICONS('.i{color:blue}'));
    const r = await install('demo-icons', 'latest');
    assert.equal(r.status, 201);
    assert.equal(r.body.library.version, '2.0.0');
    assert.equal(r.body.library.autoload, true);
    // Scripts are off again by now, so the script choice isn't carried over; the stylesheet is.
    assert.deepEqual(r.body.library.include, ['css/icons.css']);
    assert.equal((await get('/lib/demo-icons@2.0.0/css/icons.css')).text, '.i{color:blue}');
    assert.equal((await get('/lib/demo-icons@1.0.0/css/icons.css')).status, 404);
    assert.match((await get('/')).text, /demo-icons@2\.0\.0\/css\/icons\.css/);
  });

  test('another server unpacks its own copy from the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-lib-b-'));
    const b = await startNode({ dbUrl: db.url, env: { LIBRARY_DIR: dir } });
    try {
      const r = await request(b.app).get('/lib/demo-icons@2.0.0/css/icons.css');
      assert.equal(r.status, 200);
      assert.equal(r.text, '.i{color:blue}');
      assert.ok(fs.readdirSync(dir).some((d) => d.startsWith('demo-icons@2.0.0-')));
    } finally {
      await b.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('export the list; import it on another installation; a changed hash is refused', async () => {
    const ex = await admin.get('/api/admin/libraries/export');
    assert.equal(ex.status, 200);
    assert.match(ex.headers['content-disposition'], /libraries\.json/);
    assert.equal(ex.body.format, 'cms-libraries');
    const icons = ex.body.libraries.find((l) => l.name === 'demo-icons');
    assert.equal(icons.version, '2.0.0');
    assert.deepEqual(icons.include, ['css/icons.css']);
    icons.include.push('js/icons.js'); // as if exported from an installation that allows scripts

    const other = await makeNode();
    try {
      const oa = await signedIn(other.app);
      await other.ctx.settings.update('libraries', { values: { registry_url: reg.url } }, null);
      const imp = await oa.post('/api/admin/libraries/import').send(ex.body);
      assert.equal(imp.status, 200, JSON.stringify(imp.body));
      assert.equal(imp.body.failed.length, 0, JSON.stringify(imp.body.failed));
      assert.equal(imp.body.installed.length, 2);
      assert.match(
        imp.body.installed.find((x) => x.name === 'demo-icons').note,
        /Scripts were skipped/,
      );
      const got = (await oa.get('/api/admin/libraries')).body.libraries.find(
        (l) => l.name === 'demo-icons',
      );
      assert.equal(got.integrity, icons.integrity);
      assert.equal(got.autoload, true);
      assert.deepEqual(got.include, ['css/icons.css'], 'scripts are off on this installation');

      const forged = { ...ex.body, libraries: [{ ...icons, integrity: 'sha512-AAAA' }] };
      const bad = await oa.post('/api/admin/libraries/import').send(forged);
      assert.equal(bad.body.installed.length, 0);
      assert.match(bad.body.failed[0].error, /hash differs/);
      assert.equal((await oa.post('/api/admin/libraries/import').send({ nope: 1 })).status, 422);
    } finally {
      await other.close();
    }
  });

  test('an unreachable registry is reported with how to fix it', async () => {
    await node.ctx.settings.update(
      'libraries',
      { values: { registry_url: 'http://127.0.0.1:9' } },
      null,
    );
    const r = await install('anything');
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /Settings → Libraries/);
    await node.ctx.settings.update('libraries', { values: { registry_url: reg.url } }, null);
  });

  test('permissions: libraries.read may look, only libraries.manage may change', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'lib-reader', description: '', permissions: ['admin.access', 'libraries.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'lib@example.com',
        name: 'lib',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const reader = await signedIn(node.app, {
      email: 'lib@example.com',
      password: 'Some-long-pass-12',
    });
    assert.equal((await reader.get('/api/admin/libraries')).status, 200);
    assert.equal(
      (await reader.post('/api/admin/libraries').send({ name: 'demo-icons' })).status,
      403,
    );
    assert.equal((await reader.delete(one('demo-icons'))).status, 403);
    assert.equal((await reader.get('/api/admin/libraries/search?q=x')).status, 403);
  });

  test('remove a library: its files and tags are gone', async () => {
    assert.equal((await admin.delete(one('demo-icons'))).status, 204);
    assert.equal((await get('/lib/demo-icons@2.0.0/css/icons.css')).status, 404);
    assert.doesNotMatch((await get('/')).text, /demo-icons/);
  });
});
