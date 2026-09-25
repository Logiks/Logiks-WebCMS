import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { makeNode, signedIn } from './helpers.js';

const DEFAULTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'site',
  'defaults',
);

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const zipOf = (files) => {
  const z = new AdmZip();
  for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.from(c));
  return z.toBuffer();
};

/** GET a route that answers with a zip body, as a Buffer. */
const download = (agent, url) =>
  agent
    .get(url)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

describe('Pages and Components: export / import as a .zip', () => {
  for (const kind of ['pages', 'components']) {
    test(`${kind}: export downloads a zip of the tree; import saves it back, validated`, async () => {
      const before1 = await download(admin, `/api/admin/site/${kind}/export`);
      assert.equal(before1.status, 200);
      assert.equal(before1.headers['content-type'], 'application/zip');
      const zip = new AdmZip(before1.body);
      const originalCount = zip.getEntries().length;
      assert.ok(originalCount > 0, `the starter site ships some ${kind}`);
      assert.ok(zip.getEntries().every((e) => e.entryName.startsWith(`${kind}/`)));

      const ext = kind === 'pages' ? '.html' : '.html';
      const goodPath = `${kind}/imported-${kind}${ext}`;
      const content = kind === 'pages' ? '<p>Imported page</p>' : '<p>Imported component</p>';
      const uploadZip = zipOf({
        [goodPath]: content,
        [`${kind}/broken${ext}`]: '{% if %}', // invalid Liquid — reported, not fatal to the rest
        'unrelated/ignored.txt': 'not part of the site tree at all',
      });
      const imp = await admin
        .post(`/api/admin/site/${kind}/import`)
        .set('content-type', 'application/octet-stream')
        .send(uploadZip);
      assert.equal(imp.status, 200, JSON.stringify(imp.body));
      assert.equal(imp.body.written, 1);
      assert.equal(imp.body.errors.length, 1);
      assert.match(imp.body.errors[0].path, /broken/);
      assert.ok(node.ctx.siteFiles.list().some((f) => f.path === goodPath));

      // export again: the imported file is now included, nothing outside the prefix leaked in
      const after1 = await download(admin, `/api/admin/site/${kind}/export`);
      const zip2 = new AdmZip(after1.body);
      assert.ok(zip2.getEntries().some((e) => e.entryName === goodPath));
      assert.equal(zip2.getEntries().length, originalCount + 1);

      await node.ctx.siteFiles.remove(goodPath, null);
    });

    test(`${kind}: import with prune=true removes what the zip doesn't have`, async () => {
      const only = `${kind}/prune-only-this.html`;
      const uploadZip = zipOf({ [only]: '<p>Only this one</p>' });
      const before1 = node.ctx.siteFiles.list().filter((f) => f.kind === kind.slice(0, -1)).length;
      assert.ok(before1 > 1, 'there is more than one to prune away');
      const r = await admin
        .post(`/api/admin/site/${kind}/import?prune=true`)
        .set('content-type', 'application/octet-stream')
        .send(uploadZip);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const remaining = node.ctx.siteFiles.list().filter((f) => f.kind === kind.slice(0, -1));
      assert.deepEqual(
        remaining.map((f) => f.path),
        [only],
      );

      // restore the starter site for the tests that follow
      await node.ctx.siteFiles.remove(only, null);
      await node.ctx.siteFiles.seedDefaults(DEFAULTS, null, { force: true });
    });

    test(`${kind}: import needs ${kind}.write, export needs ${kind}.read`, async () => {
      const role = await node.ctx.users.createRole(
        { name: `no-${kind}`, description: '', permissions: ['admin.access'] },
        null,
      );
      await node.ctx.users.createUser(
        {
          email: `no-${kind}@example.com`,
          name: 'x',
          password: 'Some-long-pass-12',
          roleId: Number(role.id),
        },
        null,
      );
      const bare = await signedIn(node.app, {
        email: `no-${kind}@example.com`,
        password: 'Some-long-pass-12',
      });
      assert.equal((await bare.get(`/api/admin/site/${kind}/export`)).status, 403);
      assert.equal(
        (
          await bare
            .post(`/api/admin/site/${kind}/import`)
            .set('content-type', 'application/octet-stream')
            .send(zipOf({}))
        ).status,
        403,
      );
    });
  }
});

