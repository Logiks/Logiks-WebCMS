import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeNode, signedIn } from './helpers.js';
import { FEATURES } from '../src/modules/aigov/features.js';
import { missingStatements } from '../src/modules/aigov/statement.js';
import { toOpenAI, fromOpenAI } from '../src/modules/aigov/translate.js';
import { compactText, redact, redactParams, jsonValid } from '../src/modules/aigov/text.js';

/** A fake server. `handler(req, body)` returns [status, json]; every request it saw is kept in `seen`. */
function fakeServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, headers: req.headers, body });
      const [status, json] = server.handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  server.handler = handler;
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        seen,
        url: `http://127.0.0.1:${server.address().port}`,
        set: (h) => (server.handler = h),
        close: () => server.close(),
      }),
    ),
  );
}

const openaiAnswer = (text, extra = {}) => [
  200,
  {
    id: 'x',
    model: 'local-model',
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    ...extra,
  },
];
const claudeAnswer = (text, model = 'claude-test') => ({
  model,
  usage: { input_tokens: 100, output_tokens: 20 },
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
});

let node, admin, local, cloud, claude;
let defaultCalls;
const set = (ns, values) => node.ctx.settings.update(ns, { values }, null, { internal: true });
const ask = (feature, opts = {}, params = {}) =>
  node.ctx.aigov.client({ feature, injected: claude, ...opts }).messages.create({
    model: 'claude-main',
    max_tokens: 500,
    system: 'Be brief.',
    messages: [{ role: 'user', content: 'hello' }],
    ...params,
  });
const addLocal = (over = {}) =>
  node.ctx.aigov.saveProfile(
    {
      name: 'ollama',
      provider: 'openai-compatible',
      base_url: `${local.url}/v1`,
      model: 'llama3.1:8b',
      ...over,
    },
    null,
  );

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  local = await fakeServer(() => openaiAnswer('local says hi'));
  cloud = await fakeServer(() => [
    200,
    claudeAnswer('fake anthropic says hi', 'claude-via-server'),
  ]);
});
after(async () => {
  local.close();
  cloud.close();
  await node.close();
});
beforeEach(async () => {
  defaultCalls = [];
  claude = {
    messages: {
      create: async (p) => {
        defaultCalls.push(p);
        return claudeAnswer('claude says hi', p.model);
      },
    },
  };
  local.set(() => openaiAnswer('local says hi'));
  local.seen.length = 0;
  await node.ctx.aigov.resetRoutes(null);
  await set('ai', {
    profiles: [],
    daily_token_cap: 0,
    monthly_token_cap: 0,
    daily_cost_cap: 0,
    monthly_cost_cap: 0,
    default_price_in: 0,
    default_price_out: 0,
  });
  await node.ctx.db('ai_usage_log').delete();
});

test('with no routes every task uses Claude exactly as before (the shipped state)', async () => {
  const res = await ask('translations');
  assert.equal(res.content[0].text, 'claude says hi');
  assert.equal(defaultCalls.length, 1);
  assert.equal(defaultCalls[0].model, 'claude-main'); // the caller's model, untouched
  const row = await node.ctx.db('ai_usage_log').first();
  assert.equal(row.profile, 'default');
  assert.equal(!!row.is_local, false);
  assert.ok(res.usage_id); // every result carries its usage id
});

test('a routed task goes to the local model first and never touches Claude when it answers', async () => {
  await addLocal();
  await node.ctx.aigov.saveRoutes({ translations: ['ollama', 'default'] }, null);
  const res = await ask('translations');
  assert.equal(res.content[0].text, 'local says hi');
  assert.equal(defaultCalls.length, 0);
  assert.equal(local.seen[0].body.model, 'llama3.1:8b'); // the profile's model wins over the caller's
  assert.equal(local.seen[0].body.messages[0].content, 'Be brief.');
  const row = await node.ctx.db('ai_usage_log').first();
  assert.equal(row.profile, 'ollama');
  assert.equal(!!row.is_local, true);
});

