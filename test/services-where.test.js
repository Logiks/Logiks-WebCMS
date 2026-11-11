import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
const pub = (p) => request(node.app).get(`/api/public${p}`);

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  await node.ctx.settings.update('features', { values: { public_api: true, services: true } });
  await node.ctx.db.schema.createTable('data_items', (t) => {
    t.integer('id').primary();
    t.string('name', 40);
    t.string('color', 20).nullable();
    t.integer('price');
    t.string('note', 40).nullable();
  });
  await node.ctx.db('data_items').insert([
    { id: 1, name: 'Apple pie', color: 'red', price: 10, note: null },
    { id: 2, name: 'Apple tart', color: 'green', price: 20, note: 'hi' },
    { id: 3, name: 'Banana split', color: 'yellow', price: 30, note: null },
    { id: 4, name: 'Cherry pie', color: 'red', price: 40, note: 'hi' },
    { id: 5, name: 'Date cake', color: null, price: 50, note: 'x' },
  ]);
});
after(() => node.close());

let n = 0;
/** Saves a table query over data_items with this where logic and returns a caller for it. */
async function service(where, { whereMatch, params = [], expect = 201 } = {}) {
  const slug = `w-${++n}`;
  const r = await admin.post('/api/admin/services').send({
    slug,
    name: slug,
    mode: 'query',
    enabled: true,
    config: {
      source: 'table',
      table: 'data_items',
      columns: ['id', 'name'],
      where,
      ...(whereMatch ? { whereMatch } : {}),
      params,
      sort: { column: 'id', dir: 'asc' },
      perPage: { default: 50, max: 50 },
    },
  });
  assert.equal(r.status, expect, JSON.stringify(r.body));
  if (expect !== 201) return r;
  return async (qs = '') => (await pub(`/services/${slug}${qs}`)).body.items?.map((x) => x.id);
}
const text = (name, required = false) => ({ name, type: 'string', required });
const num = (name) => ({ name, type: 'number', required: false });

test('an old filter (column = parameter) keeps working exactly as before', async () => {
  const run = await service([{ column: 'color', param: 'c' }], { params: [text('c', true)] });
  assert.deepEqual(await run('?c=red'), [1, 4]);
});

test('comparisons against a fixed value or a parameter', async () => {
  assert.deepEqual(await (await service([{ column: 'price', op: '>', value: 25 }]))(), [3, 4, 5]);
  assert.deepEqual(await (await service([{ column: 'price', op: '<=', value: 20 }]))(), [1, 2]);
  assert.deepEqual(await (await service([{ column: 'color', op: '!=', value: 'red' }]))(), [2, 3]);
  const run = await service([{ column: 'price', op: '>=', param: 'min' }], {
    params: [num('min')],
  });
  assert.deepEqual(await run('?min=40'), [4, 5]);
});

test('text matching: contains, starts with, ends with', async () => {
  const contains = await service([{ column: 'name', op: 'contains', param: 'q' }], {
    params: [text('q')],
  });
  assert.deepEqual(await contains('?q=pie'), [1, 4]);
  assert.deepEqual(await contains('?q=APPLE'), [1, 2], 'case does not matter');
  assert.deepEqual(
    await (
      await service([{ column: 'name', op: 'starts_with', value: 'Apple' }])
    )(),
    [1, 2],
  );
  assert.deepEqual(
    await (
      await service([{ column: 'name', op: 'ends_with', value: 'cake' }])
    )(),
    [5],
  );
  assert.deepEqual(await contains('?q='), [], 'nothing to look for, nothing matches');
});