describe('Services: export / import as a .zip', () => {
  test('export is one <slug>.json per Service; import upserts by slug through the normal create/update path', async () => {
    await admin.post('/api/admin/services').send({
      slug: 'export-me',
      name: 'Export me',
      mode: 'query',
      enabled: true,
      config: { source: 'type', type: 'post', sort: 'newest', perPage: { default: 5, max: 10 } },
    });
    const dl = await download(admin, '/api/admin/services/export');
    assert.equal(dl.status, 200);
    const zip = new AdmZip(dl.body);
    const entry = zip.getEntries().find((e) => e.entryName === 'export-me.json');
    assert.ok(entry);
    const defn = JSON.parse(entry.getData().toString('utf8'));
    assert.equal(defn.config.type, 'post');

    // edit it in the exported JSON and import it back: an UPDATE, not a duplicate
    defn.name = 'Renamed on import';
    const upload = zipOf({ 'export-me.json': JSON.stringify(defn) });
    const imp = await admin
      .post('/api/admin/services/import')
      .set('content-type', 'application/octet-stream')
      .send(upload);
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(imp.body.updated, 1);
    assert.equal(imp.body.created, 0);
    assert.equal((await node.ctx.services.get('export-me')).name, 'Renamed on import');

    // a brand new slug in the zip is a create
    const upload2 = zipOf({ 'brand-new.json': JSON.stringify({ ...defn, slug: 'brand-new' }) });
    const imp2 = await admin
      .post('/api/admin/services/import')
      .set('content-type', 'application/octet-stream')
      .send(upload2);
    assert.equal(imp2.body.created, 1);
    await admin.delete('/api/admin/services/export-me');
    await admin.delete('/api/admin/services/brand-new');
  });

  test('importing a sql/script definition still needs the importing actor to hold services.sql/services.script', async () => {
    const upload = zipOf({
      'sneaky.json': JSON.stringify({
        slug: 'sneaky',
        name: 'Sneaky',
        mode: 'sql',
        config: { sql: 'select 1 as x', params: [] },
      }),
    });
    const writer = await (async () => {
      const role = await node.ctx.users.createRole(
        {
          name: 'services-writer-import',
          description: '',
          permissions: ['admin.access', 'services.write'],
        },
        null,
      );
      await node.ctx.users.createUser(
        {
          email: 'writer-import@example.com',
          name: 'x',
          password: 'Some-long-pass-12',
          roleId: Number(role.id),
        },
        null,
      );
      return signedIn(node.app, {
        email: 'writer-import@example.com',
        password: 'Some-long-pass-12',
      });
    })();
    const r = await writer
      .post('/api/admin/services/import')
      .set('content-type', 'application/octet-stream')
      .send(upload);
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 0);
    assert.match(r.body.errors[0].message, /services\.sql/);
  });
});

describe('Translations: export / import as a .zip', () => {
  test('export gives full-context files (edited over shipped over theme); import stores overrides only', async () => {
    await node.ctx.siteFiles.put(
      'locales/en.json',
      JSON.stringify({ blog: { title: 'My Blog' } }),
      null,
    );

    const dl = await download(admin, '/api/admin/site/locales/export');
    assert.equal(dl.status, 200);
    const zip = new AdmZip(dl.body);
    const en = zip.getEntries().find((e) => e.entryName === 'en.json');
    assert.ok(en);
    const parsed = JSON.parse(en.getData().toString('utf8'));
    assert.equal(parsed.blog.title, 'My Blog', "the editor's override shows in the export");
    assert.ok(parsed.pagination?.older, 'shipped wording fills in what was never overridden');

    // edit it and import it back — only the ONE key changed is what gets stored as an override
    parsed.blog.title = 'Renamed Blog';
    const upload = zipOf({ 'en.json': JSON.stringify(parsed) });
    const imp = await admin
      .post('/api/admin/site/locales/import')
      .set('content-type', 'application/octet-stream')
      .send(upload);
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.deepEqual(imp.body.saved, ['en']);
    assert.equal(
      JSON.parse(node.ctx.siteFiles.get('locales/en.json').content).blog.title,
      'Renamed Blog',
    );

    await node.ctx.siteFiles.remove('locales/en.json', null);
  });

  test('a file that is not a plain "<code>.json" in the zip is ignored, not an error', async () => {
    const upload = zipOf({
      'readme.txt': 'not a language file',
      'de.json': JSON.stringify({ a: 'b' }),
    });
    const r = await admin
      .post('/api/admin/site/locales/import')
      .set('content-type', 'application/octet-stream')
      .send(upload);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.saved, ['de']);
    await node.ctx.siteFiles.remove('locales/de.json', null);
  });

  test('import needs locales.write, export needs locales.read', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'no-locales', description: '', permissions: ['admin.access'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'no-locales@example.com',
        name: 'x',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const bare = await signedIn(node.app, {
      email: 'no-locales@example.com',
      password: 'Some-long-pass-12',
    });
    assert.equal((await bare.get('/api/admin/site/locales/export')).status, 403);
    assert.equal(
      (
        await bare
          .post('/api/admin/site/locales/import')
          .set('content-type', 'application/octet-stream')
          .send(zipOf({}))
      ).status,
      403,
    );
  });
});