test('a failing local model falls back to Claude with the SAME request', async () => {
  await addLocal();
  await node.ctx.aigov.saveRoutes({ translations: ['ollama', 'default'] }, null);
  local.set(() => [500, { error: 'boom' }]);
  const res = await ask('translations');
  assert.equal(res.content[0].text, 'claude says hi');
  assert.equal(defaultCalls.length, 1);
  // what the fallback was sent is what the local model was sent
  assert.equal(defaultCalls[0].messages[0].content, local.seen[0].body.messages[1].content);
  assert.equal(defaultCalls[0].system, 'Be brief.');
  const rows = await node.ctx.db('ai_usage_log').orderBy('id');
  assert.deepEqual(
    rows.map((r) => [r.profile, !!r.ok]),
    [
      ['ollama', false],
      ['default', true],
    ],
  );
});

test('an answer that fails validation counts as unusable and falls back', async () => {
  await addLocal();
  await node.ctx.aigov.saveRoutes({ seo: ['ollama', 'default'] }, null);
  local.set(() => openaiAnswer('no json here'));
  claude.messages.create = async (p) => claudeAnswer('{"title":"ok"}', p.model);
  const res = await ask('seo', { validate: node.ctx.aigov.jsonValid });
  assert.equal(res.content[0].text, '{"title":"ok"}');
  const local1 = await node.ctx.db('ai_usage_log').where({ profile: 'ollama' }).first();
  assert.equal(!!local1.usable, false);
});

test('a routed task never silently uses the default model: it fails loudly', async () => {
  await addLocal();
  await node.ctx.aigov.saveRoutes({ translations: ['ollama'] }, null);
  local.set(() => [503, { error: 'down' }]);
  await assert.rejects(ask('translations'), (e) => {
    assert.equal(e.code, 'ai_no_route');
    assert.match(e.message, /ollama failed/);
    assert.match(e.message, /reset this task to Claude/);
    return true;
  });
  assert.equal(defaultCalls.length, 0);
});

test('tools are translated both ways, and bad tool arguments make the profile unusable', async () => {
  const params = {
    max_tokens: 100,
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    tools: [
      { name: 'read_help', description: 'd', input_schema: { type: 'object', properties: {} } },
    ],
    messages: [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_help', input: { a: 1 } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
    ],
  };
  const body = toOpenAI(params, 'm');
  assert.equal(body.messages[0].content, 'sys');
  assert.equal(body.tools[0].function.name, 'read_help');
  assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"a":1}');
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 't1', content: 'result' });
  const back = fromOpenAI(
    {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [{ id: 'c', function: { name: 'read_help', arguments: '{"x":2}' } }],
          },
        },
      ],
    },
    'm',
  );
  assert.equal(back.stop_reason, 'tool_use');
  assert.deepEqual(back.content[0].input, { x: 2 });
  assert.throws(
    () =>
      fromOpenAI(
        {
          choices: [
            { message: { tool_calls: [{ id: 'c', function: { name: 'n', arguments: '{oops' } }] } },
          ],
        },
        'm',
      ),
    /not JSON/,
  );
});

test('a task that needs tools cannot be routed to a profile without them, and is skipped if it changes later', async () => {
  await addLocal({ tools: false });
  await assert.rejects(
    node.ctx.aigov.saveRoutes({ 'assistant.help': ['ollama'] }, null),
    /needs tools/,
  );
  await node.ctx.aigov.saveRoutes({ translations: ['ollama', 'default'] }, null);
  const res = await ask(
    'translations',
    {},
    { tools: [{ name: 'x', input_schema: { type: 'object' } }] },
  );
  assert.equal(res.content[0].text, 'claude says hi'); // skipped the no-tools profile, fell to Claude
  assert.equal(local.seen.length, 0);
});

test('caps count only cloud usage, and local models keep working past them', async () => {
  await addLocal();
  await set('ai', { daily_token_cap: 100 });
  await ask('translations'); // 120 tokens of cloud use
  await assert.rejects(ask('translations'), (e) => e.code === 'ai_cap_reached');
  await node.ctx.aigov.saveRoutes({ translations: ['ollama'] }, null);
  const res = await ask('translations');
  assert.equal(res.content[0].text, 'local says hi');
  // heavy local use did not count towards the cap
  const spend = await node.ctx.aigov.spendNow();
  assert.equal(spend.day.tokens, 120);
});

test('the AI_DISABLED switch (environment only) stops every call', async () => {
  const off = await makeNode({ env: { AI_DISABLED: '1' } });
  try {
    let called = 0;
    const injected = {
      messages: {
        create: async () => {
          called++;
          return claudeAnswer('x');
        },
      },
    };
    await assert.rejects(
      off.ctx.aigov
        .client({ feature: 'translations', injected })
        .messages.create({ max_tokens: 5, messages: [] }),
      (e) => e.status === 503 && e.code === 'ai_disabled',
    );
    assert.equal(called, 0);
    const page = await (await signedIn(off.app)).get('/api/admin/aigov');
    assert.equal(page.body.disabled, true);
  } finally {
    await off.close();
  }
});

