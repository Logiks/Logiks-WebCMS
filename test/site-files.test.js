import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { makeNode, startNode, tmpDb, sharedBus, busFor, until } from './helpers.js';
import { classify } from '../src/modules/site/files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rejects = (p, re) =>
  assert.rejects(p, (e) => e.status === 422 && re.test(e.message), `expected a 422 matching ${re}`);
const mirrored = (node, rel) => path.join(node.env.SITE_DIR, rel);

let node;
before(async () => {
  node = await makeNode();
  // A new site starts with the starter pages and components; these tests want a blank tree.
  await node.ctx.siteFiles.apply({ deletes: node.ctx.siteFiles.list().map((f) => f.path) }, null);
});
after(() => node.close());

describe('paths', () => {
  const info = (kind, name, params = [], catchAll = false) => ({ kind, name, params, catchAll });
  test('pages and components are named by a strict grammar', () => {
    assert.deepEqual(classify('pages/about.html'), info('page', 'about'));
    assert.deepEqual(classify('pages/products/index.html'), info('page', 'products/index'));
    assert.deepEqual(classify('components/ui/card-2.html'), info('component', 'ui/card-2'));
    for (const bad of [
      '',
      'about.html',
      'pages/about.htm',
      'pages/About.html',
      'pages/../secrets.html',
      'pages//x.html',
      'pages/a b.html',
      'pages/.hidden.html',
      'themes/default/x.html',
      'components/theme/header.html', // reserved for the active theme's own components
      'components/theme.html',
      `pages/${'a'.repeat(200)}.html`,
      'pages/a/b/c/d/e/f.html',
    ])
      assert.throws(
        () => classify(bad),
        (e) => e.status === 422,
        `should refuse "${bad}"`,
      );
  });

  test('a part of an address that varies is written [name] or [...name]; components and server addresses cannot', () => {
    assert.deepEqual(classify('pages/blog/[slug].html'), info('page', 'blog/[slug]', ['slug']));
    assert.deepEqual(
      classify('pages/[type]/[...path].html'),
      info('page', '[type]/[...path]', ['type', 'path'], true),
    );
    for (const bad of [
      'pages/[...path]/more.html', // a catch-all is last
      'pages/[a]/[a].html', // the same name twice
      'pages/[Slug].html',
      'pages/[].html',
      'components/[x].html', // only pages are addressed
      'pages/admin.html', // the server answers these before any page
      'pages/api/x.html',
      'pages/[...path]/[x].html',
    ])
      assert.throws(
        () => classify(bad),
        (e) => e.status === 422,
        `should refuse "${bad}"`,
      );
  });
});

