import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode } from './helpers.js';
import { createAssistant, isHelpQuestion, HELP_TOOLS } from '../src/modules/assistant/service.js';
import { cachedSystem, cachedTools, withHistoryCache } from '../src/core/ai-cache.js';

let node;
before(async () => {
  node = await makeNode();
});
after(() => node.close());

const adm = { id: 1, email: 'admin@example.com', can: () => true };
const fake = () => {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(JSON.parse(JSON.stringify(req)));
        return {
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
};

describe('cache helpers (D-132)', () => {
  test('the last message block is marked, on a copy', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ];
    const out = withHistoryCache(msgs);
    assert.equal(out[1].content[1].cache_control.type, 'ephemeral');
    assert.equal(out[1].content[0].cache_control, undefined);
    assert.equal(msgs[1].content[1].cache_control, undefined); // original untouched
    assert.equal(withHistoryCache([{ role: 'user', content: 'x' }])[0].content[0].text, 'x');
    assert.deepEqual(withHistoryCache([]), []);
  });
  test('system and tools get one marker each', () => {
    assert.equal(cachedSystem('s')[0].cache_control.type, 'ephemeral');
    const t = cachedTools([{ name: 'a' }, { name: 'b' }]);
    assert.equal(t[0].cache_control, undefined);
    assert.equal(t[1].cache_control.type, 'ephemeral');
  });
});

describe('which messages take the help route', () => {
  test('plain questions do', () => {
    assert.ok(isHelpQuestion('How do I reset a password?'));
    assert.ok(isHelpQuestion('Where is the SEO setting?'));
    assert.ok(isHelpQuestion('What does the cache tag do?'));
    assert.ok(isHelpQuestion("Why can't I sign in?"));
  });
  test('requests, attachments, pins and work chats do not', () => {
    assert.ok(!isHelpQuestion('Can you add a contact page?'));
    assert.ok(!isHelpQuestion('What plugins are there?'));
    assert.ok(!isHelpQuestion('How many pages does my site have?'));
    assert.ok(!isHelpQuestion('Make the header blue'));
    assert.ok(!isHelpQuestion('How do I do this?', { images: 1 }));
    assert.ok(!isHelpQuestion('How do I do this?', { focus: 'pages/a.html' }));
    assert.ok(!isHelpQuestion('x'.repeat(401) + '?'));
    const worked = [{ role: 'assistant', content: [{ type: 'tool_use', name: 'write_file' }] }];
    assert.ok(!isHelpQuestion('What did you change?', { messages: worked }));
    const helped = [{ role: 'assistant', content: [{ type: 'tool_use', name: 'read_help' }] }];
    assert.ok(isHelpQuestion('How do I get an old version back?', { messages: helped }));
  });
});

describe('the assistant', () => {
  test('a help question uses the help model, a short prompt and only the help tools', async () => {
    const client = fake();
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'How do I invite a user?', adm);
    const req = client.calls[0];
    assert.equal(req.model, node.ctx.settings.get('assistant.help_model'));
    assert.deepEqual(req.tools.map((t) => t.name).sort(), [...HELP_TOOLS].sort());
    assert.match(req.system[0].text, /answer questions about how to use this CMS/);
    assert.ok(req.system[0].text.length < 1500);
    assert.equal(req.output_config, undefined);
    const last = req.messages.at(-1).content.at(-1);
    assert.equal(last.cache_control.type, 'ephemeral');
  });

  test('a request to change something keeps the full prompt, tools and model', async () => {
    const client = fake();
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'Add a contact page', adm);
    const req = client.calls[0];
    assert.ok(req.tools.length > 20);
    assert.match(req.system[0].text, /site assistant inside a CMS admin/);
    assert.ok(req.output_config);
  });

  test('switching the route off sends questions to the main model', async () => {
    await node.ctx.settings.update('assistant', { values: { route_help: false } }, null);
    const client = fake();
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'How do I invite a user?', adm);
    assert.ok(client.calls[0].tools.length > 20);
    await node.ctx.settings.update('assistant', { values: { route_help: true } }, null);
  });
});

describe('help reading is small by default', () => {
  test('a long guide returns its outline and an intro, one section on request', () => {
    const big = node.ctx.help.read('support', 'troubleshooting');
    assert.ok(big.truncated);
    assert.ok(big.text.length <= 3000, `intro was ${big.text.length}`);
    assert.ok(big.headings.length > 2);
    const one = node.ctx.help.read('support', 'troubleshooting', big.headings[1]);
    assert.match(
      one.text,
      new RegExp(`^## ${big.headings[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });
  test('search names the section to read next', () => {
    const hit = node.ctx.help.search('password reset')[0];
    assert.ok(hit.heading);
  });
});

describe('long sections are read in parts', () => {
  test('a long "##" section returns its own text and names its parts', () => {
    const r = node.ctx.help.read('administration', 'robots-and-sitemap', 'sitemap.xml');
    assert.ok(r.text.length < 3000);
    assert.match(r.note, /Remove something/);
    const part = node.ctx.help.read('administration', 'robots-and-sitemap', 'Remove something');
    assert.match(part.text, /^### Remove something/);
  });
});
