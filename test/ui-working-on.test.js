import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';
import { createAssistant } from '../src/modules/assistant/service.js';

let node, b;
before(async () => {
  node = await makeNode();
  await node.ctx.settings.update('prompts', { values: { planning: 'never_ask' } }, null);
  const me = await node.ctx.db('users').where({ email: ADMIN.email }).first();
  const actor = { id: me.id, email: me.email, can: () => true };
  const usage = { input_tokens: 1, output_tokens: 1 };
  const use = (...calls) => ({
    content: calls.map((c, i) => ({ type: 'tool_use', id: `t${i}`, name: c.name, input: c.input })),
    stop_reason: 'tool_use',
    usage,
  });
  const responses = [
    use(
      {
        name: 'write_file',
        input: { path: 'pages/about.html', content: '---\ntitle: About\n---\n<h1>About</h1>' },
      },
      { name: 'write_file', input: { path: 'components/hero.html', content: '<div>hero</div>' } },
      {
        name: 'write_file',
        input: {
          path: 'plugins/ui-demo/plugin.json',
          content: JSON.stringify({
            slug: 'ui-demo',
            name: 'UI Demo',
            version: '1.0.0',
            author: 'T',
            description: 'd',
          }),
        },
      },
    ),
    { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage },
  ];
  const svc = createAssistant(node.ctx, {
    client: { messages: { create: async () => responses.shift() } },
  });
  await svc.sendMessage((await svc.create(actor)).id, 'make things', actor);
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
});

test('the chat shows each file it touched with its kind, and a "Working on" strip names the page, component and plugin', async () => {
  const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
  b.click(b.$('.chat-fab'));
  const dock = () => b.$('aside.chat-dock');
  await wait(() => dock() && dock().querySelectorAll('.ac-working .ac-chip').length === 3);
  const chips = [...dock().querySelectorAll('.ac-working .ac-chip')].map((c) =>
    c.textContent.replace(/\s+/g, ' ').trim(),
  );
  assert.ok(
    chips.some((t) => /^Page about\.html$/.test(t)),
    chips.join('|'),
  );
  assert.ok(
    chips.some((t) => /^Component hero\.html$/.test(t)),
    chips.join('|'),
  );
  assert.ok(
    chips.some((t) => /^Plugin · ui-demo plugin\.json$/.test(t)),
    chips.join('|'),
  );
  const lines = [...dock().querySelectorAll('.ac-tool')].map((t) => t.textContent);
  assert.ok(lines.some((t) => /Wrote a file.*Plugin.*plugins\/ui-demo\/plugin\.json/.test(t)));
  assert.equal(dock().querySelector('.ac-working .ac-chip[href="#/plugins"]') !== null, true);
});

test('the "Working on" strip folds away to its title and count, and opens again', async () => {
  const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
  const dock = () => b.$('aside.chat-dock');
  const chipCount = () => dock().querySelectorAll('.ac-working .ac-chip').length;
  if (!dock()) b.click(b.$('.chat-fab'));
  await wait(() => dock() && chipCount() === 3);
  const toggle = () => dock().querySelector('.ac-working-toggle');
  assert.equal(toggle().textContent.replace(/\s+/g, ' ').trim(), 'Working on 3');
  b.click(toggle());
  await wait(() => chipCount() === 0);
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  b.click(toggle());
  await wait(() => chipCount() === 3);
});
