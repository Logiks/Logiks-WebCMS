import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b;
before(async () => {
  node = await makeNode();
  const db = node.ctx.db;
  await db.schema.createTable('do_orders', (t) => {
    t.increments('id');
    t.string('customer', 50).notNullable();
  });
  await db('do_orders').insert([{ customer: 'Acme' }, { customer: 'Zed' }]);
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 10000, every: 50 });
const sec = () => b.$('section[x-data="systemPage"]');
const state = () => b.win.Alpine.$data(sec());
const type = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
};
const button = (t) => [...sec().querySelectorAll('button')].find((x) => x.textContent.trim() === t);

test('Operations → System shows the database, and erasing takes two steps, typed words and the password', async () => {
  b.go('#/system');
  await wait(() => sec() && state().db);
  assert.match(sec().textContent, /Size on disk/);
  assert.ok(state().db.tables > 10);

  b.click(button('Erase data…'));
  await wait(() => state().fl.open && state().fl.candidates.length);
  // choose one table
  b.click(sec().querySelector('#fl-some'));
  await wait(() => state().fl.mode === 'tables');
  const box = sec().querySelector('#fl-t-do_orders');
  box.checked = true;
  box.dispatchEvent(new b.win.Event('change', { bubbles: true }));
  await wait(() => state().fl.picked.includes('do_orders'));
  b.click(button('Review what will be erased'));
  await wait(() => state().fl.step === 2 && state().fl.ch);
  const phrase = state().fl.ch.phrase;
  assert.match(phrase, /^ERASE-/);

  const go = () => button('Erase these records');
  assert.equal(go().disabled, true, 'locked until the words, password and the tick are given');
  type(sec().querySelector('#fl-phrase'), phrase);
  type(sec().querySelector('#fl-pass'), ADMIN.password);
  await wait(() => go().disabled === true);
  sec().querySelector('#fl-ack').click();
  await wait(() => go().disabled === false);

  // a wrong password is refused with a message, nothing is erased
  type(sec().querySelector('#fl-pass'), 'wrong-password');
  b.click(go());
  await wait(() => /password is not right/.test(state().fl.error));
  assert.equal((await node.ctx.db('do_orders')).length, 2);

  type(sec().querySelector('#fl-pass'), ADMIN.password);
  b.click(go());
  await wait(async () => (await node.ctx.db('do_orders')).length === 0);
  await wait(() => state().fl.last && !state().fl.open);
  assert.match(sec().textContent, /One step back/);

  // one step back
  b.win.confirm = () => true;
  b.click(button('Put the erased records back'));
  await wait(async () => (await node.ctx.db('do_orders')).length === 2);
});
