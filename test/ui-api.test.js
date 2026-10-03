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
const button = (root, text) =>
  [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === text);

test('API and Modules are in the menu under System', async () => {
  b.go('#/overview');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  await wait(() => /API/.test(navText()) && /Modules/.test(navText()));
});

test('create an API key from the screen, see the secret once, and use it against /api/v1', async () => {
  b.go('#/api');
  const page = () => b.$('section[x-data="apiPage"]');
  await wait(() => page() && button(page(), 'New API key'));
  b.click(button(page(), 'New API key'));
  await wait(() => page().querySelector('#k-name'));
  setValue(page().querySelector('#k-name'), 'UI key');
  b.click(button(page(), 'Create key'));
  await wait(async () => (await node.ctx.apiKeys.list()).some((k) => k.name === 'UI key'));

  const shown = () => page().querySelector('.alert-success code');
  await wait(() => shown() && /^cms_/.test(shown().textContent));
  const secret = shown().textContent.trim();

  const ok = await fetch(`${node.url}/api/v1/content`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).data);

  // The secret is dismissed, and the list shows only the hint.
  b.click(button(page(), 'I’ve saved it'));
  await wait(() => !page().querySelector('.alert-success').offsetParent && true);
  assert.ok(!page().textContent.includes(secret));
  assert.match(page().textContent, /UI key/);
  assert.match(page().textContent, /cms_[0-9a-f]{8}_…/);

  // Delete it from the list.
  const row = () =>
    [...page().querySelectorAll('tbody tr')].find((tr) => /UI key/.test(tr.textContent));
  await wait(
    () => row() && [...row().querySelectorAll('button')].find((x) => x.textContent === 'Delete'),
  );
  b.click([...row().querySelectorAll('button')].find((x) => x.textContent === 'Delete'));
  await wait(async () => !(await node.ctx.apiKeys.list()).some((k) => k.name === 'UI key'));
  assert.equal(
    (await fetch(`${node.url}/api/v1/content`, { headers: { Authorization: `Bearer ${secret}` } }))
      .status,
    401,
  );
});

test('the Reference tab lists every operation, and Modules lists every module', async () => {
  const page = () => b.$('section[x-data="apiPage"]');
  b.go('#/api');
  await wait(() => page() && button(page(), 'Reference'));
  b.click(button(page(), 'Reference'));
  await wait(
    () => /\/content\/:type/.test(page().textContent) && /\/menus\/:name/.test(page().textContent),
  );

  b.go('#/modules');
  const mods = () => b.$('section[x-data="modulesPage"]');
  await wait(
    () => mods() && /SEO Manager/.test(mods().textContent) && /Scheduler/.test(mods().textContent),
  );
  assert.equal(
    mods().querySelectorAll('tbody tr').length,
    node.ctx.modules.ids().length + node.ctx.plugins.list().length,
  );
});

test('the page editor lists the modules a page may use, writes "uses" to the file and warns about a gap', async () => {
  await node.ctx.siteFiles.put(
    'components/ui-list.html',
    `<script type="application/json" data-cms="meta">
{"api":[{"name":"p","url":"/api/v1/content/post"}]}
</script><p>list</p>`,
    null,
  );
  b.go('#/pages/new');
  const ed = () => b.$('section[x-data^="pagesEditor"]');
  await wait(() => ed() && ed().querySelector('#p-name'));
  setValue(ed().querySelector('#p-name'), 'ui-uses');
  // Switch to code mode and put a component that reads content on the page.
  const codeBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => /code/i.test(x.textContent));
  await wait(() => codeBtn());
  b.click(codeBtn());
  const alpine = () => b.win.Alpine.$data(ed());
  alpine().code = '{% render "ui-list" %}';
  await wait(() => alpine().usesInfo.inferred.modules.includes('content'));

  b.click(button(ed(), 'Only the ones I pick'));
  await wait(() => alpine().front.usesMode === 'listed');
  await wait(() => alpine().usesInfo.issues.some((i) => i.code === 'undeclared_module'));

  b.click(button(ed(), 'Create page'));
  await wait(() => node.ctx.siteFiles.list().some((f) => f.path === 'pages/ui-uses.html'));
  assert.match(node.ctx.siteFiles.get('pages/ui-uses.html').content, /uses: none/);

  alpine().useWhatItNeeds();
  await wait(() => alpine().front.usesModules.includes('content'));
  assert.match(alpine().content(), /uses: content/);
});

test('Modules: switch an optional module off from the screen; its menu entry goes, and comes back on', async () => {
  b.go('#/modules');
  const mods = () => b.$('section[x-data="modulesPage"]');
  const rowOf = (label) => () =>
    [...mods().querySelectorAll('tbody tr')].find(
      (tr) => tr.querySelector('button')?.textContent === label,
    );
  await wait(() => mods() && rowOf('SEO Manager')());
  const btn = () =>
    [...rowOf('SEO Manager')().querySelectorAll('button')].find((x) =>
      /Turn off|Turn on/.test(x.textContent),
    );
  assert.equal(btn().textContent.trim(), 'Turn off');
  b.click(btn());
  await wait(() => node.ctx.settings.get('modules.disabled').includes('seo'));
  await wait(() => btn()?.textContent.trim() === 'Turn on');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  await wait(() => !/SEO Manager/.test(navText()));

  // The Scheduler needs Webhooks: the server says so, and the screen shows it.
  const hook = () =>
    [...rowOf('Webhooks')().querySelectorAll('button')].find((x) => /Turn off/.test(x.textContent));
  await wait(() => rowOf('Webhooks')() && hook());
  b.click(hook());
  await wait(() => /Scheduler needs Webhooks/.test(mods().textContent));
  assert.ok(!node.ctx.settings.get('modules.disabled').includes('webhooks'));

  b.click(btn());
  await wait(() => !node.ctx.settings.get('modules.disabled').includes('seo'));
  await wait(() => /SEO Manager/.test(navText()));
});
