import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startNode, signedIn, ADMIN, until } from './helpers.js';

test('Clear: pages, templates and everything each drop what is kept, and the action is audited', async () => {
  const node = await startNode({ seed: true });
  try {
    const admin = await signedIn(node.app);
    const { cache } = node.ctx;
    await node.ctx.siteFiles.put('pages/hello.html', '<h1>one</h1>', null);

    // A visitor's page is cached; the same address then serves from the cache.
    const first = await request(node.app).get('/hello');
    assert.equal(first.status, 200);
    assert.match(first.text, /one/);
    assert.equal((await request(node.app).get('/hello')).headers['x-cache'], 'HIT');
    const before = cache.stats().sets;
    assert.ok(before > 0, 'the page was stored');

    await cache.set('other:thing', { a: 1 }, { tags: ['other'] });
    assert.deepEqual(await cache.get('other:thing'), { a: 1 });

    // Pages: rendered pages go, unrelated data stays.
    const r1 = await admin.post('/api/admin/cache/clear').send({ scope: 'pages' });
    assert.equal(r1.status, 200);
    assert.deepEqual(await cache.get('other:thing'), { a: 1 }, 'data under another tag is kept');
    const stale = await request(node.app).get('/hello');
    assert.equal(stale.headers['x-cache'], 'MISS', 'the page is built again');

    // Templates: this server's compiled site is dropped and rebuilt.
    let cleared = 0;
    const orig = node.ctx.sitePages.clearCompiled;
    node.ctx.sitePages.clearCompiled = () => {
      cleared++;
      return orig();
    };
    assert.equal(
      (await admin.post('/api/admin/cache/clear').send({ scope: 'templates' })).status,
      200,
    );
    assert.ok(cleared >= 1);
    assert.equal((await request(node.app).get('/hello')).status, 200, 'it renders again');

    // Everything: unrelated data goes too.
    assert.equal(
      (await admin.post('/api/admin/cache/clear').send({ scope: 'everything' })).status,
      200,
    );
    assert.equal(await cache.get('other:thing'), undefined);

    assert.equal((await admin.post('/api/admin/cache/clear').send({ scope: 'nope' })).status, 422);
    const status = (await admin.get('/api/admin/cache')).body;
    assert.deepEqual(status.recent.map((e) => e.scope).slice(0, 3), [
      'everything',
      'templates',
      'pages',
    ]);
    assert.equal(status.recent[0].by, ADMIN.email);
  } finally {
    await node.close();
  }
});

test('Switch off: nothing is stored or served from the cache, responses are not kept by browsers, and it comes back on cleanly', async () => {
  const node = await startNode({ seed: true });
  try {
    const admin = await signedIn(node.app);
    const { cache } = node.ctx;
    await node.ctx.siteFiles.put('pages/hello.html', '<h1>one</h1>', null);
    const warm = await request(node.app).get('/hello');
    assert.match(warm.headers['cache-control'], /max-age|s-maxage|public/, 'normally cacheable');
    await cache.set('keep:me', 1);

    const off = await admin.put('/api/admin/cache/enabled').send({ enabled: false });
    assert.equal(off.status, 200);
    assert.equal(cache.enabled(), false);
    assert.equal((await admin.get('/api/admin/cache')).body.enabled, false);

    // An edit shows at once, with no clearing, and nothing tells a browser or CDN to keep it.
    await node.ctx.siteFiles.put('pages/hello.html', '<h1>two</h1>', null);
    const a = await request(node.app).get('/hello');
    assert.match(a.text, /two/);
    assert.match(a.headers['cache-control'], /no-store|no-cache|max-age=0/);
    const setsBefore = cache.stats().sets;
    await request(node.app).get('/hello');
    assert.equal(cache.stats().sets, setsBefore, 'nothing is written while it is off');
    assert.equal(await cache.get('keep:me'), undefined);

    // Switching back on starts empty (nothing old comes back).
    await admin.put('/api/admin/cache/enabled').send({ enabled: true });
    assert.equal(cache.enabled(), true);
    assert.equal(await cache.get('keep:me'), undefined);
    const log = (await admin.get('/api/admin/cache')).body.recent;
    assert.deepEqual(
      log.slice(0, 2).map((e) => e.enabled),
      [true, false],
    );
  } finally {
    await node.close();
  }
});

test('Cache page: needs cache.read to look, cache.clear to clear, cache.manage to switch', async () => {
  const node = await startNode({ seed: true });
  try {
    const admin = await signedIn(node.app);
    const mk = async (email, perms) => {
      const role = await admin
        .post('/api/admin/roles')
        .send({ name: `r-${email}`, permissions: perms });
      assert.equal(role.status, 201, JSON.stringify(role.body));
      const u = await admin.post('/api/admin/users').send({
        email,
        name: 'T',
        password: 'Another-Pass-77',
        roleId: role.body.id ?? role.body.role?.id,
      });
      assert.ok([200, 201].includes(u.status), JSON.stringify(u.body));
      return signedIn(node.app, { email, password: 'Another-Pass-77' });
    };
    const none = await mk('none@example.com', ['admin.access']);
    assert.equal((await none.get('/api/admin/cache')).status, 403);
    const reader = await mk('read@example.com', ['admin.access', 'cache.read']);
    assert.equal((await reader.get('/api/admin/cache')).status, 200);
    assert.equal(
      (await reader.post('/api/admin/cache/clear').send({ scope: 'pages' })).status,
      403,
    );
    assert.equal(
      (await reader.put('/api/admin/cache/enabled').send({ enabled: false })).status,
      403,
    );
    const clearer = await mk('clear@example.com', ['admin.access', 'cache.read', 'cache.clear']);
    assert.equal(
      (await clearer.post('/api/admin/cache/clear').send({ scope: 'pages' })).status,
      200,
    );
    assert.equal(
      (await clearer.put('/api/admin/cache/enabled').send({ enabled: false })).status,
      403,
    );
    await until(() => true);
  } finally {
    await node.close();
  }
});