test('a profile key is sealed, never returned, and sent as a bearer token', async () => {
  await addLocal({ api_key: 'sk-local-secret-123456' });
  const stored = node.ctx.settings.get('ai.profiles')[0];
  assert.match(stored.api_key_enc, /^enc:v1:/);
  assert.ok(!JSON.stringify(stored).includes('sk-local-secret-123456'));
  const page = await admin.get('/api/admin/aigov');
  assert.equal(page.status, 200);
  assert.ok(!JSON.stringify(page.body).includes('sk-local-secret-123456'));
  assert.equal(page.body.profiles.find((p) => p.name === 'ollama').hasKey, true);
  await node.ctx.aigov.saveRoutes({ translations: ['ollama'] }, null);
  await ask('translations');
  assert.equal(local.seen[0].headers.authorization, 'Bearer sk-local-secret-123456');
  // saving again without a key keeps the stored one
  await addLocal({ model: 'other' });
  assert.equal(node.ctx.settings.get('ai.profiles')[0].api_key_enc, stored.api_key_enc);
});

test('an Anthropic profile can point at another Anthropic-compatible server', async () => {
  await node.ctx.aigov.saveProfile(
    {
      name: 'gateway',
      provider: 'anthropic',
      base_url: cloud.url,
      model: 'claude-haiku-x',
      api_key: 'sk-ant-fake-key-000000000000',
    },
    null,
  );
  await node.ctx.aigov.saveRoutes({ seo: ['gateway'] }, null);
  const res = await ask('seo');
  assert.equal(res.content[0].text, 'fake anthropic says hi');
  assert.equal(cloud.seen[0].url, '/v1/messages');
  assert.equal(cloud.seen[0].body.model, 'claude-haiku-x');
  assert.equal(cloud.seen[0].headers['x-api-key'], 'sk-ant-fake-key-000000000000');
});

test('secrets in a request are masked before it leaves, for every provider', async () => {
  await addLocal();
  await node.ctx.aigov.saveRoutes({ translations: ['ollama'] }, null);
  await ask(
    'translations',
    {},
    {
      messages: [
        {
          role: 'user',
          content: 'key sk-ant-abcdefghijklmnopqrstuvwxyz and enc:v1:abc:def:ghi:jkl',
        },
      ],
    },
  );
  const sent = JSON.stringify(local.seen[0].body);
  assert.ok(!sent.includes('sk-ant-abc') && !sent.includes('enc:v1'));
  assert.match(sent, /\[hidden\]/);
  assert.equal(redactParams({ a: 'plain text that is fine' }).a, 'plain text that is fine');
});

test('an approved maximum cost is a hard ceiling and is never retried', async () => {
  await set('ai', { default_price_in: 3, default_price_out: 15 });
  await assert.rejects(
    ask('translations', { maxCost: 0.0001 }, { max_tokens: 100_000 }),
    (e) => e.code === 'ai_cost_ceiling',
  );
  assert.equal(defaultCalls.length, 0);
});

test('plan sends nothing and says which profiles could answer', async () => {
  await addLocal();
  await node.ctx.aigov.saveRoutes({ translations: ['ollama', 'default'] }, null);
  const plan = await node.ctx.aigov.plan(
    { feature: 'translations' },
    { max_tokens: 100, messages: [] },
  );
  assert.equal(plan.routed, true);
  assert.deepEqual(
    plan.steps.map((s) => [s.profile, s.usable]),
    [
      ['ollama', true],
      ['default', false],
    ],
  );
  assert.equal(local.seen.length, 0);
});

