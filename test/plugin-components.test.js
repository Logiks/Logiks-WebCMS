import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';

// A plugin's front-end component lives in the plugin's own folder and is rendered as {% render "plugin/<slug>/<name>" %};
// it is never copied into the site tree (public).
let node, admin, dir;
before(async () => {
  node = await makeNode();
  dir = path.join(node.ctx.env.PLUGINS_DIR, 'cardy');
  fs.mkdirSync(path.join(dir, 'components/deep'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      slug: 'cardy',
      name: 'Cardy',
      version: '1.0.0',
      author: 't',
      description: 'd',
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'components/card.html'),
    '<style>.c{color:red}</style><div class="c">PLUGIN CARD ONE</div>',
  );
  fs.writeFileSync(path.join(dir, 'components/deep/inner.html'), '<p>PLUGIN INNER</p>');
  admin = await signedIn(node.app);
  await admin.post('/api/admin/plugins/rescan').send({});
});
after(() => node.close());

const home = () => request(node.app).get('/');
const tree = () => [...node.ctx.siteFiles.snapshot().files.keys()];
const enable = (on) => admin.post(`/api/admin/plugins/cardy/${on ? 'enable' : 'disable'}`).send({});

test('renders a plugin component from the plugin folder, and writes nothing to the site tree', async () => {
  await node.ctx.siteFiles.put(
    'pages/index.html',
    '---\ntitle: Home\n---\n<main>{% render "plugin/cardy/card" %}|{% render "plugin/cardy/deep/inner" %}</main>',
    null,
  );
  const before = tree();
  assert.equal((await enable(true)).status, 200);
  const res = await home();
  assert.equal(res.status, 200);
  assert.match(res.text, /PLUGIN CARD ONE/);
  assert.match(res.text, /PLUGIN INNER/);
  assert.deepEqual(tree().sort(), before.sort(), 'enabling copied nothing into the tree');
  assert.ok(!tree().some((p) => p.includes('cardy')));
});

test('disabling takes effect at once, even for a page that was cached', async () => {
  await home(); // warm the cache
  await enable(false);
  assert.doesNotMatch((await home()).text, /PLUGIN CARD ONE/);
  await enable(true);
  assert.match((await home()).text, /PLUGIN CARD ONE/);
});

test('a changed component shows after the plugin is disabled and enabled again', async () => {
  fs.writeFileSync(path.join(dir, 'components/card.html'), '<div>PLUGIN CARD TWO</div>');
  await enable(false);
  await enable(true);
  const res = await home();
  assert.match(res.text, /PLUGIN CARD TWO/);
  assert.doesNotMatch(res.text, /PLUGIN CARD ONE/);
});

test('the names "plugin" and "plugin/…" are reserved in the site tree', async () => {
  await assert.rejects(
    () => node.ctx.siteFiles.put('components/plugin/x.html', '<p>x</p>', null),
    /reserved/,
  );
});

test('the bundled plugins ship their components in their own folders', async () => {
  assert.ok(fs.existsSync(path.resolve('plugins/weather-demo/components/current.html')));
  assert.ok(fs.existsSync(path.resolve('plugins/ip-viewer/components/ip-detector.html')));
  for (const f of ['weather-demo', 'ip-viewer']) {
    const src = fs.readFileSync(path.resolve(`plugins/${f}/plugin.js`), 'utf8');
    assert.doesNotMatch(
      src,
      /siteFiles\.put\(/,
      `${f} must not copy components into the site tree`,
    );
  }
  // Actually load each one: a syntax slip in a plugin only shows when it is enabled, which a grep would never catch.
  for (const f of ['weather-demo', 'ip-viewer', 'file-manager']) {
    const mod = await import(pathToFileURL(path.resolve(`plugins/${f}/plugin.js`)).href);
    assert.equal(typeof mod.default, 'function', `${f} exports a factory`);
  }
});
