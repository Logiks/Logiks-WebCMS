import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn, startSmtp, configureMail, ADMIN, until } from './helpers.js';

let node, smtp;
const tokenFrom = (msg) => /#\/reset\/([A-Za-z0-9_-]+)/.exec(msg.text)[1];

async function csrf(app) {
  const agent = request.agent(app);
  const { body } = await agent.get('/api/auth/csrf');
  return {
    agent,
    token: body.csrfToken,
    post: (url) => agent.post(url).set('x-csrf-token', body.csrfToken),
  };
}

before(async () => {
  smtp = await startSmtp();
  node = await makeNode({ env: { JOB_BACKOFF_MS: '20' } });
  await node.ctx.settings.update('security', { values: { forgot_rate_limit_per_hour: 100 } }); // the limit itself has its own test
});
after(async () => {
  await node.close();
  await smtp.close();
});

describe('email delivery', () => {
  test('"Send me a test email" delivers to the signed-in admin using unsaved form values', async () => {
    const s = await signedIn(node.app);
    const r = await s.post('/api/admin/settings/mail/tests/send_test').send({
      values: {
        transport: 'smtp',
        host: '127.0.0.1',
        port: smtp.port,
        from_address: 'noreply@example.com',
      },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    await until(() => smtp.messages.length === 1);
    assert.equal(smtp.messages[0].to.value[0].address, ADMIN.email);
    assert.match(smtp.messages[0].subject, /Test email from/);
    assert.equal(node.ctx.settings.get('mail.transport'), 'none', 'a test must not save anything');
    smtp.messages.length = 0;
  });

  test('connection test explains bad credentials and unreachable hosts in plain language', async () => {
    const authed = await startSmtp({ auth: { user: 'u', pass: 'p' } });
    try {
      const s = await signedIn(node.app);
      const ok = await s
        .post('/api/admin/settings/mail/tests/connect')
        .send({ values: { host: '127.0.0.1', port: authed.port, user: 'u', password: 'p' } });
      assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
      assert.match(ok.body.message, /signed in/);
      const bad = await s
        .post('/api/admin/settings/mail/tests/connect')
        .send({ values: { host: '127.0.0.1', port: authed.port, user: 'u', password: 'wrong' } });
      assert.equal(bad.body.ok, false);
      assert.match(bad.body.message, /username or password/);
      const down = await s
        .post('/api/admin/settings/mail/tests/connect')
        .send({ values: { host: '127.0.0.1', port: 1 } });
      assert.match(down.body.message, /refused/);
    } finally {
      await authed.close();
    }
  });

  test('queued mail payloads are sealed: no recipient or link is readable in the queue', async () => {
    await configureMail(node.ctx, smtp);
    const captured = [];
    const real = node.ctx.jobs.enqueue;
    node.ctx.jobs.enqueue = async (name, data) => captured.push({ name, data });
    await node.ctx.mailer.sendTemplate('secret.person@example.com', 'password-reset', {
      name: 'X',
      link: 'https://x/#/reset/SECRETTOKEN',
      minutes: 60,
    });
    node.ctx.jobs.enqueue = real;
    assert.equal(captured[0].name, 'mail.send');
    const wire = JSON.stringify(captured[0].data);
    assert.match(captured[0].data.sealed, /^enc:v1:/);
    assert.ok(!wire.includes('secret.person') && !wire.includes('SECRETTOKEN'));
  });

  test('failed deliveries are retried and eventually arrive', async () => {
    const flaky = await startSmtp({ failFirst: 2 });
    const n = await makeNode({ env: { JOB_BACKOFF_MS: '20' } });
    try {
      await configureMail(n.ctx, flaky);
      await n.ctx.mailer.sendTemplate('a@example.com', 'test', {});
      await until(() => flaky.messages.length === 1, { timeout: 5000 });
      assert.equal(flaky.messages[0].to.value[0].address, 'a@example.com');
    } finally {
      await n.close();
      await flaky.close();
    }
  });

  test('when mail is unavailable the message is dropped without throwing', async () => {
    const n = await makeNode();
    try {
      assert.equal(n.ctx.mailer.enabled(), false);
      assert.equal(await n.ctx.mailer.sendTemplate('a@example.com', 'test', {}), false);
    } finally {
      await n.close();
    }
  });
});

describe('forgot password', () => {
  test('is hidden until email is configured (public info tells the sign-in page)', async () => {
    const n = await makeNode();
    try {
      assert.equal((await request(n.app).get('/api/public/info')).body.passwordReset, false);
      await configureMail(n.ctx, smtp);
      assert.equal((await request(n.app).get('/api/public/info')).body.passwordReset, true);
    } finally {
      await n.close();
    }
  });

  test('full flow: request → email → link works once → new password → old sessions gone', async () => {
    smtp.messages.length = 0;
    const s = await signedIn(node.app); // an existing session that must be revoked
    const c = await csrf(node.app);
    const res = await c.post('/api/auth/forgot').send({ email: ADMIN.email });
    assert.equal(res.status, 200);
    await until(() => smtp.messages.some((m) => /Reset your/.test(m.subject)));
    const mail = smtp.messages.find((m) => /Reset your/.test(m.subject));
    assert.equal(mail.to.value[0].address, ADMIN.email);
    assert.match(mail.text, /http:\/\/localhost:3000\/admin#\/reset\//);
    const token = tokenFrom(mail);

    // the database holds only a hash of the token
    const rows = await node.ctx.db('password_resets');
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(token));
    assert.equal(rows[0].token_hash.length, 64);

    assert.equal((await c.post('/api/auth/reset/check').send({ token })).body.valid, true);
    assert.equal(
      (await c.post('/api/auth/reset/check').send({ token: 'x'.repeat(43) })).body.valid,
      false,
    );

    // a weak password is rejected without burning the link
    const weak = await c.post('/api/auth/reset').send({ token, password: 'short' });
    assert.equal(weak.status, 422);
    assert.equal((await c.post('/api/auth/reset/check').send({ token })).body.valid, true);

    const done = await c.post('/api/auth/reset').send({ token, password: 'Brand-new-pass-77' });
    assert.equal(done.status, 200);

    // single use
    const again = await c.post('/api/auth/reset').send({ token, password: 'Another-pass-88' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'invalid_token');

    // the pre-existing session was signed out; old password is dead; new one works
    assert.equal((await s.get('/api/auth/me')).status, 401);
    await assert.rejects(signedIn(node.app, ADMIN), /401/);
    const fresh = await signedIn(node.app, { email: ADMIN.email, password: 'Brand-new-pass-77' });
    assert.equal(fresh.user.email, ADMIN.email);

    // and the account owner is told
    await until(() => smtp.messages.some((m) => /password was changed/.test(m.subject)));
    // restore for the tests that follow
    await node.ctx.users.setPassword(1, ADMIN.password, {});
  });

  test('unknown emails get the identical response and no email', async () => {
    smtp.messages.length = 0;
    await node.ctx.db('password_resets').del(); // clear the one-per-minute throttle from the previous test
    const c = await csrf(node.app);
    const known = await c.post('/api/auth/forgot').send({ email: 'ADMIN@example.com' });
    const unknown = await c.post('/api/auth/forgot').send({ email: 'nobody@example.com' });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
    await until(() => smtp.messages.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(smtp.messages.length, 1, 'only the real account is emailed');
    assert.equal(
      await node.ctx.db('users').where({ email: 'nobody@example.com' }).first(),
      undefined,
    );
  });

  test('a new request voids the previous link; requests inside a minute are absorbed', async () => {
    smtp.messages.length = 0;
    await node.ctx.db('password_resets').del();
    const c = await csrf(node.app);
    await c.post('/api/auth/forgot').send({ email: ADMIN.email });
    await c.post('/api/auth/forgot').send({ email: ADMIN.email }); // within 60s → ignored
    await until(() => smtp.messages.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(smtp.messages.length, 1);

    const first = tokenFrom(smtp.messages[0]);
    await node.ctx.db('password_resets').update({ created_at: Date.now() - 120_000 }); // pretend a minute passed
    await c.post('/api/auth/forgot').send({ email: ADMIN.email });
    await until(() => smtp.messages.length === 2);
    assert.equal(
      (await c.post('/api/auth/reset/check').send({ token: first })).body.valid,
      false,
      'older link is void',
    );
    assert.equal(
      (await c.post('/api/auth/reset/check').send({ token: tokenFrom(smtp.messages[1]) })).body
        .valid,
      true,
    );
  });

  test('expired links are rejected', async () => {
    smtp.messages.length = 0;
    await node.ctx.db('password_resets').del();
    const c = await csrf(node.app);
    await c.post('/api/auth/forgot').send({ email: ADMIN.email });
    await until(() => smtp.messages.length === 1);
    const token = tokenFrom(smtp.messages[0]);
    await node.ctx.db('password_resets').update({ expires_at: Date.now() - 1000 });
    assert.equal((await c.post('/api/auth/reset/check').send({ token })).body.valid, false);
    assert.equal(
      (await c.post('/api/auth/reset').send({ token, password: 'Valid-password-99' })).status,
      400,
    );
  });

  test('a disabled account cannot use a link issued before it was disabled', async () => {
    smtp.messages.length = 0;
    await node.ctx.db('password_resets').del();
    const viewer = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
    const u = await node.ctx.users.createUser(
      {
        email: 'gone@example.com',
        name: 'Gone',
        password: 'Some-password-12',
        roleId: Number(viewer.id),
      },
      null,
    );
    const c = await csrf(node.app);
    await c.post('/api/auth/forgot').send({ email: 'gone@example.com' });
    await until(() => smtp.messages.length === 1);
    await node.ctx.users.updateUser(u.id, { status: 'disabled' }, null);
    assert.equal(
      (await c.post('/api/auth/reset/check').send({ token: tokenFrom(smtp.messages[0]) })).body
        .valid,
      false,
    );
  });

  test('request volume is limited per IP', async () => {
    const n = await makeNode();
    try {
      await configureMail(n.ctx, smtp);
      await n.ctx.settings.update('security', { values: { forgot_rate_limit_per_hour: 1 } });
      const c = await csrf(n.app);
      assert.equal((await c.post('/api/auth/forgot').send({ email: 'a@example.com' })).status, 200);
      const second = await c.post('/api/auth/forgot').send({ email: 'b@example.com' });
      assert.equal(second.status, 429);
    } finally {
      await n.close();
    }
  });
});

describe('invitations and link throttling', () => {
  let n;
  const viewerId = async () =>
    Number((await n.ctx.db('roles').where({ name: 'Viewer' }).first()).id);
  before(async () => {
    n = await makeNode({ env: { JOB_BACKOFF_MS: '20' } });
  });
  after(async () => n.close());

  test('inviting needs email to be configured, and creates nothing without it', async () => {
    const s = await signedIn(n.app);
    const r = await s
      .post('/api/admin/users/invite')
      .send({ email: 'early@example.com', name: 'Early', roleId: await viewerId() });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'mail_not_configured');
    assert.match(r.body.error.message, /Settings → Email/);
    assert.equal(await n.ctx.db('users').where({ email: 'early@example.com' }).first(), undefined);
    await configureMail(n.ctx, smtp);
  });

  test('invite → email → the invitee chooses a password once → signs in with the invited role', async () => {
    smtp.messages.length = 0;
    const s = await signedIn(n.app);
    const r = await s
      .post('/api/admin/users/invite')
      .send({ email: 'Newbie@Example.com', name: 'Nia Newbie', roleId: await viewerId() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.email, 'newbie@example.com');
    assert.equal(r.body.role, 'Viewer');
    assert.equal(r.body.status, 'active');

    await until(() => smtp.messages.some((m) => /invited to/.test(m.subject)));
    const mail = smtp.messages.find((m) => /invited to/.test(m.subject));
    assert.equal(mail.to.value[0].address, 'newbie@example.com');
    assert.match(mail.text, new RegExp(`${ADMIN.email} invited you`));
    assert.match(mail.text, /expires in 72 hours/);
    const token = tokenFrom(mail);

    // nobody knows the placeholder password, and the link is only stored hashed
    const rows = await n.ctx.db('password_resets').where({ user_id: r.body.id });
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(token));
    const hours = (Number(rows[0].expires_at) - Date.now()) / 3_600_000;
    assert.ok(hours > 71.9 && hours <= 72, `link lifetime ${hours}h`);

    const c = await csrf(n.app);
    assert.equal((await c.post('/api/auth/reset/check').send({ token })).body.valid, true);
    assert.equal(
      (await c.post('/api/auth/reset').send({ token, password: 'Nia-first-pass-1' })).status,
      200,
    );
    assert.equal(
      (await c.post('/api/auth/reset').send({ token, password: 'Nia-second-pass-2' })).status,
      400,
      'the link works once',
    );
    const nia = await signedIn(n.app, {
      email: 'newbie@example.com',
      password: 'Nia-first-pass-1',
    });
    assert.equal(nia.user.role, 'Viewer');

    const audit = (await s.get('/api/admin/audit?action=user.invited')).body.entries;
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes(token), 'the link never reaches the audit log');
  });

  test('the invitation lifetime is a setting', async () => {
    const s = await signedIn(n.app);
    await n.ctx.settings.update('security', { values: { invite_token_hours: 2 } });
    const r = await s
      .post('/api/admin/users/invite')
      .send({ email: 'brief@example.com', name: 'Brief', roleId: await viewerId() });
    const row = await n.ctx.db('password_resets').where({ user_id: r.body.id }).first();
    const hours = (Number(row.expires_at) - Date.now()) / 3_600_000;
    assert.ok(hours > 1.9 && hours <= 2, `link lifetime ${hours}h`);
    await n.ctx.settings.update('security', { values: { invite_token_hours: 72 } });
  });

  test('a taken email is refused and sends nothing; viewers cannot invite', async () => {
    smtp.messages.length = 0;
    const s = await signedIn(n.app);
    const dup = await s
      .post('/api/admin/users/invite')
      .send({ email: ADMIN.email, name: 'Dup', roleId: await viewerId() });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'email_taken');

    const v = await signedIn(n.app, { email: 'newbie@example.com', password: 'Nia-first-pass-1' });
    const denied = await v
      .post('/api/admin/users/invite')
      .send({ email: 'x@example.com', name: 'X', roleId: await viewerId() });
    assert.equal(denied.status, 403);
    assert.equal(
      (await v.post('/api/admin/users/1/resend-invite').send({})).status,
      403,
      'resending is guarded too',
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(
      smtp.messages.filter((m) => ['x@example.com', ADMIN.email].includes(m.to.value[0].address))
        .length,
      0,
      'nothing was sent to the refused addresses',
    );
  });

  test('re-sending voids the previous link; unknown or disabled users get a clear error', async () => {
    smtp.messages.length = 0;
    const s = await signedIn(n.app);
    const u = await n.ctx.db('users').where({ email: 'brief@example.com' }).first();
    const before = await n.ctx.db('password_resets').where({ user_id: u.id }).first();
    const r = await s.post(`/api/admin/users/${u.id}/resend-invite`).send({});
    assert.equal(r.status, 200);
    await until(() => smtp.messages.length === 1);
    const c = await csrf(n.app);
    assert.equal(
      (await c.post('/api/auth/reset/check').send({ token: tokenFrom(smtp.messages[0]) })).body
        .valid,
      true,
    );
    const old = await n.ctx.db('password_resets').where({ id: before.id }).first();
    assert.ok(old.used_at, 'the first invitation was voided');

    assert.equal((await s.post('/api/admin/users/9999/resend-invite').send({})).status, 404);
    await n.ctx.users.updateUser(u.id, { status: 'disabled' }, null);
    assert.equal((await s.post(`/api/admin/users/${u.id}/resend-invite`).send({})).status, 404);
  });

  test('simultaneous reset requests for one account send exactly one email', async () => {
    smtp.messages.length = 0;
    await n.ctx.db('password_resets').del();
    // the route doesn't wait for the service, so real requests overlap exactly like this
    await Promise.all(
      Array.from({ length: 6 }, () => n.ctx.recovery.request(ADMIN.email, '1.2.3.4')),
    );
    await until(() => smtp.messages.length >= 1);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(smtp.messages.filter((m) => /Reset your/.test(m.subject)).length, 1);
    assert.equal(
      (await n.ctx.db('password_resets').where({ user_id: 1 }).whereNull('used_at')).length,
      1,
      'and exactly one usable link exists',
    );
  });
});
