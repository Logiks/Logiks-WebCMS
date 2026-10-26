import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';
import { sanitizeBlocks, renderBlocks, blocksToText } from '../src/modules/content/blocks.js';

let node, admin;
const PW = 'Some-long-pass-12';
const para = (...texts) => ({
  blocks: texts.map((text) => ({ type: 'paragraph', data: { text } })),
});
const post = (title, extra = {}) => ({ title, data: { body: para(`About ${title}`) }, ...extra });
const mk = async (type, body) => {
  const r = await admin.post(`/api/admin/content/types/${type}/entries`).send(body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.entry;
};

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

// ───────── blocks ─────────

test('new blocks: table, callout, embed and download are sanitised and rendered', () => {
  const doc = sanitizeBlocks({
    blocks: [
      {
        type: 'table',
        data: {
          header: true,
          rows: [
            ['Name', 'Qty'],
            ['<b>Tea</b><script>x</script>', '2'],
          ],
        },
      },
      { type: 'callout', data: { style: 'warning', text: 'Mind the <i>gap</i>' } },
      { type: 'embed', data: { url: 'https://youtu.be/dQw4w9WgXcQ', caption: 'Demo' } },
      { type: 'download', data: { mediaId: 7, label: 'Price list' } },
    ],
  });
  const html = renderBlocks(doc, {
    images: new Map([[7, { src: '/media/7/a.pdf', size: 204800, filename: 'a.pdf' }]]),
  });
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<td><b>Tea<\/b><\/td>/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(
    html,
    /<aside class="callout callout-warning" role="note">Mind the <i>gap<\/i><\/aside>/,
  );
  assert.match(html, /<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ"/);
  assert.match(
    html,
    /<a href="\/media\/7\/a\.pdf" download>Price list<\/a> <span class="download-size">\(200 KB\)/,
  );
  assert.match(blocksToText(doc), /Tea/);
});

test('an embed from anywhere but YouTube or Vimeo is refused', () => {
  for (const url of [
    'https://evil.example/x',
    'http://youtu.be/dQw4w9WgXcQ',
    'javascript:alert(1)',
  ])
    assert.throws(
      () => sanitizeBlocks({ blocks: [{ type: 'embed', data: { url } }] }),
      /YouTube and Vimeo/,
      url,
    );
  assert.ok(
    sanitizeBlocks({ blocks: [{ type: 'embed', data: { url: 'https://vimeo.com/123456789' } }] }),
  );
});

test('alignment, text colour and size survive; anything else in a style does not', () => {
  const doc = sanitizeBlocks({
    blocks: [
      {
        type: 'paragraph',
        data: {
          align: 'center',
          text: '<span style="color: rgb(255, 0, 0); background:url(javascript:x); font-size:2em">a</span><font color="#00ff00" size="5">b</font><span style="color:expression(alert(1))">c</span>',
        },
      },
      { type: 'header', data: { text: 'H', level: 2, align: 'bogus' } },
    ],
  });
  const t = doc.blocks[0].data.text;
  assert.match(t, /color:\s*rgb\(255, 0, 0\)/);
  assert.match(t, /font-size:\s*2em/);
  assert.match(t, /color:#00ff00;font-size:1\.5em/);
  assert.doesNotMatch(t, /url\(|expression/);
  assert.equal(doc.blocks[0].data.align, 'center');
  assert.equal('align' in doc.blocks[1].data, false, 'an unknown alignment is dropped');
  assert.match(renderBlocks(doc), /<p style="text-align:center">/);
});

// ───────── authors and list filters ─────────

test('the author can be chosen, only by someone who may edit other people’s work, and the list filters by author, term and date', async () => {
  const role = await node.ctx.users.createRole(
    { name: 'Writer', permissions: ['admin.access', 'content.post.read', 'content.post.write'] },
    null,
  );
  const writer = await node.ctx.users.createUser(
    { email: 'writer@example.com', name: 'Wendy Writer', password: PW, roleId: Number(role.id) },
    null,
  );
  const authors = (await admin.get('/api/admin/content/authors')).body.authors;
  assert.ok(authors.some((a) => a.name === 'Wendy Writer'));
  assert.equal(Object.keys(authors[0]).sort().join(), 'id,name', 'names only');

  const e = await mk('post', post('By Wendy', { authorId: Number(writer.id) }));
  assert.equal(e.authorId, Number(writer.id));
  assert.equal(e.author, 'Wendy Writer');
  const mine = await mk('post', post('By admin'));
  const moved = await admin
    .put(`/api/admin/content/entries/${mine.id}`)
    .send({ authorId: Number(writer.id), version: mine.version });
  assert.equal(moved.body.entry.authorId, Number(writer.id));

  const bad = await admin
    .put(`/api/admin/content/entries/${mine.id}`)
    .send({ authorId: 99999, version: moved.body.entry.version });
  assert.equal(bad.status, 422);

  const w = await signedIn(node.app, { email: 'writer@example.com', password: PW });
  const ownRes = await w.post('/api/admin/content/types/post/entries').send(post('Wendy own'));
  const own = ownRes.body.entry;
  const refused = await w
    .put(`/api/admin/content/entries/${own.id}`)
    .send({ authorId: 1, version: own.version });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error.message, /author/i);

  const byWendy = (await admin.get(`/api/admin/content/types/post/entries?authorId=${writer.id}`))
    .body;
  assert.ok(byWendy.entries.length >= 3);
  assert.ok(byWendy.entries.every((x) => x.authorId === Number(writer.id)));
  const future = Date.now() + 86_400_000;
  assert.equal(
    (await admin.get(`/api/admin/content/types/post/entries?from=${future}`)).body.total,
    0,
  );
  assert.ok((await admin.get(`/api/admin/content/types/post/entries?to=${future}`)).body.total > 0);
  const cat = (
    await admin.post('/api/admin/content/taxonomies/category/terms').send({ name: 'Filter me' })
  ).body.term;
  await mk('post', post('Categorised', { termIds: [cat.id] }));
  const inCat = (await admin.get(`/api/admin/content/types/post/entries?termId=${cat.id}`)).body;
  assert.deepEqual(
    inCat.entries.map((x) => x.title),
    ['Categorised'],
  );
});

// ───────── autosave ─────────

test('autosave keeps a draft without piling up revisions, and never touches live content', async () => {
  const e = await mk('post', post('Autosaved'));
  let v = e.version;
  for (const text of ['one', 'two', 'three']) {
    const r = await admin
      .put(`/api/admin/content/entries/${e.id}`)
      .send({ data: { body: para(text) }, version: v, autosave: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    v = r.body.entry.version;
  }
  const revs = (await admin.get(`/api/admin/content/entries/${e.id}/revisions`)).body.revisions;
  assert.equal(
    revs.filter((r) => r.note === 'Autosave').length,
    1,
    'three autosaves, one revision',
  );
  assert.equal(revs.length, 2, 'Created + Autosave');
  const got = (await admin.get(`/api/admin/content/entries/${e.id}`)).body.entry;
  assert.equal(got.data.body.blocks[0].data.text, 'three');
  assert.equal(got.version, v);

  // A manual save after autosaves adds its own revision.
  await admin.put(`/api/admin/content/entries/${e.id}`).send({ title: 'Autosaved!', version: v });
  assert.equal(
    (await admin.get(`/api/admin/content/entries/${e.id}/revisions`)).body.revisions.length,
    3,
  );

  const live = await mk('post', post('Live one', { status: 'published' }));
  const r = await admin
    .put(`/api/admin/content/entries/${live.id}`)
    .send({ data: { body: para('sneaky') }, version: live.version, autosave: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'autosave_draft_only');
});

// ───────── address change warning + redirect ─────────

test('changing the address of a live entry can redirect the old one', async () => {
  const e = await mk('post', post('Old name', { status: 'published' }));
  const oldUrl = node.ctx.site.urls.entry(e);
  assert.ok(oldUrl);
  const r = await admin
    .put(`/api/admin/content/entries/${e.id}`)
    .send({ slug: 'new-name', version: e.version, redirect: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.redirect.from, oldUrl);
  assert.match(r.body.redirect.to, /new-name$/);
  assert.equal(r.body.redirect.error, undefined);
  const hit = await request(node.app).get(oldUrl).redirects(0);
  assert.equal(hit.status, 301);
  assert.match(hit.headers.location, /new-name$/);

  // Without the flag nothing is created.
  const f = await mk('post', post('Quiet one', { status: 'published' }));
  const q = await admin
    .put(`/api/admin/content/entries/${f.id}`)
    .send({ slug: 'quiet-two', version: f.version });
  assert.equal(q.body.redirect, null);
});

// ───────── automatic unpublishing ─────────

test('an entry can come offline by itself, from any node, and only when it is live or scheduled', async () => {
  const soon = Date.now() + 600;
  const e = await mk('post', post('Short lived', { status: 'published', unpublishAt: soon }));
  assert.equal(e.unpublishAt, soon);
  assert.equal(await node.ctx.content.unpublishDue(), 0, 'not yet');
  await new Promise((r) => setTimeout(r, 700));
  const runs = await Promise.all([
    node.ctx.content.unpublishDue(),
    node.ctx.content.unpublishDue(),
  ]);
  assert.equal(runs[0] + runs[1], 1, 'exactly one node takes it down');
  const got = (await admin.get(`/api/admin/content/entries/${e.id}`)).body.entry;
  assert.equal(got.status, 'draft');
  assert.equal(got.unpublishAt, null);
  assert.equal((await request(node.app).get(`/blog/${e.slug}`)).status, 404);

  const past = await admin
    .post('/api/admin/content/types/post/entries')
    .send(post('Bad time', { status: 'published', unpublishAt: Date.now() - 1000 }));
  assert.equal(past.status, 422);
  assert.equal(past.body.error.code, 'invalid_unpublish_at');
  const before = await admin.post('/api/admin/content/types/post/entries').send(
    post('Before it starts', {
      status: 'scheduled',
      publishAt: Date.now() + 7200_000,
      unpublishAt: Date.now() + 3600_000,
    }),
  );
  assert.equal(before.status, 422);
  const drafts = await mk('post', post('A draft', { unpublishAt: Date.now() + 5000 }));
  assert.equal(drafts.unpublishAt, null, 'drafts have nothing to take down');
});

// ───────── revision compare ─────────

test('one revision can be read in full for the side-by-side compare', async () => {
  const e = await mk('post', post('Compare me'));
  const u = await admin
    .put(`/api/admin/content/entries/${e.id}`)
    .send({ data: { body: para('second draft') }, version: e.version });
  assert.equal(u.status, 200);
  const revs = (await admin.get(`/api/admin/content/entries/${e.id}/revisions`)).body.revisions;
  const first = revs[revs.length - 1];
  const one = (await admin.get(`/api/admin/content/entries/${e.id}/revisions/${first.id}`)).body
    .revision;
  assert.equal(one.data.body.blocks[0].data.text, 'About Compare me');
  const other = await mk('post', post('Someone else'));
  assert.equal(
    (await admin.get(`/api/admin/content/entries/${other.id}/revisions/${first.id}`)).status,
    404,
    'a revision of another entry is not reachable through this one',
  );
});

// ───────── schema type ─────────

test('a post can say it is a NewsArticle; the choice is validated', async () => {
  const e = await mk('post', {
    ...post('Breaking', { status: 'published' }),
    data: {
      body: para('Something happened today in the town square, according to witnesses.'),
      schema_type: 'NewsArticle',
    },
  });
  const page = await request(node.app).get(node.ctx.site.urls.entry(e));
  assert.equal(page.status, 200);
  assert.match(page.text, /"@type":"NewsArticle"/);
  assert.doesNotMatch(page.text, /"@type":"BlogPosting"/);

  const plain = await mk('post', post('Ordinary', { status: 'published' }));
  assert.match(
    (await request(node.app).get(node.ctx.site.urls.entry(plain))).text,
    /"@type":"BlogPosting"/,
  );
  const bad = await admin
    .post('/api/admin/content/types/post/entries')
    .send({ title: 'x', data: { schema_type: 'Product' } });
  assert.equal(bad.status, 422);
});

// ───────── pre-publish checks ─────────

test('the checklist says what is missing, with a fix for each, and finds dead links on this site', async () => {
  const draft = {
    title: 'Needs work',
    data: {
      body: {
        blocks: [
          {
            type: 'paragraph',
            data: { text: 'See <a href="/no-such-page">this</a> and <a href="/blog">blog</a>.' },
          },
          { type: 'image', data: { mediaId: 999999, alt: '', caption: '' } },
        ],
      },
    },
  };
  const r = (await admin.post('/api/admin/content/types/post/checks').send(draft)).body;
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.ok(by['meta-description'], 'no search description');
  assert.ok(by['featured-image']);
  assert.match(by['broken-links'].message, /\/no-such-page/);
  assert.doesNotMatch(by['broken-links'].message, /\/blog\b(?!-)/);
  assert.ok(
    r.checks.every((c) => c.fix),
    'each check says how to fix it',
  );
  assert.match(r.suggestedDescription, /See this and blog/);

  const done = (
    await admin.post('/api/admin/content/types/post/checks').send({
      title: 'Done',
      data: {
        seo_description:
          'A search description that is long enough to be shown in full by search engines, around one hundred and forty characters in all.',
        body: para('x'.repeat(300)),
      },
    })
  ).body;
  assert.equal(
    done.checks.some((c) => c.id === 'meta-description'),
    false,
  );

  const slug = await mk('post', post('Live address', { status: 'published' }));
  const s = (
    await admin
      .post('/api/admin/content/types/post/checks')
      .send({ title: 'Live address', slug: 'other', entryId: slug.id, data: {} })
  ).body;
  assert.ok(s.checks.some((c) => c.id === 'slug-changed'));

  const invalid = (
    await admin
      .post('/api/admin/content/types/post/checks')
      .send({ title: 'x', data: { body: { blocks: [{ type: 'nope', data: {} }] } } })
  ).body;
  assert.equal(invalid.checks[0].level, 'error');
});

test('the checklist needs permission to edit that kind of content', async () => {
  const role = await node.ctx.users.createRole(
    { name: 'Reader', permissions: ['content.post.read'] },
    null,
  );
  await node.ctx.users.createUser(
    { email: 'reader@example.com', name: 'Reader', password: PW, roleId: Number(role.id) },
    null,
  );
  const rd = await signedIn(node.app, { email: 'reader@example.com', password: PW });
  assert.equal(
    (await rd.post('/api/admin/content/types/post/checks').send({ title: 'x', data: {} })).status,
    403,
  );
});
