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
after(() => {
  b.close();
  return node.close();
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const sec = () => b.$('section[x-data="promptsPage"]');
const tab = (name) =>
  [...sec().querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === name);
const submit = () =>
  sec()
    .querySelector('form')
    .dispatchEvent(new b.win.Event('submit', { bubbles: true, cancelable: true }));
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
};

test('Prompts has a tab per kind, each with its own explanation; Master prompt opens straight in the editor', async () => {
  b.go('#/prompts');
  await wait(() => sec() && sec().querySelectorAll('[role="tab"]').length === 5);
  assert.deepEqual(
    [...sec().querySelectorAll('[role="tab"]')].map((x) => x.textContent.trim()),
    ['Master prompt', 'Working method', 'Project types', 'Rules', 'Preview'],
  );
  await wait(() =>
    /quality standard/.test(b.$('section[x-data="promptsPage"] > p.small').textContent),
  );
  await wait(
    () => sec().querySelector('#pr-body') && /./.test(sec().querySelector('#pr-body').value),
  );
  assert.match(sec().querySelector('#pr-label').value, /Master prompt/);

  b.click(tab('Working method'));
  await wait(() => /How a request is handled/.test(sec().querySelector('p.small').textContent));
  await wait(() => sec().querySelectorAll('.list-group-item').length === 3);

  b.click(tab('Rules'));
  await wait(() => /one area/.test(sec().querySelector('p.small').textContent));
  await wait(() =>
    [...sec().querySelectorAll('.list-group-item')].some((x) =>
      x.textContent.includes('database tables'),
    ),
  );
});

test('Project types: edit one, and the Preview tab shows what the assistant is told, including ticked rule areas', async () => {
  b.click(tab('Project types'));
  await wait(() =>
    [...sec().querySelectorAll('.list-group-item')].some((x) =>
      x.textContent.includes('Online shop'),
    ),
  );
  const row = [...sec().querySelectorAll('.list-group-item')].find((x) =>
    x.textContent.includes('Online shop'),
  );
  b.click(row);
  await wait(() => sec().querySelector('#pr-body'));
  const body = sec().querySelector('#pr-body');
  assert.match(body.value, /Online shop/);
  type(body, `${body.value}\nAlways show prices including tax.`);
  submit();
  await wait(async () => (await node.ctx.prompts.get('project.ecommerce')).edited);

  b.click(tab('Preview'));
  await wait(() => sec().querySelector('#pr-prev-type'));
  const sel = sec().querySelector('#pr-prev-type');
  sel.value = 'ecommerce';
  sel.dispatchEvent(new b.win.Event('change', { bubbles: true }));
  const topic = sec().querySelector('#pr-topic-tables');
  topic.checked = true;
  topic.dispatchEvent(new b.win.Event('change', { bubbles: true }));
  b.click([...sec().querySelectorAll('button')].find((x) => x.textContent === 'Show'));
  await wait(() => /including tax/.test(sec().querySelector('pre').textContent));
  assert.match(sec().querySelector('pre').textContent, /Rules: Database tables/);
});

test('Rules: a new rule set for another area can be added from its tab', async () => {
  b.click(tab('Rules'));
  await wait(() =>
    [...sec().querySelectorAll('button')].some((x) => x.textContent.trim() === 'New rule set'),
  );
  b.click(
    [...sec().querySelectorAll('button')].find((x) => x.textContent.trim() === 'New rule set'),
  );
  await wait(() => sec().querySelector('#pr-area'));
  type(sec().querySelector('#pr-label'), 'Rules: pages');
  type(sec().querySelector('#pr-body'), 'Every page ends with a call to action.');
  submit();
  await wait(
    async () => (await node.ctx.prompts.get('rules.pages').catch(() => null))?.kind === 'rules',
  );
});
