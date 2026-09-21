import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn, ADMIN } from './helpers.js';

let node;
before(async () => {
  node = await makeNode();
});
after(async () => node.close());

const NEW = 'Changed-password-42';

test('change password: validates, keeps this session, signs out the others', async () => {
  const here = await signedIn(node.app);
  const other = await signedIn(node.app); // a second device

  const wrong = await here
    .post('/api/auth/password')
    .send({ current: 'nope-nope-nope', next: NEW });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.field, 'current');
  assert.equal(
    (await here.post('/api/auth/password').send({ current: ADMIN.password, next: 'short' })).status,
    422,
  );
  assert.equal(
    (await here.post('/api/auth/password').send({ current: ADMIN.password, next: ADMIN.password }))
      .status,
    422,
  );

  const ok = await here.post('/api/auth/password').send({ current: ADMIN.password, next: NEW });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.otherSessionsSignedOut, 1);

  assert.equal(
    (await here.get('/api/auth/me')).status,
    200,
    'the session you used stays signed in',
  );
  assert.equal((await other.get('/api/auth/me')).status, 401, 'other devices are signed out');
  await assert.rejects(signedIn(node.app, ADMIN), /401/);
  await signedIn(node.app, { email: ADMIN.email, password: NEW });

  const audit = (await here.get('/api/admin/audit?action=auth.password')).body.entries;
  assert.ok(
    audit.some((e) => e.action === 'auth.password_changed' && e.meta.sessionsRevoked === 1),
  );
  await node.ctx.users.setPassword(1, ADMIN.password, {}); // restore
});

test('session list shows your devices, never raw session ids', async () => {
  const a = await signedIn(node.app);
  const b = await signedIn(node.app);
  const { sessions } = (await a.get('/api/auth/sessions')).body;
  assert.ok(sessions.length >= 2);
  assert.equal(sessions.filter((s) => s.current).length, 1);
  assert.equal(sessions[0].current, true, 'current session is listed first');
  assert.match(sessions[0].id, /^[0-9a-f]{16}$/);
  assert.ok(sessions[0].device && sessions[0].createdAt && sessions[0].lastSeen);

  const cookies = (await node.ctx.sessionStore.listForUser(1)).map((s) => s.sid);
  const wire = JSON.stringify(sessions);
  for (const sid of cookies)
    assert.ok(!wire.includes(sid), 'a raw session id leaked into the API response');
  assert.ok(b);
});

test('revoke one session, then all others', async () => {
  const a = await signedIn(node.app);
  const b = await signedIn(node.app);
  const c = await signedIn(node.app);

  const list = (await a.get('/api/auth/sessions')).body.sessions;
  const current = list.find((s) => s.current);
  assert.equal(
    (await a.del(`/api/auth/sessions/${current.id}`)).status,
    409,
    "can't revoke the session you're using this way",
  );
  assert.equal((await a.del('/api/auth/sessions/0000000000000000')).status, 404);

  // find b's handle by asking b
  const bId = (await b.get('/api/auth/sessions')).body.sessions.find((s) => s.current).id;
  assert.equal((await a.del(`/api/auth/sessions/${bId}`)).status, 204);
  assert.equal((await b.get('/api/auth/me')).status, 401);
  assert.equal((await c.get('/api/auth/me')).status, 200);

  const r = await a.post('/api/auth/sessions/revoke-others');
  assert.ok(r.body.revoked >= 1);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  assert.equal((await a.get('/api/auth/me')).status, 200);
});

test('you cannot see or revoke another user’s sessions through your own endpoints', async () => {
  const viewerRole = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
  await node.ctx.users.createUser(
    {
      email: 'v2@example.com',
      name: 'V2',
      password: 'Viewer-two-pass-1',
      roleId: Number(viewerRole.id),
    },
    null,
  );
  const admin = await signedIn(node.app);
  const v = await signedIn(node.app, { email: 'v2@example.com', password: 'Viewer-two-pass-1' });
  const adminHandle = (await admin.get('/api/auth/sessions')).body.sessions.find(
    (s) => s.current,
  ).id;
  assert.equal((await v.del(`/api/auth/sessions/${adminHandle}`)).status, 404);
  assert.equal((await admin.get('/api/auth/me')).status, 200);
});

