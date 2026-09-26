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
  await node.ctx.content.create(
    'page',
    { title: 'Widgets', status: 'draft', data: { body: { blocks: [] } } },
    null,
  );
});
after(async () => {
  b.close();
  await node.close();
});

test('Activity is in the Logs menu, alongside the general Audit log (D-059)', async () => {
  b.go('#/overview');
  const navText = () => `${b.$$('.nav-link-x').map((a) => a.textContent.trim())}`;
  await wait(() => /Logs/.test(navText()));
  b.click(b.button('Logs'));
  await wait(() => /Activity/.test(navText()));
  assert.match(navText(), /Audit log/);
});

test('shows a human-readable line for a content change, and never a security event', async () => {
  b.go('#/content-activity');
  const page = () => b.$('section[x-data="contentActivityPage"]');
  await wait(() => page() && page().querySelector('tbody tr'));
  assert.match(page().textContent, /Created/);
  assert.match(page().textContent, /Widgets/);
  assert.doesNotMatch(page().textContent, /auth\.login/);
});
