import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';

let node;
before(async () => {
  node = await makeNode();
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

const lastNamed = async (name) => {
  const rows = await node.ctx.events.list({ name, limit: 1 });
  return rows[0];
};

describe('Events: emit() and the log', () => {
  test('emit() writes a row the log can list back, filtered by name', async () => {
    await node.ctx.events.emit('widget.frobbed', { widgetId: 7 });
    const found = await lastNamed('widget.frobbed');
    assert.ok(found, 'the event was logged');
    assert.deepEqual(found.payload, { widgetId: 7 });
  });

  test('an empty event name is rejected', async () => {
    await assert.rejects(() => node.ctx.events.emit('  '), /required/);
  });
});

describe('Events: built-in lifecycle wiring', () => {
  test('content.published fires the first time an entry goes live, content.updated on a later save', async () => {
    const post = await node.ctx.content.create(
      'post',
      { title: 'Event Post', status: 'draft', data: {} },
      null,
    );
    assert.equal(await lastNamed('content.published').then((e) => e?.payload.id), undefined);

    await node.ctx.content.update(post.id, { status: 'published' }, null);
    const published = await lastNamed('content.published');
    assert.equal(published.payload.id, post.id);
    assert.equal(published.payload.title, 'Event Post');

    await node.ctx.content.update(post.id, { title: 'Event Post, Renamed' }, null);
    const updated = await lastNamed('content.updated');
    assert.equal(updated.payload.id, post.id);
    assert.equal(updated.payload.title, 'Event Post, Renamed');
  });

  test('content.deleted fires only when the deleted entry was live', async () => {
    const draft = await node.ctx.content.create(
      'post',
      { title: 'Never published', status: 'draft', data: {} },
      null,
    );
    await node.ctx.content.remove(draft.id, null);
    const beforeDeleted = await lastNamed('content.deleted');

    const post = await node.ctx.content.create(
      'post',
      { title: 'Live then deleted', status: 'published', data: {} },
      null,
    );
    await node.ctx.content.remove(post.id, null);
    const afterDeleted = await lastNamed('content.deleted');
    assert.notEqual(afterDeleted, beforeDeleted, 'the draft delete did not also log an event');
    assert.equal(afterDeleted.payload.title, 'Live then deleted');
  });

  test('user.created fires when an admin creates a user', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'r-event-user', description: '', permissions: ['admin.access'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'event-user@example.com',
        name: 'Event User',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const found = await lastNamed('user.created');
    assert.equal(found.payload.email, 'event-user@example.com');
  });

  test('contact.submitted fires when the contact form is submitted', async () => {
    await node.ctx.site.contact.submit({ name: 'Ada', email: 'ada@example.com', message: 'Hi' });
    const found = await lastNamed('contact.submitted');
    assert.equal(found.payload.email, 'ada@example.com');
  });
});

describe('Events: permissions', () => {
  test('events.write is required to fire a test event; events.read alone can only view the log', async () => {
    const reader = await mkUser(['admin.access', 'events.read'], 'events-reader@example.com');
    const writer = await mkUser(
      ['admin.access', 'events.read', 'events.write'],
      'events-writer@example.com',
    );

    const denied = await reader.post('/api/admin/events/fire').send({ name: 'x.y' });
    assert.equal(denied.status, 403);

    const ok = await writer
      .post('/api/admin/events/fire')
      .send({ name: 'ui.manual_fire', payload: { a: 1 } });
    assert.equal(ok.status, 202);
    const found = await lastNamed('ui.manual_fire');
    assert.deepEqual(found.payload, { a: 1 });

    assert.equal((await reader.get('/api/admin/events')).status, 200);
  });

  test('firing a test event is audited (it can trigger real webhooks, D-050)', async () => {
    const writer = await mkUser(
      ['admin.access', 'events.read', 'events.write'],
      'events-audited@example.com',
    );
    await writer.post('/api/admin/events/fire').send({ name: 'ui.audited_fire', payload: {} });
    const entries = await node.ctx.audit.list({ action: 'events.fired', limit: 5 });
    assert.ok(entries.some((e) => e.entityId === 'ui.audited_fire'));
    assert.equal(entries[0].actor, 'events-audited@example.com');
  });
});
