import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { JSDOM } from 'jsdom';
import { makeNode, signedIn, tmpDb, sharedBus, busFor, until, sleep } from './helpers.js';

let node, admin, media;
const doc = (res) => new JSDOM(res.text).window.document;
const body = (...t) => ({ blocks: t.map((text) => ({ type: 'paragraph', data: { text } })) });
const mk = (type, title, data = {}, extra = {}) =>
  node.ctx.content.create(
    type,
    { title, status: 'published', data: { body: body(`About ${title}`), ...data }, ...extra },
    null,
  );
const api = (p, o = {}) => {
  let r = request(node.app).get(`/api/public${p}`);
  if (o.origin) r = r.set('Origin', o.origin);
  return r;
};

before(async () => {
  media = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-p2-'));
  node = await makeNode({ env: { MEDIA_DIR: media } });
  admin = await signedIn(node.app);
});
after(async () => {
  await node.close();
  fs.rmSync(media, { recursive: true, force: true });
});

// ───────────────────────────── public content API ─────────────────────────────

test('the public API is off until the feature is switched on', async () => {
  for (const p of [
    '/content',
    '/content/post',
    '/content/page/about',
    '/menus/main',
    '/search?q=x',
    '/terms/category',
  ]) {
    const r = await api(p);
    assert.equal(r.status, 404, p);
    assert.match(r.body.error.message, /turned off/);
  }
  await node.ctx.settings.update('features', { values: { public_api: true } });
  assert.equal((await api('/content')).status, 200);
});

test('lists are paginated, filterable by category, sorted newest first, and only ever show published content', async () => {
  const cat = await node.ctx.content.createTerm('category', { name: 'News' }, null);
  const other = await node.ctx.content.createTerm('category', { name: 'Unused' }, null);
  for (let i = 1; i <= 7; i++) {
    await mk('post', `Story ${i}`, { excerpt: `Excerpt ${i}` }, { termIds: i % 2 ? [cat.id] : [] });
    await sleep(3);
  }
  await node.ctx.content.create('post', { title: 'Draft story', data: {} }, null);
  await node.ctx.content.create(
    'post',
    { title: 'Later story', status: 'scheduled', publishAt: Date.now() + 3600_000, data: {} },
    null,
  );

  const types = (await api('/content')).body.types;
  assert.deepEqual(
    types.map((t) => t.id),
    ['page', 'post'],
  );

  const p1 = (await api('/content/post?per_page=3')).body;
  assert.deepEqual(
    p1.items.map((i) => i.title),
    ['Story 7', 'Story 6', 'Story 5'],
  );
  assert.equal(p1.total, 7);
  assert.equal(p1.pages, 3);
  const p3 = (await api('/content/post?per_page=3&page=3')).body;
  assert.deepEqual(
    p3.items.map((i) => i.title),
    ['Story 1'],
  );
  assert.equal((await api('/content/post?per_page=1000')).body.perPage, 50, 'page size is capped');
  assert.equal((await api('/content/post?per_page=abc&page=-4')).body.page, 1);

  const inCat = (await api('/content/post?category=news')).body;
  assert.deepEqual(
    inCat.items.map((i) => i.title),
    ['Story 7', 'Story 5', 'Story 3', 'Story 1'],
  );
  assert.equal(inCat.items[0].terms[0].slug, 'news');
  assert.equal((await api('/content/post?category=' + other.slug)).body.total, 0);
  assert.equal((await api('/content/post?category=ghost')).status, 404);
  assert.equal((await api('/content/nothing')).status, 404);

  const all = (await api('/content/post?per_page=50')).body.items.map((i) => i.title);
  assert.ok(!all.includes('Draft story') && !all.includes('Later story'));
  const item = p1.items[0];
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      'author',
      'excerpt',
      'featuredImage',
      'fields',
      'id',
      'locale',
      'path',
      'publishedAt',
      'slug',
      'terms',
      'title',
      'type',
      'updatedAt',
      'url',
    ].sort(),
  );
  assert.equal(item.url, '/blog/story-7');
  assert.equal(item.excerpt, 'Excerpt 7');
});

