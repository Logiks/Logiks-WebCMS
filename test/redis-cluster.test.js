import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Redis } from 'ioredis';
import { makeNode, tmpDbUrl, ADMIN, until } from './helpers.js';

// Runs only when a real Redis is available:  REDIS_URL=redis://127.0.0.1:6379/15 npm test
const REDIS_URL = process.env.TEST_REDIS_URL;
const skip = !REDIS_URL && 'set TEST_REDIS_URL to run cluster tests against a real Redis';

let a, b, admin;
before(async () => {
  if (skip) return;
  admin = new Redis(REDIS_URL);
  await admin.flushdb();
  const { url } = tmpDbUrl();
  a = await makeNode({ dbUrl: url, env: { REDIS_URL } });
  b = await makeNode({ dbUrl: url, env: { REDIS_URL } });
});
after(async () => {
  if (skip) return;
  await a.close();
  await b.close();
  await admin.quit();
});

test('nodes use Redis for bus, sessions and jobs', { skip }, () => {
  for (const n of [a, b]) {
    assert.equal(n.ctx.bus.kind, 'redis');
    assert.equal(n.ctx.sessionStore.kind, 'redis');
    assert.equal(n.ctx.jobs.kind, 'bullmq');
  }
});

test('settings saved on node A are applied by node B over Redis pub/sub', { skip }, async () => {
  let fired = 0;
  b.ctx.settings.onChange('general', () => fired++);
  await a.ctx.settings.update('general', { values: { site_name: 'Over Redis' } });
  await until(() => b.ctx.settings.get('general.site_name') === 'Over Redis');
  assert.equal(b.ctx.settings.version, a.ctx.settings.version);
  assert.equal(fired, 1);
  assert.equal(b.ctx.settings.stats.pollHeals, 0);
});

test(
  'no sticky sessions: sign in on node A, keep using the session on node B',
  { skip },
  async () => {
    const agent = request.agent(a.app);
    const { body } = await agent.get('/api/auth/csrf');
    const login = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', body.csrfToken)
      .send(ADMIN);
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');

    const onB = await request(b.app).get('/api/auth/me').set('Cookie', cookie);
    assert.equal(onB.status, 200);
    assert.equal(onB.body.user.email, ADMIN.email);

    // CSRF tokens issued by A validate on B (shared secret, session-bound HMAC)
    const put = await request(b.app)
      .put('/api/admin/settings/general')
      .set('Cookie', cookie)
      .set('x-csrf-token', login.body.csrfToken)
      .send({ values: { tagline: 'written via B' } });
    assert.equal(put.status, 200);
    await until(() => a.ctx.settings.get('general.tagline') === 'written via B');
  },
);

test(
  'a role change on node A revokes access on node B immediately (rbac bus)',
  { skip },
  async () => {
    const role = await a.ctx.users.createRole(
      { name: 'Auditor', permissions: ['admin.access', 'audit.read'] },
      null,
    );
    await a.ctx.users.createUser(
      { email: 'aud@example.com', name: 'Aud', password: 'Auditor-pass-123', roleId: role.id },
      null,
    );

    const agent = request.agent(b.app);
    const { body } = await agent.get('/api/auth/csrf');
    await agent
      .post('/api/auth/login')
      .set('x-csrf-token', body.csrfToken)
      .send({ email: 'aud@example.com', password: 'Auditor-pass-123' });
    assert.equal((await agent.get('/api/admin/audit')).status, 200); // B caches the principal

    await a.ctx.users.updateRole(role.id, { permissions: ['admin.access'] }, null);
    await until(async () => (await agent.get('/api/admin/audit')).status === 403);
  },
);

test('rate limits are counted cluster-wide, not per node', { skip }, async () => {
  await a.ctx.settings.update('security', { values: { rate_limit_per_minute: 10 } });
  await until(() => b.ctx.settings.get('security.rate_limit_per_minute') === 10);
  await admin.keys('cms:rl:api:*').then((k) => k.length && admin.del(...k));

  let blocked = 0;
  for (let i = 0; i < 8; i++) await request(a.app).get('/api/public/info');
  for (let i = 0; i < 8; i++)
    if ((await request(b.app).get('/api/public/info')).status === 429) blocked++;
  assert.ok(blocked > 0, 'node B should be throttled by requests that hit node A');
});

test(
  'heartbeats: every node appears in the cluster view and reports its config version',
  { skip },
  async () => {
    await a.ctx.nodes.start();
    await b.ctx.nodes.start();
    const view = await a.ctx.nodes.list();
    assert.equal(view.nodes.length, 2);
    await until(async () => (await a.ctx.nodes.list()).nodes.every((n) => !n.drift));
  },
);

test(
  'jobs: schedules registered by two workers stay single; each job runs exactly once',
  { skip },
  async () => {
    const ran = [];
    for (const [name, n] of [
      ['A', a],
      ['B', b],
    ])
      n.ctx.jobs.define('test.echo', async (d) => {
        ran.push([name, d.i]);
      });
    await a.ctx.jobs.startWorker();
    await b.ctx.jobs.startWorker();

    const schedulers = await admin.zcard('cms:bull:cms-default:repeat');
    // one entry per built-in schedule (sessions, audit, nodes, auth cleanup, content publishing), however many workers registered them
    assert.equal(schedulers, 5, 'built-in schedules must not be duplicated by the second worker');

    for (let i = 0; i < 6; i++) await a.ctx.jobs.enqueue('test.echo', { i });
    await until(() => ran.length >= 6);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ran.length, 6);
    assert.deepEqual([...new Set(ran.map(([, i]) => i))].sort(), [0, 1, 2, 3, 4, 5]);
  },
);
