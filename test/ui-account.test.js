import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startNode, signedIn, startSmtp, configureMail, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, smtp;
before(async () => {
  smtp = await startSmtp();
  node = await startNode({ seed: true, env: { JOB_BACKOFF_MS: '20' } });
  await node.ctx.settings.update('security', { values: { forgot_rate_limit_per_hour: 100 } });
});
after(async () => {
  await node.close();
  await smtp.close();
});

test('sign-in page hides "Forgot your password?" until email is configured', async () => {
  const off = await openAdmin(node.url);
  assert.ok(!off.visible(off.$('a[href="#/forgot"]')), 'hidden while mail is off');
  off.go('#/forgot');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(off.$('#email'), 'the forgot screen is unavailable without mail; sign-in stays');
  off.close();

  await configureMail(node.ctx, smtp);
  const on = await openAdmin(node.url);
  await until(() => on.visible(on.$('a[href="#/forgot"]')));
  on.close();
});

test('forgot → email → reset screen: mismatch, weak and valid passwords, then sign in', async () => {
  const b = await openAdmin(node.url);
  await until(() => b.visible(b.$('a[href="#/forgot"]')));
  b.click(b.$('a[href="#/forgot"]'));
  await until(() => b.$('#fp-email'));
  b.type(b.$('#fp-email'), ADMIN.email);
  b.submit(b.$('form.login-form'));
  await until(() => b.alertShown(/reset link is on its way/));

  await until(() => smtp.messages.some((m) => /Reset your/.test(m.subject)));
  const token = /#\/reset\/([A-Za-z0-9_-]+)/.exec(smtp.messages.at(-1).text)[1];

  b.go(`#/reset/${token}`);
  await until(() => b.$('#rp-new'));
  assert.equal(b.win.location.hash, '#/reset', 'the token is removed from the address bar');

  b.type(b.$('#rp-new'), 'Fresh-password-2026');
  b.type(b.$('#rp-confirm'), 'Different-password-1');
  b.submit(b.$('form.login-form'));
  await until(() => /don't match/.test(b.text()));

  b.type(b.$('#rp-new'), 'short');
  b.type(b.$('#rp-confirm'), 'short');
  b.submit(b.$('form.login-form'));
  await until(() => /at least 10 characters/i.test(b.text()));
  assert.ok(b.$('#rp-new'), 'the form stays so they can try again');

  b.type(b.$('#rp-new'), 'Fresh-password-2026');
  b.type(b.$('#rp-confirm'), 'Fresh-password-2026');
  b.submit(b.$('form.login-form'));
  await until(() => b.alertShown(/Password changed, and every device was signed out/));

  b.go('#/');
  await b.signIn(ADMIN.email, 'Fresh-password-2026');
  assert.match(b.text(), /Overview/);
  assert.deepEqual(b.errors, []);
  b.close();
  await node.ctx.users.setPassword(1, ADMIN.password, {});
});

test('a used, expired or made-up link shows a clear message, not a form', async () => {
  const b = await openAdmin(node.url);
  b.go(`#/reset/${'x'.repeat(43)}`);
  await until(() => b.alertShown(/invalid or has expired/));
  assert.ok(!b.$('#rp-new'));
  b.close();
});

test('My account: change password shows field errors, then succeeds and lists your devices', async () => {
  const other = await signedIn(node.app); // a second device
  const b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  b.click(b.$('a[href="#/account"]'));
  await until(() => b.$('#pw-current'));
  assert.match(b.text(), /admin@example\.com/);

  b.type(b.$('#pw-current'), 'not-my-password');
  b.type(b.$('#pw-new'), 'Another-good-pass-1');
  b.type(b.$('#pw-confirm'), 'Another-good-pass-2');
  b.submit(b.$('#password-form'));
  await until(() => /don't match/.test(b.text()));

  b.type(b.$('#pw-confirm'), 'Another-good-pass-1');
  b.submit(b.$('#password-form'));
  await until(() => /Current password is incorrect/.test(b.text()));

  b.type(b.$('#pw-current'), ADMIN.password);
  b.type(b.$('#pw-new'), 'tiny');
  b.type(b.$('#pw-confirm'), 'tiny');
  b.submit(b.$('#password-form'));
  await until(() => /at least 10 characters/i.test(b.text()));

  b.type(b.$('#pw-new'), 'Another-good-pass-1');
  b.type(b.$('#pw-confirm'), 'Another-good-pass-1');
  b.submit(b.$('#password-form'));
  await until(() => /Password changed\. 1 other device was signed out/.test(b.text()));
  assert.equal((await other.get('/api/auth/me')).status, 401);
  assert.equal(b.$('#pw-current').value, '', 'the form is cleared');
  await until(() =>
    b.$$('section[x-data="accountPage"] tbody tr .tag.ok').some((t) => b.visible(t)),
  );
  await node.ctx.users.setPassword(1, ADMIN.password, {});
  b.close();
});

test('My account: sign out one device, then all others', async () => {
  const d1 = await signedIn(node.app);
  const d2 = await signedIn(node.app);
  const b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  b.go('#/account');
  await until(() => b.$$('section[x-data="accountPage"] tbody tr').length >= 3);
  assert.ok(
    b.visible(b.$$('section[x-data="accountPage"] tbody tr')[0].querySelector('.tag.ok')),
    'this device is listed first',
  );

  const others = () =>
    b
      .$$('section[x-data="accountPage"] tbody tr')
      .filter((r) => !b.visible(r.querySelector('.tag.ok')));
  b.click([...others()[0].querySelectorAll('button')].find((x) => x.textContent === 'Sign out'));
  await until(
    () =>
      b.$$('section[x-data="accountPage"] tbody tr').length === 2 || /Signed out\./.test(b.text()),
  );
  const dead = [
    (await d1.get('/api/auth/me')).status,
    (await d2.get('/api/auth/me')).status,
  ].sort();
  assert.deepEqual(dead, [200, 401], 'exactly one of the other devices was signed out');

  b.click(b.button('Sign out all other devices'));
  await until(() => b.$$('section[x-data="accountPage"] tbody tr').length === 1);
  assert.equal((await d1.get('/api/auth/me')).status, 401);
  assert.equal((await d2.get('/api/auth/me')).status, 401);
  b.close();
});

test('Users: an administrator can sign someone out everywhere', async () => {
  const viewer = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
  await node.ctx.users.createUser(
    {
      email: 'sess@example.com',
      name: 'Sess User',
      password: 'Some-long-pass-12',
      roleId: Number(viewer.id),
    },
    null,
  );
  const victim = await signedIn(node.app, {
    email: 'sess@example.com',
    password: 'Some-long-pass-12',
  });
  const b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  b.go('#/users');
  await until(() =>
    b
      .$$('section[x-data="usersPage"] tbody tr')
      .some((r) => /sess@example\.com/.test(r.textContent)),
  );
  const row = b
    .$$('section[x-data="usersPage"] tbody tr')
    .find((r) => /sess@example\.com/.test(r.textContent));
  b.click([...row.querySelectorAll('button')].find((x) => x.textContent === 'Edit'));
  await until(() => b.button('Sign out everywhere'));
  b.click(b.button('Sign out everywhere'));
  await until(() => /Signed out 1 session/.test(b.text()));
  assert.equal((await victim.get('/api/auth/me')).status, 401);
  b.close();
});

test('System: shows component health and cache, flushes the cache, retries and discards failed jobs', async () => {
  node.ctx.jobs.define('test.ui-flaky', async () => {
    throw new Error('mail server on fire');
  });
  await node.ctx.jobs.enqueue('test.ui-flaky', {});
  await until(async () => (await node.ctx.jobs.failed()).length === 1, { timeout: 4000 });
  await node.ctx.cache.set('warm', 1);

  const b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  b.go('#/system');
  await until(() => /Up · \d+ ms/.test(b.text()));
  assert.match(b.text(), new RegExp(node.ctx.dialect.kind));
  assert.match(b.text(), /Not configured/);
  assert.match(b.text(), /Sending through smtp/);
  assert.match(b.text(), /mail server on fire/);
  assert.match(b.text(), /3 attempts/);

  b.click(b.button('Flush cache'));
  await until(() => /Cache flushed on every server/.test(b.text()));
  assert.equal(await node.ctx.cache.get('warm'), undefined);

  b.click(b.button('Discard'));
  await until(() => !/mail server on fire/.test(b.text()));
  assert.equal((await node.ctx.jobs.failed()).length, 0);
  assert.deepEqual(b.errors, []);
  b.close();
});

test('My account: change your name; the header updates and blank names are refused', async () => {
  const viewer = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
  await node.ctx.users.createUser(
    {
      email: 'namer@example.com',
      name: 'Before Name',
      password: 'Namer-pass-12345',
      roleId: Number(viewer.id),
    },
    null,
  );
  const b = await openAdmin(node.url);
  await b.signIn('namer@example.com', 'Namer-pass-12345');
  b.go('#/account');
  await until(() => b.$('#profile-name'));
  assert.equal(b.$('#profile-name').value, 'Before Name');
  assert.ok(b.$('#profile-form button').disabled, 'nothing to save yet');

  b.type(b.$('#profile-name'), 'After Name');
  await until(() => !b.$('#profile-form button').disabled);
  b.submit(b.$('#profile-form'));
  await until(() => /Name saved/.test(b.text()));
  assert.equal(
    (await node.ctx.db('users').where({ email: 'namer@example.com' }).first()).name,
    'After Name',
  );
  await until(() => /After Name/.test(b.$('a[title="My account"]').textContent));
  assert.ok(b.$('#profile-form button').disabled, 'saved: the button rests again');
  assert.deepEqual(b.errors, []);
  b.close();
});

test('Users: invite someone by email instead of choosing their password', async () => {
  const smtp2 = await startSmtp();
  try {
    await configureMail(node.ctx, smtp2);
    const b = await openAdmin(node.url);
    await b.signIn(ADMIN.email, ADMIN.password);
    b.go('#/users');
    await until(() => b.button('Add user'));
    b.click(b.button('Add user'));
    const form = await until(() =>
      b.$$('form.panel').find((f) => b.visible(f) && /New user/.test(f.textContent)),
    );
    const [name, email] = form.querySelectorAll('input');
    b.type(name, 'Ivy Invited');
    b.type(email, 'ivy@example.com');
    const pw = form.querySelector('input[type=password]');
    assert.ok(b.visible(pw.closest('.col-md-4')), 'password field shown by default');
    const box = form.querySelector('#u-invite');
    box.checked = true;
    box.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await until(() => !b.visible(pw.closest('.col-md-4')));
    await until(() => b.button('Send invitation'));
    b.submit(form);
    await until(() => /Invitation sent to ivy@example\.com/.test(b.text()));
    await until(() => smtp2.messages.some((m) => /invited to/.test(m.subject)));
    assert.equal(
      (await node.ctx.db('users').where({ email: 'ivy@example.com' }).first()).status,
      'active',
    );

    // an existing user can be sent a fresh link
    await until(() => b.$$('tbody tr').some((r) => /ivy@example\.com/.test(r.textContent)));
    const row = b
      .$$('section[x-data="usersPage"] tbody tr')
      .find((r) => /ivy@example\.com/.test(r.textContent));
    b.click([...row.querySelectorAll('button')].find((x) => x.textContent === 'Edit'));
    await until(() => b.button('Email a password link'));
    smtp2.messages.length = 0;
    b.click(b.button('Email a password link'));
    await until(() => /password link is on its way to ivy@example\.com/.test(b.text()));
    await until(() => smtp2.messages.length === 1);
    assert.deepEqual(b.errors, []);
    b.close();
  } finally {
    await node.ctx.settings.update('mail', { values: { transport: 'none' } });
    await smtp2.close();
  }
});

test('Menu: opening a screen by its address expands its group; groups with nothing allowed disappear', async () => {
  const role = await node.ctx.users.createRole(
    { name: 'Auditor', permissions: ['admin.access', 'audit.read'] },
    null,
  );
  await node.ctx.users.createUser(
    {
      email: 'auditor@example.com',
      name: 'Au Ditor',
      password: 'Some-long-pass-12',
      roleId: Number(role.id),
    },
    null,
  );

  const admin = await openAdmin(node.url, { path: '/admin#/users' });
  await admin.signIn(ADMIN.email, ADMIN.password);
  await until(() => admin.$('.nav-sub-link.active'));
  assert.equal(admin.$('.nav-sub-link.active').textContent.trim(), 'Users');
  assert.equal(admin.button('Security').getAttribute('aria-expanded'), 'true', 'its group is open');
  assert.equal(admin.button('Operations').getAttribute('aria-expanded'), 'false');
  admin.close();

  const b = await openAdmin(node.url);
  await b.signIn('auditor@example.com', 'Some-long-pass-12');
  const shown = () => b.$$('.nav-link-x').map((a) => a.textContent.trim());
  await until(() => shown().includes('Logs'));
  assert.ok(!shown().includes('Operations'), 'no Operations permissions, no Operations group');
  assert.ok(!shown().includes('Settings'));
  // audit.read alone (no users.read/roles.read) leaves Security with nothing to show — Audit log lives in
  // Logs now (D-059), so Security doesn't render as a group at all for this role.
  assert.ok(
    !shown().includes('Security'),
    'audit.read moved to Logs, so Security has no visible items',
  );
  b.click(b.button('Logs'));
  await until(() => b.$$('.nav-sub').some(b.visible));
  assert.deepEqual(
    b
      .$$('.nav-sub')
      .filter(b.visible)
      .flatMap((g) => [...g.querySelectorAll('.nav-sub-link')])
      .map((a) => a.textContent.trim()),
    ['Audit log'],
  );
  b.go('#/updates'); // a screen this user can't open falls back to the overview
  await until(() => /Config version|What's running/.test(b.text()));
  assert.ok(!b.$('section[x-data="updatesPage"]'));
  b.close();
});
