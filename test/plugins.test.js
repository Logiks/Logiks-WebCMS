import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { makeNode, signedIn, tmpDb, sharedBus, busFor, until } from './helpers.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const MANIFEST = (o = {}) =>
  JSON.stringify({
    slug: 'hello',
    name: 'Hello plugin',
    version: '1.0.0',
    author: 'Test author',
    description: 'A tiny test plugin.',
    menu: { label: 'Hello', icon: 'bi-puzzle' },
    permissions: [],
    ...o,
  });
/** A minimal but real plugin: a route, an admin fragment, a migration. */
const BASE = (extra = {}) => ({
  'plugin.json': MANIFEST(extra),
  'plugin.js':
    "export default function (ctx) {\n  const { Router } = ctx.require('express');\n  const r = Router();\n  r.get('/ping', (req, res) => res.json({ ok: true, dialect: ctx.dialect.kind }));\n  r.get('/rows', async (req, res) => res.json({ n: (await ctx.db('plugin_hello_pings').select('*')).length }));\n  return r;\n}\n",
  'migrate.js':
    "export default async function (db, dialect) {\n  await db.schema.createTable('plugin_hello_pings', (t) => { t.increments('id'); });\n}\n",
  'admin/index.html':
    '<div data-testid="hello-plugin-screen">Hello from the plugin admin screen</div>',
});
function zipOf(files) {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content));
  return z.toBuffer();
}
const install = (agent, buf) =>
  agent.post('/api/admin/plugins').set('Content-Type', 'application/octet-stream').send(buf);
/** GET a route that answers with a zip body, as a Buffer. */
const download = (agent, url) =>
  agent
    .get(url)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

