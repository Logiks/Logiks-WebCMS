import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { JSDOM } from 'jsdom';
import { makeNode, until } from './helpers.js';

let node;
const body = (...t) => ({ blocks: t.map((text) => ({ type: 'paragraph', data: { text } })) });
const publish = (title, text, extra = {}) =>
  node.ctx.content.create(
    extra.type ?? 'page',
    { title, status: 'published', data: { body: body(text), ...(extra.data ?? {}) } },
    null,
  );
const find = async (q, opts = {}) =>
  (await node.ctx.search.query({ q, locale: 'en', limit: 10, ...opts })).results.map(
    (r) => r.title,
  );

before(async () => {
  node = await makeNode();
});
after(() => node.close());

test('published content is searchable straight away, ranked by relevance, with matching prefixes', async () => {
  await publish(
    'Rocket science basics',
    'A rocket needs fuel. Rocket engines burn fuel to make thrust; every rocket is a controlled explosion.',
  );
  await publish('Gardening notes', 'Tomatoes like sun. Once we saw a rocket in the garden.');
  await publish('Budget planning', 'Quarterly budget numbers for the finance team.');
  assert.deepEqual(
    await find('rocket'),
    ['Rocket science basics', 'Gardening notes'],
    'the page about rockets ranks above the passing mention',
  );
  assert.deepEqual(await find('budg'), ['Budget planning'], 'a prefix finds the word');
  assert.deepEqual(
    await find('QUARTERLY  budget'),
    ['Budget planning'],
    'case and spacing do not matter; all words must match',
  );
  assert.deepEqual(await find('rocket tomatoes'), ['Gardening notes']);
  assert.deepEqual(await find('nonexistentword'), []);
  const r = await node.ctx.search.query({ q: 'tomatoes', locale: 'en' });
  assert.match(r.results[0].excerpt, /Tomatoes like sun/);
  assert.equal(r.total, 1);
  assert.equal(r.results[0].path, 'gardening-notes');
});

test('titles and text in other fields are searched too, and non-English letters work', async () => {
  await publish('Café menu', 'Fresh coffee', {
    type: 'post',
    data: { excerpt: 'Seasonal specials at the café counter' },
  });
  assert.deepEqual(await find('café'), ['Café menu']);
  assert.deepEqual(await find('specials'), ['Café menu']);
  assert.deepEqual(await find('coffee'), ['Café menu']);
});

test('editing, unpublishing, archiving, scheduling and deleting keep the index in step', async () => {
  const e = await publish('Lifecycle piece', 'unicorn sightings reported');
  assert.deepEqual(await find('unicorn'), ['Lifecycle piece']);
  await node.ctx.content.update(e.id, { data: { body: body('dragon sightings reported') } }, null);
  assert.deepEqual(await find('unicorn'), []);
  assert.deepEqual(await find('dragon'), ['Lifecycle piece']);
  await node.ctx.content.update(e.id, { status: 'draft' }, null);
  assert.deepEqual(await find('dragon'), [], 'drafts are not searchable');
  await node.ctx.content.update(e.id, { status: 'published' }, null);
  assert.deepEqual(await find('dragon'), ['Lifecycle piece']);
  await node.ctx.content.update(e.id, { status: 'archived' }, null);
  assert.deepEqual(await find('dragon'), []);

  const s = await node.ctx.content.create(
    'post',
    {
      title: 'Timed release',
      status: 'scheduled',
      publishAt: Date.now() + 150,
      data: { body: body('phoenix arrival') },
    },
    null,
  );
  assert.deepEqual(await find('phoenix'), [], 'not yet');
  await new Promise((r) => setTimeout(r, 250));
  await node.ctx.content.publishDue();
  assert.deepEqual(await find('phoenix'), ['Timed release']);
  await node.ctx.content.remove(s.id, null);
  assert.deepEqual(await find('phoenix'), []);
});

test('search syntax typed by a visitor is just words: no errors, no injection, on any database', async () => {
  const attacks = [
    '"',
    '""',
    '*',
    '-',
    '+',
    '(',
    ')',
    'rocket OR budget',
    'rocket AND NOT budget',
    'NEAR(rocket budget)',
    'title:rocket',
    "'; DROP TABLE entries; --",
    '" OR 1=1 --',
    'rocket*"',
    '\\',
    'a'.repeat(500),
    '{}[]<>|',
    '%_',
    '\u0000',
    'rocket\n\nbudget',
    '😀😀',
  ];
  for (const q of attacks) {
    const r = await node.ctx.search.query({ q, locale: 'en', limit: 10 });
    assert.ok(Array.isArray(r.results), JSON.stringify(q));
  }
  assert.deepEqual(
    await find('rocket OR budget'),
    [],
    'OR is a word, not an operator: nothing contains both "or" and the others',
  );
  assert.ok(
    (await node.ctx.db('entries').count({ n: '*' }).first()).n > 0,
    'and the tables are still there',
  );
  assert.deepEqual(await find(''), []);
  assert.deepEqual(await find('   '), []);
});

