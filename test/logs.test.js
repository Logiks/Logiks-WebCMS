import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const DAY = 86_400_000;

test('the log manager lists every log with its size and how long it is kept', async () => {
  const res = await admin.get('/api/admin/logs');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.logs.map((l) => l.id),
    ['audit', 'events', 'webhooks', 'activity', 'ai'],
  );
  assert.ok(res.body.logs.every((l) => Number.isInteger(l.retentionDays)));
});

test('a manual prune removes only entries older than the age given, and is itself audited', async () => {
  const old = Date.now() - 40 * DAY;
  await node.ctx.db('events_log').insert([
    { name: 'a.old', payload: '{}', created_at: old },
    { name: 'a.new', payload: '{}', created_at: Date.now() },
  ]);
  const r = await admin.post('/api/admin/logs/events/prune').send({ days: 30 });
  assert.equal(r.body.deleted, 1);
  const names = (await node.ctx.db('events_log').select('name')).map((x) => x.name);
  assert.ok(names.includes('a.new') && !names.includes('a.old'));
  const log = await node.ctx.db('audit_logs').where({ action: 'logs.prune' }).first();
  assert.equal(JSON.parse(log.meta).deleted, 1);
});

test('days = 0 empties a log, and the viewer shows what is left', async () => {
  await node.ctx.aiUsage.record({
    provider: 'openai',
    model: 'm',
    feature: 'media-generator',
    units: 1,
  });
  const seen = await admin.get('/api/admin/logs/ai');
  assert.equal(seen.body.rows.length, 1);
  assert.equal((await admin.post('/api/admin/logs/ai/prune').send({ days: 0 })).body.deleted, 1);
  assert.equal((await admin.get('/api/admin/logs/ai')).body.rows.length, 0);
});

test('retention is the setting the nightly job reads; logs that cannot be kept forever refuse 0', async () => {
  const ok = await admin.put('/api/admin/logs/events/retention').send({ days: 7 });
  assert.equal(ok.status, 200);
  assert.equal(node.ctx.settings.get('automation.events_retention_days'), 7);
  assert.equal((await admin.put('/api/admin/logs/events/retention').send({ days: 0 })).status, 422);
  assert.equal((await admin.put('/api/admin/logs/audit/retention').send({ days: 0 })).status, 200);
});

test('only someone with logs.manage can see or prune logs', async () => {
  const anon = await fetch(`${node.url}/api/admin/logs`);
  assert.ok([401, 403].includes(anon.status));
  assert.equal((await admin.post('/api/admin/logs/nope/prune').send({ days: 1 })).status, 404);
});
