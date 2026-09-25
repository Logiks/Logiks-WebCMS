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
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};

test('SEO Manager is in the menu, under Webmaster', async () => {
  b.go('#/overview');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  await wait(() => /SEO Manager/.test(navText()));
});

test('create a rule from the SEO Manager screen and see it override a live page, then delete it', async () => {
  const before_ = await (await fetch(`${node.url}/contact`)).text();
  assert.doesNotMatch(before_, /UI Override Title/);

  b.go('#/seo/new');
  const ed = () => b.$('section[x-data^="seoRuleEditor"]');
  await wait(() => ed() && ed().querySelector('#seo-pattern'));
  setValue(ed().querySelector('#seo-pattern'), '/contact');
  setValue(ed().querySelector('#seo-title'), 'UI Override Title');
  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create rule');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.seo.list().then((rs) => rs.some((r) => r.pattern === '/contact')));

  const overridden = await (await fetch(`${node.url}/contact`)).text();
  assert.match(overridden, /<title>UI Override Title<\/title>/);

  b.go('#/seo');
  const list = () => b.$('section[x-data="seoList"]');
  await wait(() => list() && /\/contact/.test(list().textContent));
  const row = () =>
    [...list().querySelectorAll('tbody tr')].find((tr) => /\/contact/.test(tr.textContent));
  const deleteBtn = () => row()?.querySelector('button');
  await wait(() => deleteBtn());
  b.click(deleteBtn());
  await wait(async () => !(await node.ctx.seo.list()).some((r) => r.pattern === '/contact'));

  const reverted = await (await fetch(`${node.url}/contact`)).text();
  assert.doesNotMatch(reverted, /UI Override Title/);
});

test('the Page Manager SEO section round-trips seo_type and twitter_card', async () => {
  b.go('#/pages/new');
  const ed = () => b.$('section[x-data^="pagesEditor"]');
  await wait(() => ed() && ed().querySelector('#p-name'));
  setValue(ed().querySelector('#p-name'), 'ui-seo-defaults');
  setValue(ed().querySelector('#p-seo-type'), 'article');
  setValue(ed().querySelector('#p-twitter-card'), 'summary_large_image');
  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create page');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.siteFiles.list().some((f) => f.path === 'pages/ui-seo-defaults.html'));
  const saved = node.ctx.siteFiles.get('pages/ui-seo-defaults.html').content;
  assert.match(saved, /seo_type: article/);
  assert.match(saved, /twitter_card: summary_large_image/);
});