describe('installing a plugin from a zip', () => {
  test('rejects an empty zip, a missing manifest, a bad slug and path traversal', async () => {
    assert.equal((await install(admin, zipOf({}))).status, 422);
    assert.equal(
      (await install(admin, zipOf({ 'plugin.js': 'export default () => {}' }))).status,
      422,
    );
    assert.equal(
      (await install(admin, zipOf({ 'plugin.json': MANIFEST({ slug: 'Not Valid!' }) }))).status,
      422,
    );
    const z = new AdmZip();
    z.addFile('plugin.json', Buffer.from(MANIFEST()));
    z.addFile('placeholder.txt', Buffer.from('x'));
    z.getEntries().find((e) => e.entryName === 'placeholder.txt').entryName = '../../../etc/passwd';
    assert.equal((await install(admin, z.toBuffer())).status, 422);
  });

  test('rejects a symlink entry', async () => {
    const z = new AdmZip();
    z.addFile('plugin.json', Buffer.from(MANIFEST()));
    z.addFile('plugin.js', Buffer.from('export default () => {}'));
    const buf = z.toBuffer();
    for (let i = 0; i + 46 < buf.length; i++) {
      if (buf.readUInt32LE(i) !== 0x02014b50) continue;
      const nameLen = buf.readUInt16LE(i + 28);
      if (buf.subarray(i + 46, i + 46 + nameLen).toString() !== 'plugin.js') continue;
      buf.writeUInt16LE(0x031e, i + 4); // made by: Unix
      buf.writeUInt32LE((0o120777 << 16) >>> 0, i + 38); // external attributes: symlink, rwxrwxrwx
    }
    assert.equal((await install(admin, buf)).status, 422);
  });

  test('rejects a plugin.js whose default export is not a function', async () => {
    const res = await install(
      admin,
      zipOf({ 'plugin.json': MANIFEST(), 'plugin.js': 'export default 42;' }),
    );
    assert.equal(res.status, 422);
  });

  test('a valid package installs disabled, then enabling loads its route and runs its migration', async () => {
    const res = await install(admin, zipOf(BASE()));
    assert.equal(res.status, 201);
    assert.equal(res.body.plugin.enabled, false);
    assert.equal(res.body.plugin.source, 'db');

    // not reachable yet: disabled
    assert.equal((await admin.get('/api/admin/apps/hello/ping')).status, 404);

    const enabled = await admin.post('/api/admin/plugins/hello/enable').send({});
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.plugin.enabled, true);
    assert.ok(fs.existsSync(path.join(node.env.PLUGINS_DIR, 'hello', 'plugin.js')));

    const ping = await admin.get('/api/admin/apps/hello/ping');
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body, { ok: true, dialect: node.ctx.dialect.kind });

    // the migration ran: the table exists and the route can query it
    const rows = await admin.get('/api/admin/apps/hello/rows');
    assert.equal(rows.status, 200);
    assert.equal(rows.body.n, 0);

    // disabling makes the route fall through to 404 again, without unloading the module
    const disabled = await admin.post('/api/admin/plugins/hello/disable').send({});
    assert.equal(disabled.body.plugin.enabled, false);
    assert.equal((await admin.get('/api/admin/apps/hello/ping')).status, 404);
    assert.equal(node.ctx.plugins.active().has('hello'), false);

    // re-enabling without a version bump works again immediately (reuses the loaded module)
    await admin.post('/api/admin/plugins/hello/enable').send({});
    assert.equal((await admin.get('/api/admin/apps/hello/ping')).status, 200);

    // re-enabling didn't re-run the migration (no duplicate-table error, and only one migration row)
    const migrations = await node.ctx.db('plugin_migrations').where({ plugin_slug: 'hello' });
    assert.equal(migrations.length, 1);
  });

  test('reinstalling the same slug is a version upsert, not a duplicate', async () => {
    await install(admin, zipOf(BASE({ version: '1.0.1' })));
    const list = (await admin.get('/api/admin/plugins')).body.plugins;
    assert.equal(list.filter((p) => p.slug === 'hello').length, 1);
    assert.equal(list.find((p) => p.slug === 'hello').version, '1.0.1');
    // it was enabled before the reinstall; the version bump hot-loads the new code with no restart
    assert.equal(list.find((p) => p.slug === 'hello').enabled, true);
    await until(async () => (await admin.get('/api/admin/apps/hello/ping')).status === 200);
  });

  test('uninstall refuses while enabled, then succeeds once disabled', async () => {
    assert.equal((await admin.delete('/api/admin/plugins/hello')).status, 409);
    await admin.post('/api/admin/plugins/hello/disable').send({});
    assert.equal((await admin.delete('/api/admin/plugins/hello')).status, 204);
    assert.equal(
      (await admin.get('/api/admin/plugins')).body.plugins.some((p) => p.slug === 'hello'),
      false,
    );
  });

  test('export → reinstall round-trips the same package', async () => {
    await install(admin, zipOf(BASE({ slug: 'roundtrip' })));
    const zip = await download(admin, '/api/admin/plugins/roundtrip/export');
    assert.equal(zip.status, 200);
    assert.equal(zip.headers['content-type'], 'application/zip');
    await admin.post('/api/admin/plugins/roundtrip/disable').send({});
    await admin.delete('/api/admin/plugins/roundtrip');
    const reinstalled = await install(admin, zip.body);
    assert.equal(reinstalled.status, 201);
    assert.equal(reinstalled.body.plugin.slug, 'roundtrip');
  });
});

