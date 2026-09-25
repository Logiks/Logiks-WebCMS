import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, media, b;
before(async () => {
  media = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-ui-'));
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
const sec = (name) => b.$(`section[x-data^="${name}"]`);
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};
const file = (buf, name, type) => new b.win.File([buf], name, { type });
const chooseFiles = (input, files) => {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};
const png = (w = 30, h = 20) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#e33' } })
    .png()
    .toBuffer();

test('Content lives under its own menu group, with a link per content type', async () => {
  // The shell can paint before Alpine's nav x-for has flushed the permission-filtered list; wait for the button first.
  await wait(() => b.button('Content'));
  b.click(b.button('Content'));
  await wait(() => b.$$('.nav-sub-link').some((a) => a.textContent.trim() === 'Pages'));
  const links = b
    .$$('.nav-sub')
    .filter(b.visible)
    .flatMap((g) => [...g.querySelectorAll('.nav-sub-link')].map((a) => a.textContent.trim()));
  assert.deepEqual(links, ['Pages', 'Posts', 'Categories and tags', 'Media']);
  b.click(b.button('Content'));
});

test('write a page: title, a paragraph with formatting, a heading, a list; save; it is in the database and on the site', async () => {
  b.go('#/content/page');
  await wait(
    () =>
      /Nothing here yet/.test(sec('contentList')?.textContent ?? '') &&
      b.visible(sec('contentList').querySelector('.empty')),
  );
  assert.equal(b.$('.nav-sub-link.active').textContent.trim(), 'Pages');
  b.click(
    [...sec('contentList').querySelectorAll('a')].find((a) => /New page/.test(a.textContent)),
  );
  await wait(() => b.$('#e-title'));
  setValue(b.$('#e-title'), 'Hello from the editor');
  await wait(() => b.$('#e-slug').value === 'hello-from-the-editor'); // the address follows the title until you type your own

  const add = (t) =>
    b.click(
      [...sec('contentEditor').querySelectorAll('.block-add button')].find(
        (x) => x.textContent.trim() === t,
      ),
    );
  add('paragraph');
  await wait(() => sec('contentEditor').querySelector('.rich'));
  const rich = sec('contentEditor').querySelector('.rich');
  rich.innerHTML = 'Plain and <b>bold</b> and <script>alert(1)</script>';
  rich.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  add('header');
  await wait(() => sec('contentEditor').querySelector('input[aria-label="Heading text"]'));
  setValue(sec('contentEditor').querySelector('input[aria-label="Heading text"]'), 'A heading');
  add('list');
  await wait(() => sec('contentEditor').querySelector('textarea[aria-label="List items"]'));
  setValue(
    sec('contentEditor').querySelector('textarea[aria-label="List items"]'),
    'one\ntwo\n\nthree',
  );
  setValue(b.$('#e-status'), 'published');

  await wait(
    () =>
      /unsaved changes/.test(sec('contentEditor').textContent) &&
      b.visible(
        [...sec('contentEditor').querySelectorAll('.text-warning')].find((e) =>
          /unsaved/.test(e.textContent),
        ),
      ),
  );
  b.click(
    [...sec('contentEditor').querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'Save',
    ),
  );
  await wait(() => /#\/content\/page\/\d+$/.test(b.win.location.hash));
  const row = await node.ctx.db('entries').where({ slug: 'hello-from-the-editor' }).first();
  assert.equal(row.status, 'published');
  const data = JSON.parse(row.data);
  assert.deepEqual(
    data.body.blocks.map((x) => x.type),
    ['paragraph', 'header', 'list'],
  );
  assert.equal(
    data.body.blocks[0].data.text,
    'Plain and <b>bold</b> and',
    'the server removed the script and its text',
  );
  assert.deepEqual(data.body.blocks[2].data.items, ['one', 'two', 'three']);
  await wait(() => b.$('#e-title')?.value === 'Hello from the editor');

  const site = await request(node.app).get('/hello-from-the-editor');
  assert.equal(site.status, 200);
  assert.match(site.text, /<b>bold<\/b>/);
  assert.match(site.text, /<h2>A heading<\/h2>/);
});

test('editing keeps the block order you set, and moving and removing blocks works', async () => {
  const s = () => sec('contentEditor');
  await wait(() => s().querySelectorAll('.block').length === 3);
  const types = () => [...s().querySelectorAll('.block .block-bar .tag')].map((t) => t.textContent);
  assert.deepEqual(types(), ['paragraph', 'header', 'list']);
  b.click(s().querySelectorAll('.block')[2].querySelector('[aria-label="Move up"]'));
  await wait(() => types().join() === 'paragraph,list,header');
  b.click(s().querySelectorAll('.block')[0].querySelector('[aria-label="Remove block"]'));
  await wait(() => types().join() === 'list,header');
  b.click([...s().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'));
  await wait(
    async () =>
      JSON.parse(
        (await node.ctx.db('entries').where({ slug: 'hello-from-the-editor' }).first()).data,
      )
        .body.blocks.map((x) => x.type)
        .join() === 'list,header',
  );
  assert.match(s().textContent, /Version 2/);
});

test('history lists every save and restores an earlier one', async () => {
  const s = () => sec('contentEditor');
  b.click([...s().querySelectorAll('button')].find((x) => x.textContent.trim() === 'History'));
  await wait(() => s().querySelectorAll('.border-top').length >= 2);
  const restore = [...s().querySelectorAll('.border-top button')].pop(); // the oldest
  b.click(restore);
  await wait(
    async () =>
      JSON.parse(
        (await node.ctx.db('entries').where({ slug: 'hello-from-the-editor' }).first()).data,
      ).body.blocks.length === 3,
  );
  await wait(() => s().querySelectorAll('.block').length === 3);
  assert.match(b.text(), /Restored version 1/);
});

test('the list shows entries with their status and address; a search narrows it', async () => {
  await node.ctx.content.create('page', { title: 'Zebra draft', data: {} }, null);
  b.go('#/content/page');
  await wait(() => sec('contentList')?.querySelectorAll('tbody tr').length === 2);
  const rows = [...sec('contentList').querySelectorAll('tbody tr')].map((r) =>
    r.textContent.replace(/\s+/g, ' '),
  );
  assert.ok(rows.some((r) => /Hello from the editor.*\/hello-from-the-editor.*Published/.test(r)));
  assert.ok(rows.some((r) => /Zebra draft.*Draft/.test(r)));
  setValue(sec('contentList').querySelector('input[aria-label="Search titles"]'), 'Zebra');
  await wait(() => sec('contentList').querySelectorAll('tbody tr').length === 1);
  setValue(sec('contentList').querySelector('input[aria-label="Search titles"]'), '');
  setValue(sec('contentList').querySelector('select[aria-label="Filter by status"]'), 'published');
  await wait(() => sec('contentList').querySelectorAll('tbody tr').length === 1);
});

test('a scheduled entry needs a future time, and the message shows next to the field', async () => {
  b.go('#/content/page');
  await wait(() => sec('contentList'));
  b.click(
    [...sec('contentList').querySelectorAll('a')].find((a) => /New page/.test(a.textContent)),
  );
  await wait(() => b.$('#e-title'));
  setValue(b.$('#e-title'), 'Timed page');
  setValue(b.$('#e-status'), 'scheduled');
  await wait(() => b.visible(b.$('#e-when')));
  b.click(
    [...sec('contentEditor').querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'Save',
    ),
  );
  await wait(
    () =>
      /Pick a time in the future/.test(sec('contentEditor').textContent) &&
      b.visible(
        [...sec('contentEditor').querySelectorAll('.invalid-feedback')].find((e) =>
          /future/.test(e.textContent),
        ),
      ),
  );
  assert.equal(await node.ctx.db('entries').where({ title: 'Timed page' }).first(), undefined);
});

test('media: upload files, describe an image, use it in a page through the picker, and see what uses it', async () => {
  b.go('#/media');
  await wait(() => sec('mediaPage'));
  chooseFiles(sec('mediaPage').querySelector('input[type="file"]'), [
    file(await png(800, 500), 'red.png', 'image/png'),
  ]);
  await wait(() => sec('mediaPage').querySelectorAll('.media-tile').length === 1);
  const m = await node.ctx.db('media').first();
  assert.equal(m.filename, 'red.png');
  b.click(sec('mediaPage').querySelector('.media-tile'));
  await wait(() => b.visible(sec('mediaPage').querySelector('#m-alt')));
  setValue(sec('mediaPage').querySelector('#m-alt'), 'A red rectangle');
  b.click(
    [...sec('mediaPage').querySelectorAll('button')].find((x) =>
      /Save description/.test(x.textContent),
    ),
  );
  await wait(async () => (await node.ctx.db('media').first()).alt === 'A red rectangle');

  chooseFiles(sec('mediaPage').querySelector('input[type="file"]'), [
    file(Buffer.from('<svg onload=alert(1)/>'), 'x.svg', 'image/svg+xml'),
  ]);
  await wait(
    () =>
      /SVG/.test(sec('mediaPage').textContent) &&
      b.visible(sec('mediaPage').querySelector('.alert-danger')),
  );

  // use it in a page: an image block via the picker
  b.go('#/content/page');
  await wait(() => sec('contentList'));
  b.click(
    [...sec('contentList').querySelectorAll('a')].find((a) => /New page/.test(a.textContent)),
  );
  await wait(() => b.$('#e-title'));
  setValue(b.$('#e-title'), 'With picture');
  b.click(
    [...sec('contentEditor').querySelectorAll('.block-add button')].find(
      (x) => x.textContent.trim() === 'image',
    ),
  );
  await wait(() =>
    [...sec('contentEditor').querySelectorAll('button')].some((x) =>
      /Choose an image/.test(x.textContent),
    ),
  );
  b.click(
    [...sec('contentEditor').querySelectorAll('button')].find((x) =>
      /Choose an image/.test(x.textContent),
    ),
  );
  await wait(() => b.visible(b.$('.modal-x')) && b.$$('.modal-x .media-tile').length === 1);
  b.click(b.$('.modal-x .media-tile'));
  await wait(() => !b.visible(b.$('.modal-x')));
  await wait(
    () =>
      sec('contentEditor').querySelector('input[aria-label="Image description for screen readers"]')
        ?.value === 'A red rectangle',
  );
  b.click(
    [...sec('contentEditor').querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'Save',
    ),
  );
  await wait(() => /#\/content\/page\/\d+$/.test(b.win.location.hash));
  const saved = JSON.parse(
    (await node.ctx.db('entries').where({ title: 'With picture' }).first()).data,
  );
  assert.equal(saved.body.blocks[0].data.mediaId, Number(m.id));
  assert.equal(await node.ctx.media.usage(m.id), 1);
});

test('the featured-image field opens the same picker', async () => {
  const s = () => sec('contentEditor');
  await wait(() =>
    [...s().querySelectorAll('button')].some((x) => /Choose from the library/.test(x.textContent)),
  );
  b.click(
    [...s().querySelectorAll('button')].find((x) => /Choose from the library/.test(x.textContent)),
  );
  await wait(() => b.$$('.modal-x .media-tile').length === 1 && b.visible(b.$('.modal-x')));
  b.click(b.$('.modal-x .media-tile'));
  await wait(() => !b.visible(b.$('.modal-x')));
  b.click([...s().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'));
  await wait(
    async () =>
      JSON.parse((await node.ctx.db('entries').where({ title: 'With picture' }).first()).data)
        .featured_image > 0,
  );
});

test('posts: categories can be created inline and are attached on save; the terms screen renames and deletes', async () => {
  b.go('#/content/post');
  await wait(() => sec('contentList'));
  b.click(
    [...sec('contentList').querySelectorAll('a')].find((a) => /New post/.test(a.textContent)),
  );
  await wait(() => b.$('#e-title'));
  setValue(b.$('#e-title'), 'News item');
  await wait(() => sec('contentEditor').querySelector('input[aria-label="New category"]'));
  setValue(sec('contentEditor').querySelector('input[aria-label="New category"]'), 'Announcements');
  b.click(
    [...sec('contentEditor').querySelectorAll('button')].find(
      (x) =>
        x.textContent.trim() === 'Add' && x.closest('.panel').textContent.includes('Categories'),
    ),
  );
  await wait(() => sec('contentEditor').querySelector('input[type="checkbox"]:checked'));
  b.click(
    [...sec('contentEditor').querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'Save',
    ),
  );
  await wait(async () => (await node.ctx.db('entry_terms').count({ n: '*' }).first()).n === 1);

  b.go('#/terms');
  await wait(() => sec('termsPage')?.textContent.includes('Announcements'));
  assert.match(sec('termsPage').textContent, /1 use/);
  b.win.prompt = () => 'Company news';
  b.click(
    [...sec('termsPage').querySelectorAll('button')].find((x) => x.textContent.trim() === 'Rename'),
  );
  await wait(
    async () =>
      (await node.ctx.db('terms').where({ taxonomy: 'category' }).first()).name === 'Company news',
  );
  b.click(
    [...sec('termsPage').querySelectorAll('button')].find((x) => x.textContent.trim() === 'Delete'),
  );
  await wait(async () => !(await node.ctx.db('terms').where({ taxonomy: 'category' }).first()));
});

test('menus: build a tree with a page and an address, save, and the site shows it', async () => {
  b.go('#/menus');
  await wait(() => sec('menusPage'));
  setValue(sec('menusPage').querySelector('input[aria-label="New menu name"]'), 'main');
  b.click(
    [...sec('menusPage').querySelectorAll('button')].find((x) => /Add menu/.test(x.textContent)),
  );
  await wait(() =>
    [...sec('menusPage').querySelectorAll('button')].some(
      (x) => x.textContent.trim() === 'Add item',
    ),
  );
  const addItem = () =>
    b.click(
      [...sec('menusPage').querySelectorAll('button')].find(
        (x) => x.textContent.trim() === 'Add item',
      ),
    );
  addItem();
  await wait(() => sec('menusPage').querySelectorAll('.frow').length === 1);
  addItem();
  await wait(() => sec('menusPage').querySelectorAll('.frow').length === 2);
  const rows = () => [...sec('menusPage').querySelectorAll('.frow')];
  setValue(rows()[1].querySelector('select[aria-label="Link to"]'), 'url');
  await wait(() => b.visible(rows()[1].querySelector('input[aria-label="Address"]')));
  setValue(rows()[1].querySelector('input[aria-label="Address"]'), 'https://shop.example');
  setValue(rows()[1].querySelector('input[aria-label="Label"]'), 'Shop');
  b.click(rows()[1].querySelector('[aria-label="Move up"]'));
  await wait(() => rows()[0].querySelector('input[aria-label="Label"]').value === 'Shop');
  b.click(
    [...sec('menusPage').querySelectorAll('button')].find((x) => /Save menu/.test(x.textContent)),
  );
  await wait(async () => !!(await node.ctx.db('menus').where({ name: 'main' }).first()));
  const items = JSON.parse((await node.ctx.db('menus').where({ name: 'main' }).first()).items);
  assert.deepEqual(
    items.map((i) => i.label),
    ['Shop', 'Hello from the editor'],
  );
  assert.equal(items[0].url, 'https://shop.example');
  assert.ok(items[1].entryId > 0);
  assert.match(
    (await request(node.app).get('/hello-from-the-editor')).text,
    /href="https:\/\/shop\.example"/,
  );
});

test('redirects: add one, see it work, and a bad one shows the reason', async () => {
  b.go('#/redirects');
  await wait(() => sec('redirectsPage'));
  setValue(sec('redirectsPage').querySelector('input[aria-label="Old address"]'), '/old');
  setValue(
    sec('redirectsPage').querySelector('input[aria-label="New address"]'),
    'javascript:alert(1)',
  );
  b.submit(sec('redirectsPage').querySelector('form'));
  await wait(
    () =>
      /path like \/new-page/.test(sec('redirectsPage').textContent) &&
      b.visible(sec('redirectsPage').querySelector('form .text-danger')),
  );
  setValue(
    sec('redirectsPage').querySelector('input[aria-label="New address"]'),
    '/hello-from-the-editor',
  );
  b.submit(sec('redirectsPage').querySelector('form'));
  await wait(() => sec('redirectsPage').querySelectorAll('tbody tr').length === 1);
  assert.equal((await request(node.app).get('/old')).status, 301);
  b.click(
    [...sec('redirectsPage').querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'Remove',
    ),
  );
  await wait(
    () =>
      sec('redirectsPage').querySelectorAll('tbody tr').length === 0 ||
      b.visible(sec('redirectsPage').querySelector('.empty')),
  );
});

test('themes: the built-in one is live; a zip is installed and made live from the screen; a bad zip explains itself', async () => {
  b.go('#/themes');
  const builtIn = node.ctx.themes.list().length; // the code ships more than one (default, midnight)
  await wait(() => sec('themesPage')?.querySelectorAll('.node').length === builtIn);
  assert.match(sec('themesPage').textContent, /Default.*Live.*Built in/s);

  const good = new AdmZip();
  for (const [n, c] of Object.entries({
    'theme.json': JSON.stringify({ id: 'bold', name: 'Bold', version: '2.0.0' }),
    'layouts/default.html':
      '<html><head>{{ seo.head }}{{ content_for_header }}</head><body class="bold">{{ content_for_layout }}</body></html>',
  }))
    good.addFile(n, Buffer.from(c));
  chooseFiles(sec('themesPage').querySelector('input[type="file"]'), [
    file(good.toBuffer(), 'bold.zip', 'application/zip'),
  ]);
  await wait(() => sec('themesPage').querySelectorAll('.node').length === builtIn + 1);
  const boldRow = [...sec('themesPage').querySelectorAll('.node')].find((n) =>
    /Bold/.test(n.textContent),
  );
  b.click(
    [...boldRow.querySelectorAll('button')]
      .filter(b.visible)
      .find((x) => x.textContent.trim() === 'Make live'),
  );
  await wait(() => node.ctx.settings.get('site.theme') === 'bold');
  assert.match((await request(node.app).get('/hello-from-the-editor')).text, /class="bold"/);

  chooseFiles(sec('themesPage').querySelector('input[type="file"]'), [
    file(Buffer.from('not a zip at all'), 'bad.zip', 'application/zip'),
  ]);
  await wait(
    () =>
      /valid zip/.test(sec('themesPage').textContent) &&
      b.visible(sec('themesPage').querySelector('.alert-danger')),
  );
  await node.ctx.themes.activate('default', null);
});

test('messages from the contact form are listed and can be deleted', async () => {
  await node.ctx.site.contact.submit({
    name: 'Asha',
    email: 'asha@example.com',
    message: 'Hi <b>there</b>',
    page: '/contact',
  });
  b.go('#/messages');
  await wait(() => sec('messagesPage')?.textContent.includes('Asha'));
  assert.match(sec('messagesPage').textContent, /Hi <b>there<\/b>/, 'shown as text, not as markup');
  assert.equal(sec('messagesPage').querySelectorAll('.pre b').length, 0);
  b.click(
    [...sec('messagesPage').querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'Delete',
    ),
  );
  await wait(async () => !(await node.ctx.db('contact_messages').first()));
});

test('an author sees only what they can use, and can only save drafts', async () => {
  const role = await node.ctx.db('roles').where({ name: 'Author' }).first();
  await node.ctx.users.createUser(
    {
      email: 'author@example.com',
      name: 'Author',
      password: 'Some-long-pass-12',
      roleId: Number(role.id),
    },
    null,
  );
  const a = await openAdmin(node.url);
  try {
    await a.signIn('author@example.com', 'Some-long-pass-12');
    await wait(() => a.$$('.nav-link-x').some((x) => x.textContent.trim() === 'Content'));
    const tops = a.$$('.nav-link-x:not(.nav-sub-link)').map((x) => x.textContent.trim());
    assert.deepEqual(tops, ['Overview', 'Content'], 'no themes, settings, security or operations');
    a.click(a.button('Content'));
    await wait(() => a.$$('.nav-sub').some(a.visible));
    const links = a
      .$$('.nav-sub')
      .filter(a.visible)
      .flatMap((g) => [...g.querySelectorAll('.nav-sub-link')].map((x) => x.textContent.trim()));
    assert.deepEqual(links, ['Pages', 'Posts', 'Media']);
    a.go('#/content/post/new');
    await wait(() => a.$('#e-status'));
    assert.deepEqual(
      [...a.$('#e-status').options].map((o) => o.textContent),
      ['Draft'],
    );
    assert.equal(a.$('#e-status').disabled, true);
    assert.ok(
      a.$$('.small.muted').some((e) => /You can save drafts/.test(e.textContent) && a.visible(e)),
    );
    a.go('#/themes'); // not allowed: falls back to the overview
    await wait(() => /Config version|What's running/.test(a.text()));
    assert.deepEqual(a.errors, []);
  } finally {
    a.close();
  }
});

test('no script errors anywhere in that tour', () => {
  assert.deepEqual(b.errors, []);
});
