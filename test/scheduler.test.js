import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeNode, signedIn, tmpDb, until } from './helpers.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const mkUser = async (perms, email) => {
  const role = await node.ctx.users.createRole(
    { name: `r-${email}`, description: '', permissions: perms },
    null,
  );
  await node.ctx.users.createUser(
    { email, name: email, password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  return signedIn(node.app, { email, password: 'Some-long-pass-12' });
};

const mkService = (over = {}) => ({
  slug: `sched-svc-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Scheduled service',
  mode: 'query',
  enabled: true,
  config: { type: 'post', sort: 'newest', perPage: { default: 5, max: 10 } },
  ...over,
});

describe('Scheduler: CRUD, validation and permissions', () => {
  test('scheduler.write creates, updates and deletes; scheduler.read alone can only view', async () => {
    const reader = await mkUser(['admin.access', 'scheduler.read'], 'sched-reader@example.com');
    const writer = await mkUser(
      ['admin.access', 'scheduler.read', 'scheduler.write', 'services.read', 'services.write'],
      'sched-writer@example.com',
    );
    const svcSlug = (await writer.post('/api/admin/services').send(mkService())).body.slug;

    const denied = await reader.post('/api/admin/scheduler/tasks').send({ name: 'x' });
    assert.equal(denied.status, 403);

    const created = await writer.post('/api/admin/scheduler/tasks').send({
      name: 'Nightly run',
      kind: 'service',
      target: svcSlug,
      scheduleType: 'interval',
      everyMs: 3_600_000,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.task.id;

    const listed = await reader.get('/api/admin/scheduler/tasks');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.tasks.some((t) => t.id === id));

    const updated = await writer.put(`/api/admin/scheduler/tasks/${id}`).send({
      name: 'Renamed',
      kind: 'service',
      target: svcSlug,
      scheduleType: 'interval',
      everyMs: 3_600_000,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.task.name, 'Renamed');

    assert.equal((await reader.delete(`/api/admin/scheduler/tasks/${id}`)).status, 403);
    assert.equal((await writer.delete(`/api/admin/scheduler/tasks/${id}`)).status, 204);
  });

  test('the target must actually exist', async () => {
    const bad = await admin.post('/api/admin/scheduler/tasks').send({
      name: 'x',
      kind: 'service',
      target: 'no-such-service',
      scheduleType: 'interval',
      everyMs: 3_600_000,
    });
    assert.equal(bad.status, 422);
    assert.match(bad.body.error.message, /no-such-service/);
  });

  test('the schedule fields must match the chosen schedule type', async () => {
    const svc = await admin.post('/api/admin/services').send(mkService());
    const missingEvery = await admin.post('/api/admin/scheduler/tasks').send({
      name: 'x',
      kind: 'service',
      target: svc.body.slug,
      scheduleType: 'interval',
    });
    assert.equal(missingEvery.status, 422);

    const badCron = await admin.post('/api/admin/scheduler/tasks').send({
      name: 'x',
      kind: 'service',
      target: svc.body.slug,
      scheduleType: 'cron',
      cronExpr: 'not a cron expression',
    });
    assert.equal(badCron.status, 422);
  });

  test('an interval must be at least a minute', async () => {
    const svc = await admin.post('/api/admin/services').send(mkService());
    const tooFast = await admin.post('/api/admin/scheduler/tasks').send({
      name: 'x',
      kind: 'service',
      target: svc.body.slug,
      scheduleType: 'interval',
      everyMs: 500,
    });
    assert.equal(tooFast.status, 422);
  });

  test('cron-preview reports the next few run times, or an error for a bad expression', async () => {
    const ok = await admin.get(
      '/api/admin/scheduler/cron-preview?expr=' + encodeURIComponent('0 * * * *'),
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.next.length, 3);
    const bad = await admin.get('/api/admin/scheduler/cron-preview?expr=nonsense');
    assert.ok(bad.body.error);
  });
});

describe('Scheduler: execution', () => {
  test('"Run now" against a Service records last_status "ok"', async () => {
    const svc = await admin.post('/api/admin/services').send(mkService());
    const task = await admin.post('/api/admin/scheduler/tasks').send({
      name: 'Run now service',
      kind: 'service',
      target: svc.body.slug,
      scheduleType: 'interval',
      everyMs: 3_600_000,
    });
    const id = task.body.task.id;
    const fired = await admin.post(`/api/admin/scheduler/tasks/${id}/run`);
    assert.equal(fired.status, 202);
    await until(
      async () => (await admin.get(`/api/admin/scheduler/tasks/${id}`)).body.task.lastStatus,
    );
    const after_ = (await admin.get(`/api/admin/scheduler/tasks/${id}`)).body.task;
    assert.equal(after_.lastStatus, 'ok');
    assert.ok(after_.lastRunAt);
  });

  test('"Run now" against a disabled Service records last_status "error"', async () => {
    const svc = await admin.post('/api/admin/services').send(mkService({ enabled: false }));
    const task = await admin.post('/api/admin/scheduler/tasks').send({
      name: 'Run now disabled service',
      kind: 'service',
      target: svc.body.slug,
      scheduleType: 'interval',
      everyMs: 3_600_000,
    });
    const id = task.body.task.id;
    await admin.post(`/api/admin/scheduler/tasks/${id}/run`);
    await until(
      async () => (await admin.get(`/api/admin/scheduler/tasks/${id}`)).body.task.lastStatus,
    );
    const after_ = (await admin.get(`/api/admin/scheduler/tasks/${id}`)).body.task;
    assert.equal(after_.lastStatus, 'error');
    assert.match(after_.lastError, /disabled/);
  });

  test('a scheduled task targeting a Webhook delivers to it, with the task’s own params as the payload', async () => {
    const received = [];
    const receiver = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${receiver.address().port}/hook`;
    const webhook = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'Scheduler target', event: 'never.matches', url });
    const task = await admin.post('/api/admin/scheduler/tasks').send({
      name: 'Run now webhook',
      kind: 'webhook',
      target: String(webhook.body.webhook.id),
      scheduleType: 'interval',
      everyMs: 3_600_000,
      params: { hello: 'from the scheduler' },
    });
    await admin.post(`/api/admin/scheduler/tasks/${task.body.task.id}/run`);
    await until(() => received.length > 0);
    const body = JSON.parse(received[received.length - 1]);
    assert.equal(body.event, 'scheduled');
    assert.deepEqual(body.payload, { hello: 'from the scheduler' });
    await new Promise((resolve) => receiver.close(resolve));
  });

  test('an enabled cron task actually recurs, and disabling it stops further runs', async () => {
    const svc = await admin.post('/api/admin/services').send(mkService());
    const task = await admin.post('/api/admin/scheduler/tasks').send({
      name: 'Cron recur',
      kind: 'service',
      target: svc.body.slug,
      scheduleType: 'cron',
      cronExpr: '* * * * * *', // every second
    });
    const id = task.body.task.id;
    await until(
      async () => (await admin.get(`/api/admin/scheduler/tasks/${id}`)).body.task.lastRunAt,
    );
    const first = (await admin.get(`/api/admin/scheduler/tasks/${id}`)).body.task.lastRunAt;
    await until(
      async () => (await admin.get(`/api/admin/scheduler/tasks/${id}`)).body.task.lastRunAt > first,
    );

    await admin.put(`/api/admin/scheduler/tasks/${id}`).send({
      name: 'Cron recur',
      kind: 'service',
      target: svc.body.slug,
      scheduleType: 'cron',
      cronExpr: '* * * * * *',
      enabled: false,
    });
    const stoppedAt = (await admin.get(`/api/admin/scheduler/tasks/${id}`)).body.task.lastRunAt;
    await new Promise((r) => setTimeout(r, 1500));
    const after_ = (await admin.get(`/api/admin/scheduler/tasks/${id}`)).body.task.lastRunAt;
    assert.equal(after_, stoppedAt, 'no further runs once disabled');
  });
});

describe('Scheduler: surviving a restart', () => {
  test('an enabled schedule is re-armed on boot (reloadAll), so it survives a process restart', async () => {
    const db = tmpDb();
    const a = await makeNode({ dbUrl: db.url });
    const aAdmin = await signedIn(a.app);
    const svc = (await aAdmin.post('/api/admin/services').send(mkService())).body;
    const task = await a.ctx.scheduler.create(
      {
        name: 'Survives restart',
        kind: 'service',
        target: svc.slug,
        scheduleType: 'cron',
        cronExpr: '* * * * * *',
      },
      null,
    );
    await until(async () => (await a.ctx.scheduler.get(task.id)).lastRunAt);
    await a.close();

    const b = await makeNode({ dbUrl: db.url });
    const beforeRestart = (await b.ctx.scheduler.get(task.id)).lastRunAt;
    await until(async () => (await b.ctx.scheduler.get(task.id)).lastRunAt > beforeRestart);
    await b.close();
    db.cleanup();
  });
});
