import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';
import { envelope } from '../src/core/api/envelope.js';
import { compilePath, matchPath } from '../src/core/api/match.js';

let node, admin, post;
const v1 = (p, key) => {
  const r = request(node.app).get(`/api/v1${p}`);
  return key ? r.set('Authorization', `Bearer ${key}`) : r;
};
const legacy = (p) => request(node.app).get(`/api/public${p}`);
const setApi = (on) => node.ctx.settings.update('features', { values: { public_api: on } });
const newKey = async (o = {}) =>
  (await admin.post('/api/admin/api-keys').send({ name: 'test', scopes: ['*'], ...o })).body;

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  const cat = await node.ctx.content.createTerm('category', { name: 'News' }, null);
  post = await node.ctx.content.create(
    'post',
    {
      title: 'Hello API',
      status: 'published',
      data: { body: { blocks: [{ type: 'paragraph', data: { text: 'hello world' } }] } },
      termIds: [cat.id],
    },
    null,
  );
  await node.ctx.site.menus.save('main', { title: 'Main', items: [{ label: 'Home', url: '/' }] });
});
after(() => node.close());

describe('path templates', () => {
  test(':x is one segment and *x is the rest', () => {
    const p = compilePath('/content/:type/*path');
    assert.deepEqual(matchPath(p, ['content', 'post', 'a', 'b']), { type: 'post', path: 'a/b' });
    assert.equal(matchPath(p, ['content', 'post']), null);
    assert.equal(matchPath(compilePath('/terms/:t/:s'), ['terms', 'c', 's', 'extra']), null);
    assert.throws(() => compilePath('/a/*rest/b'), /must come last/);
  });

  test('loose matching treats a Liquid segment as unknown', () => {
    const p = compilePath('/content/post/:slug');
    assert.deepEqual(matchPath(p, ['content', 'post', '{{ slug }}'], { loose: true }), {
      slug: '{{ slug }}',
    });
    assert.equal(
      matchPath(compilePath('/menus/main'), ['menus', '{{ x }}'], { loose: true }) !== null,
      true,
    );
  });
});

describe('the envelope', () => {
  test('a list becomes data + meta; anything else is wrapped as it is', () => {
    assert.deepEqual(envelope({ items: [1, 2], page: 1, total: 2 }), {
      data: [1, 2],
      meta: { page: 1, total: 2 },
    });
    assert.deepEqual(envelope({ results: ['a'], total: 1, query: 'q' }), {
      data: ['a'],
      meta: { total: 1, query: 'q' },
    });
    assert.deepEqual(envelope({ item: { id: 1 } }), { data: { item: { id: 1 } }, meta: {} });
  });
});

describe('/api/v1 and /api/public', () => {
  test('both are off until the feature is on, with a message that says how to fix it', async () => {
    await setApi(false);
    for (const r of [await v1('/content/post'), await legacy('/content/post')]) {
      assert.equal(r.status, 404);
      assert.match(r.body.error.message, /turned off/);
    }
  });

  test('v1 wraps successes in { data, meta }; /api/public keeps the raw body', async () => {
    await setApi(true);
    const a = await v1('/content/post?per_page=5');
    const b = await legacy('/content/post?per_page=5');
    assert.equal(a.status, 200);
    assert.ok(Array.isArray(a.body.data));
    assert.equal(a.body.data[0].title, 'Hello API');
    assert.equal(a.body.meta.total, 1);
    assert.deepEqual(a.body.data, b.body.items);
    assert.equal(a.headers['cache-control'].startsWith('public'), true);
  });

  test('every declared operation answers the same over HTTP as in-process (what the site sees)', async () => {
    await setApi(true);
    const urls = {
      'content.types': '/content',
      'content.list': '/content/post',
      'content.item': `/content/post/${post.path}`,
      'content.terms': '/terms/category',
      'content.term': '/terms/category/news',
      'site.menu': '/menus/main',
      'search.query': '/search?q=hello',
    };
    const declared = node.ctx.modules
      .operations()
      .filter((o) => o.method === 'GET')
      .map((o) => o.id);
    for (const id of declared.filter((x) => x !== 'services.run'))
      assert.ok(urls[id], `add a sample address for ${id}`);
    for (const [id, url] of Object.entries(urls)) {
      const inproc = await node.ctx.publicData.get(`/api/v1${url}`);
      assert.equal(inproc.operation, id);
      const http = await v1(url);
      assert.equal(http.status, 200, url);
      assert.deepEqual(http.body, JSON.parse(JSON.stringify(envelope(inproc.body))), url);
    }
  });

  test('/info is enveloped on v1 and raw on /api/public', async () => {
    assert.ok((await v1('/info')).body.data.siteName);
    assert.ok((await legacy('/info')).body.siteName);
  });

  test('unknown addresses are a plain 404', async () => {
    assert.equal((await v1('/nothing/here')).status, 404);
    assert.equal((await v1('/content/post/')).status, 200); // trailing slash is the list
  });

  test('CORS answers the preflight for the key headers, for an origin the admin listed', async () => {
    await node.ctx.settings.update('security', { values: { cors_origins: ['https://x.example'] } });
    const r = await request(node.app)
      .options('/api/v1/content/post')
      .set('Origin', 'https://x.example')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,x-api-key');
    assert.match(r.headers['access-control-allow-headers'] ?? '', /Authorization/i);
  });
});

