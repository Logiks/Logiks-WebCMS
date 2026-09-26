import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const mkUser = async (perms, email) => {
  const role = await node.ctx.users.createRole(
    { name: `r-${email}`, description: '', permissions: perms },
    null,
  );
  await node.ctx.users.createUser(
    { email, name: email, password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  return signedIn(node.app, { email, password: 'Some-long-pass-12' });
};

describe('System → Database: table list and structure', () => {
  test('sensitive tables never appear in the list, but their structure can still be read', async () => {
    const r = await admin.get('/api/admin/dbms/tables');
    assert.equal(r.status, 200);
    assert.ok(r.body.tables.some((t) => t.name === 'entries'));
    assert.ok(!r.body.tables.some((t) => t.name === 'users'));
    assert.ok(!r.body.tables.some((t) => t.name === 'settings'));
    assert.ok(!r.body.tables.some((t) => t.name === 'analytics_sessions'));
    assert.ok(!r.body.tables.some((t) => t.name === 'activity_log'));

    const info = await admin.get('/api/admin/dbms/tables/users');
    assert.equal(info.status, 200, 'structure of a sensitive table is still readable');
    assert.equal(info.body.sensitive, true);
    assert.ok(info.body.columns.some((c) => c.name === 'email'));
  });

  test('a real table reports its columns (with primary key) and indexes', async () => {
    const r = await admin.get('/api/admin/dbms/tables/entries');
    assert.equal(r.status, 200);
    const id = r.body.columns.find((c) => c.name === 'id');
    assert.ok(id);
    assert.equal(id.primaryKey, true);
    const type = r.body.columns.find((c) => c.name === 'type');
    assert.ok(type);
    assert.equal(type.primaryKey, false);
    assert.ok(r.body.indexes.length > 0, 'entries has at least the unique(type,locale,path) index');
  });

  test('an unknown table 404s', async () => {
    assert.equal((await admin.get('/api/admin/dbms/tables/not_a_real_table')).status, 404);
  });

  test('dbms.read is required to browse or read structure', async () => {
    const bare = await mkUser(['admin.access'], 'no-dbms@example.com');
    assert.equal((await bare.get('/api/admin/dbms/tables')).status, 403);
    assert.equal((await bare.get('/api/admin/dbms/tables/entries')).status, 403);
    assert.equal((await bare.get('/api/admin/dbms/tables/entries/rows')).status, 403);
  });
});

describe('Creating a table, then full CRUD on its rows', () => {
  test('columns of every offered type, an auto-increment primary key, defaults and nullability', async () => {
    const created = await admin.post('/api/admin/dbms/tables').send({
      name: 'dbms_test_widgets',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'label', type: 'string', nullable: false },
        { name: 'notes', type: 'text', nullable: true },
        { name: 'qty', type: 'integer', nullable: true, default: 0 },
        { name: 'active', type: 'boolean', nullable: true, default: true },
        { name: 'price', type: 'float', nullable: true },
        { name: 'meta', type: 'json', nullable: true },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const info = await admin.get('/api/admin/dbms/tables/dbms_test_widgets');
    assert.equal(info.status, 200);
    const cols = Object.fromEntries(info.body.columns.map((c) => [c.name, c]));
    assert.equal(cols.id.primaryKey, true);
    assert.equal(cols.id.autoIncrement, true);
    assert.equal(cols.label.nullable, false);
    assert.equal(cols.notes.nullable, true);

    // create
    const c1 = await admin
      .post('/api/admin/dbms/tables/dbms_test_widgets/rows')
      .send({ label: 'First', qty: 3, active: true, price: 9.5, meta: '{"a":1}' });
    assert.equal(c1.status, 201, JSON.stringify(c1.body));
    assert.ok(c1.body.id);
    await admin
      .post('/api/admin/dbms/tables/dbms_test_widgets/rows')
      .send({ label: 'Second', qty: 1 });

    // browse: paginated, sortable
    const list = await admin.get(
      '/api/admin/dbms/tables/dbms_test_widgets/rows?per_page=1&page=1&sort=id&dir=desc',
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.rows.length, 1);
    assert.equal(list.body.total, 2);
    assert.equal(list.body.rows[0].label, 'Second', 'sorted by id desc');

    // update
    const upd = await admin
      .put('/api/admin/dbms/tables/dbms_test_widgets/rows')
      .send({ pk: { id: c1.body.id }, data: { label: 'Renamed', qty: 7 } });
    assert.equal(upd.status, 204);
    const afterUpdate = await admin.get(
      '/api/admin/dbms/tables/dbms_test_widgets/rows?sort=id&dir=asc',
    );
    const row = afterUpdate.body.rows.find((r) => r.id === c1.body.id);
    assert.equal(row.label, 'Renamed');
    assert.equal(row.qty, 7);

    // delete
    const del = await admin
      .delete('/api/admin/dbms/tables/dbms_test_widgets/rows')
      .send({ pk: { id: c1.body.id } });
    assert.equal(del.status, 204);
    assert.equal((await admin.get('/api/admin/dbms/tables/dbms_test_widgets/rows')).body.total, 1);

    // updating/deleting a row that no longer matches 404s
    assert.equal(
      (
        await admin
          .put('/api/admin/dbms/tables/dbms_test_widgets/rows')
          .send({ pk: { id: c1.body.id }, data: { label: 'x' } })
      ).status,
      404,
    );

    // drop it
    assert.equal((await admin.delete('/api/admin/dbms/tables/dbms_test_widgets')).status, 204);
    assert.equal((await admin.get('/api/admin/dbms/tables/dbms_test_widgets')).status, 404);
  });

  test('a composite primary key is supported', async () => {
    await admin.post('/api/admin/dbms/tables').send({
      name: 'dbms_test_composite',
      columns: [
        { name: 'a', type: 'string', primaryKey: true },
        { name: 'b', type: 'string', primaryKey: true },
        { name: 'value', type: 'integer', nullable: true },
      ],
    });
    await admin
      .post('/api/admin/dbms/tables/dbms_test_composite/rows')
      .send({ a: 'x', b: 'y', value: 1 });
    const upd = await admin
      .put('/api/admin/dbms/tables/dbms_test_composite/rows')
      .send({ pk: { a: 'x', b: 'y' }, data: { value: 2 } });
    assert.equal(upd.status, 204);
    const rows = (await admin.get('/api/admin/dbms/tables/dbms_test_composite/rows')).body.rows;
    assert.equal(rows[0].value, 2);
    await admin.delete('/api/admin/dbms/tables/dbms_test_composite');
  });

  test('creating a table with a reserved/sensitive name, a duplicate name, or no columns is refused', async () => {
    assert.equal(
      (
        await admin
          .post('/api/admin/dbms/tables')
          .send({ name: 'users', columns: [{ name: 'x', type: 'string' }] })
      ).status,
      422,
    );
    assert.equal(
      (
        await admin
          .post('/api/admin/dbms/tables')
          .send({ name: 'entries', columns: [{ name: 'x', type: 'string' }] })
      ).status,
      422,
    );
    assert.equal(
      (await admin.post('/api/admin/dbms/tables').send({ name: 'dbms_test_empty', columns: [] }))
        .status,
      422,
    );
  });

  test('a sensitive table is refused by every structured mutation, even with dbms.write', async () => {
    assert.equal(
      (await admin.post('/api/admin/dbms/tables/users/rows').send({ email: 'x@example.com' }))
        .status,
      422,
    );
    assert.equal(
      (await admin.put('/api/admin/dbms/tables/users/rows').send({ pk: { id: 1 }, data: {} }))
        .status,
      422,
    );
    assert.equal(
      (await admin.delete('/api/admin/dbms/tables/users/rows').send({ pk: { id: 1 } })).status,
      422,
    );
    assert.equal((await admin.delete('/api/admin/dbms/tables/users')).status, 422);
  });

  test('dbms.write is required for every mutation; dbms.read alone is refused', async () => {
    const reader = await mkUser(['admin.access', 'dbms.read'], 'dbms-reader@example.com');
    assert.equal(
      (
        await reader
          .post('/api/admin/dbms/tables')
          .send({ name: 'dbms_test_x', columns: [{ name: 'a', type: 'string' }] })
      ).status,
      403,
    );
    assert.equal(
      (await reader.post('/api/admin/dbms/tables/entries/rows').send({ type: 'post' })).status,
      403,
    );
  });
});

describe('The SQL console (dbms.query): literally anything, normalised results, saved queries', () => {
  test('a SELECT and a write both work, with normalised rowCount', async () => {
    await admin.post('/api/admin/dbms/tables').send({
      name: 'dbms_test_console',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'label', type: 'string', nullable: true },
      ],
    });
    const ins = await admin
      .post('/api/admin/dbms/query')
      .send({ sql: "insert into dbms_test_console (label) values ('from console')" });
    assert.equal(ins.status, 200, JSON.stringify(ins.body));
    assert.equal(ins.body.rowCount, 1);

    const sel = await admin
      .post('/api/admin/dbms/query')
      .send({ sql: 'select * from dbms_test_console' });
    assert.equal(sel.status, 200);
    assert.equal(sel.body.rows.length, 1);
    assert.equal(sel.body.rows[0].label, 'from console');

    const upd = await admin
      .post('/api/admin/dbms/query')
      .send({ sql: "update dbms_test_console set label = 'changed'" });
    assert.equal(upd.body.rowCount, 1);

    await admin.post('/api/admin/dbms/query').send({ sql: 'drop table dbms_test_console' });
  });

  test('an invalid query is a 400 with the database’s own message, not a 500', async () => {
    const r = await admin
      .post('/api/admin/dbms/query')
      .send({ sql: 'select * from not_a_real_table_at_all' });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.message.length > 0);
  });

  test('saved queries: create, list, delete', async () => {
    const saved = await admin
      .post('/api/admin/dbms/saved-queries')
      .send({ name: 'Count entries', sql: 'select count(*) as n from entries' });
    assert.equal(saved.status, 201);
    const list = await admin.get('/api/admin/dbms/saved-queries');
    assert.ok(list.body.queries.some((q) => q.name === 'Count entries'));
    await admin.delete(`/api/admin/dbms/saved-queries/${saved.body.id}`);
    const after1 = await admin.get('/api/admin/dbms/saved-queries');
    assert.ok(!after1.body.queries.some((q) => q.id === saved.body.id));
  });

  test('dbms.write does not grant the console or saved queries — dbms.query is its own, higher tier', async () => {
    const writer = await mkUser(
      ['admin.access', 'dbms.read', 'dbms.write'],
      'dbms-writer@example.com',
    );
    assert.equal(
      (await writer.post('/api/admin/dbms/query').send({ sql: 'select 1' })).status,
      403,
    );
    assert.equal(
      (await writer.post('/api/admin/dbms/saved-queries').send({ name: 'x', sql: 'select 1' }))
        .status,
      403,
    );
  });

  test('the console can reach a sensitive table — that is the point of a console', async () => {
    const r = await admin
      .post('/api/admin/dbms/query')
      .send({ sql: 'select count(*) as n from users' });
    assert.equal(r.status, 200);
    assert.ok(r.body.rows[0].n >= 1);
  });
});
