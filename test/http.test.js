import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { makeNode, signedIn, ADMIN, loopback } from './helpers.js';
import { securityHeaders } from '../src/core/http/securityHeaders.js';
import { createCsrf } from '../src/core/http/csrf.js';
import { dialect } from '../src/core/db/index.js';

let node;
before(async () => {
  node = await makeNode();
});
after(async () => {
  await node.close();
});

describe('health', () => {
  test('/healthz is liveness only; /readyz reports dependencies and flips to 503 when draining', async () => {
    assert.equal((await request(node.app).get('/healthz')).status, 200);
    const ready = await request(node.app).get('/readyz');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.checks.database, true);

    node.ctx.state.draining = true;
    const draining = await request(node.app).get('/readyz');
    assert.equal(draining.status, 503);
    assert.equal(draining.body.checks.draining, false);
    assert.equal(
      (await request(node.app).get('/healthz')).status,
      200,
      'liveness must stay green while draining',
    );
    node.ctx.state.draining = false;
  });
});

describe('authentication', () => {
  test('mutating requests without a CSRF token are rejected', async () => {
    const res = await request(node.app).post('/api/auth/login').send(ADMIN);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'bad_csrf');
  });

  test('admin API requires a session', async () => {
    assert.equal((await request(node.app).get('/api/admin/settings')).status, 401);
    assert.equal((await request(node.app).get('/api/auth/me')).status, 401);
  });

  test('bad credentials give one generic message for unknown user and wrong password', async () => {
    const agent = request.agent(node.app);
    const { body } = await agent.get('/api/auth/csrf');
    const a = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', body.csrfToken)
      .send({ email: 'nobody@example.com', password: 'whatever-123' });
    const b = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', body.csrfToken)
      .send({ email: ADMIN.email, password: 'wrong-password' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error.message, b.body.error.message);
  });

  test('session cookie is HttpOnly + SameSite and the session id changes on login', async () => {
    const agent = request.agent(node.app);
    const { body, headers } = await agent.get('/api/auth/csrf');
    const before = headers['set-cookie'].find((c) => c.startsWith('cms.sid'));
    const res = await agent.post('/api/auth/login').set('x-csrf-token', body.csrfToken).send(ADMIN);
    const after = res.headers['set-cookie'].find((c) => c.startsWith('cms.sid'));
    assert.match(after, /HttpOnly/i);
    assert.match(after, /SameSite=Lax/i);
    assert.notEqual(
      before.split(';')[0],
      after.split(';')[0],
      'session fixation: id must be regenerated',
    );
    assert.equal(res.body.user.email, ADMIN.email);
  });

  test('repeated failures lock the account, even against the right password', async () => {
    const n = await makeNode({ env: {} });
    try {
      const agent = request.agent(n.app);
      const { body } = await agent.get('/api/auth/csrf');
      const login = (password) =>
        agent
          .post('/api/auth/login')
          .set('x-csrf-token', body.csrfToken)
          .send({ email: ADMIN.email, password });
      for (let i = 0; i < 5; i++) assert.equal((await login('nope-nope-nope')).status, 401);
      const locked = await login(ADMIN.password);
      assert.equal(locked.status, 423);
      assert.match(locked.body.error.message, /Try again in/);
    } finally {
      await n.close();
    }
  });

  test('logout ends the session', async () => {
    const s = await signedIn(node.app);
    assert.equal((await s.get('/api/auth/me')).status, 200);
    assert.equal((await s.post('/api/auth/logout')).status, 200);
    assert.equal((await s.get('/api/auth/me')).status, 401);
  });
});