describe('API keys', () => {
  test('the secret is returned once and never stored, listed or audited', async () => {
    const made = await newKey({ name: 'Mobile app' });
    assert.match(made.secret, /^cms_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(made.key.hint, `cms_${made.key.prefix}_…`);
    const list = (await admin.get('/api/admin/api-keys')).body;
    const dump = JSON.stringify(list) + JSON.stringify(await node.ctx.audit.list({ limit: 200 }));
    assert.ok(!dump.includes(made.secret));
    const row = await node.ctx.db('api_keys').where({ id: made.key.id }).first();
    assert.ok(!JSON.stringify(row).includes(made.secret.split('_')[2]));
    assert.equal(row.hash.length, 64);
    assert.ok(list.keys.some((k) => k.name === 'Mobile app' && !('hash' in k) && !('secret' in k)));
  });

  test('a key works while the public API is off, and its answers are never shared-cacheable', async () => {
    await setApi(false);
    const { secret } = await newKey();
    const r = await v1('/content/post', secret);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.match(r.headers.vary, /Authorization/i);
    assert.equal((await v1('/content/post')).status, 404); // without it: still off
    const viaHeader = await request(node.app).get('/api/v1/content/post').set('X-API-Key', secret);
    assert.equal(viaHeader.status, 200);
  });

  test('scopes limit which modules a key may read', async () => {
    await setApi(false);
    const { secret } = await newKey({ scopes: ['content'] });
    assert.equal((await v1('/content/post', secret)).status, 200);
    const denied = await v1('/menus/main', secret);
    assert.equal(denied.status, 403);
    assert.match(denied.body.error.message, /"site" module/);
    assert.equal((await v1('/search?q=x', secret)).status, 403);
  });

  test('a wrong, disabled, expired or rotated-away key is a 401 that says what to do', async () => {
    await setApi(true); // even with the API open, a bad key is refused rather than silently ignored
    const bad = await v1('/content/post', 'cms_deadbeef_' + 'A'.repeat(43));
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'invalid_api_key');
    assert.match(bad.body.error.message, /System → API/);

    const k = await newKey();
    assert.equal((await v1('/content', k.secret)).status, 200);
    await admin
      .put(`/api/admin/api-keys/${k.key.id}`)
      .send({ name: 'x', scopes: ['*'], enabled: false });
    assert.equal((await v1('/content', k.secret)).status, 401);
    await admin
      .put(`/api/admin/api-keys/${k.key.id}`)
      .send({ name: 'x', scopes: ['*'], enabled: true });
    assert.equal((await v1('/content', k.secret)).status, 200);

    const expired = await newKey();
    await node.ctx
      .db('api_keys')
      .where({ id: expired.key.id })
      .update({ expires_at: Date.now() - 1000 });
    await node.ctx.cache.invalidate(['apikeys']);
    assert.equal((await v1('/content', expired.secret)).status, 401);

    const rot = (await admin.post(`/api/admin/api-keys/${k.key.id}/rotate`).send({})).body;
    assert.notEqual(rot.secret, k.secret);
    assert.equal((await v1('/content', k.secret)).status, 401);
    assert.equal((await v1('/content', rot.secret)).status, 200);
  });

  test('deleting a key stops it at once', async () => {
    const k = await newKey();
    assert.equal((await v1('/content', k.secret)).status, 200);
    assert.equal((await admin.delete(`/api/admin/api-keys/${k.key.id}`)).status, 204);
    assert.equal((await v1('/content', k.secret)).status, 401);
  });

  test('each key has its own request budget', async () => {
    const k = await newKey({ rateLimit: 2 });
    assert.equal((await v1('/content', k.secret)).status, 200);
    assert.equal((await v1('/content', k.secret)).status, 200);
    const third = await v1('/content', k.secret);
    assert.equal(third.status, 429);
    assert.match(third.body.error.message, /API key/);
    const other = await newKey();
    assert.equal((await v1('/content', other.secret)).status, 200);
  });

  test('input is validated and the admin routes are permission-guarded', async () => {
    const empty = await admin.post('/api/admin/api-keys').send({ name: '', scopes: ['*'] });
    assert.equal(empty.status, 422);
    const nomod = await admin.post('/api/admin/api-keys').send({ name: 'x', scopes: ['users'] });
    assert.equal(nomod.status, 422);
    assert.match(nomod.body.error.message, /or <module>:write/);

    const role = await node.ctx.users.createRole(
      { name: 'api-reader', description: '', permissions: ['admin.access', 'api.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'ar@example.com',
        name: 'ar',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const reader = await signedIn(node.app, {
      email: 'ar@example.com',
      password: 'Some-long-pass-12',
    });
    assert.equal((await reader.get('/api/admin/api-keys')).status, 200);
    assert.equal(
      (await reader.post('/api/admin/api-keys').send({ name: 'x', scopes: ['*'] })).status,
      403,
    );
  });
});

describe('OpenAPI', () => {
  test('/api/v1/openapi.json describes every declared operation, its parameters and the envelope', async () => {
    const r = await v1('/openapi.json');
    assert.equal(r.status, 200);
    assert.equal(r.body.openapi, '3.1.0');
    for (const op of node.ctx.modules.operations()) {
      const path = op.path.replace(/[:*](\w+)/g, '{$1}');
      const doc = r.body.paths[path]?.[op.method.toLowerCase()];
      assert.ok(doc, `${op.id} → ${path}`);
      assert.equal(doc.operationId, op.id);
      for (const name of [...op.path.matchAll(/[:*](\w+)/g)].map((m) => m[1]))
        assert.ok(
          doc.parameters.some((p) => p.name === name && p.in === 'path' && p.required),
          name,
        );
      for (const q of Object.keys(op.query))
        assert.ok(doc.parameters.some((p) => p.name === q && p.in === 'query'));
      assert.ok(doc.responses[op.status] && doc.responses[404] && doc.responses[429]);
    }
    assert.ok(r.body.components.securitySchemes.bearerKey);
    assert.ok(r.body.paths['/info']);
  });

  test('the admin document lists every guarded route with its permission, and needs api.read', async () => {
    const r = await admin.get('/api/admin/api-reference/openapi.json?surface=admin');
    assert.equal(r.status, 200);
    const post = r.body.paths['/admin/seo/rules'].post;
    assert.deepEqual(post['x-permissions'], ['seo.write']);
    assert.ok(r.body.paths['/admin/seo/rules/{id}'].put);
    const ref = (await admin.get('/api/admin/api-reference')).body;
    assert.equal(ref.prefix, '/api/v1');
    assert.ok(ref.operations.find((o) => o.id === 'services.run').available === false);
    assert.ok(ref.readable.some((m) => m.id === 'content'));
  });
});

describe('writes (D-070)', () => {
  const send = (method, p, body, key) => {
    let r = request(node.app)[method](`/api/v1${p}`);
    if (key) r = r.set('Authorization', `Bearer ${key}`);
    return r.send(body);
  };
  const keyWith = (scopes) => newKey({ scopes });

  test('there are no writes on the older /api/public address', async () => {
    const r = await request(node.app).post('/api/public/contact').send({ name: 'x' });
    assert.ok(r.status >= 400, `a write on /api/public must not succeed (got ${r.status})`);
  });

  test('a write needs a key that names the module; "*" is read-only', async () => {
    const none = await send('post', '/entries/post', { title: 'No key' });
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, 'api_key_required');

    const readAll = await keyWith(['*']);
    const star = await send('post', '/entries/post', { title: 'Star' }, readAll.secret);
    assert.equal(star.status, 403);
    assert.match(star.body.error.message, /content:write/);

    const readOnly = await keyWith(['content']);
    assert.equal(
      (await send('post', '/entries/post', { title: 'R' }, readOnly.secret)).status,
      403,
    );
  });

  test('create a draft with a key: it is a draft, attributed to the key, and not on the site', async () => {
    await setApi(true);
    const k = await keyWith(['content:write']);
    const r = await send(
      'post',
      '/entries/post',
      {
        title: 'From the API',
        data: { body: { blocks: [{ type: 'paragraph', data: { text: 'hi' } }] } },
      },
      k.secret,
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.item.status, 'draft');
    assert.equal(r.body.data.item.title, 'From the API');
    assert.equal(r.headers['cache-control'], 'no-store');
    const row = await node.ctx.db('entries').where({ id: r.body.data.item.id }).first();
    assert.equal(row.author_id, null);
    assert.equal(
      (await v1('/content/post')).body.data.some((p) => p.title === 'From the API'),
      false,
    );
    const audit = JSON.stringify(await node.ctx.audit.list({ limit: 50 }));
    assert.match(audit, /api-key:test/);
    assert.ok(!audit.includes(k.secret));
  });

  test('a write cannot publish: status in the body is not accepted, and bad input is a 422', async () => {
    const k = await keyWith(['content:write']);
    const pub = await send(
      'post',
      '/entries/post',
      { title: 'Sneaky', status: 'published' },
      k.secret,
    );
    assert.equal(pub.status, 422);
    const empty = await send('post', '/entries/post', { title: '' }, k.secret);
    assert.equal(empty.status, 422);
    const unknown = await send('post', '/entries/nothing', { title: 'x' }, k.secret);
    assert.ok([404, 422].includes(unknown.status));
  });

  test('update only a draft the API created; anything else is refused', async () => {
    const k = await keyWith(['content:write']);
    const made = await send('post', '/entries/post', { title: 'Draft one' }, k.secret);
    const id = made.body.data.item.id;
    const up = await send('put', `/entries/post/${id}`, { title: 'Draft one, edited' }, k.secret);
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.data.item.title, 'Draft one, edited');
    assert.equal(up.body.data.item.status, 'draft');

    // A published entry written by a person, and a draft written by a person, are not the API's to change.
    const refused = await send('put', `/entries/post/${post.id}`, { title: 'Hijack' }, k.secret);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'not_editable');
    assert.equal((await node.ctx.content.get(post.id)).title, 'Hello API');

    // Once a person publishes it, the API can no longer touch it.
    await node.ctx.content.update(id, { status: 'published' }, null);
    assert.equal(
      (await send('put', `/entries/post/${id}`, { title: 'Late' }, k.secret)).status,
      403,
    );
    assert.equal((await send('put', '/entries/post/999999', { title: 'x' }, k.secret)).status, 404);
  });

  test('the contact form works for anyone while the public API is on, with its own limit and a honeypot', async () => {
    await node.ctx.settings.update('site', { values: { contact_enabled: true } });
    await setApi(false);
    const off = await send('post', '/contact', {
      name: 'A',
      email: 'a@example.com',
      message: 'Hi',
    });
    assert.equal(off.status, 401);
    await setApi(true);
    const ok = await send('post', '/contact', {
      name: 'Ann',
      email: 'ann@example.com',
      message: 'Hello there',
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data, { received: true });
    const stored = await node.ctx
      .db('contact_messages')
      .where({ email: 'ann@example.com' })
      .first();
    assert.equal(stored.message, 'Hello there');

    const trap = await send('post', '/contact', {
      name: 'Bot',
      email: 'b@example.com',
      message: 'x',
      website: 'http://spam',
    });
    assert.equal(trap.status, 201);
    assert.equal(
      await node.ctx.db('contact_messages').where({ email: 'b@example.com' }).first(),
      undefined,
    );

    const bad = await send('post', '/contact', { name: 'A', email: 'not-an-email', message: 'x' });
    assert.equal(bad.status, 422);
    const links = await send('post', '/contact', {
      name: 'A',
      email: 'a@example.com',
      message: 'http://a.test http://b.test http://c.test http://d.test',
    });
    assert.equal(links.status, 422);
  });

  test('the contact form is off when the site’s contact form is off', async () => {
    await node.ctx.settings.update('site', { values: { contact_enabled: false } });
    const r = await send('post', '/contact', { name: 'A', email: 'a@example.com', message: 'Hi' });
    assert.equal(r.status, 404);
    await node.ctx.settings.update('site', { values: { contact_enabled: true } });
  });

  test('the key form accepts <module>:write scopes and nothing invented', async () => {
    assert.equal(
      (await admin.post('/api/admin/api-keys').send({ name: 'w', scopes: ['content:write'] }))
        .status,
      201,
    );
    assert.equal(
      (await admin.post('/api/admin/api-keys').send({ name: 'w', scopes: ['users:write'] })).status,
      422,
    );
    assert.equal(
      (await admin.post('/api/admin/api-keys').send({ name: 'w', scopes: ['site:write'] })).status,
      422,
    ); // contact is anonymous
  });

  test('the OpenAPI document describes the request body and the success status of a write', async () => {
    const doc = (await v1('/openapi.json')).body;
    const create = doc.paths['/entries/{type}'].post;
    assert.ok(create.requestBody.content['application/json'].schema.properties.title);
    assert.ok(create.responses[201]);
    assert.ok(doc.paths['/entries/{type}/{id}'].put);
    const contact = doc.paths['/contact'].post;
    assert.ok(contact.security.some((s) => Object.keys(s).length === 0)); // anonymous allowed
    assert.ok(!doc.paths['/entries/{type}'].post.security.some((s) => Object.keys(s).length === 0));
  });
});
