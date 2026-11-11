import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { startNode, signedIn, until } from './helpers.js';

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const download = (admin, qs) =>
  admin.get(`/api/admin/dbms/export?${qs}`).buffer(true).parse(binary);
const upload = (admin, qs, zip) =>
  admin.post(`/api/admin/dbms/import?${qs}`).set('content-type', 'application/zip').send(zip);

async function makeTable(node, name = 'data_notes') {
  await node.ctx.db.schema.createTable(name, (t) => {
    t.integer('id').primary();
    t.string('title', 80);
    t.string('extra', 40).nullable();
  });
}

test('export a table to a zip, import it on another server: the table and its records arrive, nothing is replaced', async () => {
  const a = await startNode({ seed: true });
  const b = await startNode({ seed: true });
  try {
    const admin = await signedIn(a.app);
    await makeTable(a);
    await a.ctx.db('data_notes').insert([
      { id: 1, title: 'one', extra: 'x' },
      { id: 2, title: 'two', extra: null },
    ]);

    const exp = await download(admin, 'tables=data_notes');
    assert.equal(exp.status, 200);
    assert.match(exp.headers['content-type'], /zip/);
    assert.match(exp.headers['content-disposition'], /data_notes-\d{4}-\d{2}-\d{2}\.zip/);
    const zip = new AdmZip(exp.body);
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    assert.deepEqual(Object.keys(manifest.tables), ['data_notes']);
    assert.deepEqual(
      Object.keys(manifest.schema),
      ['data_notes'],
      'only the chosen table is described',
    );
    assert.equal(manifest.tables.data_notes.rows, 2);
    // The temporary backup that carried the file is removed once the download has ended.
    await until(async () => (await a.ctx.backup.list()).length === 0);

    const other = await signedIn(b.app);
    // Look first: nothing changes.
    const look = await upload(other, 'dryRun=true', exp.body);
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.deepEqual(
      look.body.tables.map((t) => [t.table, t.rows, t.exists]),
      [['data_notes', 2, false]],
    );
    assert.equal(await b.ctx.db.schema.hasTable('data_notes'), false);
    assert.equal((await b.ctx.backup.list()).length, 0);

    // Importing needs the word.
    assert.equal((await upload(other, '', exp.body)).status, 422);
    const done = await upload(other, 'confirm=IMPORT', exp.body);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.imported, ['data_notes']);
    assert.equal(done.body.result.tablesCreated, 1);
    assert.equal(done.body.result.rowsAdded, 2);
    assert.deepEqual(
      (await b.ctx.db('data_notes').orderBy('id')).map((r) => r.title),
      ['one', 'two'],
    );

    // The target edits a record and adds one; importing again changes none of that.
    await b.ctx.db('data_notes').where({ id: 1 }).update({ title: 'edited here' });
    await b.ctx.db('data_notes').insert({ id: 3, title: 'three' });
    const again = await upload(other, 'confirm=IMPORT', exp.body);
    assert.equal(again.body.result.rowsAdded, 0);
    assert.deepEqual(
      (await b.ctx.db('data_notes').orderBy('id')).map((r) => r.title),
      ['edited here', 'two', 'three'],
      'existing records are kept exactly as they are; nothing is deleted',
    );
    assert.equal((await b.ctx.backup.list()).length, 0);
  } finally {
    await a.close();
    await b.close();
  }
});

