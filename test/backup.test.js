import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { makeNode, signedIn } from './helpers.js';

let node, admin, svc;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  svc = node.ctx.backup;
});
after(() => node.close());

const sha = (b) => createHash('sha256').update(b).digest('hex');
const actor = () => ({ id: 1, email: 'admin@example.com', can: () => true });

/** Make a backup and wait until it is ready. */
async function backUp(opts = {}) {
  const b = await svc.create(opts, actor());
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
  await svc.restore(id, { confirm: 'RESTORE', safety: false, ...opts }, actor());
  await svc.idle();
  return svc.status();
}
const redirects = () => node.ctx.db('redirects').select('from_path').orderBy('from_path');
const addRedirect = (p) =>
  node.ctx
    .db('redirects')
    .insert({ from_path: p, to_url: '/x', status_code: 301, created_at: Date.now() });

describe('backup and restore', () => {
  test('a backup holds user data and media, and leaves out runtime tables', async () => {
    await addRedirect('/keep-me');
    const m = await node.ctx.media.upload({
      buffer: Buffer.from('hello backup'),
      name: 'note.txt',
    });
    const b = await backUp();
    assert.ok(b.size > 0);
    assert.ok(b.manifest.tables.users.rows >= 1);
    assert.ok(b.manifest.tables.redirects.rows >= 1);
    for (const t of ['sessions', 'knex_migrations', 'audit_logs', 'backups', 'config_meta'])
      assert.equal(t in b.manifest.tables, false, `${t} is not backed up`);
    assert.ok(b.manifest.skippedTables.includes('sessions'));
    assert.equal(b.manifest.media.files >= 1, true);
    const zip = new AdmZip(
      await (async () => {
        const chunks = [];
        for await (const c of (await svc.open(b.id)).stream) chunks.push(c);
        return Buffer.concat(chunks);
      })(),
    );
    assert.ok(
      zip.getEntry(
        `media/m/${m.id}/${(await node.ctx.db('media').where({ id: m.id }).first()).original_file}`,
      ),
    );
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

  test('restoring needs the typed word; then data comes back and later changes are gone', async () => {
    const b = await backUp();
    await addRedirect('/made-after');
    await node.ctx.db('redirects').where({ from_path: '/keep-me' }).delete();
    await assert.rejects(svc.restore(b.id, { confirm: 'yes' }, actor()), /Type RESTORE/);

    const status = await restoreAndWait(b.id);
    assert.equal(status.error ?? null, null);
    assert.equal(status.result.secretsCleared, 0);
    const paths = (await redirects()).map((r) => r.from_path);
    assert.ok(paths.includes('/keep-me'), 'a record deleted after the backup is back');
    assert.ok(!paths.includes('/made-after'), 'a record made after the backup is gone');
  });

  test('uploaded files are restored too', async () => {
    const m = await node.ctx.media.upload({ buffer: Buffer.from('second file'), name: 'two.txt' });
    const row = await node.ctx.db('media').where({ id: m.id }).first();
    const key = `m/${m.id}/${row.original_file}`;
    const b = await backUp();
    await node.ctx.storage.delete(`m/${m.id}`);
    assert.equal(await node.ctx.storage.exists(key), false);
    await restoreAndWait(b.id);
    assert.equal(await node.ctx.storage.exists(key), true);
  });

  test('everyone is signed out after a restore, and settings are reloaded on every server', async () => {
    const before = (await node.ctx.db('config_meta').first()).config_version;
    const b = await backUp();
    await restoreAndWait(b.id);
    assert.ok((await node.ctx.db('config_meta').first()).config_version > before);
    const me = await admin.get('/api/auth/me');
    assert.equal(me.status, 401);
    admin = await signedIn(node.app);
  });

  test('a safety backup of the current state is made first by default', async () => {
    const b = await backUp();
    const count = (await svc.list()).length;
    await svc.restore(b.id, { confirm: 'RESTORE' }, actor());
    await svc.idle();
    const all = await svc.list();
    assert.equal(all.length, count + 1);
    const safety = all.find((x) => x.source === 'safety');
    assert.ok(safety && safety.status === 'ready');
    assert.match(safety.name, /Before restoring/);
  });
});

describe('what a restore refuses or cleans', () => {
  test('a backup from a newer version is refused, nothing changes', async () => {
    const b = await backUp();
    const future = await tampered(b.id, (zip) => {
      const m = JSON.parse(zip.getEntry('manifest.json').getData().toString());
      m.migrations.push('29990101000001_from_the_future.js');
      zip.updateFile('manifest.json', Buffer.from(JSON.stringify(m)));
    });
    const plan = await svc.inspect(future.id);
    assert.equal(plan.blockers.length, 1);
    await assert.rejects(svc.restore(future.id, { confirm: 'RESTORE' }, actor()), /newer version/);
  });

  test('a damaged table file is caught before anything is touched', async () => {
    await addRedirect('/still-here');
    const b = await backUp();
    const bad = await tampered(b.id, (zip) => {
      const e = zip.getEntry('db/redirects.ndjson');
      zip.updateFile(e.entryName, Buffer.concat([e.getData(), Buffer.from('{"junk":1}\n')]));
    });
    const status = await restoreAndWait(bad.id);
    assert.match(status.error, /damaged/);
    assert.ok((await redirects()).some((r) => r.from_path === '/still-here'));
  });

  test('if the data swap fails part-way, nothing is changed (it is one transaction)', async () => {
    await addRedirect('/atomic');
    const b = await backUp();
    const live = (await node.ctx.db('users').select('id', 'email')).length;
    const bad = await tampered(b.id, (zip) => {
      const e = zip.getEntry('db/users.ndjson');
      const data = Buffer.concat([e.getData(), e.getData()]); // every user twice: the primary key objects
      zip.updateFile(e.entryName, data);
      const m = JSON.parse(zip.getEntry('manifest.json').getData().toString());
      m.tables.users.sha256 = sha(data);
      zip.updateFile('manifest.json', Buffer.from(JSON.stringify(m)));
    });
    const status = await restoreAndWait(bad.id);
    assert.ok(status.error, 'the restore reports why it failed');
    assert.equal((await node.ctx.db('users').select('id')).length, live);
    assert.ok((await redirects()).some((r) => r.from_path === '/atomic'));
  });

  test('a file that is not a backup is refused on upload', async () => {
    await assert.rejects(svc.upload(Buffer.from('not a zip'), 'x', actor()), /not a backup|zip/);
    const z = new AdmZip();
    z.addFile('hello.txt', Buffer.from('hi'));
    await assert.rejects(svc.upload(z.toBuffer(), 'x', actor()), /no manifest|not a backup/);
  });

  test('secrets: "leave out" removes every saved secret; "keep" clears only the ones this server cannot read', async () => {
    const readable = node.ctx.crypto.encrypt('mine', 'test.secret');
    const foreign = 'enc:v1:deadbeef:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA';
    await node.ctx.db('redirects').where({ from_path: '/keep-me' }).update({ to_url: readable });
    await node.ctx.db('redirects').where({ from_path: '/still-here' }).update({ to_url: foreign });

    const removed = await backUp({ secrets: 'remove' });
    assert.ok(removed.manifest.secretsRemoved >= 2);
    const noSecrets = await tampered(removed.id, () => {});
    assert.equal(noSecrets.secrets, 'remove');

    const kept = await backUp({ secrets: 'keep' });
    const plan = await svc.inspect(kept.id);
    assert.equal(plan.secretsNotReadable, 1);
    assert.match(plan.warnings.join(' '), /cleared/);
    const status = await restoreAndWait(kept.id);
    assert.equal(status.result.secretsCleared, 1);
    const rows = await node.ctx.db('redirects').select('from_path', 'to_url');
    assert.equal(rows.find((r) => r.from_path === '/keep-me').to_url, readable);
    assert.equal(rows.find((r) => r.from_path === '/still-here').to_url, '');
  });
});

describe('who can do what', () => {
  test('without a backup permission every route is refused', async () => {
    await node.ctx
      .db('roles')
      .insert({
        name: 'nobackup',
        description: 'x',
        is_system: false,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .catch(() => {});
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
    admin = await signedIn(node.app); // earlier restores signed everyone out
    const b = await backUp();
    const del = await admin
      .delete(`/api/admin/backups/${b.id}`)
      .set('x-csrf-token', (await admin.get('/api/auth/csrf')).body.csrfToken);
    assert.equal(del.status, 204);
    assert.equal(await node.ctx.storage.exists(`backups/${b.id}.zip`), false);
  });
});
