import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import { createAiComponentWriter } from '../src/modules/site/component-ai.js';

let node;
let admin;
/** Every request the fake Claude saw, and the replies it will give next (first in, first out). */
const seen = [];
const replies = [];
const fakeClient = {
  messages: {
    async create(params) {
      seen.push(params);
      return { content: [{ type: 'text', text: replies.shift() ?? 'NAME: card\n\n<p>Hi</p>' }] };
    },
  },
};

const GOOD = `NAME: pricing_table

<script type="application/json" data-cms="meta">{"title":"Pricing table","props":{"heading":{"type":"string","default":"Simple pricing"}}}</script>
<style>
  :host { display: block; }
  h2 { color: var(--ink, #1c2b2f); }
</style>
<section><h2>{{ heading | default: "Simple pricing" }}</h2></section>`;

before(async () => {
  node = await makeNode();
  node.ctx.aiComponentWriter = createAiComponentWriter(node.ctx, { client: fakeClient });
  admin = await signedIn(node.app);
});
after(() => node.close());

const generate = (body) => admin.post('/api/admin/site/components/generate').send(body);

test('Write it with AI: the component is saved under the name the AI chose, and it parses', async () => {
  replies.push(GOOD);
  const r = await generate({ description: 'A pricing table with three plans' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'pricing_table');
  const saved = node.ctx.siteFiles.get('components/pricing_table.html').content;
  assert.match(saved, /data-cms="meta"/);
  assert.match(saved, /<section>/);
  assert.doesNotMatch(saved, /^NAME:/m);
  assert.match(seen.at(-1).messages[0].content, /pricing table with three plans/);
});

test('A name that is taken is not overwritten: the new one gets a number', async () => {
  replies.push(GOOD);
  const r = await generate({ description: 'A pricing table with three plans' });
  assert.equal(r.body.name, 'pricing_table_2');
  assert.ok(node.ctx.siteFiles.get('components/pricing_table.html'));
});

test('A name given by the person wins over the AI’s, and a code fence round the reply is tolerated', async () => {
  replies.push('```html\n' + GOOD + '\n```');
  const r = await generate({ description: 'A pricing table with three plans', name: 'my_prices' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'my_prices');
});

test('A refused file is sent back once with the reason, and the corrected one is saved', async () => {
  replies.push('NAME: broken\n\n<p>{% if %}</p>', 'NAME: fixed_one\n\n<p>ok</p>');
  const before = seen.length;
  const r = await generate({ description: 'Something that first comes out wrong' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'fixed_one');
  assert.equal(seen.length - before, 2);
  assert.match(seen.at(-1).messages.at(-1).content, /refused/);
  assert.equal(
    node.ctx.siteFiles.list('components/').some((f) => f.path === 'components/broken.html'),
    false,
  );
});

test('If the AI keeps sending something invalid nothing is saved, and the message says what to do', async () => {
  const count = node.ctx.siteFiles.list('components/').length;
  replies.push('NAME: bad\n\n<p>{% if %}</p>', 'NAME: bad\n\n<p>{% if %}</p>');
  const r = await generate({ description: 'Something that never comes out right' });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /blank component/);
  assert.equal(node.ctx.siteFiles.list('components/').length, count);
});

test('A too-short description and a bad name are refused before any AI call', async () => {
  const calls = seen.length;
  assert.equal((await generate({ description: 'hero' })).status, 422);
  assert.equal(
    (await generate({ description: 'A perfectly fine description', name: 'Bad Name' })).status,
    422,
  );
  assert.equal(seen.length, calls);
});

test('Without an API key the person is told where to set one', async () => {
  const w = createAiComponentWriter(node.ctx);
  await assert.rejects(
    () => w.generate({ description: 'A pricing table with three plans' }),
    /Settings → AI/,
  );
});

test('Only people who can write components may use it', async () => {
  const role = await node.ctx.users.createRole(
    { name: 'reader', description: '', permissions: ['admin.access', 'components.read'] },
    null,
  );
  await node.ctx.users.createUser(
    { email: 'r@example.com', name: 'R', password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  const reader = await signedIn(node.app, {
    email: 'r@example.com',
    password: 'Some-long-pass-12',
  });
  const r = await reader
    .post('/api/admin/site/components/generate')
    .send({ description: 'A pricing table with three plans' });
  assert.equal(r.status, 403);
});
