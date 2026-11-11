import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNode, signedIn } from './helpers.js';

test('the table list says how many records, which engine, and how big; maintenance changes no record', async () => {
  const node = await startNode({ seed: true });
  try {
    const admin = await signedIn(node.app);
    await node.ctx.db.schema.createTable('data_things', (t) => {
      t.increments('id');
      t.string('name', 40);
    });
    await node.ctx.db('data_things').insert([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    await node.ctx.db.raw('create view data_things_view as select * from data_things');

    const list = (await admin.get('/api/admin/dbms/tables')).body.tables;
    const t = list.find((x) => x.name === 'data_things');
    assert.equal(t.rows, 3);
    assert.equal(t.view, false);
    assert.equal(
      t.engine,
      { sqlite: 'SQLite', mysql: 'InnoDB', pg: 'heap' }[node.ctx.dialect.kind],
      'the storage engine',
    );
    assert.equal(
      t.approx,
      node.ctx.dialect.kind !== 'sqlite',
      'SQLite counts exactly, the others estimate',
    );
    assert.ok(t.bytes === null || t.bytes > 0, 'a size, or a dash where the engine cannot say');
    const v = list.find((x) => x.name === 'data_things_view');
    assert.deepEqual(
      [v.view, v.rows, v.engine, v.bytes],
      [true, null, null, null],
      'a view has none of these',
    );
    assert.ok(!list.some((x) => x.name === 'users'), 'sensitive tables are still not listed');

    for (const action of ['optimize', 'analyze']) {
      const r = await admin.post('/api/admin/dbms/tables/data_things/maintenance').send({ action });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.table, 'data_things');
      assert.ok(r.body.message.length > 3);
    }
    assert.equal(
      Number((await node.ctx.db('data_things').count({ n: '*' }).first()).n),
      3,
      'no record changed',
    );
    assert.ok(
      (await node.ctx.audit.list({ action: 'dbms.table_maintained' })).length >= 2,
      'audited',
    );

    assert.equal(
      (
        await admin
          .post('/api/admin/dbms/tables/data_things_view/maintenance')
          .send({ action: 'optimize' })
      ).status,
      422,
    );
    assert.equal(
      (await admin.post('/api/admin/dbms/tables/users/maintenance').send({ action: 'optimize' }))
        .status,
      422,
    );
    assert.equal(
      (
        await admin
          .post('/api/admin/dbms/tables/nope_nope/maintenance')
          .send({ action: 'optimize' })
      ).status,
      404,
    );
    assert.equal(
      (await admin.post('/api/admin/dbms/tables/data_things/maintenance').send({ action: 'drop' }))
        .status,
      422,
    );
  } finally {
    await node.close();
  }
});

test('maintenance needs the database write permission', async () => {
  const node = await startNode({ seed: true });
  try {
    const admin = await signedIn(node.app);
    const role = await admin
      .post('/api/admin/roles')
      .send({ name: 'db-reader', permissions: ['admin.access', 'dbms.read'] });
    await admin.post('/api/admin/users').send({
      email: 'r@example.com',
      name: 'R',
      password: 'Another-Pass-77',
      roleId: role.body.id ?? role.body.role?.id,
    });
    const reader = await signedIn(node.app, {
      email: 'r@example.com',
      password: 'Another-Pass-77',
    });
    assert.equal((await reader.get('/api/admin/dbms/tables')).status, 200);
    assert.equal(
      (await reader.post('/api/admin/dbms/tables/entries/maintenance').send({ action: 'analyze' }))
        .status,
      403,
    );
  } finally {
    await node.close();
  }
});
