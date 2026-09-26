import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { JSDOM } from 'jsdom';
import { makeNode, signedIn } from './helpers.js';
import { WRAPPER_CSS, compileComponent } from '../src/modules/site/component.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = path.join(ROOT, 'site', 'defaults');
const readDefault = (rel) => fs.readFileSync(path.join(DEFAULTS, rel), 'utf8');
const zipOf = (files) => {
  const z = new AdmZip();
  for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.from(c));
  return z.toBuffer();
};

/** A second theme: only layouts, components, styles and locales. */
const AURORA = {
  'theme.json': JSON.stringify({
    id: 'aurora',
    name: 'Aurora',
    version: '1.0.0',
    styles: ['aurora.css'],
  }),
  'layouts/default.html':
    '<!doctype html><html><head>{{ seo.head }}{{ content_for_header }}</head><body class="aurora">{% render "theme/masthead" %}<div id="frame">{{ content_for_layout }}</div>{{ content_for_footer }}</body></html>',
  'layouts/landing.html':
    '<!doctype html><html><head>{{ content_for_header }}</head><body class="aurora-landing">{{ content_for_layout }}</body></html>',
  'components/masthead.html':
    '<style>.m { background: #111; color: #fff }</style><div class="m">AURORA MASTHEAD {{ site.name }}</div>',
  'styles/aurora.css': 'body{background:#000}',
  'locales/en.json': '{}',
};

let node, admin;
const get = (p) => request(node.app).get(p);
const idOf = (rel) => compileComponent(`site:${rel}`, readDefault(rel)).id;
const cssOf = (rel) => compileComponent(`site:${rel}`, readDefault(rel)).css;
const put = (p, content) => node.ctx.siteFiles.put(p, content, null);
const del = (p) => node.ctx.siteFiles.remove(p, null);
const text = (res) =>
  (res.text.split('<main')[1] ?? res.text)
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const body = (...t) => ({ blocks: t.map((x) => ({ type: 'paragraph', data: { text: x } })) });
const publish = (type, title, data = {}, extra = {}) =>
  node.ctx.content.create(
    type,
    { title, status: 'published', data: { body: body(`Text of ${title}`), ...data }, ...extra },
    null,
  );

before(async () => {
  node = await makeNode(); // a new site starts with the starter pages and components
  admin = await signedIn(node.app);
  await node.ctx.themes.install(zipOf(AURORA), null);
});
after(() => node.close());

