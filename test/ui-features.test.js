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
const page = () => b.$('section[x-data="featuresPage"]');
const row = (label) =>
  [...page().querySelectorAll('tbody tr')].find(
    (tr) => tr.querySelector('strong')?.textContent === label,
  );
const button = (root, text) =>
  [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === text);
const dialog = () => b.$('section[x-data="featuresPage"] [role="dialog"]');
const visibleDialog = () => dialog() && dialog().style.display !== 'none';
const group = (label) => b.$$('.nav-link-x').find((a) => a.textContent.trim() === label);
const subs = () => b.$$('.nav-sub-link').map((a) => a.textContent.trim());

test('Features is in the menu under Settings', async () => {
  b.go('#/overview');
  await wait(() => group('Settings'));
  b.click(group('Settings'));
  await wait(() => subs().includes('Features'));
  assert.ok(subs().includes('All settings'));
});

test('switch the blog off: a dialog says what changes, its button works, the Content menu follows', async () => {
  b.go('#/features');
  await wait(() => page() && row('Blog'));
  assert.equal(row('Blog').querySelector('.tag').textContent.trim(), 'On');
  b.click(button(row('Blog'), 'Turn off'));
  await wait(() => visibleDialog());
  assert.match(dialog().textContent, /Turn off Blog\?/);
  assert.match(dialog().textContent, /Hides the blog pages from your site/);
  assert.doesNotMatch(dialog().textContent, /Nothing is deleted/);
  assert.equal(node.ctx.features.isOn('blog'), true, 'asking changes nothing');
  const confirm = button(dialog(), 'Turn off Blog');
  assert.equal(confirm.disabled, false, 'the confirm button is enabled');
  assert.equal(confirm.hasAttribute('disabled'), false);
  b.click(confirm);
  await wait(() => !node.ctx.features.isOn('blog'));
  await wait(() => row('Blog').querySelector('.tag').textContent.trim() === 'Off');
  await wait(() => !visibleDialog());
  assert.ok(
    node.ctx.siteFiles.snapshot().files.has('pages/blog/index.html'),
    'the pages are still there',
  );

  // The Content menu no longer offers Posts or Categories and tags.
  b.click(group('Content'));
  await wait(() => subs().includes('Content pages'));
  await wait(() => !subs().includes('Posts'));
  assert.ok(!subs().includes('Categories and tags'));

  b.click(button(row('Blog'), 'Turn on'));
  await wait(() => visibleDialog());
  b.click(button(dialog(), 'Turn on Blog'));
  await wait(() => node.ctx.features.isOn('blog'));
  await wait(() => subs().includes('Posts') && subs().includes('Categories and tags'));
});

test('a feature that is not built yet cannot be switched on, and names what it needs', async () => {
  await wait(() => row('eCommerce'));
  assert.match(row('eCommerce').textContent, /Not available yet/);
  assert.match(row('eCommerce').textContent, /Needs Customer accounts\./);
  assert.match(row('Payment gateways').textContent, /Needs eCommerce\./);
  assert.equal(button(row('eCommerce'), 'Turn on').disabled, true);
});