describe('plugin migrations run once, however often the version changes', () => {
  const enable = (slug) => admin.post(`/api/admin/plugins/${slug}/enable`).send({});
  const disable = (slug) => admin.post(`/api/admin/plugins/${slug}/disable`).send({});
  const names = async (slug) =>
    (await node.ctx.db('plugin_migrations').where({ plugin_slug: slug }).orderBy('id')).map(
      (r) => r.name,
    );
  const hasColumn = (table, col) => node.ctx.db.schema.hasColumn(table, col);

  test('a single default-export migrate.js is not run again after a version bump (Weather Demo 1.0.0 → 1.3.0)', async () => {
    await install(admin, zipOf(BASE({ slug: 'legacy-mig', version: '1.0.0' })));
    // BASE's migrate.js creates plugin_hello_pings; give this plugin its own table name.
    const own = (v) =>
      zipOf({
        ...BASE({ slug: 'legacy-mig', version: v }),
        'migrate.js':
          "export default async function (db) {\n  await db.schema.createTable('plugin_legacy_mig_t', (t) => { t.increments('id'); });\n}\n",
      });
    await install(admin, own('1.0.0'));
    assert.equal((await enable('legacy-mig')).status, 200);
    assert.equal(await node.ctx.db.schema.hasTable('plugin_legacy_mig_t'), true);
    await disable('legacy-mig');
    await install(admin, own('1.3.0'));
    const again = await enable('legacy-mig');
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(await names('legacy-mig'), ['1.0.0']);
  });

  test('named migrations each run once: a new version adds only the new ones', async () => {
    const pkg = (v, extra = '') =>
      zipOf({
        ...BASE({ slug: 'named-mig', version: v }),
        'migrate.js': `export const migrations = [
  { name: '001-create', up: async (db) => { await db.schema.createTable('plugin_named_mig_t', (t) => { t.increments('id'); }); } },
${extra}];\n`,
      });
    await install(admin, pkg('1.0.0'));
    assert.equal((await enable('named-mig')).status, 200);
    assert.deepEqual(await names('named-mig'), ['001-create']);
    assert.equal(await hasColumn('plugin_named_mig_t', 'label'), false);

    await disable('named-mig');
    await install(
      admin,
      pkg(
        '1.1.0',
        "  { name: '002-label', up: async (db) => { await db.schema.alterTable('plugin_named_mig_t', (t) => { t.string('label', 60); }); } },\n",
      ),
    );
    const again = await enable('named-mig');
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(await names('named-mig'), ['001-create', '002-label']);
    assert.equal(await hasColumn('plugin_named_mig_t', 'label'), true);

    await disable('named-mig');
    assert.equal((await enable('named-mig')).status, 200);
    assert.deepEqual(await names('named-mig'), ['001-create', '002-label'], 'nothing runs twice');
  });

  test('a migration that fails is rolled back and says which one', async () => {
    const bad = zipOf({
      ...BASE({ slug: 'bad-mig' }),
      'migrate.js':
        "export const migrations = [{ name: '001-boom', up: async () => { throw new Error('boom'); } }];\n",
    });
    await install(admin, bad);
    const r = await enable('bad-mig');
    assert.notEqual(r.status, 200);
    assert.match(JSON.stringify(r.body), /001-boom/);
    assert.deepEqual(await names('bad-mig'), []);
  });
});

describe('a disk-sourced plugin', () => {
  test('is discovered by scanning plugins/, can be enabled, and cannot be uninstalled through the admin', async () => {
    const dir = path.join(node.env.PLUGINS_DIR, 'diskplug');
    fs.mkdirSync(path.join(dir, 'admin'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      MANIFEST({ slug: 'diskplug', name: 'Disk plugin' }),
    );
    fs.writeFileSync(
      path.join(dir, 'plugin.js'),
      "export default (ctx) => { const { Router } = ctx.require('express'); const r = Router(); r.get('/ping', (req, res) => res.json({ ok: true })); return r; };\n",
    );
    fs.writeFileSync(path.join(dir, 'admin/index.html'), '<div>disk plugin admin</div>');

    const rescanned = await admin.post('/api/admin/plugins/rescan').send({});
    assert.equal(rescanned.status, 200);
    const row = rescanned.body.plugins.find((p) => p.slug === 'diskplug');
    assert.ok(row, 'disk-sourced plugin should appear after a rescan');
    assert.equal(row.source, 'disk');
    assert.equal(row.enabled, false);

    await admin.post('/api/admin/plugins/diskplug/enable').send({});
    assert.equal((await admin.get('/api/admin/apps/diskplug/ping')).status, 200);

    // it ships from disk, so the admin can only disable it, never uninstall it
    assert.equal((await admin.delete('/api/admin/plugins/diskplug')).status, 422);
    await admin.post('/api/admin/plugins/diskplug/disable').send({});
  });
});

describe('permissions', () => {
  test('plugins.read is required to list; plugins.manage is required to mutate', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'PluginViewer', permissions: ['admin.access', 'plugins.read'] },
      null,
    );
    const email = 'pluginviewer@example.com';
    await node.ctx.users.createUser(
      { email, name: 'Plugin Viewer', password: 'Correct-Horse-9', roleId: role.id },
      null,
    );
    const viewer = await signedIn(node.app, { email, password: 'Correct-Horse-9' });
    assert.equal((await viewer.get('/api/admin/plugins')).status, 200);
    assert.equal((await install(viewer, zipOf(BASE({ slug: 'nope' })))).status, 403);

    const noPerms = await node.ctx.users.createRole(
      { name: 'NoPlugins', permissions: ['admin.access'] },
      null,
    );
    const email2 = 'noplugins@example.com';
    await node.ctx.users.createUser(
      { email: email2, name: 'No Plugins', password: 'Correct-Horse-9', roleId: noPerms.id },
      null,
    );
    const other = await signedIn(node.app, { email: email2, password: 'Correct-Horse-9' });
    assert.equal((await other.get('/api/admin/plugins')).status, 403);
  });
});

