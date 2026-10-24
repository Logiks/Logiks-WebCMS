import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import v8 from 'node:v8';
import vm from 'node:vm';
import { makeNode, signedIn } from './helpers.js';
import { DATA_PREFIX, gitChangedFiles, safeRel } from '../src/modules/backup/service.js';

let node, admin, svc, db;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  svc = node.ctx.backup;
  db = node.ctx.db;
});
after(() => node.close());

const sha = (b) => createHash('sha256').update(b).digest('hex');
const actor = () => ({ id: 1, email: 'admin@example.com', can: () => true });
const NOFOLDERS = { folders: [], includeMedia: false };

/** Make a backup and wait until it is ready. */
async function backUp(opts = {}) {
  const b = await svc.create({ ...NOFOLDERS, ...opts }, actor());
  await svc.idle();
  const done = await svc.get(b.id);
  assert.equal(done.status, 'ready', done.error);
  return done;
}
/** Read a stored backup, let `edit` change its zip, and upload the result as a new backup. */
async function tampered(id, edit) {
  const { stream } = await svc.open(id);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const zip = new AdmZip(Buffer.concat(chunks));
  edit(zip);
  return svc.upload(zip.toBuffer(), 'tampered', actor());
}
async function restoreAndWait(id, opts = {}) {
  await svc.restore(id, { confirm: 'RESTORE', ...opts }, actor());
  await svc.idle();
  return svc.status();
}
const dropAll = async () => {
  for (const t of ['do_orders', 'sys_flags', 'data_items', 'do_logbook', 'do_scratch'])
    await db.schema.dropTableIfExists(t);
};
const orders = async () => (await db('do_orders').orderBy('id')).map((r) => [r.customer, r.note]);
const makeOrders = async () => {
  await db.schema.dropTableIfExists('do_orders');
  await db.schema.createTable('do_orders', (t) => {
    t.increments('id');
    t.string('customer', 100).notNullable();
    t.integer('qty').notNullable().defaultTo(1);
    t.text('note').nullable();
    t.index(['customer'], 'do_orders_customer_idx');
  });
  await db('do_orders').insert({ customer: 'Acme', qty: 3, note: 'first' });
  await db('do_orders').insert({ customer: 'Zed', note: 'second' });
};

