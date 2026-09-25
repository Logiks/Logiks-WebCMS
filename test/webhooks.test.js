import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { makeNode, signedIn, until } from './helpers.js';

let node, admin, receiver, receiverUrl;
const received = [];

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(receiver.nextStatus || 200).end('ok');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
});
after(async () => {
  await node.close();
  await new Promise((resolve) => receiver.close(resolve));
});

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

describe('Webhooks: CRUD and permissions', () => {
  test('webhooks.write creates, updates and deletes; webhooks.read alone can only view', async () => {
    const reader = await mkUser(['admin.access', 'webhooks.read'], 'wh-reader@example.com');
    const writer = await mkUser(
      ['admin.access', 'webhooks.read', 'webhooks.write'],
      'wh-writer@example.com',
    );

    const denied = await reader
      .post('/api/admin/webhooks')
      .send({ name: 'x', event: 'x.y', url: receiverUrl });
    assert.equal(denied.status, 403);

    const created = await writer
      .post('/api/admin/webhooks')
      .send({ name: 'My webhook', event: 'widget.*', url: receiverUrl });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.webhook.id;

    const listed = await reader.get('/api/admin/webhooks');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.webhooks.some((w) => w.id === id));

    const updated = await writer
      .put(`/api/admin/webhooks/${id}`)
      .send({ name: 'Renamed', event: 'widget.*', url: receiverUrl });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.webhook.name, 'Renamed');

    assert.equal((await reader.delete(`/api/admin/webhooks/${id}`)).status, 403);
    assert.equal((await writer.delete(`/api/admin/webhooks/${id}`)).status, 204);
  });

  test('a secret is write-only: never returned by get or list, but signs deliveries', async () => {
    const created = await admin.post('/api/admin/webhooks').send({
      name: 'Secret hook',
      event: 'secret.test',
      url: receiverUrl,
      secret: 'shh-its-a-secret',
    });
    assert.equal(created.status, 201);
    const id = created.body.webhook.id;
    assert.equal(created.body.webhook.secret, undefined);
    assert.equal(created.body.webhook.hasSecret, true);

    const got = await admin.get(`/api/admin/webhooks/${id}`);
    assert.equal(JSON.stringify(got.body).includes('shh-its-a-secret'), false);

    const before_ = received.length;
    await node.ctx.events.emit('secret.test', { x: 1 });
    await until(() => received.length > before_);
    const delivery = received[received.length - 1];
    const expected = createHmac('sha256', 'shh-its-a-secret').update(delivery.body).digest('hex');
    assert.equal(delivery.headers['x-cms-signature'], `sha256=${expected}`);

    await admin.delete(`/api/admin/webhooks/${id}`);
  });

  test('the URL must start with http:// or https://', async () => {
    const bad = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'x', event: 'x.y', url: 'javascript:alert(1)' });
    assert.equal(bad.status, 422);
  });
});

