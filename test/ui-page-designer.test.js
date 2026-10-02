import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

test('AI Page Designer is in the Webmaster menu, opening the sessions list', async () => {
  const webmaster = () =>
    [...b.$$('.nav-link-x')].find((a) => a.textContent.trim() === 'Webmaster');
  await wait(() => webmaster());
  b.click(webmaster());
  const link = () =>
    [...b.$$('.nav-sub-link')].find((a) => a.textContent.trim() === 'AI Page Designer');
  await wait(() => link());
  b.click(link());
  await wait(() => /#\/pageDesigner$/.test(b.win.location.hash));
  await wait(() => sec('pageDesignerList'));
});

test('starting a new session opens the chat screen; sending a message without an API key configured shows a clear error and keeps the draft', async () => {
  b.go('#/pageDesigner');
  await wait(() => sec('pageDesignerList'));
  const startBtn = () =>
    [...sec('pageDesignerList').querySelectorAll('button')].find(
      (x) => x.textContent === 'Start session',
    );
  await wait(() => startBtn());
  b.click(startBtn());

  await wait(() => /#\/pageDesigner\/\d+/.test(b.win.location.hash));
  await wait(() => sec('pageDesignerChat'));
  assert.match(sec('pageDesignerChat').textContent, /New page/);

  const textarea = () => sec('pageDesignerChat').querySelector('textarea');
  await wait(() => textarea());
  setValue(textarea(), 'Build me a simple About page.');
  const sendBtn = () =>
    [...sec('pageDesignerChat').querySelectorAll('button')].find((x) => x.textContent === 'Send');
  await wait(() => sendBtn() && !sendBtn().disabled);
  b.click(sendBtn());

  // no ai.anthropic_api_key is configured in a fresh test node, so this should fail gracefully, not silently
  await wait(() => /Set an Anthropic API key/.test(sec('pageDesignerChat').textContent));
  assert.equal(textarea().value, 'Build me a simple About page.');
});
