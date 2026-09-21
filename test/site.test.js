import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { JSDOM } from 'jsdom';
import {
  makeNode,
  signedIn,
  startSmtp,
  configureMail,
  tmpDb,
  sharedBus,
  busFor,
  until,
  sleep,
} from './helpers.js';

let node, admin, media, smtp;
const get = (p, agent = request(node.app)) => agent.get(p);
const doc = (res) => new JSDOM(res.text).window.document;
const body = (...t) => ({ blocks: t.map((text) => ({ type: 'paragraph', data: { text } })) });
const publish = (type, title, data = {}, extra = {}) =>
  node.ctx.content.create(
    type,
    { title, status: 'published', data: { body: body(`Text of ${title}`), ...data }, ...extra },
    null,
  );

before(async () => {
  media = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-site-'));
  smtp = await startSmtp();
  node = await makeNode({ env: { MEDIA_DIR: media } });
  admin = await signedIn(node.app);
  await node.ctx.settings.update('general', {
    values: {
      site_name: 'Acme Co',
      tagline: 'We make things',
      site_url: 'https://acme.example',
      admin_email: 'owner@acme.example',
    },
  });
  await node.ctx.settings.update('security', { values: { contact_rate_limit_per_hour: 1000 } });
});
after(async () => {
  await node.close();
  await smtp.close();
  fs.rmSync(media, { recursive: true, force: true });
});

test('the default theme renders every content type: home, page, nested page, post, blog, category, custom type, 404', async () => {
  const cat = await node.ctx.content.createTerm('category', { name: 'News' }, null);
  const about = await publish('page', 'About us', { seo_description: 'All about us' });
  await publish('page', 'Team', {}, { parentId: about.id });
  for (let i = 1; i <= 3; i++)
    await publish('post', `Post ${i}`, { excerpt: `Summary ${i}` }, { termIds: [cat.id] });
  node.ctx.content.registry.defineType('event', {
    label: 'Event',
    fields: {
      body: { type: 'blocks', label: 'Details' },
      venue: { type: 'string', label: 'Venue' },
    },
  });
  await node.ctx.content.create(
    'event',
    {
      title: 'Launch party',
      status: 'published',
      data: { body: body('Come along'), venue: 'The Hall' },
    },
    null,
  );

  // no home page yet: the starter home page shows a welcome banner and the latest posts
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /text\/html/);
  assert.equal(doc(home).querySelector('h1').textContent, 'Acme Co');
  assert.equal(doc(home).querySelectorAll('main article').length, 3);
  assert.match(home.text, /Summary 1/);

  const page = await get('/about-us');
  assert.equal(page.status, 200);
  assert.equal(doc(page).querySelector('h1').textContent, 'About us');
  assert.match(page.text, /Text of About us/);
  assert.match(doc(page).querySelector('title').textContent, /^About us \| Acme Co$/);
  assert.equal(doc(page).querySelector('meta[name="description"]').content, 'All about us');
  assert.equal(
    doc(page).querySelector('link[rel="stylesheet"]').href.startsWith('/theme/default/'),
    true,
  );
  assert.equal(doc(page).querySelector('html').lang, 'en');

  const child = await get('/about-us/team');
  assert.equal(child.status, 200);
  assert.deepEqual(
    [...doc(child).querySelectorAll('.crumbs a, .crumbs span')].map((x) => x.textContent),
    ['About us', 'Team'],
  );
  assert.match(
    (await get('/about-us')).text,
    /href="\/about-us\/team"/,
    'a parent lists its children',
  );

  const post = await get('/blog/post-1');
  assert.equal(post.status, 200);
  assert.equal(doc(post).querySelector('h1').textContent, 'Post 1');
  assert.match(post.text, /href="\/category\/news"/);
  assert.match(post.text, /<time datetime="\d{4}-/);

  const blog = await get('/blog');
  assert.equal(doc(blog).querySelectorAll('main article').length, 3);
  assert.equal(doc(await get('/category/news')).querySelector('h1').textContent, 'News');
  assert.equal((await get('/category/nope')).status, 404);

  const ev = await get('/event/launch-party');
  assert.equal(ev.status, 200, 'a type declared in code gets its own address with no extra work');
  assert.match(ev.text, /Come along/);

  const nf = await get('/nothing-here');
  assert.equal(nf.status, 404);
  assert.equal(doc(nf).querySelector('h1').textContent, 'Page not found');
  assert.match(nf.text, /noindex/);
  for (const bad of [
    '/blog/nope',
    '/blog/page/99',
    '/blog/post-1/extra',
    '/../etc/passwd',
    '/a%00b',
    '/UPPER',
    '/x y',
  ])
    assert.equal((await get(bad)).status, 404, bad);
});

