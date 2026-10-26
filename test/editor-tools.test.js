import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';
import { sanitizeBlocks, renderBlocks, blocksToText } from '../src/modules/content/blocks.js';
import { markdownToBlocks } from '../src/modules/content/markdown.js';
import {
  keywordItems,
  structureItems,
  readability,
  readDoc,
} from '../src/modules/content/analysis.js';

let node, admin;
const PW = 'Some-long-pass-12';
const para = (...texts) => ({
  blocks: texts.map((text) => ({ type: 'paragraph', data: { text } })),
});
const mk = async (type, body) => {
  const r = await admin.post(`/api/admin/content/types/${type}/entries`).send(body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.entry;
};
const as = async (name, permissions) => {
  const role = await node.ctx.users.createRole({ name, permissions }, null);
  const email = `${name.toLowerCase().replace(/\W+/g, '')}@example.com`;
  await node.ctx.users.createUser({ email, name, password: PW, roleId: Number(role.id) }, null);
  return signedIn(node.app, { email, password: PW });
};

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

// ───────── blocks ─────────

test('a link can open in a new tab, but only a web address, and the rel stays safe', () => {
  const doc = sanitizeBlocks({
    blocks: [
      {
        type: 'paragraph',
        data: {
          text: '<a href="https://a.com" target="_blank">a</a> <a href="/in" target="_blank">b</a> <a href="https://c.com" target="_top">c</a> <a href="https://d.com">d</a>',
        },
      },
    ],
  });
  const html = renderBlocks(doc);
  assert.match(
    html,
    /<a href="https:\/\/a\.com" rel="noopener nofollow ugc noreferrer" target="_blank">a<\/a>/,
  );
  assert.match(html, /<a href="\/in">b<\/a>/, 'a page of this site never opens elsewhere');
  assert.match(html, /<a href="https:\/\/c\.com" rel="noopener nofollow ugc">c<\/a>/);
  assert.match(html, /<a href="https:\/\/d\.com" rel="noopener nofollow ugc">d<\/a>/);
});

test('button, callout title, embed shape and download card render with their own classes', () => {
  const doc = sanitizeBlocks({
    blocks: [
      {
        type: 'button',
        data: {
          text: 'Buy',
          url: 'https://shop.example',
          look: 'outline',
          newTab: true,
          align: 'center',
        },
      },
      { type: 'button', data: { text: 'Home', url: '/', newTab: true } },
      { type: 'callout', data: { style: 'success', title: 'Tip <b>1</b>', text: 'Do it' } },
      { type: 'embed', data: { url: 'https://youtu.be/dQw4w9WgXcQ', ratio: '4:3' } },
      { type: 'download', data: { mediaId: 3, label: 'Sheet', look: 'card' } },
    ],
  });
  const html = renderBlocks(doc, { images: new Map([[3, { src: '/media/3/a.pdf', size: 2048 }]]) });
  assert.match(
    html,
    /<p class="cms-button-row" style="text-align:center"><a class="cms-button cms-button-outline" href="https:\/\/shop\.example" target="_blank" rel="noopener noreferrer">Buy<\/a><\/p>/,
  );
  assert.match(
    html,
    /<a class="cms-button cms-button-primary" href="\/">Home<\/a>/,
    'no new tab for this site',
  );
  assert.match(html, /<strong class="callout-title">Tip 1<\/strong>Do it/);
  assert.match(html, /<figure class="embed embed-4x3">/);
  assert.match(html, /<p class="download download-card">/);
  assert.throws(
    () =>
      sanitizeBlocks({
        blocks: [{ type: 'button', data: { text: 'x', url: 'javascript:alert(1)' } }],
      }),
    /button address/,
  );
  assert.match(blocksToText(doc), /Buy/);
});

test('custom HTML keeps structure and drops scripts, frames, styles, handlers and unsafe links', () => {
  const doc = sanitizeBlocks({
    blocks: [
      {
        type: 'html',
        data: {
          code: '<div class="promo" style="position:fixed" onclick="x()"><script>1</script><h3>Hi</h3><a href="javascript:alert(1)">bad</a><a href="https://ok.example">ok</a><img src="javascript:1" onerror="x()"><img src="/media/1/a.png" alt="a"></div><iframe src="https://evil.example"></iframe><form action="/x"><input></form>',
        },
      },
    ],
  });
  const html = renderBlocks(doc);
  assert.match(html, /<div class="html-block"><div class="promo"><h3>Hi<\/h3>/);
  assert.match(html, /<a href="https:\/\/ok\.example"/);
  assert.match(html, /<img src="\/media\/1\/a\.png" alt="a" loading="lazy" \/>/);
  for (const bad of [
    '<script',
    'onclick',
    'onerror',
    'style=',
    'javascript:',
    '<iframe',
    '<form',
    '<input',
  ])
    assert.ok(!html.includes(bad), `${bad} must not survive`);
});

// ───────── custom HTML is permissioned ─────────

test('adding or changing a custom HTML block needs its own permission; leaving or removing one does not', async () => {
  const html = (code) => ({ blocks: [{ type: 'html', data: { code } }] });
  const made = await mk('post', { title: 'Has html', data: { body: html('<p>one</p>') } });
  const writer = await as('Html writer', [
    'admin.access',
    'content.post.read',
    'content.post.write',
    'content.post.others',
  ]);
  const refused = await writer
    .post('/api/admin/content/types/post/entries')
    .send({ title: 'Nope', data: { body: html('<p>x</p>') } });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error.message, /custom HTML/);

  const keep = await writer.put(`/api/admin/content/entries/${made.id}`).send({
    title: 'Retitled by someone without the permission',
    data: { body: html('<p>one</p>') },
    version: made.version,
  });
  assert.equal(keep.status, 200, 'the existing block was not touched');
  const change = await writer.put(`/api/admin/content/entries/${made.id}`).send({
    data: { body: html('<p>two</p>') },
    version: keep.body.entry.version,
  });
  assert.equal(change.status, 403);
  const remove = await writer.put(`/api/admin/content/entries/${made.id}`).send({
    data: { body: para('gone') },
    version: keep.body.entry.version,
  });
  assert.equal(remove.status, 200);
  const granted = await as('Html trusted', [
    'admin.access',
    'content.post.read',
    'content.post.write',
    'content.html_blocks',
  ]);
  assert.equal(
    (
      await granted
        .post('/api/admin/content/types/post/entries')
        .send({ title: 'Fine', data: { body: html('<p>x</p>') } })
    ).status,
    201,
  );
});

