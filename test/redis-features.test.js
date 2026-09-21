import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Redis } from 'ioredis';
import {
  makeNode,
  tmpDb,
  signedIn,
  startSmtp,
  configureMail,
  ADMIN,
  until,
  sleep,
} from './helpers.js';

// Needs a real Redis:  TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test
const REDIS_URL = process.env.TEST_REDIS_URL;
const skip = !REDIS_URL && 'set TEST_REDIS_URL to run these against a real Redis';

let a, b, db, admin, smtp;
before(async () => {
  if (skip) return;
  admin = new Redis(REDIS_URL);
  await admin.flushdb();
  smtp = await startSmtp();
  db = tmpDb();
  const env = { REDIS_URL, JOB_BACKOFF_MS: '20' };
  a = await makeNode({ dbUrl: db.url, env: { ...env, ROLE: 'web' } }); // web node: enqueues only
  b = await makeNode({ dbUrl: db.url, env: { ...env, ROLE: 'worker' } }); // worker node: processes the queue
  await b.ctx.jobs.startWorker();
});
after(async () => {
  if (skip) return;
  await a.close();
  await b.close();
  await smtp.close();
  await admin.quit();
});

test(
  'cache: L2 in Redis is shared, and tag invalidation on one node empties the others at once',
  { skip },
  async () => {
    assert.equal(a.ctx.cache.stats().backend, 'redis');
    await a.ctx.cache.set('page:home', { html: '<h1>hi</h1>' }, { tags: ['pages', 'page:home'] });
    assert.deepEqual(await b.ctx.cache.get('page:home'), { html: '<h1>hi</h1>' });
    assert.equal(b.ctx.cache.stats().l2Hits, 1, 'B found it in Redis, not in its own memory');
    assert.deepEqual(await b.ctx.cache.get('page:home'), { html: '<h1>hi</h1>' });
    assert.equal(b.ctx.cache.stats().l1Hits, 1, 'and now serves it from memory');

    await a.ctx.cache.invalidate(['page:home']);
    await until(async () => (await b.ctx.cache.get('page:home')) === undefined, { timeout: 500 });
    assert.equal(await a.ctx.cache.get('page:home'), undefined);
  },
);

test(
  'cache: a single computation is shared cluster-wide via Redis; flush clears every node',
  { skip },
  async () => {
    let loads = 0;
    const load = async () => ({ n: ++loads });
    await a.ctx.cache.wrap('shared', load, { tags: ['x'] });
    assert.deepEqual(await b.ctx.cache.wrap('shared', load, { tags: ['x'] }), { n: 1 });
    assert.equal(loads, 1);

    const s = await signedIn(a.app);
    assert.equal((await s.post('/api/admin/system/cache/flush')).status, 200);
    await until(async () => (await b.ctx.cache.get('shared')) === undefined, { timeout: 500 });
  },
);

test(
  'cache: if a bus message is lost, staleness is bounded by the tag refresh window',
  { skip },
  async () => {
    await a.ctx.cache.set('bounded', 'old', { tags: ['t'] });
    assert.equal(await b.ctx.cache.get('bounded'), 'old'); // B now holds it in memory
    const sub = b.ctx.bus.sub; // simulate B missing every pub/sub message
    await sub.unsubscribe();
    await a.ctx.cache.invalidate(['t']);
    await sleep(100);
    assert.equal(await b.ctx.cache.get('bounded'), 'old', 'B has not heard about it yet');
    await until(async () => (await b.ctx.cache.get('bounded')) === undefined, { timeout: 4000 });
    await sub.subscribe(
      'cms:bus:cache:tags',
      'cms:bus:cache:del',
      'cms:bus:cfg:changed',
      'cms:bus:rbac:changed',
    );
  },
);

test('sessions: listing and revoking work across nodes (Redis-backed)', { skip }, async () => {
  const onA = await signedIn(a.app);
  const onB = await signedIn(b.app);
  const list = (await onA.get('/api/auth/sessions')).body.sessions;
  assert.equal(list.length >= 2, true, 'A sees the session that was created on B');
  const bHandle = (await onB.get('/api/auth/sessions')).body.sessions.find((x) => x.current).id;
  assert.equal((await onA.del(`/api/auth/sessions/${bHandle}`)).status, 204);
  assert.equal((await onB.get('/api/auth/me')).status, 401);
  assert.equal((await onA.get('/api/auth/me')).status, 200);
});

test(
  'queue: a web-only node enqueues, a separate worker node delivers the email',
  { skip },
  async () => {
    await configureMail(a.ctx, smtp);
    await until(() => b.ctx.settings.get('mail.transport') === 'smtp');
    assert.equal(a.ctx.jobs.kind, 'bullmq');

    const agent = request.agent(a.app);
    const { body } = await agent.get('/api/auth/csrf');
    await agent
      .post('/api/auth/forgot')
      .set('x-csrf-token', body.csrfToken)
      .send({ email: ADMIN.email });
    await until(() => smtp.messages.some((m) => /Reset your/.test(m.subject)), { timeout: 5000 });
    assert.match(smtp.messages.at(-1).text, /#\/reset\//);

    // the job payload sitting in Redis is sealed
    const keys = await admin.keys('cms:bull:cms-default:*');
    const dump = JSON.stringify(
      await Promise.all(
        keys.map(async (k) => ((await admin.type(k)) === 'hash' ? admin.hgetall(k) : null)),
      ),
    );
    assert.ok(!dump.includes(ADMIN.email), 'no recipient address readable in Redis');
  },
);

test('queue: stats, failed listing, retry and discard work against BullMQ', { skip }, async () => {
  let healthy = false;
  for (const n of [a, b])
    n.ctx.jobs.define('test.redis-flaky', async () => {
      if (!healthy) throw new Error('nope');
    });
  await a.ctx.jobs.enqueue('test.redis-flaky', { pii: 'x' });
  const failed = await until(
    async () => {
      const f = await a.ctx.jobs.failed();
      return f.length ? f : null;
    },
    { timeout: 5000 },
  );
  assert.equal(failed[0].attemptsMade, 3);
  assert.equal((await a.ctx.jobs.stats()).counts.failed >= 1, true);
  assert.equal((await a.ctx.jobs.stats()).driver, 'bullmq');
  assert.ok(!JSON.stringify(failed).includes('pii'));

  healthy = true;
  assert.equal(await a.ctx.jobs.retry(failed[0].id), true);
  await until(async () => (await a.ctx.jobs.failed()).length === 0, { timeout: 5000 });

  healthy = false;
  await a.ctx.jobs.enqueue('test.redis-flaky', {});
  const again = await until(async () => (await a.ctx.jobs.failed())[0], { timeout: 5000 });
  assert.equal(await a.ctx.jobs.discard(again.id), true);
  assert.equal((await a.ctx.jobs.failed()).length, 0);
});

test('metrics: queue depth comes from Redis and is visible from any node', { skip }, async () => {
  const s = await signedIn(a.app);
  await s
    .put('/api/admin/settings/system')
    .send({ values: { metrics_enabled: true, metrics_token: 'redis-metrics-token-123456' } });
  await until(() => b.ctx.settings.get('system.metrics_enabled') === true);
  const res = await request(b.app)
    .get('/metrics')
    .set('Authorization', 'Bearer redis-metrics-token-123456');
  assert.equal(res.status, 200);
  assert.match(res.text, /cms_queue_jobs\{state="completed",role="worker"\} \d+/);
  assert.match(
    res.text,
    /cms_mail_total\{result="sent",role="worker"\} [1-9]/,
    'the worker node did the sending',
  );
});
