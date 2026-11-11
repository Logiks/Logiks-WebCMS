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
  await node.ctx.db.schema.createTable('data_items', (t) => {
    t.integer('id').primary();
    t.string('name', 40);
    t.string('color', 20).nullable();
    t.integer('price');
  });
  await node.ctx.db('data_items').insert([
    { id: 1, name: 'Apple pie', color: 'red', price: 10 },
    { id: 2, name: 'Apple tart', color: 'green', price: 20 },
    { id: 3, name: 'Banana split', color: 'yellow', price: 30 },
    { id: 4, name: 'Cherry pie', color: 'red', price: 40 },
  ]);
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 10000, every: 50 });
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};
const check = (el) => {
  el.checked = true;
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};
const ed = () => b.$('section[x-data^="servicesEditor"]');

test('Services → Database table: build the where logic with conditions and a group, save it, reopen it, and call it', async () => {
  b.go('#/services/new');
  await wait(() => ed() && ed().querySelector('#s-name'));
  setValue(ed().querySelector('#s-name'), 'Menu items');
  setValue(ed().querySelector('#s-slug'), 'ui-where');
  check(ed().querySelector('#src-table'));
  const tableSelect = () => ed().querySelector('#t-table');
  await wait(
    () => tableSelect() && [...tableSelect().options].some((o) => o.value === 'data_items'),
  );
  setValue(tableSelect(), 'data_items');
  await wait(() => ed().querySelector('#tc-name'));
  for (const c of ['id', 'name']) check(ed().querySelector(`#tc-${c}`));
  const enabled = ed().querySelector('#s-enabled');
  enabled.checked = true;
  enabled.dispatchEvent(new b.win.Event('change', { bubbles: true }));

  // A parameter to search with.
  b.click([...ed().querySelectorAll('button')].find((x) => x.textContent === 'Add parameter'));
  await wait(() => ed().querySelector('input[aria-label="Parameter name"]'));
  setValue(ed().querySelector('input[aria-label="Parameter name"]'), 'q');

  // Condition 1: price is at least 20 (a fixed value).
  b.click(ed().querySelector('[data-add-where]'));
  await wait(() => ed().querySelectorAll('select[aria-label="Condition"]').length === 1);
  const row = (i) => ({
    column: () => ed().querySelectorAll('select[aria-label="Column"]')[i],
    op: () => ed().querySelectorAll('select[aria-label="Condition"]')[i],
    source: () => ed().querySelectorAll('select[aria-label="Compare with"]')[i],
    value: () => ed().querySelectorAll('input[aria-label="Fixed value"]')[i],
    param: () => ed().querySelectorAll('select[aria-label="Parameter"]')[i],
    skip: () => ed().querySelectorAll('.form-check-input[id^="wi-"]')[i],
  });
  setValue(row(0).column(), 'price');
  setValue(row(0).op(), '>=');
  setValue(row(0).source(), 'value');
  setValue(row(0).value(), '20');

  // A group: name contains the parameter OR color is green. (Two rows inside the group.)
  b.click(ed().querySelector('[data-add-group]'));
  await wait(() => ed().querySelector('[data-group]'));
  b.click(
    [...ed().querySelectorAll('[data-group] button')].find((x) => x.textContent === 'Add to group'),
  );
  await wait(() => ed().querySelectorAll('select[aria-label="Condition"]').length === 3);
  setValue(row(1).column(), 'name');
  setValue(row(1).op(), 'contains');
  setValue(row(1).param(), 'q');
  check(row(1).skip());
  setValue(row(2).column(), 'color');
  setValue(row(2).op(), '=');
  setValue(row(2).source(), 'value');
  setValue(row(2).value(), 'green');
  setValue(ed().querySelector('select[aria-label="Group matches all or any"]'), 'any');

  await wait(() =>
    /price is at least “20” AND \(name contains ‹q› OR color is “green”\)/.test(
      ed().querySelector('[data-where-summary]')?.textContent ?? '',
    ),
  );

  const save = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create service');
  await wait(() => save() && !save().disabled);
  b.click(save());
  await wait(() => node.ctx.services.get('ui-where').catch(() => null));
  const saved = await node.ctx.services.get('ui-where');
  assert.deepEqual(saved.config.where, [
    { column: 'price', op: '>=', value: 20, ignoreIfMissing: false },
    {
      group: {
        match: 'any',
        conditions: [
          { column: 'name', op: 'contains', param: 'q', ignoreIfMissing: true },
          { column: 'color', op: '=', value: 'green', ignoreIfMissing: false },
        ],
      },
    },
  ]);

  const ids = async (qs) =>
    (await node.ctx.publicData.get(`/api/public/services/ui-where${qs}`)).body.items.map(
      (i) => i.id,
    );
  assert.deepEqual(await ids(''), [2], 'price >= 20 and green');
  assert.deepEqual(await ids('?q=pie'), [2, 4], 'price >= 20 and (pie or green)');

  // Reopen it: the conditions and the group come back as they were saved.
  b.go('#/services');
  await wait(() => b.$('section[x-data="servicesList"]'));
  b.go('#/services/ui-where');
  await wait(() => ed() && ed().querySelectorAll('select[aria-label="Condition"]').length === 3);
  assert.equal(row(0).op().value, '>=');
  assert.equal(row(0).value().value, '20');
  assert.equal(row(1).param().value, 'q');
  assert.equal(row(2).value().value, 'green');
  assert.equal(b.$('select[aria-label="Group matches all or any"]').value, 'any');
  assert.deepEqual(b.errors, []);
});