test('the report: observed quality only, and "saved" counts only usable local calls', async () => {
  await addLocal();
  await set('ai', { default_price_in: 3, default_price_out: 15 });
  await node.ctx.aigov.saveRoutes({ seo: ['ollama', 'default'] }, null);
  claude.messages.create = async (p) => claudeAnswer('{"title":"claude"}', p.model);
  await ask('seo'); // no validator, so any non-empty local answer is usable
  local.set(() => openaiAnswer('{"title":"fine"}'));
  await ask('seo', { validate: node.ctx.aigov.jsonValid }); // local ok and usable
  const rep = await node.ctx.aigov.report();
  const localRow = rep.rows.find((r) => r.feature === 'seo' && r.profile === 'ollama');
  assert.equal(localRow.calls, 2);
  assert.equal(localRow.quality, 100); // first call had no validator, so it was usable by the default check
  assert.ok(rep.totals.savedEstimate > 0);
  assert.equal(localRow.cost, 0);
  const empty = await node.ctx.aigov.report({ from: Date.now() + 1e9 });
  assert.equal(empty.rows.length, 0); // no calls, no invented score
  // a bad answer lowers it
  local.set(() => openaiAnswer('plain words'));
  await ask('seo', { validate: node.ctx.aigov.jsonValid });
  const after = (await node.ctx.aigov.report()).rows.find((r) => r.profile === 'ollama');
  assert.ok(after.quality < 100);
  // thumbs: once rated, they carry 60%
  const id = (await node.ctx.db('ai_usage_log').where({ profile: 'ollama' }).first()).id;
  await node.ctx.aigov.rate(id, -1);
  const rated = (await node.ctx.aigov.report()).rows.find((r) => r.profile === 'ollama');
  assert.ok(rated.quality < after.quality);
});

test('one click sends every task back to Claude, and only an administrator may do it', async () => {
  await addLocal();
  const r1 = await admin.post('/api/admin/aigov/routes/recommended').send({ profile: 'ollama' });
  assert.equal(r1.status, 200);
  assert.ok(Object.keys(r1.body.routes).length >= 3);
  assert.ok(!('assistant' in r1.body.routes) && !('page-designer' in r1.body.routes)); // heavy tasks untouched
  assert.deepEqual(r1.body.routes.translations, ['ollama', 'default']);
  const r2 = await admin.post('/api/admin/aigov/routes/reset').send({});
  assert.deepEqual(r2.body.routes, {});
  assert.deepEqual(node.ctx.aigov.routes(), {});
  const anon = await fetch(`${node.url}/api/admin/aigov`);
  assert.equal(anon.status, 401);
});

test('Test connection reaches a local server and says whether it supports tools', async () => {
  const ok = await admin.post('/api/admin/aigov/profiles/ollama/test').send({
    draft: {
      provider: 'openai-compatible',
      base_url: `${local.url}/v1`,
      model: 'm',
      is_local: true,
    },
  });
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.toolsOk, false); // the fake answers with plain text, not a tool call
  local.set(() => [404, {}]);
  const bad = await admin.post('/api/admin/aigov/profiles/ollama/test').send({
    draft: { provider: 'openai-compatible', base_url: `${local.url}/v1`, model: 'm' },
  });
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.message, /Check the address/);
});

test('a profile that is on a route cannot be deleted', async () => {
  await addLocal();
  await node.ctx.aigov.saveRoutes({ translations: ['ollama'] }, null);
  await assert.rejects(
    node.ctx.aigov.deleteProfile('ollama', null),
    /Remove it from the routing table/,
  );
});

test('helpers: compaction is idempotent, JSON is detected, secrets are masked', () => {
  const messy = `a   \n\n\n\n b ${'='.repeat(40)}\r\n${'x'.repeat(300)}`;
  for (const max of [50, 8000]) {
    const once = compactText(messy, max);
    assert.equal(compactText(once, max), once);
    assert.ok(once.length <= max);
  }
  assert.ok(jsonValid('Sure: {"a":1}') && !jsonValid('{oops') && !jsonValid('none'));
  assert.equal(redact('Bearer abcdefghijklmnopqrstuvwxyz0123'), '[hidden]');
});

test('every AI task is in the data statement, and nothing outside the gateway calls a provider', () => {
  assert.deepEqual(missingStatements(), []);
  assert.ok(FEATURES.length >= 10);
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && !p.includes(`${path.sep}aigov${path.sep}`)) {
        const s = fs.readFileSync(p, 'utf8');
        if (
          /new Anthropic\(|api\.anthropic\.com|api\.openai\.com\/v1\/(chat|responses)|11434/.test(s)
        )
          bad.push(p);
      }
    }
  };
  walk(path.join(import.meta.dirname, '..', 'src'));
  // ai-models only lists model names (not a model call); media-generator makes images, not text.
  assert.deepEqual(
    bad.filter((p) => !p.includes('ai-models')),
    [],
  );
});
