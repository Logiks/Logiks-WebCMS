import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { makeNode, signedIn, until } from './helpers.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const toggle = (id, enabled) => admin.put(`/api/admin/system/modules/${id}`).send({ enabled });
const state = async () => (await admin.get('/api/admin/system/modules/state')).body.disabled;

test('Settings → All settings does not list the Modules (or Feature switches) card: it has nothing to edit', async () => {
  const names = (await admin.get('/api/admin/settings')).body.namespaces.map((n) => n.namespace);
  assert.ok(names.includes('general'), 'ordinary namespaces are still listed');
  assert.ok(!names.includes('modules') && !names.includes('featureset'));
  // …and the switches themselves still work
  assert.equal((await toggle('seo', false)).status, 200);
  assert.deepEqual(await state(), ['seo']);
  await toggle('seo', true);
});

describe('switching optional modules on and off', () => {
  test('a module that is off answers 404 on every route it owns, and comes back when switched on', async () => {
    assert.equal((await admin.get('/api/admin/seo/rules')).status, 200);
    const off = await toggle('seo', false);
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.disabled, ['seo']);
    const r = await admin.get('/api/admin/seo/rules');
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'module_disabled');
    assert.match(r.body.error.message, /Settings → Modules/);
    assert.equal((await admin.post('/api/admin/seo/rules').send({ pattern: '/x' })).status, 404);
    // Routes that were never the module's are untouched.
    assert.equal((await admin.get('/api/admin/webhooks')).status, 200);
    assert.equal((await toggle('seo', true)).status, 200);
    assert.equal((await admin.get('/api/admin/seo/rules')).status, 200);
    assert.deepEqual(await state(), []);
  });

  test('a core module cannot be switched off, and an unknown one is a 404', async () => {
    const core = await toggle('content', false);
    assert.equal(core.status, 422);
    assert.equal(core.body.error.code, 'module_required');
    assert.equal((await toggle('nope', false)).status, 404);
  });

  test('you cannot switch off what another module needs, or on what needs something that is off', async () => {
    const used = await toggle('webhooks', false); // the Scheduler needs Webhooks
    assert.equal(used.status, 422);
    assert.match(used.body.error.message, /Scheduler needs Webhooks/);
    assert.equal((await toggle('scheduler', false)).status, 200);
    assert.equal((await toggle('webhooks', false)).status, 200);
    const back = await toggle('scheduler', true);
    assert.equal(back.status, 422);
    assert.match(back.body.error.message, /needs Webhooks, which is switched off/);
    assert.equal((await toggle('webhooks', true)).status, 200);
    assert.equal((await toggle('scheduler', true)).status, 200);
    assert.deepEqual(await state(), []);
  });

  test('it is permission-guarded and audited', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'no-modules', description: '', permissions: ['admin.access', 'cluster.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'nm@example.com',
        name: 'nm',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const u = await signedIn(node.app, { email: 'nm@example.com', password: 'Some-long-pass-12' });
    assert.equal(
      (await u.put('/api/admin/system/modules/seo').send({ enabled: false })).status,
      403,
    );
    assert.equal((await u.get('/api/admin/system/modules/state')).status, 200);
    await toggle('seo', false);
    await toggle('seo', true);
    const log = await node.ctx.audit.list({ limit: 50 });
    assert.ok(log.some((e) => e.action === 'module.disabled' && e.entityId === 'seo'));
    assert.ok(log.some((e) => e.action === 'module.enabled' && e.entityId === 'seo'));
  });

  test('SEO rules stop applying while SEO Manager is off', async () => {
    await node.ctx.seo.create({ pattern: '/contact', title: 'Switch Test Title' }, null);
    const title = async () => (await request(node.app).get('/contact')).text;
    assert.match(await title(), /<title>Switch Test Title<\/title>/);
    await toggle('seo', false);
    assert.doesNotMatch(await title(), /Switch Test Title/);
    await toggle('seo', true);
    assert.match(await title(), /<title>Switch Test Title<\/title>/);
  });

  test('Services off removes its public operation and what a page can read; on restores it', async () => {
    await node.ctx.settings.update('features', { values: { public_api: true, services: true } });
    const hit = () => node.ctx.publicData.resolve('/api/v1/services/anything');
    assert.ok(hit());
    await toggle('page-designer', false);
    await toggle('scheduler', false); // the Scheduler runs Services
    assert.equal((await toggle('services', false)).status, 200);
    await assert.rejects(node.ctx.publicData.get('/api/v1/services/anything'), /no such data/);
    assert.equal(node.ctx.modules.isEnabled('services', node.ctx), false);
    await toggle('services', true);
    await toggle('scheduler', true);
    await toggle('page-designer', true);
    assert.equal(node.ctx.modules.isEnabled('services', node.ctx), true);
    await node.ctx.settings.update('features', { values: { public_api: false, services: false } });
  });

  test('events off logs nothing; jobs of an off module do nothing', async () => {
    const count = async () => Number((await node.ctx.db('events_log').count({ n: '*' }))[0].n);
    const n = await count();
    await toggle('webhooks', false).catch(() => {});
    await toggle('scheduler', false);
    await toggle('webhooks', false);
    await toggle('events', false);
    await node.ctx.events.emit('switch.test', {});
    assert.equal(await count(), n);
    await toggle('events', true);
    await node.ctx.events.emit('switch.test', {});
    assert.equal(await count(), n + 1);
    await toggle('webhooks', true);
    await toggle('scheduler', true);
  });

  test('the switch reaches every server', async () => {
    await toggle('dbms', false);
    await until(async () => node.ctx.settings.get('modules.disabled').includes('dbms'));
    assert.equal(node.ctx.modules.isOn('dbms', node.ctx), false);
    await toggle('dbms', true);
  });
});