describe('saving files', () => {
  test('create, read, list, update and delete', async () => {
    const v0 = node.ctx.siteFiles.version;
    const r = await node.ctx.siteFiles.put(
      'pages/about.html',
      '---\ntitle: About\n---\n<p>Hi</p>',
      null,
    );
    assert.equal(r.changed, true);
    assert.equal(node.ctx.siteFiles.version, v0 + 1);
    const f = node.ctx.siteFiles.get('pages/about.html');
    assert.equal(f.content, '---\ntitle: About\n---\n<p>Hi</p>');
    assert.equal(f.kind, 'page');
    assert.equal(f.hash, r.hash);
    assert.ok(node.ctx.siteFiles.list().some((x) => x.path === 'pages/about.html'));
    assert.deepEqual(node.ctx.siteFiles.list('components/'), []);

    // an identical save changes nothing (no version bump, so no cache churn anywhere)
    assert.equal(
      (await node.ctx.siteFiles.put('pages/about.html', f.content, null)).changed,
      false,
    );
    assert.equal(node.ctx.siteFiles.version, v0 + 1);

    await node.ctx.siteFiles.put('pages/about.html', '<p>Changed</p>', null);
    assert.equal(node.ctx.siteFiles.get('pages/about.html').content, '<p>Changed</p>');

    await node.ctx.siteFiles.remove('pages/about.html', null);
    assert.throws(
      () => node.ctx.siteFiles.get('pages/about.html'),
      (e) => e.status === 404,
    );
    await assert.rejects(
      node.ctx.siteFiles.remove('pages/about.html', null),
      (e) => e.status === 404,
    );
  });

  test('what is wrong is explained at save time, and nothing is stored', async () => {
    const put = (p, c) => node.ctx.siteFiles.put(p, c, null);
    const before = node.ctx.siteFiles.version;
    await rejects(put('pages/x.html', '{% if never_closed %}'), /Template/);
    await rejects(put('pages/x.html', '{% include "../../etc/passwd" %}'), /include/); // not an allowed tag
    await rejects(put('pages/x.html', '---\nlayout: ../../x\n---\nhi'), /layout/);
    await rejects(put('components/x.html', '<style>.a{color:red</style><p>x</p>'), /unclosed|CSS/);
    await rejects(
      put('components/x.html', '<style>@import url(https://evil.example/a.css);</style>x'),
      /@import/,
    );
    await rejects(
      put('components/x.html', '<script type="application/json" data-cms="meta">{oops</script>'),
      /JSON/,
    );
    await rejects(put('pages/x.html', 'a'.repeat(200 * 1024 + 1)), /larger than 200 KB/);
    await rejects(put('pages/x.html', 'has a \0 byte'), /binary/);
    // a page that says what it shows must have the address parts that content needs
    await rejects(put('pages/x.html', '---\nentry: post\n---\nx'), /needs \[slug\]/);
    await rejects(put('pages/[type]/x.html', '---\nentry: own\n---\nx'), /needs \[type\]/);
    await rejects(put('pages/x.html', '---\nterms: category\n---\nx'), /terms: needs \[slug\]/);
    await rejects(
      put('pages/blog/[slug].html', '---\nentry: post\nterms: tag\n---\nx'),
      /not both/,
    );
    await put('pages/blog/[slug].html', '---\nentry: post\n---\n{{ params.slug }}'); // fine
    await put('pages/about.html', '---\nentry: page:about\n---\nx'); // one fixed entry, no parts needed
    await node.ctx.siteFiles.remove('pages/blog/[slug].html', null);
    await node.ctx.siteFiles.remove('pages/about.html', null);
    assert.equal(
      node.ctx.siteFiles.version,
      before + 4,
      'failed saves bump nothing (only the four good ones did)',
    );
    assert.equal(node.ctx.siteFiles.list().length, 0);
  });

  test('a save made from a stale copy is refused, not silently overwritten', async () => {
    const { hash } = await node.ctx.siteFiles.put('pages/lock.html', 'one', null);
    await node.ctx.siteFiles.put('pages/lock.html', 'two', null, hash); // right token: accepted
    await assert.rejects(
      node.ctx.siteFiles.put('pages/lock.html', 'three', null, hash), // old token
      (e) => e.status === 409 && /Someone changed this file/.test(e.message),
    );
    assert.equal(node.ctx.siteFiles.get('pages/lock.html').content, 'two');
    await assert.rejects(
      node.ctx.siteFiles.put('pages/nothere.html', 'x', null, 'a'.repeat(64)),
      (e) => e.status === 409,
      'expecting a file that is gone is also a conflict',
    );
    await node.ctx.siteFiles.remove('pages/lock.html', null);
  });

  test('every change is audited without the file content', async () => {
    await node.ctx.siteFiles.put('pages/audited.html', 'SECRET-LOOKING-BODY', {
      id: 1,
      email: 'a@b.c',
    });
    await node.ctx.siteFiles.remove('pages/audited.html', { id: 1, email: 'a@b.c' });
    const rows = await node.ctx
      .db('audit_logs')
      .where('action', 'like', 'site.file_%')
      .orderBy('id');
    const mine = rows.filter((r) => r.entity_id === 'pages/audited.html');
    assert.deepEqual(
      mine.map((r) => r.action),
      ['site.file_created', 'site.file_deleted'],
    );
    assert.ok(!JSON.stringify(rows).includes('SECRET-LOOKING-BODY'));
    assert.equal(mine[0].actor_email, 'a@b.c');
  });
});

