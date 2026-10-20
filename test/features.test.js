import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';
import { createFeatures } from '../src/modules/features/service.js';

let node, admin;
const get = (p) => request(node.app).get(p);
const put = (id, enabled) => admin.put(`/api/admin/features/${id}`).send({ enabled });
const listed = async () => (await admin.get('/api/admin/features')).body.features;
const one = async (id) => (await listed()).find((f) => f.id === id);

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  await node.ctx.content.create(
    'post',
    {
      title: 'Hello feature world',
      status: 'published',
      data: { body: { blocks: [{ type: 'paragraph', data: { text: 'A post body' } }] } },
    },
    null,
  );
});
after(() => node.close());

describe('Settings → Features: the blog', () => {
  test('an existing install has the blog on, so nothing changes on upgrade', async () => {
    assert.equal((await one('blog')).enabled, true);
    const r = await get('/blog');
    assert.equal(r.status, 200);
    assert.match(r.text, /Hello feature world/);
    assert.equal((await get('/blog/hello-feature-world')).status, 200);
  });

  test('switching it off stops serving the blog and everything it shows, and deletes nothing', async () => {
    const home = await get('/');
    assert.match(
      home.text,
      /Hello feature world/,
      'the home page lists the latest posts while the blog is on',
    );

    const r = await put('blog', false);
    assert.equal(r.status, 200);
    assert.equal(r.body.features.find((f) => f.id === 'blog').enabled, false);

    assert.equal((await get('/blog')).status, 404);
    assert.equal((await get('/blog/hello-feature-world')).status, 404);
    const after = await get('/');
    assert.equal(after.status, 200, 'the home page still works');
    assert.doesNotMatch(after.text, /Hello feature world/, 'but no longer lists posts');

    // Posts, categories and tags are gone from the admin and the public API too, not just the site.
    const types = (await admin.get('/api/admin/content/types')).body.types.map((t) => t.id);
    assert.deepEqual(types, ['page']);
    const posts = await admin.get('/api/admin/content/types/post/entries');
    assert.equal(posts.status, 404);
    assert.equal(posts.body.error.code, 'feature_disabled');
    assert.match(posts.body.error.message, /Settings → Features/);
    assert.equal((await admin.get('/api/admin/content/taxonomies/category/terms')).status, 404);
    assert.equal((await admin.get('/api/admin/content/taxonomies/tag/terms')).status, 404);
    await assert.rejects(
      node.ctx.publicData.get('/api/public/content/post'),
      /Nothing is published here/,
    );
    const state = (await admin.get('/api/admin/system/modules/state')).body;
    assert.ok(state.featuresOff.includes('blog'));
    // The search and the sitemap don't offer what can't be opened.
    assert.doesNotMatch((await get('/sitemap.xml')).text, /hello-feature-world/);
    assert.doesNotMatch((await get('/search?q=Hello')).text, /Hello feature world/);

    // The data and the pages are still there.
    const stored = await node.ctx.content.list('post', { status: 'published' });
    assert.ok(JSON.stringify(stored).includes('Hello feature world'));
    assert.ok(node.ctx.siteFiles.snapshot().files.has('pages/blog/index.html'));
  });

  test('switching it back on brings everything back as it was', async () => {
    assert.equal((await put('blog', true)).status, 200);
    const r = await get('/blog');
    assert.equal(r.status, 200);
    assert.match(r.text, /Hello feature world/);
    assert.equal((await get('/blog/hello-feature-world')).status, 200);
    const types = (await admin.get('/api/admin/content/types')).body.types.map((t) => t.id);
    assert.deepEqual(types, ['page', 'post']);
    assert.equal((await admin.get('/api/admin/content/types/post/entries')).status, 200);
    assert.ok((await node.ctx.publicData.get('/api/public/content/post')).body);
  });

  test('both directions are audited', async () => {
    await put('blog', false);
    await put('blog', true);
    const log = await node.ctx.audit.list?.({ entity: 'feature' });
    const actions = JSON.stringify(
      log ?? (await node.ctx.db('audit_log').where({ entity: 'feature' })),
    );
    assert.match(actions, /feature\.disabled/);
    assert.match(actions, /feature\.enabled/);
  });
});

