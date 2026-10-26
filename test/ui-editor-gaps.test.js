import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, media, b;
before(async () => {
  media = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-ui-gaps-'));
  node = await makeNode({ env: { MEDIA_DIR: media } });
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
  fs.rmSync(media, { recursive: true, force: true });
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const ed = () => b.$('section[x-data^="contentEditor"]');
const data = () => b.win.Alpine.$data(ed());
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};
const add = (t) =>
  b.click([...ed().querySelectorAll('.block-add button')].find((x) => x.textContent.trim() === t));
const openNew = async (type = 'post') => {
  b.go(`#/content/${type}/new`);
  await wait(
    () => b.$('#e-title') && ed() && data().typeId === type && data().isNew && !data().loading,
  );
  await new Promise((r) => setTimeout(r, 100)); // the editor starts watching its fields a tick after it loads
};
const types = () => [...ed().querySelectorAll('.block .block-bar .tag')].map((t) => t.textContent);

test('a draft saves itself, once, and keeps saving without piling up history', async () => {
  await openNew();
  data().autosaveMs = 150;
  setValue(b.$('#e-title'), 'Written without pressing Save');
  await wait(async () => (await node.ctx.db('entries').count({ n: '*' }).first()).n === 1);
  await wait(() => /#\/content\/post\/\d+$/.test(b.win.location.hash));
  await wait(() => data().saveState === 'saved');
  assert.ok(
    b.visible(
      [...ed().querySelectorAll('.text-success')].find((e) => /Draft saved at/.test(e.textContent)),
    ),
    'a "saved" confirmation is shown',
  );
  const row = await node.ctx.db('entries').first();
  assert.equal(row.status, 'draft');

  add('paragraph');
  await wait(() => ed().querySelector('.rich'));
  const rich = ed().querySelector('.rich');
  for (const text of ['one', 'two', 'three']) {
    rich.innerHTML = text;
    rich.dispatchEvent(new b.win.Event('input', { bubbles: true }));
    await wait(() => data().dirty);
    await wait(() => !data().dirty);
  }
  const saved = JSON.parse((await node.ctx.db('entries').where({ id: row.id }).first()).data);
  assert.equal(saved.body.blocks[0].data.text, 'three');
  const revs = await node.ctx.db('entry_revisions').where({ entry_id: row.id });
  assert.ok(revs.length <= 3, `history stays short (got ${revs.length})`);
  assert.equal(
    await node.ctx
      .db('entries')
      .count({ n: '*' })
      .first()
      .then((r) => r.n),
    1,
    'one entry, not one per autosave',
  );
  b.go('#/overview');
});

test('live content is not autosaved', async () => {
  const e = await node.ctx.content.create('post', { title: 'Already live', status: 'published' });
  b.go(`#/content/post/${e.id}`);
  await wait(() => ed() && data().entry?.id === e.id && !data().loading);
  data().autosaveMs = 100;
  setValue(b.$('#e-title'), 'Already live, edited');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await node.ctx.content.get(e.id)).title, 'Already live');
  assert.ok(
    b.visible(
      [...ed().querySelectorAll('.small.muted')].find((x) => /not autosaved/.test(x.textContent)),
    ),
  );
});

