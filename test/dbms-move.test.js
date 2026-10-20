import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode, signedIn, tmpDbUrl, until } from './helpers.js';
import { createDb, dialect } from '../src/core/db/index.js';
import {
  copyOrder,
  selfRefOrder,
  parseTarget,
  redactUrl,
  requote,
} from '../src/modules/dbms/migrate.js';

// The source is always the node's own (SQLite) database. TEST_MOVE_TARGET=mysql://root@127.0.0.1:3306 (or postgres://…)
// makes the copy go to a fresh database on that server; without it the target is another SQLite file.
function newTarget() {
  const base = process.env.TEST_MOVE_TARGET;
  if (!base) return tmpDbUrl();
  const old = process.env.TEST_DB_URL;
  process.env.TEST_DB_URL = base;
  try {
    return tmpDbUrl();
  } finally {
    if (old === undefined) delete process.env.TEST_DB_URL;
    else process.env.TEST_DB_URL = old;
  }
}
const kindOf = (url) =>
  url.startsWith('sqlite') ? 'sqlite' : url.startsWith('mysql') ? 'mysql' : 'pg';

describe('Move database: pure helpers', () => {
  test('parents are copied before children, and loops do not hang', () => {
    const order = copyOrder(
      ['child', 'parent', 'solo'],
      [{ table: 'child', column: 'p', refTable: 'parent', refColumn: 'id' }],
    );
    assert.ok(order.indexOf('parent') < order.indexOf('child'));
    assert.equal(order.length, 3);
    assert.equal(
      copyOrder(
        ['a', 'b'],
        [
          { table: 'a', column: 'x', refTable: 'b', refColumn: 'id' },
          { table: 'b', column: 'x', refTable: 'a', refColumn: 'id' },
        ],
      ).length,
      2,
    );
  });

  test('a table that points at itself loads each row after the row it references', () => {
    const rows = [
      { id: 3, parent: 2 },
      { id: 2, parent: 1 },
      { id: 1, parent: null },
    ];
    assert.deepEqual(
      selfRefOrder(rows, 'id', ['parent']).map((r) => r.id),
      [1, 2, 3],
    );
  });

  test('connection strings: engines are recognised, passwords never shown', () => {
    assert.equal(parseTarget('mysql://u:p@h:3306/d').kind, 'mysql');
    assert.equal(parseTarget('postgresql://u:p@h/d').kind, 'pg');
    assert.equal(parseTarget('sqlite:./x.db').kind, 'sqlite');
    assert.throws(() => parseTarget('mongodb://x'), /connection string/);
    assert.equal(redactUrl('mysql://root:s3cret@h:3306/d'), 'mysql://root:***@h:3306/d');
  });
});

describe('Move database: quoting between engines', () => {
  test('identifiers are requoted, string literals are not', () => {
    assert.equal(
      requote('select "a" from "t" where x = \'"q"\'', 'sqlite', 'mysql'),
      'select `a` from `t` where x = \'"q"\'',
    );
    assert.equal(requote('select `a` from `t`', 'mysql', 'pg'), 'select "a" from "t"');
    assert.equal(requote('select "a"', 'sqlite', 'pg'), 'select "a"');
  });
});

