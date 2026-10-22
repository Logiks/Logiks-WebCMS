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

const wait = (fn) => until(fn, { timeout: 10000, every: 50 });
const sec = () => b.$('section[x-data="backupPage"]');
const type = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
};
const button = (t) => [...sec().querySelectorAll('button')].find((x) => x.textContent.trim() === t);

test('Operations → Backups makes a backup, lists it, and restoring needs the typed word', async () => {
  b.go('#/backup');
  await wait(() => sec() && sec().querySelector('#bk-name'));
  type(sec().querySelector('#bk-name'), 'Before the redesign');
  b.click(button('Make a backup'));
  await wait(() => /Before the redesign/.test(sec().querySelector('tbody')?.textContent ?? ''));
  await wait(async () => (await node.ctx.backup.list())[0]?.status === 'ready');

  await wait(() => button('Restore…'));
  b.click(button('Restore…'));
  await wait(() => sec().querySelector('#bk-confirm'));
  const go = () => button('Restore this backup');
  assert.equal(go().disabled, true, 'locked until RESTORE is typed');
  type(sec().querySelector('#bk-confirm'), 'RESTORE');
  await wait(() => !go().disabled);
});
