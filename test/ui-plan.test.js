import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';
import { createAssistant } from '../src/modules/assistant/service.js';

let node, b, sessionId;
before(async () => {
  node = await makeNode();
  const me = await node.ctx.db('users').where({ email: ADMIN.email }).first();
  const actor = { id: me.id, email: me.email, can: () => true };
  const usage = { input_tokens: 1, output_tokens: 1 };
  const responses = [
    {
      content: [
        {
          type: 'tool_use',
          id: 'tp1',
          name: 'propose_plan',
          input: {
            title: 'Bakery site',
            summary: 'A small bakery.',
            assumptions: ['English only'],
            pages: [{ path: '/menu', purpose: 'What we bake' }],
            design: 'Warm and simple.',
          },
        },
      ],
      stop_reason: 'tool_use',
      usage,
    },
    {
      content: [{ type: 'text', text: 'Waiting for your decision.' }],
      stop_reason: 'end_turn',
      usage,
    },
  ];
  const svc = createAssistant(node.ctx, {
    client: { messages: { create: async () => responses.shift() } },
  });
  sessionId = (await svc.create(actor)).id;
  await svc.sendMessage(sessionId, 'Build me a bakery site', actor);
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const dock = () => b.$('aside.chat-dock');

test('a proposed plan is a card with the assumptions and pages, and Approve records the decision', async () => {
  b.click(b.$('.chat-fab'));
  await wait(() => dock() && dock().querySelector('.ac-plan'));
  const card = () => dock().querySelector('.ac-plan');
  assert.match(card().textContent, /Bakery site/);
  assert.match(card().textContent, /English only/);
  assert.match(card().textContent, /\/menu/);
  assert.match(card().textContent, /Waiting for your decision/);
  const btn = (t) => [...card().querySelectorAll('button')].find((x) => x.textContent === t);
  b.click(btn('Approve and build'));
  await wait(async () => {
    const r = await node.ctx.db('assistant_plans').where({ session_id: sessionId }).first();
    return r?.status === 'approved';
  });
  // The follow-up message cannot be sent without an API key, but the decision stands and the buttons are gone.
  await wait(() => !btn('Approve and build') || !btn('Approve and build').offsetParent);
});
