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

test('Webmaster is in the menu, with Pages and Components', async () => {
  b.go('#/overview');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  // Wait for the nav to actually be populated (permissions loaded, items rendered), not just the sidebar element to exist.
  await wait(() => /Pages/.test(navText()));
  assert.match(navText(), /Components/);
});

test('Pages: the list shows the starter site, in a new page you can add components and save it', async () => {
  b.go('#/pages');
  const list = () => b.$('section[x-data="pagesList"]');
  await wait(() => list() && list().querySelectorAll('tbody tr').length > 3);
  assert.match(list().textContent, /\/blog/);

  b.go('#/pages/new');
  const ed = () => b.$('section[x-data^="pagesEditor"]');
  await wait(() => ed() && ed().querySelector('#p-name'));
  setValue(ed().querySelector('#p-name'), 'ui-test-page');
  setValue(ed().querySelector('#p-title'), 'A page built in the browser');

  const addSelect = () => ed().querySelector('select[aria-label="Add a component"]');
  await wait(() => addSelect() && [...addSelect().options].some((o) => o.value === 'hero'));
  setValue(addSelect(), 'hero');
  const addBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Add');
  await wait(() => addBtn());
  b.click(addBtn());
  await wait(() => /Hero banner/.test(ed().textContent));

  const headingInput = [...ed().querySelectorAll('label')]
    .find((l) => /Heading/.test(l.textContent))
    ?.closest('.mb-2')
    ?.querySelector('input, textarea');
  assert.ok(headingInput, 'the hero component’s Heading field is on the page');
  setValue(headingInput, 'Built from the page builder');

  await wait(() =>
    /Built from the page builder/.test(ed().querySelector('iframe')?.getAttribute('srcdoc') || ''),
  );

  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create page');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.siteFiles.list().some((f) => f.path === 'pages/ui-test-page.html'));
  const saved = node.ctx.siteFiles.get('pages/ui-test-page.html').content;
  assert.match(saved, /title: A page built in the browser/);
  assert.match(saved, /\{% render "hero", heading: "Built from the page builder" %\}/);
  // the address bar never shows the storage details: no "pages/" prefix, no ".html" suffix
  // The address changes when the save's response arrives, a moment after the row is in the database.
  await wait(() => b.win.location.hash === '#/pages/ui-test-page');
  assert.equal(b.win.location.hash, '#/pages/ui-test-page');

  // back on the list, the new page shows up, and can be deleted
  b.go('#/pages');
  await wait(() => list() && /ui-test-page/.test(list().textContent));
  const row = [...list().querySelectorAll('tbody tr')].find((r) =>
    /ui-test-page/.test(r.textContent),
  );
  b.click(row.querySelector('button.btn-outline-danger'));
  await wait(() => !node.ctx.siteFiles.list().some((f) => f.path === 'pages/ui-test-page.html'));
});

test('Pages: typing ".html" into the address is dropped, not doubled into a real /page.html address', async () => {
  b.go('#/pages/new');
  const ed = () => b.$('section[x-data^="pagesEditor"]');
  await wait(() => ed() && ed().querySelector('#p-name'));
  const nameInput = ed().querySelector('#p-name');
  setValue(nameInput, 'extension-test.html');
  nameInput.dispatchEvent(new b.win.Event('blur', { bubbles: true }));
  await wait(() => nameInput.value === 'extension-test');

  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create page');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.siteFiles.list().some((f) => f.path === 'pages/extension-test.html'));
  assert.ok(
    !node.ctx.siteFiles.list().some((f) => f.path === 'pages/extension-test.html.html'),
    'the typed .html was not doubled up',
  );
  await wait(() => b.win.location.hash === '#/pages/extension-test');
  assert.equal(b.win.location.hash, '#/pages/extension-test');

  await node.ctx.siteFiles.remove('pages/extension-test.html', null);
});

test('Components: the list shows the starter components, and a new one can be built and saved', async () => {
  b.go('#/components');
  const list = () => b.$('section[x-data="componentsList"]');
  await wait(() => list() && /hero/.test(list().textContent));

  b.go('#/components/new');
  const ed = () => b.$('section[x-data^="componentsEditor"]');
  await wait(() => ed() && ed().querySelector('#c-name'));
  setValue(ed().querySelector('#c-name'), 'ui-test-widget');
  setValue(ed().querySelector('#c-title'), 'UI test widget');

  const addProp = [...ed().querySelectorAll('button')].find(
    (x) => x.textContent === 'Add property',
  );
  b.click(addProp);
  await wait(() => ed().querySelector('.row.g-2.mb-2'));
  const propRow = ed().querySelector('.row.g-2.mb-2');
  setValue(propRow.querySelector('input[aria-label="Property key"]'), 'label');
  setValue(propRow.querySelector('input[aria-label="Default value"]'), 'Hi');

  setValue(ed().querySelector('#c-template'), '<p>{{ label }}</p>');

  await wait(() => /Hi/.test(ed().querySelector('iframe')?.getAttribute('srcdoc') || ''));

  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create component');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() =>
    node.ctx.siteFiles.list().some((f) => f.path === 'components/ui-test-widget.html'),
  );
  const saved = node.ctx.siteFiles.get('components/ui-test-widget.html').content;
  assert.match(saved, /"label"/);
  assert.match(saved, /<p>\{\{ label \}\}<\/p>/);

  await node.ctx.siteFiles.remove('components/ui-test-widget.html', null);
});

test('Pages: the list offers export and a .zip import', async () => {
  b.go('#/pages');
  const list = () => b.$('section[x-data="pagesList"]');
  await wait(() => list());
  const exportLink = [...list().querySelectorAll('a')].find((a) => a.textContent === 'Export .zip');
  assert.ok(exportLink);
  assert.equal(exportLink.getAttribute('href'), '/api/admin/site/pages/export');

  const input = list().querySelector('input[type="file"]');
  assert.ok(input);
  const zipBuffer = await node.ctx.siteFiles.exportZip('pages'); // a real, valid pages.zip
  Object.defineProperty(input, 'files', {
    value: [new b.win.File([zipBuffer], 'pages.zip', { type: 'application/zip' })],
    configurable: true,
  });
  input.dispatchEvent(new b.win.Event('change', { bubbles: true }));
  await wait(() => /Import finished/.test(b.text()));
});
