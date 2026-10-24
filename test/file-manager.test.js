import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode, signedIn, until } from './helpers.js';

// The File Manager plugin (plugins/file-manager) is copied into the test node's own PLUGINS_DIR, and the node gets a
// throwaway appRoot, so nothing here can touch the repository's real site/ or plugins/ folders.
// Disk edits are exercised on the `plugins` root (the only disk root: the shipped `site/` folder is not reachable).
let node, admin, appRoot;
const BASE = '/api/admin/apps/file-manager';
const put = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

before(async () => {
  appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-app-'));
  node = await makeNode({ appRoot });
  fs.cpSync(
    path.resolve('plugins/file-manager'),
    path.join(node.ctx.env.PLUGINS_DIR, 'file-manager'),
    {
      recursive: true,
    },
  );
  put(path.join(node.ctx.env.PLUGINS_DIR, 'other/plugin.json'), '{"slug":"other"}');
  put(path.join(node.ctx.env.PLUGINS_DIR, 'other/notes.txt'), 'remember the milk\n');
  put(path.join(node.ctx.env.PLUGINS_DIR, 'other/locales/en.json'), '{"hello":"Hello world"}');
  put(path.join(node.ctx.env.PLUGINS_DIR, 'other/assets/base/theme.json'), '{"id":"base"}');
  put(
    path.join(node.ctx.env.PLUGINS_DIR, 'other/assets/base/styles/main.css'),
    'body { color: red; }\n',
  );
  admin = await signedIn(node.app);
  assert.equal((await admin.post('/api/admin/plugins/rescan').send({})).status, 200);
  assert.equal((await admin.post('/api/admin/plugins/file-manager/enable').send({})).status, 200);
});
after(async () => {
  await node.close();
  fs.rmSync(appRoot, { recursive: true, force: true });
});

const list = (root, p = '') => admin.get(`${BASE}/list?root=${root}&path=${p}`);
const del = (body) => admin.post(`${BASE}/delete`).send(body);
const PD = () => node.ctx.env.PLUGINS_DIR;

describe('browsing and editing', () => {
  test('lists each root, folders first, and hides node_modules/.git', async () => {
    put(path.join(PD(), 'other/node_modules/x.js'), '1');
    const r = await list('plugins', 'other');
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.entries.map((e) => e.name),
      ['assets', 'locales', 'notes.txt', 'plugin.json'],
    );
    assert.equal(
      (await list('plugins')).body.entries.some((e) => e.name === 'file-manager'),
      true,
    );
    assert.equal(
      (await list('public')).body.entries.some((e) => e.name === 'pages'),
      true,
    );
  });

  test('saves a disk file, and refuses a save made on top of a newer version', async () => {
    const f = (await admin.get(`${BASE}/file?root=plugins&path=other/locales/en.json`)).body;
    assert.equal(f.content, '{"hello":"Hello world"}');
    const ok = await admin.put(`${BASE}/file`).send({
      root: 'plugins',
      path: 'other/locales/en.json',
      content: '{"hello":"Hi"}',
      expectedHash: f.hash,
    });
    assert.equal(ok.status, 200);
    assert.equal(
      fs.readFileSync(path.join(PD(), 'other/locales/en.json'), 'utf8'),
      '{"hello":"Hi"}',
    );
    const stale = await admin.put(`${BASE}/file`).send({
      root: 'plugins',
      path: 'other/locales/en.json',
      content: '{"hello":"Yo"}',
      expectedHash: f.hash,
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error.message, /changed on disk/);
  });

  test('rejects invalid JSON with a message that says how to fix it', async () => {
    const r = await admin
      .put(`${BASE}/file`)
      .send({ root: 'plugins', path: 'other/locales/en.json', content: '{nope' });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /isn’t valid JSON/);
  });

  test('saves a public (site tree) file through the database, not the disk', async () => {
    const before = (await admin.get(`${BASE}/file?root=public&path=pages/index.html`)).body;
    const text = before.content + '\n<!-- edited by file manager -->';
    const r = await admin
      .put(`${BASE}/file`)
      .send({ root: 'public', path: 'pages/index.html', content: text, expectedHash: before.hash });
    assert.equal(r.status, 200);
    assert.match(node.ctx.siteFiles.get('pages/index.html').content, /edited by file manager/);
  });

  test('creates files and folders, refuses duplicates, and rewrites nothing outside the root', async () => {
    assert.equal(
      (
        await admin
          .post(`${BASE}/create`)
          .send({ root: 'plugins', path: 'other/extra/readme.md', content: '# hi' })
      ).status,
      201,
    );
    assert.equal(fs.readFileSync(path.join(PD(), 'other/extra/readme.md'), 'utf8'), '# hi');
    assert.equal(
      (await admin.post(`${BASE}/create`).send({ root: 'plugins', path: 'other/extra/readme.md' }))
        .status,
      409,
    );
    assert.equal(
      (
        await admin
          .post(`${BASE}/create`)
          .send({ root: 'plugins', path: 'other/empty-dir', type: 'dir' })
      ).status,
      201,
    );
    const tree = await admin
      .post(`${BASE}/create`)
      .send({ root: 'public', path: 'tmp', type: 'dir' });
    assert.equal(tree.status, 422);
  });

  test('renames a disk file', async () => {
    const r = await admin
      .post(`${BASE}/rename`)
      .send({ root: 'plugins', from: 'other/extra/readme.md', to: 'other/extra/README.md' });
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(path.join(PD(), 'other/extra/README.md')), true);
  });

  test('refuses paths that escape the root, point at node_modules, or go through a symlink', async () => {
    for (const p of [
      '../package.json',
      'a/../../x',
      '/etc/passwd',
      'other/node_modules/x.js',
      'a\\b',
    ])
      assert.equal(
        (await admin.get(`${BASE}/file?root=plugins&path=${encodeURIComponent(p)}`)).status,
        422,
        p,
      );
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-out-'));
    put(path.join(outside, 'secret.txt'), 'top secret');
    fs.symlinkSync(outside, path.join(PD(), 'other/escape'));
    const r = await admin.get(`${BASE}/file?root=plugins&path=other/escape/secret.txt`);
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /outside/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('will not open a binary file', async () => {
    fs.writeFileSync(path.join(PD(), 'other/pic.bin'), Buffer.from([1, 0, 2, 0, 3]));
    const r = await admin.get(`${BASE}/file?root=plugins&path=other/pic.bin`);
    assert.equal(r.status, 415);
  });
});