test('a single entry comes with its rich content as HTML and as blocks, and images resolve', async () => {
  const buf = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#39c' } })
    .jpeg()
    .toBuffer();
  const m = (
    await admin
      .post('/api/admin/media?name=pic.jpg&alt=Blue')
      .set('content-type', 'application/octet-stream')
      .send(buf)
  ).body.item;
  await mk('page', 'Docs home', {
    featured_image: m.id,
    body: {
      blocks: [
        { type: 'header', data: { text: 'Welcome', level: 2 } },
        { type: 'paragraph', data: { text: 'Some <b>bold</b> <script>x</script>' } },
        { type: 'image', data: { mediaId: m.id } },
      ],
    },
  });
  const parent = (await node.ctx.db('entries').where({ path: 'docs-home' }).first()).id;
  await mk('page', 'Install guide', {}, { parentId: Number(parent) });

  const r = (await api('/content/page/docs-home')).body.item;
  assert.equal(r.title, 'Docs home');
  assert.equal(r.fields.body.html.includes('<h2>Welcome</h2>'), true);
  assert.match(r.fields.body.html, /<b>bold<\/b>/);
  assert.doesNotMatch(r.fields.body.html, /<script/);
  assert.deepEqual(
    r.fields.body.blocks.map((b) => b.type),
    ['header', 'paragraph', 'image'],
  );
  assert.equal(r.featuredImage.id, m.id);
  assert.equal(r.featuredImage.width, 900);
  assert.match(r.featuredImage.srcset, /640w/);
  assert.equal((await request(node.app).get(r.featuredImage.src)).status, 200);

  const nested = (await api('/content/page/docs-home/install-guide')).body.item;
  assert.equal(nested.path, 'docs-home/install-guide');
  for (const bad of [
    '/content/page/nope',
    '/content/page/..%2fetc',
    '/content/page/UPPER',
    '/content/post/docs-home',
  ])
    assert.equal((await api(bad)).status, 404, bad);
});

test('CORS follows the origins listed in settings, the API sets no cookies, and only reads are allowed', async () => {
  assert.equal(
    (await api('/content', { origin: 'https://app.example' })).headers[
      'access-control-allow-origin'
    ],
    undefined,
    'not listed yet',
  );
  await node.ctx.settings.update('security', { values: { cors_origins: ['https://app.example'] } });
  const ok = await api('/content', { origin: 'https://app.example' });
  assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example');
  assert.equal(ok.headers['set-cookie'], undefined);
  assert.equal(
    (await api('/content', { origin: 'https://evil.example' })).headers[
      'access-control-allow-origin'
    ],
    undefined,
  );
  const pre = await request(node.app)
    .options('/api/public/content')
    .set('Origin', 'https://app.example')
    .set('Access-Control-Request-Method', 'DELETE');
  assert.match(pre.headers['access-control-allow-methods'], /^GET,HEAD,OPTIONS$/);
  const agent = await signedIn(node.app);
  assert.equal(
    (await agent.post('/api/public/content/post').send({})).status >= 400,
    true,
    'nothing can be written through the public API',
  );
  assert.equal((await api('/content')).headers['x-powered-by'], undefined);
});

test('API responses are cached and refresh the moment content changes; ETags give 304s', async () => {
  const e = await mk('post', 'Live update', { excerpt: 'before' });
  const first = await api('/content/post?per_page=1');
  assert.equal(first.body.items[0].excerpt, 'before');
  assert.match(first.headers['cache-control'], /public, max-age=30, s-maxage=300/);
  assert.equal(
    (await api('/content/post?per_page=1').set('If-None-Match', first.headers.etag)).status,
    304,
  );
  await node.ctx.content.update(e.id, { data: { excerpt: 'after' } }, null);
  assert.equal((await api('/content/post?per_page=1')).body.items[0].excerpt, 'after');
  await node.ctx.settings.update('site', { values: { page_cache_seconds: 0 } });
  assert.equal((await api('/content/post')).headers['cache-control'], 'no-store');
  await node.ctx.settings.update('site', { reset: ['page_cache_seconds'] });
});