test('the home page is a page whose address is the "home page" setting; its own address redirects to /', async () => {
  await publish('page', 'Home', { seo_title: 'Welcome to Acme' });
  const home = await get('/');
  assert.equal(doc(home).querySelector('h1').textContent, 'Home');
  assert.equal(doc(home).querySelector('title').textContent, 'Welcome to Acme');
  assert.equal(doc(home).querySelector('link[rel="canonical"]').href, 'https://acme.example/');
  const dup = await get('/home');
  assert.equal(dup.status, 301);
  assert.equal(dup.headers.location, '/');
  assert.match(home.text, /"@type":"WebSite"/);
  await node.ctx.settings.update('site', { values: { home_page: 'about-us' } });
  try {
    assert.equal(
      doc(await get('/')).querySelector('h1').textContent,
      'About us',
      'changing the setting refreshed the cached home page',
    );
  } finally {
    await node.ctx.settings.update('site', { reset: ['home_page'] });
  }
});

test('everything a visitor or editor typed is escaped; block content keeps its safe formatting', async () => {
  const nasty = '<script>alert(1)</script> & "quotes"';
  await publish('page', nasty, {
    seo_description: '"><script>alert(2)</script>',
    body: {
      blocks: [
        { type: 'paragraph', data: { text: 'Fine <b>bold</b> <img src=x onerror=alert(3)>' } },
      ],
    },
  });
  const r = await get('/script-alert-1-script-quotes');
  assert.equal(r.status, 200);
  const d = doc(r);
  assert.equal(d.querySelectorAll('script:not([type="application/ld+json"])').length, 0);
  assert.equal(d.querySelector('h1').textContent, nasty);
  assert.equal(d.querySelector('title').textContent, `${nasty} | Acme Co`);
  assert.equal(d.querySelector('meta[name="description"]').content, '"><script>alert(2)</script>');
  assert.ok(d.querySelector('.body b'));
  assert.equal(d.querySelectorAll('img[onerror]').length, 0);
  // structured data cannot be broken out of
  const ld = [...d.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
    JSON.parse(s.textContent),
  );
  assert.ok(ld.some((o) => o['@type'] === 'WebPage' && o.name === nasty));
  assert.ok(!r.text.includes('</script><script>'));
});

test('SEO: canonical, Open Graph, article structured data, breadcrumbs, noindex per page', async () => {
  const post = await get('/blog/post-2');
  const d = doc(post);
  assert.equal(d.querySelector('link[rel="canonical"]').href, 'https://acme.example/blog/post-2');
  assert.equal(d.querySelector('meta[property="og:type"]').content, 'article');
  assert.equal(d.querySelector('meta[property="og:site_name"]').content, 'Acme Co');
  assert.equal(
    d.querySelector('meta[property="og:url"]').content,
    'https://acme.example/blog/post-2',
  );
  assert.equal(d.querySelector('meta[name="twitter:card"]').content, 'summary');
  const article = [...d.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => JSON.parse(s.textContent))
    .find((o) => o['@type'] === 'BlogPosting');
  assert.equal(article.headline, 'Post 2');
  assert.match(article.datePublished, /^\d{4}-\d\d-\d\dT/);
  const crumbs = [
    ...doc(await get('/about-us/team')).querySelectorAll('script[type="application/ld+json"]'),
  ]
    .map((s) => JSON.parse(s.textContent))
    .find((o) => o['@type'] === 'BreadcrumbList');
  assert.deepEqual(
    crumbs.itemListElement.map((i) => i.name),
    ['About us', 'Team'],
  );
  assert.equal(crumbs.itemListElement[1].item, 'https://acme.example/about-us/team');

  await publish('page', 'Secret sauce', { noindex: true });
  assert.match(
    (await get('/secret-sauce')).text,
    /<meta name="robots" content="noindex, nofollow">/,
  );
  assert.doesNotMatch((await get('/about-us')).text, /name="robots"/);
});

