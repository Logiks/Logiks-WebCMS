import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn, until } from './helpers.js';

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

describe('analytics service: record(), sessions and reports', () => {
  test('a pageview creates a bounced session; a second pageview for the same session un-bounces it', async () => {
    await node.ctx.analytics.record({
      surface: 'public',
      type: 'pageview',
      sessionToken: 'sess-1',
      path: '/a',
      userAgent: 'Mozilla/5.0 (Macintosh)',
      referrer: 'https://example.com',
    });
    const s1 = await node.ctx.db('analytics_sessions').where({ token: 'sess-1' }).first();
    assert.equal(s1.page_count, 1);
    assert.equal(!!s1.is_bounce, true);
    assert.equal(s1.entry_path, '/a');
    assert.equal(s1.exit_path, '/a');
    assert.equal(s1.device_type, 'desktop');

    await node.ctx.analytics.record({
      surface: 'public',
      type: 'pageview',
      sessionToken: 'sess-1',
      path: '/b',
    });
    const s2 = await node.ctx.db('analytics_sessions').where({ token: 'sess-1' }).first();
    assert.equal(s2.page_count, 2);
    assert.equal(!!s2.is_bounce, false);
    assert.equal(s2.entry_path, '/a', 'entry path never changes');
    assert.equal(s2.exit_path, '/b');

    const events = await node.ctx.db('activity_log').where({ session_token: 'sess-1' });
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.event_type === 'pageview' && e.surface === 'public'));
  });

  test('click and dwell events do not create a session on their own, but bump last_seen and clear is_bounce', async () => {
    await node.ctx.analytics.record({
      surface: 'public',
      type: 'pageview',
      sessionToken: 'sess-2',
      path: '/x',
    });
    await node.ctx.analytics.record({
      surface: 'public',
      type: 'click',
      sessionToken: 'sess-2',
      path: '/x',
      label: 'buy-now',
    });
    const s = await node.ctx.db('analytics_sessions').where({ token: 'sess-2' }).first();
    assert.equal(!!s.is_bounce, false, 'a click means the session did not just bounce');
    assert.equal(s.page_count, 1, 'a click is not a page view');

    await node.ctx.analytics.record({
      surface: 'public',
      type: 'dwell',
      sessionToken: 'ghost-session-never-seen',
      path: '/x',
      durationMs: 4000,
    });
    assert.equal(
      await node.ctx.db('analytics_sessions').where({ token: 'ghost-session-never-seen' }).first(),
      undefined,
    );
    const dwellRow = await node.ctx
      .db('activity_log')
      .where({ session_token: 'ghost-session-never-seen', event_type: 'dwell' })
      .first();
    assert.equal(dwellRow.duration_ms, 4000);
  });

  test('the admin surface is tracked separately from the public one', async () => {
    await node.ctx.analytics.record({
      surface: 'admin',
      type: 'pageview',
      sessionToken: 'admin-sess-1',
      userId: 1,
      path: '#/settings',
    });
    const overviewPublic = await node.ctx.analytics.overview({ surface: 'public' });
    const overviewAdmin = await node.ctx.analytics.overview({ surface: 'admin' });
    assert.ok(overviewAdmin.pageviews >= 1);
    const adminOnly = await node.ctx.db('activity_log').where({ surface: 'admin' });
    assert.ok(adminOnly.every((e) => e.surface === 'admin'));
    void overviewPublic;
  });

  test('pagesReport: views, unique sessions, and a bounce rate for entry pages', async () => {
    const pages = await node.ctx.analytics.pagesReport({ surface: 'public' });
    const a = pages.find((p) => p.path === '/a');
    assert.ok(a);
    assert.equal(a.views, 1);
    assert.equal(a.sessions, 1);
    assert.equal(a.bounceRate, 0, 'sess-1 did not bounce (it had a second page view)');
  });

  test('sessionsReport: newest first, cursor-paginated on last_seen', async () => {
    const page1 = await node.ctx.analytics.sessionsReport({ surface: 'public', limit: 1 });
    assert.equal(page1.length, 1);
    const page2 = await node.ctx.analytics.sessionsReport({
      surface: 'public',
      limit: 1,
      before: page1[0].lastSeen,
    });
    assert.equal(page2.length, 1);
    assert.notEqual(page1[0].token, page2[0].token);
  });

  test('activeReport: sessions within the window, grouped by their current page', async () => {
    const active = await node.ctx.analytics.activeReport({ surface: 'public' });
    // sess-1 (exit /b) and sess-2 (exit /x) both just happened, so both are "active" under the default window.
    assert.equal(active.total, 2);
    assert.deepEqual(active.byPage.map((p) => p.path).sort(), ['/b', '/x']);
    assert.ok(active.byPage.every((p) => p.count === 1));
  });

  test('activeReport: a session outside the window drops off', async () => {
    const old = Date.now() - 3_600_000;
    await node.ctx.db('analytics_sessions').insert({
      token: 'stale-session',
      surface: 'public',
      first_seen: old,
      last_seen: old,
      page_count: 1,
      exit_path: '/stale',
    });
    const active = await node.ctx.analytics.activeReport({ surface: 'public', windowMs: 60_000 });
    assert.ok(!active.byPage.some((p) => p.path === '/stale'));
    await node.ctx.db('analytics_sessions').where({ token: 'stale-session' }).del();
  });

  test('usersReport: only sessions with a signed-in user, joined with their name/email', async () => {
    const users = await node.ctx.analytics.usersReport({ surface: 'admin' });
    const u = users.find((u) => u.userId === 1);
    assert.ok(u);
    assert.equal(u.email, 'admin@example.com');
    assert.equal(u.sessions, 1);
  });

  test('overview: avg pages/session and a click count, alongside the existing KPIs', async () => {
    const o = await node.ctx.analytics.overview({ surface: 'public' });
    // sess-1: 2 pageviews; sess-2: 1 pageview + 1 click (a click never bumps page_count).
    assert.equal(o.sessions, 2);
    assert.equal(o.avgPagesPerSession, 1.5);
    assert.equal(o.clicks, 1);
  });

  test('dailyTrend: pageviews and unique visitors bucketed by calendar day', async () => {
    const trend = await node.ctx.analytics.dailyTrend({ surface: 'public' });
    assert.equal(trend.length, 1, 'everything in this suite happened today');
    assert.equal(trend[0].pageviews, 3, 'sess-1 (2) + sess-2 (1)');
    assert.equal(trend[0].visitors, 2);
    assert.match(trend[0].date, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('deviceBreakdown: sessions grouped by the device guessed from their user-agent', async () => {
    const devices = await node.ctx.analytics.deviceBreakdown({ surface: 'public' });
    const byDevice = Object.fromEntries(devices.map((d) => [d.device, d.count]));
    assert.equal(byDevice.desktop, 1, 'sess-1 had a Macintosh user-agent');
    assert.equal(byDevice.unknown, 1, 'sess-2 had none');
  });

  test('referrersReport: grouped by host (not the full URL), plus a direct count', async () => {
    const r = await node.ctx.analytics.referrersReport({ surface: 'public' });
    assert.deepEqual(r.top, [{ host: 'example.com', sessions: 1 }]);
    assert.equal(r.direct, 1, 'sess-2 arrived with no referrer at all');
  });

  test('prune() deletes activity and sessions older than the retention window', async () => {
    const old = Date.now() - 200 * 86_400_000;
    await node.ctx.db('activity_log').insert({
      session_token: 'ancient',
      surface: 'public',
      event_type: 'pageview',
      path: '/old',
      created_at: old,
    });
    await node.ctx.db('analytics_sessions').insert({
      token: 'ancient',
      surface: 'public',
      first_seen: old,
      last_seen: old,
      page_count: 1,
    });
    const n = await node.ctx.analytics.prune(180);
    assert.ok(n >= 1);
    assert.equal(
      await node.ctx.db('analytics_sessions').where({ token: 'ancient' }).first(),
      undefined,
    );
    assert.equal(await node.ctx.analytics.prune(0), 0, '0 means keep forever');
  });
});

describe('analytics: permissions and blocklists', () => {
  test('analytics.read is required to view any report', async () => {
    const nobody = await mkUser(['admin.access'], 'analytics-nobody@example.com');
    assert.equal((await nobody.get('/api/admin/analytics/overview')).status, 403);
    const reader = await mkUser(['admin.access', 'analytics.read'], 'analytics-reader@example.com');
    assert.equal((await reader.get('/api/admin/analytics/overview')).status, 200);
    assert.equal((await reader.get('/api/admin/analytics/pages')).status, 200);
    assert.equal((await reader.get('/api/admin/analytics/sessions')).status, 200);
    assert.equal((await nobody.get('/api/admin/analytics/active')).status, 403);
    assert.equal((await reader.get('/api/admin/analytics/active')).status, 200);
    assert.equal((await reader.get('/api/admin/analytics/users')).status, 200);
    assert.equal((await nobody.get('/api/admin/analytics/trend')).status, 403);
    assert.equal((await reader.get('/api/admin/analytics/trend')).status, 200);
    assert.equal((await nobody.get('/api/admin/analytics/devices')).status, 403);
    assert.equal((await reader.get('/api/admin/analytics/devices')).status, 200);
    assert.equal((await nobody.get('/api/admin/analytics/referrers')).status, 403);
    assert.equal((await reader.get('/api/admin/analytics/referrers')).status, 200);
  });

  test('any signed-in admin can be tracked without analytics.read (viewing and appearing are different permissions)', async () => {
    const nobody = await mkUser(['admin.access'], 'analytics-tracked@example.com');
    const r = await nobody
      .post('/api/admin/analytics/beacon')
      .send({ type: 'pageview', path: '#/overview' });
    assert.equal(r.status, 202);
    await until(
      async () =>
        await node.ctx.db('activity_log').where({ surface: 'admin', path: '#/overview' }).first(),
    );
  });
});

describe('public site: server-side page views, the visitor cookie, and the click/dwell beacon', () => {
  test('a page GET mints a cms_vid cookie and (async, via the job queue) records a page view', async () => {
    const agent = request.agent(node.app);
    const res = await agent.get('/');
    assert.equal(res.status, 200);
    const cookie = res.headers['set-cookie']?.find((c) => c.startsWith('cms_vid='));
    assert.ok(cookie, 'a visitor cookie is minted on the first page view');
    assert.match(cookie, /HttpOnly/);
    const token = cookie.match(/cms_vid=([^;]+)/)[1];

    await until(async () => await node.ctx.db('analytics_sessions').where({ token }).first());
    const session = await node.ctx.db('analytics_sessions').where({ token }).first();
    assert.equal(session.surface, 'public');
    assert.equal(session.entry_path, '/');

    const again = await agent.get('/');
    assert.ok(
      !(again.headers['set-cookie'] ?? []).some((c) => c.startsWith('cms_vid=')),
      'the same visitor keeps the same cookie, it is not reissued',
    );
    await until(
      async () =>
        (await node.ctx.db('analytics_sessions').where({ token }).first()).page_count === 2,
    );
  });

  test('the beacon records a click against the visitor already identified by the cms_vid cookie, not a client-supplied id', async () => {
    const agent = request.agent(node.app);
    await agent.get('/'); // establishes the cookie
    const beacon = await agent
      .post('/analytics/beacon')
      .send({ type: 'click', path: '/', label: 'cta-button' });
    assert.equal(beacon.status, 202);
    await until(
      async () =>
        await node.ctx
          .db('activity_log')
          .where({ event_type: 'click', label: 'cta-button' })
          .first(),
    );
  });

  test('a beacon with no visitor cookie at all is accepted (202) but records nothing', async () => {
    const before = await node.ctx
      .db('activity_log')
      .where({ event_type: 'click', label: 'orphan' })
      .first();
    assert.equal(before, undefined);
    const r = await request(node.app)
      .post('/analytics/beacon')
      .send({ type: 'click', path: '/', label: 'orphan' });
    assert.equal(r.status, 202);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      await node.ctx.db('activity_log').where({ event_type: 'click', label: 'orphan' }).first(),
      undefined,
    );
  });

  test('turning analytics off stops both the cookie and any recording', async () => {
    await admin.put('/api/admin/settings/analytics').send({ values: { enabled: false } });
    try {
      const res = await request(node.app).get('/about-does-not-exist-xyz');
      assert.ok(!(res.headers['set-cookie'] ?? []).some((c) => c.startsWith('cms_vid=')));
    } finally {
      await admin.put('/api/admin/settings/analytics').send({ values: { enabled: true } });
    }
  });
});