test('menus, terms and search are available too', async () => {
  const about = await node.ctx.db('entries').where({ path: 'docs-home' }).first();
  await admin.put('/api/admin/menus/main').send({
    items: [
      { label: 'Docs', entryId: Number(about.id) },
      { label: 'Home', url: '/' },
    ],
  });
  assert.deepEqual(
    (await api('/menus/main')).body.items.map((i) => [i.label, i.url]),
    [
      ['Docs', '/docs-home'],
      ['Home', '/'],
    ],
  );
  assert.equal((await api('/menus/ghost')).status, 404);
  const terms = (await api('/terms/category')).body.terms;
  assert.deepEqual(
    terms.map((t) => t.slug),
    ['news'],
    'only categories in use',
  );
  const s = (await api('/search?q=install')).body;
  assert.equal(s.results[0].title, 'Install guide');
  assert.equal(s.results[0].url, '/docs-home/install-guide');
  assert.equal((await api('/search?q=')).body.total, 0);
});

// ───────────────────────────── languages ─────────────────────────────

test('languages: off by default; when on, translations link to each other and are served under /<language>/', async () => {
  const en = await mk('page', 'About', {}, {});
  const asked = await node.ctx.content.create(
    'page',
    {
      title: 'Om oss',
      slug: 'om-oss',
      locale: 'sv',
      translationOf: en.id,
      status: 'published',
      data: { body: body('Svensk text') },
    },
    null,
  );
  assert.equal(
    asked.locale,
    'en',
    'while the feature is off everything is in the default language',
  );
  await node.ctx.content.remove(asked.id, null);

  await node.ctx.settings.update('features', { values: { multilingual: true } });
  await node.ctx.settings.update('content', { values: { locales: ['sv'] } });
  assert.equal(
    (await admin.post('/api/admin/content/types/page/entries').send({ title: 'X', locale: 'fr' }))
      .status,
    422,
  );

  const sv = (
    await admin.post('/api/admin/content/types/page/entries').send({
      title: 'Om oss',
      slug: 'about',
      locale: 'sv',
      translationOf: en.id,
      status: 'published',
      data: { body: body('Svensk text') },
    })
  ).body.entry;
  assert.equal(sv.locale, 'sv');
  assert.equal(sv.path, 'about', 'the same address in another language is fine');
  assert.equal(
    sv.translationGroup,
    (await admin.get(`/api/admin/content/entries/${en.id}`)).body.entry.translationGroup,
  );

  const enPage = await request(node.app).get('/about');
  assert.match(enPage.text, /About About/);
  assert.equal(doc(enPage).querySelector('html').lang, 'en');
  const svPage = await request(node.app).get('/sv/about');
  assert.equal(svPage.status, 200);
  assert.match(svPage.text, /Svensk text/);
  assert.equal(doc(svPage).querySelector('html').lang, 'sv');
  assert.equal(
    doc(svPage).querySelector('link[rel="canonical"]').href,
    'http://localhost:3000/sv/about',
  );
  const alts = (p) =>
    [...doc(p).querySelectorAll('link[rel="alternate"]')]
      .map((l) => [l.getAttribute('hreflang'), l.getAttribute('href')])
      .sort();
  assert.deepEqual(alts(enPage), [
    ['en', 'http://localhost:3000/about'],
    ['sv', 'http://localhost:3000/sv/about'],
  ]);
  assert.deepEqual(alts(svPage), alts(enPage), 'both languages announce each other');

  assert.equal((await request(node.app).get('/fr/about')).status, 404);
  assert.equal((await request(node.app).get('/sv/nothing')).status, 404);
  assert.match(
    (await request(node.app).get('/sitemap.xml')).text,
    /http:\/\/localhost:3000\/sv\/about/,
  );

  assert.equal((await api('/content/page/about?locale=sv')).body.item.locale, 'sv');
  assert.equal((await api('/content/page/about')).body.item.locale, 'en');
  assert.equal((await api('/content/page?locale=fr')).status, 422);
  assert.equal((await api('/search?q=Svensk&locale=sv')).body.total, 1);
  assert.equal(
    (await api('/search?q=Svensk&locale=en')).body.total,
    0,
    'search stays inside a language',
  );
  const dup = await admin
    .post('/api/admin/content/types/page/entries')
    .send({ title: 'Om oss 2', slug: 'about', locale: 'sv' });
  assert.equal(dup.status, 409, 'but not twice within one language');

  await node.ctx.settings.update('features', { reset: ['multilingual'] });
  await node.ctx.settings.update('content', { reset: ['locales'] });
});

