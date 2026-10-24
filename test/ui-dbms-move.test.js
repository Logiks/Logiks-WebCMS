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
const page = () => b.$('section[x-data="dbmsPage"]');

test('the copy screen is called "Copy database", and its connection string is visible with a Hide/Show toggle', async () => {
  b.go('#/dbms');
  await wait(
    () =>
      page() &&
      [...page().querySelectorAll('button')].some((x) => x.textContent.trim() === 'Copy database'),
  );
  assert.equal(
    [...page().querySelectorAll('button')].some((x) => x.textContent.trim() === 'Move database'),
    false,
    'the old name is gone',
  );
  b.click(
    [...page().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Copy database'),
  );
  await wait(() => page().querySelector('#mv-url'));
  assert.match(page().textContent, /Copy to another database/);
  const field = () => page().querySelector('#mv-url');
  assert.equal(
    field().getAttribute('type'),
    'text',
    'visible by default, so what was pasted can be checked',
  );
  assert.equal(field().getAttribute('autocomplete'), 'off');
  const toggle = () =>
    [...page().querySelectorAll('button')].find((x) =>
      ['Hide', 'Show'].includes(x.textContent.trim()),
    );
  b.click(toggle());
  await wait(() => field().getAttribute('type') === 'password');
  assert.equal(toggle().textContent.trim(), 'Show');
  b.click(toggle());
  await wait(() => field().getAttribute('type') === 'text');
});