test('structure only, and a table that lacks a column: the table is created empty / the column is added, never changed', async () => {
  const a = await startNode({ seed: true });
  const b = await startNode({ seed: true });
  try {
    const admin = await signedIn(a.app);
    await makeTable(a);
    await a.ctx.db('data_notes').insert({ id: 1, title: 'one', extra: 'x' });
    const structure = await download(admin, 'tables=data_notes&data=false');
    assert.equal(structure.status, 200);
    assert.deepEqual(
      Object.keys(JSON.parse(new AdmZip(structure.body).readAsText('manifest.json')).tables),
      [],
    );

    const other = await signedIn(b.app);
    const made = await upload(other, 'confirm=IMPORT', structure.body);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.result.tablesCreated, 1);
    assert.equal(
      Number((await b.ctx.db('data_notes').count({ n: '*' }))[0].n),
      0,
      'no records came',
    );

    // A target whose table lacks the column gets it added.
    await b.ctx.db.schema.dropTable('data_notes');
    await b.ctx.db.schema.createTable('data_notes', (t) => {
      t.integer('id').primary();
      t.string('title', 80);
    });
    const full = await download(admin, 'tables=data_notes');
    const preview = await upload(other, 'dryRun=true', full.body);
    assert.deepEqual(preview.body.tables[0].newColumns, ['extra']);
    const done = await upload(other, 'confirm=IMPORT', full.body);
    assert.equal(done.body.result.columnsAdded, 1);
    assert.equal((await b.ctx.db('data_notes').first()).extra, 'x');
  } finally {
    await a.close();
    await b.close();
  }
});

test('choose which tables of a file to import; a table the file lacks is refused', async () => {
  const a = await startNode({ seed: true });
  const b = await startNode({ seed: true });
  try {
    const admin = await signedIn(a.app);
    await makeTable(a, 'data_a');
    await makeTable(a, 'data_b');
    await a.ctx.db('data_a').insert({ id: 1, title: 'a' });
    await a.ctx.db('data_b').insert({ id: 1, title: 'b' });
    const exp = await download(admin, 'tables=data_a,data_b');
    const other = await signedIn(b.app);
    const done = await upload(other, 'confirm=IMPORT&tables=data_b', exp.body);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.imported, ['data_b']);
    assert.equal(await b.ctx.db.schema.hasTable('data_a'), false, 'the other table stayed out');
    assert.equal((await b.ctx.db('data_b').first()).title, 'b');
    assert.equal((await upload(other, 'confirm=IMPORT&tables=users', exp.body)).status, 403);
  } finally {
    await a.close();
    await b.close();
  }
});

test('who may do what: sensitive tables need the SQL console right, migration tables are never offered, reading needs dbms.read', async () => {
  const node = await startNode({ seed: true });
  try {
    const admin = await signedIn(node.app);
    const mk = async (email, perms) => {
      const role = await admin
        .post('/api/admin/roles')
        .send({ name: `r-${email}`, permissions: perms });
      assert.equal(role.status, 201, JSON.stringify(role.body));
      const u = await admin.post('/api/admin/users').send({
        email,
        name: 'T',
        password: 'Another-Pass-77',
        roleId: role.body.id ?? role.body.role?.id,
      });
      assert.ok([200, 201].includes(u.status), JSON.stringify(u.body));
      return signedIn(node.app, { email, password: 'Another-Pass-77' });
    };
    await makeTable(node);
    const none = await mk('none@example.com', ['admin.access']);
    assert.equal((await download(none, 'tables=data_notes')).status, 403);
    const reader = await mk('read@example.com', ['admin.access', 'dbms.read']);
    assert.equal((await download(reader, 'tables=data_notes')).status, 200);
    assert.equal((await download(reader, 'tables=users')).status, 403, 'users is sensitive');
    assert.equal(
      (await upload(reader, 'dryRun=true', Buffer.from('x'))).status,
      403,
      'import needs dbms.write',
    );
    const writer = await mk('write@example.com', ['admin.access', 'dbms.read', 'dbms.write']);
    const exp = await download(reader, 'tables=data_notes');
    assert.equal((await upload(writer, 'dryRun=true', exp.body)).status, 200);

    assert.equal((await download(admin, 'tables=knex_migrations')).status, 422);
    assert.equal((await download(admin, 'tables=nope_table')).status, 404);
    assert.equal((await download(admin, 'tables=')).status, 422);
    assert.equal(
      (await download(admin, 'tables=users')).status,
      200,
      'the SQL-console right allows it',
    );
    assert.equal((await upload(admin, 'dryRun=true', Buffer.from('not a zip'))).status, 422);
    assert.equal((await upload(admin, 'dryRun=true', Buffer.alloc(0))).status, 415);
  } finally {
    await node.close();
  }
});
