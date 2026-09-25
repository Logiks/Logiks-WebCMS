import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b;
before(async () => {
  node = await makeNode();
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  await node.ctx.settings.update('features', { values: { public_api: true, services: true } });
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

test('Services is in the menu, under Webmaster', async () => {
  b.go('#/overview');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  await wait(() => /Services/.test(navText()));
});

test('build a query-builder Service, preview it, save it, and see it work over the public API', async () => {
  await node.ctx.content.create(
    'post',
    { title: 'From the builder', status: 'published', data: {} },
    null,
  );

  b.go('#/services/new');
  const ed = () => b.$('section[x-data^="servicesEditor"]');
  await wait(() => ed() && ed().querySelector('#s-name'));
  setValue(ed().querySelector('#s-name'), 'Recent posts');
  setValue(ed().querySelector('#s-slug'), 'ui-recent-posts');
  const typeSelect = () => ed().querySelector('#s-type');
  await wait(() => typeSelect() && [...typeSelect().options].some((o) => o.value === 'post'));
  setValue(typeSelect(), 'post');
  const enabledBox = ed().querySelector('#s-enabled');
  enabledBox.checked = true;
  enabledBox.dispatchEvent(new b.win.Event('change', { bubbles: true }));

  await wait(() => {
    const pre = ed().querySelector('pre');
    return pre && /From the builder/.test(pre.textContent);
  });

  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create service');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.services.get('ui-recent-posts').catch(() => null));

  const saved = await node.ctx.services.get('ui-recent-posts');
  assert.equal(saved.config.type, 'post');
  assert.equal(saved.enabled, true);

  const r = await node.ctx.publicData.get('/api/public/services/ui-recent-posts');
  assert.ok(r.body.items.some((i) => i.title === 'From the builder'));

  b.go('#/services');
  const list = () => b.$('section[x-data="servicesList"]');
  await wait(() => list() && /ui-recent-posts/.test(list().textContent));
  const row = [...list().querySelectorAll('tbody tr')].find((r2) =>
    /ui-recent-posts/.test(r2.textContent),
  );
  b.click(row.querySelector('button'));
  const stillExists = () =>
    node.ctx.services.get('ui-recent-posts').then(
      () => true,
      () => false,
    );
  await wait(async () => !(await stillExists()));
});

const check = (el) => {
  el.checked = true;
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};

test('build a table-source query Service (services.sql) and see it work', async () => {
  await node.ctx.content.create(
    'post',
    { title: 'Table row', status: 'published', data: {} },
    null,
  );

  b.go('#/services/new');
  const ed = () => b.$('section[x-data^="servicesEditor"]');
  await wait(() => ed() && ed().querySelector('#s-name'));
  setValue(ed().querySelector('#s-name'), 'Table service');
  setValue(ed().querySelector('#s-slug'), 'ui-table-service');
  check(ed().querySelector('#src-table'));

  const tableSelect = () => ed().querySelector('#t-table');
  await wait(() => tableSelect() && [...tableSelect().options].some((o) => o.value === 'entries'));
  setValue(tableSelect(), 'entries');

  const titleCol = () => ed().querySelector('#tc-title');
  await wait(() => titleCol());
  check(titleCol());
  const idCol = () => ed().querySelector('#tc-id');
  await wait(() => idCol());
  check(idCol());

  await wait(() => {
    const pre = ed().querySelector('pre');
    return pre && /Table row/.test(pre.textContent);
  });

  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create service');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.services.get('ui-table-service').catch(() => null));

  const saved = await node.ctx.services.get('ui-table-service');
  assert.equal(saved.config.source, 'table');
  assert.equal(saved.config.table, 'entries');
  assert.deepEqual(saved.config.columns.sort(), ['id', 'title']);

  // saving a new item renames its URL via history.replaceState, which fires no hashchange — go via the list so
  // the next "new" visit is a genuine navigation, not a silent reuse of this now-saved editor instance.
  b.go('#/services');
  await wait(() => b.$('section[x-data="servicesList"]'));
});

test('build a script Service and see the full-ctx result over the public API', async () => {
  b.go('#/services/new');
  const ed = () => b.$('section[x-data^="servicesEditor"]');
  await wait(() => ed() && ed().querySelector('#s-name'));
  setValue(ed().querySelector('#s-name'), 'Script service');
  setValue(ed().querySelector('#s-slug'), 'ui-script-service');
  check(ed().querySelector('#s-enabled'));
  check(ed().querySelector('#mode-script'));

  await wait(() => ed().querySelector('#sc-code'));
  setValue(
    ed().querySelector('#sc-code'),
    'return { siteName: ctx.settings.get("general.site_name") };',
  );

  await wait(() => {
    const pre = ed().querySelector('pre');
    return pre && /siteName/.test(pre.textContent);
  });

  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create service');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.services.get('ui-script-service').catch(() => null));

  const r = await node.ctx.publicData.get('/api/public/services/ui-script-service');
  assert.equal(typeof r.body.siteName, 'string');
});

test('the Raw SQL mode is hidden from a user without services.sql', async () => {
  const role = await node.ctx.users.createRole(
    {
      name: 'services-writer',
      description: '',
      permissions: ['admin.access', 'services.read', 'services.write'],
    },
    null,
  );
  await node.ctx.users.createUser(
    {
      email: 'svcwriter@example.com',
      name: 'Writer',
      password: 'Some-long-pass-12',
      roleId: Number(role.id),
    },
    null,
  );
  const b2 = await openAdmin(node.url);
  try {
    await b2.signIn('svcwriter@example.com', 'Some-long-pass-12');
    b2.go('#/services/new');
    const ed = () => b2.$('section[x-data^="servicesEditor"]');
    await wait(() => ed() && ed().querySelector('#s-name'));
    const sqlLabel = () =>
      [...ed().querySelectorAll('label')].find((l) => l.textContent.trim() === 'Raw SQL');
    await wait(() => !sqlLabel() || sqlLabel().style.display === 'none');
  } finally {
    b2.close();
  }
});
