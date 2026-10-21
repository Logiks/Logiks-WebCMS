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

test('the orange Templates button opens a panel; picking a template previews it and opens a session with the draft ready', async () => {
  b.go('#/pageDesigner');
  await wait(() => sec('pageDesignerList'));
  const slot = () => sec('pageDesignerList').querySelector('[x-data^="templatePicker"]');
  const data = () => b.win.Alpine.$data(slot());
  const open = () =>
    [...sec('pageDesignerList').querySelectorAll('button')].find(
      (x) => /Templates/.test(x.textContent) && x.classList.contains('btn-orange'),
    );
  await wait(() => open());
  assert.equal(data().open, false, 'the panel is closed until asked for');
  b.click(open());
  await wait(() => data().open === true);
  const rows = () => [...sec('pageDesignerList').querySelectorAll('button.pd-row')];
  await wait(() => rows().length >= 20);
  // the first template is already previewing
  await wait(() => data().tpl && data().html);
  // filter by kind
  const chip = (name) =>
    [...sec('pageDesignerList').querySelectorAll('button.pd-filter')].find((x) =>
      x.textContent.startsWith(name),
    );
  b.click(chip('Legal'));
  await wait(() => rows().length === 2 && rows().every((r) => /Privacy|Terms/.test(r.textContent)));
  b.click(chip('All'));
  await wait(() => rows().length >= 20);
  b.click(rows().find((r) => /Pricing/.test(r.textContent)));
  await wait(() => data().tpl?.id === 'pricing');
  assert.equal(data().path, 'pages/pricing.html');
  await wait(() => /Choose the plan that fits/.test(data().html));
  const use = () =>
    [...sec('pageDesignerList').querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'Use this template',
    );
  b.click(use());
  await wait(() => /#\/pageDesigner\/\d+$/.test(b.win.location.hash));
  await wait(() => sec('pageDesignerChat'));
  const chat = () => b.win.Alpine.$data(sec('pageDesignerChat'));
  await wait(() => chat().currentDraft?.path === 'pages/pricing.html');
  assert.equal(chat().currentDraft.front_matter.title, 'Pricing');
});
