import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

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
const sec = (name) => b.$(`section[x-data^="${name}"]`);
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
};
/** Same shape as ui-appearance.test.js's own `input()` for the Theme editor's CodeJar-bound textarea. */
const codeInput = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};
// x-show only toggles `display:none` — an element stays in the DOM, so querySelector alone can't tell a hidden
// button from a shown one (the same gotcha CLAUDE.md documents for textContent).
const btn = (root, label) =>
  [...root.querySelectorAll('button')]
    .filter(b.visible)
    .find((x) => x.textContent.trim() === label);

test('Plugin Editor has no nav entry of its own — it opens from a button inside Plugin Manager', async () => {
  b.go('#/plugins');
  const page = () => b.$('section[x-data="pluginsPage"]');
  await wait(() => page());
  const editorLink = () =>
    [...page().querySelectorAll('a')].find((a) => /Plugin Editor/.test(a.textContent));
  await wait(() => editorLink());
  b.click(editorLink());
  await wait(() => /#\/pluginEditor$/.test(b.win.location.hash));
  await wait(() => sec('pluginEditorList'));
});

test('starting a new session opens the chat screen; sending a message without an API key configured shows a clear error and keeps the draft', async () => {
  b.go('#/pluginEditor');
  await wait(() => sec('pluginEditorList'));
  const startBtn = () =>
    [...sec('pluginEditorList').querySelectorAll('button')].find(
      (x) => x.textContent === 'Start session',
    );
  await wait(() => startBtn());
  b.click(startBtn());

  await wait(() => /#\/pluginEditor\/\d+/.test(b.win.location.hash));
  await wait(() => sec('pluginEditorChat'));
  assert.match(sec('pluginEditorChat').textContent, /New plugin/);

  const textarea = () => sec('pluginEditorChat').querySelector('textarea');
  await wait(() => textarea());
  setValue(textarea(), 'Build me a plugin that shows a random quote.');
  const sendBtn = () =>
    [...sec('pluginEditorChat').querySelectorAll('button')].find((x) => x.textContent === 'Send');
  await wait(() => sendBtn() && !sendBtn().disabled);
  b.click(sendBtn());

  // no ai.anthropic_api_key is configured in a fresh test node, so this should fail gracefully, not silently
  await wait(() => /Set an Anthropic API key/.test(sec('pluginEditorChat').textContent));
  assert.equal(textarea().value, 'Build me a plugin that shows a random quote.');
});

test('"Edit with AI" on a plugin row jumps straight into a session already scoped to that plugin', async () => {
  const zip = new AdmZip();
  zip.addFile(
    'plugin.json',
    Buffer.from(
      JSON.stringify({
        slug: 'editme',
        name: 'Edit Me',
        version: '1.0.0',
        author: 'Test',
        description: 'For the Edit with AI shortcut.',
      }),
    ),
  );
  await node.ctx.plugins.install(zip.toBuffer(), null);
  // a db-sourced plugin only materializes its files to disk once enabled — the editor works on real files, so
  // "Edit with AI" needs those to actually exist first.
  await node.ctx.plugins.setEnabled('editme', true, null);

  b.go('#/plugins');
  const page = () => b.$('section[x-data="pluginsPage"]');
  await wait(() => /Edit Me/.test(page()?.textContent ?? ''));
  const row = () => [...page().querySelectorAll('tr')].find((r) => /Edit Me/.test(r.textContent));
  const editBtn = () =>
    [...row().querySelectorAll('button')].find((x) => x.textContent === 'Edit with AI');
  await wait(() => editBtn());
  b.click(editBtn());

  await wait(() => /#\/pluginEditor\/\d+/.test(b.win.location.hash));
  await wait(() => sec('pluginEditorChat'));
  assert.match(sec('pluginEditorChat').textContent, /Plugin: editme/);
});

test('files can be viewed and edited by hand, not only through the chat', async () => {
  b.go('#/pluginEditor');
  await wait(() => sec('pluginEditorList'));
  b.click(btn(sec('pluginEditorList'), 'Start session'));
  await wait(() => /#\/pluginEditor\/\d+/.test(b.win.location.hash));
  const page = () => sec('pluginEditorChat');
  await wait(() => page());

  // No plugin yet: create plugin.json by hand, same validation the AI's own write_file tool uses.
  const newPathInput = () => page().querySelector('input[aria-label="New file path"]');
  await wait(() => newPathInput());
  setValue(newPathInput(), 'plugin.json');
  b.click([...page().querySelectorAll('button')].find((x) => x.textContent === 'Add'));

  const manifest = JSON.stringify({
    slug: 'hand-edited',
    name: 'Hand Edited',
    version: '1.0.0',
    author: 'Test',
    description: 'Written by hand in the Files panel.',
  });
  await wait(() => page().querySelector('#pe-file-content'));
  codeInput(page().querySelector('#pe-file-content'), manifest);
  await wait(() => btn(page(), 'Save file') && !btn(page(), 'Save file').disabled);
  b.click(btn(page(), 'Save file'));
  await wait(() => /Plugin: hand-edited/.test(page().textContent));
  await wait(() => fs.existsSync(path.join(node.env.PLUGINS_DIR, 'hand-edited', 'plugin.json')));

  // plugin.json itself has no Delete button (every plugin needs one — overwrite it instead).
  assert.ok(!btn(page(), 'Delete'));

  // Add a second file, then delete it — a file other than plugin.json does get a Delete button.
  setValue(newPathInput(), 'README.md');
  b.click([...page().querySelectorAll('button')].find((x) => x.textContent === 'Add'));
  await wait(() => /README\.md/.test(page().querySelector('.panel-h .mono')?.textContent ?? ''));
  codeInput(page().querySelector('#pe-file-content'), '# Hand Edited');
  b.click(btn(page(), 'Save file'));
  await wait(() => fs.existsSync(path.join(node.env.PLUGINS_DIR, 'hand-edited', 'README.md')));
  await wait(() => btn(page(), 'Delete'));

  b.win.confirm = () => true;
  b.click(btn(page(), 'Delete'));
  await wait(() => !fs.existsSync(path.join(node.env.PLUGINS_DIR, 'hand-edited', 'README.md')));
});