describe('plugins are modules', () => {
  const MANIFEST = (o = {}) =>
    JSON.stringify({
      slug: 'modplug',
      name: 'Mod plugin',
      version: '1.0.0',
      permissions: [{ key: 'modplug.view', label: 'View it' }],
      ...o,
    });
  const zip = (manifest) => {
    const z = new AdmZip();
    z.addFile('plugin.json', Buffer.from(manifest));
    z.addFile('plugin.js', Buffer.from('export default function () { return null; }\n'));
    return z.toBuffer();
  };
  const install = (buf) =>
    admin.post('/api/admin/plugins').set('Content-Type', 'application/octet-stream').send(buf);
  const listed = async () => (await admin.get('/api/admin/system/modules')).body.modules;

  test('an enabled plugin is registered with its requirements and permissions; disabled, it is not', async () => {
    assert.equal((await install(zip(MANIFEST({ requires: ['seo'] })))).status, 201);
    assert.ok(!node.ctx.modules.has('plugin-modplug'));
    assert.equal((await admin.post('/api/admin/plugins/modplug/enable').send({})).status, 200);
    await until(() => node.ctx.modules.has('plugin-modplug'));
    const m = (await listed()).find((x) => x.id === 'plugin-modplug');
    assert.equal(m.kind, 'plugin');
    assert.equal(m.enabled, true);
    assert.deepEqual(m.requires, ['plugins', 'seo']);
    assert.deepEqual(m.provides.permissions, ['modplug.view']);

    // It needs SEO Manager, so SEO Manager can't be switched off underneath it.
    const refuse = await toggle('seo', false);
    assert.equal(refuse.status, 422);
    assert.match(refuse.body.error.message, /Mod plugin needs SEO Manager/);

    await admin.post('/api/admin/plugins/modplug/disable').send({});
    await until(() => !node.ctx.modules.has('plugin-modplug'));
    const idle = (await listed()).find((x) => x.id === 'plugin-modplug');
    assert.equal(idle.enabled, false);
    assert.equal((await toggle('seo', false)).status, 200);
    await toggle('seo', true);
  });

  test('a plugin that needs something that is switched off is not loaded, and says why', async () => {
    await toggle('seo', false);
    const r = await admin.post('/api/admin/plugins/modplug/enable').send({});
    assert.equal(r.status, 200);
    assert.equal(node.ctx.modules.has('plugin-modplug'), false);
    const p = (await admin.get('/api/admin/plugins')).body.plugins.find(
      (x) => x.slug === 'modplug',
    );
    assert.equal(p.loaded, false);
    assert.match(p.loadError, /seo.*switched off|not loaded/i);
    await toggle('seo', true);
    await admin.post('/api/admin/plugins/modplug/disable').send({});
  });

  test('a plugin that depends on another plugin loads only with it, in any install order', async () => {
    await install(
      zip(
        MANIFEST({ slug: 'second-plug', name: 'Second', permissions: [], depends: ['first-plug'] }),
      ),
    );
    await install(zip(MANIFEST({ slug: 'first-plug', name: 'First', permissions: [] })));
    await admin.post('/api/admin/plugins/second-plug/enable').send({});
    assert.equal(node.ctx.modules.has('plugin-second-plug'), false);
    await admin.post('/api/admin/plugins/first-plug/enable').send({});
    await until(() => node.ctx.modules.has('plugin-second-plug'));
    assert.ok(node.ctx.modules.has('plugin-first-plug'));
    // Switching the first off takes the second out with it.
    await admin.post('/api/admin/plugins/first-plug/disable').send({});
    await until(() => !node.ctx.modules.has('plugin-second-plug'));
  });
});

describe('modules that start switched off (eCommerce, Support — D-095)', () => {
  const shop = (id, requires = []) => ({
    id,
    label: id,
    requires,
    optional: true,
    defaultOff: true,
    category: 'eCommerce',
    feature: 'ecommerce',
  });
  const listed = async () => (await admin.get('/api/admin/system/modules')).body.modules;

  before(() => {
    node.ctx.modules.registerDynamic(shop('shop-a'));
    node.ctx.modules.registerDynamic(shop('shop-b', ['shop-a']));
  });
  after(() => node.ctx.modules.unregister('shop-a'));

  test('they are off until an administrator opts in, and the menu is told so', async () => {
    assert.deepEqual(await state(), ['shop-a', 'shop-b']);
    const m = (await listed()).find((x) => x.id === 'shop-a');
    assert.equal(m.enabled, false);
    assert.equal(m.switchedOff, true);
    assert.equal(m.category, 'eCommerce');
    assert.equal(m.feature, 'ecommerce');
    assert.equal(m.defaultOff, true);
  });

  test('opting in is saved, needs what the module requires, and can be undone', async () => {
    const early = await toggle('shop-b', true);
    assert.equal(early.status, 422);
    assert.match(early.body.error.message, /shop-b needs shop-a, which is switched off/);

    assert.equal((await toggle('shop-a', true)).status, 200);
    assert.equal((await toggle('shop-b', true)).status, 200);
    assert.deepEqual(await state(), []);
    assert.deepEqual(node.ctx.settings.get('modules.enabled'), ['shop-a', 'shop-b']);
    assert.deepEqual(node.ctx.settings.get('modules.disabled'), []);

    const used = await toggle('shop-a', false);
    assert.equal(used.status, 422);
    assert.match(used.body.error.message, /shop-b needs shop-a/);
    assert.equal((await toggle('shop-b', false)).status, 200);
    assert.equal((await toggle('shop-a', false)).status, 200);
    assert.deepEqual(await state(), ['shop-a', 'shop-b']);
    assert.deepEqual(node.ctx.settings.get('modules.enabled'), []);
  });
});