// ───────── approval workflow ─────────

test('a writer submits for review, a publisher approves or sends it back, and visitors see nothing until it is live', async () => {
  const writer = await as('Review writer', [
    'admin.access',
    'content.post.read',
    'content.post.write',
  ]);
  const made = await writer
    .post('/api/admin/content/types/post/entries')
    .send({ title: 'Needs a look', data: { body: para('Words '.repeat(40)) } });
  assert.equal(made.status, 201);
  const id = made.body.entry.id;
  const sub = await writer
    .put(`/api/admin/content/entries/${id}`)
    .send({ status: 'review', version: made.body.entry.version, note: 'Ready for you' });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal(sub.body.entry.status, 'review');
  const edit = await writer
    .put(`/api/admin/content/entries/${id}`)
    .send({ title: 'Needs a look (tweaked)', version: sub.body.entry.version });
  assert.equal(edit.status, 200, 'the writer can still polish it while it waits');
  const self = await writer
    .put(`/api/admin/content/entries/${id}`)
    .send({ status: 'published', version: edit.body.entry.version });
  assert.equal(self.status, 403, 'a writer cannot approve their own work');

  const queue = await admin.get('/api/admin/content/types/post/entries?status=review');
  assert.ok(queue.body.entries.some((e) => e.id === id));
  assert.equal((await request(node.app).get(`/blog/${made.body.entry.slug}`)).status, 404);

  const back = await admin.put(`/api/admin/content/entries/${id}`).send({
    status: 'draft',
    version: edit.body.entry.version,
    note: 'Changes requested: add a source',
  });
  assert.equal(back.body.entry.status, 'draft');
  const log = await node.ctx
    .db('audit_logs')
    .where({ entity_id: String(id) })
    .select('action');
  const actions = log.map((l) => l.action);
  assert.ok(actions.includes('content.submit_review'));
  assert.ok(actions.includes('content.request_changes'));

  const again = await writer
    .put(`/api/admin/content/entries/${id}`)
    .send({ status: 'review', version: back.body.entry.version });
  const ok = await admin
    .put(`/api/admin/content/entries/${id}`)
    .send({ status: 'published', version: again.body.entry.version });
  assert.equal(ok.body.entry.status, 'published');
  assert.equal((await admin.get('/api/admin/content/summary')).body.review, 0);
});