describe('Move database: end to end', () => {
  let node, admin, appRoot;
  before(async () => {
    appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-move-'));
    fs.writeFileSync(path.join(appRoot, '.env'), 'PORT=3000\nDB_URL=sqlite:./data/cms.db\n');
    node = await makeNode({ appRoot });
    admin = await signedIn(node.app);
    // Something of every kind: content with a title that is searchable, a console-made table, a self-referencing row.
    await node.ctx.dbms.createTable?.(
      {
        name: 'moved_extra',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'note', type: 'string' },
        ],
      },
      { can: () => true },
    );
    await node.ctx.db('moved_extra').insert([{ note: 'one' }, { note: 'two' }]);
    await node.ctx.db('search_index').insert({
      entry_id: 99,
      type: 'page',
      locale: 'en',
      title: 'Moved hello',
      body: 'b',
      updated_at: 1,
    });

    // Awkward and larger tables: a two-column key, a text key, and no key at all.
    const { db } = node.ctx;
    await db.schema.createTable('moved_big', (t) => {
      t.integer('a').notNullable();
      t.string('b', 40).notNullable();
      t.text('payload', 'longtext');
      t.primary(['a', 'b']);
    });
    await db.schema.createTable('moved_str', (t) => {
      t.string('code', 40).primary();
      t.integer('n');
    });
    await db.schema.createTable('moved_nopk', (t) => {
      t.integer('n');
      t.string('label', 40);
    });
    const fill = async (table, total, make) => {
      for (let i = 0; i < total; i += 200)
        await db(table).insert(
          Array.from({ length: Math.min(200, total - i) }, (_, k) => make(i + k)),
        );
    };
    await fill('moved_big', 7000, (i) => ({
      a: Math.floor(i / 5),
      b: `k${i % 5}`,
      payload: 'p'.repeat(i % 50),
    }));
    await fill('moved_str', 2500, (i) => ({ code: `c-${String(i).padStart(5, '0')}`, n: i }));
    await fill('moved_nopk', 2200, (i) => ({ n: i, label: `l${i}` }));

    // A view, an index, and a trigger — made after the first rows, so a trigger that fired during the copy would
    // leave extra rows in moved_audit and the row-count check would catch it.
    await db.schema.createTable('moved_audit', (t) => {
      t.increments('id');
      t.string('note', 191);
    });
    await db.raw('create view moved_notes_v as select id, note from moved_extra');
    await db.raw('create index moved_extra_note_ix on moved_extra(note)');
    const insertAudit = 'insert into moved_audit(note) values (new.note)';
    if (node.ctx.dialect.kind === 'sqlite')
      await db.raw(
        `create trigger moved_log after insert on moved_extra begin ${insertAudit}; end`,
      );
    else if (node.ctx.dialect.kind === 'mysql')
      await db.raw(
        `create trigger moved_log after insert on moved_extra for each row ${insertAudit}`,
      );
    else {
      await db.raw(
        `create function moved_fn() returns trigger as $$ begin ${insertAudit}; return new; end $$ language plpgsql`,
      );
      await db.raw(
        'create trigger moved_log after insert on moved_extra for each row execute function moved_fn()',
      );
    }
    await db('moved_extra').insert({ note: 'audited' });
  });
  after(async () => {
    await node.close();
    fs.rmSync(appRoot, { recursive: true, force: true });
  });

  test('needs the dbms.migrate permission', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'dba-lite', description: '', permissions: ['dbms.read', 'dbms.query'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'dba@example.com',
        name: 'D',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const dba = await signedIn(node.app, {
      email: 'dba@example.com',
      password: 'Some-long-pass-12',
    });
    assert.equal((await dba.get('/api/admin/dbms/move')).status, 403);
    assert.equal((await admin.get('/api/admin/dbms/move')).status, 200);
  });

  test('refuses the database it already runs on, junk strings, and unreachable servers', async () => {
    const same = await admin.post('/api/admin/dbms/move/test').send({ url: node.env.DB_URL });
    assert.equal(same.status, 422);
    const junk = await admin.post('/api/admin/dbms/move/test').send({ url: 'ftp://nope' });
    assert.equal(junk.status, 422);
    const down = await admin
      .post('/api/admin/dbms/move/test')
      .send({ url: 'postgres://u:secret@127.0.0.1:1/none' });
    assert.equal(down.status, 422);
    assert.ok(!JSON.stringify(down.body).includes('secret'), 'the password is never echoed');
  });

  test('refuses a target that already has tables', async () => {
    const other = newTarget();
    const c = createDb({
      dbKind: kindOf(other.url),
      DB_URL: other.url,
      DB_POOL_MIN: 1,
      DB_POOL_MAX: 2,
    });
    await c.schema.createTable('already_here', (t) => t.increments('id'));
    await c.destroy();
    const r = await admin.post('/api/admin/dbms/move/start').send({ url: other.url });
    assert.equal(r.status, 422);
    assert.equal(r.body.error?.code ?? r.body.code, 'target_not_empty');
    other.cleanup();
  });

  test('copies every table, checks the counts, fixes counters, and only then switches', async () => {
    const dest = newTarget();
    const start = await admin.post('/api/admin/dbms/move/start').send({ url: dest.url });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    await until(async () => (await admin.get('/api/admin/dbms/move')).body.state !== 'running', {
      timeout: 60000,
      every: 200,
    });
    const st = (await admin.get('/api/admin/dbms/move')).body;
    assert.equal(st.state, 'ready', JSON.stringify(st));
    assert.deepEqual(st.mismatches, []);
    assert.deepEqual([...st.extraTables].sort(), [
      'moved_audit',
      'moved_big',
      'moved_extra',
      'moved_nopk',
      'moved_str',
    ]);
    const obj = (kind, name) => st.objects.find((o) => o.kind === kind && o.name === name);
    assert.equal(
      obj('view', 'moved_notes_v')?.status,
      'created',
      'a plain view moves on every engine',
    );
    assert.equal(obj('index', 'moved_extra_note_ix')?.status, 'created');
    assert.ok(obj('trigger', 'moved_log'), 'the trigger is accounted for');
    if (st.targetKind === st.sourceKind) {
      assert.equal(
        obj('trigger', 'moved_log').status,
        'created',
        'same engine: the trigger moves as it is',
      );
      if (st.sourceKind === 'pg') assert.equal(obj('function', 'moved_fn').status, 'created');
    } else if (obj('trigger', 'moved_log').status === 'skipped')
      assert.match(
        obj('trigger', 'moved_log').sql,
        /create trigger \W?moved_log/i,
        'its SQL is kept for porting',
      );
    assert.ok(
      !JSON.stringify(st).includes(dest.url.split('@')[0].split(':')[2] ?? '\u0000'),
      'no password in status',
    );

    // The copy is a working database: same users, same data, and a new row gets a fresh id.
    const kind = kindOf(dest.url);
    const t = createDb({ dbKind: kind, DB_URL: dest.url, DB_POOL_MIN: 1, DB_POOL_MAX: 2 });
    try {
      assert.equal(Number((await t('users').count({ n: '*' }).first()).n), 2);
      assert.ok(await t('users').where({ email: 'admin@example.com' }).first());
      assert.equal(Number((await t('moved_extra').count({ n: '*' }).first()).n), 3);
      assert.equal(Number((await t('moved_big').count({ n: '*' }).first()).n), 7000);
      assert.equal(Number((await t('moved_str').count({ n: '*' }).first()).n), 2500);
      assert.equal(Number((await t('moved_nopk').count({ n: '*' }).first()).n), 2200);
      assert.equal((await t('moved_str').orderBy('code', 'desc').first()).n, 2499);
      assert.equal(
        Number((await t('moved_audit').count({ n: '*' }).first()).n),
        1,
        'the trigger did not fire while the copy ran',
      );
      assert.equal(
        Number((await t('moved_notes_v').count({ n: '*' }).first()).n),
        3,
        'the view works',
      );
      const id = await dialect(t).insertGetId(t('moved_extra'), { note: 'three' });
      assert.equal(id, 4, 'the auto-increment counter continued from the copied rows');
      if (kind === 'sqlite')
        assert.equal(
          Number(
            (
              await t.raw('select count(*) as n from search_fts where search_fts match ?', [
                'moved',
              ])
            ).at(0).n,
          ),
          1,
          'the SQLite full-text index is rebuilt from search_index',
        );
      const migs = await t('knex_migrations').count({ n: '*' }).first();
      assert.ok(Number(migs.n) > 10, 'the target records its migrations');
    } finally {
      await t.destroy();
    }

    // Switching needs the same string, rewrites .env (keeping a backup), and tells you what other servers need.
    const wrong = await admin
      .post('/api/admin/dbms/move/switch')
      .send({ url: 'sqlite:./other.db' });
    assert.equal(wrong.status, 422);
    const sw = await admin.post('/api/admin/dbms/move/switch').send({ url: dest.url });
    assert.equal(sw.status, 200, JSON.stringify(sw.body));
    assert.equal(sw.body.envUpdated, true);
    const env = fs.readFileSync(path.join(appRoot, '.env'), 'utf8');
    assert.ok(env.includes(`DB_URL=${dest.url}`));
    assert.ok(env.includes('PORT=3000'), 'the rest of .env is untouched');
    assert.ok(fs.readdirSync(appRoot).some((f) => f.startsWith('.env.bak-')));
    assert.ok(!sw.body.otherServers.includes('secret'));
    const again = await admin.post('/api/admin/dbms/move/switch').send({ url: dest.url });
    assert.equal(again.status, 409);
    dest.cleanup();
  });

  const orphan = async () => {
    const cols = await node.ctx.dialect.columnDetails('theme_files');
    const row = Object.fromEntries(
      cols
        .filter((c) => !c.nullable && !c.autoIncrement)
        .map((c) => [c.name, /int/i.test(c.type) ? 1 : 'ghost']),
    );
    await node.ctx.db.raw('PRAGMA foreign_keys = OFF');
    await node.ctx.db('theme_files').insert(row);
    await node.ctx.db.raw('PRAGMA foreign_keys = ON');
  };
  const settle = () =>
    until(async () => (await admin.get('/api/admin/dbms/move')).body.state !== 'running', {
      timeout: 60000,
      every: 200,
    });

  test('a copy that stops part-way keeps what it finished and can be resumed once the cause is fixed', async () => {
    // A row whose parent does not exist: the source tolerates it, the target refuses it.
    if (node.ctx.dialect.kind !== 'sqlite') return;
    await orphan();
    const dest = newTarget();
    await admin.post('/api/admin/dbms/move/discard').send({});
    await admin.post('/api/admin/dbms/move/start').send({ url: dest.url });
    await settle();
    let st = (await admin.get('/api/admin/dbms/move')).body;
    assert.equal(st.state, 'failed');
    assert.equal(st.resumable, true);
    assert.match(st.error, /Resume/);
    assert.ok(
      st.tables.some((t) => t.done),
      'tables before the failing one are done',
    );
    assert.ok(st.tables.some((t) => !t.done));

    assert.equal(
      (
        await admin
          .post('/api/admin/dbms/move/start')
          .send({ url: 'sqlite:./nope.db', resume: true })
      ).status,
      409,
    );
    await node.ctx.db('theme_files').where({ theme_id: 'ghost' }).del();
    const r = await admin.post('/api/admin/dbms/move/start').send({ url: dest.url, resume: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await settle();
    st = (await admin.get('/api/admin/dbms/move')).body;
    assert.equal(st.state, 'ready', JSON.stringify(st.error));
    assert.deepEqual(st.mismatches, []);
    dest.cleanup();
  });

  test('Start over clears only what the copy built, and needs the right connection string', async () => {
    if (node.ctx.dialect.kind !== 'sqlite') return;
    await orphan();
    const dest = newTarget();
    await admin.post('/api/admin/dbms/move/discard').send({});
    await admin.post('/api/admin/dbms/move/start').send({ url: dest.url });
    await settle();
    assert.equal((await admin.get('/api/admin/dbms/move')).body.state, 'failed');
    assert.equal(
      (await admin.post('/api/admin/dbms/move/discard').send({ url: 'sqlite:./other.db' })).status,
      422,
    );
    assert.equal(
      (await admin.post('/api/admin/dbms/move/discard').send({ url: dest.url })).status,
      200,
    );
    assert.equal((await admin.get('/api/admin/dbms/move')).body.state, 'idle');
    assert.equal(
      (await admin.post('/api/admin/dbms/move/test').send({ url: dest.url })).body.empty,
      true,
      'tables and views are gone',
    );
    await node.ctx.db('theme_files').where({ theme_id: 'ghost' }).del();
    dest.cleanup();
  });
});
