import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b;
before(async () => {
  node = await makeNode();
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  b.win.confirm = () => true;
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const page = () => b.$('section[x-data="aigovPage"]');
const button = (label) =>
  [...page().querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(label));
const tab = (name) =>
  [...page().querySelectorAll('[role=tab]')].find((t) => t.textContent === name);
const firsts = () => [...page().querySelectorAll('select[aria-label^="First model for"]')];

test('AI & data is in the System menu and opens with the three tabs', async () => {
  b.go('#/overview');
  await wait(() =>
    /AI & data/.test(
      b
        .$$('nav a, aside a')
        .map((a) => a.textContent)
        .join('|'),
    ),
  );
  b.go('#/aigov');
  await wait(() => page() && page().querySelector('[role=tablist]'));
  assert.deepEqual(
    [...page().querySelectorAll('[role=tab]')].map((t) => t.textContent.trim()),
    ['Settings', 'Models', 'Usage'],
  );
});

test('every task starts on Claude, and one click sends routed tasks back', async () => {
  b.click(tab('Models'));
  await wait(() => firsts().length >= 10);
  assert.ok(firsts().every((s) => s.value === 'default'));

  await node.ctx.aigov.saveProfile(
    {
      name: 'ollama',
      provider: 'openai-compatible',
      base_url: 'http://127.0.0.1:1/v1',
      model: 'llama3.1:8b',
    },
    null,
  );
  await node.ctx.aigov.saveRoutes({ translations: ['ollama', 'default'] }, null);
  b.go('#/overview');
  await wait(() => !page()); // the old screen must be gone, or the next wait reads its stale rows
  b.go('#/aigov');
  await wait(() => page() && page().querySelector('[role=tablist]'));
  b.click(tab('Models'));
  await wait(() => firsts().some((s) => s.value === 'ollama'));

  const reset = () => button('Send every task back to Claude');
  await wait(() => reset() && !reset().disabled);
  b.click(reset());
  await wait(() => Object.keys(node.ctx.aigov.routes()).length === 0);
  await wait(() => firsts().every((s) => s.value === 'default'));
});