test('images: block images and the featured image come out responsive, with alt text that follows edits', async () => {
  const buf = await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#c33' } })
    .jpeg()
    .toBuffer();
  const up = await admin
    .post('/api/admin/media?name=hero.jpg&alt=A red banner')
    .set('content-type', 'application/octet-stream')
    .send(buf);
  const m = up.body.item;
  await publish('post', 'Illustrated', {
    featured_image: m.id,
    body: {
      blocks: [
        { type: 'image', data: { mediaId: m.id, caption: 'Caption <b>here</b>' } },
        { type: 'paragraph', data: { text: 'After the image' } },
      ],
    },
  });
  const r = await get('/blog/illustrated');
  const d = doc(r);
  const img = d.querySelector('.body img');
  assert.match(
    img.srcset,
    new RegExp(
      `/media/${m.id}/320\\.webp 320w, /media/${m.id}/640\\.webp 640w, /media/${m.id}/1280\\.webp 1280w, /media/${m.id}/original\\.jpg 1400w`,
    ),
  );
  assert.equal(img.getAttribute('width'), '1400');
  assert.equal(img.alt, 'A red banner');
  assert.equal(d.querySelector('figcaption b').textContent, 'here');
  assert.equal(d.querySelector('img.hero').alt, 'A red banner');
  assert.equal(
    d.querySelector('meta[property="og:image"]').content,
    `https://acme.example/media/${m.id}/original.jpg`,
  );
  assert.equal(d.querySelector('meta[name="twitter:card"]').content, 'summary_large_image');
  assert.equal(
    (await request(node.app).get(img.srcset.split(' ')[0])).status,
    200,
    'and the URLs work',
  );

  assert.equal((await get('/blog/illustrated')).headers['x-cache'], 'HIT');
  await admin.put(`/api/admin/media/${m.id}`).send({ alt: 'A crimson banner' });
  const after = await get('/blog/illustrated');
  assert.equal(
    after.headers['x-cache'],
    'MISS',
    'editing the alt text refreshed the page that shows it',
  );
  assert.equal(doc(after).querySelector('.body img').alt, 'A crimson banner');
});

