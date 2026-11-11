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

test('Database is in the menu, under the System group', async () => {
  b.go('#/overview');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  await wait(() => /Database/.test(navText()));
  assert.match(navText(), /System/);
});

test('sensitive tables are hidden from the table list', async () => {
  b.go('#/dbms');
  await wait(() => page() && page().querySelectorAll('tbody tr').length > 3);
  assert.doesNotMatch(page().textContent, /\busers\b/);
  assert.match(page().textContent, /entries/);
});

test('create a table, then use its Structure, Data and Editor tabs: add, view, edit and delete a record', async () => {
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

  // The list: what each table holds, with maintenance, and no way to drop or truncate from it.
  const widgetsRow = () =>
    [...page().querySelectorAll('[data-tables] tbody tr')].find((tr) =>
      /ui_dbms_widgets/.test(tr.textContent),
    );
  await wait(() => widgetsRow());
  assert.match(widgetsRow().textContent, /Table/);
  assert.match(
    widgetsRow().textContent,
    new RegExp({ sqlite: 'SQLite', mysql: 'InnoDB', pg: 'heap' }[node.ctx.dialect.kind]),
  );
  assert.ok(widgetsRow().querySelector('[data-optimize]'), 'Optimise is offered');
  assert.ok(widgetsRow().querySelector('[data-analyze]'), 'Analyse is offered');
  const labels = [...page().querySelectorAll('button')].map((x) => x.textContent.trim());
  assert.ok(
    !labels.includes('Drop') && !labels.includes('Truncate'),
    'no drop or truncate in the list',
  );
  b.click(widgetsRow().querySelector('[data-optimize]'));
  await wait(() => /ui_dbms_widgets: /.test(b.text()) || true);

  // open it: it opens on Data, and the three tabs are there
  b.click([...widgetsRow().querySelectorAll('a')].find((a) => a.textContent === 'ui_dbms_widgets'));
  await wait(() => page().querySelector('[data-table-tabs]'));
  const tab = (name) => page().querySelector(`[data-tab="${name}"]`);
  const pane = (name) => page().querySelector(`[data-pane="${name}"]`);
  assert.deepEqual(
    [...page().querySelectorAll('[data-table-tabs] .nav-link')].map(
      (x) => x.textContent.trim().split(' ')[0],
    ),
    ['Structure', 'Data', 'Editor'],
  );
  assert.ok(tab('data').classList.contains('active'));
  assert.ok(b.visible(pane('data')) && !b.visible(pane('structure')) && !b.visible(pane('editor')));

  // Structure: columns and indexes
  b.click(tab('structure'));
  await wait(() => b.visible(pane('structure')));
  assert.match(pane('structure').textContent, /label/);
  assert.match(pane('structure').textContent, /Primary key/);
  b.click(tab('data'));
  await wait(() => b.visible(pane('data')));

  // Add a record from Data: the Editor opens on a new record
  b.click(page().querySelector('[data-new-record]'));
  await wait(() => b.visible(pane('editor')) && b.visible(page().querySelector('[data-editor]')));
  assert.match(page().querySelector('[data-editor]').textContent, /New record/);
  assert.equal(
    page().querySelector('#ed-id')?.closest('.col-md-6')?.style.display,
    'none',
    'an automatic key is not asked for',
  );
  setValue(page().querySelector('#ed-label'), 'From the UI');
  b.click(page().querySelector('[data-editor-save]'));
  await wait(() => b.visible(pane('data')) && /From the UI/.test(pane('data').textContent));

  // View it: read-only fields
  b.click(page().querySelector('[data-view-row]'));
  await wait(
    () => b.visible(pane('editor')) && page().querySelector('#ed-label')?.value === 'From the UI',
  );
  assert.equal(page().querySelector('#ed-label').readOnly, true, 'viewing does not allow typing');
  assert.ok(
    !b.visible(page().querySelector('[data-editor-save]').parentElement),
    'no Save while only viewing',
  );

  // Edit it from the view
  b.click(page().querySelector('[data-editor-edit]'));
  await wait(() => page().querySelector('#ed-label')?.readOnly === false);
  assert.equal(page().querySelector('#ed-id').readOnly, true, 'the key is shown but not changed');
  setValue(page().querySelector('#ed-label'), 'Renamed');
  b.click(page().querySelector('[data-editor-save]'));
  await wait(
    () =>
      page().querySelector('#ed-label')?.readOnly === true &&
      page().querySelector('#ed-label').value === 'Renamed',
  );
  const saved = await node.ctx.dbms.listRows('ui_dbms_widgets');
  assert.equal(saved.rows[0].label, 'Renamed');

  // Delete it from Data
  b.click(tab('data'));
  await wait(() => b.visible(pane('data')));
  b.click(page().querySelector('[data-delete-row]'));
  // x-for really removes the <tr>, so wait for the row's dynamic text to go (hidden text stays in textContent).
  await wait(() => !/Renamed/.test(pane('data').querySelector('tbody')?.textContent ?? ''));
  assert.equal((await node.ctx.dbms.listRows('ui_dbms_widgets')).total, 0);

  await node.ctx.db.schema.dropTable('ui_dbms_widgets'); // tidy up: the screen cannot drop tables any more
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
