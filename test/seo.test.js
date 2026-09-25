import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sharp from 'sharp';
import { JSDOM } from 'jsdom';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
const get = (p) => request(node.app).get(p);
const doc = (text) => new JSDOM(text).window.document;

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const mkUser = async (perms, email) => {
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

const mkPost = (title) =>
  node.ctx.content.create(
    'post',
    {
      title,
      status: 'published',
      data: { body: { blocks: [{ type: 'paragraph', data: { text: 'x' } }] } },
    },
    null,
  );

describe('SEO Manager: CRUD and permissions', () => {
  test('seo.write creates, updates and deletes a rule; seo.read alone can only view', async () => {
    const reader = await mkUser(['admin.access', 'seo.read'], 'seo-reader@example.com');
    const writer = await mkUser(
      ['admin.access', 'seo.read', 'seo.write'],
      'seo-writer@example.com',
    );

    assert.equal((await reader.post('/api/admin/seo/rules').send({ pattern: '/x' })).status, 403);

    const created = await writer
      .post('/api/admin/seo/rules')
      .send({ pattern: '/contact', title: 'Contact us' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.rule.id;

    const listed = await reader.get('/api/admin/seo/rules');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.rules.some((r) => r.id === id));
    assert.equal((await reader.get(`/api/admin/seo/rules/${id}`)).status, 200);

    const updated = await writer
      .put(`/api/admin/seo/rules/${id}`)
      .send({ pattern: '/contact', title: 'Get in touch' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.rule.title, 'Get in touch');

    assert.equal((await reader.delete(`/api/admin/seo/rules/${id}`)).status, 403);
    assert.equal((await writer.delete(`/api/admin/seo/rules/${id}`)).status, 204);
    assert.equal((await writer.get(`/api/admin/seo/rules/${id}`)).status, 404);
  });

  test('a pattern must start with / and have no spaces; duplicates are rejected', async () => {
    assert.equal(
      (await admin.post('/api/admin/seo/rules').send({ pattern: 'no-slash' })).status,
      422,
    );
    assert.equal(
      (await admin.post('/api/admin/seo/rules').send({ pattern: '/has space' })).status,
      422,
    );
    const ok = await admin.post('/api/admin/seo/rules').send({ pattern: '/dup-test' });
    assert.equal(ok.status, 201);
    assert.equal(
      (await admin.post('/api/admin/seo/rules').send({ pattern: '/dup-test' })).status,
      422,
    );
    await admin.delete(`/api/admin/seo/rules/${ok.body.rule.id}`);
  });

  test('a meta tag needs exactly a name or a property, not both or neither', async () => {
    const bad = await admin.post('/api/admin/seo/rules').send({
      pattern: '/mt-test',
      metaTags: [{ name: 'a', property: 'b', content: 'c' }],
    });
    assert.equal(bad.status, 422);
  });
});

describe('SEO Manager: matching precedence on a live address', () => {
  test('an exact rule beats a wildcard rule for the same address', async () => {
    const wide = await admin
      .post('/api/admin/seo/rules')
      .send({ pattern: '/*', title: 'Wide rule' });
    const exact = await admin
      .post('/api/admin/seo/rules')
      .send({ pattern: '/contact', title: 'Exact rule' });
    assert.match((await get('/contact')).text, /<title>Exact rule<\/title>/);
    await admin.delete(`/api/admin/seo/rules/${wide.body.rule.id}`);
    await admin.delete(`/api/admin/seo/rules/${exact.body.rule.id}`);
  });

  test('among wildcard matches, the longer literal prefix wins, then priority breaks the tie', async () => {
    const short = await admin
      .post('/api/admin/seo/rules')
      .send({ pattern: '/con*', title: 'Short prefix' });
    const long = await admin
      .post('/api/admin/seo/rules')
      .send({ pattern: '/contact*', title: 'Long prefix' });
    assert.match((await get('/contact')).text, /<title>Long prefix<\/title>/);

    await admin
      .put(`/api/admin/seo/rules/${short.body.rule.id}`)
      .send({ pattern: '/con*', title: 'Short prefix', priority: 10 });
    assert.match((await get('/contact')).text, /<title>Short prefix<\/title>/);

    await admin.delete(`/api/admin/seo/rules/${short.body.rule.id}`);
    await admin.delete(`/api/admin/seo/rules/${long.body.rule.id}`);
  });

  test('** matches an address more than one segment past the prefix (a single * cannot)', async () => {
    // Exercised directly against resolve() rather than through a live page, so this doesn't depend on a
    // particular nested address existing in the starter site's fixture data.
    const single = await admin
      .post('/api/admin/seo/rules')
      .send({ pattern: '/deep/*', title: 'Single segment' });
    assert.equal((await node.ctx.seo.resolve('/deep/one')).title, 'Single segment');
    assert.equal(await node.ctx.seo.resolve('/deep/one/two'), null);
    await admin.delete(`/api/admin/seo/rules/${single.body.rule.id}`);

    const deep = await admin
      .post('/api/admin/seo/rules')
      .send({ pattern: '/deep/**', title: 'Any depth' });
    assert.equal((await node.ctx.seo.resolve('/deep/one')).title, 'Any depth');
    assert.equal((await node.ctx.seo.resolve('/deep/one/two')).title, 'Any depth');
    await admin.delete(`/api/admin/seo/rules/${deep.body.rule.id}`);
  });

  test('a disabled rule never matches', async () => {
    const r = await admin
      .post('/api/admin/seo/rules')
      .send({ pattern: '/contact', title: 'Should not show', enabled: false });
    assert.doesNotMatch((await get('/contact')).text, /<title>Should not show<\/title>/);
    await admin.delete(`/api/admin/seo/rules/${r.body.rule.id}`);
  });

  test('a rule overrides title, description, noindex, canonical and twitter card, and adds a meta tag plus JSON-LD, on top of the entry’s own fields', async () => {
    const post = await mkPost('Rule Target');
    const url = `/blog/${post.slug}`;
    const rule = await admin.post('/api/admin/seo/rules').send({
      pattern: url,
      title: 'Forced title',
      description: 'Forced description',
      noindex: true,
      canonical: '/canonical-target',
      twitterCard: 'summary_large_image',
      metaTags: [{ name: 'custom-tag', content: 'hello' }],
      ldJson: [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] }],
    });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    const html = (await get(url)).text;
    assert.match(html, /<title>Forced title<\/title>/);
    assert.match(html, /name="description" content="Forced description"/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /rel="canonical" href="[^"]*\/canonical-target"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, /<meta name="custom-tag" content="hello">/);
    const ldTypes = [...doc(html).querySelectorAll('script[type="application/ld+json"]')].map(
      (s) => JSON.parse(s.textContent)['@type'],
    );
    assert.ok(ldTypes.includes('FAQPage'), ldTypes.join(','));
    assert.ok(ldTypes.includes('BlogPosting'), 'the page’s own structured data still renders too');
    await admin.delete(`/api/admin/seo/rules/${rule.body.rule.id}`);
  });

  test('noindex: false on a rule overrides a site-wide noindex for that one address', async () => {
    await node.ctx.settings.update('general', { values: { site_name: 'Acme' } });
    await node.ctx.settings.update('site', { values: { noindex: true } });
    assert.match((await get('/contact')).text, /name="robots" content="noindex, nofollow"/);
    const rule = await admin
      .post('/api/admin/seo/rules')
      .send({ pattern: '/contact', noindex: false });
    assert.doesNotMatch((await get('/contact')).text, /name="robots"/);
    await admin.delete(`/api/admin/seo/rules/${rule.body.rule.id}`);
    await node.ctx.settings.update('site', { values: { noindex: false } });
  });

  test('updating a rule is reflected immediately, never served stale from cache', async () => {
    const r = await admin.post('/api/admin/seo/rules').send({ pattern: '/contact', title: 'V1' });
    assert.match((await get('/contact')).text, /<title>V1<\/title>/);
    await admin
      .put(`/api/admin/seo/rules/${r.body.rule.id}`)
      .send({ pattern: '/contact', title: 'V2' });
    assert.match((await get('/contact')).text, /<title>V2<\/title>/);
    await admin.delete(`/api/admin/seo/rules/${r.body.rule.id}`);
    assert.doesNotMatch((await get('/contact')).text, /<title>V2<\/title>/);
  });
});

describe('Settings → SEO: site-wide tags on every page', () => {
  test('Twitter handle, Facebook App ID and search-console verification tags appear in <head>', async () => {
    await node.ctx.settings.update('seo', {
      values: {
        twitter_site: '@acme',
        facebook_app_id: '99999',
        google_site_verification: 'g-abc',
        bing_site_verification: 'b-abc',
        pinterest_site_verification: 'p-abc',
      },
    });
    const html = (await get('/contact')).text;
    assert.match(html, /name="twitter:site" content="@acme"/);
    assert.match(html, /property="fb:app_id" content="99999"/);
    assert.match(html, /name="google-site-verification" content="g-abc"/);
    assert.match(html, /name="msvalidate.01" content="b-abc"/);
    assert.match(html, /name="p:domain_verify" content="p-abc"/);
  });
});

describe('Page Manager SEO section: template-level defaults from front matter', () => {
  test('seo_type and twitter_card front-matter fields set the page’s default when nothing overrides them', async () => {
    const put = await admin.put('/api/admin/site/file').send({
      path: 'pages/seo-defaults.html',
      content: '---\nseo_type: article\ntwitter_card: summary_large_image\n---\n<h1>Hi</h1>',
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const html = (await get('/seo-defaults')).text;
    assert.match(html, /property="og:type" content="article"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    await admin.delete('/api/admin/site/file?path=pages/seo-defaults.html');
  });

  test('seo_image is used as the page’s default social image when nothing else provides one', async () => {
    const buf = await sharp({
      create: { width: 400, height: 300, channels: 3, background: '#333' },
    })
      .jpeg()
      .toBuffer();
    const up = await admin
      .post('/api/admin/media?name=seo-default.jpg&alt=default')
      .set('content-type', 'application/octet-stream')
      .send(buf);
    const mediaId = up.body.item.id;
    const put = await admin.put('/api/admin/site/file').send({
      path: 'pages/seo-image-default.html',
      content: `---\nseo_image: ${mediaId}\n---\n<h1>Hi</h1>`,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const html = (await get('/seo-image-default')).text;
    assert.match(html, new RegExp(`property="og:image" content="[^"]*/media/${mediaId}/`));
    await admin.delete('/api/admin/site/file?path=pages/seo-image-default.html');
  });

  test('an SEO Manager rule’s image overrides the page’s own seo_image default', async () => {
    const buf1 = await sharp({
      create: { width: 400, height: 300, channels: 3, background: '#111' },
    })
      .jpeg()
      .toBuffer();
    const buf2 = await sharp({
      create: { width: 500, height: 400, channels: 3, background: '#222' },
    })
      .jpeg()
      .toBuffer();
    const default_ = (
      await admin
        .post('/api/admin/media?name=default-img.jpg&alt=default')
        .set('content-type', 'application/octet-stream')
        .send(buf1)
    ).body.item;
    const override = (
      await admin
        .post('/api/admin/media?name=override-img.jpg&alt=override')
        .set('content-type', 'application/octet-stream')
        .send(buf2)
    ).body.item;
    await admin.put('/api/admin/site/file').send({
      path: 'pages/seo-image-override.html',
      content: `---\nseo_image: ${default_.id}\n---\n<h1>Hi</h1>`,
    });
    const rule = await admin
      .post('/api/admin/seo/rules')
      .send({ pattern: '/seo-image-override', image: override.id });
    const html = (await get('/seo-image-override')).text;
    assert.match(html, new RegExp(`property="og:image" content="[^"]*/media/${override.id}/`));
    assert.doesNotMatch(html, new RegExp(`/media/${default_.id}/`));
    await admin.delete(`/api/admin/seo/rules/${rule.body.rule.id}`);
    await admin.delete('/api/admin/site/file?path=pages/seo-image-override.html');
  });
});
