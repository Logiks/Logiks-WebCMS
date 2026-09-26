import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b;
const wait = (fn) => until(fn, { timeout: 8000, every: 50 });

before(async () => {
  node = await makeNode();
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  await node.ctx.analytics.record({
    surface: 'public',
    type: 'pageview',
    sessionToken: 'ui-sess-1',
    path: '/hello',
    userAgent: 'Mozilla/5.0 (iPhone)',
  });
  await node.ctx.analytics.record({
    surface: 'admin',
    type: 'pageview',
    sessionToken: 'ui-admin-sess-1',
    userId: 1,
    path: '#/overview',
  });
});
after(async () => {
  b.close();
  await node.close();
});

test('Analytics is in the menu, near Content, with five screens', async () => {
  b.go('#/overview');
  const navText = () => `${b.$$('.nav-link-x').map((a) => a.textContent.trim())}`;
  await wait(() => /Analytics/.test(navText()));
  b.click(b.button('Analytics'));
  await wait(() => /Page Analytics/.test(navText()));
  assert.match(navText(), /Active Now/);
  assert.match(navText(), /Sessions/);
  assert.match(navText(), /User-wise Analytics/);
});

// Every screen mounts the same component (`analyticsPage('<tab>')`), and jsdom keeps the previous route's DOM
// around briefly after a hash change, so each test must select ITS OWN tab's instance, never a bare prefix match.
const pageFor = (tab) => () => b.$(`section[x-data="analyticsPage('${tab}')"]`);

test('Overview shows totals, a default 30-day range, and a chart per KPI group', async () => {
  b.go('#/analytics-overview');
  const page = pageFor('overview');
  await wait(() => page() && /–/.test(page().textContent) === false);
  const tile = (label) =>
    [...page().querySelectorAll('.panel')].find((p) => p.textContent.includes(label));
  await wait(() => tile('Page views').querySelector('.bigver').textContent === '1');
  assert.equal(tile('Unique visitors').querySelector('.bigver').textContent, '1');
  assert.equal(tile('Clicks tracked').querySelector('.bigver').textContent, '0');

  // "From" defaults to ~30 days ago, not left blank (an unfiltered all-time report is not a useful dashboard default).
  const fromValue = page().querySelector('#an-from-1').value;
  const daysAgo = Math.round((Date.now() - new Date(fromValue).getTime()) / 86_400_000);
  assert.ok(daysAgo >= 28 && daysAgo <= 30, `expected ~29 days ago, got ${daysAgo}`);

  // Trend chart: one point for today, with both series drawn.
  const svg = page().querySelector('svg.chart-svg');
  assert.ok(svg, 'the trend chart renders');
  const [pageviewsLine, visitorsLine] = svg.querySelectorAll('polyline.chart-line');
  assert.ok(pageviewsLine.getAttribute('points'), 'page views line has a point');
  assert.ok(visitorsLine.getAttribute('points'), 'visitors line has a point');

  // Device donut: one segment (mobile, from the seeded iPhone user-agent), with a matching legend row.
  const segments = page().querySelectorAll('.donut-wrap circle');
  assert.equal(segments.length, 1);
  assert.match(page().querySelector('.legend.flex-column').textContent, /mobile/);

  // Top referrers: no referrer was recorded, so the only row is "Direct".
  const barRows = page().querySelectorAll('.bar-list-row');
  assert.equal(barRows.length, 1);
  assert.match(barRows[0].textContent, /Direct/);
});

test('Active Now shows the seeded session grouped by its current page', async () => {
  b.go('#/analytics-active');
  const page = () => b.$('section[x-data="analyticsActivePage"]');
  await wait(() => page() && page().querySelector('.bar-list-row'));
  assert.equal(page().querySelector('.bigver').textContent, '1');
  assert.match(page().querySelector('.bar-list-row').textContent, /\/hello/);
});

test('Page Analytics lists the page, page-wise', async () => {
  b.go('#/analytics-pages');
  const page = pageFor('pages');
  await wait(() => page() && page().querySelector('tbody tr'));
  assert.match(page().querySelector('tbody tr td').textContent, /\/hello/);
});

test('Sessions lists the session, with its device type', async () => {
  b.go('#/analytics-sessions');
  const page = pageFor('sessions');
  await wait(() => page() && page().querySelector('tbody tr'));
  assert.match(page().textContent, /mobile/);
});

test('User-wise Analytics defaults to the admin panel and shows the signed-in user', async () => {
  b.go('#/analytics-users');
  const page = pageFor('users');
  await wait(() => page() && page().querySelector('tbody tr'));
  assert.match(page().textContent, new RegExp(ADMIN.email));
});
