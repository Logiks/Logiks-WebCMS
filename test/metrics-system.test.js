import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn, until } from './helpers.js';

let node, admin;
const TOKEN = 'a-long-random-metrics-token-1234567890';

before(async () => {
  node = await makeNode({ env: { JOB_BACKOFF_MS: '10' } });
  admin = await signedIn(node.app);
});
after(async () => node.close());

test('/metrics is off by default, needs a token once enabled, and rejects wrong ones', async () => {
  assert.equal((await request(node.app).get('/metrics')).status, 404);

  await admin.put('/api/admin/settings/system').send({ values: { metrics_enabled: true } });
  const noToken = await request(node.app).get('/metrics');
  assert.equal(noToken.status, 503);
  assert.match(noToken.body.error.message, /token/);

  await admin.put('/api/admin/settings/system').send({ values: { metrics_token: TOKEN } });
  assert.equal((await request(node.app).get('/metrics')).status, 401);
  assert.equal(
    (await request(node.app).get('/metrics').set('Authorization', 'Bearer nope')).status,
    401,
  );
  assert.equal(
    (await request(node.app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`)).status,
    200,
  );
});

test('exposes app, queue, cache, pool and process metrics in Prometheus format', async () => {
  await request(node.app).get('/api/public/info'); // some traffic
  await node.ctx.cache.wrap('m', async () => 1);
  await node.ctx.cache.wrap('m', async () => 1);
  const res = await request(node.app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
  assert.match(res.headers['content-type'], /text\/plain/);
  for (const name of [
    'cms_http_request_duration_seconds_bucket',
    'cms_config_version',
    'cms_node_draining{role="all"} 0',
    'cms_db_pool_connections{state="used"',
    'cms_cache_requests_total{result="l1_hit"',
    'cms_queue_jobs{state="waiting"',
    'cms_auth_logins_total{result="success"',
    'cms_build_info{version=',
    'cms_process_cpu_user_seconds_total',
    'cms_nodejs_eventloop_lag_seconds',
  ])
    assert.ok(res.text.includes(name), `missing ${name}`);
  assert.match(res.text, /cms_cache_requests_total\{result="l1_hit",role="all"\} [1-9]/);
});

test('labels stay low-cardinality and secrets never appear', async () => {
  const [users, roles] = [(await admin.get('/api/admin/users')).body.users, 1];
  await admin.get(`/api/admin/users/${users[0].id}`); // 404 route but still an id-shaped path
  await request(node.app).get('/api/admin/users/98765');
  await admin
    .put('/api/admin/settings/mail')
    .send({ values: { password: 'hunter2-metric-secret' } });
  const text = (await request(node.app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`))
    .text;
  assert.ok(!text.includes('98765'), 'ids must not become label values');
  assert.match(text, /route="\/api\/admin\/users\/:id"/);
  assert.ok(!text.includes('hunter2-metric-secret'));
  assert.ok(!text.includes(TOKEN));
  assert.ok(!/route="\/metrics"|route="\/healthz"/.test(text), 'probes and scrapes are not timed');
  assert.ok(roles);
});

test('login outcomes and settings sync are counted', async () => {
  const before = (await request(node.app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`))
    .text;
  const agent = request.agent(node.app);
  const { body } = await agent.get('/api/auth/csrf');
  await agent
    .post('/api/auth/login')
    .set('x-csrf-token', body.csrfToken)
    .send({ email: 'admin@example.com', password: 'wrong-wrong-wrong' });
  const after = (await request(node.app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`))
    .text;
  const n = (t) =>
    Number(/cms_auth_logins_total\{result="failure",role="all"\} (\d+)/.exec(t)?.[1] ?? 0);
  assert.equal(n(after), n(before) + 1);
  assert.match(after, /cms_settings_events_total\{kind="bus_applied"/);
});

test('admin System screen: component health, cache and queue in one call', async () => {
  const r = await admin.get('/api/admin/system');
  assert.equal(r.status, 200);
  const c = r.body.components;
  assert.equal(c.database.ok, true);
  assert.equal(c.database.kind, node.ctx.dialect.kind);
  assert.equal(c.redis, null);
  assert.equal(c.queue.driver, 'local');
  assert.ok(Array.isArray(c.queue.scheduled) && c.queue.scheduled.length >= 4);
  assert.equal(c.mail.enabled, false);
  assert.equal(r.body.cache.backend, 'memory');
  assert.ok(r.body.uptimeSeconds >= 0 && r.body.process.rssMb > 0);
});

test('flushing the cache needs its own permission and is audited', async () => {
  await node.ctx.cache.set('keep', 'me');
  const viewerRole = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
  await node.ctx.users.createUser(
    {
      email: 'v3@example.com',
      name: 'V3',
      password: 'Viewer-three-pass1',
      roleId: Number(viewerRole.id),
    },
    null,
  );
  const v = await signedIn(node.app, { email: 'v3@example.com', password: 'Viewer-three-pass1' });
  assert.equal((await v.get('/api/admin/system')).status, 200, 'viewers can look');
  assert.equal((await v.post('/api/admin/system/cache/flush')).status, 403, 'but not flush');
  assert.equal(await node.ctx.cache.get('keep'), 'me');

  assert.equal((await admin.post('/api/admin/system/cache/flush')).status, 200);
  assert.equal(await node.ctx.cache.get('keep'), undefined);
  assert.ok(
    (await admin.get('/api/admin/audit?action=cache')).body.entries.some(
      (e) => e.action === 'cache.flush',
    ),
  );
});

test('failed background jobs are listed, can be retried or discarded, and need jobs.manage', async () => {
  let attempts = 0;
  let healthy = false;
  node.ctx.jobs.define('test.flaky', async () => {
    attempts++;
    if (!healthy) throw new Error('downstream is down');
  });
  await node.ctx.jobs.enqueue('test.flaky', { secret: 'personal-data' });
  const failed = await until(
    async () => {
      const r = await admin.get('/api/admin/system/jobs/failed');
      return r.body.jobs.length ? r.body.jobs : null;
    },
    { timeout: 4000 },
  );
  assert.equal(attempts, 3, 'three attempts with backoff');
  assert.equal(failed[0].name, 'test.flaky');
  assert.match(failed[0].failedReason, /downstream is down/);
  assert.ok(!JSON.stringify(failed).includes('personal-data'), 'job payloads are never returned');

  const viewer = await signedIn(node.app, {
    email: 'v3@example.com',
    password: 'Viewer-three-pass1',
  });
  assert.equal((await viewer.post(`/api/admin/system/jobs/${failed[0].id}/retry`)).status, 403);

  healthy = true;
  assert.equal((await admin.post(`/api/admin/system/jobs/${failed[0].id}/retry`)).status, 200);
  await until(
    async () => (await admin.get('/api/admin/system/jobs/failed')).body.jobs.length === 0,
  );

  healthy = false;
  await node.ctx.jobs.enqueue('test.flaky', {});
  const again = await until(
    async () => (await admin.get('/api/admin/system/jobs/failed')).body.jobs[0],
    { timeout: 4000 },
  );
  assert.equal((await admin.delete(`/api/admin/system/jobs/${again.id}`)).status, 204);
  assert.equal((await admin.get('/api/admin/system/jobs/failed')).body.jobs.length, 0);
  assert.equal((await admin.post('/api/admin/system/jobs/424242/retry')).status, 404);
});
