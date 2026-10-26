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
const ed = () => b.$('section[x-data^="contentEditor"]');
const data = () => b.win.Alpine.$data(ed());
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};
const btn = (label, root = ed()) =>
  [...root.querySelectorAll('button')].find(
    (x) => x.textContent.trim() === label || x.getAttribute('aria-label') === label,
  );
const openNew = async (type = 'post') => {
  // The same address again would keep the previous screen, so leave it first.
  b.go('#/overview');
  await wait(() => !ed());
  b.go(`#/content/${type}/new`);
  await wait(
    () => b.$('#e-title') && ed() && data().typeId === type && data().isNew && !data().loading,
  );
  await new Promise((r) => setTimeout(r, 100));
  data().autosaveMs = 60_000; // these tests press the buttons themselves
};
const body = () => data().form.data.body.blocks;
const fire = (el, type) =>
  el.dispatchEvent(new b.win.Event(type, { bubbles: true, cancelable: true }));
const rich = (i = 0) => ed().querySelectorAll('.block')[i].querySelector('.rich');
const write = (el, html) => {
  el.innerHTML = html;
  fire(el, 'input');
};
const select = (el, from = 0, to = null) => {
  const r = b.win.document.createRange();
  const t = el.firstChild;
  r.setStart(t, from);
  r.setEnd(t, to ?? t.length);
  const s = b.win.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  data().rememberSelection();
};

test('the search preview follows the title and description, clips what search clips, and has a mobile size', async () => {
  await openNew();
  setValue(b.$('#e-title'), 'How we bake sourdough');
  const serp = () => ed().querySelector('.serp');
  await wait(() => /How we bake sourdough/.test(serp().textContent));
  assert.match(ed().querySelector('.serp-url').textContent, /›\s*blog/);
  setValue(b.$('#f-seo_title'), 'S'.repeat(90));
  await wait(() => ed().querySelector('.serp-title').textContent.length === 60);
  assert.match(ed().querySelector('.serp-title').textContent, /…$/);
  setValue(b.$('#f-seo_description'), 'd'.repeat(300).replace(/(.{9})/g, '$1 '));
  await wait(() => ed().querySelector('.serp-desc').textContent.length <= 160);
  b.click(btn('Mobile', ed().querySelector('[aria-label="Search preview size"]')));
  await wait(() => ed().querySelector('.serp').classList.contains('serp-mobile'));
  assert.ok(ed().querySelector('.serp-desc').textContent.length <= 120);
});

test('writing checks: the focus keyword, headings, readability and quality appear, and refresh as the text changes', async () => {
  await openNew();
  setValue(b.$('#e-title'), 'Sourdough for beginners');
  setValue(b.$('#f-focus_keyword'), 'sourdough');
  b.click(btn('paragraph'));
  await wait(() => ed().querySelector('.rich'));
  write(rich(), 'TODO write the opening about <a href="/x">click here</a>.');
  b.click(btn('Check my writing'));
  const panel = () => ed().querySelector('[aria-label="Content analysis"]');
  await wait(() => data().analysis && panel().querySelectorAll('li').length > 5);
  const text = panel().textContent;
  assert.match(text, /Focus keyword/);
  assert.match(text, /keyword is in the search title|keyword is not in the search title/);
  assert.match(text, /Placeholder text/);
  assert.match(text, /“here” or “read more”/);
  assert.ok(panel().querySelector('li[data-status="bad"]'), 'a failing check is marked');
  assert.match(text, /reading checks appear|Reading ease/);
  // Once run, it keeps itself fresh.
  const seen = data().analysis;
  write(rich(), 'Sourdough is a slow, rewarding way to bake. '.repeat(20));
  await wait(() => data().analysis !== seen);
  assert.doesNotMatch(panel().textContent, /Placeholder text/);
});