describe('the local public/ folder', () => {
  test('is a mirror of the database: files appear, change and disappear', async () => {
    await node.ctx.siteFiles.put('pages/team/index.html', 'v1', null);
    const file = mirrored(node, 'pages/team/index.html');
    assert.equal(fs.readFileSync(file, 'utf8'), 'v1');
    await node.ctx.siteFiles.put('pages/team/index.html', 'v2', null);
    assert.equal(fs.readFileSync(file, 'utf8'), 'v2');
    await node.ctx.siteFiles.remove('pages/team/index.html', null);
    assert.ok(!fs.existsSync(file));
  });

  test('a hand edit is kept as .local instead of being silently destroyed', async () => {
    await node.ctx.siteFiles.put('pages/edited.html', 'from the database', null);
    const file = mirrored(node, 'pages/edited.html');
    fs.writeFileSync(file, 'typed by hand');
    await node.ctx.siteFiles.put('pages/other.html', 'anything', null); // any change refreshes the mirror
    assert.equal(fs.readFileSync(file, 'utf8'), 'from the database');
    assert.equal(fs.readFileSync(`${file}.local`, 'utf8'), 'typed by hand');
    await node.ctx.siteFiles.remove('pages/edited.html', null);
    await node.ctx.siteFiles.remove('pages/other.html', null);
  });

  test('a file the database does not have is not left lying in pages/', async () => {
    const stray = mirrored(node, 'pages/stray.html');
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, 'orphan');
    await node.ctx.siteFiles.put('pages/trigger.html', 'x', null);
    assert.ok(!fs.existsSync(stray), 'the orphan is moved out of the way');
    assert.equal(fs.readFileSync(`${stray}.local`, 'utf8'), 'orphan');
    await node.ctx.siteFiles.remove('pages/trigger.html', null);
  });
});

