import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';
import { createAssistant, focusText } from '../src/modules/assistant/service.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const adm = { id: 1, email: 'admin@example.com', can: () => true };
const only = (...perms) => ({ id: 2, email: 'x@example.com', can: (p) => perms.includes(p) });
const usage = { input_tokens: 1, output_tokens: 1 };
const fake = () => {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(JSON.parse(JSON.stringify(req)));
        return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage };
      },
    },
  };
};

describe('pinning a chat', () => {
  test('a pin is stored, shown on the session, and cleared with an empty value', async () => {
    const svc = node.ctx.assistant;
    const s = await svc.create(adm);
    assert.equal(s.focus, null);
    assert.equal((await svc.setFocus(s.id, 'pages/about.html', adm)).focus, 'pages/about.html');
    assert.equal((await svc.setFocus(s.id, 'plugins/hello-ai/', adm)).focus, 'plugins/hello-ai');
    assert.equal((await svc.setFocus(s.id, '', adm)).focus, null);
  });

  test('over HTTP, and a path that is not a document is refused', async () => {
    const { session } = (await admin.post('/api/admin/assistant/sessions').send({})).body;
    const ok = await admin
      .put(`/api/admin/assistant/sessions/${session.id}`)
      .send({ focus: 'components/hero.html' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.session.focus, 'components/hero.html');
    const bad = await admin
      .put(`/api/admin/assistant/sessions/${session.id}`)
      .send({ focus: '../etc/passwd' });
    assert.equal(bad.status, 422);
  });

  test('you cannot pin something you may not read', async () => {
    const svc = node.ctx.assistant;
    const p = only('admin.access');
    const s = await svc.create(p);
    await assert.rejects(svc.setFocus(s.id, 'plugins/hello-ai', p), /plugins\.manage/);
    await assert.rejects(svc.setFocus(s.id, 'pages/a.html', p), /pages\.read/);
  });

  test('the model is told what the chat is pinned to, outside the cached block', async () => {
    const client = fake();
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    await svc.setFocus(s.id, 'pages/about.html', adm);
    await svc.sendMessage(s.id, 'make the heading bigger', adm);
    const sys = client.calls[0].system;
    assert.equal(sys[0].cache_control.type, 'ephemeral');
    assert.ok(!sys[0].text.includes('pinned'));
    assert.match(sys[1].text, /pinned this chat to the page pages\/about\.html/);
    assert.match(sys[1].text, /"This page"/);

    const free = await svc.create(adm);
    await svc.sendMessage(free.id, 'hello', adm);
    assert.equal(client.calls[1].system.length, 1);
  });

  test('wording for each kind', () => {
    assert.match(focusText('plugins/shop'), /the plugin "shop".*list_plugin_files/);
    assert.match(focusText('components/hero.html'), /the component components\/hero\.html/);
    assert.match(focusText('menus/main.json'), /the document menus\/main\.json/);
  });
});

describe('Ask the assistant from a screen', () => {
  test('the button on a page pins the chat and the panel shows what it is focused on', async () => {
    await node.ctx.siteFiles.put('pages/focus-me.html', '---\ntitle: Focus me\n---\n<h1>Hi</h1>', {
      id: null,
      email: null,
      can: () => true,
    });
    const b = await openAdmin(node.url);
    try {
      await b.signIn(ADMIN.email, ADMIN.password);
      const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
      b.go('#/pages');
      await wait(() => b.$('section[x-data="pagesList"] tbody tr'));
      const row = () =>
        [...b.$$('section[x-data="pagesList"] tbody tr')].find((r) =>
          r.textContent.includes('focus-me'),
        );
      await wait(() => row());
      b.click(row().querySelector('button[aria-label="Ask the assistant about this page"]'));
      await wait(() => b.$('aside.chat-dock .ac-chip-focus'));
      assert.match(b.$('aside.chat-dock .ac-chip-focus').textContent, /Page\s+focus-me\.html/);
      const sess = await node.ctx.db('assistant_sessions').orderBy('id', 'desc').first();
      assert.equal(sess.focus, 'pages/focus-me.html');
      // The clear button unpins.
      b.click(b.$('aside.chat-dock button[aria-label="Stop focusing on this"]'));
      await wait(
        async () => !(await node.ctx.db('assistant_sessions').where({ id: sess.id }).first()).focus,
      );
    } finally {
      b.close();
    }
  });

  test('with an earlier conversation open, the button starts a new chat instead of pinning that one', async () => {
    const root = { id: null, email: null, can: () => true };
    await node.ctx.siteFiles.put(
      'pages/fresh-chat.html',
      '---\ntitle: Fresh\n---\n<h1>Hi</h1>',
      root,
    );
    const old = await node.ctx.db('assistant_sessions').orderBy('id', 'desc').first();
    await node.ctx.db('assistant_messages').insert({
      session_id: old.id,
      role: 'user',
      content: 'something about another page',
      created_at: Date.now(),
    });
    const before = await node.ctx.db('assistant_sessions').count({ n: '*' }).first();
    const b = await openAdmin(node.url);
    try {
      await b.signIn(ADMIN.email, ADMIN.password);
      const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
      b.go('#/pages');
      const row = () =>
        [...b.$$('section[x-data="pagesList"] tbody tr')].find((r) =>
          r.textContent.includes('fresh-chat'),
        );
      await wait(() => row());
      b.click(row().querySelector('button[aria-label="Ask the assistant about this page"]'));
      await wait(() => b.$('aside.chat-dock .ac-chip-focus'));
      const latest = await node.ctx.db('assistant_sessions').orderBy('id', 'desc').first();
      assert.notEqual(latest.id, old.id, 'a new chat was started');
      assert.equal(latest.focus, 'pages/fresh-chat.html');
      assert.equal(
        (await node.ctx.db('assistant_sessions').where({ id: old.id }).first()).focus ===
          'pages/fresh-chat.html',
        false,
        'the earlier chat keeps its own context',
      );
      assert.equal(
        Number((await node.ctx.db('assistant_sessions').count({ n: '*' }).first()).n),
        Number(before.n) + 1,
      );
    } finally {
      b.close();
    }
  });
});

describe('blank chats are reused', () => {
  test('creating a chat while an empty one exists returns that one, without its old focus', async () => {
    const svc = createAssistant(node.ctx, { client: fake() });
    const a = await svc.create(adm);
    await svc.setFocus(a.id, 'pages/about.html', adm);
    const b = await svc.create(adm);
    assert.equal(b.id, a.id);
    assert.ok(!b.focus);
  });
});