describe("plugin config (D-061: plugin.json's config → a plugin_<slug> settings namespace)", () => {
  const WITH_CONFIG = (slug) => ({
    'plugin.json': MANIFEST({
      slug,
      config: {
        greeting: { type: 'string', label: 'Greeting', default: 'Hello' },
        loud: { type: 'boolean', label: 'Shout it', default: false },
      },
    }),
  });

  test('declaring config registers a plugin_<slug> namespace (hyphens become underscores), visible generically and editable through the curated route', async () => {
    await install(admin, zipOf(WITH_CONFIG('with-config')));
    const list = (await admin.get('/api/admin/plugins')).body.plugins;
    const row = list.find((p) => p.slug === 'with-config');
    assert.equal(row.hasConfig, true);
    assert.equal(row.settingsNs, 'plugin_with_config');

    // generic Settings screen: the namespace appears with no plugin-specific UI code
    const generic = await admin.get('/api/admin/settings');
    assert.ok(generic.body.namespaces.some((n) => n.namespace === 'plugin_with_config'));

    // curated route, gated by plugins.manage rather than settings.read/write
    const got = await admin.get('/api/admin/plugins/with-config/config');
    assert.equal(got.status, 200);
    assert.ok(got.body.fields.some((f) => f.key === 'greeting'));
    assert.equal(got.body.state.greeting.value, 'Hello');

    const saved = await admin
      .put('/api/admin/plugins/with-config/config')
      .send({ values: { greeting: 'Howdy', loud: true } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.state.greeting.value, 'Howdy');
    assert.equal(node.ctx.settings.get('plugin_with_config.loud'), true);

    // rejects a value that doesn't match the field's own type
    const bad = await admin
      .put('/api/admin/plugins/with-config/config')
      .send({ values: { loud: 'not a boolean' } });
    assert.equal(bad.status, 422);

    await admin.delete('/api/admin/plugins/with-config').catch(() => {});
  });

  test('a plugin with no config block gets no namespace at all', async () => {
    await install(admin, zipOf(BASE({ slug: 'no-config' })));
    const row = (await admin.get('/api/admin/plugins')).body.plugins.find(
      (p) => p.slug === 'no-config',
    );
    assert.equal(row.hasConfig, false);
    assert.equal((await admin.get('/api/admin/plugins/no-config/config')).status, 404);
    await admin.delete('/api/admin/plugins/no-config').catch(() => {});
  });

  test('uninstalling a configured plugin removes its namespace too', async () => {
    await install(admin, zipOf(WITH_CONFIG('temp-config')));
    assert.equal((await admin.get('/api/admin/plugins/temp-config/config')).status, 200);
    await admin.delete('/api/admin/plugins/temp-config');
    assert.equal(
      (await admin.get('/api/admin/settings')).body.namespaces.some(
        (n) => n.namespace === 'plugin_temp_config',
      ),
      false,
    );
  });
});

test('cluster: enabling a plugin on one server makes it reachable on another (bus), and a server that misses the message heals by polling', async () => {
  const db = tmpDb();
  const emitter = sharedBus();
  const a = await makeNode({ dbUrl: db.url, bus: busFor(emitter) });
  // its own bus: it never hears from A directly, so this also exercises the polling fallback
  const b = await makeNode({
    dbUrl: db.url,
    bus: busFor(sharedBus()),
    env: { CONFIG_POLL_SECONDS: '1' },
  });
  try {
    const agentA = await signedIn(a.app);
    await install(agentA, zipOf(BASE({ slug: 'clustered' })));
    await agentA.post('/api/admin/plugins/clustered/enable').send({});

    assert.equal(b.ctx.plugins.active().has('clustered'), false);
    await until(() => b.ctx.plugins.active().has('clustered'), { timeout: 4000 });
    assert.equal((await request(b.app).get('/api/admin/apps/clustered/ping')).status, 401); // no session on b's agent
    const agentB = await signedIn(b.app);
    assert.equal((await agentB.get('/api/admin/apps/clustered/ping')).status, 200);
  } finally {
    await a.close();
    await b.close();
    db.cleanup();
  }
});
