import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn, ADMIN } from './helpers.js';
import { PROTECTED } from '../src/modules/dbms/ops.js';

let node, admin, db, ops;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  db = node.ctx.db;
  ops = node.ctx.dbOps;
});
after(() => node.close());

const actor = () => ({ id: 1, email: ADMIN.email, can: () => true });
const csrf = async () => (await admin.get('/api/auth/csrf')).body.csrfToken;
const post = async (url, body) =>
  admin
    .post(url)
    .set('x-csrf-token', await csrf())
    .send(body);
const seed = async () => {
  await db.schema.dropTableIfExists('do_orders');
  await db.schema.createTable('do_orders', (t) => {
    t.increments('id');
    t.string('customer', 50).notNullable();
  });
  await db('do_orders').insert([{ customer: 'Acme' }, { customer: 'Zed' }]);
  await db.schema.dropTableIfExists('data_notes');
  await db.schema.createTable('data_notes', (t) => {
    t.increments('id');
    t.string('body', 50).nullable();
  });
  await db('data_notes').insert({ body: 'keep or lose' });
};
const flushNow = async (tables, over = {}) => {
  const ch = await ops.challenge({ mode: 'tables', tables }, actor());
  return ops.flush(
    { token: ch.token, phrase: ch.phrase, password: ADMIN.password, ...over },
    actor(),
  );
};

describe('how the database is doing', () => {
  test('stats report engine, size, tables, records, latency, memory and the pool', async () => {
    await seed();
    const s = (await admin.get('/api/admin/dbms/ops/stats')).body;
    assert.equal(s.engine.kind, node.ctx.dialect.kind);
    assert.ok(s.engine.version);
    assert.ok(s.sizeBytes > 0);
    assert.ok(s.tables > 10 && s.rows > 0);
    assert.ok(s.pingMs >= 0);
    assert.ok(s.memory.app.rss > 0);
    assert.ok(Array.isArray(s.biggest) && s.biggest.length > 0);
    assert.ok(s.biggest.every((t) => typeof t.name === 'string' && t.rows >= 0));
    if (s.engine.kind !== 'sqlite') assert.ok(s.connections && s.connections.max > 0);
  });
});

describe('what an erase may touch', () => {
  test('accounts, roles, sessions, the audit log, backups and migrations are never in an erase', async () => {
    const all = await ops.plan({ mode: 'all' });
    for (const t of PROTECTED) assert.equal(all.tables.includes(t), false, t);
    await assert.rejects(ops.plan({ mode: 'tables', tables: ['users'] }), /cannot be erased/);
    await assert.rejects(ops.plan({ mode: 'tables', tables: ['backups'] }), /cannot be erased/);
    await assert.rejects(
      ops.plan({ mode: 'tables', tables: ['no_such_table'] }),
      /cannot be erased/,
    );
    await assert.rejects(ops.plan({ mode: 'tables', tables: [] }), /at least one/);
  });

  test('a table another table points at cannot go alone, and "all" keeps it', async () => {
    await db.schema.dropTableIfExists('do_lines');
    await db.schema.dropTableIfExists('do_heads');
    await db.schema.createTable('do_heads', (t) => t.increments('id'));
    await db.schema.createTable('do_lines', (t) => {
      t.increments('id');
      t.integer('head_id').unsigned().notNullable().references('id').inTable('do_heads');
    });
    await db('do_heads').insert({});
    await db('do_lines').insert({ head_id: 1 });
    await assert.rejects(
      ops.challenge({ mode: 'tables', tables: ['do_heads'] }, actor()),
      /used by "do_lines"/,
    );
    const all = await ops.plan({ mode: 'all' });
    assert.equal(
      all.tables.includes('do_heads'),
      true,
      'do_lines is erased too, so do_heads can go',
    );
    await db('do_lines').delete();
    await db.schema.dropTable('do_lines');
    await db.schema.dropTable('do_heads');
  });
});