test('the index can be rebuilt from published content, and only that', async () => {
  await node.ctx.db('search_index').del();
  if (node.ctx.dialect.kind === 'sqlite') await node.ctx.db.raw('DELETE FROM search_fts');
  assert.deepEqual(await find('rocket'), []);
  const n = await node.ctx.search.reindex();
  assert.ok(n >= 4);
  assert.deepEqual(await find('rocket'), ['Rocket science basics', 'Gardening notes']);
  assert.deepEqual(await find('dragon'), [], 'archived content is not indexed');
  // Delete one row by hand so the job's own effect is observable, and wait for it: local-mode jobs fire on a later
  // tick (never awaited by enqueue() itself), and a still-running background reindex must not leak into the next
  // test — see the dedicated race test right after this one, which needs a clean, single-source-of-concurrency start.
  await node.ctx.db('search_index').where({ entry_id: 1 }).del();
  assert.equal(
    await node.ctx.jobs.enqueue('search.reindex', {}).then(() => true),
    true,
    'and there is a job for it',
  );
  await until(() => node.ctx.db('search_index').where({ entry_id: 1 }).first().then(Boolean));
});

test('reindexing never shows a partially-rebuilt index to a concurrent search (D-033 follow-up)', async () => {
  // Found for real on MySQL: the previous job enqueued above runs in the background (local-mode jobs fire on a
  // later tick, never awaited here), racing this test's own queries against its del()-then-reinsert-one-by-one
  // reindex. Enough entries that the rebuild isn't one instant round trip, so a poll running alongside it has a
  // real chance to land mid-rebuild.
  for (let i = 1; i <= 20; i++) await publish(`Batch entry ${i}`, 'marmot burrow census');
  // find()'s own default limit is 10 (right for the small fixtures elsewhere in this file); ask the service directly here.
  assert.equal((await node.ctx.search.query({ q: 'marmot', locale: 'en', limit: 50 })).total, 20);

  let polling = true;
  const totals = [];
  const poll = (async () => {
    while (polling)
      totals.push((await node.ctx.search.query({ q: 'marmot', locale: 'en', limit: 50 })).total);
  })();
  await node.ctx.search.reindex();
  polling = false;
  await poll;

  assert.ok(totals.length > 0, 'the poll loop actually ran during the reindex');
  assert.ok(
    totals.every((t) => t === 20),
    `a concurrent search saw a partially-rebuilt index: ${[...new Set(totals)]}`,
  );
});

test('the /search page lists results, escapes what was typed, is never cached, and is rate limited', async () => {
  const r = await request(node.app).get('/search?q=rocket');
  assert.equal(r.status, 200);
  const d = new JSDOM(r.text).window.document;
  assert.deepEqual(
    [...d.querySelectorAll('main ol li a')].map((a) => a.textContent),
    ['Rocket science basics', 'Gardening notes'],
  );
  assert.equal(d.querySelector('main ol li a').getAttribute('href'), '/rocket-science-basics');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(r.text, /noindex/);
  assert.equal(d.querySelector('input[name="q"]').value, 'rocket');

  const xss = await request(node.app).get(
    '/search?q=' + encodeURIComponent('"><script>alert(1)</script>'),
  );
  assert.equal(xss.status, 200);
  assert.equal(
    new JSDOM(xss.text).window.document.querySelectorAll(
      'script:not([type]):not([data-cms="analytics"])',
    ).length,
    0,
  );
  assert.match(xss.text, /Nothing matched/);

  assert.match((await request(node.app).get('/search')).text, /Type something/);
  assert.equal((await request(node.app).get('/search?q=' + 'x'.repeat(5000))).status, 200);

  const n = await makeNode();
  try {
    await n.ctx.settings.update('security', { values: { rate_limit_per_minute: 10 } });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await request(n.app).get('/search?q=x')).status);
    assert.deepEqual(codes, [...Array(10).fill(200), 429, 429]);
  } finally {
    await n.close();
  }
});

test('search pages paginate', async () => {
  for (let i = 1; i <= 12; i++) await publish(`Zebra report ${i}`, 'zebra herd movement');
  await node.ctx.settings.update('site', { values: { posts_per_page: 5 } });
  const first = new JSDOM((await request(node.app).get('/search?q=zebra')).text).window.document;
  assert.equal(first.querySelectorAll('main ol li').length, 5);
  assert.match(first.querySelector('nav[aria-label="Pages"]').textContent, /1 \/ 3/);
  const next = first.querySelector('a[rel="next"]').getAttribute('href');
  assert.equal(next, '?q=zebra&page=2', 'the search words survive paging');
  const last = new JSDOM((await request(node.app).get('/search?q=zebra&page=3')).text).window
    .document;
  assert.equal(last.querySelectorAll('main ol li').length, 2);
  assert.equal(last.querySelector('a[rel="next"]'), null);
  await node.ctx.settings.update('site', { reset: ['posts_per_page'] });
});
