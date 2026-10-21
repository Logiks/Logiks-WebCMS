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
const sec = () => b.$('section[x-data="helpPage"]');
const shown = (el) => Boolean(el) && el.style.display !== 'none';

test('the menu has a Help group with the five entries, open to anyone who can sign in', async () => {
  const group = b.$$('.nav-group-btn').find((x) => x.textContent.includes('Help'));
  assert.ok(group, 'Help group');
  b.click(group);
  await wait(() => b.$$('.nav-sub-link').some((a) => a.textContent === 'Prompt library'));
  const labels = b.$$('.nav-sub-link').map((a) => a.textContent);
  for (const l of ['Administration', 'Support', 'Coding guide', 'AI prompting', 'Prompt library'])
    assert.ok(labels.includes(l), l);
});

test('a section lists its guides, a guide opens with its text, and the neighbour link moves on', async () => {
  b.go('#/help/coding');
  await wait(() => sec() && sec().querySelectorAll('.help-card').length >= 5);
  const card = [...sec().querySelectorAll('.help-card')].find((a) =>
    a.textContent.includes('Liquid in this CMS'),
  );
  assert.ok(card);
  b.click(card);
  await wait(() => /Output and escaping/.test(sec().querySelector('.help-doc')?.textContent ?? ''));
  assert.match(sec().querySelector('.help-doc').innerHTML, /<pre>/);
  assert.ok(sec().querySelector('.help-copy'), 'code samples get a copy button');
  const next = [...sec().querySelectorAll('article a.btn')].find(
    (a) => shown(a) && a.textContent.includes('→'),
  );
  assert.ok(next, 'a next guide');
  b.click(next);
  await wait(() =>
    /api\.posts|Getting data into the page/.test(
      sec().querySelector('.help-doc')?.textContent ?? '',
    ),
  );
});

test('search finds a guide from anywhere in Help and clearing it returns to the page', async () => {
  b.go('#/help/support');
  await wait(() => sec() && sec().querySelector('#help-q'));
  b.type(sec().querySelector('#help-q'), 'lockout');
  await wait(
    () => sec().querySelectorAll('section[aria-labelledby="help-res-h"] .list-group a').length >= 1,
  );
  assert.match(sec().querySelector('.list-group a').textContent, /\S/);
  b.click([...sec().querySelectorAll('button')].find((x) => x.textContent === 'Clear search'));
  await wait(
    () => !sec().querySelectorAll('section[aria-labelledby="help-res-h"] .list-group a').length,
  );
});

test('the prompt library filters, fills the blanks and shows the finished prompt', async () => {
  b.go('#/help/prompts');
  await wait(() => sec() && sec().querySelectorAll('.help-prompt').length >= 20);
  b.type(sec().querySelector('#help-pq'), 'site brief');
  await wait(() => sec().querySelectorAll('.help-prompt').length < 20);
  const mine = [...sec().querySelectorAll('.help-prompt')].find((p) =>
    p.textContent.includes('Write the site brief'),
  );
  assert.ok(mine, 'the filter keeps the matching prompt');
  b.click(mine.querySelector('.help-prompt-head'));
  await wait(() => sec().querySelector('.help-prompt input[type="text"]'));
  const inputs = [...sec().querySelectorAll('.help-prompt input[type="text"]')];
  assert.ok(inputs.length >= 5, 'one field per blank');
  b.type(inputs[0], 'Oakwood Joinery, a furniture workshop');
  await wait(() =>
    /Oakwood Joinery, a furniture workshop/.test(
      sec().querySelector('.help-prompt-body').textContent,
    ),
  );
  // Blanks left empty stay visible as [[Blank]].
  assert.match(sec().querySelector('.help-prompt-body').textContent, /\[\[Audience\]\]/);
  assert.ok(b.button('Copy prompt'));
  assert.deepEqual(b.errors, []);
});