describe('Webhooks: event matching and delivery', () => {
  test('an exact event name only fires an exactly-matching webhook', async () => {
    const w = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'Exact', event: 'exact.match', url: receiverUrl });
    const before_ = received.length;
    await node.ctx.events.emit('exact.match.other', {});
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, before_, 'a near-miss name did not fire it');
    await node.ctx.events.emit('exact.match', { yes: true });
    await until(() => received.length > before_);
    assert.match(received[received.length - 1].body, /"yes":true/);
    await admin.delete(`/api/admin/webhooks/${w.body.webhook.id}`);
  });

  test('a wildcard pattern matches, and two webhooks can both fire for one event', async () => {
    const w1 = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'Wild 1', event: 'orders.*', url: receiverUrl });
    const w2 = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'Wild 2', event: 'orders.**', url: receiverUrl });
    const before_ = received.length;
    await node.ctx.events.emit('orders.created', { id: 42 });
    await until(() => received.length >= before_ + 2);
    await admin.delete(`/api/admin/webhooks/${w1.body.webhook.id}`);
    await admin.delete(`/api/admin/webhooks/${w2.body.webhook.id}`);
  });

  test('a single * matches one dot-segment; ** matches any depth', async () => {
    const w1 = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'One segment', event: 'deep.*', url: receiverUrl });
    const w2 = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'Any depth', event: 'deep.**', url: receiverUrl });
    const before_ = received.length;
    await node.ctx.events.emit('deep.one.two', {});
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, before_ + 1, 'only the ** rule matched a two-segment name');
    await admin.delete(`/api/admin/webhooks/${w1.body.webhook.id}`);
    await admin.delete(`/api/admin/webhooks/${w2.body.webhook.id}`);
  });

  test('a delivery attempt is recorded, success and failure', async () => {
    const w = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'Recorded', event: 'recorded.test', url: receiverUrl });
    const id = w.body.webhook.id;
    receiver.nextStatus = 200;
    await node.ctx.events.emit('recorded.test', {});
    await until(
      async () =>
        (await admin.get(`/api/admin/webhooks/${id}/deliveries`)).body.deliveries.length > 0,
    );
    let deliveries = (await admin.get(`/api/admin/webhooks/${id}/deliveries`)).body.deliveries;
    assert.equal(deliveries[0].status, 'success');
    assert.equal(deliveries[0].responseCode, 200);

    receiver.nextStatus = 500;
    await node.ctx.events.emit('recorded.test', {});
    await until(async () => {
      deliveries = (await admin.get(`/api/admin/webhooks/${id}/deliveries`)).body.deliveries;
      return deliveries.some((d) => d.status === 'failed');
    });
    const failed = deliveries.find((d) => d.status === 'failed');
    assert.equal(failed.responseCode, 500);
    receiver.nextStatus = 200;
    await admin.delete(`/api/admin/webhooks/${id}`);
  });

  test('"Send test" delivers a synthetic event through the same path', async () => {
    const w = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'Test button', event: 'never.matches.anything', url: receiverUrl });
    const id = w.body.webhook.id;
    const before_ = received.length;
    const fired = await admin.post(`/api/admin/webhooks/${id}/test`);
    assert.equal(fired.status, 202);
    await until(() => received.length > before_);
    assert.match(received[received.length - 1].body, /"event":"test"/);
    await admin.delete(`/api/admin/webhooks/${id}`);
  });

  test('a configured payload is merged under a real event’s own payload (the event’s fields win on a clash)', async () => {
    const w = await admin.post('/api/admin/webhooks').send({
      name: 'Payload test',
      event: 'payload.test',
      url: receiverUrl,
      payload: { source: 'default', extra: 'kept', clash: 'from-webhook' },
    });
    const id = w.body.webhook.id;
    assert.deepEqual(w.body.webhook.payload, {
      source: 'default',
      extra: 'kept',
      clash: 'from-webhook',
    });

    const before_ = received.length;
    await node.ctx.events.emit('payload.test', { source: 'event', clash: 'from-event' });
    await until(() => received.length > before_);
    const body = JSON.parse(received[received.length - 1].body);
    assert.deepEqual(body.payload, { source: 'event', extra: 'kept', clash: 'from-event' });
    await admin.delete(`/api/admin/webhooks/${id}`);
  });

  test('"Send test" sends the webhook’s own configured payload when it has one', async () => {
    const w = await admin.post('/api/admin/webhooks').send({
      name: 'Test with payload',
      event: 'never.matches.anything',
      url: receiverUrl,
      payload: { hello: 'from the configured payload' },
    });
    const id = w.body.webhook.id;
    const before_ = received.length;
    await admin.post(`/api/admin/webhooks/${id}/test`);
    await until(() => received.length > before_);
    const body = JSON.parse(received[received.length - 1].body);
    assert.deepEqual(body.payload, { hello: 'from the configured payload' });
    await admin.delete(`/api/admin/webhooks/${id}`);
  });

  test('updating a rule’s event pattern is reflected immediately, never served stale from cache', async () => {
    const w = await admin
      .post('/api/admin/webhooks')
      .send({ name: 'Cache test', event: 'cache.v1', url: receiverUrl });
    const id = w.body.webhook.id;
    await admin
      .put(`/api/admin/webhooks/${id}`)
      .send({ name: 'Cache test', event: 'cache.v2', url: receiverUrl });
    const before_ = received.length;
    await node.ctx.events.emit('cache.v1', {});
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, before_, 'the old pattern no longer matches');
    await node.ctx.events.emit('cache.v2', {});
    await until(() => received.length > before_);
    await admin.delete(`/api/admin/webhooks/${id}`);
  });
});