test('counters, the suggested description and the toolbar: style, alignment, duplicate, source, new blocks', async () => {
  await openNew('page');
  setValue(b.$('#e-title'), 'Toolbar tour');
  add('paragraph');
  await wait(() => ed().querySelector('.rich'));
  const rich = ed().querySelector('.rich');
  rich.innerHTML = 'Hello there, this is the opening line of the page.';
  rich.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  await wait(
    () => /\d+ words?/.test(ed().textContent) && /^\d+ \/ 255$/.test(b.$('.counter')?.textContent),
  );

  // The search description is empty: the page says what search engines will show instead.
  await wait(() => data().suggested.startsWith('Hello there'));
  const use = [...ed().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Use this');
  assert.ok(use);
  await wait(() => b.visible(use.closest('div')));
  assert.match(
    [...ed().querySelectorAll('.counter')].map((x) => x.textContent).join('|'),
    /0 \/ 300/,
  );
  b.click(use);
  await wait(() => data().form.data.seo_description.startsWith('Hello there'));
  assert.match(
    [...ed().querySelectorAll('.counter')].map((x) => x.textContent).join('|'),
    /\d+ \/ 300 · a little short/,
  );

  // The toolbar acts on the block you last touched.
  b.click(ed().querySelector('.block'));
  const style = ed().querySelector('select[aria-label="Text style"]');
  await wait(() => !style.disabled);
  setValue(style, 'h2');
  await wait(() => types().join() === 'header');
  assert.equal(data().form.data.body.blocks[0].data.level, 2);
  assert.equal(
    data().form.data.body.blocks[0].data.text,
    'Hello there, this is the opening line of the page.',
  );
  setValue(style, 'p');
  await wait(() => types().join() === 'paragraph');

  b.click(ed().querySelector('button[aria-label="Align centre"]'));
  await wait(() => data().form.data.body.blocks[0].data.align === 'center');
  assert.match(ed().querySelector('.rich').getAttribute('style'), /text-align:\s*center/);
  b.click(ed().querySelector('button[aria-label="Align centre"]'));
  await wait(() => data().form.data.body.blocks[0].data.align === undefined);

  b.click(ed().querySelector('[aria-label="Duplicate block"]'));
  await wait(() => types().length === 2);

  b.click(ed().querySelector('button[aria-label="Edit HTML source"]'));
  await wait(() => ed().querySelector('textarea[aria-label="HTML source"]'));
  setValue(ed().querySelector('textarea[aria-label="HTML source"]'), 'Source <b>edited</b>');
  assert.match(data().form.data.body.blocks[1].data.text, /Source <b>edited<\/b>/);

  for (const t of ['table', 'callout', 'embed', 'download']) add(t);
  await wait(() => types().length === 6);
  assert.deepEqual(types().slice(2), ['table', 'callout', 'embed', 'download']);
  b.click([...ed().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Add row'));
  await wait(() => data().form.data.body.blocks[2].data.rows.length === 3);
  setValue(ed().querySelector('input[aria-label="Row 1, column 1"]'), 'Plan');
  setValue(ed().querySelector('input[aria-label="Row 2, column 2"]'), '£5');
  setValue(ed().querySelector('input[aria-label="Video address"]'), 'https://example.com/x');
  await wait(() =>
    b.visible(
      [...ed().querySelectorAll('.text-warning')].find((x) =>
        /YouTube and Vimeo/.test(x.textContent),
      ),
    ),
  );
  setValue(ed().querySelector('input[aria-label="Video address"]'), 'https://youtu.be/dQw4w9WgXcQ');
  await wait(() => data().embedOk(data().form.data.body.blocks[4].data.url));
  b.click(ed().querySelector('.block-add').previousElementSibling ?? ed()); // blur-ish: no-op
  const c = ed().querySelector('.callout .rich');
  c.innerHTML = 'Careful now';
  c.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  // The download block needs a file: remove it so the page can save.
  const dl = [...ed().querySelectorAll('.block')].find(
    (x) => x.querySelector('.tag').textContent === 'download',
  );
  b.click(dl.querySelector('[aria-label="Remove block"]'));
  await wait(() => types().length === 5);

  b.click([...ed().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'));
  await wait(() => /#\/content\/page\/\d+$/.test(b.win.location.hash));
  const row = await node.ctx.db('entries').where({ slug: 'toolbar-tour' }).first();
  const body = JSON.parse(row.data).body.blocks;
  assert.deepEqual(
    body.map((x) => x.type),
    ['paragraph', 'paragraph', 'table', 'callout', 'embed'],
  );
  assert.deepEqual(body[2].data.rows[1], ['', '£5']);
  assert.equal(body[3].data.text, 'Careful now');
  assert.equal(body[4].data.url, 'https://youtu.be/dQw4w9WgXcQ');
});

test('choosing Published runs the checklist; a live address change offers a redirect; the author can be picked', async () => {
  const author = await node.ctx.users.createUser(
    {
      email: 'second@example.com',
      name: 'Second Author',
      password: 'Some-long-pass-12',
      roleId: (await node.ctx.db('users').first()).role_id,
    },
    null,
  );
  const e = await node.ctx.content.create('post', {
    title: 'Check me',
    status: 'published',
    data: { schema_type: 'NewsArticle' },
  });
  b.go(`#/content/post/${e.id}`);
  await wait(() => ed() && data().entry?.id === e.id && !data().loading);

  const author$ = b.$('#e-author');
  assert.ok(author$ && !author$.disabled);
  setValue(author$, String(author.id));
  assert.equal(data().form.authorId, Number(author.id));

  setValue(b.$('#e-status'), 'draft');
  await wait(() => data().form.status === 'draft');
  setValue(b.$('#e-status'), 'published');
  await wait(() => data().checks && data().checks.length);
  const ids = data().checks.map((c) => c.id);
  assert.ok(ids.includes('featured-image') && ids.includes('meta-description'), ids.join());
  assert.ok(
    [...ed().querySelectorAll('ul[aria-label="Checklist"] li')].every((li) =>
      li.textContent.trim(),
    ),
  );

  assert.equal(b.$('#e-redirect'), null, 'no warning while the address is unchanged');
  setValue(b.$('#e-slug'), 'check-me-renamed');
  await wait(() => b.$('#e-redirect'));
  assert.ok(b.$('#e-redirect').checked, 'redirecting is the default');
  b.click([...ed().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'));
  await wait(async () => (await node.ctx.db('redirects').count({ n: '*' }).first()).n === 1);
  const r = await node.ctx.db('redirects').first();
  assert.match(r.from_path, /check-me$/);
  assert.match(r.to_url, /check-me-renamed$/);
  assert.equal((await node.ctx.content.get(e.id)).authorId, Number(author.id));
  b.go('#/overview');
});

test('automatic unpublishing: the field appears for live entries and is saved', async () => {
  const e = await node.ctx.content.create('post', { title: 'Timed', status: 'published' });
  b.go(`#/content/post/${e.id}`);
  await wait(() => ed() && data().entry?.id === e.id && !data().loading);
  const off = b.$('#e-off');
  assert.ok(off);
  await wait(() => b.visible(off.closest('div')));
  const at = new Date(Date.now() + 3 * 86_400_000);
  setValue(off, data().toLocal(at.getTime()));
  b.click([...ed().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'));
  await wait(async () => (await node.ctx.content.get(e.id)).unpublishAt);
  const got = (await node.ctx.content.get(e.id)).unpublishAt;
  assert.ok(Math.abs(got - at.getTime()) < 120_000);
  b.go('#/overview');
});

test('history: Compare shows two versions side by side with the differences marked', async () => {
  const e = await node.ctx.content.create('post', {
    title: 'Versions',
    data: {
      body: {
        blocks: [
          { type: 'paragraph', data: { text: 'First wording' } },
          { type: 'paragraph', data: { text: 'Kept line' } },
        ],
      },
    },
  });
  await node.ctx.content.update(e.id, {
    title: 'Versions',
    data: {
      body: {
        blocks: [
          { type: 'paragraph', data: { text: 'Second wording' } },
          { type: 'paragraph', data: { text: 'Kept line' } },
        ],
      },
    },
  });
  b.go(`#/content/post/${e.id}`);
  await wait(() => ed() && data().entry?.id === e.id && !data().loading);
  b.click([...ed().querySelectorAll('button')].find((x) => x.textContent.trim() === 'History'));
  await wait(() => data().revisions.length === 2);
  const first = [...ed().querySelectorAll('button')].filter(
    (x) => x.textContent.trim() === 'Compare',
  );
  b.click(first[first.length - 1]); // the oldest
  await wait(() => data().cmp.rows.length);
  const rows = data().cmp.rows;
  const chg = rows.find((r) => r.kind === 'chg');
  assert.equal(chg.l, 'First wording');
  assert.equal(chg.r, 'Second wording');
  assert.ok(rows.some((r) => r.kind === 'same' && r.l === 'Kept line' && r.r === 'Kept line'));
  assert.ok(ed().querySelector('.diff-chg .diff-l').textContent.includes('First wording'));
  b.go('#/overview');
});

test('the entry list filters by author, category and date', async () => {
  const list = () => b.$('section[x-data^="contentList"]');
  const ld = () => b.win.Alpine.$data(list());
  const second = await node.ctx.db('users').where({ email: 'second@example.com' }).first();
  const cat = await node.ctx.content.createTerm('category', { name: 'Only these' });
  const e = await node.ctx.content.create('post', { title: 'Filter target', termIds: [cat.id] });
  await node.ctx
    .db('entries')
    .where({ id: e.id })
    .update({ author_id: Number(second.id) });
  b.go('#/content/post');
  await wait(() => list() && ld().loaded && ld().authors.length > 1 && ld().terms.length);
  const titles = () => ld().entries.map((x) => x.title);

  setValue(list().querySelector('select[aria-label="Filter by author"]'), String(second.id));
  await wait(() => titles().includes('Filter target') && !titles().includes('Versions'));
  setValue(list().querySelector('select[aria-label="Filter by author"]'), '');
  setValue(list().querySelector('select[aria-label="Filter by category or tag"]'), String(cat.id));
  await wait(() => titles().join() === 'Filter target');

  setValue(list().querySelector('select[aria-label="Filter by category or tag"]'), '');
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  setValue(list().querySelector('#l-from'), tomorrow);
  await wait(() => ld().loaded && ld().entries.length === 0);
  assert.ok(b.visible(list().querySelector('.empty')));
  assert.match(list().querySelector('.empty').textContent, /matches these filters/);
  b.click(
    [...list().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Clear filters'),
  );
  await wait(() => ld().entries.length > 1);
});

test('images dropped into the content upload and become image blocks, with an alt warning and a size hint', async () => {
  await openNew('post');
  const buf = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#39c' } })
    .png()
    .toBuffer();
  const file = new b.win.File([buf], 'dropped.png', { type: 'image/png' });
  const ev = new b.win.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
  ed().querySelector('.blocks').dispatchEvent(ev);
  await wait(() => types().join() === 'image');
  const blk = data().form.data.body.blocks[0];
  assert.ok(blk.data.mediaId);
  assert.equal((await node.ctx.db('media').count({ n: '*' }).first()).n, 1);
  await wait(() => data().media[blk.data.mediaId]);
  assert.ok(
    b.visible(
      [...ed().querySelectorAll('.text-warning')].find((x) => /No description/.test(x.textContent)),
    ),
    'missing alt text is flagged',
  );
  await wait(() => /a good size/.test(ed().textContent));
  setValue(ed().querySelector('input[aria-label^="Image description"]'), 'A blue square');
  await wait(() => !data().needsAlt(blk));
});

test('no script errors anywhere in that tour', () => {
  assert.deepEqual(b.errors, []);
});
