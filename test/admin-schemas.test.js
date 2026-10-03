import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import { adminCoverage } from '../src/core/api/openapi.js';

let node, admin, spec;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  await admin.post('/api/admin/api-keys').send({ name: 'k', scopes: ['content'] });
  await admin.post('/api/admin/seo/rules').send({ pattern: '/schema-test', title: 'T' });
  spec = (await admin.get('/api/admin/api-reference/openapi.json?surface=admin')).body;
});
after(() => node.close());

const routes = () =>
  node.ctx.modules.ids().flatMap((id) => node.ctx.modules.routesOf(id).map((r) => ({ id, ...r })));

describe('admin route schemas (D-070)', () => {
  test('the document carries request bodies, query and path parameters from the schemas the routes validate with', () => {
    const rule = spec.paths['/admin/seo/rules'].post;
    assert.equal(rule.requestBody.content['application/json'].schema.type, 'object');
    assert.ok(rule.requestBody.content['application/json'].schema.properties.pattern);
    assert.ok(rule.responses[201].content['application/json']);
    assert.equal(rule['x-documented'].request, true);

    const keys = spec.paths['/admin/api-keys/{id}'].put;
    assert.equal(keys.parameters.find((p) => p.name === 'id').schema.type, 'integer');
    assert.ok(keys.requestBody.content['application/json'].schema.properties.scopes);

    const hook = spec.paths['/admin/webhooks'].post.requestBody.content['application/json'].schema;
    assert.ok(hook.properties.url);
  });

  test('a route that declares nothing says so instead of pretending', () => {
    const plain =
      spec.paths['/admin/audit']?.get ?? Object.values(spec.paths['/admin/audit'] ?? {})[0];
    if (plain) assert.match(plain.responses[200].description, /not described/);
  });

  test('every declared schema becomes a JSON Schema, never an empty one', () => {
    let n = 0;
    for (const item of Object.values(spec.paths))
      for (const op of Object.values(item))
        for (const media of [op.requestBody?.content?.['application/json']].filter(Boolean)) {
          n++;
          assert.ok(Object.keys(media.schema).length > 0, op.operationId);
        }
    assert.ok(n >= 25, `expected at least 25 documented request bodies, found ${n}`);
  });

  test('the share of routes with a schema is reported, and is large enough to mean something', () => {
    const c = adminCoverage({
      routesOf: (id) => node.ctx.modules.routesOf(id),
      ids: node.ctx.modules.ids(),
    });
    assert.ok(c.routes > 150);
    assert.ok(c.withRequestSchema >= 25, JSON.stringify(c));
    assert.ok(c.withResponseSchema >= 6, JSON.stringify(c));
    const ref = c;
    return admin
      .get('/api/admin/api-reference')
      .then((r) => assert.deepEqual(r.body.adminCoverage, ref));
  });

  test('declared response schemas match what the routes really answer', async () => {
    let checked = 0;
    for (const r of routes()) {
      if (!r.docs?.response || r.method !== 'GET' || /[:*]/.test(r.path)) continue;
      const res = await admin.get(`/api/admin${r.path}`);
      assert.equal(res.status, 200, r.path);
      const parsed = r.docs.response.safeParse(res.body);
      assert.ok(
        parsed.success,
        `${r.path}: ${parsed.error?.issues?.[0]?.path?.join('.')} ${parsed.error?.issues?.[0]?.message}`,
      );
      checked++;
    }
    assert.ok(checked >= 4, `only ${checked} response schemas were checked`);
  });

  test('a request schema accepts what the admin screens send and rejects what the handler rejects', async () => {
    const seoPost = routes().find((r) => r.method === 'POST' && r.path === '/seo/rules');
    assert.ok(seoPost.docs.body.safeParse({ pattern: '/ok' }).success);
    assert.equal(seoPost.docs.body.safeParse({ pattern: 'no-slash' }).success, false);
    assert.equal(
      (await admin.post('/api/admin/seo/rules').send({ pattern: 'no-slash' })).status,
      422,
    );
  });

  test('docs() changes nothing at run time', async () => {
    const r = await admin.post('/api/admin/api-keys').send({ name: '', scopes: ['*'] });
    assert.equal(r.status, 422);
    assert.equal((await admin.get('/api/admin/seo/rules')).status, 200);
  });
});