describe('Settings → Features: content pages', () => {
  before(async () => {
    await node.ctx.content.create(
      'page',
      {
        title: 'About feature',
        status: 'published',
        data: { body: { blocks: [{ type: 'paragraph', data: { text: 'About body text' } }] } },
      },
      null,
    );
  });

  test('on by default for an existing install, called Content pages in the admin', async () => {
    assert.equal((await one('pages')).enabled, true);
    const types = (await admin.get('/api/admin/content/types')).body.types;
    assert.equal(types.find((t) => t.id === 'page').plural, 'Content pages');
    const r = await get('/about-feature');
    assert.equal(r.status, 200);
    assert.match(r.text, /About body text/);
  });

  test('off: the pages editors wrote stop being served and leave the admin, site pages are unaffected, nothing is deleted', async () => {
    assert.equal((await put('pages', false)).status, 200);
    assert.equal((await get('/about-feature')).status, 404);
    assert.equal((await get('/')).status, 200, 'the home page is a site page and still works');
    assert.equal((await get('/contact')).status, 200, 'so is the contact page');
    const types = (await admin.get('/api/admin/content/types')).body.types.map((t) => t.id);
    assert.ok(!types.includes('page'));
    const gone = await admin.get('/api/admin/content/types/page/entries');
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error.code, 'feature_disabled');
    assert.doesNotMatch((await get('/sitemap.xml')).text, /about-feature/);
    const kept = await node.ctx.db('entries').where({ title: 'About feature' });
    assert.equal(kept.length, 1);
  });

  test('on again: they are back', async () => {
    assert.equal((await put('pages', true)).status, 200);
    assert.equal((await get('/about-feature')).status, 200);
    const types = (await admin.get('/api/admin/content/types')).body.types.map((t) => t.id);
    assert.ok(types.includes('page'));
  });
});

describe('Settings → Features: features that are not built yet, and dependencies', () => {
  test('a feature with nothing behind it cannot be switched on yet, and says so', async () => {
    const f = await one('support');
    assert.equal(f.ready, false);
    const r = await put('support', true);
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'feature_unavailable');
    assert.match(r.body.error.message, /Support tickets isn't available yet/);
    assert.equal((await one('support')).enabled, false);
  });

  test('the plan says what switching a feature would do before it does it', async () => {
    const p = (await admin.get('/api/admin/features/blog/plan?enabled=false')).body;
    assert.deepEqual(p.features, ['blog']);
    assert.deepEqual(p.blockedBy, []);
    const q = (await admin.get('/api/admin/features/ecommerce/plan?enabled=true')).body;
    assert.ok(q.blockedBy.length, 'eCommerce is not built yet');
  });

  test('an unknown feature is a 404', async () => {
    assert.equal((await put('nope', true)).status, 404);
  });

  test('it needs a permission', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'feat-viewer', description: '', permissions: ['admin.access', 'features.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'fv@example.com',
        name: 'fv',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const u = await signedIn(node.app, { email: 'fv@example.com', password: 'Some-long-pass-12' });
    assert.equal((await u.get('/api/admin/features')).status, 200);
    assert.equal((await u.put('/api/admin/features/blog').send({ enabled: false })).status, 403);
    assert.equal((await one('blog')).enabled, true);
  });
});

describe('features with modules (service level)', () => {
  // A stand-in feature with two optional modules, so the rules for modules are tested before eCommerce exists.
  const defs = [
    { id: 'base', label: 'Base', description: '', requires: [], gates: {} },
    { id: 'shop', label: 'Shop', description: '', requires: ['base'], gates: {} },
  ];
  let features;
  before(() => {
    const m = (id, requires, feature) => ({
      id,
      label: id,
      requires,
      optional: true,
      defaultOff: true,
      feature,
    });
    node.ctx.modules.registerDynamic(m('base-mod', [], 'base'));
    node.ctx.modules.registerDynamic(m('shop-mod', ['base-mod'], 'shop'));
    features = createFeatures({ ctx: node.ctx, definitions: defs });
  });
  after(async () => {
    node.ctx.modules.unregister('base-mod');
    await node.ctx.settings.update('featureset', { values: { enabled: ['blog'] } }, null, {
      internal: true,
    });
  });

  test('switching a feature on pulls in what it needs, in order, and switches its modules', async () => {
    const plan = features.plan('shop', true);
    assert.deepEqual(plan.features, ['base', 'shop']);
    assert.deepEqual(
      plan.modules.map((x) => x.id),
      ['base-mod', 'shop-mod'],
    );
    await features.setEnabled('shop', true, null);
    assert.equal(node.ctx.modules.isOn('base-mod', node.ctx), true);
    assert.equal(node.ctx.modules.isOn('shop-mod', node.ctx), true);
    assert.equal(features.isOn('base'), true);
  });

  test('switching off what another feature needs is refused and changes nothing', async () => {
    const plan = features.plan('base', false);
    assert.match(plan.blockedBy[0], /Shop needs Base/);
    await assert.rejects(features.setEnabled('base', false, null), /Shop needs Base/);
    assert.equal(node.ctx.modules.isOn('base-mod', node.ctx), true);
  });

  test('switching off turns its modules off but keeps the data and opt-in order', async () => {
    await features.setEnabled('shop', false, null);
    await features.setEnabled('base', false, null);
    assert.equal(node.ctx.modules.isOn('shop-mod', node.ctx), false);
    assert.equal(node.ctx.modules.isOn('base-mod', node.ctx), false);
    assert.equal(features.isOn('shop'), false);
  });
});