test('lists and empty values: is one of, is none of, is empty, is not empty', async () => {
  assert.deepEqual(
    await (
      await service([{ column: 'color', op: 'in', value: 'red, yellow' }])
    )(),
    [1, 3, 4],
  );
  assert.deepEqual(
    await (
      await service([{ column: 'color', op: 'not_in', value: 'red,yellow' }])
    )(),
    [2],
  );
  const inParam = await service([{ column: 'id', op: 'in', param: 'ids' }], {
    params: [text('ids')],
  });
  assert.deepEqual(await inParam('?ids=2,5'), [2, 5]);
  assert.deepEqual(await (await service([{ column: 'note', op: 'is_null' }]))(), [1, 3]);
  assert.deepEqual(await (await service([{ column: 'note', op: 'not_null' }]))(), [2, 4, 5]);
});

test('all of / any of, and a group for "a AND (b OR c)"', async () => {
  const all = [
    { column: 'color', op: '=', value: 'red' },
    { column: 'price', op: '>', value: 20 },
  ];
  assert.deepEqual(await (await service(all))(), [4], 'all must match');
  assert.deepEqual(
    await (
      await service(all, { whereMatch: 'any' })
    )(),
    [1, 3, 4, 5],
    'any one will do',
  );

  const grouped = await service([
    { column: 'price', op: '>=', value: 20 },
    {
      group: {
        match: 'any',
        conditions: [
          { column: 'color', op: '=', value: 'green' },
          { column: 'name', op: 'starts_with', value: 'Cherry' },
        ],
      },
    },
  ]);
  assert.deepEqual(await grouped(), [2, 4], 'price >= 20 AND (green OR Cherry…)');
});

test('a search box left empty can drop its condition instead of matching nothing', async () => {
  const where = [
    { column: 'name', op: 'contains', param: 'q', ignoreIfMissing: true },
    { column: 'color', op: '=', param: 'c', ignoreIfMissing: true },
  ];
  const run = await service(where, { params: [text('q'), text('c')] });
  assert.deepEqual(await run(), [1, 2, 3, 4, 5], 'nothing sent: nothing filtered');
  assert.deepEqual(await run('?c=red'), [1, 4]);
  assert.deepEqual(await run('?q=pie&c=red'), [1, 4]);
  assert.deepEqual(await run('?q=apple&c=red'), [1]);
});

test('values are bound, never written into the SQL', async () => {
  const run = await service([{ column: 'name', op: 'contains', param: 'q' }], {
    params: [text('q')],
  });
  assert.deepEqual(await run("?q=x'; drop table data_items; --"), []);
  assert.equal(await node.ctx.db.schema.hasTable('data_items'), true);
});

test('what is refused, and why', async () => {
  const bothValue = await service([{ column: 'color', op: '=', param: 'c', value: 'red' }], {
    params: [text('c')],
    expect: 422,
  });
  assert.match(bothValue.body.error.message, /both a parameter and a fixed value/);
  const neither = await service([{ column: 'color', op: '=' }], { expect: 422 });
  assert.match(neither.body.error.message, /needs a parameter or a fixed value/);
  const undeclared = await service([{ column: 'color', op: '=', param: 'zzz' }], { expect: 422 });
  assert.match(undeclared.body.error.message, /declared parameter "zzz"/);
  const noColumn = await service([{ column: 'nope', op: '=', value: 'x' }], { expect: 422 });
  assert.match(noColumn.body.error.message, /no column "nope"/);
  const ignoreConst = await service(
    [{ column: 'color', op: '=', value: 'red', ignoreIfMissing: true }],
    { expect: 422 },
  );
  assert.match(ignoreConst.body.error.message, /only applies to a filter that uses a parameter/);
  const badOp = await service([{ column: 'color', op: 'regexp', value: 'x' }], { expect: 422 });
  assert.equal(badOp.status, 422);
  const inGroup = await service(
    [{ group: { match: 'any', conditions: [{ column: 'nope', op: '=', value: 'x' }] } }],
    { expect: 422 },
  );
  assert.match(
    inGroup.body.error.message,
    /no column "nope"/,
    'conditions inside a group are checked too',
  );
  const emptyGroup = await service([{ group: { match: 'all', conditions: [] } }], { expect: 422 });
  assert.equal(emptyGroup.status, 422);
});