test('the page cache: second request is a HIT with ETag/304 and CDN headers; drafts and unknown pages never leak', async () => {
  const first = await get('/about-us');
  const again = await get('/about-us');
  assert.equal(again.headers['x-cache'], 'HIT');
  assert.equal(again.text, first.text);
  assert.match(
    again.headers['cache-control'],
    /public, max-age=60, s-maxage=300, stale-while-revalidate=30/,
  );
  assert.match(again.headers.etag, /^W\/"/);
  assert.equal((await get('/about-us').set('If-None-Match', again.headers.etag)).status, 304);
  const head = await request(node.app).head('/about-us');
  assert.equal(head.status, 200);
  assert.equal(head.text ?? '', '');

  await node.ctx.content.create(
    'page',
    { title: 'Hidden draft', data: { body: body('draft') } },
    null,
  );
  assert.equal((await get('/hidden-draft')).status, 404);
  await node.ctx.content.create(
    'page',
    {
      title: 'Later',
      status: 'scheduled',
      publishAt: Date.now() + 3600_000,
      data: { body: body('later') },
    },
    null,
  );
  assert.equal((await get('/later')).status, 404);
  assert.equal((await get('/blog/hidden-draft')).status, 404);

  // query strings that mean nothing don't create new cache entries
  assert.equal((await get('/about-us?utm_source=x')).headers['x-cache'], 'HIT');
  await node.ctx.settings.update('site', { values: { page_cache_seconds: 0 } });
  const off = await get('/about-us');
  assert.equal(off.headers['x-cache'], 'BYPASS');
  assert.equal(off.headers['cache-control'], 'no-store');
  await node.ctx.settings.update('site', { reset: ['page_cache_seconds'] });
  const notFound = await get('/nope-1');
  assert.equal(notFound.headers['cache-control'], 'public, max-age=30, s-maxage=60');
  assert.equal(
    (await get('/nope-2')).headers['x-cache'],
    'BYPASS',
    'a made-up address is never stored one by one, so a flood of them cannot fill the cache',
  );
});

test('editing invalidates exactly the pages that show the change', async () => {
  const a = await publish('page', 'Page A');
  await publish('page', 'Page B');
  const p1 = await publish('post', 'Listed post', { excerpt: 'orig excerpt' });
  await publish('post', 'Other post');
  for (const u of ['/page-a', '/page-b', '/blog/listed-post', '/blog/other-post', '/blog'])
    await get(u); // warm
  const state = async () =>
    Object.fromEntries(
      await Promise.all(
        ['/page-a', '/page-b', '/blog/listed-post', '/blog/other-post', '/blog'].map(async (u) => [
          u,
          (await get(u)).headers['x-cache'],
        ]),
      ),
    );

  assert.deepEqual(await state(), {
    '/page-a': 'HIT',
    '/page-b': 'HIT',
    '/blog/listed-post': 'HIT',
    '/blog/other-post': 'HIT',
    '/blog': 'HIT',
  });

  // 1. rewriting the text of page A refreshes page A only
  await admin
    .put(`/api/admin/content/entries/${a.id}`)
    .send({ data: { body: body('New words for A') } });
  const s1 = await state();
  assert.equal(s1['/page-a'], 'MISS');
  assert.equal(s1['/page-b'], 'HIT', 'another page is untouched by a body edit');
  assert.equal(s1['/blog'], 'HIT');
  assert.match((await get('/page-a')).text, /New words for A/);

  // 2. editing a post refreshes it and the lists that show it, not its neighbours
  await admin
    .put(`/api/admin/content/entries/${p1.id}`)
    .send({ data: { excerpt: 'changed excerpt' } });
  const s2 = await state();
  assert.equal(s2['/blog/listed-post'], 'MISS');
  assert.equal(s2['/blog'], 'MISS');
  assert.equal(s2['/blog/other-post'], 'HIT');
  assert.equal(s2['/page-b'], 'HIT');
  assert.match((await get('/blog')).text, /changed excerpt/);

  // 3. renaming a page changes the navigation and breadcrumbs, so pages that show them refresh
  await admin.put(`/api/admin/content/entries/${a.id}`).send({ title: 'Page A renamed' });
  assert.equal((await state())['/page-b'], 'MISS');
  assert.equal((await get('/page-a')).status, 200);
});

test('a cached page is refreshed on every server: edit on one, and the other stops serving the old version', async () => {
  const db = tmpDb();
  const emitter = sharedBus();
  const a = await makeNode({ dbUrl: db.url, bus: busFor(emitter), env: { MEDIA_DIR: media } });
  const b = await makeNode({ dbUrl: db.url, bus: busFor(emitter), env: { MEDIA_DIR: media } });
  try {
    const entry = await a.ctx.content.create(
      'page',
      { title: 'Shared page', status: 'published', data: { body: body('version one') } },
      null,
    );
    const viaB = () => request(b.app).get('/shared-page');
    await viaB();
    const hit = await viaB();
    assert.equal(hit.headers['x-cache'], 'HIT');
    assert.match(hit.text, /version one/);

    const t0 = Date.now();
    await a.ctx.content.update(entry.id, { data: { body: body('version two') } }, null);
    await until(async () => /version two/.test((await viaB()).text), { timeout: 3000, every: 20 });
    assert.ok(
      Date.now() - t0 < 3000,
      `refreshed everywhere within seconds (${Date.now() - t0} ms)`,
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
    db.cleanup();
  }
});

test('redirects: temporary and permanent, query strings kept, they win over pages, loops and junk are refused', async () => {
  const mk = (b) => admin.post('/api/admin/redirects').send(b);
  assert.equal((await mk({ from: '/old-about', to: '/about-us' })).status, 201);
  const r = await get('/old-about?ref=mail');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/about-us?ref=mail');
  await mk({ from: '/promo', to: 'https://shop.example/sale', status: 302 });
  const ext = await get('/promo?x=1');
  assert.equal(ext.status, 302);
  assert.equal(
    ext.headers.location,
    'https://shop.example/sale',
    'query strings are not forwarded to other sites',
  );
  await mk({ from: '/page-b', to: '/about-us' });
  assert.equal((await get('/page-b')).status, 301, 'a redirect beats a page at the same address');

  assert.equal((await mk({ from: '/old-about', to: '/x' })).status, 409);
  assert.equal((await mk({ from: '/a', to: '/a' })).status, 422);
  assert.equal((await mk({ from: '/about-us', to: '/old-about' })).status, 422, 'A→B and B→A');
  assert.equal((await mk({ from: 'no-slash', to: '/x' })).status, 422);
  assert.equal((await mk({ from: '/q?x=1', to: '/x' })).status, 422);
  assert.equal((await mk({ from: '/j', to: 'javascript:alert(1)' })).status, 422);
  assert.equal((await mk({ from: '/j', to: '//evil.example' })).status, 422);
  assert.equal((await mk({ from: '/j', to: '/x', status: 200 })).status, 422);
  const list = (await admin.get('/api/admin/redirects')).body.redirects;
  await admin.delete(`/api/admin/redirects/${list.find((x) => x.from === '/page-b').id}`);
  assert.equal(
    (await get('/page-b')).status,
    200,
    'removing the redirect brings the page back at once',
  );
});

test('trailing slashes redirect to one canonical address', async () => {
  const r = await get('/about-us/?a=1');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/about-us?a=1');
});

test('navigation menus: entries link by their current address, unpublished ones vanish, the current page is marked', async () => {
  const about = (await admin.get('/api/admin/content/types/page/entries?q=About')).body.entries[0];
  const team = (await admin.get('/api/admin/content/types/page/entries?q=Team')).body.entries[0];
  const draft = await node.ctx.content.create('page', { title: 'Menu draft', data: {} }, null);
  const put = (name, items) => admin.put(`/api/admin/menus/${name}`).send({ title: name, items });
  assert.equal(
    (
      await put('main', [
        { label: 'About', entryId: about.id, children: [{ label: 'The team', entryId: team.id }] },
        { label: 'Soon', entryId: draft.id },
        { label: 'Shop', url: 'https://shop.example' },
        { label: 'Blog', url: '/blog' },
      ])
    ).status,
    200,
  );
  await put('footer', [{ label: 'Contact', url: 'mailto:hi@acme.example' }]);

  const d = doc(await get('/about-us/team'));
  const top = [...d.querySelectorAll('header nav > ul > li > a')].map((a) => [
    a.textContent,
    a.getAttribute('href'),
    a.getAttribute('aria-current'),
  ]);
  assert.deepEqual(top, [
    ['About', '/about-us', 'page'],
    ['Shop', 'https://shop.example', null],
    ['Blog', '/blog', null],
  ]);
  assert.equal(d.querySelector('.sub a').textContent, 'The team');
  assert.equal(d.querySelector('footer a').getAttribute('href'), 'mailto:hi@acme.example');

  await admin.put(`/api/admin/content/entries/${about.id}`).send({ slug: 'about' });
  assert.equal(
    doc(await get('/blog'))
      .querySelector('header nav a')
      .getAttribute('href'),
    '/about',
    'a renamed page updates the menu on every cached page',
  );

  for (const bad of [
    [{ label: 'x', url: 'javascript:alert(1)' }],
    [{ label: '', url: '/x' }],
    [{ label: 'x', url: '//evil.example' }],
    [
      {
        label: 'x',
        url: '/a',
        children: [
          {
            label: 'y',
            url: '/b',
            children: [{ label: 'z', url: '/c', children: [{ label: 'w', url: '/d' }] }],
          },
        ],
      },
    ],
  ])
    assert.equal((await put('main', bad)).status, 422, JSON.stringify(bad).slice(0, 60));
  assert.equal((await admin.delete('/api/admin/menus/footer')).status, 204);
});

test('sitemap.xml and robots.txt: published, indexable pages only; noindex switches everything off', async () => {
  const sm = await get('/sitemap.xml');
  assert.equal(sm.status, 200);
  assert.match(sm.headers['content-type'], /application\/xml/);
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.includes('https://acme.example/'));
  assert.ok(locs.includes('https://acme.example/blog/post-1'));
  assert.ok(locs.includes('https://acme.example/event/launch-party'));
  assert.ok(locs.includes('https://acme.example/category/news'));
  assert.ok(
    !locs.some((l) => /hidden-draft|later|secret-sauce/.test(l)),
    'no drafts, scheduled or noindex pages',
  );
  assert.match(sm.text, /<lastmod>\d{4}-\d\d-\d\dT/);
  assert.ok(!sm.text.includes('<script'));

  const robots = (await get('/robots.txt')).text;
  assert.match(
    robots,
    /^User-agent: \*\nDisallow: \/admin\nDisallow: \/api\/\nDisallow: \/preview\/\nDisallow: \/search\n\nSitemap: https:\/\/acme\.example\/sitemap\.xml\n$/,
  );
  await node.ctx.settings.update('site', {
    values: { robots_extra: 'Disallow: /private\n  Crawl-delay: 5' },
  });
  assert.match((await get('/robots.txt')).text, /Disallow: \/private\nCrawl-delay: 5/);

  await node.ctx.settings.update('site', { values: { noindex: true } });
  assert.match((await get('/robots.txt')).text, /^User-agent: \*\nDisallow: \/\n/);
  assert.doesNotMatch((await get('/robots.txt')).text, /Sitemap/);
  assert.equal((await get('/sitemap.xml')).status, 404);
  const page = await get('/about');
  assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(page.text, /name="robots" content="noindex, nofollow"/);
  await node.ctx.settings.update('site', { reset: ['noindex', 'robots_extra'] });
  assert.equal((await get('/sitemap.xml')).status, 200);
});

test('a new post appears in the sitemap without waiting for the cache to expire', async () => {
  await publish('post', 'Fresh off the press');
  assert.match((await get('/sitemap.xml')).text, /blog\/fresh-off-the-press/);
});

test('drafts can be previewed with a signed, expiring link, and nothing else can see them', async () => {
  const draft = await node.ctx.content.create(
    'post',
    { title: 'Upcoming', data: { body: body('Not public yet') } },
    null,
  );
  assert.equal((await get('/blog/upcoming')).status, 404);

  const link = (await admin.post(`/api/admin/content/entries/${draft.id}/preview-link`).send({}))
    .body;
  assert.match(link.url, /^https:\/\/acme\.example\/preview\/\d+\?exp=\d+&sig=/);
  const r = await get(link.path);
  assert.equal(r.status, 200);
  assert.match(r.text, /Not public yet/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.match(r.text, /name="robots" content="noindex/);

  const u = new URL(link.url);
  const other = await node.ctx.content.create('post', { title: 'Someone else', data: {} }, null);
  const tampered = [
    `/preview/${other.id}${u.search}`,
    `/preview/${draft.id}?exp=${u.searchParams.get('exp')}&sig=abc`,
    `/preview/${draft.id}?exp=${Date.now() - 1000}&sig=${u.searchParams.get('sig')}`,
    `/preview/${draft.id}`,
    `/preview/${draft.id}?exp=99999999999999&sig=${u.searchParams.get('sig')}`,
  ];
  for (const t of tampered) assert.equal((await get(t)).status, 403, t);

  const role = await node.ctx.users.createRole(
    { name: 'ReadOnlyPreview', permissions: ['admin.access', 'content.post.read'] },
    null,
  );
  await node.ctx.users.createUser(
    { email: 'ro@example.com', name: 'RO', password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  const ro = await signedIn(node.app, { email: 'ro@example.com', password: 'Some-long-pass-12' });
  assert.equal(
    (await ro.post(`/api/admin/content/entries/${draft.id}/preview-link`).send({})).status,
    403,
  );
});

test('maintenance mode shows a 503 to visitors but not to the admin', async () => {
  await node.ctx.settings.update('general', {
    values: { maintenance_mode: true, maintenance_message: 'Back at <noon>' },
  });
  const r = await get('/about');
  assert.equal(r.status, 503);
  assert.equal(r.headers['retry-after'], '300');
  assert.match(r.text, /Back at &lt;noon&gt;/);
  assert.equal((await get('/blog')).status, 503);
  assert.equal((await get('/robots.txt')).status, 200);
  assert.equal((await admin.get('/api/admin/themes')).status, 200);
  await node.ctx.settings.update('general', { reset: ['maintenance_mode', 'maintenance_message'] });
  assert.equal((await get('/about')).status, 200);
});

test('theme assets are served immutable under the current hash, briefly under an old one, and never outside assets/', async () => {
  const css = doc(await get('/about')).querySelector('link[rel="stylesheet"]').href;
  const ok = await get(css);
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /text\/css/);
  assert.match(ok.headers['cache-control'], /immutable/);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  const stale = await get(css.replace(/\/[0-9a-f]{12}\//, '/000000000000/'));
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['cache-control'], 'public, max-age=60');
  for (const bad of [
    '/theme/default/x/assets/../theme.json',
    '/theme/default/x/assets/..%2ftheme.json',
    '/theme/default/x/assets/nope.css',
    '/theme/ghost/x/assets/theme.css',
    '/theme/default/x/assets/locales/en.json',
  ])
    assert.equal((await get(bad)).status, 404, bad);
});

test('a broken theme does not take the site down: pages fall back to the built-in theme', async () => {
  const files = {
    'theme.json': JSON.stringify({ id: 'heavy', name: 'Heavy', version: '1.0.0' }),
    // The loop grows with the page title, so the install dry run (a tiny sample page) passes and a long title blows the budget.
    'layouts/default.html':
      '<html><head>{{ seo.head }}{{ content_for_header }}</head><body class="heavy">{% assign n = seo.title.size | times: 4000 %}{% for i in (1..n) %}x{% endfor %}{{ content_for_layout }}</body></html>',
  };
  const z = new AdmZip();
  for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.from(c));
  await node.ctx.themes.install(z.toBuffer(), null);
  await node.ctx.themes.activate('heavy', null);
  assert.match(
    (await get('/blog')).text,
    /class="heavy"/,
    'the theme works for what it can render',
  );
  await node.ctx.settings.update('themes', { values: { render_ms: 50 } });
  await publish(
    'page',
    'A title long enough to make the heavy theme loop for a very long time indeed, far beyond its budget',
  );
  const r = await get(
    '/a-title-long-enough-to-make-the-heavy-theme-loop-for-a-very-long-time-indeed-far-beyond-its-budget',
  );
  assert.equal(r.status, 200);
  assert.match(r.text, /class="brand"/, 'served by the default theme');
  assert.doesNotMatch(r.text, /class="heavy"/);
  await node.ctx.themes.activate('default', null);
  await node.ctx.themes.uninstall('heavy', null);
  await node.ctx.settings.update('themes', { reset: ['render_ms'] });
});

test('contact form: stored and emailed, with honeypot, signed token, validation, link limit and a rate limit', async () => {
  await configureMail(node.ctx, smtp);
  await node.ctx.settings.update('site', { values: { contact_recipient: 'sales@acme.example' } });
  const page = await get('/contact');
  assert.equal(page.status, 200);
  const d = doc(page);
  const form = d.querySelector('form.contact');
  assert.equal(form.method, 'post');
  assert.equal(form.getAttribute('action'), '/contact');
  const token = d.querySelector('input[name="t"]').value;
  assert.match(token, /^\d+\.[\w-]+$/);
  assert.equal(d.querySelector('.hp input').tabIndex, -1);

  const post = (fields) =>
    request(node.app)
      .post('/contact')
      .type('form')
      .send({
        back: '/contact',
        t: token,
        name: 'Asha',
        email: 'asha@example.com',
        message: 'Hello <b>team</b>',
        ...fields,
      });
  const ok = await post({});
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/contact?sent=1#contact');
  const stored = await node.ctx.db('contact_messages').first();
  assert.equal(stored.name, 'Asha');
  assert.equal(stored.message, 'Hello <b>team</b>', 'stored as typed');
  await until(async () => (await node.ctx.db('contact_messages').first()).emailed, {
    timeout: 4000,
  });
  await until(() => smtp.messages.length === 1, { timeout: 4000 });
  const mail = smtp.messages[0];
  assert.equal(mail.to.text, 'sales@acme.example');
  assert.equal(mail.replyTo.text, 'asha@example.com');
  assert.match(
    mail.html,
    /Hello &lt;b&gt;team&lt;\/b&gt;/,
    'the message is escaped inside the email',
  );
  assert.ok(!/<b>team/.test(mail.html));

  const flash = await get('/contact?sent=1');
  assert.match(doc(flash).querySelector('.notice.ok').textContent, /Thanks/);
  assert.equal(flash.headers['cache-control'], 'no-store');
  assert.equal(flash.headers['x-cache'], 'BYPASS');
  assert.equal(
    doc(await get('/contact?error=invalid')).querySelector('.notice.bad').textContent,
    'Please fill in your name, a valid email address and a message.',
  );
  assert.equal(
    doc(await get('/contact?error=<script>')).querySelector('.notice.bad'),
    null,
    'error text is never taken from the address',
  );

  const count = async () =>
    Number((await node.ctx.db('contact_messages').count({ n: '*' }).first()).n);
  const before = await count();
  assert.equal(
    (await post({ website: 'http://spam.example' })).headers.location,
    '/contact?sent=1#contact',
    'a bot is told it worked',
  );
  assert.equal(
    (await post({ t: '123.forged' })).headers.location,
    '/contact?error=expired#contact',
  );
  assert.equal(
    (await post({ t: `${Date.now() - 3 * 3600_000}.${token.split('.')[1]}` })).headers.location,
    '/contact?error=expired#contact',
  );
  assert.equal((await post({ email: 'nope' })).headers.location, '/contact?error=invalid#contact');
  assert.equal((await post({ name: '' })).headers.location, '/contact?error=invalid#contact');
  assert.equal(
    (await post({ message: 'x'.repeat(5001) })).headers.location,
    '/contact?error=invalid#contact',
  );
  assert.equal(
    (await post({ message: 'http://a.example http://b.example http://c.example http://d.example' }))
      .headers.location,
    '/contact?error=links#contact',
  );
  assert.equal(await count(), before, 'none of those were stored');
  assert.equal(
    (await post({ back: '//evil.example' })).headers.location,
    '/?sent=1#contact',
    'no open redirect',
  );
  assert.equal(
    (await post({ back: 'javascript:alert(1)', name: 'B' })).headers.location.startsWith('/?'),
    true,
  );
  await node.ctx.settings.update('site', { values: { contact_enabled: false } });
  assert.equal((await post({})).status, 404);
  await node.ctx.settings.update('site', { reset: ['contact_enabled', 'contact_recipient'] });

  const msgs = (await admin.get('/api/admin/messages')).body.messages;
  assert.equal(msgs[msgs.length - 1].name, 'Asha');
  assert.equal((await admin.delete(`/api/admin/messages/${msgs[0].id}`)).status, 204);
});

test('the contact form is rate limited per address, and the limit is a setting', async () => {
  const n = await makeNode({ env: { MEDIA_DIR: media } });
  try {
    await n.ctx.settings.update('security', { values: { contact_rate_limit_per_hour: 3 } });
    await n.ctx.content.create(
      'page',
      { title: 'Contact', status: 'published', data: { template: 'contact' } },
      null,
    );
    const token = doc(await request(n.app).get('/contact')).querySelector('input[name="t"]').value;
    const send = () =>
      request(n.app)
        .post('/contact')
        .type('form')
        .send({ back: '/contact', t: token, name: 'A', email: 'a@example.com', message: 'hi' });
    for (let i = 0; i < 3; i++)
      assert.equal((await send()).headers.location, '/contact?sent=1#contact');
    assert.equal(
      (await send()).headers.location,
      '/contact?error=slow#contact',
      'the fourth in an hour is refused',
    );
    assert.equal(Number((await n.ctx.db('contact_messages').count({ n: '*' }).first()).n), 3);
  } finally {
    await n.close();
  }
});

test('metrics count page cache hits, misses and bypasses', async () => {
  const text = await node.ctx.metrics.render();
  assert.match(text, /cms_page_cache_total\{result="hit"/);
  assert.match(text, /cms_page_cache_total\{result="miss"/);
});

test('public pages get the same security headers as the rest of the site', async () => {
  const r = await get('/about');
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-powered-by'], undefined);
  await sleep(1);
});
