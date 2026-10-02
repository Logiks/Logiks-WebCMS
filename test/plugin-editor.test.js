import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeNode, signedIn } from './helpers.js';
import { createPluginEditor } from '../src/modules/plugin-editor/service.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

/** A queue of canned Anthropic responses, consumed in order — never touches the real paid API. */
const fakeClient = (responses) => ({
  messages: {
    async create() {
      if (!responses.length) throw new Error('fakeClient: ran out of canned responses');
      return responses.shift();
    },
  },
});
const text = (t, stop = 'end_turn') => ({
  content: [{ type: 'text', text: t }],
  stop_reason: stop,
});
const toolUse = (calls) => ({
  content: calls.map((c) => ({
    type: 'tool_use',
    id: `toolu_${c.name}`,
    name: c.name,
    input: c.input,
  })),
  stop_reason: 'tool_use',
});
/** Point a session's editor at a stub client instead of the real Anthropic API. */
const withClient = (responses) =>
  createPluginEditor(node.ctx, { pluginsDir: node.env.PLUGINS_DIR, client: fakeClient(responses) });

const VALID_MANIFEST = JSON.stringify({
  slug: 'chat-demo',
  name: 'Chat Demo',
  version: '1.0.0',
  author: 'Test',
  description: 'Made via the editor.',
});

describe('settings: the ai namespace', () => {
  test('test_connection requires an API key', async () => {
    const out = await node.ctx.settings.runTest('ai', 'connect', {}, null);
    assert.equal(out.ok, false);
    assert.match(out.message, /api key/i);
  });
});

describe('permissions', () => {
  test('plugins.manage is required for every route', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'NoEditor', permissions: ['admin.access'] },
      null,
    );
    const email = 'noeditor@example.com';
    await node.ctx.users.createUser(
      { email, name: 'No Editor', password: 'Correct-Horse-9', roleId: role.id },
      null,
    );
    const other = await signedIn(node.app, { email, password: 'Correct-Horse-9' });
    assert.equal((await other.get('/api/admin/plugin-editor/sessions')).status, 403);
    assert.equal((await other.post('/api/admin/plugin-editor/sessions').send({})).status, 403);
  });
});

// routes.js destructures `ctx.pluginEditor` once when the app is built, so swapping the property afterwards
// never reaches the route; these tests exercise the service directly instead (admin.id comes from the session's
// own creator for the audit-log actor, which is all the service needs — it doesn't touch req/res).
const actor = { id: null, email: 'admin@example.com' };

describe('a chat session', () => {
  test('a valid write_file establishes the slug and persists the full transcript', async () => {
    const editor = withClient([
      toolUse([{ name: 'write_file', input: { path: 'plugin.json', content: VALID_MANIFEST } }]),
      text('Created the chat-demo plugin.'),
    ]);
    const created = await editor.create({}, actor);

    const out = await editor.sendMessage(
      created.id,
      'Make a tiny demo plugin called chat-demo.',
      actor,
    );
    assert.equal(out.session.slug, 'chat-demo');

    const dir = path.join(node.env.PLUGINS_DIR, 'chat-demo');
    assert.equal(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'), VALID_MANIFEST);

    const full = await editor.get(created.id);
    // user text, assistant tool_use, user tool_result, assistant final text
    assert.equal(full.messages.length, 4);
    assert.equal(full.messages[0].role, 'user');
    assert.equal(full.messages[2].content[0].is_error, undefined);
  });

  test('an invalid write is rejected (is_error tool_result) and nothing is written, while a valid sibling write still lands', async () => {
    const editor = withClient([
      toolUse([
        {
          name: 'write_file',
          input: {
            path: 'plugin.json',
            content: VALID_MANIFEST.replace('chat-demo', 'chat-demo-2'),
          },
        },
        { name: 'write_file', input: { path: 'plugin.js', content: 'export default 42;' } }, // not a function: dryRun rejects it
      ]),
      text('Done, though plugin.js needs fixing.'),
    ]);
    const created = await editor.create({}, actor);
    const out = await editor.sendMessage(created.id, 'Make another demo plugin.', actor);
    assert.equal(out.session.slug, 'chat-demo-2');

    const dir = path.join(node.env.PLUGINS_DIR, 'chat-demo-2');
    assert.ok(fs.existsSync(path.join(dir, 'plugin.json')));
    assert.equal(fs.existsSync(path.join(dir, 'plugin.js')), false);

    const full = await editor.get(created.id);
    const toolResultMsg = full.messages.find((m) => m.content?.[0]?.type === 'tool_result');
    const errorResult = toolResultMsg.content.find((c) => c.is_error);
    assert.ok(errorResult, 'the invalid write should have produced an is_error tool_result');
    assert.match(errorResult.content, /default export/i);
  });

  test('sessions list and resuming a session round-trip', async () => {
    const editor = withClient([]);
    const created = await editor.create({}, actor);
    const list = await editor.list();
    assert.ok(list.some((s) => s.id === created.id));
    const resumed = await editor.get(created.id);
    assert.equal(resumed.session.id, created.id);
    assert.deepEqual(resumed.messages, []);
  });

  // Regression: a real bug reported live — "Edit with AI" for a plugin that already has a session (e.g. clicked a
  // second time after navigating away and back) threw a raw "UNIQUE constraint failed: plugin_editor_sessions.slug"
  // instead of reopening the existing chat.
  test('creating a session for a plugin that already has one resumes it instead of throwing', async () => {
    fs.mkdirSync(path.join(node.env.PLUGINS_DIR, 'edit-twice'), { recursive: true });
    const editor = withClient([]);
    const first = await editor.create({ slug: 'edit-twice' }, actor);
    const second = await editor.create({ slug: 'edit-twice' }, actor);
    assert.equal(second.id, first.id);
    const rows = await node.ctx.db('plugin_editor_sessions').where({ slug: 'edit-twice' });
    assert.equal(rows.length, 1);
  });

  test('over HTTP: creating a session and fetching it works end to end (no AI call needed for these)', async () => {
    const created = await admin.post('/api/admin/plugin-editor/sessions').send({});
    assert.equal(created.status, 201);
    const got = await admin.get(`/api/admin/plugin-editor/sessions/${created.body.session.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.session.id, created.body.session.id);
  });
});