describe('settings API + RBAC', () => {
  test('admin reads and writes; response never contains secret values', async () => {
    const s = await signedIn(node.app);
    const put = await s
      .put('/api/admin/settings/mail')
      .send({ values: { host: 'smtp.example.com', password: 'hunter2-secret' } });
    assert.equal(put.status, 200);
    assert.ok(!JSON.stringify(put.body).includes('hunter2-secret'));
    assert.equal(put.body.settings.state.password.isSet, true);
    const all = await s.get('/api/admin/settings');
    assert.ok(!JSON.stringify(all.body).includes('hunter2-secret'));
    const audit = await s.get('/api/admin/audit');
    assert.ok(
      !JSON.stringify(audit.body).includes('hunter2-secret'),
      'secrets must not reach the audit log',
    );
    assert.ok(audit.body.entries.some((e) => e.action === 'settings.update'));
  });

  test('stale versions get 409, invalid values 422 with the field named', async () => {
    const s = await signedIn(node.app);
    const cur = (await s.get('/api/admin/settings/general')).body.state.tagline.version;
    await s
      .put('/api/admin/settings/general')
      .send({ values: { tagline: 'fresh' }, versions: { tagline: cur } });
    const stale = await s
      .put('/api/admin/settings/general')
      .send({ values: { tagline: 'stale' }, versions: { tagline: cur } });
    assert.equal(stale.status, 409);
    const bad = await s
      .put('/api/admin/settings/general')
      .send({ values: { timezone: 'Nope/Nope' } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.field, 'general.timezone');
  });

  test('a read-only role can view but not change settings, users or roles', async () => {
    const viewerRole = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
    await node.ctx.users.createUser(
      {
        email: 'viewer@example.com',
        name: 'Viewer',
        password: 'Viewer-pass-123',
        roleId: Number(viewerRole.id),
      },
      null,
    );
    const v = await signedIn(node.app, {
      email: 'viewer@example.com',
      password: 'Viewer-pass-123',
    });
    assert.equal((await v.get('/api/admin/settings')).status, 200);
    assert.equal(
      (await v.put('/api/admin/settings/general').send({ values: { site_name: 'Hacked' } })).status,
      403,
    );
    assert.equal(
      (
        await v
          .post('/api/admin/users')
          .send({ email: 'x@example.com', name: 'X', password: 'Xxxxxxxx-123', roleId: 1 })
      ).status,
      403,
    );
    assert.equal(
      (await v.post('/api/admin/roles').send({ name: 'Evil', permissions: ['*'] })).status,
      403,
    );
    assert.notEqual(node.ctx.settings.get('general.site_name'), 'Hacked');
  });

  test('role permission changes take effect immediately for signed-in users', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'Temp', permissions: ['admin.access', 'settings.read'] },
      null,
    );
    await node.ctx.users.createUser(
      { email: 'temp@example.com', name: 'Temp', password: 'Temp-pass-1234', roleId: role.id },
      null,
    );
    const t = await signedIn(node.app, { email: 'temp@example.com', password: 'Temp-pass-1234' });
    assert.equal((await t.get('/api/admin/settings')).status, 200);
    assert.equal((await t.get('/api/admin/audit')).status, 403);
    const admin = await signedIn(node.app);
    await admin
      .patch(`/api/admin/roles/${role.id}`)
      .send({ permissions: ['admin.access', 'audit.read'] });
    assert.equal((await t.get('/api/admin/audit')).status, 200);
    assert.equal((await t.get('/api/admin/settings')).status, 403);
  });

  test('connection test reports failure without saving anything', async () => {
    const s = await signedIn(node.app);
    const r = await s
      .post('/api/admin/settings/mail/tests/connect')
      .send({ values: { host: '127.0.0.1', port: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.notEqual(node.ctx.settings.get('mail.port'), 1);
  });

  test('audit log: date range and actor filters, and CSV/JSON export', async () => {
    const s = await signedIn(node.app);
    await s.put('/api/admin/settings/general').send({ values: { tagline: 'audit-filter-test' } });
    const to = Date.now() + 60_000;
    const from = to - 3_600_000;

    const byDate = await s.get(`/api/admin/audit?from=${from}&to=${to}`);
    assert.ok(byDate.body.entries.some((e) => e.action === 'settings.update'));
    const tooOld = await s.get(`/api/admin/audit?from=${from - 3_600_000}&to=${from}`);
    assert.ok(!tooOld.body.entries.some((e) => e.action === 'settings.update' && e.at >= from));

    const byActor = await s.get(`/api/admin/audit?actorEmail=${encodeURIComponent(ADMIN.email)}`);
    assert.ok(byActor.body.entries.length);
    assert.ok(byActor.body.entries.every((e) => e.actor === ADMIN.email));
    const wrongActor = await s.get('/api/admin/audit?actorEmail=nobody@example.com');
    assert.deepEqual(wrongActor.body.entries, []);

    const json = await s.get('/api/admin/audit/export?format=json');
    assert.equal(json.status, 200);
    assert.ok(json.body.entries.some((e) => e.action === 'settings.update'));

    const csv = await s.get('/api/admin/audit/export');
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /attachment; filename="audit-log\.csv"/);
    assert.match(csv.text, /^id,at,action,actor,entity,entityId,ip,meta/);
    assert.ok(!csv.text.includes('hunter2-secret'), 'secrets must not reach the export either');

    assert.equal((await request(node.app).get('/api/admin/audit/export')).status, 401);
  });
});

