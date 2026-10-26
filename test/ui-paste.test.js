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
// Data made by the page lives in jsdom's realm; compare it as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));
const sec = (name) => b.$(`section[x-data^="${name}"]`);

/** Paste what Word or Google Docs put on the clipboard into the paragraph at the caret. */
const paste = (el, html, text = '') => {
  const ev = new b.win.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (t) => (t === 'text/html' ? html : t === 'text/plain' ? text : '') },
  });
  el.dispatchEvent(ev);
  return ev;
};

test('pasting from Google Docs and Word keeps headings, lists, links and bold as blocks', async () => {
  b.go('#/content/page');
  await wait(() => sec('contentList'));
  b.click(
    [...sec('contentList').querySelectorAll('a')].find((a) =>
      /New content page/.test(a.textContent),
    ),
  );
  await wait(() => b.$('#e-title'));
  const add = (t) =>
    b.click(
      [...sec('contentEditor').querySelectorAll('.block-add button')].find(
        (x) => x.textContent.trim() === t,
      ),
    );
  add('paragraph');
  await wait(() => sec('contentEditor').querySelector('.rich'));
  const rich = () => sec('contentEditor').querySelector('.rich');
  const blocks = () => b.win.Alpine.$data(sec('contentEditor')).form.data.body.blocks;

  const docs =
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">' +
    '<h2 dir="ltr"><span style="font-weight:700">Getting started</span></h2>' +
    '<p dir="ltr"><span>Read the </span><a href="https://www.google.com/url?q=https://example.com/guide&amp;sa=D"><span style="color:#1155cc;text-decoration:underline">guide</span></a>' +
    '<span style="font-weight:700"> now</span><span style="font-style:italic"> please</span>.</p>' +
    '<ul><li><p>First</p></li><li><p>Second</p><ul><li><p>Nested</p></li></ul></li></ul>' +
    '<ol><li><p>Step</p></li></ol></b>';
  const ev = paste(rich(), docs);
  assert.equal(ev.defaultPrevented, true);
  await wait(() => blocks().length === 4);
  assert.deepEqual(
    [...blocks().map((x) => x.type)],
    ['header', 'paragraph', 'list', 'list'],
    'the empty paragraph was replaced',
  );
  assert.deepEqual(plain(blocks()[0].data), { text: 'Getting started', level: 2 });
  assert.equal(
    blocks()[1].data.text,
    'Read the <a href="https://example.com/guide">guide</a><b> now</b><i> please</i>.',
  );
  assert.deepEqual(plain(blocks()[2].data.items), ['First', 'Second', 'Nested']);
  assert.equal(blocks()[3].data.style, 'ordered');

  // Word: headings, and lists that are really paragraphs with a typed marker.
  const word =
    '<html><body><!--[if gte mso 9]><xml>x</xml><![endif]--><h1 style="mso-style:x"><a name="_Toc1">Report</a></h1>' +
    '<p class=MsoNormal>Intro <b>text</b>&nbsp;here<o:p></o:p></p>' +
    '<p class=MsoListParagraphCxSpFirst style="mso-list:l0 level1 lfo1"><![if !supportLists]><span style="mso-list:Ignore">1.<span>&nbsp;&nbsp;</span></span><![endif]>One</p>' +
    '<p class=MsoListParagraphCxSpLast style="mso-list:l0 level1 lfo1"><![if !supportLists]><span style="mso-list:Ignore">2.<span>&nbsp;&nbsp;</span></span><![endif]>Two</p>' +
    '<p class=MsoNormal><a href="#_Toc1">toc</a> <a href="javascript:alert(1)">bad</a></p>' +
    '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>';
  const last = sec('contentEditor').querySelectorAll('.rich');
  add('paragraph');
  await wait(() => sec('contentEditor').querySelectorAll('.rich').length > last.length);
  const fresh = [...sec('contentEditor').querySelectorAll('.rich')].pop();
  paste(fresh, word);
  await wait(() => blocks().length === 4 + 5);
  const got = blocks().slice(4);
  assert.deepEqual(
    [...got.map((x) => x.type)],
    ['header', 'paragraph', 'list', 'paragraph', 'table'],
  );
  assert.deepEqual(plain(got[0].data), { text: 'Report', level: 1 });
  assert.equal(got[1].data.text, 'Intro <b>text</b> here');
  assert.deepEqual(plain(got[2].data), { style: 'ordered', items: ['One', 'Two'] });
  assert.equal(
    got[3].data.text,
    'toc bad',
    'bookmarks and script links lose the link, keep the words',
  );
  assert.deepEqual(plain(got[4].data), {
    header: true,
    rows: [
      ['A', 'B'],
      ['1', '2'],
    ],
  });
});

test('pasting formatted words inside one paragraph, or plain text, does not create blocks', async () => {
  const blocks = () => b.win.Alpine.$data(sec('contentEditor')).form.data.body.blocks;
  const count = () => sec('contentEditor').querySelectorAll('.rich').length;
  const n = count();
  b.click(
    [...sec('contentEditor').querySelectorAll('.block-add button')].find(
      (x) => x.textContent.trim() === 'paragraph',
    ),
  );
  await wait(() => count() > n);
  const el = [...sec('contentEditor').querySelectorAll('.rich')].pop();
  const before = blocks().length;
  paste(el, '<span style="font-weight:700">bold</span> and <a href="/about">link</a>');
  paste(el, '', 'just words');
  assert.equal(blocks().length, before);
  const last = blocks()[before - 1];
  assert.match(last.data.text, /<b>bold<\/b> and <a href="\/about">link<\/a>/);
  assert.match(last.data.text, /just words/);
});
