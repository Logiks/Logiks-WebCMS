import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
const get = (p) => request(node.app).get(p);

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const mk = async (perms, email) => {
  const role = await node.ctx.users.createRole(
    { name: `r-${email}`, description: '', permissions: perms },
    null,
  );
  await node.ctx.users.createUser(
    { email, name: email, password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  return signedIn(node.app, { email, password: 'Some-long-pass-12' });
};

describe('GET /site/pages and /site/components: what the list screens show', () => {
  test('pages come with their front matter', async () => {
    const r = await admin.get('/api/admin/site/pages');
    assert.equal(r.status, 200);
    const blog = r.body.pages.find((p) => p.path === 'pages/blog/index.html');
    assert.ok(blog);
    assert.equal(blog.kind, 'page');
    assert.ok(blog.front && typeof blog.front === 'object');
    const dyn = r.body.pages.find((p) => p.path === 'pages/blog/[slug].html');
    assert.deepEqual(dyn.params, ['slug']);
  });

  test('components come with their meta: title, props, api', async () => {
    const r = await admin.get('/api/admin/site/components');
    assert.equal(r.status, 200);
    const hero = r.body.components.find((c) => c.path === 'components/hero.html');
    assert.ok(hero);
    assert.equal(hero.meta.title, 'Hero banner');
    assert.ok('heading' in hero.meta.props);
    assert.equal(hero.meta.props.heading.default, 'Welcome');
  });

  test('an invalid file still shows up in the list, just without parsed front matter or meta', async () => {
    // written directly to the DB, bypassing validation, the way an edit from an old code version might be
    await node.ctx.db('site_files').insert({
      path: 'pages/broken.html',
      content: '---\nBad Key: 1\n---\nBody',
      content_hash: 'x'.repeat(64),
      size: 1,
      created_at: 0,
      updated_at: 0,
    });
    await node.ctx.siteFiles.refresh();
    const r = await admin.get('/api/admin/site/pages');
    const broken = r.body.pages.find((p) => p.path === 'pages/broken.html');
    assert.ok(broken);
    assert.equal(broken.front, null);
    await node.ctx.db('site_files').where({ path: 'pages/broken.html' }).del();
    await node.ctx.siteFiles.refresh();
  });

  test('reading the list needs pages.read / components.read, not just admin.access', async () => {
    const bare = await mk(['admin.access'], 'bare-builder@example.com');
    assert.equal((await bare.get('/api/admin/site/pages')).status, 403);
    assert.equal((await bare.get('/api/admin/site/components')).status, 403);
  });
});

describe('GET /site/builder-meta: what the front-matter form offers', () => {
  test('theme layouts, content types and taxonomies', async () => {
    const r = await admin.get('/api/admin/site/builder-meta');
    assert.equal(r.status, 200);
    assert.ok(r.body.layouts.includes('default'));
    assert.ok(r.body.entryTypes.some((t) => t.id === 'post'));
    assert.ok(r.body.entryTypes.some((t) => t.id === 'page'));
    assert.ok(r.body.taxonomies.some((t) => t.id === 'category'));
  });

  test('needs pages.read or components.read', async () => {
    const bare = await mk(['admin.access'], 'bare-meta@example.com');
    assert.equal((await bare.get('/api/admin/site/builder-meta')).status, 403);
  });
});

describe('POST /site/preview: draft content rendered without saving', () => {
  test('a page draft renders, and nothing is written to the site tree', async () => {
    const version = node.ctx.siteFiles.version;
    const r = await admin.post('/api/admin/site/preview').send({
      mode: 'page',
      path: 'pages/blog/index.html',
      content: '---\ntitle: Draft blog\n---\n<h1>Draft body {{ site.name }}</h1>',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 200);
    assert.match(r.body.html, /Draft body/);
    assert.doesNotMatch((await get('/blog')).text, /Draft body/, 'the real page is untouched');
    assert.equal(node.ctx.siteFiles.version, version, 'nothing was saved');
  });

  test('a new page not yet in the tree can be previewed before it is ever saved', async () => {
    const r = await admin.post('/api/admin/site/preview').send({
      mode: 'page',
      path: 'pages/brand-new.html',
      content: '<p>Not saved yet</p>',
    });
    assert.equal(r.status, 200);
    assert.match(r.body.html, /Not saved yet/);
    assert.throws(() => node.ctx.siteFiles.get('pages/brand-new.html'));
  });

  test('a dynamic page previews with a placeholder for the part of the address that varies', async () => {
    const r = await admin.post('/api/admin/site/preview').send({
      mode: 'page',
      path: 'pages/blog/[slug].html',
      content: '<p>slug is {{ params.slug }}</p>',
    });
    assert.equal(r.status, 200);
    assert.match(r.body.html, /slug is sample/);
    // a caller can supply a real value instead
    const r2 = await admin.post('/api/admin/site/preview').send({
      mode: 'page',
      path: 'pages/blog/[slug].html',
      content: '<p>slug is {{ params.slug }}</p>',
      params: { slug: 'hello-world' },
    });
    assert.match(r2.body.html, /slug is hello-world/);
  });

  test('an invalid draft is reported with the same message a save would give, not silently dropped', async () => {
    const r = await admin.post('/api/admin/site/preview').send({
      mode: 'page',
      path: 'pages/blog/index.html',
      content: '{% if %}',
    });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /Template/);
  });

  test('a component draft renders with its props, styled by the active theme', async () => {
    const r = await admin.post('/api/admin/site/preview').send({
      mode: 'component',
      name: 'hero',
      content: node.ctx.siteFiles.get('components/hero.html').content,
      props: { heading: 'Preview heading', button_label: 'Go', button_url: '/somewhere' },
    });
    assert.equal(r.status, 200);
    assert.match(r.body.html, /Preview heading/);
    assert.match(r.body.html, /Go</);
    assert.match(r.body.html, /href="\/somewhere"/);
    // the theme's CSS variables are in scope: the preview is a full page, not a bare fragment
    assert.match(r.body.html, /<style data-cms="components">/);
    // ...but only the component: none of the theme's header, footer or skip link around it
    assert.doesNotMatch(r.body.html, /<header|<footer|class="skip"|<main/);
  });

  test('a prop value can hold quotes, braces and Liquid-looking text without breaking the preview or running as code', async () => {
    const r = await admin.post('/api/admin/site/preview').send({
      mode: 'component',
      name: 'hero',
      content: node.ctx.siteFiles.get('components/hero.html').content,
      props: { heading: '" %}{{ 7 | times: 6 }}{% if true' },
    });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body.html, /\b42\b/, 'the value stayed a plain string, not Liquid code');
    assert.match(r.body.html, /\{\{ 7 \| times: 6 \}\}/, 'printed literally, escaped for HTML');
  });

  test('previewing needs write on the kind being edited, not just read', async () => {
    const reader = await mk(
      ['admin.access', 'pages.read', 'components.read'],
      'reader-preview@example.com',
    );
    assert.equal(
      (
        await reader
          .post('/api/admin/site/preview')
          .send({ mode: 'page', path: 'pages/blog/index.html', content: '<p>x</p>' })
      ).status,
      403,
    );
    assert.equal(
      (
        await reader
          .post('/api/admin/site/preview')
          .send({ mode: 'component', name: 'hero', content: '<p>x</p>' })
      ).status,
      403,
    );
  });
});