test('an administrator can sign a user out everywhere; disabling or deleting does too', async () => {
  const viewerRole = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
  const mk = (email) =>
    node.ctx.users.createUser(
      { email, name: email, password: 'Some-long-pass-12', roleId: Number(viewerRole.id) },
      null,
    );
  const [u1, u2, u3] = await Promise.all([
    mk('k1@example.com'),
    mk('k2@example.com'),
    mk('k3@example.com'),
  ]);
  const creds = (email) => ({ email, password: 'Some-long-pass-12' });
  const s1 = await signedIn(node.app, creds('k1@example.com'));
  const s2 = await signedIn(node.app, creds('k2@example.com'));
  const s3 = await signedIn(node.app, creds('k3@example.com'));
  const admin = await signedIn(node.app);

  assert.equal((await admin.post(`/api/admin/users/${u1.id}/revoke-sessions`)).body.revoked, 1);
  assert.equal((await s1.get('/api/auth/me')).status, 401);

  await admin.patch(`/api/admin/users/${u2.id}`).send({ status: 'disabled' });
  assert.equal((await s2.get('/api/auth/me')).status, 401);

  await admin.del(`/api/admin/users/${u3.id}`);
  assert.equal((await s3.get('/api/auth/me')).status, 401);

  // a viewer can't do it
  const v = await signedIn(node.app, { email: 'v2@example.com', password: 'Viewer-two-pass-1' });
  assert.equal((await v.post(`/api/admin/users/${u1.id}/revoke-sessions`)).status, 403);
});

test('an admin resetting someone’s password signs them out', async () => {
  const viewerRole = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
  const u = await node.ctx.users.createUser(
    {
      email: 'r1@example.com',
      name: 'R1',
      password: 'Some-long-pass-12',
      roleId: Number(viewerRole.id),
    },
    null,
  );
  const s = await signedIn(node.app, { email: 'r1@example.com', password: 'Some-long-pass-12' });
  const admin = await signedIn(node.app);
  await admin.patch(`/api/admin/users/${u.id}`).send({ password: 'Reset-by-admin-99' });
  assert.equal((await s.get('/api/auth/me')).status, 401);
});

test('profile: you can change your own name; it shows everywhere and is audited', async () => {
  const viewer = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
  await node.ctx.users.createUser(
    {
      email: 'prof@example.com',
      name: 'Old Name',
      password: 'Profile-pass-12',
      roleId: Number(viewer.id),
    },
    null,
  );
  const creds = { email: 'prof@example.com', password: 'Profile-pass-12' };
  const s = await signedIn(node.app, creds);

  for (const bad of ['', '   ', 'x'.repeat(129)]) {
    const r = await s.patch('/api/auth/profile').send({ name: bad });
    assert.ok([400, 422].includes(r.status), `rejects ${JSON.stringify(bad.slice(0, 5))}`);
  }
  assert.equal((await s.get('/api/auth/me')).body.user.name, 'Old Name', 'nothing changed');

  const ok = await s.patch('/api/auth/profile').send({ name: '  New Name  ' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, 'New Name', 'trimmed');
  assert.equal((await s.get('/api/auth/me')).body.user.name, 'New Name');
  assert.equal((await signedIn(node.app, creds)).user.name, 'New Name');
  assert.equal((await node.ctx.db('users').where({ email: creds.email }).first()).name, 'New Name');

  const admin = await signedIn(node.app);
  const entry = (await admin.get('/api/admin/audit?action=auth.profile_updated')).body.entries[0];
  assert.equal(entry.actor, 'prof@example.com');

  // email and role stay administrator-only: extra fields are ignored, not applied
  await s
    .patch('/api/auth/profile')
    .send({ name: 'New Name', email: 'evil@example.com', roleId: 1 });
  const row = await node.ctx.db('users').where({ id: ok.body.user.id }).first();
  assert.equal(row.email, 'prof@example.com');
  assert.equal(Number(row.role_id), Number(viewer.id));
  assert.equal((await s.patch('/api/auth/profile').send({})).status, 422);
});
