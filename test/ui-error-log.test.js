import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b;
before(async () => {
  node = await makeNode();
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });

test('Log manager shows the most frequent server errors first when the log is opened', async () => {
  for (let i = 0; i < 3; i++)
    await node.ctx.errorLog.record({ source: 'job', job: 'ui.job', err: new Error('Flaky thing') });
  await node.ctx.errorLog.record({ source: 'http', err: new Error('Rare thing') });
  b.go('#/log-manager');
  const page = () => b.$('section[x-data="logManagerPage"]');
  const openBtn = () =>
    page() && [...page().querySelectorAll('button')].find((x) => x.textContent === 'Server errors');
  await wait(openBtn);
  b.click(openBtn());
  const rows = () => [...page().querySelectorAll('tbody')].flatMap((t) => [...t.rows]);
  await wait(() => rows().some((r) => /Flaky thing/.test(r.textContent) && b.visible(r)));
  const top = rows().find((r) => /Flaky thing/.test(r.textContent) && b.visible(r));
  assert.match(top.cells[0].textContent, /^3$/);
});

test('Logs → Server errors opens the errors directly, without the retention table', async () => {
  await node.ctx.errorLog.record({ source: 'http', err: new Error('Direct thing') });
  b.go('#/server-errors');
  const page = () => b.$('section[x-data="logManagerPage(\'errors\')"]');
  const rows = () => [...(page()?.querySelectorAll('tbody') ?? [])].flatMap((t) => [...t.rows]);
  await wait(() => rows().some((r) => /Direct thing/.test(r.textContent) && b.visible(r)));
  const hidden = (el) => el.closest('[x-show]')?.style.display === 'none';
  const h = (t) => [...page().querySelectorAll('h1')].find((x) => x.textContent === t);
  assert.ok(!hidden(h('Server errors')), 'its own heading shows');
  assert.ok(hidden(h('Log manager')), "the Log Manager's heading does not");
  const retention = [...page().querySelectorAll('th')].find((x) => /Keep for/.test(x.textContent));
  assert.ok(hidden(retention), 'the retention table stays on the Log Manager');
  assert.deepEqual(b.errors, []);
});

test('Text usage by user offers CSV and JSON downloads', async () => {
  b.go('#/ai-users-text');
  const links = () => [...b.$$('a[download]')].filter(b.visible).map((a) => a.getAttribute('href'));
  await wait(() => links().length === 2);
  assert.ok(
    links().some(
      (h) =>
        h.startsWith('/api/admin/ai-usage/export?') &&
        h.includes('format=csv') &&
        h.includes('kind=text'),
    ),
  );
  assert.ok(links().some((h) => h.includes('format=json')));
});
