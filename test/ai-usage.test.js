import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const reply = (model, usage) => ({ model, usage, content: [{ type: 'text', text: 'hi' }] });

test('a wrapped Anthropic client logs each call with its model, tokens and feature', async () => {
  const fake = {
    messages: {
      create: async (p) =>
        reply(p.model, {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 7,
        }),
    },
  };
  const client = node.ctx.aiUsage.wrap(fake, { feature: 'assistant', userId: null });
  const res = await client.messages.create({ model: 'claude-test-1', messages: [] });
  assert.equal(res.content[0].text, 'hi'); // the caller still gets the real reply
  const row = await node.ctx.db('ai_usage_log').where({ model: 'claude-test-1' }).first();
  assert.equal(row.provider, 'anthropic');
  assert.equal(row.feature, 'assistant');
  assert.equal(Number(row.input_tokens), 12); // cache writes bill as input
  assert.equal(Number(row.output_tokens), 4);
  assert.equal(Number(row.cache_read_tokens), 7);
  assert.equal(!!row.ok, true);
});

test('a failed call is logged as failed and the error still reaches the caller', async () => {
  const fake = {
    messages: {
      create: async () => {
        throw new Error('boom');
      },
    },
  };
  const client = node.ctx.aiUsage.wrap(fake, { feature: 'seo' });
  await assert.rejects(client.messages.create({ model: 'claude-fail', messages: [] }), /boom/);
  const row = await node.ctx.db('ai_usage_log').where({ model: 'claude-fail' }).first();
  assert.equal(!!row.ok, false);
});

test('a streamed call is logged when it finishes', async () => {
  const fake = {
    messages: {
      stream: () => ({
        finalMessage: async () => reply('claude-stream', { input_tokens: 5, output_tokens: 6 }),
      }),
    },
  };
  const client = node.ctx.aiUsage.wrap(fake, { feature: 'page-designer' });
  await client.messages.stream({ model: 'claude-stream' }).finalMessage();
  assert.equal(
    (await node.ctx.db('ai_usage_log').where({ model: 'claude-stream' }).first()).feature,
    'page-designer',
  );
});

test('the report groups by provider and model, and image providers count images', async () => {
  await node.ctx.aiUsage.record({
    provider: 'openai',
    model: 'gpt-image-1',
    feature: 'media-generator',
    units: 1,
  });
  const r = await admin.get('/api/admin/ai-usage/summary');
  assert.equal(r.status, 200);
  assert.ok(r.body.total.calls >= 4);
  assert.ok(
    r.body.byModel.some(
      (m) => m.provider === 'openai' && m.model === 'gpt-image-1' && m.units === 1,
    ),
  );
  assert.ok(r.body.byModel.some((m) => m.provider === 'anthropic' && m.model === 'claude-test-1'));
  const recent = await admin.get('/api/admin/ai-usage/recent?provider=openai');
  assert.deepEqual([...new Set(recent.body.calls.map((c) => c.provider))], ['openai']);
});

test('a date range works on both the summary and the recent list', async () => {
  // Both queries join `users`, which has its own created_at: the range filter must be qualified.
  const from = Date.now() - 60_000;
  const s = await admin.get(`/api/admin/ai-usage/summary?kind=text&from=${from}`);
  assert.equal(s.status, 200);
  const r = await admin.get(
    `/api/admin/ai-usage/recent?kind=text&limit=50&from=${from}&to=${Date.now() + 60_000}`,
  );
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.calls));
});

test('one message that took several calls shows once, with its total tokens', async () => {
  const uid = (await node.ctx.db('users').first()).id;
  const fake = {
    messages: {
      create: async (p) => reply(p.model, { input_tokens: 100, output_tokens: 10 }),
    },
  };
  const client = node.ctx.aiUsage.wrap(fake, { feature: 'assistant', userId: uid });
  const ask = { role: 'user', content: 'Build me a pricing page' };
  const toolResult = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
  };
  // the tool loop re-sends the same message with tool results behind it, then a hidden continuation
  await client.messages.create({ model: 'claude-turn', messages: [ask] });
  await client.messages.create({ model: 'claude-turn', messages: [ask, toolResult] });
  await client.messages.create({
    model: 'claude-turn',
    messages: [ask, toolResult, { role: 'user', content: '[auto] continue' }],
  });
  // the same words sent again later are a second message
  await client.messages.create({ model: 'claude-turn', messages: [ask, ask] });

  const r = await admin.get('/api/admin/ai-usage/messages');
  assert.equal(r.status, 200);
  const mine = r.body.messages.filter((m) => m.prompt === 'Build me a pricing page');
  assert.deepEqual(mine.map((m) => m.calls).sort(), [1, 3]);
  const big = mine.find((m) => m.calls === 3);
  assert.equal(big.input, 300);
  assert.equal(big.output, 30);
  assert.equal(big.feature, 'assistant');
  assert.ok(big.email);

  const s = await admin.get('/api/admin/ai-usage/summary?period=month');
  const row = s.body.byUserPeriod.find((x) => x.userId === uid);
  assert.match(row.period, /^\d{4}-\d{2}$/);
  assert.ok(row.input >= 400);
});

test('the report is not readable without signing in', async () => {
  const res = await fetch(`${node.url}/api/admin/ai-usage/summary`);
  assert.ok([401, 403].includes(res.status), `got ${res.status}`);
});