describe('what a backup holds', () => {
  test('the definition of every table, but records only from do_, sys_ and data_ tables', async () => {
    await makeOrders();
    const b = await backUp();
    const m = b.manifest;
    for (const t of [
      'users',
      'sessions',
      'audit_logs',
      'media',
      'settings',
      'redirects',
      'do_orders',
    ])
      assert.ok(m.schema[t]?.columns.length, `${t} has a definition`);
    assert.deepEqual(
      Object.keys(m.tables).filter((t) => !DATA_PREFIX.test(t)),
      [],
      'no other table carries records',
    );
    assert.equal(m.tables.do_orders.rows, 2);
    assert.equal('users' in m.tables, false);
    assert.equal('sessions' in m.tables, false);
    assert.ok(m.schema.users.columns.find((c) => c.name === 'email' && c.nullable === false));
    assert.ok(
      Object.values(m.schema).some((t) => t.foreignKeys.length),
      'foreign keys recorded',
    );
    assert.ok(m.schema.do_orders.indexes.some((i) => i.name === 'do_orders_customer_idx'));
    assert.equal(m.dataScope, 'prefixed');
  });

  test('table names with those prefixes are never treated as runtime state', () => {
    for (const n of ['do_x', 'sys_sessions', 'sys_audit_logs', 'data_cluster_nodes', 'do_backups'])
      assert.equal(DATA_PREFIX.test(n), true, n);
    for (const n of ['doc_x', 'system', 'database', 'sessions', 'users'])
      assert.equal(DATA_PREFIX.test(n), false, n);
  });

  test('it can be downloaded over HTTP only with backup.create, and is a real zip', async () => {
    const [b] = await svc.list();
    const ok = await admin
      .get(`/api/admin/backups/${b.id}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => cb(null, Buffer.concat(c)));
      });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /zip/);
    assert.ok(new AdmZip(ok.body).getEntry('manifest.json'));
    const anon = await (
      await import('supertest')
    )
      .default(node.app)
      .get(`/api/admin/backups/${b.id}/download`);
    assert.equal(anon.status, 401);
  });
});

describe('a restore only ever adds', () => {
  test('missing records come back; records already here are kept exactly as they are; nothing is deleted', async () => {
    await makeOrders();
    const b = await backUp();
    await db('do_orders').where({ customer: 'Acme' }).update({ note: 'edited after the backup' });
    await db('do_orders').where({ customer: 'Zed' }).delete(); // deleted after the backup
    await db('do_orders').insert({ customer: 'Later', note: 'made after the backup' });

    const status = await restoreAndWait(b.id);
    assert.equal(status.error ?? null, null);
    assert.equal(status.result.rowsAdded, 1, 'only the deleted record was missing');
    assert.equal(status.result.rowsAlreadyThere, 1);
    const rows = await orders();
    assert.deepEqual(
      rows.map((r) => r[0]).sort(),
      ['Acme', 'Later', 'Zed'],
      'the deleted one is back; the later one is still there',
    );
    assert.equal(
      rows.find((r) => r[0] === 'Acme')[1],
      'edited after the backup',
      'not overwritten',
    );
  });

  test('a table this server lacks is created with its columns, key, defaults and indexes, then filled', async () => {
    await makeOrders();
    await db.schema.dropTableIfExists('sys_flags');
    await db.schema.createTable('sys_flags', (t) => {
      t.string('flag', 60).primary();
      t.boolean('on').notNullable().defaultTo(false);
    });
    await db('sys_flags').insert({ flag: 'beta', on: true });
    await db.schema.dropTableIfExists('data_items');
    await db.schema.createTable('data_items', (t) => {
      t.integer('a').notNullable();
      t.integer('b').notNullable();
      t.string('label', 50).nullable();
      t.primary(['a', 'b']);
      t.unique(['label'], { indexName: 'data_items_label_uq' });
    });
    await db('data_items').insert([
      { a: 1, b: 1, label: 'x' },
      { a: 1, b: 2, label: 'y' },
    ]);
    const b = await backUp();
    for (const t of ['do_orders', 'sys_flags', 'data_items']) await db.schema.dropTable(t); // a server without them
    const plan = await svc.inspect(b.id);
    assert.deepEqual([...plan.creates].sort(), ['data_items', 'do_orders', 'sys_flags']);

    const status = await restoreAndWait(b.id);
    assert.equal(status.error ?? null, null);
    assert.equal(status.result.tablesCreated, 3);
    assert.equal((await db('do_orders')).length, 2);
    assert.equal((await db('sys_flags').first()).flag, 'beta');
    assert.equal((await db('data_items')).length, 2);
    const idx = (await node.ctx.dialect.indexList('do_orders')).map((i) => i.name);
    assert.ok(idx.includes('do_orders_customer_idx'));
    const uq = (await node.ctx.dialect.indexList('data_items')).find(
      (i) => i.name === 'data_items_label_uq',
    );
    assert.ok(uq?.unique);
    await db('do_orders').insert({ customer: 'New' });
    assert.equal(
      Number((await db('do_orders').where({ customer: 'New' }).first()).qty),
      1,
      'a plain default survived',
    );
  });

  test('an existing table gets the columns it lacks through ALTER TABLE; its own extra columns and rows are kept', async () => {
    await makeOrders();
    const b = await backUp(); // has customer, qty, note
    // this server's version of the table: older (no qty, no note) and with a column the backup does not know
    await db.schema.dropTable('do_orders');
    await db.schema.createTable('do_orders', (t) => {
      t.increments('id');
      t.string('customer', 100).notNullable();
      t.string('mine_only', 20).nullable();
    });
    await db('do_orders').insert({ customer: 'Existing', mine_only: 'keep me' });

    const plan = await svc.inspect(b.id);
    assert.ok(
      plan.warnings.join(' ').match(/columns added[^]*qty/),
      'the plan names the new columns',
    );
    const status = await restoreAndWait(b.id);
    assert.equal(status.error ?? null, null);
    assert.equal(status.result.columnsAdded, 2);
    const cols = (await node.ctx.dialect.columnDetails('do_orders')).map((c) => c.name);
    for (const c of ['id', 'customer', 'mine_only', 'qty', 'note']) assert.ok(cols.includes(c), c);
    const rows = await db('do_orders').orderBy('id');
    assert.equal(rows[0].customer, 'Existing');
    assert.equal(rows[0].mine_only, 'keep me', 'the extra column and its data are untouched');
    assert.equal(rows[0].note, null, 'old rows have nothing in a new column');
    const zed = rows.find((r) => r.customer === 'Zed');
    assert.ok(
      zed && zed.note === 'second' && Number(zed.qty) === 1,
      'a restored row has the new columns',
    );
    assert.equal(
      rows.some((r) => r.customer === 'Acme'),
      false,
      "the backup's id 1 is taken here by a different record, which is kept, so that one is not added",
    );
  });

  test('a record that clashes on a unique column is skipped quietly; a table with no key is filled only when empty', async () => {
    await db.schema.dropTableIfExists('do_logbook');
    await db.schema.createTable('do_logbook', (t) => {
      t.string('entry', 50).nullable(); // no primary key
    });
    await db('do_logbook').insert([{ entry: 'one' }, { entry: 'two' }]);
    await makeOrders();
    await db.schema.alterTable('do_orders', (t) =>
      t.unique(['customer'], { indexName: 'do_orders_cust_uq' }),
    );
    const b = await backUp();

    await db('do_orders').where({ customer: 'Zed' }).update({ customer: 'Zed2' });
    await db('do_orders').insert({ customer: 'Zed' }); // takes the unique name the backup's row 2 has
    const status = await restoreAndWait(b.id);
    assert.equal(status.error ?? null, null, 'a unique clash is not an error');
    assert.equal(
      status.result.rowsSkippedNoKey,
      2,
      'do_logbook already has rows and no key to compare',
    );
    assert.equal((await db('do_logbook')).length, 2, 'nothing doubled');

    await db('do_logbook').delete();
    const again = await restoreAndWait(b.id);
    assert.equal(again.result.rowsSkippedNoKey, 0);
    assert.equal((await db('do_logbook')).length, 2, 'an empty table with no key is filled');
  });

  test('ordinary data, users and sessions are never touched, and nobody is signed out', async () => {
    await makeOrders();
    const b = await backUp();
    await db('users').where({ id: 1 }).update({ name: 'Changed after the backup' });
    await db('redirects').insert({
      from_path: '/mine',
      to_url: '/x',
      status_code: 301,
      created_at: Date.now(),
    });
    await restoreAndWait(b.id);
    assert.equal((await db('users').where({ id: 1 }).first()).name, 'Changed after the backup');
    assert.ok(await db('redirects').where({ from_path: '/mine' }).first());
    assert.equal((await admin.get('/api/auth/me')).status, 200, 'still signed in');
  });

  test('during a restore not one DELETE, DROP, TRUNCATE or UPDATE is sent to the database', async () => {
    await makeOrders();
    await db.schema.dropTableIfExists('do_scratch');
    await db.schema.createTable('do_scratch', (t) => {
      t.increments('id');
      t.string('v', 10).nullable();
    });
    await db('do_scratch').insert({ v: 'a' });
    const b = await backUp();
    await db.schema.dropTable('do_scratch'); // so the restore creates a table too
    await db.schema.alterTable('do_orders', (t) => t.dropColumn('note')); // and alters one
    const seen = [];
    const spy = (q) => seen.push(q.sql);
    db.on('query', spy);
    try {
      const status = await restoreAndWait(b.id);
      assert.equal(status.error ?? null, null);
      assert.ok(status.result.tablesCreated >= 1 && status.result.columnsAdded >= 1);
    } finally {
      db.removeListener('query', spy);
    }
    assert.ok(seen.some((q) => /^insert/i.test(q)) && seen.some((q) => /^create table/i.test(q)));
    const destructive = seen.filter(
      (q) =>
        /^\s*(delete|drop|truncate|update)\b/i.test(q) ||
        /\bdrop\s+(table|column|index)\b/i.test(q),
    );
    assert.deepEqual(destructive, [], 'nothing destructive was sent');
  });

  test('the typed word is required, and a safety backup is optional', async () => {
    await makeOrders();
    const b = await backUp();
    await assert.rejects(svc.restore(b.id, { confirm: 'yes' }, actor()), /Type RESTORE/);
    const before = (await svc.list()).length;
    await restoreAndWait(b.id);
    assert.equal((await svc.list()).length, before, 'no safety backup unless asked for');
    await restoreAndWait(b.id, { safety: true });
    const all = await svc.list();
    assert.equal(all.length, before + 1);
    assert.ok(all.some((x) => x.source === 'safety' && x.status === 'ready'));
  });
});

describe('what a restore refuses', () => {
  test('a backup from a newer version is refused', async () => {
    const b = await backUp();
    const future = await tampered(b.id, (zip) => {
      const m = JSON.parse(zip.getEntry('manifest.json').getData().toString());
      m.migrations.push('29990101000001_from_the_future.js');
      zip.updateFile('manifest.json', Buffer.from(JSON.stringify(m)));
    });
    assert.equal((await svc.inspect(future.id)).blockers.length, 1);
    await assert.rejects(svc.restore(future.id, { confirm: 'RESTORE' }, actor()), /newer version/);
  });

  test('a damaged table file is caught before anything is touched', async () => {
    await makeOrders();
    const b = await backUp();
    await db.schema.dropTable('do_orders');
    const bad = await tampered(b.id, (zip) => {
      const e = zip.getEntry('db/do_orders.ndjson');
      zip.updateFile(e.entryName, Buffer.concat([e.getData(), Buffer.from('{"junk":1}\n')]));
    });
    const status = await restoreAndWait(bad.id);
    assert.match(status.error, /damaged/);
    assert.equal(await db.schema.hasTable('do_orders'), false, 'not even the table was created');
  });

  test('if adding the records fails, none of them are added (one transaction), and nothing is removed', async () => {
    await makeOrders();
    const b = await backUp();
    await db('do_orders').delete();
    await db('do_orders').insert({ customer: 'Survivor', note: 'must stay' });
    const bad = await tampered(b.id, (zip) => {
      const e = zip.getEntry('db/do_orders.ndjson');
      // the second record has no customer, which the column refuses
      const lines = e.getData().toString().trim().split('\n');
      lines[1] = JSON.stringify({ ...JSON.parse(lines[1]), customer: null });
      const data = Buffer.from(`${lines.join('\n')}\n`);
      zip.updateFile(e.entryName, data);
      const m = JSON.parse(zip.getEntry('manifest.json').getData().toString());
      m.tables.do_orders.sha256 = sha(data);
      zip.updateFile('manifest.json', Buffer.from(JSON.stringify(m)));
    });
    const status = await restoreAndWait(bad.id);
    assert.ok(status.error, 'it says why it failed');
    assert.deepEqual(
      await orders(),
      [['Survivor', 'must stay']],
      'no partial additions, nothing removed',
    );
  });

  test('a file that is not a backup is refused on upload', async () => {
    await assert.rejects(svc.upload(Buffer.from('not a zip'), 'x', actor()), /not a backup|zip/);
    const z = new AdmZip();
    z.addFile('hello.txt', Buffer.from('hi'));
    await assert.rejects(
      svc.upload(z.toBuffer(), 'x', actor()),
      /unexpected file|no manifest|not a backup/,
    );
  });
});

describe('secrets', () => {
  test('"leave out" removes every saved secret; "keep" clears only the ones this server cannot read', async () => {
    const readable = node.ctx.crypto.encrypt('mine', 'test.secret');
    const foreign = 'enc:v1:deadbeef:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA';
    await db.schema.dropTableIfExists('do_orders');
    await db.schema.createTable('do_orders', (t) => {
      t.increments('id');
      t.string('customer', 100).notNullable();
      t.text('note').nullable();
    });
    await db('do_orders').insert({ customer: 'mine', note: readable });
    await db('do_orders').insert({ customer: 'foreign', note: foreign });

    const removed = await backUp({ secrets: 'remove' });
    assert.equal(removed.manifest.secretsRemoved, 2);
    const kept = await backUp({ secrets: 'keep' });
    const plan = await svc.inspect(kept.id);
    assert.equal(plan.secretsNotReadable, 1);
    assert.match(plan.warnings.join(' '), /cleared/);

    await db('do_orders').delete();
    const status = await restoreAndWait(kept.id);
    assert.equal(status.error ?? null, null);
    assert.equal(status.result.secretsCleared, 1);
    const rows = await db('do_orders').select('customer', 'note');
    assert.equal(rows.find((r) => r.customer === 'mine').note, readable);
    assert.equal(rows.find((r) => r.customer === 'foreign').note, '');
  });
});

describe('uploaded files and folders', () => {
  const plug = () => path.join(node.ctx.env.PLUGINS_DIR, 'my-plugin');
  const put = async (rel, text) => {
    const f = path.join(plug(), rel);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, text);
  };

  test('uploaded files not already stored are restored; one that exists is never replaced', async () => {
    const m = await node.ctx.media.upload({ buffer: Buffer.from('original'), name: 'two.txt' });
    const row = await db('media').where({ id: m.id }).first();
    const key = `m/${m.id}/${row.original_file}`;
    const b = await backUp({ includeMedia: true });
    assert.ok(b.manifest.media.index[key]);
    await node.ctx.storage.delete(`m/${m.id}`);
    await restoreAndWait(b.id);
    assert.equal(await node.ctx.storage.exists(key), true, 'a missing file comes back');
    await fsp.writeFile(node.ctx.storage.localPath(key), 'changed since');
    const status = await restoreAndWait(b.id);
    assert.ok(status.result.filesKept >= 1);
    assert.equal(await fsp.readFile(node.ctx.storage.localPath(key), 'utf8'), 'changed since');
  });

  test('folder files that are missing are written; existing files are never overwritten; nothing is deleted', async () => {
    await put('plugin.json', '{"slug":"my-plugin"}');
    await put('admin/page.html', '<p>v1</p>');
    await fsp.mkdir(node.ctx.env.SITE_DIR, { recursive: true });
    await fsp.writeFile(path.join(node.ctx.env.SITE_DIR, 'pages-note.txt'), 'site v1');
    const b = await backUp({ folders: ['plugins', 'public'] });
    assert.equal(b.manifest.folders.plugins.files, 2);
    assert.equal('site' in b.manifest.folders, false);

    await put('admin/page.html', '<p>v2 edited later</p>'); // exists, different: kept
    await put('extra.js', 'added later'); // not in the backup: kept
    await fsp.rm(path.join(plug(), 'plugin.json')); // missing: comes back
    const plan = await svc.inspect(b.id);
    assert.match(plan.warnings.join(' '), /never overwritten/);
    const status = await restoreAndWait(b.id);
    assert.equal(status.error ?? null, null);
    assert.equal(
      await fsp.readFile(path.join(plug(), 'plugin.json'), 'utf8'),
      '{"slug":"my-plugin"}',
    );
    assert.equal(
      await fsp.readFile(path.join(plug(), 'admin/page.html'), 'utf8'),
      '<p>v2 edited later</p>',
    );
    assert.equal(await fsp.readFile(path.join(plug(), 'extra.js'), 'utf8'), 'added later');
    assert.ok(status.result.folderFiles >= 1 && status.result.folderFilesKept >= 1);
  });

  test('a changed folder file is caught by its checksum before anything is touched', async () => {
    await put('admin/page.html', '<p>keep</p>');
    const b = await backUp({ folders: ['plugins'] });
    const bad = await tampered(b.id, (zip) => {
      zip.updateFile(
        'files/plugins/my-plugin/admin/page.html',
        Buffer.from('<script>evil()</script>'),
      );
    });
    await fsp.rm(path.join(plug(), 'admin/page.html'));
    const status = await restoreAndWait(bad.id);
    assert.match(status.error, /damaged/);
    assert.equal(
      await fsp.stat(path.join(plug(), 'admin/page.html')).then(
        () => true,
        () => false,
      ),
      false,
    );
  });

  test('a path that tries to leave its folder is never accepted', () => {
    for (const bad of [
      '../x',
      'a/../../x',
      '/etc/passwd',
      'a//b',
      'a/./b',
      'a\\b',
      '',
      'x'.repeat(301),
    ])
      assert.equal(safeRel(bad), false, JSON.stringify(bad));
    assert.equal(safeRel('pages/[...path].html'), true);
    assert.equal(safeRel('my-plugin/admin/page.html'), true);
  });

  test('inside a git checkout only files that differ from the code are kept', async () => {
    const top = await fsp.mkdtemp(path.join(os.tmpdir(), 'cms-git-'));
    const run = (...a) => execFileSync('git', ['-C', top, ...a], { stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.t');
    run('config', 'user.name', 't');
    await fsp.mkdir(path.join(top, 'plugins/shipped'), { recursive: true });
    await fsp.writeFile(path.join(top, 'plugins/shipped/a.js'), 'one');
    await fsp.writeFile(path.join(top, 'plugins/shipped/b.js'), 'one');
    await fsp.writeFile(path.join(top, '.gitignore'), 'plugins/mine/\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    await fsp.writeFile(path.join(top, 'plugins/shipped/b.js'), 'changed');
    await fsp.mkdir(path.join(top, 'plugins/mine'), { recursive: true });
    await fsp.writeFile(path.join(top, 'plugins/mine/p.js'), 'mine');
    const changed = await gitChangedFiles(top, path.join(top, 'plugins'));
    assert.deepEqual([...changed].sort(), ['mine/p.js', 'shipped/b.js']);
    assert.equal(await gitChangedFiles(top, os.tmpdir()), null);
    await fsp.rm(top, { recursive: true, force: true });
  });
});

describe('large files are streamed, not held in memory', () => {
  test('backing up and restoring a 120 MB file keeps live buffer memory far below its size', async () => {
    const size = 120 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const key = 'm/990001/big.bin';
    await node.ctx.storage.putStream(
      key,
      Readable.from(
        (async function* () {
          for (let i = 0; i < size / chunk.length; i++) yield chunk;
        })(),
      ),
    );
    await db('media').insert({
      id: 990001,
      filename: 'big.bin',
      mime: 'application/octet-stream',
      kind: 'file',
      size,
      alt: '',
      hash: 'x'.repeat(64),
      original_file: 'big.bin',
      variants: '[]',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    // Buffers only waiting to be collected are not "held", so collect before each reading.
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    gc();
    const base = process.memoryUsage().arrayBuffers;
    let peak = 0;
    const timer = setInterval(() => {
      gc();
      peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
    }, 25);
    try {
      const b = await backUp({ includeMedia: true });
      assert.equal(b.manifest.media.index[key].bytes, size);
      await node.ctx.storage.delete('m/990001');
      const status = await restoreAndWait(b.id);
      assert.equal(status.error ?? null, null);
      assert.equal(await node.ctx.storage.size(key), size, 'the big file came back whole');
    } finally {
      clearInterval(timer);
    }
    assert.ok(
      peak < 20 * 1024 * 1024,
      `peak extra buffer memory was ${Math.round(peak / 1048576)} MB`,
    );
    await db('media').where({ id: 990001 }).delete();
    await node.ctx.storage.delete('m/990001');
  });

  test('a backup can be uploaded over HTTP as a raw body, and is then restorable', async () => {
    const b = await backUp();
    const { stream } = await svc.open(b.id);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const token = (await admin.get('/api/auth/csrf')).body.csrfToken;
    const up = await admin
      .post('/api/admin/backups/upload?name=moved.zip')
      .set('x-csrf-token', token)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.concat(chunks));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.item.source, 'uploaded');
    const plan = await admin.get(`/api/admin/backups/${up.body.item.id}/inspect`);
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body.blockers, []);
    const junk = await admin
      .post('/api/admin/backups/upload')
      .set('x-csrf-token', token)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('definitely not a zip'));
    assert.equal(junk.status, 422);
  });
});

describe('who can do what', () => {
  test('without a backup permission every route is refused', async () => {
    const anon = (await import('supertest')).default(node.app);
    for (const [m, p] of [
      ['get', '/api/admin/backups'],
      ['post', '/api/admin/backups'],
      ['post', '/api/admin/backups/1/restore'],
      ['delete', '/api/admin/backups/1'],
    ]) {
      const r = await anon[m](p);
      assert.ok([401, 403].includes(r.status), `${m} ${p} -> ${r.status}`);
    }
  });

  test('a backup can be deleted, which also removes its file', async () => {
    const b = await backUp();
    const token = (await admin.get('/api/auth/csrf')).body.csrfToken;
    const del = await admin.delete(`/api/admin/backups/${b.id}`).set('x-csrf-token', token);
    assert.equal(del.status, 204);
    assert.equal(await node.ctx.storage.exists(`backups/${b.id}.zip`), false);
  });
});

test('cleanup', async () => {
  await dropAll();
});