describe('users and roles safeguards', () => {
  test('cannot lock everyone out', async () => {
    const s = await signedIn(node.app);
    const me = s.user.id;
    const adminRole = (await s.get('/api/admin/roles')).body.roles.find(
      (r) => r.name === 'Administrator',
    );
    const viewerRole = (await s.get('/api/admin/roles')).body.roles.find(
      (r) => r.name === 'Viewer',
    );
    assert.equal(
      (await s.patch(`/api/admin/users/${me}`).send({ status: 'disabled' })).status,
      409,
    );
    assert.equal((await s.del(`/api/admin/users/${me}`)).status, 409);
    const demote = await s.patch(`/api/admin/users/${me}`).send({ roleId: viewerRole.id });
    assert.equal(demote.status, 409);
    assert.equal(demote.body.error.code, 'last_admin');
    assert.equal(
      (await s.patch(`/api/admin/roles/${adminRole.id}`).send({ permissions: ['admin.access'] }))
        .status,
      409,
    );
    assert.equal((await s.del(`/api/admin/roles/${adminRole.id}`)).status, 409);
  });

  test('input rules: unique email, password policy, valid permissions, role in use', async () => {
    const s = await signedIn(node.app);
    const roles = (await s.get('/api/admin/roles')).body.roles;
    const viewer = roles.find((r) => r.name === 'Viewer');
    const dup = await s.post('/api/admin/users').send({
      email: 'ADMIN@example.com',
      name: 'Dup',
      password: 'Long-enough-pw-1',
      roleId: viewer.id,
    });
    assert.equal(dup.status, 409);
    const weak = await s
      .post('/api/admin/users')
      .send({ email: 'weak@example.com', name: 'Weak', password: 'short', roleId: viewer.id });
    assert.equal(weak.status, 422);
    const badPerm = await s
      .post('/api/admin/roles')
      .send({ name: 'Bad', permissions: ['not.a.permission'] });
    assert.equal(badPerm.status, 422);
    const inUse = await s.del(`/api/admin/roles/${viewer.id}`);
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.error.code, 'role_in_use');
  });
});

describe('settings apply live, without a restart', () => {
  test('maintenance mode switches the public site; admin stays reachable', async () => {
    const s = await signedIn(node.app);
    assert.equal((await request(node.app).get('/')).status, 200);
    await s
      .put('/api/admin/settings/general')
      .send({ values: { maintenance_mode: true, maintenance_message: 'Back at 5 <b>pm</b>' } });
    const page = await request(node.app).get('/');
    assert.equal(page.status, 503);
    assert.ok(
      page.text.includes('Back at 5 &lt;b&gt;pm&lt;/b&gt;'),
      'message must be HTML-escaped',
    );
    assert.equal((await s.get('/api/admin/settings')).status, 200);
    assert.equal((await request(node.app).get('/healthz')).status, 200);
    await s.put('/api/admin/settings/general').send({ values: { maintenance_mode: false } });
    assert.equal((await request(node.app).get('/')).status, 200);
  });

  test('CSP and CORS follow settings', async () => {
    const s = await signedIn(node.app);
    await s.put('/api/admin/settings/security').send({
      values: {
        csp_img_sources: ['https://cdn.example.com'],
        cors_origins: ['https://shop.example.com'],
      },
    });
    const res = await request(node.app)
      .get('/api/public/info')
      .set('Origin', 'https://shop.example.com');
    assert.match(
      res.headers['content-security-policy'],
      /img-src 'self' data: https:\/\/cdn\.example\.com/,
    );
    assert.equal(res.headers['access-control-allow-origin'], 'https://shop.example.com');
    const other = await request(node.app)
      .get('/api/public/info')
      .set('Origin', 'https://evil.example.com');
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });

  test('/api/public/info exposes login-page branding, resolving media ids to urls', async () => {
    const s = await signedIn(node.app);
    const now = Date.now();
    const id = await dialect(node.ctx.db).insertGetId(node.ctx.db('media'), {
      filename: 'logo.png',
      mime: 'image/png',
      kind: 'image',
      size: 100,
      width: 40,
      height: 40,
      alt: '',
      hash: 'x',
      original_file: 'logo.png',
      variants: '[]',
      created_at: now,
      updated_at: now,
    });
    await s.put('/api/admin/settings/login').send({
      values: {
        logo: id,
        welcome_heading: 'Welcome back',
        background_type: 'color',
        background_color: '#111',
      },
    });
    const info = await request(node.app).get('/api/public/info');
    assert.equal(info.body.login.logoUrl, `/media/${id}/logo.png`);
    assert.equal(info.body.login.welcomeHeading, 'Welcome back');
    assert.equal(info.body.login.backgroundType, 'color');
    assert.equal(info.body.login.backgroundColor, '#111');
    assert.equal(info.body.login.faviconUrl, null);
    await s
      .put('/api/admin/settings/login')
      .send({ reset: ['logo', 'welcome_heading', 'background_type', 'background_color'] });
  });

  test('session cookie name is hot-swapped', async () => {
    const s = await signedIn(node.app);
    await s
      .put('/api/admin/settings/security')
      .send({ values: { session_cookie_name: 'renamed.sid' } });
    const agent = request.agent(node.app);
    const { headers } = await agent.get('/api/auth/csrf');
    assert.ok(headers['set-cookie'].some((c) => c.startsWith('renamed.sid=')));
    await s
      .put('/api/admin/settings/security')
      .send({ values: { session_cookie_name: 'cms.sid' } });
  });

  test('rate limits are read from settings on every request', async () => {
    const n = await makeNode();
    try {
      const s = await signedIn(n.app);
      await s.put('/api/admin/settings/security').send({ values: { rate_limit_per_minute: 10 } });
      let last;
      for (let i = 0; i < 14; i++) last = await request(n.app).get('/api/public/info');
      assert.equal(last.status, 429);
      assert.equal(last.body.error.code, 'rate_limited');
    } finally {
      await n.close();
    }
  });

  test('log level changes at runtime', async () => {
    const s = await signedIn(node.app);
    await s.put('/api/admin/settings/system').send({ values: { log_level: 'debug' } });
    assert.equal(node.ctx.log.level, 'debug');
    await s.put('/api/admin/settings/system').send({ reset: ['log_level'] });
    assert.equal(node.ctx.log.level, 'silent'); // back to LOG_LEVEL from env
  });
});

