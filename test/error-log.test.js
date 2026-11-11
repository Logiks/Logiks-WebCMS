import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeNode, signedIn, until, loopback } from './helpers.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

test('an unhandled request error is stored without its query string, and the client still gets the normal reply', async () => {
  // A route that throws, mounted on a throwaway app that uses the real error handler and the node's error log.
  const { default: express } = await import('express');
  const { errorHandler } = await import('../src/core/http/errors.js');
  const app = express();
  app.get('/boom', () => {
    throw new TypeError('Cannot read properties of undefined (reading 7)');
  });
  app.use(
    errorHandler(node.ctx.log, true, (err, req, status) =>
      node.ctx.errorLog.record({ source: 'http', err, req, status }),
    ),
  );
  const srv = loopback(app);
  await once(srv, 'listening');
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/boom?token=secret123`);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.message, 'Something went wrong on our side.');
  await until(async () => Number((await node.ctx.db('error_log').count({ n: '*' }).first()).n) > 0);
  const row = await node.ctx.db('error_log').first();
  assert.equal(row.source, 'http');
  assert.equal(row.path, '/boom');
  assert.equal(row.status, 500);
  assert.ok(!JSON.stringify(row).includes('secret123'));
  srv.close();
});

test('the same error with different ids is one group, and the top list counts it', async () => {
  await node.ctx.db('error_log').del();
  for (const id of [11, 12, 13])
    await node.ctx.errorLog.record({
      source: 'job',
      job: 'x.y',
      err: new Error(`Row ${id} not found`),
    });
  await node.ctx.errorLog.record({
    source: 'job',
    job: 'x.y',
    err: new Error('Different problem'),
  });
  const res = await admin.get('/api/admin/logs/errors/top?days=7');
  assert.equal(res.status, 200);
  assert.equal(res.body.errors.length, 2);
  assert.equal(res.body.errors[0].count, 3);
  assert.match(res.body.errors[0].message, /^Row \d+ not found$/);
  assert.equal(res.body.errors[0].job, 'x.y');
});

test('a job that runs out of retries is logged once, not once per attempt', async () => {
  await node.ctx.db('error_log').del();
  node.ctx.jobs.define('test.always_fails', async () => {
    throw new Error('always fails');
  });
  await node.ctx.jobs.enqueue('test.always_fails', {});
  await until(
    async () => (await node.ctx.db('error_log').where({ job: 'test.always_fails' })).length > 0,
    { timeout: 15000 },
  );
  await new Promise((r) => setTimeout(r, 300));
  const rows = await node.ctx.db('error_log').where({ job: 'test.always_fails' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'job');
});

test('the log manager lists server errors and prunes them by age', async () => {
  await node.ctx.db('error_log').del();
  await node.ctx.db('error_log').insert({
    created_at: Date.now() - 90 * 86_400_000,
    fingerprint: 'old',
    source: 'http',
    message: 'old one',
  });
  await node.ctx.errorLog.record({ source: 'http', err: new Error('new one') });
  const rows = (await admin.get('/api/admin/logs/errors')).body.rows;
  assert.equal(rows.length, 2);
  assert.equal(
    (await admin.post('/api/admin/logs/errors/prune').send({ days: 30 })).body.deleted,
    1,
  );
  assert.equal(await node.ctx.errorLog.prune(0), 0);
});