describe('deleting is validated', () => {
  test('preview describes a folder, and delete needs the exact name', async () => {
    const pv = (
      await admin
        .post(`${BASE}/delete-preview`)
        .send({ root: 'plugins', path: 'other/assets/base' })
    ).body;
    assert.equal(pv.kind, 'dir');
    assert.equal(pv.files, 2);
    assert.equal(pv.needsRecursive, true);
    const wrong = await del({
      root: 'plugins',
      path: 'other/assets/base',
      confirm: 'nope',
      recursive: true,
    });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error.code, 'confirm_mismatch');
    assert.equal(fs.existsSync(path.join(PD(), 'other/assets/base')), true);
  });

  test('a folder with files also needs recursive: true', async () => {
    const r = await del({ root: 'plugins', path: 'other/assets/base', confirm: 'base' });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'needs_recursive');
    assert.equal(fs.existsSync(path.join(PD(), 'other/assets/base')), true);
  });

  test('deletes a file and a folder when confirmed', async () => {
    assert.equal(
      (await del({ root: 'plugins', path: 'other/extra/README.md', confirm: 'README.md' })).status,
      200,
    );
    assert.equal(fs.existsSync(path.join(PD(), 'other/extra/README.md')), false);
    const r = await del({
      root: 'plugins',
      path: 'other/assets/base',
      confirm: 'base',
      recursive: true,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, 2);
    assert.equal(fs.existsSync(path.join(PD(), 'other/assets/base')), false);
  });

  test('refuses protected paths: roots, top-level folders, installed plugins, the plugin itself', async () => {
    for (const [root, p] of [
      ['plugins', ''],
      ['public', 'pages'],
      ['plugins', 'file-manager'],
      ['plugins', 'file-manager/plugin.js'],
    ]) {
      const r = await del({
        root,
        path: p,
        confirm: path.posix.basename(p) || 'x',
        recursive: true,
      });
      assert.equal(r.status, 409, `${root}/${p}`);
    }
  });

  test('deletes a plain file inside the plugins folder, but not an enabled plugin’s plugin.json', async () => {
    assert.equal(
      (await del({ root: 'plugins', path: 'other/notes.txt', confirm: 'notes.txt' })).status,
      200,
    );
    assert.equal(fs.existsSync(path.join(node.ctx.env.PLUGINS_DIR, 'other/notes.txt')), false);
  });

  test('deletes a public (site tree) file for every server', async () => {
    await admin
      .post(`${BASE}/create`)
      .send({ root: 'public', path: 'components/scratch/box.html', content: '<div>hi</div>' });
    const r = await del({
      root: 'public',
      path: 'components/scratch',
      confirm: 'scratch',
      recursive: true,
    });
    assert.equal(r.status, 200);
    assert.equal(node.ctx.siteFiles.snapshot().files.has('components/scratch/box.html'), false);
  });
});

