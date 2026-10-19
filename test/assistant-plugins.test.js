import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeNode } from './helpers.js';
import { createAssistant } from '../src/modules/assistant/service.js';

let node;
before(async () => {
  node = await makeNode();
  await node.ctx.settings.update('prompts', { values: { planning: 'never_ask' } }, null);
});
after(() => node.close());

const usage = { input_tokens: 1, output_tokens: 1 };
const say = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage });
const callTools = (...calls) => ({
  content: calls.map((c, i) => ({
    type: 'tool_use',
    id: `t${i}_${c.name}`,
    name: c.name,
    input: c.input ?? {},
  })),
  stop_reason: 'tool_use',
  usage,
});
const fake = (responses) => {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(JSON.parse(JSON.stringify(req)));
        return responses.shift();
      },
    },
  };
};
const adm = { id: 1, email: 'admin@example.com', can: () => true };
const only = (...perms) => ({ id: 2, email: 'x@example.com', can: (p) => perms.includes(p) });
const MANIFEST = (slug) =>
  JSON.stringify({
    slug,
    name: 'Hello AI',
    version: '1.0.0',
    author: 'T',
    description: 'Says hello.',
  });
const PLUGIN_JS = `export default (ctx) => { const { Router } = ctx.require('express'); const r = Router(); r.get('/hi', (_q, res) => res.json({ hi: 1 })); return r; };`;
const toolResults = (client, call) =>
  client.calls[call].messages
    .at(-1)
    .content.map((b) => ({ err: !!b.is_error, text: String(b.content) }));
const run = async (responses, actor = adm) => {
  const client = fake(responses);
  const svc = createAssistant(node.ctx, { client });
  const s = await svc.create(actor);
  const out = await svc.sendMessage(s.id, 'do it', actor);
  return { client, svc, out };
};

describe('plugins in the assistant', () => {
  test('it can create a plugin, edit it, and list its files; the plugin appears in Plugin Manager but stays off', async () => {
    const { client, out } = await run([
      callTools({ name: 'plugin_guide' }),
      callTools(
        {
          name: 'write_file',
          input: { path: 'plugins/hello-ai/plugin.json', content: MANIFEST('hello-ai') },
        },
        { name: 'write_file', input: { path: 'plugins/hello-ai/plugin.js', content: PLUGIN_JS } },
      ),
      callTools(
        {
          name: 'edit_file',
          input: { path: 'plugins/hello-ai/plugin.js', old: 'hi: 1', new: "hi: 'there'" },
        },
        { name: 'list_plugin_files', input: { slug: 'hello-ai' } },
      ),
      say('Created. Review it in Plugin Manager and click Enable.'),
    ]);
    assert.match(toolResults(client, 1)[0].text, /conventions/);
    assert.ok(
      toolResults(client, 2).every((r) => !r.err),
      JSON.stringify(toolResults(client, 2)),
    );
    const res = toolResults(client, 3);
    assert.ok(
      res.every((r) => !r.err),
      JSON.stringify(res),
    );
    assert.match(res[1].text, /plugins\/hello-ai\/plugin\.js/);
    assert.match(
      fs.readFileSync(path.join(node.env.PLUGINS_DIR, 'hello-ai', 'plugin.js'), 'utf8'),
      /hi: 'there'/,
    );
    const row = node.ctx.plugins.list().find((p) => p.slug === 'hello-ai');
    assert.ok(row);
    assert.equal(row.enabled, false); // only a person switches it on
    assert.ok(out.commit, 'recorded in the change history');
  });

  test('site_map lists plugins, and the plugin tools need plugins.manage', async () => {
    const { client } = await run([callTools({ name: 'site_map' }), say('ok')]);
    assert.match(toolResults(client, 1)[0].text, /hello-ai \(off\)/);
    const none = await run(
      [
        callTools(
          { name: 'plugin_guide' },
          { name: 'read_file', input: { path: 'plugins/hello-ai/plugin.json' } },
          { name: 'write_file', input: { path: 'plugins/hello-ai/x.js', content: 'x' } },
        ),
        say('no'),
      ],
      only('admin.access'),
    );
    for (const r of toolResults(none.client, 1)) {
      assert.equal(r.err, true);
      assert.match(r.text, /plugins\.manage/);
    }
  });

  test('a slug that disagrees with the path, a file before plugin.json, and an invalid package are all refused', async () => {
    const { client } = await run([
      callTools(
        { name: 'write_file', input: { path: 'plugins/new-one/plugin.js', content: PLUGIN_JS } },
        {
          name: 'write_file',
          input: { path: 'plugins/new-one/plugin.json', content: MANIFEST('other-slug') },
        },
        {
          name: 'write_file',
          input: { path: 'plugins/hello-ai/plugin.js', content: 'export default 5 +' },
        },
      ),
      say('stopped'),
    ]);
    const [a, b, c] = toolResults(client, 1);
    assert.match(a.text, /plugin\.json first/);
    assert.match(b.text, /other-slug/);
    assert.equal(c.err, true);
    assert.equal(fs.existsSync(path.join(node.env.PLUGINS_DIR, 'new-one')), false);
    assert.doesNotMatch(
      fs.readFileSync(path.join(node.env.PLUGINS_DIR, 'hello-ai', 'plugin.js'), 'utf8'),
      /5 \+/,
    );
  });

  test('reverting the change that created a plugin removes it again', async () => {
    const { svc, out } = await run([
      callTools(
        {
          name: 'write_file',
          input: { path: 'plugins/short-lived/plugin.json', content: MANIFEST('short-lived') },
        },
        {
          name: 'write_file',
          input: { path: 'plugins/short-lived/plugin.js', content: PLUGIN_JS },
        },
      ),
      say('done'),
    ]);
    assert.ok(fs.existsSync(path.join(node.env.PLUGINS_DIR, 'short-lived')));
    await svc.history.revert(out.commit.id, adm);
    assert.equal(fs.existsSync(path.join(node.env.PLUGINS_DIR, 'short-lived')), false);
    assert.equal(
      node.ctx.plugins.list().some((p) => p.slug === 'short-lived'),
      false,
    );
  });

  test('a plugin installed from a zip, or one that is switched on, is protected', async () => {
    await node.ctx.db('plugins').insert({
      slug: 'from-zip',
      name: 'Zip',
      version: '1.0.0',
      author: 'T',
      description: 'd',
      manifest: JSON.stringify({ slug: 'from-zip' }),
      source: 'db',
      enabled: false,
      installed_at: Date.now(),
      updated_at: Date.now(),
    });
    const { client } = await run([
      callTools({
        name: 'write_file',
        input: { path: 'plugins/from-zip/plugin.json', content: MANIFEST('from-zip') },
      }),
      say('no'),
    ]);
    assert.match(toolResults(client, 1)[0].text, /installed from a zip/);

    await node.ctx.db('plugins').where({ slug: 'hello-ai' }).update({ enabled: true });
    const del = await run([
      callTools({ name: 'delete_file', input: { path: 'plugins/hello-ai/plugin.json' } }),
      say('no'),
    ]);
    assert.match(toolResults(del.client, 1)[0].text, /switched on/);
    await node.ctx.db('plugins').where({ slug: 'hello-ai' }).update({ enabled: false });
  });
});
