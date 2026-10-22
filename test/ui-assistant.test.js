import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';
import { createAssistant } from '../src/modules/assistant/service.js';

let node, b;
before(async () => {
  node = await makeNode();
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const dock = () => b.$('aside.chat-dock');
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
};

test('the assistant opens as a docked panel beside the page, and closes again', async () => {
  const fab = () => b.$('.chat-fab');
  await wait(() => fab() && fab().style.display !== 'none');
  b.click(fab());
  await wait(() => dock());
  assert.ok(b.$('.shell').classList.contains('has-chat'));
  // The admin page stays on screen next to it.
  assert.ok(b.$('main.main'));
  await wait(() => dock().querySelector('textarea'));
  b.click(dock().querySelector('[aria-label="Close the assistant"]'));
  await wait(() => !dock());
  assert.ok(!b.$('.shell').classList.contains('has-chat'));
});

test('without an API key a message shows how to fix it and keeps what was typed', async () => {
  b.click(b.$('.chat-fab'));
  await wait(() => dock() && dock().querySelector('textarea'));
  const ta = () => dock().querySelector('textarea');
  setValue(ta(), 'Build me a landing page');
  const send = () => [...dock().querySelectorAll('button')].find((x) => x.textContent === 'Send');
  await wait(() => send() && !send().disabled);
  b.click(send());
  await wait(() => /Settings → AI/.test(dock().textContent));
  assert.equal(ta().value, 'Build me a landing page');
});

test('System → Requirements shows the document with the generated inventory, and can be edited', async () => {
  b.go('#/requirements');
  const page = () => b.$('section[x-data="requirementsPage"]');
  await wait(() => page() && /Site inventory/.test(page().textContent));
  assert.match(page().querySelector('h1').textContent, /Project Requirement/);
  assert.ok([...page().querySelectorAll('button')].some((x) => x.textContent === 'Rebuild'));
  assert.ok(page().querySelector('select[aria-label="Version"]'));
  b.click([...page().querySelectorAll('button')].find((x) => x.textContent === 'Edit'));
  const ta = () => page().querySelector('textarea');
  await wait(() => ta() && ta().offsetParent !== undefined);
  setValue(ta(), '# Req\n\n## Goal\n\nSell **more**.');
  b.click([...page().querySelectorAll('button')].find((x) => x.textContent === 'Save changes'));
  await wait(() => /<strong>more<\/strong>/.test(page().querySelector('.md-doc').innerHTML));
  // Markdown is escaped first: a script tag in the document never becomes a tag.
  assert.ok(!page().querySelector('.md-doc script'));
});

test('a document cannot smuggle a script or a javascript: link', async () => {
  b.go('#/requirements');
  const page = () => b.$('section[x-data="requirementsPage"]');
  await wait(() => page() && page().querySelector('.md-doc'));
  const res = await b.win.fetch('/api/admin/assistant/requirements', {
    credentials: 'same-origin',
  });
  assert.equal(res.status, 200);
  const comp = b.win.Alpine.$data(page());
  comp.html = '';
  const md = '<script>x</script> [bad](javascript:alert(1)) [ok](/pages/a)';
  // The renderer is private to app.js; exercise it through the save/load path.
  await b.win.fetch('/api/admin/assistant/requirements', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': await csrf() },
    body: JSON.stringify({ markdown: md }),
  });
  await comp.load();
  const html = page().querySelector('.md-doc').innerHTML;
  assert.ok(!html.includes('<script'));
  assert.ok(!/href="javascript:/i.test(html));
  assert.match(html, /href="\/pages\/a"/);
});

async function csrf() {
  return (await (await b.win.fetch('/api/auth/csrf', { credentials: 'same-origin' })).json())
    .csrfToken;
}

// ───── change history (D-072) ─────

const scripted = (...responses) => ({
  messages: {
    async create() {
      return responses.shift();
    },
  },
});
const usage = { input_tokens: 10, output_tokens: 5 };
const writeCall = (path, content) => ({
  content: [
    { type: 'tool_use', id: `t_${Math.random()}`, name: 'write_file', input: { path, content } },
  ],
  stop_reason: 'tool_use',
  usage,
});
const done = { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage };

test('Change history lists a change, shows its diff, and Revert puts the site back', async () => {
  const svc = createAssistant(node.ctx, {
    client: scripted(
      writeCall('pages/ui-hist.html', '---\ntitle: "Hist"\n---\n<p>hello history</p>\n'),
      done,
    ),
  });
  const me = (await node.ctx.users.list?.())?.[0];
  const actor = { id: me?.id ?? 1, email: ADMIN.email, can: () => true };
  const s = await svc.create(actor);
  const out = await svc.sendMessage(s.id, 'add a history page', actor);

  b.go('#/history');
  const page = () => b.$('section[x-data="historyPage"]');
  await wait(() => page() && /add a history page/.test(page().textContent));
  b.go(`#/history/${out.commit.id}`);
  await wait(() => /hello history/.test(page().querySelector('.diff')?.textContent ?? ''));
  assert.ok(page().querySelector('.diff-line.dadd'), 'added lines are marked');

  window_confirm(true);
  b.click(
    [...page().querySelectorAll('button')].find((x) => /Revert this change/.test(x.textContent)),
  );
  await wait(() => /Change reverted/.test(page().textContent));
  assert.throws(() => node.ctx.siteFiles.get('pages/ui-hist.html'));
});

test('the panel lists the changes made in a chat, with a Revert button', async () => {
  const svc = createAssistant(node.ctx, {
    client: scripted(
      writeCall('pages/ui-card.html', '---\ntitle: "Card"\n---\n<p>card</p>\n'),
      done,
    ),
  });
  const actor = { id: 1, email: ADMIN.email, can: () => true };
  const s = await svc.create(actor);
  await svc.sendMessage(s.id, 'make a card page', actor);
  b.win.localStorage.setItem('assistant.session', String(s.id));
  if (dock()) {
    b.click(dock().querySelector('[aria-label="Close the assistant"]'));
    await wait(() => !dock());
  }
  b.click(b.$('.chat-fab'));
  const head = () => dock() && dock().querySelector('.cc-head');
  await wait(() => head() && /Changes in this chat/.test(head().textContent));
  // Collapsed until asked for: the list is there but hidden, and the header says how many.
  assert.equal(dock().querySelector('.cc-count').textContent, '1');
  assert.equal(head().getAttribute('aria-expanded'), 'false');
  assert.equal(dock().querySelector('.cc-body').style.display, 'none');
  b.click(head());
  await wait(() => head().getAttribute('aria-expanded') === 'true');
  assert.notEqual(dock().querySelector('.cc-body').style.display, 'none');
  assert.ok([...dock().querySelectorAll('button')].some((x) => x.textContent === 'Revert'));
  // What it changed can be seen right there, without leaving the chat.
  const showBtn = () =>
    [...dock().querySelectorAll('button')].find((x) => x.textContent === 'Diff');
  b.click(showBtn());
  await wait(() => /<p>card<\/p>/.test(dock().querySelector('.diff')?.textContent ?? ''));
  assert.ok(dock().querySelector('.diff-line.dadd'));
  await svc.history.revert((await svc.history.list({ sessionId: s.id }))[0].id, actor);
});

function window_confirm(answer) {
  b.win.confirm = () => answer;
}

test('Commit now on Change history records a hand edit', async () => {
  await node.ctx.siteFiles.put(
    'pages/ui-hand.html',
    '---\ntitle: "Hand"\n---\n<p>by hand</p>\n',
    null,
  );
  b.go('#/history');
  const page = () => b.$('section[x-data="historyPage"]');
  await wait(() => page() && page().querySelector('#hist-msg'));
  setValue(page().querySelector('#hist-msg'), 'Edited by hand');
  b.click([...page().querySelectorAll('button')].find((x) => x.textContent === 'Commit now'));
  await wait(() => /Committed \d+ file/.test(page().textContent));
  await wait(() => /Edited by hand/.test(page().textContent));
});

test('the model picker offers the configured models, saves the choice on the chat, and can go back to the default', async () => {
  const sel = () => dock() && dock().querySelector('#chat-model');
  if (!dock()) b.click(b.$('.chat-fab'));
  await wait(() => sel() && sel().options.length > 2);
  assert.match(sel().options[0].textContent, /^Default \(/);
  const sessionId = () => Number(b.win.localStorage.getItem('assistant.session'));
  await wait(() => sessionId());
  sel().value = 'claude-haiku-4-5';
  sel().dispatchEvent(new b.win.Event('change', { bubbles: true }));
  await wait(async () => {
    const r = await node.ctx.db('assistant_sessions').where({ id: sessionId() }).first();
    return r.model === 'claude-haiku-4-5';
  });
  sel().value = '';
  sel().dispatchEvent(new b.win.Event('change', { bubbles: true }));
  await wait(
    async () => !(await node.ctx.db('assistant_sessions').where({ id: sessionId() }).first()).model,
  );
});

test('a deletion the assistant asks for shows a card that needs two clicks, and the table name typed', async () => {
  const admin = await node.ctx.db('users').where({ email: ADMIN.email }).first();
  const actor = { id: admin.id, email: admin.email, can: () => true };
  await node.ctx.dbms.createTable(
    {
      name: 'cards',
      columns: [{ name: 'id', type: 'integer', primaryKey: true, autoIncrement: true }],
    },
    actor,
  );
  const usage = { input_tokens: 1, output_tokens: 1 };
  const queue = [
    {
      content: [
        {
          type: 'tool_use',
          id: 'd1',
          name: 'db_request_delete',
          input: { kind: 'table', table: 'cards' },
        },
      ],
      stop_reason: 'tool_use',
      usage,
    },
    {
      content: [{ type: 'text', text: 'Waiting for your confirmation.' }],
      stop_reason: 'end_turn',
      usage,
    },
  ];
  const svc = createAssistant(node.ctx, {
    client: { messages: { create: async () => queue.shift() } },
  });
  const s = await svc.create(actor);
  await svc.sendMessage(s.id, 'drop the cards table', actor);

  // The earlier tests left the panel open on another chat: close it, then reopen on this one.
  if (dock()) {
    b.click(dock().querySelector('[aria-label="Close the assistant"]'));
    await wait(() => !dock());
  }
  b.win.localStorage.setItem('assistant.session', String(s.id));
  b.click(b.$('.chat-fab'));
  await wait(() => dock());
  const card = () => dock().querySelector('[aria-label="Confirm a deletion"]');
  await wait(() => card() && /Delete the table "cards"/.test(card().textContent));
  const btn = (t) => [...card().querySelectorAll('button')].find((x) => x.textContent.trim() === t);
  const stage = async () => (await node.ctx.db('assistant_confirmations').first()).status;
  assert.equal(await stage(), 'pending');

  b.click(btn('Delete…'));
  await wait(async () => (await stage()) === 'first');
  await wait(() => card().querySelector('input'));
  setValue(card().querySelector('input'), 'wrong');
  b.click(card().querySelector('.btn-danger'));
  await wait(() => /Type the table name/.test(dock().textContent));
  assert.equal(await stage(), 'first');
  setValue(card().querySelector('input'), 'cards');
  b.click(card().querySelector('.btn-danger'));
  await wait(async () => (await stage()) === 'confirmed');
  assert.equal(
    await node.ctx.db.schema.hasTable('cards'),
    true,
    'the person confirmed; nothing is deleted until the assistant acts',
  );
});