// ───────────────────────────── roles ─────────────────────────────

test('the Editor and Author presets do what their descriptions say', async () => {
  const roles = (await admin.get('/api/admin/roles')).body.roles.map((r) => r.name);
  assert.ok(roles.includes('Editor') && roles.includes('Author'));
  const mkUser = async (roleName, email) => {
    const role = await node.ctx.db('roles').where({ name: roleName }).first();
    await node.ctx.users.createUser(
      { email, name: roleName, password: 'Some-long-pass-12', roleId: Number(role.id) },
      null,
    );
    return signedIn(node.app, { email, password: 'Some-long-pass-12' });
  };
  const editor = await mkUser('Editor', 'ed@example.com');
  const author = await mkUser('Author', 'au@example.com');
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#000' } })
    .png()
    .toBuffer();

  const page = (
    await editor
      .post('/api/admin/content/types/page/entries')
      .send({ title: 'Editor page', status: 'published', data: {} })
  ).body.entry;
  assert.equal(page.status, 'published');
  assert.equal((await editor.put('/api/admin/menus/footer').send({ items: [] })).status, 200);
  assert.equal(
    (await editor.post('/api/admin/redirects').send({ from: '/e', to: '/x' })).status,
    201,
  );
  assert.equal(
    (
      await editor
        .post('/api/admin/media?name=a.png')
        .set('content-type', 'application/octet-stream')
        .send(png)
    ).status,
    201,
  );
  assert.equal(
    (await editor.get('/api/admin/settings')).status,
    403,
    'editors do not change settings',
  );
  assert.equal((await editor.get('/api/admin/users')).status, 403);
  assert.equal((await editor.post('/api/admin/themes/default/activate').send({})).status, 403);

  const draft = (
    await author
      .post('/api/admin/content/types/post/entries')
      .send({ title: 'Author draft', data: {} })
  ).body.entry;
  assert.equal(draft.status, 'draft');
  assert.equal(
    (await author.put(`/api/admin/content/entries/${draft.id}`).send({ status: 'published' }))
      .status,
    403,
  );
  assert.equal(
    (
      await author
        .post('/api/admin/media?name=b.png')
        .set('content-type', 'application/octet-stream')
        .send(png)
    ).status,
    201,
  );
  assert.equal((await author.put('/api/admin/menus/main').send({ items: [] })).status, 403);
  assert.equal((await author.delete(`/api/admin/content/entries/${page.id}`)).status, 403);
});