describe('the double guard', () => {
  test('the screen needs permission, and every step is audited', async () => {
    const anon = (await import('supertest')).default(node.app);
    for (const u of [
      '/api/admin/dbms/ops/flush/plan',
      '/api/admin/dbms/ops/flush/challenge',
      '/api/admin/dbms/ops/flush',
    ])
      assert.ok([401, 403].includes((await anon.post(u).send({})).status), u);
    const r = await post('/api/admin/dbms/ops/flush/challenge', {
      mode: 'tables',
      tables: ['do_orders'],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.phrase, /^ERASE-[A-Z2-9]{6}$/);
    assert.ok(r.body.expiresAt > Date.now());
    assert.equal(r.body.plan.tables.join(), 'do_orders');
    const log = await db('audit_logs').where({ action: 'database.flush_requested' }).first();
    assert.ok(log);
  });

  test('wrong words or a wrong password erase nothing, and the challenge dies after three tries', async () => {
    await seed();
    const ch = await ops.challenge({ mode: 'tables', tables: ['do_orders'] }, actor());
    await assert.rejects(
      ops.flush({ token: ch.token, phrase: 'ERASE-WRONG1', password: ADMIN.password }, actor()),
      /words do not match/,
    );
    await assert.rejects(
      ops.flush({ token: ch.token, phrase: ch.phrase, password: 'not-the-password' }, actor()),
      /password is not right/,
    );
    assert.equal((await db('do_orders')).length, 2, 'nothing erased');
    await assert.rejects(
      ops.flush({ token: ch.token, phrase: 'x', password: 'x' }, actor()),
      /words do not match/,
    );
    await assert.rejects(
      ops.flush({ token: ch.token, phrase: ch.phrase, password: ADMIN.password }, actor()),
      /expired or was already used/,
      'three failed tries used the challenge up',
    );
    assert.equal((await db('do_orders')).length, 2);
  });

  test('a challenge is for one person, one time, and an unknown token is refused', async () => {
    await seed();
    const ch = await ops.challenge({ mode: 'tables', tables: ['do_orders'] }, actor());
    await assert.rejects(
      ops.flush(
        { token: ch.token, phrase: ch.phrase, password: ADMIN.password },
        { ...actor(), id: 2 },
      ),
      /someone else/,
    );
    await assert.rejects(
      ops.flush(
        { token: 'f'.repeat(32), phrase: 'ERASE-AAAAAA', password: ADMIN.password },
        actor(),
      ),
      /expired or was already used/,
    );
    const done = await ops.flush(
      { token: ch.token, phrase: ch.phrase, password: ADMIN.password },
      actor(),
    );
    assert.equal(done.total, 2);
    await assert.rejects(
      ops.flush({ token: ch.token, phrase: ch.phrase, password: ADMIN.password }, actor()),
      /expired or was already used/,
      'the same words cannot erase twice',
    );
  });

  test('a challenge that has run out of time is refused', async () => {
    await seed();
    const ch = await ops.challenge({ mode: 'tables', tables: ['do_orders'] }, actor());
    const real = Date.now;
    Date.now = () => real() + 6 * 60 * 1000;
    try {
      await assert.rejects(
        ops.flush({ token: ch.token, phrase: ch.phrase, password: ADMIN.password }, actor()),
        /expired/,
      );
    } finally {
      Date.now = real;
    }
    assert.equal((await db('do_orders')).length, 2);
  });
});

describe('erasing, with one step back', () => {
  test('a copy is made first, the chosen tables are emptied, others untouched, and it is audited', async () => {
    await seed();
    const before = (await db('users').select('id')).length;
    const r = await flushNow(['do_orders']);
    assert.equal((await db('do_orders')).length, 0);
    assert.equal((await db('data_notes')).length, 1, 'a table that was not chosen is untouched');
    assert.equal((await db('users').select('id')).length, before);
    assert.equal(await db.schema.hasTable('do_orders'), true, 'the table stays');
    const snap = await node.ctx.backup.get(r.snapshotId);
    assert.equal(snap.source, 'flush');
    assert.equal(snap.status, 'ready');
    assert.equal(
      snap.manifest.tables.do_orders.rows,
      2,
      'the copy holds the records that were erased',
    );
    const log = await db('audit_logs')
      .where({ action: 'database.flushed' })
      .orderBy('id', 'desc')
      .first();
    assert.match(log.meta, new RegExp(`"snapshotId":${r.snapshotId}`));
  });

  test('only the latest erase is kept', async () => {
    await seed();
    const a = await flushNow(['do_orders']);
    await db('data_notes').insert({ body: 'second' });
    const b = await flushNow(['data_notes']);
    const flushes = (await node.ctx.backup.list()).filter((x) => x.source === 'flush');
    assert.deepEqual(
      flushes.map((x) => x.id),
      [b.snapshotId],
    );
    assert.notEqual(a.snapshotId, b.snapshotId);
    assert.equal((await ops.last()).id, b.snapshotId);
  });

  test('going one step back puts the erased records back and keeps anything made since', async () => {
    await seed();
    await flushNow(['do_orders', 'data_notes']);
    await db('do_orders').insert({ id: 50, customer: 'Made after the erase' });
    await ops.undo(actor());
    await node.ctx.backup.idle();
    const status = await node.ctx.backup.status();
    assert.equal(status.error ?? null, null);
    const names = (await db('do_orders').orderBy('id')).map((r) => r.customer);
    assert.deepEqual(names, ['Acme', 'Zed', 'Made after the erase']);
    assert.equal((await db('data_notes')).length, 1);
  });

  test('"all data" leaves the protected tables alone and a way back exists', async () => {
    await seed();
    await db('redirects').insert({
      from_path: '/x',
      to_url: '/y',
      status_code: 301,
      created_at: Date.now(),
    });
    const users = (await db('users').select('id')).length;
    const ch = await ops.challenge({ mode: 'all' }, actor());
    assert.ok(ch.plan.tables.includes('redirects') && ch.plan.tables.includes('do_orders'));
    await ops.flush({ token: ch.token, phrase: ch.phrase, password: ADMIN.password }, actor());
    assert.equal((await db('redirects')).length, 0);
    assert.equal((await db('do_orders')).length, 0);
    assert.equal((await db('users').select('id')).length, users, 'accounts kept');
    assert.equal(
      (await admin.get('/api/auth/me')).status,
      200,
      'the person who erased is still signed in',
    );
    await ops.undo(actor());
    await node.ctx.backup.idle();
    assert.equal((await db('redirects')).length, 1);
    assert.equal((await db('do_orders')).length, 2);
  });

  test('if the copy cannot be made, nothing is erased', async () => {
    await seed();
    const real = node.ctx.storage.putStream;
    node.ctx.storage.putStream = async () => {
      throw new Error('disk is full');
    };
    try {
      await assert.rejects(flushNow(['do_orders']), /nothing was erased/);
    } finally {
      node.ctx.storage.putStream = real;
    }
    assert.equal((await db('do_orders')).length, 2, 'the records are all still there');
    const flushes = (await node.ctx.backup.list()).filter(
      (x) => x.source === 'flush' && x.status !== 'failed',
    );
    assert.ok(flushes.every((x) => x.status === 'ready'));
  });

  test('records that arrive while the copy is being made stop the erase instead of being lost', async () => {
    await seed();
    const real = node.ctx.backup.snapshot;
    node.ctx.backup.snapshot = async (...a) => {
      const snap = await real.apply(node.ctx.backup, a);
      await db('do_orders').insert({ customer: 'Arrived late' }); // after the copy was read
      return snap;
    };
    try {
      await assert.rejects(flushNow(['do_orders']), /changed while the copy was being made/);
    } finally {
      node.ctx.backup.snapshot = real;
    }
    assert.equal(
      (await db('do_orders')).length,
      3,
      'nothing was erased, including the late record',
    );
  });

  test('another person cannot undo without the permission, and nothing to undo is a clear message', async () => {
    const anon = (await import('supertest')).default(node.app);
    assert.ok(
      [401, 403].includes((await anon.post('/api/admin/dbms/ops/flush/undo').send({})).status),
    );
    for (const x of (await node.ctx.backup.list()).filter((b) => b.source === 'flush'))
      await node.ctx.backup.remove(x.id, actor());
    await assert.rejects(ops.undo(actor()), /no erase to go back from/);
  });
});