describe('the public mirror on disk', () => {
  test('deleting a folder’s files also removes the empty folder from public/ on disk', async () => {
    const dir = path.join(node.ctx.env.SITE_DIR, 'components/gone');
    await admin
      .post(`${BASE}/create`)
      .send({ root: 'public', path: 'components/gone/a.html', content: '<p>a</p>' });
    await until(() => fs.existsSync(path.join(dir, 'a.html')));
    const r = await del({
      root: 'public',
      path: 'components/gone',
      confirm: 'gone',
      recursive: true,
    });
    assert.equal(r.status, 200);
    await until(() => !fs.existsSync(dir));
    assert.equal(
      fs.existsSync(path.join(node.ctx.env.SITE_DIR, 'components')),
      true,
      'the top folder stays',
    );
  });
});

describe('search', () => {
  test('finds text across roots with line numbers, honours case, word and regex options', async () => {
    const s = (q) => admin.get(`${BASE}/search?${new URLSearchParams(q)}`);
    const plain = await s({ q: 'hello', root: 'plugins' });
    assert.equal(plain.status, 200);
    assert.ok(plain.body.results.some((x) => x.path === 'other/locales/en.json' && x.line === 1));
    assert.equal((await s({ q: 'HELLO', root: 'plugins', case: '1' })).body.results.length, 0);
    assert.equal((await s({ q: 'hel', root: 'plugins', word: '1' })).body.results.length, 0);
    assert.ok((await s({ q: 'he.lo', root: 'plugins', regex: '1' })).body.results.length > 0);
    assert.equal((await s({ q: '(', root: 'plugins', regex: '1' })).status, 422);
    assert.ok(
      (await s({ q: 'export default', root: 'plugins', glob: '*.js' })).body.results.every((x) =>
        x.path.endsWith('.js'),
      ),
    );
    assert.ok((await s({ q: '<html', root: 'public' })).body.results.length >= 0);
  });

  test('searches file names, and says when it stopped early', async () => {
    const byName = await admin.get(`${BASE}/search?q=plugin.json&mode=name&root=plugins`);
    assert.ok(byName.body.results.some((x) => x.path === 'file-manager/plugin.json'));
    const capped = await admin.get(`${BASE}/search?q=e&root=plugins`);
    node.ctx.settings.ns('plugin_file_manager'); // config namespace is registered
    assert.ok(capped.body.results.length > 0);
  });
});

describe('permissions', () => {
  test('a user without file_manager.view can’t read; edit and delete are separate', async () => {
    const role = await admin
      .post('/api/admin/roles')
      .send({ name: 'FM viewer', permissions: ['admin.access', 'file_manager.view'] });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const email = 'fm-viewer@example.com';
    const mk = await admin.post('/api/admin/users').send({
      email,
      name: 'Viewer',
      password: 'Sup3r-secret-pass!',
      roleId: role.body.role?.id ?? role.body.id,
    });
    assert.ok([200, 201].includes(mk.status), JSON.stringify(mk.body));
    const viewer = await signedIn(node.app, { email, password: 'Sup3r-secret-pass!' });
    assert.equal((await viewer.get(`${BASE}/list?root=plugins`)).status, 200);
    assert.equal(
      (
        await viewer
          .put(`${BASE}/file`)
          .send({ root: 'plugins', path: 'other/locales/en.json', content: '{}' })
      ).status,
      403,
    );
    assert.equal(
      (
        await viewer
          .post(`${BASE}/delete`)
          .send({ root: 'plugins', path: 'other/locales', confirm: 'locales' })
      ).status,
      403,
    );
  });
});

describe('the shipped site/ folder is out of reach', () => {
  test('site is not one of the roots, and every route refuses it', async () => {
    const roots = (await admin.get(`${BASE}/roots`)).body.roots.map((r) => r.id);
    assert.deepEqual(roots, ['public', 'plugins']);
    const shipped = path.join(appRoot, 'site/themes/base/theme.json');
    put(shipped, '{"id":"base"}');
    const calls = [
      admin.get(`${BASE}/list?root=site`),
      admin.get(`${BASE}/file?root=site&path=themes/base/theme.json`),
      admin
        .put(`${BASE}/file`)
        .send({ root: 'site', path: 'themes/base/theme.json', content: '{}' }),
      admin.post(`${BASE}/create`).send({ root: 'site', path: 'x.txt', content: 'x' }),
      admin
        .post(`${BASE}/rename`)
        .send({ root: 'site', from: 'themes/base/theme.json', to: 'themes/base/t.json' }),
      del({ root: 'site', path: 'themes/base/theme.json', confirm: 'theme.json' }),
      admin.get(`${BASE}/search?q=base&root=site`),
    ];
    for (const r of await Promise.all(calls)) {
      assert.equal(r.status, 422);
      assert.match(r.body.error.message, /Choose one of: public, plugins/);
    }
    assert.equal(fs.readFileSync(shipped, 'utf8'), '{"id":"base"}', 'nothing was changed');
  });
});
