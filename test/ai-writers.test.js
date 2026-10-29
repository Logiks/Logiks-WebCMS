import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import { createAiPageWriter } from '../src/modules/site/page-ai.js';
import { createAiServiceWriter } from '../src/modules/services/ai.js';
import { createAiSeoWriter } from '../src/modules/seo/ai.js';

let node;
let admin;
const seen = [];
const replies = [];
const fakeClient = {
  messages: {
    async create(p) {
      seen.push(p);
      return { content: [{ type: 'text', text: replies.shift() ?? '{}' }] };
    },
  },
};

before(async () => {
  node = await makeNode();
  const c = { client: fakeClient };
  node.ctx.aiPageWriter = createAiPageWriter(node.ctx, c);
  node.ctx.aiServiceWriter = createAiServiceWriter(node.ctx, c);
  node.ctx.aiSeoWriter = createAiSeoWriter(node.ctx, c);
  admin = await signedIn(node.app);
});
after(() => node.close());

const PAGE = `ADDRESS: about

---
title: About the bakery
description: Our story and what we bake.
---
<h1>{{ 'about.h' | t: 'About us' }}</h1>
{% render "cta" %}`;

test('Pages: the AI writes a page that renders existing components; it is saved at its address', async () => {
  replies.push(PAGE);
  const r = await admin
    .post('/api/admin/site/pages/generate')
    .send({ description: 'An about page for a family bakery' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.address, 'about');
  assert.match(node.ctx.siteFiles.get('pages/about.html').content, /title: About the bakery/);
  assert.match(
    JSON.stringify(seen.at(-1).system),
    /- cta/,
    'the AI is told which components exist',
  );
  assert.equal((await admin.get('/about')).status, 200);
});

test('Pages: an address that is taken is refused before any AI call; an AI-chosen one gets a number', async () => {
  const calls = seen.length;
  const r = await admin
    .post('/api/admin/site/pages/generate')
    .send({ description: 'Another about page', address: 'about' });
  assert.equal(r.status, 409);
  assert.equal(seen.length, calls);
  replies.push(PAGE);
  const r2 = await admin
    .post('/api/admin/site/pages/generate')
    .send({ description: 'Another about page' });
  assert.equal(r2.body.address, 'about-2');
});

test('Pages: rendering a component that does not exist is sent back, then saved once fixed', async () => {
  replies.push(
    'ADDRESS: shop\n\n---\ntitle: Shop\n---\n{% render "no_such" %}',
    'ADDRESS: shop\n\n---\ntitle: Shop\n---\n<h1>Shop</h1>',
  );
  const n = seen.length;
  const r = await admin
    .post('/api/admin/site/pages/generate')
    .send({ description: 'A shop landing page' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(seen.length - n, 2);
  assert.match(seen.at(-1).messages.at(-1).content, /no_such/);
});

test('Services: a query Service over a real content type is created switched OFF', async () => {
  replies.push(
    JSON.stringify({
      slug: 'Latest News',
      name: 'Latest news',
      type: 'post',
      sort: 'newest',
      perPageDefault: 6,
      perPageMax: 24,
      fields: ['excerpt', 'nope'],
    }),
  );
  const r = await admin
    .post('/api/admin/services/generate')
    .send({ description: 'The latest 6 blog posts' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const s = (await admin.get(`/api/admin/services/${r.body.slug}`)).body;
  assert.equal(s.mode, 'query');
  assert.equal(s.enabled, false);
  assert.equal(s.config.type, 'post');
  assert.equal(s.config.perPage.max, 24);
  assert.deepEqual(s.config.fields, ['excerpt'], 'unknown fields are dropped');
});

test('Services: an invented content type is refused with the real ones named', async () => {
  replies.push(JSON.stringify({ slug: 'x-y', name: 'X', type: 'unicorn' }));
  const r = await admin
    .post('/api/admin/services/generate')
    .send({ description: 'List all the unicorns please' });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /post/);
});

test('SEO: suggestions come from the page text and are NOT saved', async () => {
  replies.push(
    JSON.stringify({
      title: 'About the bakery',
      description: 'How a family bakery began and what it bakes each morning.',
      type: 'website',
      twitterCard: 'summary',
      ldJson: [{ '@context': 'https://schema.org', '@type': 'Bakery' }, { nope: 1 }],
    }),
  );
  const before = (await admin.get('/api/admin/seo/rules')).body.rules.length;
  const r = await admin.post('/api/admin/seo/suggest').send({ pattern: '/about' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.title, 'About the bakery');
  assert.equal(r.body.readPage, true);
  assert.equal(r.body.ldJson.length, 1, 'JSON-LD without an @type is dropped');
  assert.match(seen.at(-1).messages[0].content, /About us|bakery/i);
  assert.equal((await admin.get('/api/admin/seo/rules')).body.rules.length, before);
});

test('SEO: a wildcard with no hint has nothing to read, and says so', async () => {
  const r = await admin.post('/api/admin/seo/suggest').send({ pattern: '/blog/*' });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /what the page is about/);
});

test('Without an API key the person is told where to set one', async () => {
  const w = createAiSeoWriter(node.ctx);
  await assert.rejects(() => w.suggest({ pattern: '/x', hint: 'a page about x' }), /Settings → AI/);
});

test('A role that cannot write pages, services or SEO is refused all three', async () => {
  const role = await node.ctx.users.createRole(
    {
      name: 'viewer',
      description: '',
      permissions: ['admin.access', 'pages.read', 'services.read', 'seo.read'],
    },
    null,
  );
  await node.ctx.users.createUser(
    { email: 'v@example.com', name: 'V', password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  const v = await signedIn(node.app, { email: 'v@example.com', password: 'Some-long-pass-12' });
  for (const u of ['/site/pages/generate', '/services/generate', '/seo/suggest'])
    assert.equal(
      (await v.post(`/api/admin${u}`).send({ description: 'A long enough text', pattern: '/a' }))
        .status,
      403,
      u,
    );
});
