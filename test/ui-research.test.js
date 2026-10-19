import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b;
before(async () => {
  node = await makeNode();
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  await node.ctx.research.create(
    {
      title: 'Odisha rice',
      topic: 'rice',
      summary: 'Grown in Odisha.',
      sources: [{ url: 'https://a.example/rice', title: 'Rice guide', note: 'main source' }],
    },
    null,
  );
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });

test('AI Research is under Content and shows saved research with its source links', async () => {
  b.go('#/research');
  await wait(() => b.$$('section[x-data="researchPage"] .list-group-item').length === 1);
  b.$('section[x-data="researchPage"] .list-group-item').click();
  await wait(() => b.$('section[x-data="researchPage"] article'));
  const link = b.$('section[x-data="researchPage"] article ol a');
  assert.equal(link.getAttribute('href'), 'https://a.example/rice');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.match(
    b.$('section[x-data="researchPage"] .research-summary').textContent,
    /Grown in Odisha/,
  );
});

test('the chat turns [label](#/screen) into a link and leaves other markup inert', async () => {
  b.click(b.$('.chat-fab'));
  await wait(() => b.$('aside.chat-dock textarea'));
  const panel =
    b.$('aside.chat-dock [x-data="assistantPanel"]') ?? b.$('[x-data="assistantPanel"]');
  const { linkify } = b.win.Alpine.$data(panel);
  assert.equal(
    linkify('Open [Settings → Security](#/settings/security/csp_img_sources).'),
    'Open <a href="#/settings/security/csp_img_sources">Settings → Security</a>.',
  );
  assert.equal(
    linkify('[x](javascript:alert(1)) <img src=x onerror=alert(1)>'),
    '[x](javascript:alert(1)) &lt;img src=x onerror=alert(1)&gt;',
  );
});

test('the Search panel lists web results and saves one as a note', async () => {
  node.ctx.research.web.search = async () => [
    { title: 'Rice facts', url: 'https://r.example/', snippet: 'About rice' },
  ];
  b.go('#/research');
  const sec = () => b.$('section[x-data="researchPage"]');
  await wait(() => sec() && sec().querySelector('#rs-q'));
  const q = sec().querySelector('#rs-q');
  q.value = 'rice';
  q.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  b.$('section[x-data="researchPage"] form').dispatchEvent(
    new b.win.Event('submit', { bubbles: true, cancelable: true }),
  );
  await wait(() => /Rice facts/.test(sec().querySelector('ul').textContent));
  const save = [...sec().querySelectorAll('button')].find((x) =>
    x.textContent.includes('Save as research note'),
  );
  b.click(save);
  await wait(() => sec().querySelectorAll('.list-group-item').length === 2);
});