test('autosave still refuses anything but a draft, and a review submission raises an event', async () => {
  const e = await mk('post', { title: 'Evented', data: { body: para('x') } });
  const before = await node.ctx.db('events_log').where({ name: 'content.review_requested' });
  const r = await admin
    .put(`/api/admin/content/entries/${e.id}`)
    .send({ status: 'review', version: e.version });
  assert.equal(r.status, 200);
  const after = await node.ctx.db('events_log').where({ name: 'content.review_requested' });
  assert.equal(after.length, before.length + 1);
  const auto = await admin
    .put(`/api/admin/content/entries/${e.id}`)
    .send({ title: 'Evented 2', version: r.body.entry.version, autosave: true });
  assert.equal(auto.status, 409);
});

// ───────── templates ─────────

test('built-in templates are listed; a saved one comes back, keeps only the writing, and is deleted by its maker', async () => {
  const list = (await admin.get('/api/admin/content/types/post/templates')).body.templates;
  const names = list.filter((t) => t.builtIn).map((t) => t.name);
  assert.deepEqual(names.slice(0, 2), ['Blog post', 'Case study']);
  assert.ok(list[0].data.body.blocks.length > 3);

  const saved = await admin.post('/api/admin/content/types/post/templates').send({
    name: 'Weekly update',
    description: 'Every Friday',
    data: {
      body: para('Hello <script>x</script>'),
      excerpt: 'Sum',
      seo_title: 'not kept',
      featured_image: 99,
    },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(Object.keys(saved.body.template.data).sort(), ['body', 'excerpt']);
  assert.doesNotMatch(JSON.stringify(saved.body.template.data), /script/);
  assert.equal(
    (
      await admin
        .post('/api/admin/content/types/post/templates')
        .send({ name: 'Weekly update', data: {} })
    ).status,
    409,
  );

  const other = await as('Template other', [
    'admin.access',
    'content.post.read',
    'content.post.write',
  ]);
  assert.ok(
    (await other.get('/api/admin/content/types/post/templates')).body.templates.some(
      (t) => t.name === 'Weekly update',
    ),
  );
  assert.equal(
    (await other.delete(`/api/admin/content/templates/${saved.body.template.id}`)).status,
    403,
  );
  assert.equal(
    (await admin.delete(`/api/admin/content/templates/${saved.body.template.id}`)).status,
    204,
  );
  assert.ok(
    !(await admin.get('/api/admin/content/types/post/templates')).body.templates.some(
      (t) => t.name === 'Weekly update',
    ),
  );

  const reader = await as('Template reader', ['content.post.read']);
  assert.equal((await reader.get('/api/admin/content/types/post/templates')).status, 403);
});

test('a template cannot smuggle a custom HTML block past the permission', async () => {
  const w = await as('Template writer', [
    'admin.access',
    'content.post.read',
    'content.post.write',
  ]);
  const r = await w.post('/api/admin/content/types/post/templates').send({
    name: 'Sneaky',
    data: { body: { blocks: [{ type: 'html', data: { code: '<p>x</p>' } }] } },
  });
  assert.equal(r.status, 403);
});

// ───────── markdown ─────────

test('Markdown becomes blocks; raw HTML and unsafe links stay inert', async () => {
  const blocks = markdownToBlocks(
    '---\ntitle: x\n---\n# Big\n\nSome **bold**, *italic*, `code` and [a link](https://a.example) and [bad](javascript:alert(1)) <script>x</script>\n\n- one\n- two\n\n1. first\n2. second\n\n> wise words\n\n```\nlet a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n',
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['header', 'paragraph', 'list', 'list', 'quote', 'code', 'table', 'delimiter'],
  );
  const html = renderBlocks(sanitizeBlocks({ blocks }));
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<a href="https:\/\/a\.example" rel="noopener nofollow ugc">a link<\/a>/);
  assert.doesNotMatch(html, /javascript:|<script/);
  const r = await admin.post('/api/admin/content/markdown').send({ markdown: '## Hi\n\ntext' });
  assert.deepEqual(
    r.body.blocks.map((b) => b.type),
    ['header', 'paragraph'],
  );
});

// ───────── analysis ─────────

const doc = (...blocks) => ({ blocks });
const h = (text, level = 2) => ({ type: 'header', data: { text, level } });
const p = (text) => ({ type: 'paragraph', data: { text } });
const byId = (items, id) => items.find((i) => i.id === id);

test('focus keyword checks look at the title, description, address, opening, content and subheadings', () => {
  const r = readDoc(
    doc(
      p('Learning to bake sourdough bread takes patience.'),
      h('Why sourdough bread rises'),
      p('Flour, water, salt. '.repeat(80)),
    ),
  );
  const items = keywordItems(
    {
      keyword: 'Sourdough Bread',
      title: 'A guide',
      seoTitle: 'Sourdough bread for beginners',
      description: 'Short and without it.',
      slug: 'sourdough-bread-guide',
    },
    r,
  );
  assert.equal(byId(items, 'kw-title').status, 'good');
  assert.equal(byId(items, 'kw-description').status, 'bad');
  assert.equal(byId(items, 'kw-slug').status, 'good');
  assert.equal(byId(items, 'kw-intro').status, 'good');
  assert.equal(byId(items, 'kw-heading').status, 'good');
  assert.equal(byId(items, 'kw-content').status, 'good');
  assert.equal(keywordItems({ keyword: '' }, r)[0].id, 'kw-missing');
  const stuffed = readDoc(
    doc(p('bread bread bread bread bread bread bread bread. ' + 'other words here '.repeat(8))),
  );
  assert.equal(
    byId(keywordItems({ keyword: 'bread', title: 'bread' }, stuffed), 'kw-content').status,
    'warn',
  );
});

test('heading structure: a heading 1 in the content, a skipped level, an empty heading and a long text with no subheadings', () => {
  const r = readDoc(doc(h('Second title', 1), h('Jump', 4), h('', 2), p('word '.repeat(10))));
  const ids = structureItems(r).map((i) => i.id);
  assert.deepEqual(ids.sort(), ['st-empty', 'st-h1', 'st-skip']);
  const long = readDoc(doc(p('word '.repeat(400))));
  assert.ok(byId(structureItems(long), 'st-none'));
  assert.ok(byId(structureItems(readDoc(doc(h('A'), p('short text here')))), 'st-ok'));
});

test('readability scores plain text higher than long, dense sentences and flags habits', () => {
  const easy =
    'The cat sat on the mat. It was a big cat. The dog ran to the park. We like to play. The sun is hot today. We had fun. '.repeat(
      3,
    );
  const hard =
    'Notwithstanding the aforementioned considerations regarding organisational infrastructure, the implementation of comprehensive methodological frameworks necessitates considerable interdepartmental collaboration and substantial administrative deliberation throughout the entire procedural lifecycle. '.repeat(
      3,
    );
  const a = readability(easy, [easy]);
  const b = readability(hard, [hard]);
  assert.ok(a.score > b.score + 30, `${a.score} vs ${b.score}`);
  assert.ok(byId(b.items, 'rd-long'));
  assert.equal(byId(b.items, 'rd-long').status, 'warn');
  assert.equal(readability('Too short.', []).score, null);
});

test('the analysis endpoint combines keyword, structure, readability, quality, duplicates and link suggestions', async () => {
  const other = await mk('post', {
    title: 'Sourdough starter basics',
    status: 'published',
    data: {
      body: para('A starter is flour and water left to ferment. '.repeat(15)),
      seo_description: 'How to make a sourdough starter from scratch in a week.',
    },
  });
  const text =
    'Everything begins with a sourdough starter basics lesson. ' +
    'Mix flour and water and wait. '.repeat(20);
  const r = await admin.post('/api/admin/content/types/post/analysis').send({
    title: 'Baking',
    slug: 'baking',
    data: {
      body: para(text, 'TODO add more <a href="/x">click here</a>'),
      focus_keyword: 'sourdough',
      seo_description: 'How to make a sourdough starter from scratch in a week.',
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.keyword.some((i) => i.id === 'kw-title'));
  assert.ok(byId(r.body.quality, 'q-placeholder'));
  assert.ok(byId(r.body.quality, 'q-link-text'));
  assert.ok(r.body.duplicates.some((d) => d.id === other.id && d.kind === 'seo_description'));
  assert.ok(r.body.links.some((l) => l.id === other.id && l.reason === 'mentioned'));
  assert.ok(r.body.readability.items.length);
  const none = await as('Analysis reader', ['content.post.read']);
  assert.equal(
    (await none.post('/api/admin/content/types/post/analysis').send({ title: 'x', data: {} }))
      .status,
    403,
  );
});

test('near-identical bodies and equal titles are flagged as duplicates before publishing', async () => {
  const body = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda. '.repeat(12);
  const first = await mk('post', { title: 'The original', data: { body: para(body) } });
  const r = await admin
    .post('/api/admin/content/types/post/checks')
    .send({ title: 'The original', data: { body: para(body) } });
  const d = r.body.checks.find((c) => c.id === 'duplicate-content');
  assert.ok(d, JSON.stringify(r.body.checks));
  assert.match(d.message, /same title/);
  assert.match(d.message, /text matches/);
  const self = await admin
    .post('/api/admin/content/types/post/checks')
    .send({ title: 'The original', data: { body: para(body) }, entryId: first.id });
  assert.ok(
    !self.body.checks.some((c) => c.id === 'duplicate-content'),
    'an entry is not a duplicate of itself',
  );
});

test('the link picker finds published entries by title and gives their address', async () => {
  await mk('post', {
    title: 'Zanzibar travel diary',
    status: 'published',
    data: { body: para('x') },
  });
  await mk('post', { title: 'Zanzibar secret draft', data: { body: para('x') } });
  const r = await admin.get('/api/admin/content/link-search?q=zanzibar');
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.results.map((x) => x.title),
    ['Zanzibar travel diary'],
  );
  assert.match(r.body.results[0].url, /^\/blog\/zanzibar-travel-diary/);
});

// ───────── preview links and the design ─────────

test('a preview link can last a day or a week, can be framed by the admin only, and is capped', async () => {
  const e = await mk('post', { title: 'Reviewable', data: { body: para('Words to review') } });
  const short = await admin.post(`/api/admin/content/entries/${e.id}/preview-link`).send({});
  const week = await admin
    .post(`/api/admin/content/entries/${e.id}/preview-link`)
    .send({ hours: 168 });
  assert.ok(week.body.expiresAt - short.body.expiresAt > 160 * 3600_000);
  assert.equal(
    (await admin.post(`/api/admin/content/entries/${e.id}/preview-link`).send({ hours: 169 }))
      .status,
    422,
  );
  assert.match(week.body.url, /^https?:\/\//);
  const page = await request(node.app).get(week.body.path);
  assert.equal(page.status, 200, 'a reviewer needs no sign-in');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.match(page.headers['x-robots-tag'], /noindex/);
  const live = await request(node.app).get('/');
  assert.doesNotMatch(live.headers['content-security-policy'] ?? '', /frame-ancestors 'self'/);
});

test('the editor gets the active theme’s colours and font', async () => {
  const r = await admin.get('/api/admin/content/editor-style');
  assert.equal(r.status, 200);
  assert.equal(r.body.theme, 'default');
  assert.equal(r.body.ink, '#1c2b2f');
  assert.match(r.body.fontFamily, /system-ui/);
  assert.equal(r.body.fontSize, '17px');
});