describe('security headers', () => {
  const headersFor = async (env, extra = {}) => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(securityHeaders(env, { csp_img_sources: [], csp_connect_sources: [] }));
    app.get('/', (_req, res) => res.send('ok'));
    return (await request(loopback(app)).get('/').set(extra)).headers;
  };

  test('production upgrades to https and sets HSTS only when the request came in over HTTPS', async () => {
    const viaAlb = await headersFor({ isProd: true }, { 'X-Forwarded-Proto': 'https' });
    assert.match(viaAlb['content-security-policy'], /upgrade-insecure-requests/);
    assert.ok(viaAlb['strict-transport-security']);

    // plain HTTP (local docker-compose, an HTTP-only staging box): upgrading would break every asset
    const plain = await headersFor({ isProd: true });
    assert.ok(!/upgrade-insecure-requests/.test(plain['content-security-policy']));
    assert.equal(plain['strict-transport-security'], undefined);
    assert.match(
      plain['content-security-policy'],
      /default-src 'self'/,
      'the rest of the policy stays',
    );
  });

  test('development never upgrades', async () => {
    const h = await headersFor({ isProd: false }, { 'X-Forwarded-Proto': 'https' });
    assert.ok(!/upgrade-insecure-requests/.test(h['content-security-policy']));
    assert.equal(h['strict-transport-security'], undefined);
  });
});

describe('csrf cookie', () => {
  const appFor = (isProd) => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(cookieParser());
    app.use((req, _res, next) => {
      req.session = { id: 'sess-1' };
      next();
    });
    const csrf = createCsrf({ settings: { get: () => 'x'.repeat(40) }, env: { isProd } });
    app.get('/t', (req, res) => res.json({ token: csrf.generateCsrfToken(req, res) }));
    app.use(csrf.doubleCsrfProtection);
    app.post('/p', (_req, res) => res.json({ ok: true }));
    return loopback(app);
  };
  const cookieOf = (res) => res.headers['set-cookie'].find((c) => c.startsWith('cms.csrf='));

  test('production marks the cookie Secure only over HTTPS, so plain-HTTP sign-in still works', async () => {
    const app = appFor(true);
    const https = await request(app).get('/t').set('X-Forwarded-Proto', 'https');
    assert.match(cookieOf(https), /; Secure/);
    const plain = await request(app).get('/t');
    assert.ok(!/; Secure/.test(cookieOf(plain)), 'a Secure cookie would be dropped on http://');

    // the double-submit round trip works on plain HTTP...
    const agent = request.agent(app);
    const { token } = (await agent.get('/t')).body;
    assert.equal((await agent.post('/p').set('x-csrf-token', token)).status, 200);
    assert.equal((await agent.post('/p').set('x-csrf-token', 'wrong')).status, 403);
    // ...and tokens are interchangeable between the two variants (any node, any hop)
    assert.equal(
      (await agent.post('/p').set('x-csrf-token', token).set('X-Forwarded-Proto', 'https')).status,
      200,
    );
  });

  test('development never sets Secure', async () => {
    const res = await request(appFor(false)).get('/t').set('X-Forwarded-Proto', 'https');
    assert.ok(!/; Secure/.test(cookieOf(res)));
  });
});