test('templates: a built-in one fills a new entry, and a saved one comes back for the next', async () => {
  await openNew();
  await wait(() => data().templates.length >= 4);
  const panel = ed().querySelector('[aria-label="Templates"]');
  assert.ok(b.visible(panel));
  b.click(btn('Case study', panel));
  await wait(() => body().length > 5);
  assert.ok(body().some((x) => x.type === 'table'));
  assert.match(data().form.data.excerpt, /How \{customer\}/);

  setValue(b.$('#e-title'), 'Template source');
  b.win.prompt = () => 'My own layout';
  await b.click(btn('Save'));
  await wait(() => /#\/content\/post\/\d+$/.test(b.win.location.hash));
  await wait(() => ed() && !data().isNew && !data().loading);
  b.click(btn('Save as template'));
  await wait(() => data().templates.some((t) => t.name === 'My own layout'));
  assert.equal((await node.ctx.db('content_templates').where({ name: 'My own layout' })).length, 1);
  await openNew();
  await wait(() => data().templates.some((t) => t.name === 'My own layout'));
});

test('approval: a writer submits, a publisher approves; the screens say who does what', async () => {
  const role = await node.ctx.users.createRole(
    { name: 'UI writer', permissions: ['admin.access', 'content.post.read', 'content.post.write'] },
    null,
  );
  await node.ctx.users.createUser(
    {
      email: 'uiwriter@example.com',
      name: 'UI Writer',
      password: 'Some-long-pass-12',
      roleId: Number(role.id),
    },
    null,
  );
  const w = await openAdmin(node.url);
  try {
    await w.signIn('uiwriter@example.com', 'Some-long-pass-12');
    w.go('#/content/post/new');
    const wed = () => w.$('section[x-data^="contentEditor"]');
    const wdata = () => w.win.Alpine.$data(wed());
    await until(() => w.$('#e-title') && wed() && wdata().isNew && !wdata().loading, {
      timeout: 8000,
      every: 50,
    });
    const submit = [...wed().querySelectorAll('button')].find((x) =>
      /Submit for review/.test(x.textContent),
    );
    assert.ok(submit && w.visible(submit));
    const approve = [...wed().querySelectorAll('button')].find((x) =>
      /Approve and publish/.test(x.textContent),
    );
    assert.ok(!w.visible(approve), 'a writer cannot approve');
    const t = w.$('#e-title');
    t.value = 'Writer draft for review';
    t.dispatchEvent(new w.win.Event('input', { bubbles: true }));
    w.click(submit);
    await until(
      async () =>
        (await node.ctx.db('entries').where({ title: 'Writer draft for review' }).first())
          ?.status === 'review',
      { timeout: 8000, every: 50 },
    );
  } finally {
    w.close();
  }
  const row = await node.ctx.db('entries').where({ title: 'Writer draft for review' }).first();
  b.go(`#/content/post/${row.id}`);
  await wait(() => ed() && data().entry?.id === row.id && !data().loading);
  const approve = btn('Approve and publish');
  await wait(() => b.visible(approve));
  assert.match(ed().textContent, /waiting for you to approve/);
  b.win.prompt = () => 'add a source';
  b.click(btn('Request changes'));
  await wait(
    async () => (await node.ctx.db('entries').where({ id: row.id }).first()).status === 'draft',
  );
  const note = await node.ctx
    .db('entry_revisions')
    .where({ entry_id: row.id })
    .orderBy('id', 'desc')
    .first();
  assert.match(note.note, /Changes requested: add a source/);
  await node.ctx.content.update(row.id, { status: 'review' }, null);
  b.go('#/overview');
  await wait(() => !ed());
  b.go(`#/content/post/${row.id}`);
  await wait(() => ed() && data().entry?.status === 'review' && !data().loading);
  b.click(btn('Approve and publish'));
  await wait(
    async () => (await node.ctx.db('entries').where({ id: row.id }).first()).status === 'published',
  );
});

test('links: same tab or new tab, and a page of this site found by title', async () => {
  await node.ctx.content.create('post', { title: 'Our pricing explained', status: 'published' });
  await openNew();
  b.click(btn('paragraph'));
  await wait(() => ed().querySelector('.rich'));
  write(rich(), 'Read about pricing here today');
  select(rich(), 11, 18);
  data().link();
  await wait(() => data().linkDlg.open);
  assert.equal(data().linkDlg.q, 'pricing');
  await wait(() => data().linkDlg.results.some((r) => r.title === 'Our pricing explained'));
  const hit = [...ed().querySelectorAll('.link-results button')].find((x) =>
    /Our pricing explained/.test(x.textContent),
  );
  b.click(hit);
  assert.match(data().linkDlg.url, /^\/blog\/our-pricing-explained/);
  assert.ok(
    !b.visible(ed().querySelector('#lk-tab').closest('.form-check')),
    'no tab choice for this site',
  );
  b.click(btn('Add link'));
  await wait(() => /<a href="\/blog\/our-pricing-explained/.test(body()[0].data.text));
  assert.doesNotMatch(body()[0].data.text, /target=/);

  write(rich(), 'Visit our partner site for details');
  select(rich(), 10, 22);
  data().link();
  await wait(() => data().linkDlg.open);
  setValue(b.$('#lk-url'), 'https://partner.example/');
  await wait(() => b.visible(ed().querySelector('#lk-tab').closest('.form-check')));
  ed().querySelector('#lk-tab').click();
  assert.equal(data().linkDlg.newTab, true);
  b.click(btn('Add link'));
  await wait(() => /target="_blank"/.test(body()[0].data.text));
  assert.match(
    body()[0].data.text,
    /<a href="https:\/\/partner\.example\/" target="_blank">partner site<\/a>/,
  );

  write(rich(), 'Plain words');
  select(rich(), 0, 5);
  data().link();
  await wait(() => data().linkDlg.open);
  setValue(b.$('#lk-url'), 'javascript:alert(1)');
  b.click(btn('Add link'));
  await wait(() => data().linkDlg.note);
  assert.ok(data().linkDlg.open, 'an unsafe address keeps the dialog open and says why');
  b.click(btn('Cancel', ed().querySelector('#lk-h').closest('.dialog')));
});

test('page source: the whole content as HTML and back, keeping images, buttons, callouts and embeds', async () => {
  await openNew();
  for (const t of [
    'header',
    'paragraph',
    'callout',
    'button',
    'embed',
    'download',
    'image',
    'quote',
    'list',
  ]) {
    b.click(
      [...ed().querySelectorAll('.block-add button')].find((x) => x.textContent.trim() === t),
    );
  }
  const blocks = body();
  blocks[0].data.text = 'Main <heading>';
  blocks[1].data.text = 'Some <b>bold</b> words';
  blocks[2].data = { style: 'warning', title: 'Careful', text: 'Mind the step' };
  blocks[3].data = { text: 'Buy', url: 'https://shop.example', look: 'outline', newTab: true };
  blocks[4].data = { url: 'https://youtu.be/dQw4w9WgXcQ', caption: 'Demo', ratio: '4:3' };
  blocks[5].data = { mediaId: 7, label: 'Sheet', look: 'card' };
  blocks[6].data = { mediaId: 9, alt: 'A loaf', caption: 'Fresh' };
  blocks[7].data = { text: 'Wise words', caption: 'Someone' };
  blocks[8].data = { style: 'ordered', items: ['one', 'two'] };
  const before = JSON.stringify(body().map((x) => ({ type: x.type, data: x.data })));
  b.click(btn('Edit the whole page as HTML'));
  await wait(() => data().src.open);
  const text = ed().querySelector('textarea[aria-label="Page HTML"]');
  assert.match(text.value, /<h2>Main &lt;heading&gt;<\/h2>/);
  assert.match(text.value, /data-media="9"/);
  assert.match(text.value, /callout-warning/);
  b.click(btn('Apply to the page'));
  await wait(() => !data().src.open);
  const after = JSON.stringify(body().map((x) => ({ type: x.type, data: x.data })));
  assert.equal(after, before, 'nothing is lost on the way through');

  data().openSource(data().type.fields.find((f) => f.key === 'body'));
  data().src.text =
    '<h2>Only this</h2><script>alert(1)</script><p>And <i>this</i></p><form><input></form>';
  b.click(btn('Apply to the page'));
  await wait(() => !data().src.open);
  assert.equal(
    body()
      .map((x) => x.type)
      .join(),
    'header,paragraph',
  );
  assert.equal(body()[0].data.text, 'Only this');
  data().openSource(data().type.fields.find((f) => f.key === 'body'));
  data().src.text = '<script>alert(1)</script>';
  b.click(btn('Apply to the page'));
  await wait(() => data().src.error);
  assert.ok(data().src.open, 'nothing usable: the page is left alone');
  data().src.open = false;
});

test('Markdown import adds or replaces blocks, and plain HTML in it stays text', async () => {
  await openNew();
  b.click(btn('paragraph'));
  b.click(btn('Import Markdown'));
  await wait(() => data().md.open);
  setValue(
    ed().querySelector('textarea[aria-label="Markdown"]'),
    '# Title\n\nHello **world** <b>raw</b>\n\n- a\n- b\n',
  );
  b.click(btn('Add to the end'));
  await wait(() => body().length === 4);
  assert.equal(
    body()
      .map((x) => x.type)
      .join(),
    'paragraph,header,paragraph,list',
  );
  assert.match(body()[2].data.text, /<b>world<\/b> &lt;b&gt;raw&lt;\/b&gt;/);
  b.click(btn('Import Markdown'));
  await wait(() => data().md.open);
  setValue(ed().querySelector('textarea[aria-label="Markdown"]'), '## Only\n');
  b.click(btn('Replace the content'));
  await wait(() => body().length === 1 && body()[0].type === 'header');
});

test('blocks can be dragged to a new place, and the menu on right-click does the same jobs', async () => {
  await openNew();
  for (const t of ['paragraph', 'quote', 'code'])
    b.click(
      [...ed().querySelectorAll('.block-add button')].find((x) => x.textContent.trim() === t),
    );
  const order = () =>
    body()
      .map((x) => x.type)
      .join();
  assert.equal(order(), 'paragraph,quote,code');
  const grips = () => ed().querySelectorAll('.block-grip');
  await wait(() => grips().length === 3);
  fire(grips()[2], 'dragstart');
  assert.equal(data().dragFrom, 2);
  fire(ed().querySelectorAll('.block')[0], 'dragover');
  await wait(() => ed().querySelectorAll('.block')[0].classList.contains('drop-before'));
  fire(ed().querySelectorAll('.block')[0], 'drop');
  await wait(() => order() === 'code,paragraph,quote');
  assert.equal(data().dragFrom, null);
  fire(grips()[0], 'dragstart');
  fire(grips()[0], 'dragend');
  assert.equal(data().dragFrom, null);

  const p = body().find((x) => x.type === 'paragraph');
  const el = [...ed().querySelectorAll('.block')]
    .find((x) => x.querySelector('.rich'))
    .querySelector('.rich');
  write(el, 'Make me a heading');
  el.dispatchEvent(
    new b.win.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
    }),
  );
  const menu = ed().querySelector('.ctx-menu');
  await wait(() => b.visible(menu) && data().menu.mode === 'context');
  b.click(
    [...menu.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Make heading 2'),
  );
  await wait(() => p.type === 'header' && p.data.level === 2);
  await wait(() => !b.visible(menu));
  await wait(() => ed().querySelector('.block-h2'));
  data().openMenu(
    { clientX: 1, clientY: 1 },
    data().type.fields.find((f) => f.key === 'body'),
    p,
  );
  await wait(() => data().menu.open);
  b.click(
    [...menu.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Duplicate block'),
  );
  await wait(() => body().length === 4);
  fire(b.win.document.body, 'mousedown');
  data().openMenu(
    { clientX: 1, clientY: 1 },
    data().type.fields.find((f) => f.key === 'body'),
    body()[0],
  );
  fire(b.win.document.body, 'keydown');
});

test('the selection bar appears over selected words', async () => {
  await openNew();
  b.click(btn('paragraph'));
  await wait(() => ed().querySelector('.rich'));
  write(rich(), 'Select these words');
  select(rich(), 0, 6);
  rich().dispatchEvent(new b.win.MouseEvent('mouseup', { bubbles: true }));
  await wait(() => data().menu.open && data().menu.mode === 'bubble');
  assert.ok(b.visible(ed().querySelector('.ctx-menu')));
  assert.ok(btn('Make heading 2', ed().querySelector('.ctx-menu')));
  data().closeMenu();
});

test('preview on devices and a shareable link', async () => {
  const e = await node.ctx.content.create('post', {
    title: 'Show me',
    data: { body: { blocks: [{ type: 'paragraph', data: { text: 'Hi there' } }] } },
  });
  b.go(`#/content/post/${e.id}`);
  await wait(() => ed() && data().entry?.id === e.id && !data().loading);
  b.click(btn('Devices'));
  await wait(() => data().device.url);
  const overlay = ed().querySelector('[aria-labelledby="dev-h"]').parentElement;
  assert.ok(b.visible(overlay));
  const frame = overlay.querySelector('iframe');
  await wait(() => /^\/preview\/\d+\?exp=/.test(frame.getAttribute('src') || ''));
  b.click(btn('Mobile', overlay));
  await wait(() => /width:375px/.test(frame.getAttribute('style')));
  b.click(btn('Tablet', overlay));
  await wait(() => /width:768px/.test(frame.getAttribute('style')));
  b.click(btn('Close', overlay));
  await wait(() => !data().device.open && !data().device.url);

  b.click(btn('Share a preview'));
  const box = ed().querySelector('[aria-label="Share a preview"]');
  await wait(() => b.visible(box));
  const sel = box.querySelector('#share-hours');
  setValue(sel, '168');
  b.click(btn('Create link', box));
  await wait(() => data().share.url);
  assert.match(box.querySelector('#share-url').value, /\/preview\/\d+\?exp=\d+&sig=/);
  assert.ok(data().share.expiresAt - Date.now() > 160 * 3600_000);
  assert.match(box.textContent, /Works until/);
});

test('the writing area takes the site’s colours and font, the new blocks can be added, and custom HTML needs permission', async () => {
  await openNew();
  await wait(() => data().design);
  const blocks = ed().querySelector('.blocks');
  assert.ok(blocks.classList.contains('themed'));
  assert.match(blocks.getAttribute('style'), /--ed-ink:#1c2b2f/);
  assert.match(blocks.getAttribute('style'), /--ed-font:system-ui/);
  const addBtn = (t) =>
    [...ed().querySelectorAll('.block-add button')].find((x) => x.textContent.trim() === t);
  assert.ok(b.visible(addBtn('html')), 'an administrator may add custom HTML');
  b.click(addBtn('button'));
  b.click(addBtn('html'));
  await wait(() => body().length === 2);
  assert.ok(ed().querySelector('textarea[aria-label="Custom HTML"]'));
  assert.ok(ed().querySelector('input[aria-label="Button text"]'));
  b.click(addBtn('header'));
  await wait(() => ed().querySelector('.block-h2'));

  // saved and sanitised
  setValue(b.$('#e-title'), 'Blocks of every kind');
  body()[0].data = { text: 'Go', url: 'https://x.example', look: 'primary', newTab: false };
  body()[1].data.code = '<div class="box"><script>x</script><p>Hi</p></div>';
  body()[2].data.text = 'Heading';
  await b.click(btn('Save'));
  await wait(() => /#\/content\/post\/\d+$/.test(b.win.location.hash));
  const row = await node.ctx.db('entries').where({ title: 'Blocks of every kind' }).first();
  const saved = JSON.parse(row.data).body.blocks;
  assert.deepEqual(
    saved.map((x) => x.type),
    ['button', 'html', 'header'],
  );
  assert.equal(saved[1].data.code, '<div class="box"><p>Hi</p></div>');
});
