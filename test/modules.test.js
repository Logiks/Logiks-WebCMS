import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import { createModuleRegistry } from '../src/core/modules/registry.js';
import { parseManifest } from '../src/core/modules/manifest.js';
import { builtinModules } from '../src/modules/index.js';

describe('module manifest', () => {
  test('defaults fill in and a bad id is explained', () => {
    const m = parseManifest({ id: 'demo', label: 'Demo' });
    assert.deepEqual(m.requires, []);
    assert.deepEqual(m.provides.services, []);
    assert.equal(m.version, '1.0.0');
    assert.throws(() => parseManifest({ id: 'Bad Id', label: 'x' }), /Module "Bad Id": id: /);
  });

  test('unknown keys are rejected, so a typo in a manifest is not silently ignored', () => {
    assert.throws(() => parseManifest({ id: 'demo', label: 'Demo', reqiures: ['x'] }), /demo/);
  });
});

describe('module registry', () => {
  const mod = (id, requires = [], extra = {}) => ({ id, label: id, requires, ...extra });

  test('a module always comes after what it requires, otherwise registration order is kept', () => {
    const r = createModuleRegistry();
    r.registerAll([mod('c', ['a']), mod('a'), mod('b', ['c'])]);
    assert.deepEqual(r.ids(), ['a', 'c', 'b']);
  });

  test('a missing requirement and a cycle stop start-up with a message that names them', () => {
    const missing = createModuleRegistry();
    missing.register(mod('a', ['ghost']));
    assert.throws(() => missing.ids(), /"a" requires "ghost", which is not registered/);

    const cyc = createModuleRegistry();
    cyc.registerAll([mod('a', ['b']), mod('b', ['a'])]);
    assert.throws(() => cyc.ids(), /dependency cycle: a → b → a/);
  });

  test('registering the same id twice fails', () => {
    const r = createModuleRegistry();
    r.register(mod('a'));
    assert.throws(() => r.register(mod('a')), /registered twice/);
  });

  test('boot runs create() in dependency order and checks what each module says it provides', async () => {
    const seen = [];
    const r = createModuleRegistry();
    r.registerAll([
      mod('b', ['a'], { create: () => seen.push('b') }),
      mod('a', [], { create: () => seen.push('a'), provides: { services: ['svc'] } }),
    ]);
    const ctx = {
      svc: {},
      permissions: { has: () => true },
      registry: { has: () => true },
      jobs: { has: () => true },
    };
    await r.boot(ctx);
    assert.deepEqual(seen, ['a', 'b']);

    const bad = createModuleRegistry();
    bad.register(mod('x', [], { provides: { services: ['nope'] } }));
    await assert.rejects(bad.boot(ctx), /Module "x" says it provides ctx.nope/);
    const badPerm = createModuleRegistry();
    badPerm.register(mod('y', [], { provides: { permissions: ['y.do'] } }));
    await assert.rejects(
      badPerm.boot({ ...ctx, permissions: { has: () => false } }),
      /uses permission "y.do", which is not registered/,
    );
  });
});

describe('the built-in modules', () => {
  let node, admin;
  before(async () => {
    node = await makeNode();
    admin = await signedIn(node.app);
  });
  after(() => node.close());

  test('every built-in module is registered, and the context was built by booting them', () => {
    const ids = node.ctx.modules.ids();
    for (const m of builtinModules) assert.ok(ids.includes(m.id), m.id);
    for (const key of [
      'seo',
      'services',
      'scheduler',
      'publicData',
      'sitePages',
      'i18n',
      'plugins',
      'pageDesigner',
      'sitemap',
    ])
      assert.ok(node.ctx[key], `ctx.${key}`);
  });

  test('every admin route is guarded: its permission is known, or the handler checks it itself', () => {
    let guarded = 0;
    for (const id of node.ctx.modules.ids()) {
      for (const route of node.ctx.modules.routesOf(id)) {
        for (const p of route.permissions ?? []) {
          assert.ok(node.ctx.permissions.has(p), `${id} ${route.method} ${route.path}: ${p}`);
          guarded++;
        }
      }
    }
    assert.ok(
      guarded > 100,
      `expected the inventory to find >100 guarded routes, found ${guarded}`,
    );
  });

  test('GET /system/modules lists built-in modules and plugins, behind a permission', async () => {
    const r = await admin.get('/api/admin/system/modules');
    assert.equal(r.status, 200);
    const seo = r.body.modules.find((m) => m.id === 'seo');
    assert.equal(seo.kind, 'core');
    assert.ok(seo.provides.permissions.includes('seo.write'));
    assert.ok(seo.routes.some((x) => x.method === 'POST' && x.path === '/seo/rules'));
    assert.equal(r.body.modules.find((m) => m.id === 'services').enabled, false); // behind features.services
    assert.equal(
      r.body.modules.filter((m) => m.kind === 'plugin').length,
      node.ctx.plugins.list().length,
    );

    const anon = await (
      await import('supertest')
    )
      .default(node.app)
      .get('/api/admin/system/modules');
    assert.equal(anon.status, 401);
  });
});

describe('contract: every module’s admin routes exist and answer', () => {
  let node, admin;
  before(async () => {
    node = await makeNode();
    admin = await signedIn(node.app);
  });
  after(() => node.close());

  test('each parameter-free GET route of each module answers without a server error', async () => {
    const seen = [];
    const failures = [];
    for (const id of node.ctx.modules.ids()) {
      for (const route of node.ctx.modules.routesOf(id)) {
        if (route.method !== 'GET' || /[:*(]/.test(route.path)) continue;
        // Streams (a zip export, an event feed) and probes of external services are not part of a quick contract check.
        if (/export|download|stream|check|events\/stream/.test(route.path)) continue;
        const r = await admin.get(`/api/admin${route.path}`);
        seen.push(`${id} ${route.path} ${r.status}`);
        if (r.status >= 500 || r.status === 404)
          failures.push(`${id} GET ${route.path} → ${r.status}`);
      }
    }
    assert.ok(seen.length > 30, `expected to exercise >30 routes, did ${seen.length}`);
    assert.deepEqual(failures, []);
  });

  test('every module with admin routes has at least one route the registry can see', () => {
    for (const m of builtinModules) {
      if (m.routes?.admin?.length) assert.ok(node.ctx.modules.routesOf(m.id).length > 0, m.id);
    }
  });
});

describe('module manifest: category, feature and defaultOff', () => {
  test('a module can start switched off, but only an optional one', () => {
    const m = parseManifest({
      id: 'shop',
      label: 'Shop',
      optional: true,
      defaultOff: true,
      category: 'eCommerce',
      feature: 'ecommerce',
    });
    assert.equal(m.defaultOff, true);
    assert.equal(m.category, 'eCommerce');
    assert.throws(
      () => parseManifest({ id: 'shop', label: 'Shop', defaultOff: true }),
      /only an optional module can start switched off/,
    );
    assert.equal(parseManifest({ id: 'x', label: 'X' }).defaultOff, false);
  });
});
