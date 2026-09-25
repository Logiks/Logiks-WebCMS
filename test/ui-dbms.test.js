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
const check = (el) => {
  el.checked = true;
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};
const page = () => b.$('section[x-data="dbmsPage"]');

test('Database is in the menu, under the renamed System group', async () => {
  b.go('#/overview');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  await wait(() => /Database/.test(navText()));
  assert.match(navText(), /System/);
  assert.doesNotMatch(navText(), /\bAppearance\b/);
});

test('sensitive tables are hidden from the table list', async () => {
  b.go('#/dbms');
  await wait(() => page() && page().querySelectorAll('tbody tr').length > 3);
  assert.doesNotMatch(page().textContent, /\busers\b/);
  assert.match(page().textContent, /entries/);
});

test('create a table, add a record, edit it, delete it, then drop the table', async () => {
  b.go('#/dbms');
  await wait(() => page());
  const newTableBtn = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'New table');
  await wait(() => newTableBtn());
  b.click(newTableBtn());

  setValue(page().querySelector('#nt-name'), 'ui_dbms_widgets');
  const addColBtn = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'Add column');
  b.click(addColBtn());
  await wait(() => page().querySelector('input[aria-label="Column name"]'));
  const nameCol = page().querySelector('input[aria-label="Column name"]');
  setValue(nameCol, 'id');
  const pkBox = nameCol.closest('.row').querySelector('input[type="checkbox"]');
  check(pkBox);
  const aiBox = nameCol.closest('.row').querySelectorAll('input[type="checkbox"]')[1];
  check(aiBox);

  b.click(addColBtn());
  const cols = () => page().querySelectorAll('input[aria-label="Column name"]');
  await wait(() => cols().length === 2);
  setValue(cols()[1], 'label');

  const createBtn = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'Create table');
  await wait(() => createBtn() && !createBtn().disabled);
  b.click(createBtn());
  await wait(() => /ui_dbms_widgets/.test(page().textContent));

  // open it
  const link = () =>
    [...page().querySelectorAll('a')].find((a) => a.textContent === 'ui_dbms_widgets');
  await wait(() => link());
  b.click(link());
  await wait(
    () => page().querySelector('#nt-name') === null && /No records/.test(page().textContent),
  );

  // add a record
  const addRecordBtn = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'Add record');
  await wait(() => addRecordBtn());
  b.click(addRecordBtn());
  await wait(() => /New record/.test(page().textContent));
  const labelInput = [...page().querySelectorAll('label')]
    .find((l) => l.textContent.trim() === 'label')
    ?.closest('.mb-2')
    ?.querySelector('input');
  assert.ok(labelInput);
  setValue(labelInput, 'From the UI');
  const saveBtn = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'Save');
  b.click(saveBtn());
  await wait(() => /From the UI/.test(page().textContent));

  // edit it
  const editBtn = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'Edit');
  await wait(() => editBtn());
  b.click(editBtn());
  await wait(() => /Edit record/.test(page().textContent));
  const labelInput2 = [...page().querySelectorAll('label')]
    .find((l) => l.textContent.trim() === 'label')
    ?.closest('.mb-2')
    ?.querySelector('input');
  setValue(labelInput2, 'Renamed');
  b.click([...page().querySelectorAll('button')].find((x) => x.textContent === 'Save'));
  await wait(() => /Renamed/.test(page().textContent));

  const saved = await node.ctx.dbms.listRows('ui_dbms_widgets');
  assert.equal(saved.rows[0].label, 'Renamed');

  // delete it
  const deleteBtn = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'Delete');
  await wait(() => deleteBtn());
  b.click(deleteBtn());
  // "No records." lives in a div gated by x-show, which stays in the DOM (and in textContent) even while
  // hidden — wait for the actual row's dynamic text to disappear instead (x-for really removes the <tr>).
  await wait(() => !/Renamed/.test(page().textContent));

  // drop the table (type-to-confirm)
  b.win.prompt = () => 'ui_dbms_widgets';
  const tablesTab = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'Tables');
  b.click(tablesTab());
  await wait(() => /ui_dbms_widgets/.test(page().textContent));
  const widgetsRow = () =>
    [...page().querySelectorAll('tbody tr')].find((tr) => /ui_dbms_widgets/.test(tr.textContent));
  const dropBtn = () => widgetsRow()?.querySelector('button');
  await wait(() => dropBtn());
  b.click(dropBtn());
  await wait(async () => !(await node.ctx.db.schema.hasTable('ui_dbms_widgets')));
});

test('the SQL console runs a query and can save it for later', async () => {
  b.go('#/dbms');
  await wait(() => page());
  const consoleTab = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'SQL console');
  b.click(consoleTab());
  await wait(() => page().querySelector('#dbms-sql'));
  setValue(page().querySelector('#dbms-sql'), 'select count(*) as n from entries');
  const runBtn = () => [...page().querySelectorAll('button')].find((x) => x.textContent === 'Run');
  b.click(runBtn());
  await wait(() => /row\(s\)/.test(page().textContent));

  setValue(page().querySelector('input[aria-label="Name this query to save it"]'), 'Count entries');
  b.click([...page().querySelectorAll('button')].find((x) => x.textContent === 'Save query'));
  await wait(() => /Count entries/.test(page().textContent));

  const saved = await node.ctx.dbms.listSavedQueries();
  assert.ok(saved.some((q) => q.name === 'Count entries'));
});
