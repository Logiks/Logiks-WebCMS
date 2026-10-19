import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import { createAssistant, compactHistory } from '../src/modules/assistant/service.js';
import { parseSections } from '../src/modules/assistant/requirements.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(async () => {
  await node.close();
});

/** Canned Anthropic responses, consumed in order, and a record of every request made — never the real paid API. */
const fakeClient = (responses) => {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(JSON.parse(JSON.stringify(req)));
        if (!responses.length) throw new Error('fakeClient: out of responses');
        return responses.shift();
      },
    },
  };
};
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 };
const say = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage });
const callTools = (...calls) => ({
  content: calls.map((c, i) => ({
    type: 'tool_use',
    id: `toolu_${i}_${c.name}`,
    name: c.name,
    input: c.input ?? {},
  })),
  stop_reason: 'tool_use',
  usage,
});
const withClient = (responses) => {
  const client = fakeClient(responses);
  return { client, svc: createAssistant(node.ctx, { client }) };
};
const adm = { id: 1, email: 'admin@example.com', can: () => true };
const only = (...perms) => ({ id: 2, email: 'x@example.com', can: (p) => perms.includes(p) });

describe('requirements document', () => {
  test('a section is added, replaced and removed without touching the others', async () => {
    const r = node.ctx.assistant.requirements;
    await r.setSection('Audience', 'Small shops.', adm);
    await r.setSection('Goals', 'Sell more.', adm);
    await r.setSection('audience', 'Small shops in Odisha.', adm); // heading match ignores case
    let doc = parseSections((await r.get()).authored);
    assert.deepEqual(
      doc.sections.map((s) => [s.heading, s.body]),
      [
        ['Audience', 'Small shops in Odisha.'],
        ['Goals', 'Sell more.'],
      ],
    );
    await r.setSection('Goals', '', adm);
    doc = parseSections((await r.get()).authored);
    assert.deepEqual(
      doc.sections.map((s) => s.heading),
      ['Audience'],
    );
  });

  test('the inventory is generated from the live site, not stored', async () => {
    const got = await node.ctx.assistant.requirements.get();
    assert.match(got.markdown, /## Site inventory/);
    assert.match(got.inventory, /Pages \(\d+\)/);
    assert.ok(!got.authored.includes('Site inventory'));
  });
});

describe('the chat loop', () => {
  test('answers, stores the turn, counts tokens and titles the chat', async () => {
    const { svc, client } = withClient([say('Hello.')]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'Hi there', adm);
    assert.equal(out.session.title, 'Hi there');
    assert.deepEqual(out.session.usage, { input: 100, output: 20, cacheRead: 80 });
    const got = await svc.get(s.id, adm);
    assert.deepEqual(
      got.messages.map((m) => m.role),
      ['user', 'assistant'],
    );
    // The static prefix is marked cacheable.
    assert.equal(client.calls[0].system[0].cache_control.type, 'ephemeral');
    assert.ok(client.calls[0].tools.some((t) => t.cache_control));
  });

  test('a tool call updates the requirements and its result goes back to the model', async () => {
    const { svc, client } = withClient([
      callTools({
        name: 'update_requirements',
        input: { heading: 'Look and feel', body: 'Calm, green.' },
      }),
      say('Noted.'),
    ]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'We want it calm and green', adm);
    const doc = await node.ctx.assistant.requirements.section('Look and feel');
    assert.equal(doc.body, 'Calm, green.');
    const second = client.calls[1].messages.at(-1);
    assert.equal(second.content[0].type, 'tool_result');
    assert.ok(!second.content[0].is_error);
  });

  test('a tool the person may not use fails for the model, not silently', async () => {
    const { svc, client } = withClient([
      callTools({ name: 'update_requirements', input: { heading: 'X', body: 'y' } }),
      say('I cannot.'),
    ]);
    const s = await svc.create(only('admin.access'));
    await svc.sendMessage(s.id, 'write it down', only('admin.access'));
    const res = client.calls[1].messages.at(-1).content[0];
    assert.equal(res.is_error, true);
    assert.match(res.content, /requirements\.write/);
  });

  test('read_file returns a slice and refuses paths outside the site tree', async () => {
    const path = node.ctx.siteFiles.list('pages/')[0].path;
    const { svc, client } = withClient([
      callTools(
        { name: 'read_file', input: { path, limit: 2 } },
        { name: 'read_file', input: { path: '../x' } },
      ),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'look', adm);
    const [ok, bad] = client.calls[1].messages.at(-1).content;
    assert.equal(JSON.parse(ok.content).to <= 2, true);
    assert.equal(bad.is_error, true);
  });

  test('a chat is private to the person who started it', async () => {
    const { svc } = withClient([]);
    const s = await svc.create(adm);
    const stranger = { ...only('admin.access'), id: 99 };
    await assert.rejects(svc.get(s.id, stranger), /not found|doesn.t exist|That chat/i);
    assert.equal((await svc.list(stranger)).length, 0);
  });

  test('a second message while one is running is refused, and the lock is released afterwards', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const client = {
      messages: {
        async create() {
          await gate;
          return say('done');
        },
      },
    };
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    const first = svc.sendMessage(s.id, 'one', adm);
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(svc.sendMessage(s.id, 'two', adm), (e) => e.status === 409);
    release();
    await first;
    await svc.sendMessage(s.id, 'three', adm); // lock freed
  });

  test('a failed model call still stores the turn and frees the chat', async () => {
    const svc = createAssistant(node.ctx, {
      client: {
        messages: {
          async create() {
            throw new Error('boom');
          },
        },
      },
    });
    const s = await svc.create(adm);
    await assert.rejects(svc.sendMessage(s.id, 'hello', adm), (e) => e.status === 502);
    const got = await svc.get(s.id, adm);
    assert.deepEqual(
      got.messages.map((m) => m.role),
      ['user'],
    );
    const ok = createAssistant(node.ctx, { client: fakeClient([say('fine')]) });
    await ok.sendMessage(s.id, 'again', adm);
  });
});

describe('token thrift', () => {
  const big = 'x'.repeat(5000);
  const turn = (n) => [
    { role: 'user', content: `q${n}` },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${n}`, name: 'read_file', input: {} }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: big }] },
    { role: 'assistant', content: [{ type: 'text', text: `a${n}` }] },
  ];

  test('earlier tool results shrink, the current turn stays whole', () => {
    const msgs = [...turn(1), ...turn(2)];
    const out = compactHistory(msgs, 4);
    assert.ok(out[2].content[0].content.length < 300);
    const current = compactHistory(
      [...msgs.slice(0, 4), { role: 'user', content: 'now' }, ...turn(3).slice(1)],
      4,
    );
    assert.equal(current.at(-2).content[0].content.length, 5000);
  });

  test('only the most recent turns are resent, and the history still starts on a user turn', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => turn(i)).flat();
    const out = compactHistory(msgs, msgs.length);
    assert.equal(out[0].content, 'q4');
    assert.equal(out.filter((m) => typeof m.content === 'string').length, 8);
  });

  test('a long tool result is cut before it is stored', async () => {
    const huge = 'line\n'.repeat(5000);
    node.ctx.siteFiles.snapshot(); // sanity: the tree is loaded
    const path = 'pages/assistant-huge.html';
    await node.ctx.siteFiles.put(path, `---\ntitle: Huge\n---\n${huge}`, null);
    const { svc, client } = withClient([
      callTools({ name: 'read_file', input: { path, limit: 400 } }),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'read it', adm);
    const res = client.calls[1].messages.at(-1).content[0].content;
    assert.ok(res.length <= 8200);
    await node.ctx.siteFiles.remove(path, null);
  });
});

describe('replies that run out of room', () => {
  const cut = (content) => ({ content, stop_reason: 'max_tokens', usage });
  const text = (t) => ({ type: 'text', text: t });
  const half = { type: 'tool_use', id: 'toolu_cut', name: 'write_file', input: {} };
  const stored = async (svc, id) => (await svc.get(id, adm)).messages;
  const page = (title) => `---\ntitle: "${title}"\n---\n<p>${title}</p>\n`;

  test('there is room for a whole page in one reply', async () => {
    const { svc, client } = withClient([say('ok')]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'hi', adm);
    assert.ok(
      client.calls[0].max_tokens >= 16000,
      `room for a whole page: ${client.calls[0].max_tokens}`,
    );
  });

  test('a reply that is cut off is continued by the assistant, not by the person', async () => {
    const { svc, client } = withClient([
      cut([text('First half of the answer')]),
      say('and the second half.'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'explain', adm);
    assert.equal(client.calls.length, 2);
    const last = client.calls[1].messages;
    assert.match(last.at(-1).content, /^\[auto\] Your reply was cut off/);
    assert.equal(last.at(-2).content[0].text, 'First half of the answer');
    const all = JSON.stringify(out.messages);
    assert.ok(!all.includes('cut short'), 'the person is not asked to do anything');
    assert.equal((await stored(svc, s.id)).length, 4);
  });

  test('a tool call cut off half way is dropped and redone in smaller steps', async () => {
    const { svc, client } = withClient([
      cut([half]),
      callTools({
        name: 'write_file',
        input: { path: 'pages/ast-big-1.html', content: page('Part one') },
      }),
      say('done'),
    ]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'build a big page', adm);
    const nudge = client.calls[1].messages.at(-1).content;
    assert.match(nudge, /cut off before it finished, so it changed nothing/);
    assert.match(nudge, /smaller steps/);
    // The broken call is not in what is sent back (it could never be answered), so the conversation stays valid.
    assert.ok(!JSON.stringify(client.calls[1].messages).includes('toolu_cut'));
    assert.ok(node.ctx.siteFiles.get('pages/ast-big-1.html'));
    await node.ctx.siteFiles.remove('pages/ast-big-1.html', null);
  });

  test('it gives up after three tries, and then says so', async () => {
    const { svc, client } = withClient([
      cut([text('a')]),
      cut([text('b')]),
      cut([text('c')]),
      cut([text('d')]),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'endless', adm);
    assert.equal(client.calls.length, 4);
    assert.match(JSON.stringify(out.messages.at(-1)), /cut short/);
  });

  test('the nudges are never shown and never start a new turn', async () => {
    const { svc } = withClient([cut([text('x')]), say('y')]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'one', adm);
    const msgs = await stored(svc, s.id);
    const autos = msgs.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith('[auto] '),
    );
    assert.equal(autos.length, 1);
    // Ten real turns plus their nudges still count as ten turns when deciding what to resend.
    const history = [];
    for (let i = 0; i < 10; i++)
      history.push(
        { role: 'user', content: `q${i}` },
        { role: 'assistant', content: [text('a')] },
        { role: 'user', content: '[auto] Continue exactly where you stopped.' },
        { role: 'assistant', content: [text('b')] },
      );
    const out = compactHistory(history, history.length);
    assert.equal(
      out.filter((m) => typeof m.content === 'string' && !m.content.startsWith('[auto]')).length,
      8,
    );
  });
});

describe('long replies are streamed (the SDK refuses a long non-streaming request)', () => {
  // The real SDK, with only the network replaced: this is the exact failure ("Streaming is required for operations
  // that may take longer than 10 minutes") that a large output cap causes if requests are not streamed.
  const sse = (text) =>
    [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            model: 'x',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
      ],
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]
      .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
      .join('');

  test('a real SDK client completes an assistant turn at the configured output cap', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const sent = [];
    const client = new Anthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return new globalThis.Response(sse('Hello from a streamed reply'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'hi', adm);
    assert.equal(sent.length, 1, 'the request actually went out');
    assert.equal(sent[0].stream, true);
    assert.ok(sent[0].max_tokens > 21_000 ? sent[0].stream : true);
    assert.match(JSON.stringify(out.messages), /Hello from a streamed reply/);
    assert.equal(out.session.usage.output, 3);
  });

  test('a client that can stream is streamed; one that cannot is called normally', async () => {
    const calls = [];
    const streaming = {
      messages: {
        stream: (params) => {
          calls.push(['stream', params.max_tokens]);
          return { finalMessage: async () => say('streamed') };
        },
        create: async () => {
          throw new Error('create must not be used when streaming is available');
        },
      },
    };
    const svc = createAssistant(node.ctx, { client: streaming });
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'hi', adm);
    assert.equal(calls.length, 1);
    const { svc: plain, client } = withClient([say('plain')]);
    const s2 = await plain.create(adm);
    await plain.sendMessage(s2.id, 'hi', adm);
    assert.equal(client.calls.length, 1);
  });
});

describe('choosing the model', () => {
  test('a chat uses its own model when one is chosen, otherwise the installation default', async () => {
    const { svc, client } = withClient([say('a'), say('b'), say('c')]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'one', adm);
    await svc.setModel(s.id, 'claude-haiku-4-5', adm);
    await svc.sendMessage(s.id, 'two', adm);
    await svc.setModel(s.id, '', adm); // back to the default
    await svc.sendMessage(s.id, 'three', adm);
    assert.equal(client.calls[0].model, svc.models().default);
    assert.equal(client.calls[1].model, 'claude-haiku-4-5');
    assert.equal(client.calls[2].model, svc.models().default);
  });

  test('only models offered under Settings → AI can be chosen', async () => {
    const { svc } = withClient([]);
    const s = await svc.create(adm);
    await assert.rejects(svc.setModel(s.id, 'gpt-nonsense', adm), (e) => e.status === 422);
    assert.ok(svc.models().options.length >= 2);
    assert.ok(
      svc.models().options.every((o) => !/\(/.test(o.label)),
      'labels are short',
    );
  });

  test('over HTTP: list the models, choose one for a chat, and it is private to its owner', async () => {
    const list = (await admin.get('/api/admin/assistant/models')).body;
    assert.ok(list.default && list.options.length);
    const s = (await admin.post('/api/admin/assistant/sessions')).body.session;
    const res = await admin
      .put(`/api/admin/assistant/sessions/${s.id}`)
      .send({ model: list.options.at(-1).value });
    assert.equal(res.body.session.model, list.options.at(-1).value);
    assert.equal(
      (await admin.put(`/api/admin/assistant/sessions/${s.id}`).send({ model: 'nope' })).status,
      422,
    );
    assert.equal((await admin.put(`/api/admin/assistant/sessions/${s.id}`).send({})).status, 422);
  });
});

describe('HTTP', () => {
  test('without an API key the chat explains what to do', async () => {
    const s = (await admin.post('/api/admin/assistant/sessions')).body.session;
    const res = await admin
      .post(`/api/admin/assistant/sessions/${s.id}/messages`)
      .send({ text: 'hi' });
    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /Settings → AI/);
  });

  test('sessions can be listed, renamed and deleted', async () => {
    const s = (await admin.post('/api/admin/assistant/sessions')).body.session;
    assert.ok(
      (await admin.get('/api/admin/assistant/sessions')).body.sessions.some((x) => x.id === s.id),
    );
    const renamed = await admin
      .put(`/api/admin/assistant/sessions/${s.id}`)
      .send({ title: 'Plan' });
    assert.equal(renamed.body.session.title, 'Plan');
    assert.equal((await admin.delete(`/api/admin/assistant/sessions/${s.id}`)).status, 204);
    assert.equal((await admin.get(`/api/admin/assistant/sessions/${s.id}`)).status, 404);
  });

  test('requirements need their own permissions; the chat needs only admin access', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'ChatOnly', permissions: ['admin.access'] },
      null,
    );
    const email = 'chatonly@example.com';
    await node.ctx.users.createUser(
      { email, name: 'Chat Only', password: 'Correct-Horse-9', roleId: role.id },
      null,
    );
    const other = await signedIn(node.app, { email, password: 'Correct-Horse-9' });
    assert.equal((await other.post('/api/admin/assistant/sessions')).status, 201);
    assert.equal((await other.get('/api/admin/assistant/requirements')).status, 403);
    assert.equal(
      (await other.put('/api/admin/assistant/requirements').send({ markdown: '# x' })).status,
      403,
    );
  });

  test('the requirements document can be edited by hand and read back', async () => {
    const put = await admin
      .put('/api/admin/assistant/requirements')
      .send({ markdown: '# Req\n\n## Goal\n\nSell.' });
    assert.equal(put.status, 200);
    const got = (await admin.get('/api/admin/assistant/requirements')).body;
    assert.match(got.markdown, /## Goal/);
    assert.match(got.markdown, /## Site inventory/);
  });
});
