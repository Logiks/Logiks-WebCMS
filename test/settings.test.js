import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startNode, tmpDb } from './helpers.js';

const db = tmpDb();
let node;
let s;
before(async () => {
  node = await startNode({ dbUrl: db.url });
  s = node.ctx.settings;
});
after(async () => {
  await node.close();
  db.cleanup();
});

test('serves code defaults before anything is saved; lookups are synchronous', () => {
  assert.equal(s.get('general.site_name'), 'My Site');
  assert.equal(s.get('security.session_ttl_hours'), 12);
  assert.throws(() => s.get('general.nope'), /Unknown setting/);
});

test('update persists, bumps the version, and applies immediately', async () => {
  const before = s.version;
  const out = await s.update('general', { values: { site_name: 'Acme', maintenance_mode: true } });
  assert.deepEqual(out.changed.sort(), ['maintenance_mode', 'site_name']);
  assert.equal(out.version, before + 1);
  assert.equal(s.get('general.site_name'), 'Acme');
  assert.equal(s.version, before + 1);
});

test('no-op writes change nothing and do not bump the version', async () => {
  const v = s.version;
  const out = await s.update('general', { values: { site_name: 'Acme' } });
  assert.deepEqual(out.changed, []);
  assert.equal(s.version, v);
});

test('validation errors are 422 with a readable message', async () => {
  await assert.rejects(
    s.update('general', { values: { timezone: 'Mars/Base' } }),
    (e) => e.status === 422 && /timezone/i.test(e.message),
  );
  await assert.rejects(
    s.update('security', { values: { session_ttl_hours: 0 } }),
    (e) => e.status === 422,
  );
  await assert.rejects(
    s.update('general', { values: { site_url: 'not a url' } }),
    (e) => e.status === 422,
  );
  await assert.rejects(s.update('general', { values: { nope: 1 } }), (e) => e.status === 404);
});

test('a failed batch is atomic: nothing partially applied', async () => {
  const v = s.version;
  await assert.rejects(s.update('general', { values: { tagline: 'ok', timezone: 'bad/zone' } }));
  assert.equal(s.get('general.tagline'), '');
  assert.equal(s.version, v);
});

test('optimistic locking: stale version → 409 and no write', async () => {
  const cur = s.describe('general').state.site_name.version;
  await s.update('general', { values: { site_name: 'Acme 2' }, versions: { site_name: cur } });
  await assert.rejects(
    s.update('general', { values: { site_name: 'Acme 3' }, versions: { site_name: cur } }),
    (e) => e.status === 409 && e.code === 'version_conflict',
  );
  assert.equal(s.get('general.site_name'), 'Acme 2');
});

test('secrets are encrypted at rest, decrypt for code, and never appear in the API view', async () => {
  await s.update('mail', { values: { password: 'hunter2-s3cret' } });
  assert.equal(s.get('mail.password'), 'hunter2-s3cret');
  const row = await node.ctx.db('settings').where({ namespace: 'mail', name: 'password' }).first();
  assert.match(row.value, /^enc:v1:/);
  assert.ok(!row.value.includes('hunter2'));
  const view = JSON.stringify(s.describeAll());
  assert.ok(!view.includes('hunter2'));
  assert.equal(s.describe('mail').state.password.isSet, true);
  const revs = JSON.stringify(await s.revisions({ namespace: 'mail' }));
  assert.ok(!revs.includes('hunter2'));
  const audit = JSON.stringify(await node.ctx.audit.list({ limit: 50 }));
  assert.ok(!audit.includes('hunter2'));
});

test('secret changes need settings.secrets.write', async () => {
  const limited = { id: 1, email: 'x@y.z', can: (p) => p !== 'settings.secrets.write' };
  await assert.rejects(
    s.update('mail', { values: { password: 'nope' } }, limited),
    (e) => e.status === 403,
  );
});

test('the session secret was generated once, encrypted, and is hidden', async () => {
  const secret = s.get('security.session_secret');
  assert.ok(secret.length >= 64);
  const row = await node.ctx
    .db('settings')
    .where({ namespace: 'security', name: 'session_secret' })
    .first();
  assert.match(row.value, /^enc:v1:/);
  assert.ok(!s.describe('security').fields.some((f) => f.key === 'session_secret'));
  await assert.rejects(
    s.update('security', { values: { session_secret: 'x' } }),
    (e) => e.status === 404,
  );
});

test('reset reverts to the default; history can restore a previous value', async () => {
  await s.update('general', { values: { tagline: 'first' } });
  await s.update('general', { values: { tagline: 'second' } });
  const revs = await s.revisions({ namespace: 'general', limit: 5 });
  const last = revs.find((r) => r.key === 'tagline' && r.to === 'second');
  await s.rollback(last.id, null);
  assert.equal(s.get('general.tagline'), 'first');
  await s.update('general', { reset: ['tagline'] });
  assert.equal(s.get('general.tagline'), '');
  assert.equal(s.describe('general').state.tagline.source, 'default');
});

test('secret history cannot be restored', async () => {
  const rev = (await s.revisions({ namespace: 'mail' })).find((r) => r.secret);
  await assert.rejects(s.rollback(rev.id, null), (e) => e.status === 422);
});

test('onChange hooks fire with new and previous values', async () => {
  const seen = [];
  const off = s.onChange('features', (next, prev) => seen.push([prev.commerce, next.commerce]));
  await s.update('features', { values: { commerce: true } });
  off();
  await s.update('features', { values: { commerce: false } });
  assert.deepEqual(seen, [[false, true]]);
});

test('environment overrides win, lock the field, and reject edits', async () => {
  const n = await startNode({ dbUrl: db.url, env: {} });
  n.ctx.settings.envSource = { CFG__general__site_name: 'From Env' };
  await n.ctx.settings._applyVersion(-1, null);
  assert.equal(n.ctx.settings.get('general.site_name'), 'From Env');
  assert.equal(n.ctx.settings.describe('general').state.site_name.locked, true);
  await assert.rejects(
    n.ctx.settings.update('general', { values: { site_name: 'x' } }),
    (e) => e.code === 'locked_by_env',
  );
  await n.close();
});

test('connection test runs against draft values without saving', async () => {
  const r = await s.runTest('mail', 'connect', { host: '' });
  assert.equal(r.ok, false);
  assert.match(r.message, /host/i);
  assert.equal(s.get('mail.host'), '');
});

test('login page branding: defaults, the media hint reaches the API view, and custom CSS is checked', async () => {
  assert.equal(s.get('login.logo'), 0);
  assert.equal(s.get('login.background_type'), 'default');
  assert.equal(s.describe('login').fields.find((f) => f.key === 'logo').media, true);
  assert.equal(s.describe('login').fields.find((f) => f.key === 'welcome_heading').media, false);
  for (const css of [
    'a{}</style><script>alert(1)</script>',
    '@import url(https://evil.example/x.css);',
    'a{background:url(javascript:alert(1))}',
    'a{behavior:url(x.htc)}',
  ]) {
    await assert.rejects(
      s.update('login', { values: { custom_css: css } }),
      (e) => e.status === 422,
      css,
    );
  }
  await s.update('login', {
    values: { welcome_heading: 'Welcome back', custom_css: '.login-side{opacity:.9}' },
  });
  assert.equal(s.get('login.welcome_heading'), 'Welcome back');
});
