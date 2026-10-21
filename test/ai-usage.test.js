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

test('the report is not readable without signing in', async () => {
  const res = await fetch(`${node.url}/api/admin/ai-usage/summary`);
  assert.ok([401, 403].includes(res.status), `got ${res.status}`);
});
