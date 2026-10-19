import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b;
before(async () => {
  node = await makeNode();
  await node.ctx.prompts.ready();
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const sec = () => b.$('section[x-data="promptsPage"]');

test('System → Prompts lists the project types, edits one and previews what the assistant is told', async () => {
  b.go('#/prompts');
  await wait(() => sec() && sec().querySelectorAll('.list-group-item').length >= 9);
  const row = [...sec().querySelectorAll('.list-group-item')].find((x) =>
    x.textContent.includes('Online shop'),
  );
  b.click(row);
  await wait(() => sec().querySelector('#pr-body'));
  const body = sec().querySelector('#pr-body');
  assert.match(body.value, /Online shop/);
  body.value = `${body.value}\nAlways show prices including tax.`;
  body.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  sec()
    .querySelector('form')
    .dispatchEvent(new b.win.Event('submit', { bubbles: true, cancelable: true }));
  await wait(async () => (await node.ctx.prompts.get('project.ecommerce')).edited);
  await wait(() => sec().querySelector('#pr-prev-type'));
  const sel = sec().querySelector('#pr-prev-type');
  sel.value = 'ecommerce';
  sel.dispatchEvent(new b.win.Event('change', { bubbles: true }));
  const show = [...sec().querySelectorAll('button')].find((x) => x.textContent === 'Show');
  b.click(show);
  await wait(() => /including tax/.test(sec().querySelector('pre').textContent));
});
