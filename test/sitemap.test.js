import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sharp from 'sharp';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
const get = (p) => request(node.app).get(p);
const locs = (xml) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
const paths = (xml) => locs(xml).map((u) => new URL(u).pathname);
const setSitemap = (values) => node.ctx.settings.update('sitemap', { values }, null);
const publish = (type, title, data = {}) =>
  node.ctx.content.create(
    type,
    {
      title,
      status: 'published',
      data: { body: { blocks: [{ type: 'paragraph', data: { text: 'x' } }] }, ...data },
    },
    null,
  );

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  await node.ctx.settings.update('general', { values: { site_url: 'https://acme.example' } }, null);
  await publish('post', 'First post');
  await publish('post', 'Second post');
  await publish('page', 'About us');
});
after(() => node.close());

describe('the generated sitemap', () => {
  test('by default it lists fixed pages and published content at their addresses', async () => {
    const xml = (await get('/sitemap.xml')).text;
    assert.match(xml, /^<\?xml/);
    const p = paths(xml);
    assert.ok(p.includes('/'), 'home');
    assert.ok(p.includes('/blog/first-post') && p.includes('/blog/second-post'));
    assert.ok(p.includes('/about-us'));
    assert.ok(locs(xml).every((u) => u.startsWith('https://acme.example/')));
  });

  test('rules leave addresses out or set hints; the first match wins', async () => {
    await setSitemap({
      rules: [
        { pattern: '/blog/second-post', exclude: true },
        { pattern: '/blog/**', changefreq: 'daily', priority: 0.8 },
      ],
      default_changefreq: 'monthly',
      default_priority: '0.3',
    });
    const xml = (await get('/sitemap.xml')).text;
    assert.ok(!paths(xml).includes('/blog/second-post'));
    assert.match(
      xml,
      /<loc>https:\/\/acme\.example\/blog\/first-post<\/loc><lastmod>[^<]+<\/lastmod><changefreq>daily<\/changefreq><priority>0\.8<\/priority>/,
    );
    assert.match(
      xml,
      /<loc>https:\/\/acme\.example\/about-us<\/loc><lastmod>[^<]+<\/lastmod><changefreq>monthly<\/changefreq><priority>0\.3<\/priority>/,
      'defaults for everything else',
    );
    await setSitemap({ rules: [], default_changefreq: '', default_priority: '' });
  });

  test('content types can be left out; extra addresses are added; sources can be switched off', async () => {
    await setSitemap({ exclude_types: ['post'], extra_urls: ['/landing/spring'] });
    let p = paths((await get('/sitemap.xml')).text);
    assert.ok(!p.some((x) => x.startsWith('/blog/')), 'no posts');
    assert.ok(p.includes('/about-us') && p.includes('/landing/spring'));

    await setSitemap({ exclude_types: [], extra_urls: [], include_entries: false });
    p = paths((await get('/sitemap.xml')).text);
    assert.ok(!p.includes('/about-us') && !p.includes('/blog/first-post'));
    await setSitemap({ include_entries: true });
  });

  test('invalid rules and extra addresses are refused with a message', async () => {
    for (const values of [
      { rules: [{ pattern: 'no-slash' }] },
      { rules: [{ pattern: '/x', changefreq: 'sometimes' }] },
      { rules: [{ pattern: '/x', priority: 2 }] },
      { rules: [{ pattern: '/x', weird: 1 }] },
      { extra_urls: ['https://elsewhere.example/'] },
    ]) {
      const r = await admin.put('/api/admin/sitemap').send({ values });
      assert.equal(r.status, 422, JSON.stringify(values));
      assert.ok(r.body.error.message.length > 10);
    }
  });

  test('past the per-file limit, /sitemap.xml becomes an index of parts', async () => {
    for (let i = 0; i < 100; i++) await publish('post', `Bulk ${i}`);
    await setSitemap({ per_file: 100 });
    const index = (await get('/sitemap.xml')).text;
    assert.match(index, /<sitemapindex /);
    const parts = locs(index);
    assert.deepEqual(
      parts.map((u) => new URL(u).pathname),
      ['/sitemap-1.xml', '/sitemap-2.xml'],
    );
    const one = (await get('/sitemap-1.xml')).text;
    const two = (await get('/sitemap-2.xml')).text;
    assert.equal(locs(one).length, 100);
    assert.ok(locs(two).length > 0 && locs(two).length <= 100);
    assert.equal(new Set([...locs(one), ...locs(two)]).size, locs(one).length + locs(two).length);
    assert.equal((await get('/sitemap-3.xml')).status, 404);
    await setSitemap({ per_file: 10000 });
    assert.equal((await get('/sitemap-1.xml')).status, 404, 'one file again: no parts');
  });

  test('a featured image is listed with its entry', async () => {
    const buf = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#345' } })
      .jpeg()
      .toBuffer();
    const up = await admin
      .post('/api/admin/media?name=cover.jpg&alt=cover')
      .set('content-type', 'application/octet-stream')
      .send(buf);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    await publish('post', 'With a cover', { featured_image: up.body.item.id });
    const xml = (await get('/sitemap.xml')).text;
    assert.match(xml, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
    assert.match(
      xml,
      new RegExp(
        `<loc>https://acme\\.example/blog/with-a-cover</loc>.*<image:image><image:loc>https://acme\\.example/media/${up.body.item.id}/`,
      ),
    );
    await setSitemap({ include_images: false });
    assert.doesNotMatch((await get('/sitemap.xml')).text, /image:image/);
    await setSitemap({ include_images: true });
  });

  test('switched off, there is no sitemap', async () => {
    await admin.put('/api/admin/sitemap').send({ enabled: false, values: {} });
    assert.equal((await get('/sitemap.xml')).status, 404);
    await admin.put('/api/admin/sitemap').send({ enabled: true, values: {} });
    assert.equal((await get('/sitemap.xml')).status, 200);
  });
});

describe('System → Sitemap (admin API)', () => {
  test('summary, filter, rebuild and download', async () => {
    const r = await admin.get('/api/admin/sitemap');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.ok(r.body.summary.total > 100);
    assert.ok(r.body.summary.bySource['entry:post'] > 100);
    assert.equal(r.body.summary.publicUrl, 'https://acme.example/sitemap.xml');
    assert.ok(r.body.settings.fields.some((f) => f.key === 'rules'));

    const f = await admin.get('/api/admin/sitemap?q=first-post');
    assert.equal(f.body.summary.matching, 1);
    assert.equal(f.body.summary.urls[0].path, '/blog/first-post');

    const rb = await admin.post('/api/admin/sitemap/regenerate').send({});
    assert.equal(rb.status, 200);
    assert.ok(await node.ctx.db('audit_logs').where({ action: 'sitemap.regenerate' }).first());

    const dl = await admin.get('/api/admin/sitemap/download');
    assert.equal(dl.status, 200);
    assert.match(dl.headers['content-disposition'], /sitemap\.xml/);
    assert.match(dl.text, /<urlset/);
  });

  test('new content appears without waiting for the cache', async () => {
    await get('/sitemap.xml');
    await publish('post', 'Fresh one');
    assert.ok(paths((await get('/sitemap.xml')).text).includes('/blog/fresh-one'));
  });

  test('permissions: sitemap.read may look, only sitemap.manage may change or rebuild', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'sm-reader', description: '', permissions: ['admin.access', 'sitemap.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'sm@example.com',
        name: 'sm',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const reader = await signedIn(node.app, {
      email: 'sm@example.com',
      password: 'Some-long-pass-12',
    });
    assert.equal((await reader.get('/api/admin/sitemap')).status, 200);
    assert.equal((await reader.put('/api/admin/sitemap').send({ values: {} })).status, 403);
    assert.equal((await reader.post('/api/admin/sitemap/regenerate').send({})).status, 403);
  });
});