describe('folders: push, pull and the starter site', () => {
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cms-folder-'));

  test('push saves valid files, reports invalid ones by name, and can prune', async () => {
    const dir = tmpDir();
    const put = (rel, c) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), c);
    };
    put('pages/a.html', '<p>a</p>');
    put('components/b.html', '<p>b</p>');
    put('pages/bad.html', '{% if never_closed %}');
    put('pages/notes.txt', 'ignored: not html');
    put('other/ignored.html', 'ignored: not in pages/ or components/');
    const r = await node.ctx.siteFiles.importFrom(dir, null);
    assert.equal(r.written, 2);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].message, /pages\/bad\.html/);
    assert.deepEqual(
      node.ctx.siteFiles.list().map((f) => f.path),
      ['components/b.html', 'pages/a.html'],
    );

    // running it again is a no-op
    assert.equal((await node.ctx.siteFiles.importFrom(dir, null)).written, 0);

    // --prune: the folder is the truth
    fs.rmSync(path.join(dir, 'pages/a.html'));
    assert.equal((await node.ctx.siteFiles.importFrom(dir, null)).removed, 0);
    assert.equal((await node.ctx.siteFiles.importFrom(dir, null, { prune: true })).removed, 1);
    assert.deepEqual(
      node.ctx.siteFiles.list().map((f) => f.path),
      ['components/b.html'],
    );

    // pull writes it all back out
    const out = tmpDir();
    assert.equal((await node.ctx.siteFiles.exportTo(out)).files, 1);
    assert.equal(fs.readFileSync(path.join(out, 'components/b.html'), 'utf8'), '<p>b</p>');
    await node.ctx.siteFiles.remove('components/b.html', null);
  });

  test('a site with no pages gets the starter site when it starts, and never again', async () => {
    const dir = path.join(ROOT, 'site', 'defaults');
    const n = await makeNode();
    try {
      // seeded by start-up: every address is a page, so an empty tree would show nothing at all
      const paths = n.ctx.siteFiles.list().map((f) => f.path);
      for (const p of [
        'pages/index.html',
        'pages/blog/index.html',
        'pages/blog/[slug].html',
        'pages/[...path].html',
        'pages/404.html',
        'components/post-list.html',
        'components/entry.html',
      ])
        assert.ok(paths.includes(p), `${p} is part of the starter site`);
      // once a site has files nothing is seeded over them: a page the owner deleted stays deleted
      await n.ctx.siteFiles.remove('pages/contact.html', null);
      assert.equal((await n.ctx.siteFiles.seedDefaults(dir, null)).skipped, true);
      assert.throws(
        () => n.ctx.siteFiles.get('pages/contact.html'),
        (e) => e.status === 404,
      );
      assert.equal((await n.ctx.siteFiles.seedDefaults(dir, null, { force: true })).written, 1);
    } finally {
      await n.close();
    }
  });

  test('a site emptied on purpose shows the built-in not-found page, framed by the theme', async () => {
    assert.deepEqual(node.ctx.siteFiles.list(), []); // the shared node was emptied in before()
    assert.equal(node.ctx.sitePages.match('/'), null);
    assert.equal(node.ctx.sitePages.has404(), false);
    const res = await request(node.app).get('/');
    assert.equal(res.status, 404);
    assert.match(res.text, /Page not found/);
    assert.match(res.text, /class="brand"/, 'the theme layout still frames it');
  });
});

describe('a cluster', () => {
  test('a save on one server reaches the others over the bus, including their public/ folders', async () => {
    const db = tmpDb();
    const wire = sharedBus();
    const a = await startNode({ dbUrl: db.url, bus: busFor(wire), seed: true });
    const b = await startNode({ dbUrl: db.url, bus: busFor(wire) });
    try {
      await a.ctx.siteFiles.put('pages/shared.html', 'from A', null);
      await until(() => b.ctx.siteFiles.snapshot().files.has('pages/shared.html'), {
        timeout: 2000,
      });
      assert.equal(b.ctx.siteFiles.version, a.ctx.siteFiles.version);
      await until(() => fs.existsSync(mirrored(b, 'pages/shared.html')), { timeout: 2000 });
      assert.notEqual(a.env.SITE_DIR, b.env.SITE_DIR, 'each server has its own folder');
      assert.deepEqual(b.ctx.sitePages.match('/shared'), { file: 'pages/shared.html', params: {} });

      await a.ctx.siteFiles.remove('pages/shared.html', null);
      await until(() => !b.ctx.siteFiles.snapshot().files.has('pages/shared.html'), {
        timeout: 2000,
      });
      await until(() => !fs.existsSync(mirrored(b, 'pages/shared.html')), { timeout: 2000 });
    } finally {
      await a.close();
      await b.close();
      db.cleanup();
    }
  });

  test('a server that misses every message heals by polling the version', async () => {
    const db = tmpDb();
    const a = await startNode({ dbUrl: db.url, bus: busFor(sharedBus()), seed: true });
    // its own bus: it never hears from A
    const b = await startNode({
      dbUrl: db.url,
      bus: busFor(sharedBus()),
      env: { CONFIG_POLL_SECONDS: '1' },
    });
    try {
      await a.ctx.siteFiles.put('pages/late.html', 'x', null);
      assert.equal(b.ctx.siteFiles.snapshot().files.has('pages/late.html'), false);
      await until(() => b.ctx.siteFiles.snapshot().files.has('pages/late.html'), { timeout: 4000 });
    } finally {
      await a.close();
      await b.close();
      db.cleanup();
    }
  });
});