test('installs that already have roles get the presets from the migration, without touching roles they already have', async () => {
  const { up } = await import('../migrations/20260401000006_editor_roles.js');
  // people hold the presets from the previous test, so simulate an older install by renaming rather than deleting
  await node.ctx.db('roles').where({ name: 'Author' }).update({ name: 'Writers' });
  await node.ctx
    .db('roles')
    .where({ name: 'Editor' })
    .update({ description: 'my own', permissions: '["admin.access"]' });
  await up(node.ctx.db);
  const rows = await node.ctx.db('roles').whereIn('name', ['Editor', 'Author']);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((r) => r.name === 'Editor').description,
    'my own',
    'an existing role is left alone',
  );
  assert.ok(
    JSON.parse(rows.find((r) => r.name === 'Author').permissions).includes('content.post.write'),
    'the missing one is added',
  );
  await up(node.ctx.db);
  assert.equal(
    (await node.ctx.db('roles').whereIn('name', ['Editor', 'Author'])).length,
    2,
    'and running it twice adds nothing',
  );
});

// ───────────────────────────── the Phase 2 demo, scripted ─────────────────────────────

test('DEMO: a marketing site on a 3-node cluster: build it, edit it, switch its theme, schedule a post — every server agrees within seconds', async () => {
  const db = tmpDb();
  const emitter = sharedBus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-demo-'));
  const opts = { dbUrl: db.url, env: { MEDIA_DIR: dir } };
  const a = await makeNode({ ...opts, bus: busFor(emitter) });
  const b = await makeNode({ ...opts, bus: busFor(emitter) });
  const c = await makeNode({ ...opts, bus: busFor(emitter) });
  const nodes = [a, b, c];
  const all = (p) => Promise.all(nodes.map((n) => request(n.app).get(p)));
  try {
    const ed = await signedIn(a.app);
    await ed.put('/api/admin/settings/general').send({
      values: {
        site_name: 'Northwind',
        tagline: 'Fresh ideas',
        site_url: 'https://northwind.example',
      },
    });

    // 1. build the site as an editor would
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#2b59c3' },
    })
      .jpeg()
      .toBuffer();
    const img = (
      await ed
        .post('/api/admin/media?name=team.jpg&alt=The team')
        .set('content-type', 'application/octet-stream')
        .send(png)
    ).body.item;
    const mkPage = async (title, status, data, extra = {}) =>
      (
        await ed
          .post('/api/admin/content/types/page/entries')
          .send({ title, status, data: { body: body(`${title} text`), ...data }, ...extra })
      ).body.entry;
    const home = await mkPage('Home', 'published', { featured_image: img.id });
    const about = await mkPage('About', 'published', {});
    await mkPage('Team', 'published', {}, { parentId: about.id });
    const cat = (
      await ed.post('/api/admin/content/taxonomies/category/terms').send({ name: 'Company news' })
    ).body.term;
    await ed.post('/api/admin/content/types/post/entries').send({
      title: 'We are hiring',
      status: 'published',
      termIds: [cat.id],
      data: { excerpt: 'Join us', body: body('Open roles') },
    });
    await ed.put('/api/admin/menus/main').send({
      items: [
        { label: 'About', entryId: about.id },
        { label: 'Blog', url: '/blog' },
      ],
    });

    // 2. every server serves the same site
    const pages = await all('/');
    assert.deepEqual(
      pages.map((r) => r.status),
      [200, 200, 200],
    );
    assert.equal(new Set(pages.map((r) => r.text)).size, 1, 'the same HTML from all three servers');
    assert.match(pages[0].text, /Northwind/);
    assert.match(pages[0].text, new RegExp(`/media/${img.id}/640\\.webp 640w`));
    for (const r of await all('/blog/we-are-hiring')) assert.match(r.text, /Open roles/);
    for (const r of await all('/about/team')) assert.match(r.text, /crumbs/);
    for (const r of await all('/sitemap.xml'))
      assert.match(r.text, /northwind\.example\/blog\/we-are-hiring/);
    for (const r of await all('/search?q=hiring')) assert.match(r.text, /We are hiring/);
    await all('/about'); // warm every server's cache
    assert.deepEqual(
      (await all('/about')).map((r) => r.headers['x-cache']),
      ['HIT', 'HIT', 'HIT'],
    );

    // 3. a page edit on one server is visible everywhere within seconds
    const t0 = Date.now();
    await ed
      .put(`/api/admin/content/entries/${about.id}`)
      .send({ data: { body: body('Brand new about text') } });
    await until(
      async () => (await all('/about')).every((r) => /Brand new about text/.test(r.text)),
      { timeout: 4000, every: 25 },
    );
    assert.ok(Date.now() - t0 < 4000, `edit visible on all servers in ${Date.now() - t0} ms`);

    // 4. switch the theme live
    const theme = new AdmZip();
    for (const [n, cnt] of Object.entries({
      'theme.json': JSON.stringify({ id: 'bold', name: 'Bold', version: '1.0.0' }),
      'layouts/default.html':
        '<!doctype html><html lang="{{ site.locale }}"><head>{{ seo.head }}{{ content_for_header }}</head><body class="bold-theme"><header>{{ site.name }}</header>{{ content_for_layout }}</body></html>',
    }))
      theme.addFile(n, Buffer.from(cnt));
    assert.equal(
      (
        await ed
          .post('/api/admin/themes')
          .set('content-type', 'application/zip')
          .send(theme.toBuffer())
      ).status,
      201,
    );
    await until(() => nodes.every((n) => n.ctx.themes.has('bold')), { timeout: 4000 });
    assert.equal((await ed.post('/api/admin/themes/bold/activate').send({})).status, 200);
    await until(async () => (await all('/about')).every((r) => /bold-theme/.test(r.text)), {
      timeout: 4000,
      every: 25,
    });
    for (const r of await all('/about'))
      assert.match(
        r.text,
        /<h1>About<\/h1>[\s\S]*<p>Brand new about text<\/p>/,
        'the same page content in the new theme',
      );
    await ed.post('/api/admin/themes/default/activate').send({});
    await until(async () => (await all('/about')).every((r) => !/bold-theme/.test(r.text)), {
      timeout: 4000,
      every: 25,
    });

    // 5. schedule a post; the scheduler on any single server publishes it for everyone
    const later = (
      await ed.post('/api/admin/content/types/post/entries').send({
        title: 'Big announcement',
        status: 'scheduled',
        publishAt: Date.now() + 300,
        data: { body: body('zeppelin news') },
      })
    ).body.entry;
    assert.deepEqual(
      (await all('/blog/big-announcement')).map((r) => r.status),
      [404, 404, 404],
    );
    await sleep(350);
    assert.equal(await c.ctx.content.publishDue(), 1);
    await until(async () => (await all('/blog/big-announcement')).every((r) => r.status === 200), {
      timeout: 4000,
      every: 25,
    });
    for (const r of await all('/search?q=zeppelin')) assert.match(r.text, /Big announcement/);
    for (const r of await all('/blog')) assert.match(r.text, /Big announcement/);
    assert.equal(
      (await ed.get(`/api/admin/content/entries/${later.id}`)).body.entry.status,
      'published',
    );

    // 6. a redirect made on one server works on all
    await ed.post('/api/admin/redirects').send({ from: '/jobs', to: '/blog/we-are-hiring' });
    await until(
      async () =>
        (await Promise.all(nodes.map((n) => request(n.app).get('/jobs')))).every(
          (r) => r.status === 301 && r.headers.location === '/blog/we-are-hiring',
        ),
      { timeout: 4000, every: 25 },
    );

    // 7. everything the editor did is in the audit log
    const actions = new Set((await a.ctx.audit.list({ limit: 200 })).map((x) => x.action));
    for (const x of [
      'content.create',
      'content.update',
      'content.publish',
      'theme.install',
      'theme.activate',
      'media.upload',
      'menu.create',
      'redirect.create',
    ])
      assert.ok(actions.has(x), x);
    assert.equal(home.slug, 'home');
  } finally {
    await Promise.all(nodes.map((n) => n.close()));
    db.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