describe('serving pages from the site tree', () => {
  test('a page renders inside the theme layout with its components, scoped css and the theme stylesheet', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    const html = res.text;
    assert.match(html, /class="brand"/, 'the theme header component is in the frame');
    assert.match(
      html,
      /<link rel="stylesheet" href="\/theme\/default\/[a-f0-9]{12}\/styles\/site\.css">/,
    );
    assert.equal((html.match(/<style data-cms="components">/g) ?? []).length, 1, 'emitted once');
    assert.ok(!html.includes('<!--cms:'), 'no placeholder is left behind');
    // the wrapper default comes first, so a component's own :host { display: block } wins
    await publish('post', 'Ship it'); // the home page now lists it, so post-list and post-card styles are used too
    const withList = (await get('/')).text;
    assert.ok(withList.includes(cssOf('components/post-list.html')));
    assert.ok(withList.indexOf(WRAPPER_CSS) < withList.indexOf(cssOf('components/post-card.html')));
  });

  test('nested folders, index pages and one address per page', async () => {
    await put('pages/products/index.html', '---\ntitle: Products\n---\n<h1>All products</h1>');
    await put('pages/products/widget.html', '---\ntitle: Widget\n---\n<h1>Widget page</h1>');
    assert.match(text(await get('/products')), /All products/);
    assert.match(text(await get('/products/widget')), /Widget page/);
    assert.equal(
      (await get('/products/index')).status,
      404,
      '/products/index is not a second address',
    );
    assert.equal((await get('/index')).status, 404);
    assert.equal((await request(node.app).head('/products')).status, 200);
  });

  test('[name] and [...name] parts fill params; the most specific page wins', async () => {
    await put('pages/docs/index.html', '<p>DOCS INDEX</p>');
    await put('pages/docs/[section].html', '<p>SECTION {{ params.section }}</p>');
    await put('pages/docs/[...rest].html', '<p>REST {{ params.rest }}</p>');
    await put('pages/docs/faq.html', '<p>FIXED FAQ</p>');
    assert.match(text(await get('/docs')), /DOCS INDEX/);
    assert.match(text(await get('/docs/faq')), /FIXED FAQ/, 'a fixed name beats [section]');
    assert.match(text(await get('/docs/intro')), /SECTION intro/);
    assert.match(text(await get('/docs/a/b/c')), /REST a\/b\/c/, 'the catch-all takes the rest');
    assert.equal(
      (await get('/docs/Not_Valid!')).status,
      404,
      'parts are checked, not passed on raw',
    );
    for (const p of ['docs/index', 'docs/[section]', 'docs/[...rest]', 'docs/faq'])
      await del(`pages/${p}.html`);
  });

  test('an address no page has is the 404 page (status 404, framed by the theme)', async () => {
    const res = await get('/no-such-page');
    assert.equal(res.status, 404);
    assert.match(res.text, /The page you were looking for isn(?:'|&#39;)t here/);
    assert.match(res.text, /class="brand"/);
    assert.match(res.text, /noindex/);
    // without pages/404.html the theme's frame shows a plain one
    const html404 = readDefault('pages/404.html');
    await del('pages/404.html');
    const bare = await get('/no-such-page');
    assert.equal(bare.status, 404);
    assert.match(bare.text, /Page not found/);
    assert.match(bare.text, /class="brand"/);
    await put('pages/404.html', html404);
  });

  test('editing a page or a component shows up at once, even though pages are cached', async () => {
    await put('pages/cached.html', '<p>first version</p>');
    assert.match(text(await get('/cached')), /first version/);
    assert.equal((await get('/cached')).headers['x-cache'], 'HIT');
    await put('pages/cached.html', '<p>second version</p>');
    assert.match(text(await get('/cached')), /second version/);
    await put('components/badge.html', '<span class="b">v1</span>');
    await put('pages/uses-badge.html', '{% render "badge" %}');
    assert.match(text(await get('/uses-badge')), /v1/);
    await put('components/badge.html', '<span class="b">v2</span>');
    assert.match(text(await get('/uses-badge')), /v2/);
    // removing a page hands its address back, even though the old answer was cached
    await get('/cached');
    await del('pages/cached.html');
    assert.equal((await get('/cached')).status, 404);
  });

  test('a component script gets a CSP nonce that matches on a cache HIT (D-055)', async () => {
    await put('components/tracker.html', '<script>window.__x = 1;</script>');
    await put('pages/scripted.html', '{% render "tracker" %}');
    const first = await get('/scripted');
    assert.equal(first.status, 200);
    const nonce = /<script nonce="([^"]+)">window\.__x = 1;<\/script>/.exec(first.text)?.[1];
    assert.ok(nonce, 'the script tag carries a nonce');
    assert.ok(first.headers['content-security-policy'].includes(`'nonce-${nonce}'`));
    assert.match(first.headers['content-security-policy'], /script-src[^;]*'self'/);

    const second = await get('/scripted');
    assert.equal(second.headers['x-cache'], 'HIT');
    assert.match(
      second.text,
      new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}">`),
      'the cached html keeps its original nonce',
    );
    assert.ok(
      second.headers['content-security-policy'].includes(`'nonce-${nonce}'`),
      'a HIT repeats the nonce already baked into the cached html, never a fresh one',
    );
  });

  test('two components with the same class names do not affect each other', async () => {
    const red = '<style>.title { color: red }</style><h2 class="title">red</h2>';
    const blue = '<style>.title { color: blue }</style><h2 class="title">blue</h2>';
    await put('components/red.html', red);
    await put('components/blue.html', blue);
    await put('pages/colours.html', '{% render "red" %}{% render "blue" %}');
    const html = (await get('/colours')).text;
    const r = compileComponent('site:components/red.html', red);
    const b = compileComponent('site:components/blue.html', blue);
    assert.notEqual(r.id, b.id);
    assert.ok(html.includes(`[data-c="${r.id}"] .title{ color: red }`));
    assert.ok(html.includes(`[data-c="${b.id}"] .title{ color: blue }`));
  });

  test('sitemap.xml lists fixed pages and the entries they show, minus 404, noindex and unrouted content', async () => {
    await put('pages/secret.html', '---\nnoindex: true\n---\nhidden');
    await put('pages/skipme.html', '---\nsitemap: false\n---\nhidden too');
    await publish('post', 'Listed post');
    await publish('page', 'Listed page');
    const xml = (await get('/sitemap.xml')).text;
    assert.match(xml, /<loc>[^<]*\/products\/widget<\/loc>/);
    assert.match(
      xml,
      /<loc>[^<]*\/blog\/listed-post<\/loc>/,
      'an entry, at the address its page gives it',
    );
    assert.match(xml, /<loc>[^<]*\/listed-page<\/loc>/);
    assert.doesNotMatch(xml, /\/404</);
    assert.doesNotMatch(xml, /\/secret</);
    assert.doesNotMatch(xml, /\/skipme</);
    assert.doesNotMatch(xml, /\/search</, 'search is sitemap: false');
    const locs = xml.match(/<loc>[^<]*<\/loc>/g);
    assert.equal(new Set(locs).size, locs.length, 'no address twice');
  });

  test('theme files are served with the right type, and only from the folders meant to be public', async () => {
    const hash = /\/theme\/default\/([a-f0-9]{12})\//.exec((await get('/')).text)[1];
    const css = await get(`/theme/default/${hash}/styles/site.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    assert.equal(css.headers['x-content-type-options'], 'nosniff');
    assert.match(css.headers['cache-control'], /immutable/);
    assert.equal(
      (await get(`/theme/default/${hash}/layouts/default.html`)).status,
      404,
      'layouts are not public',
    );
    assert.equal((await get(`/theme/default/${hash}/components/header.html`)).status, 404);
    assert.equal((await get(`/theme/default/${hash}/styles/..%2ftheme.json`)).status, 404);
  });
});

describe('content reaches pages through the endpoints components declare', () => {
  test('blog list, post page, content pages, categories and hierarchy all come from the starter site', async () => {
    const cat = await node.ctx.content.createTerm('category', { name: 'News' }, null);
    await publish('post', 'Big news', {}, { termIds: [cat.id] });
    const page = await publish('page', 'Company', {}, { slug: 'company' });
    await publish('page', 'Team', {}, { slug: 'team', parentId: page.id });

    const blog = await get('/blog');
    assert.equal(blog.status, 200);
    const doc = new JSDOM(blog.text).window.document;
    assert.ok(
      [...doc.querySelectorAll('h3 a')].some((a) => a.getAttribute('href') === '/blog/big-news'),
    );

    const one = await get('/blog/big-news');
    assert.equal(one.status, 200);
    assert.match(one.text, /<title>Big news \| /);
    assert.match(one.text, /Text of Big news/, 'the body html is not escaped');
    assert.match(one.text, /application\/ld\+json[^<]*BlogPosting/);
    assert.match(one.text, /href="\/category\/news"/, 'its category links to the category page');
    assert.match(one.text, /<meta property="og:type" content="article">/);

    const cats = await get('/category/news');
    assert.equal(cats.status, 200);
    assert.match(cats.text, /Big news/);
    assert.equal(
      (await get('/category/nothing')).status,
      404,
      'a term that does not exist is a 404',
    );
    assert.equal((await get('/tag/nothing')).status, 404);

    assert.match(text(await get('/company')), /Text of Company/);
    const nested = await get('/company/team');
    assert.equal(nested.status, 200);
    assert.match(nested.text, /class="crumbs"/, 'breadcrumbs for a page in a hierarchy');
    assert.match(nested.text, /BreadcrumbList/);
    assert.equal(
      (await get('/blog/no-such-post')).status,
      404,
      'a required piece of data that is missing: 404',
    );
  });

  test('drafts never appear; a custom content type gets /<type>/<path> without any configuration', async () => {
    await node.ctx.content.create('post', { title: 'Hidden draft', data: {} }, null);
    assert.equal((await get('/blog/hidden-draft')).status, 404);
    assert.doesNotMatch((await get('/blog')).text, /Hidden draft/);
    node.ctx.content.registry.defineType('event', {
      label: 'Event',
      fields: { body: { type: 'blocks', label: 'Details' } },
    });
    await publish('event', 'Launch party');
    const ev = await get('/event/launch-party');
    assert.equal(ev.status, 200);
    assert.match(ev.text, /Text of Launch party/);
    assert.equal(
      (await get('/post/big-news')).status,
      404,
      '/post/… is not a second address for posts',
    );
    assert.equal((await get('/nosuchtype/x')).status, 404);
  });

  test('a component declares endpoints; the address can use params, query and its own arguments', async () => {
    await put(
      'components/greeter.html',
      `<script type="application/json" data-cms="meta">{"api":[
        {"name":"posts","url":"/api/public/content/post?per_page={{ n | default: 2 }}&page={{ query.page | default: 1 }}"},
        {"name":"missing","url":"/api/public/content/post/definitely-not-here"}
      ]}</script>
      <p class="n">{{ api.posts.items.size }} of {{ api.posts.total }}</p>
      <p class="m">{% if api.missing %}found{% else %}nothing{% endif %}</p>`,
    );
    await put('pages/greet.html', '{% render "greeter", n: 1 %}');
    const res = await get('/greet');
    assert.equal(res.status, 200);
    assert.match(text(res), /1 of \d+/);
    assert.match(
      text(res),
      /nothing/,
      'an endpoint that answers 404 is simply empty unless it is required',
    );
  });

  test('anything a component prints from content is escaped; only block html is trusted', async () => {
    await publish('post', '<img src=x onerror=alert(1)>', {}, { slug: 'evil' });
    const res = await get('/blog/evil');
    assert.doesNotMatch(res.text, /<img src=x onerror/);
    assert.match(res.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch((await get('/blog')).text, /<img src=x onerror/);
  });

  test('seo and not_found are tags any template can use', async () => {
    await put(
      'pages/tagged.html',
      '{% seo title: "Tagged", description: "About tagged", noindex: true, type: "article" %}<p>tagged</p>',
    );
    const t = await get('/tagged');
    assert.match(t.text, /<title>Tagged \| /);
    assert.match(t.text, /<meta name="description" content="About tagged">/);
    assert.match(t.text, /noindex/);
    assert.match(t.text, /og:type" content="article"/);
    await put('pages/gone.html', '<p>you should not see this</p>{% not_found %}');
    const g = await get('/gone');
    assert.equal(g.status, 404);
    assert.doesNotMatch(g.text, /you should not see this/);
    assert.match(g.text, /The page you were looking for isn(?:'|&#39;)t here/);
  });

  test('made-up addresses are never stored one by one, so they cannot fill the cache', async () => {
    // the starter site's catch-all matches every address and only finds out after asking for the content
    for (const p of ['/made-up-1', '/made-up-2', '/made-up-2']) {
      const r = await get(p);
      assert.equal(r.status, 404);
      assert.equal(r.headers['x-cache'], 'BYPASS', p);
      assert.match(r.headers['cache-control'], /max-age=30/, 'a CDN may still hold it briefly');
    }
    // and one that used to be missing is there the moment it is published (nothing stale was kept)
    await publish('page', 'Made Up 3');
    assert.equal((await get('/made-up-3')).status, 200);
  });

  test('the same endpoints answer over HTTP only when the public API is switched on', async () => {
    assert.equal((await get('/api/public/content/post')).status, 404, 'off by default');
    await node.ctx.settings.update('features', { values: { public_api: true } });
    const api = await get('/api/public/content/post?per_page=1');
    assert.equal(api.status, 200);
    assert.equal(api.body.items.length, 1);
    assert.equal(
      typeof api.body.items[0].fields.body.html,
      'string',
      'plain strings over HTTP, Safe values in templates',
    );
    await node.ctx.settings.update('features', { reset: ['public_api'] });
    assert.equal(
      (await get('/blog')).status,
      200,
      'pages read the data in-process, so they keep working with it off',
    );
  });
});

describe('the sandbox holds for site pages', () => {
  test('output is escaped, and a page cannot reach outside the site and theme', async () => {
    await put('pages/xss.html', '---\ntitle: <b>bold</b>\n---\n<h1>{{ page.title }}</h1>');
    assert.match((await get('/xss')).text, /<h1>&lt;b&gt;bold&lt;\/b&gt;<\/h1>/);
    await put('pages/escape.html', '{% render "theme/../../../etc/passwd" %}');
    const res = await get('/escape');
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.text, /root:/);
    assert.match(res.text, /temporarily unavailable/);
    assert.equal((await get('/blog')).status, 200, 'one bad page does not take the site down');
  });

  test('a component that renders itself forever is stopped, not left running', async () => {
    await put('components/loop.html', '{% render "loop" %}');
    await put('pages/looping.html', '{% render "loop" %}');
    const t0 = Date.now();
    assert.equal((await get('/looping')).status, 500);
    assert.ok(Date.now() - t0 < 5000, 'stopped quickly');
    assert.equal((await get('/blog')).status, 200);
  });

  test('data reads are limited per page, and an address outside /api/public/ gives no data', async () => {
    const many = Array.from(
      { length: 10 },
      (_, i) => `{"name":"a${i}","url":"/api/public/content/post?per_page=1"}`,
    ).join(',');
    await put(
      'components/greedy.html',
      `<script type="application/json" data-cms="meta">{"api":[${many}]}</script><p>{{ api.a0.total }}</p>`,
    );
    await put('pages/greedy.html', '{% for i in (1..5) %}{% render "greedy" %}{% endfor %}');
    assert.notEqual(
      (await get('/greedy')).status,
      200,
      '50 reads is over the limit: refused, not run to exhaustion',
    );
    await put(
      'components/outside.html',
      '<script type="application/json" data-cms="meta">{"api":[{"name":"x","url":"/api/public/../../api/admin/settings"}]}</script><p>[{{ api.x }}]</p>',
    );
    await put('pages/outside.html', '{% render "outside" %}');
    const o = await get('/outside');
    assert.match(o.text, /\[\]/, 'an address that leaves the data layer just gives no data');
    assert.doesNotMatch(o.text, /session_secret/);
  });
});

describe('changing the theme changes only the theme', () => {
  test('pages, content and site components stay exactly as they were; the frame, header, styles and scripts change', async () => {
    await put(
      'pages/about-us.html',
      '{% render "hero", heading: "About us", text: "Same words in every theme." %}{% render "cta", heading: "Want to work with us?" %}',
    );
    const heroId = idOf('components/hero.html');
    const ctaId = idOf('components/cta.html');
    const before = (await get('/about-us')).text;
    for (const id of [heroId, ctaId]) assert.ok(before.includes(`data-c="${id}"`));
    assert.match(before, /class="brand"/);
    assert.doesNotMatch(before, /AURORA/);

    assert.equal((await admin.post('/api/admin/themes/aurora/activate').send({})).status, 200);
    const after = (await get('/about-us')).text;

    for (const id of [heroId, ctaId])
      assert.ok(after.includes(`data-c="${id}"`), `site component ${id} survived`);
    assert.ok(after.includes(cssOf('components/hero.html')));
    assert.ok(after.includes(cssOf('components/cta.html')));
    for (const words of ['Same words in every theme.', 'Want to work with us?'])
      assert.ok(
        before.includes(words) && after.includes(words),
        `"${words}" is the same in both themes`,
      );

    assert.match(after, /AURORA MASTHEAD/);
    assert.doesNotMatch(after, /class="brand"/, 'the old theme header is gone');
    assert.doesNotMatch(after, /styles\/site\.css/, 'the old theme stylesheet is gone');
    assert.match(after, /\/theme\/aurora\/[a-f0-9]{12}\/styles\/aurora\.css/);
    assert.match(after, /class="aurora"/);
    const hash = /\/theme\/aurora\/([a-f0-9]{12})\//.exec(after)[1];
    assert.equal(
      (await get(`/theme/aurora/${hash}/styles/aurora.css`)).text,
      'body{background:#000}',
    );

    // blog posts and content pages are pages too, so they change frame together with everything else
    await publish('post', 'Frame check');
    const blogPost = (await get('/blog/frame-check')).text;
    assert.match(blogPost, /AURORA MASTHEAD/);
    assert.match(blogPost, /Text of Frame check/);
  });

  test('a page chooses a layout by name; a theme without it falls back to its default layout', async () => {
    await put('pages/promo.html', '---\ntitle: Promo\nlayout: landing\n---\n<p>PROMO BODY</p>');
    assert.match((await get('/promo')).text, /class="aurora-landing"/);
    await admin.post('/api/admin/themes/default/activate').send({});
    const onDefault = await get('/promo');
    assert.equal(onDefault.status, 200);
    assert.match(onDefault.text, /PROMO BODY/);
    assert.match(onDefault.text, /class="brand"/);
    assert.doesNotMatch(onDefault.text, /aurora/);
  });

  test('switching there and back never writes a page or a component', async () => {
    const files = node.ctx.siteFiles.list().length;
    const version = node.ctx.siteFiles.version;
    await admin.post('/api/admin/themes/aurora/activate').send({});
    await admin.post('/api/admin/themes/default/activate').send({});
    assert.equal(node.ctx.siteFiles.version, version);
    assert.equal(node.ctx.siteFiles.list().length, files);
    assert.match((await get('/about-us')).text, /class="brand"/);
  });

  test('a site component cannot be shadowed by, or reach into, the theme namespace', async () => {
    await assert.rejects(
      put('components/theme/header.html', '<p>fake</p>'),
      (e) => e.status === 422,
    );
    await put('pages/no-prefix.html', '{% render "masthead" %}');
    await admin.post('/api/admin/themes/aurora/activate').send({});
    assert.equal(
      (await get('/no-prefix')).status,
      500,
      'components/masthead is not a site component',
    );
    await admin.post('/api/admin/themes/default/activate').send({});
  });
});

describe('the admin API', () => {
  const mk = async (roleName, permissions, email) => {
    const role = await node.ctx.users.createRole(
      { name: roleName, description: '', permissions },
      null,
    );
    await node.ctx.users.createUser(
      { email, name: roleName, password: 'Some-long-pass-12', roleId: Number(role.id) },
      null,
    );
    return signedIn(node.app, { email, password: 'Some-long-pass-12' });
  };

  test('needs a session and a CSRF token, and a role that allows it', async () => {
    assert.equal((await request(node.app).get('/api/admin/site/files')).status, 401);
    assert.equal(
      (
        await request(node.app)
          .put('/api/admin/site/file')
          .send({ path: 'pages/x.html', content: 'x' })
      ).status,
      403,
      'no CSRF token',
    );
    const viewer = await mk('Look only', ['admin.access'], 'look@example.com');
    assert.equal((await viewer.get('/api/admin/site/files')).status, 403);
    assert.equal((await viewer.get('/api/admin/site/file?path=pages/about-us.html')).status, 403);
    assert.equal(
      (await viewer.put('/api/admin/site/file').send({ path: 'pages/v.html', content: 'x' }))
        .status,
      403,
    );
  });

  test('pages and components are separate permissions', async () => {
    const pageEditor = await mk(
      'Page editor',
      ['admin.access', 'pages.read', 'pages.write'],
      'pages@example.com',
    );
    const list = (await pageEditor.get('/api/admin/site/files')).body.files;
    assert.ok(list.length > 0 && list.every((f) => f.kind === 'page'), 'only pages are listed');
    assert.equal(
      (
        await pageEditor
          .put('/api/admin/site/file')
          .send({ path: 'pages/pe.html', content: '<p>pe</p>' })
      ).status,
      200,
    );
    assert.equal(
      (
        await pageEditor
          .put('/api/admin/site/file')
          .send({ path: 'components/pe.html', content: '<p>pe</p>' })
      ).status,
      403,
    );
    assert.equal(
      (await pageEditor.get('/api/admin/site/file?path=components/hero.html')).status,
      403,
    );
    assert.equal(
      (await pageEditor.delete('/api/admin/site/file?path=components/hero.html')).status,
      403,
    );
    assert.equal((await pageEditor.delete('/api/admin/site/file?path=pages/pe.html')).status, 204);
  });

  test('an administrator reads, saves with conflict protection, gets clear errors, and deletes', async () => {
    const list = (await admin.get('/api/admin/site/files')).body;
    assert.equal(list.version, node.ctx.siteFiles.version);
    assert.ok(list.files.some((f) => f.path === 'components/hero.html' && f.kind === 'component'));
    const one = (await admin.get('/api/admin/site/file?path=pages/blog/[slug].html')).body;
    assert.equal(one.content, readDefault('pages/blog/[slug].html'));

    const save = await admin
      .put('/api/admin/site/file')
      .send({ path: 'pages/api-made.html', content: '<p>1</p>' });
    assert.equal(save.status, 200);
    assert.equal(save.body.changed, true);
    const stale = await admin
      .put('/api/admin/site/file')
      .send({ path: 'pages/api-made.html', content: '<p>2</p>', expectedHash: 'f'.repeat(64) });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'conflict');
    assert.equal(
      (
        await admin
          .put('/api/admin/site/file')
          .send({ path: 'pages/api-made.html', content: '<p>2</p>', expectedHash: save.body.hash })
      ).status,
      200,
    );
    const bad = await admin
      .put('/api/admin/site/file')
      .send({ path: 'pages/api-made.html', content: '{% if x %}' });
    assert.equal(bad.status, 422);
    assert.match(bad.body.error.message, /pages\/api-made\.html: Template/);
    assert.equal(
      (await admin.put('/api/admin/site/file').send({ path: 'themes/x.html', content: 'x' }))
        .status,
      422,
    );
    assert.equal((await admin.get('/api/admin/site/file?path=pages/missing.html')).status, 404);
    assert.equal((await admin.delete('/api/admin/site/file?path=pages/api-made.html')).status, 204);
    assert.equal((await get('/api-made')).status, 404);
  });
});
